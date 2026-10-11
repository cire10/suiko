// @ts-check
// Change detection feeding the SSE stream (design 10.3, BUILD_AMENDMENTS 6). Nothing here writes to the store.
//
// DocWatcher (one per subscribed doc, shared by all its SSE clients, closed when the last one leaves):
//   - tails the runtime events feed `<home>/ws/<wsId>/events/<docId>.jsonl` by byte offset (polled every
//     `pollMs`, default 250 ms) and emits each new record {seq, at, type, ...}; a shrunk/replaced feed
//     (seq restarted) emits `reset`;
//   - watches the tracked working file with chokidar (plus a slow stat poll as a safety net for atomic renames
//     that coalesce), debounced `debounceMs` (250 ms), and emits `working` {dirty, sha256} when the working copy's
//     hash or its dirtiness against head changes (also re-checked after each version.created);
//   - polls the waiter files of the doc and of '_all' (`wait --all`) every `presenceMs` and emits `presence`
//     {waiters} when the set of live waiters changes (liveness decays with time, so polling is required).
// GlobalWatcher (subscriptions without a doc, e.g. the doc list): scans every registered workspace's events dir
//   and waiter dirs; emits new events (with ws/doc) and per-workspace presence changes. It never replays history.
// Hub: subscription refcounting for both kinds.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { watch as chokidarWatch } from 'chokidar';
import { homeDir, listWorkspaces } from '../core/store/home.js';
import { WAITER_LIVE_MS } from '../core/store/store.js';
import { pidAlive } from '../core/util/proc.js';
import { createLogger } from '../core/util/log.js';

const log = createLogger('daemon.watch');

/**
 * @typedef {import('../core/store/store.js').Store} Store
 * @typedef {import('../shared/types.js').StoreEvent} StoreEvent
 * @typedef {{ agent: string, since: string, pid: number, doc: string }} PresenceWaiter
 * @typedef {{ dirty: boolean, sha256: string | null, missing?: boolean }} WorkingState
 * @typedef {{ kind: 'event', event: StoreEvent, ws: string, doc: string }
 *   | { kind: 'reset', lastSeq: number, ws: string, doc: string }
 *   | { kind: 'presence', waiters: PresenceWaiter[], ws: string, doc: string | null }
 *   | { kind: 'working', working: WorkingState, ws: string, doc: string }} HubMessage
 * @typedef {(msg: HubMessage) => void} HubListener
 * @typedef {{ pollMs?: number, debounceMs?: number, presenceMs?: number, workingPollMs?: number, globalMs?: number }} WatchTiming
 */

const DEFAULT_TIMING = Object.freeze({ pollMs: 250, debounceMs: 250, presenceMs: 1000, workingPollMs: 2000, globalMs: 1000 });

// ------------------------------------------------------------------------------------------------ JSONL tail

/**
 * Incremental reader of an append-only JSON-lines file.
 */
export class JsonlTail {
  /**
   * @param {string} file
   */
  constructor(file) {
    this.file = file;
    this.offset = 0;
    /** @type {Buffer} */
    this.partial = Buffer.alloc(0);
    /** @type {bigint | number | null} */
    this.ino = null;
  }

  /** Positions the tail at the current end of the file (no replay). */
  async seekEnd() {
    const st = await statOrNull(this.file);
    this.offset = st ? st.size : 0;
    this.ino = st ? st.ino : null;
    this.partial = Buffer.alloc(0);
  }

