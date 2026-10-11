// @ts-check
// Client side of the daemon lifecycle (design 10.1, amendments 2.5).
//
// ensureDaemon():
//   1. Read <SPECREVIEW_HOME>/daemon.json and GET http://127.0.0.1:<uiPort>/api/health (500 ms timeout).
//   2. Healthy specreview daemon with our package version -> reuse it (fast path, no lock).
//   3. Otherwise, under a home-level start lock (so concurrent CLIs spawn at most one daemon): re-check; if a
//      daemon of another version answers, POST /api/shutdown (Bearer token + same-origin Origin) and wait for it to
//      exit; then spawn `process.execPath bin/specreview.js serve --foreground` detached with stdout/stderr
//      appended to daemon.log, unref() it, and poll daemon.json + /api/health for up to 5 s.
//   Token, secret and ports persist in daemon.json across restarts (the daemon reuses them); `stop --rotate`
//   deletes daemon.json after stopping so the next start generates a new token and secret.
// Also: reviewUrl(), daemonStatus(), stopDaemon(), openInSystemBrowser().
// Plain node:http (agent: false) is used instead of fetch so no keep-alive socket delays the CLI's exit.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpecReviewError } from '../core/store/errors.js';
import { daemonLogPath, ensureHome, homeDir, homePath, readDaemonInfo, removeDaemonInfo } from '../core/store/home.js';
import { withLock } from '../core/store/lock.js';
import { createLogger } from '../core/util/log.js';
import { pidAlive } from '../core/util/proc.js';
import { APP_NAME, EXIT } from '../shared/protocol.js';

const log = createLogger('daemon-client');

/** Absolute path of the package root (…/html_documentation_annotator). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Absolute path of the CLI entry point. */
export const BIN_PATH = path.join(PACKAGE_ROOT, 'bin', 'specreview.js');

/** @type {string | null} */
let cachedVersion = null;

/**
 * The package version (package.json "version"); the daemon reports the same value in /api/health.
 * @returns {string}
 */
