// @ts-check
// The Suiko daemon (design 10.1, 12; BUILD_AMENDMENTS 2.5, 6): one process per OS user serving
//   - the UI origin      http://127.0.0.1:<uiPort>       SPA, /ui/*, /vendor/*, /ui-shared/protocol.js, /api/*, SSE
//   - the content origin http://127.0.0.1:<contentPort>  rendered docs + assets under per-doc capability paths
// Both servers bind 127.0.0.1 only.
//
// Lifecycle:
//   - daemon.json (SPECREVIEW_HOME, mode 0600) = {pid, uiPort, contentPort, token, secret, version, root, build,
//     startedAt}, written after both listeners are bound. root/build (core/util/build.js) identify the code this
//     daemon loaded; /api/health reports version and build so the CLI restarts a daemon running other code. Token and secret are reused from the previous daemon.json (rotated
//     only with `rotate: true`); daemon.json is kept on shutdown so they survive restarts.
//   - Ports: explicit `uiPort`/`contentPort` (or SPECREVIEW_PORT = the UI port, content = UI + 1, which is how
//     `serve --port N` reaches a spawned daemon) are used as given (0 = random) and fail if busy. Otherwise the
//     previous ports are tried first (sticky), then the pairs (4777,4778), (4779,4780)... up to PORTS.max, then
//     random ports.
//   - Refuses to start when daemon.json names another live process that answers /api/health.
//   - Idle exit after `idleMs` (12 h) with no request, no SSE client and no live waiter.
//   - Graceful shutdown: POST /api/shutdown, close(), or SIGINT/SIGTERM in foreground mode (then the process
//     exits). SSE streams are ended, watchers closed, then both servers closed.
//   - Logging: foreground mode logs to stderr with timestamps at level info (the CLI spawns
//     `serve --foreground` with stderr redirected to daemon.log); otherwise log lines are appended to
//     `logFile` (default <home>/daemon.log). SPECREVIEW_LOG_LEVEL / SPECREVIEW_DEBUG still apply.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME, PORTS } from '../shared/protocol.js';
import { daemonLogPath, ensureHome, readDaemonInfo, writeDaemonInfo } from '../core/store/home.js';
import { codeIdentity } from '../core/util/build.js';
import { randomHex } from '../core/util/hash.js';
import { configureLogger, createLogger } from '../core/util/log.js';
import { pidAlive } from '../core/util/proc.js';
import { registerApiRoutes } from './api.js';
import { ContentOrigin } from './content.js';
import { Engine } from './engine.js';
import { GuestBundleCache } from './guest-bundle.js';
import { HttpError, notFound, sendJsonError } from './http-util.js';
import { Router } from './router.js';
import { bearerToken, isAllowedHost, isAllowedOrigin, isSafeMethod, parseTarget, setUiHeaders, tokenEquals } from './security.js';
import { SseManager } from './sse.js';
import { UiStatic } from './ui-index.js';
import { Hub, anyLiveWaiters } from './watch.js';
import { WorkspaceIndex } from './workspaces.js';

const log = createLogger('daemon');

export const IDLE_MS = 12 * 60 * 60 * 1000;
const IDLE_CHECK_MS = 5 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 500;
const FORCE_CLOSE_MS = 1000;

/** Package version (daemon.json `version`, /api/health). */
export const VERSION = readPackageVersion();
/** The code this daemon loaded (daemon.json `root`/`build`; /api/health `build`), taken at startup. */
const IDENTITY = codeIdentity(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));

