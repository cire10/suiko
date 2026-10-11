// @ts-check
// Cross-process mutual exclusion with a mkdir lock (BUILD_AMENDMENTS 2.2; replaces proper-lockfile).
//
//   withLock(lockDir, fn, { timeoutMs = 20000, staleMs = 30000, refreshMs = 5000 })
//
// Protocol
// - Acquire: `mkdir(lockDir)` (atomic), then write `owner.json` {pid, at, host, token}. While held, `at` is
//   refreshed every `refreshMs`.
// - Stale: the owner pid is dead on this host (`process.kill(pid, 0)` -> ESRCH), or `at` is older than `staleMs`,
//   or (no readable owner.json) the directory is older than `staleMs`. A stale lock is broken by renaming the
//   directory aside (only one contender can win the rename) and deleting it, then acquisition is retried.
// - Contention: retry with exponential backoff between 20 and 200 ms until `timeoutMs`, then LockTimeoutError.
// - Release: remove the directory, but only if owner.json still carries our token (never delete a lock that was
//   taken over from us). An 'exit' handler removes locks still held when the process exits.
//
// Re-entrancy: a call made while the SAME async call chain already holds `lockDir` runs `fn` directly (ops may
// call other ops). Holders are tracked per async context (AsyncLocalStorage) plus a per-process map of held
// dirs, so two concurrent requests inside one process (the daemon) still exclude each other: they queue on an
// in-process gate first and then compete for the directory like any other process. This is a strict refinement
// of the "per process" re-entrancy described in the amendments.

import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LockTimeoutError } from './errors.js';
import { writeFileAtomic } from './atomic.js';
import { randomHex } from '../util/hash.js';
import { pidAlive } from '../util/proc.js';
import { sleep } from '../util/time.js';
import { createLogger } from '../util/log.js';

const log = createLogger('lock');

export const OWNER_FILE = 'owner.json';

/**
 * @typedef {object} LockOptions
 * @property {number} [timeoutMs=20000] give up (LockTimeoutError) after this long
 * @property {number} [staleMs=30000] an owner whose `at` is older than this is considered dead
 * @property {number} [refreshMs=5000] how often the holder refreshes `at`
 */

/** @typedef {{ pid: number, at: string, host?: string, token?: string }} LockOwner */

const DEFAULTS = { timeoutMs: 20000, staleMs: 30000, refreshMs: 5000 };
const MIN_DELAY = 20;
const MAX_DELAY = 200;

/** @type {Map<string, { token: string, stop: () => Promise<void> }>} dir -> lock held by this process */
const held = new Map();
/** @type {Map<string, Promise<void>>} dir -> tail of the in-process wait queue */
const gates = new Map();
/** @type {AsyncLocalStorage<Map<string, string>>} dir -> token held by the current async call chain */
const context = new AsyncLocalStorage();
let exitHookInstalled = false;

/**
 * Runs `fn` while holding the lock directory `lockDir`.
 * @template T
 * @param {string} lockDir absolute path of the lock directory (its parent is created if needed)
 * @param {() => Promise<T> | T} fn
 * @param {LockOptions} [opts]
 * @returns {Promise<T>}
 */
export async function withLock(lockDir, fn, opts = {}) {
  const dir = path.resolve(lockDir);
  const ctx = context.getStore();
  const ctxToken = ctx?.get(dir);
  if (ctxToken && held.get(dir)?.token === ctxToken) return await fn();

  const o = { ...DEFAULTS, ...opts };
  const deadline = Date.now() + o.timeoutMs;
  const leaveGate = await enterGate(dir, deadline, o.timeoutMs);
  try {
    const token = await acquireDir(dir, deadline, o);
    const stop = startRefresh(dir, token, o.refreshMs);
    held.set(dir, { token, stop });
    installExitHook();
    try {
      const next = new Map(ctx ?? []);
      next.set(dir, token);
      return await context.run(next, fn);
    } finally {
      held.delete(dir);
      await stop();
      await releaseDir(dir, token);
    }
  } finally {
    leaveGate();
  }
}

