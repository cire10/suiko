// @ts-check
// Daemon lifecycle (WP5): daemon.json (0600) persistence across restarts (same token, secret and sticky ports),
// rotation, POST /api/shutdown, idle exit (and live waiters preventing it), strict explicit ports, SPECREVIEW_PORT,
// a refused second daemon, graceful closing of open SSE streams, and daemon.log.
// SPECREVIEW_HOME is a temp dir; ports are random (0) and never the defaults.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-daemon-life-'));
const HOME = path.join(TMP, 'home');
process.env.SPECREVIEW_HOME = HOME;
delete process.env.SPECREVIEW_PORT;

const { startDaemon } = await import('../../src/daemon/main.js');
const { readDaemonInfo } = await import('../../src/core/store/home.js');
const { codeIdentity } = await import('../../src/core/util/build.js');
const { Store } = await import('../../src/core/store/store.js');

/**
 * @param {number} port
 * @param {string} p
 * @param {{ method?: string, headers?: Record<string, string> }} [o]
 * @returns {Promise<{ status: number, text: string, headers: http.IncomingHttpHeaders }>}
 */
function request(port, p, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { connection: 'close', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * True when something accepts TCP connections on the port.
 * @param {number} port
 */
function isListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(() => {
  fs.mkdirSync(HOME, { recursive: true });
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('daemon.json is written 0600 and token, secret and ports survive a restart', async () => {
  const d1 = await startDaemon({ uiPort: 0, contentPort: 0, ops: {}, logFile: false, idleMs: 0 });
  const info1 = await readDaemonInfo();
  assert.ok(info1);
  assert.equal(info1.pid, process.pid);
  assert.equal(info1.uiPort, d1.uiPort);
  assert.equal(info1.contentPort, d1.contentPort);
  assert.notEqual(d1.uiPort, d1.contentPort);
  assert.match(info1.token, /^[0-9a-f]{32}$/);
  assert.match(info1.secret, /^[0-9a-f]{64}$/);
  assert.equal(info1.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  // The code identity: the package folder in daemon.json, its build there and in /api/health (which never shows the path).
  const identity = codeIdentity(ROOT);
  assert.equal(info1.root, fs.realpathSync(ROOT));
  assert.equal(info1.build, identity.build);
  const health = JSON.parse((await request(d1.uiPort, '/api/health')).text);
  assert.equal(health.build, identity.build);
  assert.equal(JSON.stringify(health).includes(info1.root), false, 'health does not reveal the package path');
  assert.ok(!Number.isNaN(Date.parse(info1.startedAt)));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(HOME, 'daemon.json')).mode & 0o777, 0o600);
  }
  await d1.close();
  assert.equal(await isListening(d1.uiPort), false);
  assert.ok(await readDaemonInfo(), 'daemon.json is kept on shutdown');

  // no explicit ports: the previous (sticky) ports are reused
  const d2 = await startDaemon({ ops: {}, logFile: false, idleMs: 0 });
  try {
    assert.equal(d2.uiPort, d1.uiPort);
    assert.equal(d2.contentPort, d1.contentPort);
    assert.equal(d2.token, d1.token);
    assert.equal(d2.secret, d1.secret);
    const health = await request(d2.uiPort, '/api/health', { headers: { host: `127.0.0.1:${d2.uiPort}` } });
    assert.equal(health.status, 200);
    const docs = await request(d2.uiPort, '/api/docs', { headers: { host: `127.0.0.1:${d2.uiPort}`, authorization: `Bearer ${d1.token}` } });
    assert.equal(docs.status, 200, 'the old token still works');
  } finally {
    await d2.close();
  }

  // rotate: new token and secret
  const d3 = await startDaemon({ uiPort: 0, contentPort: 0, ops: {}, logFile: false, idleMs: 0, rotate: true });
  try {
    assert.notEqual(d3.token, d1.token);
    assert.notEqual(d3.secret, d1.secret);
    assert.equal((await readDaemonInfo())?.token, d3.token);
  } finally {
    await d3.close();
  }
});

test('POST /api/shutdown stops the daemon', async () => {
  const d = await startDaemon({ uiPort: 0, contentPort: 0, ops: {}, logFile: false, idleMs: 0 });
  const host = `127.0.0.1:${d.uiPort}`;
  const noToken = await request(d.uiPort, '/api/shutdown', { method: 'POST', headers: { host, origin: `http://${host}` } });
  assert.equal(noToken.status, 401);
  const r = await request(d.uiPort, '/api/shutdown', { method: 'POST', headers: { host, origin: `http://${host}`, authorization: `Bearer ${d.token}` } });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text), { ok: true });
  await Promise.race([d.closed, sleep(5000).then(() => assert.fail('daemon did not stop'))]);
  assert.equal(await isListening(d.uiPort), false);
  assert.equal(await isListening(d.contentPort), false);
});