/**
 * @typedef {object} StartOptions
 * @property {boolean} [foreground] this process is the daemon: stderr logging, signal handlers, exit on shutdown
 * @property {number} [uiPort] explicit UI port (0 = random); strict
 * @property {number} [contentPort] explicit content port (0 = random); strict
 * @property {Record<string, any>} [ops] review engine ops (default: lazy import of src/core/review/ops.js)
 * @property {(o: { root: string, cwd: string, store: any }) => any} [createContext] engine context factory (default: ops.createContext or context.js)
 * @property {string} [home] SPECREVIEW_HOME for this process (sets process.env.SPECREVIEW_HOME)
 * @property {boolean} [rotate] generate a new token and secret instead of reusing daemon.json's
 * @property {number} [idleMs] idle-exit delay (default 12 h; 0 disables)
 * @property {number} [idleCheckMs] idle check interval (default 5 min)
 * @property {number} [pingMs] SSE ping interval (default 25 s)
 * @property {import('./watch.js').WatchTiming} [timing] watcher intervals (tests)
 * @property {boolean} [dev] rebuild the guest bundle on change and serve it with no-cache (default SPECREVIEW_DEV=1)
 * @property {string | false} [logFile] append log lines to this file (default: daemon.log unless foreground)
 */

/**
 * @typedef {object} DaemonHandle
 * @property {number} uiPort
 * @property {number} contentPort
 * @property {string} token
 * @property {string} secret
 * @property {string} version
 * @property {import('../shared/types.js').DaemonInfo} info what was written to daemon.json
 * @property {string} uiOrigin 'http://127.0.0.1:<uiPort>'
 * @property {string} contentOrigin 'http://127.0.0.1:<contentPort>'
 * @property {(reason?: string) => Promise<void>} close graceful shutdown (idempotent)
 * @property {Promise<void>} closed resolves once shut down (by close(), /api/shutdown, idle or a signal)
 */

/**
 * Starts the daemon in this process.
 * @param {StartOptions} [opts]
 * @returns {Promise<DaemonHandle>}
 */
