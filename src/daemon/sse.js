// @ts-check
// GET /api/events?ws=<wsId>&doc=<docId>&k=<token> : Server-Sent Events for the UI (design 10.3).
//
// Doc streams (ws + doc):
//   - every record of the doc's runtime events feed is sent as `event: <type>`, `id: <seq>`,
//     `data: {...record, ws, doc}`. Payloads are hints; clients refetch DocState;
//   - resume: `Last-Event-ID` (header, or `lastEventId` query param) replays the records with a greater seq.
//     An unknown id (greater than the last seq, older than the feed's first record, or a non-number) or a gap
//     larger than MAX_REPLAY answers `reset` instead, and so does a feed whose seq restarted while connected;
//   - the stream starts with `retry:` and an `id:` line carrying the current last seq (no event is dispatched,
//     but the browser now has a Last-Event-ID to resume from even if no event arrives before a disconnect);
//   - `presence {waiters}` and `working.changed {dirty, sha256}` are sent at connect time and on change. They
//     carry no id (resume is about the seq feed only);
// Global streams (no doc; optional ws filter): new events of every doc (with ws/doc in the payload, no id, no
//   replay) and per-workspace `presence {ws, waiters}` changes.
// `ping` every pingMs (25 s). Subscribers are counted for the idle-exit rule.

import { SSE } from '../shared/protocol.js';
import { createLogger } from '../core/util/log.js';
import { invalid } from './http-util.js';
import { DOC_ID_RE, WS_ID_RE } from './workspaces.js';

const log = createLogger('daemon.sse');

/** Larger gaps are answered with `reset` (the client refetches DocState anyway). */
export const MAX_REPLAY = 1000;

/**
 * @typedef {import('./watch.js').HubMessage} HubMessage
 * @typedef {{ res: import('node:http').ServerResponse, close: () => void }} SseClient
 */

export class SseManager {
  /**
   * @param {{ hub: import('./watch.js').Hub, index: import('./workspaces.js').WorkspaceIndex, pingMs?: number,
   *   onCountChange?: (count: number) => void }} opts
   */
  constructor({ hub, index, pingMs = 25_000, onCountChange }) {
    this.hub = hub;
    this.index = index;
    this.pingMs = pingMs;
    this.onCountChange = onCountChange ?? (() => {});
    /** @type {Set<SseClient>} */
    this.clients = new Set();
    /** @type {NodeJS.Timeout | null} */
    this.pingTimer = null;
    this.closed = false;
  }

  /** Number of connected SSE clients. */
  get count() {
    return this.clients.size;
  }

  /**
   * Handles one SSE request (authentication is done by the caller).
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URLSearchParams} query
   */
  async handle(req, res, query) {
    if (this.closed) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('shutting down');
      return;
    }
    const wsId = query.get('ws') || '';
    const docId = query.get('doc') || '';
    if (wsId && !WS_ID_RE.test(wsId)) throw invalid('ws must be a workspace id');
    if (docId && !wsId) throw invalid('doc requires ws');
    if (docId && !DOC_ID_RE.test(docId)) throw invalid('doc must be a doc id');
    const lastIdRaw = headerValue(req.headers['last-event-id']) ?? query.get('lastEventId');

    if (docId) {
      const { store } = await this.index.doc(wsId, docId); // 404 before the stream starts
      await this.#streamDoc(req, res, { wsId, docId, store, lastIdRaw });
    } else {
      if (wsId) await this.index.store(wsId); // 404 for an unknown workspace
      await this.#streamGlobal(req, res, { wsId: wsId || null });
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{ wsId: string, docId: string, store: import('../core/store/store.js').Store, lastIdRaw: string | null }} o
   */
  async #streamDoc(req, res, { wsId, docId, store, lastIdRaw }) {
    /** @type {HubMessage[]} */
    let queue = [];
    let replaying = true;
    let sentSeq = 0;
    const meta = { ws: wsId, doc: docId };

    /** @param {HubMessage} msg */
    const deliver = (msg) => {
      if (msg.kind === 'event') {
        if (msg.event.seq <= sentSeq) return;
        sentSeq = msg.event.seq;
        writeEvent(res, msg.event.type, { ...msg.event, ...meta }, msg.event.seq);
      } else if (msg.kind === 'reset') {
        sentSeq = msg.lastSeq;
        writeEvent(res, SSE.RESET, { reason: 'feed-restarted', lastSeq: msg.lastSeq, ...meta }, msg.lastSeq);
      } else if (msg.kind === 'presence') {
        writeEvent(res, SSE.PRESENCE, { waiters: msg.waiters, ...meta });
      } else if (msg.kind === 'working') {
        writeEvent(res, SSE.WORKING_CHANGED, { ...msg.working, ...meta });
      }
    };
    /** @param {HubMessage} msg */
    const listener = (msg) => {
      if (replaying) queue.push(msg);
      else deliver(msg);
    };