/**
 * True when this process (any async chain) currently holds the lock.
 * @param {string} lockDir
 * @returns {boolean}
 */
export function isLockHeld(lockDir) {
  return held.has(path.resolve(lockDir));
}

/**
 * Reads the owner record of a lock directory (null when free or unreadable).
 * @param {string} lockDir
 * @returns {Promise<LockOwner | null>}
 */
export async function readLockOwner(lockDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(lockDir, OWNER_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Serialises async chains of this process that want the same lock. Resolves to a function that lets the next
 * waiter in. Rejects with LockTimeoutError when the deadline passes first.
 * @param {string} dir
 * @param {number} deadline epoch ms
 * @param {number} timeoutMs
 * @returns {Promise<() => void>}
 */
async function enterGate(dir, deadline, timeoutMs) {
  const prev = gates.get(dir) ?? Promise.resolve();
  /** @type {() => void} */
  let open = () => {};
  const mine = new Promise((resolve) => {
    open = () => resolve(undefined);
  });
  const tail = prev.then(() => mine);
  gates.set(dir, tail);
  const leave = () => {
    open();
    if (gates.get(dir) === tail) gates.delete(dir);
  };
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new LockTimeoutError(`timed out after ${timeoutMs} ms waiting for lock ${dir} (held in this process)`, {
        details: { lockDir: dir, owner: { pid: process.pid } },
      }));
    }, Math.max(0, deadline - Date.now()));
  });
  try {
    await Promise.race([prev, expired]);
  } catch (err) {
    leave();
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return leave;
}

/**
 * Creates the lock directory, breaking stale locks, until the deadline.
 * @param {string} dir
 * @param {number} deadline
 * @param {Required<LockOptions>} o
 * @returns {Promise<string>} our owner token
 */
async function acquireDir(dir, deadline, o) {
  await fs.mkdir(path.dirname(dir), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.mkdir(dir);
      const token = randomHex(8);
      try {
        await writeOwner(dir, token);
      } catch (err) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
      return token;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
    }
    const state = await inspect(dir, o.staleMs);
    if (state.stale) {
      log.debug(`breaking stale lock ${dir} (${state.reason})`, state.owner);
      await breakStale(dir, state.raw, o.staleMs);
      continue;
    }
    if (state.gone) continue;
    if (Date.now() >= deadline) {
      const who = state.owner ? `pid ${state.owner.pid} since ${state.owner.at}` : 'unknown owner';
      throw new LockTimeoutError(`timed out after ${o.timeoutMs} ms waiting for lock ${dir} (held by ${who})`, {
        details: { lockDir: dir, owner: state.owner ?? null },
      });
    }
    const backoff = Math.min(MAX_DELAY, MIN_DELAY * 2 ** Math.min(attempt, 4));
    const jitter = Math.floor(Math.random() * MIN_DELAY);
    await sleep(Math.min(backoff + jitter, Math.max(0, deadline - Date.now())));
  }
}

/**
 * @typedef {{ stale: boolean, gone?: boolean, reason?: string, raw: string | null, owner: LockOwner | null }} LockState
 */

/**
 * Classifies an existing lock directory.
 * @param {string} dir
 * @param {number} staleMs
 * @returns {Promise<LockState>}
 */