export async function startDaemon(opts = {}) {
  const { foreground = false } = opts;
  if (opts.home) process.env.SPECREVIEW_HOME = path.resolve(opts.home);
  ensureHome();
  const restoreLogger = setupLogging(foreground, opts.logFile);

  try {
    const prev = await readDaemonInfo();
    await assertNotRunning(prev);

    const token = !opts.rotate && isHex(prev?.token, 32) ? /** @type {string} */ (prev?.token) : randomHex(16);
    const secret = !opts.rotate && isHex(prev?.secret, 32) ? /** @type {string} */ (prev?.secret) : randomHex(32);
    const dev = opts.dev ?? process.env.SPECREVIEW_DEV === '1';
    const ports = { uiPort: 0, contentPort: 0 };
    const getPorts = () => ports;

    // ---- components
    const index = new WorkspaceIndex({ secret });
    const engine = new Engine({ index, ops: opts.ops ?? null, createContext: opts.createContext ?? null });
    const guest = new GuestBundleCache({ dev });
    const hub = new Hub({ timing: opts.timing });
    let lastActivity = Date.now();
    const touch = () => {
      lastActivity = Date.now();
    };
    const sse = new SseManager({ hub, index, pingMs: opts.pingMs, onCountChange: touch });
    const ui = new UiStatic({ contentPort: () => ports.contentPort });
    const content = new ContentOrigin({ index, guest, ports: getPorts, dev });

    // ---- servers
    const router = new Router();
    const uiServer = http.createServer((req, res) => {
      touch();
      void handleUi(req, res, { router, token, port: req.socket.localPort ?? ports.uiPort });
    });
    const contentServer = http.createServer((req, res) => {
      touch();
      void content.handle(req, res);
    });
    for (const s of [uiServer, contentServer]) {
      s.on('clientError', (_err, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        else socket.destroy();
      });
    }

    // ---- shutdown (idempotent; safe before the servers listen)
    /** @type {NodeJS.Timeout | null} */
    let idleTimer = null;
    /** @type {Array<[string, (...a: any[]) => void]>} */
    const processHandlers = [];
    /** @type {() => void} */
    let resolveClosed = () => {};
    /** @type {Promise<void>} */
    const closed = new Promise((r) => {
      resolveClosed = r;
    });
    /** @type {Promise<void> | null} */
    let closing = null;
    /** @param {string} reason @returns {Promise<void>} */
    const shutdown = (reason) => {
      if (!closing) {
        closing = (async () => {
          log.info(`shutting down (${reason})`);
          if (idleTimer) clearInterval(idleTimer);
          sse.close();
          await hub.close().catch((err) => log.warn('closing watchers failed', err));
          await Promise.all([closeServer(uiServer), closeServer(contentServer)]);
          for (const [ev, fn] of processHandlers) process.off(ev, fn);
          log.info('stopped');
          restoreLogger();
          resolveClosed();
        })();
      }
      return closing;
    };

    // ---- routes
    router.get('/', ({ req, res }) => ui.index(req, res));
    router.get('/d/:ws/:doc', ({ req, res }) => ui.index(req, res));
    router.get('/ui/*', ({ req, res, rest }) => ui.ui(req, res, rest));
    router.get('/vendor/*', ({ req, res, rest }) => ui.vendor(req, res, rest));
    router.get('/ui-shared/protocol.js', ({ req, res }) => ui.protocol(req, res));
    registerApiRoutes(router, { index, engine, sse, version: VERSION, build: IDENTITY.build, ports: getPorts, shutdown: (r) => void shutdown(r) });

    // ---- listen, then publish daemon.json
    const bound = await bindPorts(uiServer, contentServer, opts, prev);
    ports.uiPort = bound.uiPort;
    ports.contentPort = bound.contentPort;
    /** @type {import('../shared/types.js').DaemonInfo} */
    const info = {
      pid: process.pid,
      uiPort: ports.uiPort,
      contentPort: ports.contentPort,
      token,
      secret,
      version: VERSION,
      root: IDENTITY.root,
      build: IDENTITY.build,
      startedAt: new Date().toISOString(),
    };
    try {
      await writeDaemonInfo(info);
    } catch (err) {
      await Promise.all([closeServer(uiServer), closeServer(contentServer)]);
      throw err;
    }

    // ---- idle exit: no request, no SSE client and no live waiter for idleMs
    const idleMs = opts.idleMs ?? IDLE_MS;
    if (idleMs > 0) {
      let checking = false;
      idleTimer = setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          if (sse.count > 0) touch();
          else if (Date.now() - lastActivity >= idleMs) {
            if (await anyLiveWaiters()) touch();
            else void shutdown('idle');
          }
        } catch (err) {
          log.warn('idle check failed', err);
        } finally {
          checking = false;
        }
      }, Math.max(10, opts.idleCheckMs ?? Math.min(IDLE_CHECK_MS, idleMs)));
      idleTimer.unref();
    }

    if (foreground) {
      for (const sig of ['SIGINT', 'SIGTERM']) {
        const fn = () => void shutdown(sig);
        process.on(sig, fn);
        processHandlers.push([sig, fn]);
      }
      const onRejection = (/** @type {unknown} */ err) => log.error('unhandled rejection', err);
      process.on('unhandledRejection', onRejection);
      processHandlers.push(['unhandledRejection', onRejection]);
      void closed.then(() => {
        setTimeout(() => process.exit(0), 50).unref();
      });
    }

    const uiOrigin = `http://127.0.0.1:${ports.uiPort}`;
    const contentOrigin = `http://127.0.0.1:${ports.contentPort}`;
    log.info(`listening: ui ${uiOrigin}  content ${contentOrigin}  (pid ${process.pid}, v${VERSION})`);
    return {
      uiPort: ports.uiPort,
      contentPort: ports.contentPort,
      token,
      secret,
      version: VERSION,
      info,
      uiOrigin,
      contentOrigin,
      close: (reason = 'close') => shutdown(reason),
      closed,
    };
  } catch (err) {
    restoreLogger();
    throw err;
  }
}

/**
 * UI-origin request pipeline: base headers (setUiHeaders: nothing on the UI origin can be framed) -> Host ->
 * Origin (non-GET) -> token (/api/* except health) -> route.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ router: Router, token: string, port: number }} o
 */