  /**
   * Reads complete lines appended since the last call.
   * @returns {Promise<{ records: any[], truncated: boolean }>}
   */
  async read() {
    const st = await statOrNull(this.file);
    if (!st) {
      const truncated = this.offset > 0;
      this.offset = 0;
      this.ino = null;
      this.partial = Buffer.alloc(0);
      return { records: [], truncated };
    }
    let truncated = false;
    if (st.size < this.offset || (this.ino !== null && st.ino !== this.ino)) {
      truncated = true;
      this.offset = 0;
      this.partial = Buffer.alloc(0);
    }
    this.ino = st.ino;
    if (st.size === this.offset) return { records: [], truncated };
    const fh = await fsp.open(this.file, 'r');
    let chunk;
    try {
      const length = st.size - this.offset;
      chunk = Buffer.alloc(length);
      const { bytesRead } = await fh.read(chunk, 0, length, this.offset);
      chunk = chunk.subarray(0, bytesRead);
      this.offset += bytesRead;
    } finally {
      await fh.close();
    }
    const data = this.partial.length ? Buffer.concat([this.partial, chunk]) : chunk;
    const lastNl = data.lastIndexOf(0x0a);
    if (lastNl < 0) {
      this.partial = data;
      return { records: [], truncated };
    }
    this.partial = Buffer.from(data.subarray(lastNl + 1));
    const records = [];
    for (const line of data.subarray(0, lastNl).toString('utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        records.push(JSON.parse(t));
      } catch {
        // a torn or corrupt line: skipped, like store.readEvents
      }
    }
    return { records, truncated };
  }
}

/**
 * @param {string} file
 * @returns {Promise<fs.Stats | null>}
 */
async function statOrNull(file) {
  try {
    return await fsp.stat(file);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ waiters

/**
 * Live waiters in one waiters/<id> directory (fresh heartbeat, pid alive, not superseded).
 * @param {string} dir
 * @param {string} docId
 * @returns {Promise<PresenceWaiter[]>}
 */
export async function liveWaitersIn(dir, docId) {
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  /** @type {PresenceWaiter[]} */
  const out = [];
  for (const name of names.sort()) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const w = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
      if (!w || !Number.isSafeInteger(w.pid) || w.supersededBy) continue;
      const at = Date.parse(w.heartbeatAt);
      if (!Number.isFinite(at) || Date.now() - at >= WAITER_LIVE_MS || !pidAlive(w.pid)) continue;
      out.push({ agent: String(w.agent ?? ''), since: String(w.since ?? ''), pid: w.pid, doc: docId });
    } catch {
      // being replaced or corrupt: skip
    }
  }
  return out;
}

/**
 * True when any registered workspace has a live waiter (idle-exit check).
 * @returns {Promise<boolean>}
 */
export async function anyLiveWaiters() {
  const base = path.join(homeDir(), 'ws');
  let wsIds;
  try {
    wsIds = await fsp.readdir(base);
  } catch {
    return false;
  }
  for (const wsId of wsIds) {
    const wdir = path.join(base, wsId, 'waiters');
    let docs;
    try {
      docs = await fsp.readdir(wdir);
    } catch {
      continue;
    }
    for (const docId of docs) {
      if ((await liveWaitersIn(path.join(wdir, docId), docId)).length) return true;
    }
  }
  return false;
}

/**
 * @param {PresenceWaiter[]} list
 * @returns {PresenceWaiter[]}
 */
function sortWaiters(list) {
  return list.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.pid - b.pid));
}

// ------------------------------------------------------------------------------------------------ doc watcher

export class DocWatcher {
  /**
   * @param {{ wsId: string, docId: string, store: Store, timing?: WatchTiming, onMessage: HubListener }} opts
   */
  constructor({ wsId, docId, store, timing = {}, onMessage }) {
    this.wsId = wsId;
    this.docId = docId;
    this.store = store;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.onMessage = onMessage;
    this.tail = new JsonlTail(store.eventsFile(docId));
    this.lastSeq = 0;
    this.presenceSig = '';
    /** @type {PresenceWaiter[]} */
    this.presence = [];
    /** @type {WorkingState | null} */
    this.working = null;
    this.workingStat = '';
    /** @type {NodeJS.Timeout[]} */
    this.timers = [];
    /** @type {NodeJS.Timeout | null} */
    this.debounce = null;
    /** @type {import('chokidar').FSWatcher | null} */
    this.chokidar = null;
    this.closed = false;
    this.busy = { events: false, presence: false, working: false };
    /** @type {Promise<void> | null} */
    this.ready = null;
  }

  /** Initialises state and starts watching. */
  start() {
    if (!this.ready) this.ready = this.#start();
    return this.ready;
  }