test('shutdown ends open SSE streams', async () => {
  const root = path.join(TMP, 'ws-sse');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'a.md'), '# A\n');
  const store = await Store.open(root, { create: true });
  const doc = await store.createDoc({ path: 'a.md' });
  await store.commitVersion(doc, { source: (await store.readWorking(doc)).buf });
  const d = await startDaemon({ uiPort: 0, contentPort: 0, ops: {}, logFile: false, idleMs: 0 });
  const ended = new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: d.uiPort, path: `/api/events?ws=${store.wsId}&doc=${doc.id}&k=${d.token}`, agent: false },
      (res) => {
        assert.equal(res.statusCode, 200);
        res.on('data', () => {});
        res.on('end', () => resolve(true));
        res.on('close', () => resolve(true));
        setTimeout(() => void d.close(), 100);
      },
    );
    req.on('error', reject);
  });
  assert.equal(await Promise.race([ended, sleep(5000).then(() => false)]), true);
  await d.closed;
});

test('idle exit after idleMs without requests, SSE clients or live waiters', async () => {
  const d = await startDaemon({ uiPort: 0, contentPort: 0, ops: {}, logFile: false, idleMs: 300, idleCheckMs: 50 });
  const stopped = await Promise.race([d.closed.then(() => true), sleep(5000).then(() => false)]);
  assert.equal(stopped, true);
  assert.equal(await isListening(d.uiPort), false);
});

test('a live waiter keeps the daemon alive', async () => {
  const root = path.join(TMP, 'ws-idle');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'a.md'), '# A\n');
  const store = await Store.open(root, { create: true });
  const doc = await store.createDoc({ path: 'a.md' });
  const waiter = await store.registerWaiter(doc.id, { agent: 'claude' });
  const d = await startDaemon({ uiPort: 0, contentPort: 0, ops: {}, logFile: false, idleMs: 200, idleCheckMs: 50 });
  try {
    await sleep(600);
    assert.equal(await isListening(d.uiPort), true, 'still running while a waiter is live');
    await waiter.remove();
    const stopped = await Promise.race([d.closed.then(() => true), sleep(5000).then(() => false)]);
    assert.equal(stopped, true);
  } finally {
    await waiter.remove();
    await d.close();
  }
});

test('explicit ports are strict; SPECREVIEW_PORT selects the UI port', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', () => r(undefined)));
  const busy = /** @type {net.AddressInfo} */ (blocker.address()).port;
  try {
    await assert.rejects(startDaemon({ uiPort: busy, contentPort: 0, ops: {}, logFile: false, idleMs: 0 }), (err) => {
      assert.equal(/** @type {any} */ (err).code, 'EADDRINUSE');
      assert.match(String(/** @type {Error} */ (err).message), new RegExp(String(busy)));
      return true;
    });
  } finally {
    await new Promise((r) => blocker.close(() => r(undefined)));
  }
  // pick a free UI port + 1 via SPECREVIEW_PORT
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', () => r(undefined)));
  const free = /** @type {net.AddressInfo} */ (probe.address()).port;
  await new Promise((r) => probe.close(() => r(undefined)));
  process.env.SPECREVIEW_PORT = String(free);
  try {
    const d = await startDaemon({ ops: {}, logFile: false, idleMs: 0 });
    try {
      assert.equal(d.uiPort, free);
      assert.equal(d.contentPort, free + 1);
    } finally {
      await d.close();
    }
  } catch (err) {
    // free + 1 may be taken by something else on a busy machine: that is the strict behaviour too
    assert.equal(/** @type {any} */ (err).code, 'EADDRINUSE');
  } finally {
    delete process.env.SPECREVIEW_PORT;
  }
});