async function handleUi(req, res, { router, token, port }) {
  const started = Date.now();
  setUiHeaders(res);
  try {
    if (!isAllowedHost(req, port)) throw new HttpError(421, 'misdirected request: unexpected Host header', { code: 'MISDIRECTED' });
    const target = parseTarget(req.url);
    if (!target) throw notFound();
    if (!isSafeMethod(req.method) && !isAllowedOrigin(req, port)) {
      throw new HttpError(403, 'cross-origin request refused', { code: 'FORBIDDEN_ORIGIN' });
    }
    const [first, second] = target.segments;
    if (first === 'api' && !(target.segments.length === 2 && second === 'health')) {
      const given = bearerToken(req) ?? (target.segments.length === 2 && second === 'events' ? target.query.get('k') : null);
      if (!tokenEquals(given, token)) {
        throw new HttpError(401, 'missing or invalid token', { code: 'UNAUTHORIZED', headers: { 'WWW-Authenticate': 'Bearer' } });
      }
    }
    const match = router.match(req.method ?? 'GET', target.segments);
    if (!match) throw notFound();
    if ('allowed' in match) throw new HttpError(405, 'method not allowed', { headers: { Allow: match.allowed.join(', ') } });
    await match.handler({ req, res, params: match.params, rest: match.rest, query: target.query, target });
  } catch (err) {
    const status = sendJsonError(res, err);
    if (status >= 500 && status !== 501 && status !== 503) log.error(`${req.method} ${pathOnly(req.url)} failed`, err);
  } finally {
    if (log.enabled('debug')) log.debug(`${req.method} ${pathOnly(req.url)} -> ${res.statusCode} ${Date.now() - started}ms`);
  }
}

/**
 * Binds both servers (see the port policy in the header).
 * @param {http.Server} uiServer
 * @param {http.Server} contentServer
 * @param {StartOptions} opts
 * @param {import('../shared/types.js').DaemonInfo | null} prev
 * @returns {Promise<{ uiPort: number, contentPort: number }>}
 */
async function bindPorts(uiServer, contentServer, opts, prev) {
  const envPort = process.env.SPECREVIEW_PORT ? Number(process.env.SPECREVIEW_PORT) : undefined;
  const uiWanted = opts.uiPort ?? (opts.contentPort === undefined && isPort(envPort) ? envPort : undefined);
  const explicit = uiWanted !== undefined || opts.contentPort !== undefined;
  /** @type {Array<[number, number]>} */
  const candidates = [];
  if (explicit) {
    const u = uiWanted ?? 0;
    const c = opts.contentPort ?? (u > 0 ? u + 1 : 0);
    if (!isPort(u, true) || !isPort(c, true)) throw new RangeError(`invalid ports ${u}/${c}`);
    candidates.push([u, c]);
  } else {
    if (prev && isPort(prev.uiPort) && isPort(prev.contentPort) && prev.uiPort !== prev.contentPort) {
      candidates.push([prev.uiPort, prev.contentPort]);
    }
    for (let p = PORTS.ui; p + 1 <= PORTS.max; p += 2) {
      if (!candidates.some(([a, b]) => a === p && b === p + 1)) candidates.push([p, p + 1]);
    }
    candidates.push([0, 0]);
  }
  /** @type {unknown} */
  let lastErr = null;
  for (const [u, c] of candidates) {
    if (u !== 0 && u === c) continue;
    let uiPort;
    try {
      uiPort = await listenOn(uiServer, u);
    } catch (err) {
      lastErr = err;
      if (explicit || !isBusy(err)) throw portError(err, u);
      continue;
    }
    try {
      const contentPort = await listenOn(contentServer, c);
      return { uiPort, contentPort };
    } catch (err) {
      lastErr = err;
      await closeServer(uiServer);
      if (explicit || !isBusy(err)) throw portError(err, c);
    }
  }
  throw portError(lastErr, 0);
}