    const sub = await this.hub.subscribeDoc({ wsId, docId, store }, listener);
    const client = this.#open(req, res, sub.unsubscribe);
    if (!client) return;

    try {
      const lastSeq = await store.lastSeq(docId);
      const lastId = parseLastId(lastIdRaw);
      if (lastIdRaw == null || lastIdRaw === '') {
        sentSeq = lastSeq;
        res.write(`id: ${lastSeq}\n\n`);
      } else if (lastId === null || lastId > lastSeq) {
        sentSeq = lastSeq;
        writeEvent(res, SSE.RESET, { reason: 'unknown-event-id', lastSeq, ...meta }, lastSeq);
      } else {
        const events = await store.readEvents(docId, lastId);
        const contiguous = events.length === 0 ? lastId === lastSeq : events[0].seq === lastId + 1;
        if (!contiguous || events.length > MAX_REPLAY) {
          sentSeq = lastSeq;
          writeEvent(res, SSE.RESET, { reason: events.length > MAX_REPLAY ? 'too-far-behind' : 'unknown-event-id', lastSeq, ...meta }, lastSeq);
        } else {
          sentSeq = lastId;
          if (!events.length) res.write(`id: ${lastId}\n\n`);
          for (const ev of events) deliver({ kind: 'event', event: ev, ...meta });
        }
      }
      writeEvent(res, SSE.PRESENCE, { waiters: sub.watcher.currentPresence(), ...meta });
      const working = sub.watcher.currentWorking();
      if (working) writeEvent(res, SSE.WORKING_CHANGED, { ...working, ...meta });
    } catch (err) {
      log.warn(`SSE replay failed for ${wsId}/${docId}`, err);
    } finally {
      replaying = false;
      const pending = queue;
      queue = [];
      for (const msg of pending) deliver(msg);
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{ wsId: string | null }} o
   */
  async #streamGlobal(req, res, { wsId }) {
    /** @param {HubMessage} msg */
    const listener = (msg) => {
      if (wsId && msg.ws !== wsId) return;
      if (msg.kind === 'event') writeEvent(res, msg.event.type, { ...msg.event, ws: msg.ws, doc: msg.doc });
      else if (msg.kind === 'presence') writeEvent(res, SSE.PRESENCE, { waiters: msg.waiters, ws: msg.ws, doc: msg.doc });
    };
    const sub = await this.hub.subscribeAll(listener);
    this.#open(req, res, sub.unsubscribe);
  }

  /**
   * Starts the event stream and registers the client.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {() => void} unsubscribe
   * @returns {SseClient | null}
   */
  #open(req, res, unsubscribe) {
    if (req.destroyed || res.destroyed) {
      unsubscribe();
      return null;
    }
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    let closed = false;
    /** @type {SseClient} */
    const client = {
      res,
      close: () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        this.clients.delete(client);
        this.onCountChange(this.clients.size);
        if (!res.writableEnded) res.end();
      },
    };
    this.clients.add(client);
    this.onCountChange(this.clients.size);
    res.on('close', client.close);
    req.on('error', client.close);
    this.#ensurePing();
    return client;
  }

  #ensurePing() {
    if (this.pingTimer || this.closed) return;
    this.pingTimer = setInterval(() => {
      for (const c of this.clients) writeEvent(c.res, SSE.PING, { at: new Date().toISOString() });
    }, this.pingMs);
    this.pingTimer.unref?.();
  }

  /** Ends every stream (shutdown). */
  close() {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const c of [...this.clients]) c.close();
  }
}

/**
 * Writes one SSE message. JSON.stringify never emits raw newlines, so `data:` stays on one line.
 * @param {import('node:http').ServerResponse} res
 * @param {string} type
 * @param {unknown} data
 * @param {number} [id]
 */
export function writeEvent(res, type, data, id) {
  if (res.writableEnded || res.destroyed) return;
  const name = String(type).replace(/[\r\n]/g, '');
  let out = `event: ${name}\n`;
  if (id !== undefined && id !== null) out += `id: ${id}\n`;
  out += `data: ${JSON.stringify(data ?? {})}\n\n`;
  res.write(out);
}

/**
 * @param {string | null} raw
 * @returns {number | null}
 */
function parseLastId(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!/^\d{1,15}$/.test(s)) return null;
  return Number(s);
}

/**
 * @param {string | string[] | undefined} h
 * @returns {string | null}
 */
function headerValue(h) {
  if (Array.isArray(h)) return h[0] ?? null;
  return typeof h === 'string' ? h : null;
}