test('a second daemon is refused while the first one (another process) is healthy', async () => {
  const home2 = path.join(TMP, 'home-second');
  fs.mkdirSync(home2, { recursive: true });
  const script = `
    const { startDaemon } = await import(${JSON.stringify(path.join(ROOT, 'src', 'daemon', 'main.js'))});
    const d = await startDaemon({ uiPort: 0, contentPort: 0, ops: {}, logFile: false, idleMs: 0 });
    process.stdout.write('ready ' + d.uiPort + '\\n');
    process.stdin.on('data', async () => { await d.close(); process.exit(0); });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, SPECREVIEW_HOME: home2 },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (c) => {
        out += c;
        const m = /ready (\d+)/.exec(out);
        if (m) resolve(Number(m[1]));
      });
      child.on('exit', (code) => reject(new Error(`child exited ${code}`)));
    });
    assert.ok(port > 0);
    const prevHome = process.env.SPECREVIEW_HOME;
    try {
      await assert.rejects(startDaemon({ home: home2, uiPort: 0, contentPort: 0, ops: {}, logFile: false, idleMs: 0 }), /already running/);
    } finally {
      process.env.SPECREVIEW_HOME = prevHome;
    }
  } finally {
    child.stdin.write('stop\n');
    await new Promise((r) => {
      child.on('exit', r);
      setTimeout(() => {
        child.kill('SIGKILL');
        r(undefined);
      }, 5000);
    });
  }
});

test('a stale daemon.json whose port another home\'s daemon now uses: not running, and stop leaves that daemon alone', async () => {
  const other = path.join(TMP, 'home-other');
  const stale = path.join(TMP, 'home-stale');
  fs.mkdirSync(other, { recursive: true });
  fs.mkdirSync(stale, { recursive: true });
  const script = `
    const { startDaemon } = await import(${JSON.stringify(path.join(ROOT, 'src', 'daemon', 'main.js'))});
    const d = await startDaemon({ uiPort: 0, contentPort: 0, ops: {}, logFile: false, idleMs: 0 });
    process.stdout.write('ready ' + d.uiPort + ' ' + d.contentPort + '\\n');
    process.stdin.on('data', async () => { await d.close(); process.exit(0); });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, SPECREVIEW_HOME: other }, stdio: ['pipe', 'pipe', 'inherit'] });
  const prevHome = process.env.SPECREVIEW_HOME;
  try {
    const [uiPort, contentPort] = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (c) => {
        out += c;
        const m = /ready (\d+) (\d+)/.exec(out);
        if (m) resolve([Number(m[1]), Number(m[2])]);
      });
      child.on('exit', (code) => reject(new Error(`child exited ${code}`)));
    });
    // this home's daemon died (pid gone) and another home's daemon took its port
    fs.writeFileSync(path.join(stale, 'daemon.json'), JSON.stringify({ pid: 2147480, uiPort, contentPort, token: '0'.repeat(32), secret: '0'.repeat(64), version: '0.0.0' }), { mode: 0o600 });
    process.env.SPECREVIEW_HOME = stale;
    const { daemonStatus, stopDaemon } = await import('../../src/cli/daemon-client.js');
    assert.equal((await daemonStatus()).running, false);
    const r = await stopDaemon({ timeoutMs: 500 });
    assert.deepEqual([r.wasRunning, r.stopped], [false, false]);
    assert.equal(await isListening(uiPort), true, 'the other daemon still runs');
  } finally {
    process.env.SPECREVIEW_HOME = prevHome;
    child.stdin.write('stop\n');
    await new Promise((r) => {
      child.on('exit', r);
      setTimeout(() => {
        child.kill('SIGKILL');
        r(undefined);
      }, 5000);
    });
  }
});

test('without foreground mode, log lines go to daemon.log', async () => {
  const d = await startDaemon({ uiPort: 0, contentPort: 0, ops: {}, idleMs: 0 });
  await d.close();
  await sleep(50);
  const logText = fs.readFileSync(path.join(HOME, 'daemon.log'), 'utf8');
  assert.match(logText, /listening: ui http:\/\/127\.0\.0\.1:\d+/);
  assert.ok(!logText.includes(d.token), 'the token is never logged');
});