/**
 * @param {http.Server} server
 * @param {number} port
 * @returns {Promise<number>} the bound port
 */
function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    /** @param {Error} err */
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host: '127.0.0.1', exclusive: true });
  });
}

/**
 * Closes a server, ending idle keep-alive sockets now and any remaining ones after FORCE_CLOSE_MS.
 * @param {http.Server} server
 * @returns {Promise<void>}
 */
function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    const force = setTimeout(() => server.closeAllConnections(), FORCE_CLOSE_MS);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    server.closeIdleConnections();
  });
}

/**
 * Throws when daemon.json names another live daemon that answers /api/health.
 * @param {import('../shared/types.js').DaemonInfo | null} prev
 */
async function assertNotRunning(prev) {
  if (!prev || !Number.isSafeInteger(prev.pid) || prev.pid === process.pid || !pidAlive(prev.pid) || !isPort(prev.uiPort)) return;
  try {
    const res = await fetch(`http://127.0.0.1:${prev.uiPort}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const body = /** @type {any} */ (await res.json());
    if (res.ok && body?.name === APP_NAME && body?.pid === prev.pid) {
      const err = new Error(`a Suiko daemon is already running (pid ${prev.pid}, http://127.0.0.1:${prev.uiPort})`);
      /** @type {any} */ (err).code = 'DAEMON_RUNNING';
      throw err;
    }
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'DAEMON_RUNNING') throw err;
    // not reachable: a stale daemon.json
  }
}

/**
 * @param {boolean} foreground
 * @param {string | false | undefined} logFile
 * @returns {() => void} restores the previous logger settings
 */
function setupLogging(foreground, logFile) {
  const envLevel = Boolean(process.env.SPECREVIEW_LOG_LEVEL || process.env.SPECREVIEW_DEBUG);
  if (foreground) {
    configureLogger({ time: true, ...(envLevel ? {} : { level: 'info' }) });
    return () => {};
  }
  const file = logFile === undefined ? daemonLogPath() : logFile;
  if (!file) return () => {};
  /** @type {fs.WriteStream | null} */
  let stream = null;
  try {
    stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
    stream.on('error', () => {});
  } catch {
    return () => {};
  }
  const out = stream;
  configureLogger({ time: true, sink: (line) => out.write(`${line}\n`), ...(envLevel ? {} : { level: 'info' }) });
  return () => {
    configureLogger({ time: null, sink: null, level: null });
    out.end();
  };
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isBusy(err) {
  const code = /** @type {any} */ (err)?.code;
  return code === 'EADDRINUSE' || code === 'EACCES';
}

/**
 * @param {unknown} err
 * @param {number} port
 */
function portError(err, port) {
  const code = /** @type {any} */ (err)?.code;
  if (code === 'EADDRINUSE') {
    const e = new Error(`port ${port} on 127.0.0.1 is already in use`, { cause: err });
    /** @type {any} */ (e).code = 'EADDRINUSE';
    return e;
  }
  return err instanceof Error ? err : new Error(`could not bind the daemon ports: ${String(err)}`);
}

/**
 * @param {unknown} p
 * @param {boolean} [allowZero]
 * @returns {p is number}
 */
function isPort(p, allowZero = false) {
  return Number.isSafeInteger(p) && /** @type {number} */ (p) >= (allowZero ? 0 : 1) && /** @type {number} */ (p) <= 65535;
}

/**
 * @param {unknown} s
 * @param {number} minLen
 * @returns {boolean}
 */
function isHex(s, minLen) {
  return typeof s === 'string' && s.length >= minLen && /^[0-9a-f]+$/.test(s);
}

/**
 * @param {string | undefined} url
 */
function pathOnly(url) {
  return String(url ?? '').split('?')[0];
}

/** @returns {string} */
function readPackageVersion() {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    return String(JSON.parse(fs.readFileSync(file, 'utf8')).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}