  async #start() {
    await this.tail.seekEnd();
    this.lastSeq = await this.store.lastSeq(this.docId);
    this.presence = await this.#readPresence();
    this.presenceSig = JSON.stringify(this.presence);
    this.working = await this.#readWorking();
    this.workingStat = await this.#workingStatSig();
    if (this.closed) return;
    this.timers.push(setInterval(() => void this.#pollEvents(), this.timing.pollMs));
    this.timers.push(setInterval(() => void this.#pollPresence(), this.timing.presenceMs));
    this.timers.push(setInterval(() => void this.#pollWorkingStat(), this.timing.workingPollMs));
    for (const t of this.timers) t.unref?.();
    try {
      const doc = await this.store.getDoc(this.docId);
      if (doc && !this.closed) {
        const file = this.store.workingPath(doc);
        this.chokidar = chokidarWatch(file, { ignoreInitial: true, persistent: false });
        this.chokidar.on('all', () => this.#scheduleWorking());
        this.chokidar.on('error', (err) => log.debug(`watcher error for ${this.docId}`, err));
      }
    } catch (err) {
      log.debug(`cannot watch the working copy of ${this.docId}`, err);
    }
  }

  /** Current presence (for a new SSE client). */
  currentPresence() {
    return this.presence;
  }

  /** Current working state (for a new SSE client). */
  currentWorking() {
    return this.working;
  }

  async #pollEvents() {
    if (this.closed || this.busy.events) return;
    this.busy.events = true;
    try {
      const { records, truncated } = await this.tail.read();
      if (truncated) {
        // The feed was deleted or replaced. If its seqs went backwards the old ids are meaningless: reset.
        const maxSeq = records.reduce((m, r) => (Number.isSafeInteger(r?.seq) && r.seq > m ? r.seq : m), 0);
        if (maxSeq < this.lastSeq) {
          this.lastSeq = maxSeq;
          this.onMessage({ kind: 'reset', lastSeq: maxSeq, ws: this.wsId, doc: this.docId });
          return;
        }
      }
      let versionChanged = false;
      for (const rec of records) {
        if (!rec || !Number.isSafeInteger(rec.seq) || rec.seq <= this.lastSeq) continue;
        this.lastSeq = rec.seq;
        if (rec.type === 'version.created') versionChanged = true;
        this.onMessage({ kind: 'event', event: rec, ws: this.wsId, doc: this.docId });
      }
      if (versionChanged) this.#scheduleWorking();
    } catch (err) {
      log.debug(`events poll failed for ${this.docId}`, err);
    } finally {
      this.busy.events = false;
    }
  }

  async #readPresence() {
    const own = await liveWaitersIn(this.store.waitersDir(this.docId), this.docId);
    const all = await liveWaitersIn(this.store.waitersDir('_all'), '_all');
    return sortWaiters([...own, ...all]);
  }

  async #pollPresence() {
    if (this.closed || this.busy.presence) return;
    this.busy.presence = true;
    try {
      const presence = await this.#readPresence();
      const sig = JSON.stringify(presence);
      if (sig !== this.presenceSig && !this.closed) {
        this.presenceSig = sig;
        this.presence = presence;
        this.onMessage({ kind: 'presence', waiters: presence, ws: this.wsId, doc: this.docId });
      }
    } catch (err) {
      log.debug(`presence poll failed for ${this.docId}`, err);
    } finally {
      this.busy.presence = false;
    }
  }

  async #workingStatSig() {
    try {
      const doc = await this.store.getDoc(this.docId);
      if (!doc) return 'gone';
      const st = await fsp.stat(this.store.workingPath(doc));
      return `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return 'missing';
    }
  }

  async #pollWorkingStat() {
    if (this.closed) return;
    const sig = await this.#workingStatSig();
    if (sig !== this.workingStat) {
      this.workingStat = sig;
      this.#scheduleWorking();
    }
  }

  #scheduleWorking() {
    if (this.closed) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.#checkWorking();
    }, this.timing.debounceMs);
    this.debounce.unref?.();
  }

  async #checkWorking() {
    if (this.closed) return;
    if (this.busy.working) {
      this.#scheduleWorking();
      return;
    }
    this.busy.working = true;
    try {
      this.workingStat = await this.#workingStatSig();
      const next = await this.#readWorking();
      const prev = this.working;
      if (!prev || prev.dirty !== next.dirty || prev.sha256 !== next.sha256 || Boolean(prev.missing) !== Boolean(next.missing)) {
        this.working = next;
        if (!this.closed) this.onMessage({ kind: 'working', working: next, ws: this.wsId, doc: this.docId });
      }
    } catch (err) {
      log.debug(`working check failed for ${this.docId}`, err);
    } finally {
      this.busy.working = false;
    }
  }

  /** @returns {Promise<WorkingState>} */
  async #readWorking() {
    return workingState(this.store, this.docId);
  }

  async close() {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    const w = this.chokidar;
    this.chokidar = null;
    if (w) await w.close().catch(() => {});
  }
}

/**
 * Working-copy state against the head version: {dirty, sha256} ({dirty:true, sha256:null, missing:true} when the
 * file is gone).
 * @param {Store} store
 * @param {string} docId
 * @returns {Promise<WorkingState>}
 */
export async function workingState(store, docId) {
  const doc = await store.getDoc(docId);
  if (!doc) return { dirty: false, sha256: null, missing: true };
  let sha;
  try {
    sha = (await store.readWorking(doc)).sha256;
  } catch {
    return { dirty: true, sha256: null, missing: true };
  }
  let headSha = null;
  if (doc.head) {
    try {
      const raw = await fsp.readFile(path.join(store.versionsDir(docId), `${String(doc.head).padStart(4, '0')}.json`), 'utf8');
      headSha = JSON.parse(raw)?.sha256 ?? null;
    } catch {
      headSha = null;
    }
  }
  return { dirty: headSha !== null ? headSha !== sha : Boolean(doc.head), sha256: sha };
}

// ------------------------------------------------------------------------------------------------ global watcher

export class GlobalWatcher {
  /**
   * @param {{ timing?: WatchTiming, onMessage: HubListener }} opts
   */
  constructor({ timing = {}, onMessage }) {
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.onMessage = onMessage;
    /** @type {Map<string, JsonlTail>} key `${wsId}/${docId}` */
    this.tails = new Map();
    /** @type {Map<string, string>} wsId -> presence signature */
    this.presenceSig = new Map();
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    this.busy = false;
    this.closed = false;
    this.firstScan = true;
    /** @type {Promise<void> | null} */
    this.ready = null;
  }

  start() {
    if (!this.ready) {
      this.ready = this.#scan().then(() => {
        if (this.closed) return;
        this.timer = setInterval(() => void this.#scan(), this.timing.globalMs);
        this.timer.unref?.();
      });
    }
    return this.ready;
  }

  async #scan() {
    if (this.busy || this.closed) return;
    this.busy = true;
    const first = this.firstScan;
    this.firstScan = false;
    try {
      for (const ws of await listWorkspaces()) {
        if (this.closed) return;
        const base = path.join(homeDir(), 'ws', ws.wsId);
        let files = [];
        try {
          files = (await fsp.readdir(path.join(base, 'events'))).filter((f) => f.endsWith('.jsonl')).sort();
        } catch {
          files = [];
        }
        for (const f of files) {
          const docId = f.slice(0, -'.jsonl'.length);
          const key = `${ws.wsId}/${docId}`;
          let tail = this.tails.get(key);
          if (!tail) {
            tail = new JsonlTail(path.join(base, 'events', f));
            // Feeds that exist when watching starts are not replayed; feeds created later (a newly opened doc)
            // are read from the start so their doc.opened event is delivered.
            if (first) await tail.seekEnd();
            this.tails.set(key, tail);
          }
          const { records } = await tail.read();
          for (const rec of records) {
            if (!rec || !Number.isSafeInteger(rec.seq) || typeof rec.type !== 'string') continue;
            this.onMessage({ kind: 'event', event: rec, ws: ws.wsId, doc: docId });
          }
        }
        // presence (per workspace)
        /** @type {PresenceWaiter[]} */
        let waiters = [];
        try {
          for (const d of (await fsp.readdir(path.join(base, 'waiters'))).sort()) {
            waiters.push(...(await liveWaitersIn(path.join(base, 'waiters', d), d)));
          }
        } catch {
          waiters = [];
        }
        sortWaiters(waiters);
        const sig = JSON.stringify(waiters);
        const prev = this.presenceSig.get(ws.wsId);
        this.presenceSig.set(ws.wsId, sig);
        if (!first && prev !== undefined && prev !== sig) this.onMessage({ kind: 'presence', waiters, ws: ws.wsId, doc: null });
        if (!first && prev === undefined && waiters.length) this.onMessage({ kind: 'presence', waiters, ws: ws.wsId, doc: null });
      }
    } catch (err) {
      log.debug('global scan failed', err);
    } finally {
      this.busy = false;
    }
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// ------------------------------------------------------------------------------------------------ hub

export class Hub {
  /**
   * @param {{ timing?: WatchTiming }} [opts]
   */
  constructor({ timing = {} } = {}) {
    this.timing = timing;
    /** @type {Map<string, { watcher: DocWatcher, listeners: Set<HubListener> }>} */
    this.docs = new Map();
    /** @type {{ watcher: GlobalWatcher, listeners: Set<HubListener> } | null} */
    this.global = null;
    this.closed = false;
  }

  /**
   * Subscribes to one doc. The returned watcher is started (initial state loaded).
   * @param {{ wsId: string, docId: string, store: Store }} target
   * @param {HubListener} listener
   * @returns {Promise<{ watcher: DocWatcher, unsubscribe: () => void }>}
   */
  async subscribeDoc({ wsId, docId, store }, listener) {
    if (this.closed) throw new Error('hub closed');
    const key = `${wsId}/${docId}`;
    let entry = this.docs.get(key);
    if (!entry) {
      /** @type {Set<HubListener>} */
      const listeners = new Set();
      const watcher = new DocWatcher({
        wsId,
        docId,
        store,
        timing: this.timing,
        onMessage: (msg) => {
          for (const l of [...listeners]) safeCall(l, msg);
        },
      });
      entry = { watcher, listeners };
      this.docs.set(key, entry);
    }
    entry.listeners.add(listener);
    const current = entry;
    try {
      await current.watcher.start();
    } catch (err) {
      log.warn(`could not start watching ${key}`, err);
    }
    let done = false;
    return {
      watcher: current.watcher,
      unsubscribe: () => {
        if (done) return;
        done = true;
        current.listeners.delete(listener);
        if (current.listeners.size === 0 && this.docs.get(key) === current) {
          this.docs.delete(key);
          void current.watcher.close();
        }
      },
    };
  }

  /**
   * Subscribes to every doc of every registered workspace (no replay).
   * @param {HubListener} listener
   * @returns {Promise<{ unsubscribe: () => void }>}
   */
  async subscribeAll(listener) {
    if (this.closed) throw new Error('hub closed');
    if (!this.global) {
      /** @type {Set<HubListener>} */
      const listeners = new Set();
      const watcher = new GlobalWatcher({
        timing: this.timing,
        onMessage: (msg) => {
          for (const l of [...listeners]) safeCall(l, msg);
        },
      });
      this.global = { watcher, listeners };
    }
    const current = this.global;
    current.listeners.add(listener);
    await current.watcher.start();
    let done = false;
    return {
      unsubscribe: () => {
        if (done) return;
        done = true;
        current.listeners.delete(listener);
        if (current.listeners.size === 0 && this.global === current) {
          this.global = null;
          void current.watcher.close();
        }
      },
    };
  }

  /** Number of active subscriptions (doc + global). */
  get size() {
    let n = this.global ? this.global.listeners.size : 0;
    for (const e of this.docs.values()) n += e.listeners.size;
    return n;
  }

  async close() {
    this.closed = true;
    const closing = [...this.docs.values()].map((e) => e.watcher.close());
    this.docs.clear();
    if (this.global) closing.push(this.global.watcher.close());
    this.global = null;
    await Promise.all(closing);
  }
}

/**
 * @param {HubListener} l
 * @param {HubMessage} msg
 */
function safeCall(l, msg) {
  try {
    l(msg);
  } catch (err) {
    log.warn('SSE listener failed', err);
  }
}