async function inspect(dir, staleMs) {
  /** @type {string | null} */
  let raw = null;
  /** @type {LockOwner | null} */
  let owner = null;
  try {
    raw = await fs.readFile(path.join(dir, OWNER_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Number.isSafeInteger(parsed.pid)) owner = parsed;
  } catch {
    owner = null;
  }
  if (owner) {
    const sameHost = !owner.host || owner.host === os.hostname();
    if (sameHost && owner.pid === process.pid && held.get(dir)?.token !== owner.token) {
      // Our pid but not our lock: left over by an earlier process that had the same pid.
      return { stale: true, reason: 'own pid, not held', raw, owner };
    }
    if (sameHost && !pidAlive(owner.pid)) return { stale: true, reason: `pid ${owner.pid} is dead`, raw, owner };
    const at = Date.parse(owner.at);
    if (!Number.isFinite(at) || Date.now() - at > staleMs) {
      return { stale: true, reason: `not refreshed since ${owner.at}`, raw, owner };
    }
    return { stale: false, raw, owner };
  }
  try {
    const st = await fs.stat(dir);
    if (Date.now() - st.mtimeMs > staleMs) return { stale: true, reason: 'no owner record', raw, owner: null };
    return { stale: false, raw, owner: null };
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return { stale: false, gone: true, raw, owner: null };
    throw err;
  }
}

/**
 * Removes a stale lock directory without racing other breakers: the owner record must still be the one judged
 * stale, and the directory is renamed aside (atomic; one winner) before deletion. If the renamed directory turns
 * out to hold a fresh owner (a contender re-acquired in between), it is put back when possible.
 * @param {string} dir
 * @param {string | null} judgedRaw owner.json content that was judged stale
 * @param {number} staleMs
 */
async function breakStale(dir, judgedRaw, staleMs) {
  let current = null;
  try {
    current = await fs.readFile(path.join(dir, OWNER_FILE), 'utf8');
  } catch {
    current = null;
  }
  if (current !== judgedRaw) return; // changed since inspection: re-evaluate
  const grave = `${dir}.stale-${process.pid}-${randomHex(4)}`;
  try {
    await fs.rename(dir, grave);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') return;
    throw err;
  }
  const moved = await inspect(grave, staleMs);
  if (!moved.stale && moved.owner && moved.raw !== judgedRaw) {
    try {
      await fs.rename(grave, dir);
      return;
    } catch {
      log.warn(`lock ${dir} was re-acquired while being broken; the previous holder lost it`);
    }
  }
  await fs.rm(grave, { recursive: true, force: true });
}

/**
 * @param {string} dir
 * @param {string} token
 */
async function writeOwner(dir, token) {
  /** @type {LockOwner} */
  const owner = { pid: process.pid, at: new Date().toISOString(), host: os.hostname(), token };
  await writeFileAtomic(path.join(dir, OWNER_FILE), `${JSON.stringify(owner)}\n`, { mkdir: false });
}

/**
 * Starts the periodic `at` refresh. The returned stop() waits for an in-flight refresh so that no refresh can
 * land in a directory re-created by another process after our release.
 * @param {string} dir
 * @param {string} token
 * @param {number} refreshMs
 * @returns {() => Promise<void>}
 */
function startRefresh(dir, token, refreshMs) {
  let inflight = Promise.resolve();
  let stopped = false;
  const timer = setInterval(() => {
    inflight = inflight.then(async () => {
      if (stopped) return;
      try {
        await writeOwner(dir, token);
      } catch (err) {
        log.warn(`could not refresh lock ${dir}; it may have been taken over`, err);
      }
    });
  }, Math.max(10, refreshMs));
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await inflight;
  };
}

/**
 * Removes our lock directory if we still own it.
 * @param {string} dir
 * @param {string} token
 */
async function releaseDir(dir, token) {
  const owner = await readLockOwner(dir);
  if (!owner || owner.token !== token) {
    log.warn(`lock ${dir} was taken over before release; leaving it to its new owner`);
    return;
  }
  await fs.rm(dir, { recursive: true, force: true });
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const [dir, { token }] of held) {
      try {
        const owner = JSON.parse(fsSync.readFileSync(path.join(dir, OWNER_FILE), 'utf8'));
        if (owner.token === token) fsSync.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort: a leftover lock becomes stale once our pid is gone
      }
    }
  });
}