export function packageVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    cachedVersion = String(JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0');
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

/**
 * @typedef {import('../shared/types.js').DaemonInfo} DaemonInfo
 * @typedef {{ ok: boolean, name?: string, version?: string, pid?: number }} Health
 */

/**
 * @typedef {object} EnsureOptions
 * @property {string} [version] expected daemon version (default: package version)
 * @property {string[]} [command] argv of the daemon process (default: [execPath, bin, 'serve', '--foreground'])
 * @property {Record<string, string | undefined>} [env] environment of the spawned daemon
 * @property {number} [startTimeoutMs] how long to wait for a spawned daemon to become healthy (default 5000)
 * @property {number} [healthTimeoutMs] per health request (default 500)
 */

/**
 * Makes sure a daemon of our version is running and returns its info (from daemon.json).
 * @param {EnsureOptions} [opts]
 * @returns {Promise<DaemonInfo>}
 */
export async function ensureDaemon(opts = {}) {
  const version = opts.version ?? packageVersion();
  const healthTimeoutMs = opts.healthTimeoutMs ?? 500;
  const fast = await liveDaemon(healthTimeoutMs);
  if (fast && fast.health.version === version) return fast.info;

  ensureHome();
  return withLock(
    homePath('locks', 'daemon-start'),
    async () => {
      const current = await liveDaemon(healthTimeoutMs);
      if (current && current.health.version === version) return current.info;
      if (current) {
        log.info(`daemon version ${current.health.version} != ${version}; restarting it`);
        await shutdownAndWait(current.info, current.health, 5000);
      }
      const spawned = await spawnDaemon(opts);
      if (spawned.health.version !== version) {
        // Never loop restarting: a freshly started daemon is what this installation runs.
        log.warn(`the started daemon reports version ${spawned.health.version}, expected ${version}`);
      }
      return spawned.info;
    },
    { timeoutMs: (opts.startTimeoutMs ?? 5000) + 15000 },
  );
}

/**
 * The running daemon, if daemon.json points at a healthy specreview daemon.
 * @param {number} [timeoutMs]
 * @returns {Promise<{ info: DaemonInfo, health: Health } | null>}
 */
export async function liveDaemon(timeoutMs = 500) {
  const info = await readDaemonInfo();
  if (!info || !validPort(info.uiPort)) return null;
  const health = await getHealth(info.uiPort, timeoutMs);
  if (!isSpecreviewHealth(health)) return null;
  if (health && health.pid && info.pid && health.pid !== info.pid) return null; // daemon.json not yet rewritten
  return { info, health: /** @type {Health} */ (health) };
}

/**
 * Status for `doctor`/`stop`: the daemon.json contents and whether it answers.
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ info: DaemonInfo | null, health: Health | null, running: boolean }>}
 */
export async function daemonStatus({ timeoutMs = 500 } = {}) {
  const info = await readDaemonInfo();
  const health = info && validPort(info.uiPort) ? await getHealth(info.uiPort, timeoutMs) : null;
  return { info, health, running: isSpecreviewHealth(health) };
}

/**
 * Stops the daemon (POST /api/shutdown, then SIGTERM if it does not exit). With `rotate`, deletes daemon.json so
 * the next start generates a new token and secret (old review URLs stop working).
 * @param {{ rotate?: boolean, timeoutMs?: number }} [opts]
 * @returns {Promise<{ wasRunning: boolean, pid: number | null, stopped: boolean, rotated: boolean }>}
 */
export async function stopDaemon({ rotate = false, timeoutMs = 5000 } = {}) {
  const { info, health, running } = await daemonStatus();
  let stopped = false;
  if (running && info && health) stopped = await shutdownAndWait(info, health, timeoutMs);
  if (rotate) await removeDaemonInfo();
  return { wasRunning: running, pid: running ? (health?.pid ?? info?.pid ?? null) : null, stopped, rotated: rotate };
}

/**
 * Review UI URL of a doc (design 3.2): http://127.0.0.1:<uiPort>/d/<wsId>/<docId>?k=<token>
 * @param {Pick<DaemonInfo, 'uiPort' | 'token'>} info
 * @param {string} wsId
 * @param {string} docId
 * @returns {string}
 */
export function reviewUrl(info, wsId, docId) {
  return `http://127.0.0.1:${info.uiPort}/d/${encodeURIComponent(wsId)}/${encodeURIComponent(docId)}?k=${encodeURIComponent(info.token)}`;
}

/**
 * Opens a URL in the system browser (`open` / `xdg-open` / `start`). Resolves once the opener started.
 * @param {string} url
 * @returns {Promise<void>}
 */
export function openInSystemBrowser(url) {
  if (!/^https?:\/\//.test(url)) return Promise.reject(new Error(`refusing to open a non-http URL: ${url}`));
  /** @type {[string, string[]]} */
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
        : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * GET /api/health; null when nothing (or not JSON) answers in time.
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<Health | null>}
 */
export async function getHealth(port, timeoutMs) {
  const res = await httpJson({ port, method: 'GET', path: '/api/health', timeoutMs });
  return res && res.status === 200 && res.body && typeof res.body === 'object' ? /** @type {Health} */ (res.body) : null;
}

/**
 * @param {Health | null} h
 * @returns {boolean}
 */
function isSpecreviewHealth(h) {
  return Boolean(h && h.ok && h.name === APP_NAME);
}

/**
 * POST /api/shutdown and wait until the daemon is gone (health fails and its pid is dead); SIGTERM as fallback.
 * @param {DaemonInfo} info
 * @param {Health} health
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true when it exited
 */
async function shutdownAndWait(info, health, timeoutMs) {
  const pid = health.pid ?? info.pid;
  await httpJson({
    port: info.uiPort,
    method: 'POST',
    path: '/api/shutdown',
    timeoutMs: 1000,
    headers: {
      authorization: `Bearer ${info.token}`,
      origin: `http://127.0.0.1:${info.uiPort}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  if (await waitGone(info.uiPort, pid, timeoutMs)) return true;
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone or not ours
    }
  }
  return waitGone(info.uiPort, pid, 2000);
}

/**
 * @param {number} port
 * @param {number | undefined} pid
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitGone(port, pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = pid ? pidAlive(pid) : false;
    const answering = isSpecreviewHealth(await getHealth(port, 200));
    if (!alive && !answering) return true;
    if (!pid && !answering) return true;
    await delay(100);
  }
  return false;
}

/**
 * Spawns the daemon detached and waits until it is healthy.
 * @param {EnsureOptions} opts
 * @returns {Promise<{ info: DaemonInfo, health: Health }>}
 */
async function spawnDaemon(opts) {
  const command = opts.command ?? [process.execPath, BIN_PATH, 'serve', '--foreground'];
  const logFile = daemonLogPath();
  const fd = fs.openSync(logFile, 'a', 0o600);
  /** @type {{ code: number | null, signal: string | null } | null} */
  let exited = null;
  /** @type {Error | null} */
  let spawnError = null;
  let child;
  try {
    child = spawn(command[0], command.slice(1), {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: /** @type {NodeJS.ProcessEnv} */ ({ ...(opts.env ?? process.env) }),
      cwd: homeDir(),
      windowsHide: true,
    });
  } finally {
    fs.closeSync(fd);
  }
  child.once('error', (err) => {
    spawnError = err;
  });
  child.once('exit', (code, signal) => {
    exited = { code, signal };
  });
  child.unref();

  const deadline = Date.now() + (opts.startTimeoutMs ?? 5000);
  while (Date.now() < deadline) {
    if (spawnError) throw new SpecReviewError(`could not start the review server: ${/** @type {Error} */ (spawnError).message}`);
    const live = await liveDaemon(300);
    if (live) return live;
    if (exited) {
      const e = /** @type {{ code: number | null, signal: string | null }} */ (exited);
      throw new SpecReviewError(
        `the review server exited during startup (${e.signal ?? `code ${e.code}`})${logTail(logFile)}`,
        { exit: EXIT.ERROR },
      );
    }
    await delay(100);
  }
  throw new SpecReviewError(
    `the review server did not become healthy within ${Math.round((opts.startTimeoutMs ?? 5000) / 1000)} s (see ${logFile})${logTail(logFile)}`,
    { exit: EXIT.ERROR },
  );
}

/**
 * Last lines of daemon.log for error messages ('' when unreadable/empty).
 * @param {string} file
 * @returns {string}
 */
function logTail(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.trimEnd().split('\n').slice(-5).join('\n  ');
    return lines ? `; daemon.log:\n  ${lines}` : '';
  } catch {
    return '';
  }
}

/**
 * Minimal JSON-over-HTTP request to 127.0.0.1. Resolves null on any network error or timeout.
 * @param {{ port: number, method: string, path: string, timeoutMs: number, headers?: Record<string, string>, body?: string }} req
 * @returns {Promise<{ status: number, body: unknown } | null>}
 */
function httpJson(req) {
  return new Promise((resolve) => {
    let settled = false;
    /** @param {{ status: number, body: unknown } | null} v */
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const r = http.request(
      {
        host: '127.0.0.1',
        port: req.port,
        method: req.method,
        path: req.path,
        agent: false,
        headers: { accept: 'application/json', ...(req.headers ?? {}), ...(req.body ? { 'content-length': Buffer.byteLength(req.body) } : {}) },
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size <= 1024 * 1024) chunks.push(c);
        });
        res.on('end', () => {
          /** @type {unknown} */
          let body = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            body = null;
          }
          done({ status: res.statusCode ?? 0, body });
        });
        res.on('error', () => done(null));
      },
    );
    r.setTimeout(req.timeoutMs, () => {
      r.destroy();
      done(null);
    });
    r.on('error', () => done(null));
    if (req.body) r.write(req.body);
    r.end();
  });
}

/**
 * @param {unknown} p
 * @returns {p is number}
 */
function validPort(p) {
  return typeof p === 'number' && Number.isInteger(p) && p > 0 && p < 65536;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
