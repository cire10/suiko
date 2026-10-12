// @ts-check
// WP4 daemon-client tests (design 10.1, amendments 2.5) against a fake daemon process that behaves like
// `suiko serve --foreground`: binds 127.0.0.1 on port 0 (never the default ports), writes daemon.json into
// SPECREVIEW_HOME, answers /api/health and POST /api/shutdown (Bearer token + same-origin Origin required).
// Covers spawn + health poll, reuse, version- and build-mismatch restarts, stop/--rotate, and startup failures.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-home-daemon-'));
process.env.SPECREVIEW_HOME = HOME;

const client = await import('../../src/cli/daemon-client.js');
const { pidAlive } = await import('../../src/core/util/proc.js');
const { runCli } = await import('./helpers/cli-harness.js');
const { codeIdentity } = await import('../../src/core/util/build.js');

const FAKE = path.join(HOME, 'fake-daemon.mjs');
/** @type {Set<number>} */
const spawned = new Set();

const FAKE_SOURCE = `
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const home = process.env.SPECREVIEW_HOME;
const version = process.env.FAKE_VERSION || '0.1.0';
const build = process.env.FAKE_BUILD || undefined; // unset: a daemon from before builds were reported
const token = 'tok-' + process.pid;
const server = http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && req.url === '/api/health') return send(200, { ok: true, name: 'specreview', version, build, pid: process.pid });
  if (req.method === 'POST' && req.url === '/api/shutdown') {
    const port = server.address().port;
    if (req.headers.authorization !== 'Bearer ' + token) return send(401, { error: 'unauthorized' });
    if (req.headers.origin !== 'http://127.0.0.1:' + port) return send(403, { error: 'origin' });
    send(200, { ok: true });
    setTimeout(() => process.exit(0), 20);
    return;
  }
  send(404, { error: 'not found' });
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const info = { pid: process.pid, uiPort: port, contentPort: port + 1, token, secret: 'sec', version, startedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(home, 'daemon.json'), JSON.stringify(info), { mode: 0o600 });
  console.log('fake daemon listening on', port);
});
setTimeout(() => process.exit(0), 30000).unref();
`;

before(() => {
  fs.writeFileSync(FAKE, FAKE_SOURCE);
});
after(() => {
  for (const pid of spawned) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  fs.rmSync(HOME, { recursive: true, force: true });
});

/**
 * @param {string} [version]
 * @param {string} [build] '' starts a fake that reports no build (as daemons did before builds existed)
 */
const opts = (version = '0.1.0', build = 'build-a') => ({
  version,
  build,
  command: [process.execPath, FAKE],
  env: { ...process.env, SPECREVIEW_HOME: HOME, FAKE_VERSION: version, FAKE_BUILD: build },
  startTimeoutMs: 5000,
});

describe('daemon client', () => {
  test('reviewUrl', () => {
    assert.equal(client.reviewUrl({ uiPort: 5800, token: 'a b' }, '3f9a1c2e', 'token-service'), 'http://127.0.0.1:5800/d/3f9a1c2e/token-service?k=a%20b');
  });

  test('spawns a detached daemon, waits for health, logs to daemon.log; then reuses it', async () => {
    const info = await client.ensureDaemon(opts());
    spawned.add(info.pid);
    assert.ok(pidAlive(info.pid));
    assert.notEqual(info.pid, process.pid);
    assert.equal(info.version, '0.1.0');
    const status = await client.daemonStatus();
    assert.equal(status.running, true);
    assert.equal(status.health?.pid, info.pid);
    assert.match(fs.readFileSync(path.join(HOME, 'daemon.log'), 'utf8'), /fake daemon listening on/);
    const again = await client.ensureDaemon(opts());
    assert.equal(again.pid, info.pid, 'a healthy daemon of the same version is reused');
  });

  test('a daemon of another version is shut down (Bearer + Origin) and replaced', async () => {
    const before = /** @type {any} */ (await client.daemonStatus()).info;
    const info = await client.ensureDaemon(opts('9.9.9'));
    spawned.add(info.pid);
    assert.notEqual(info.pid, before.pid);
    assert.equal(info.version, '9.9.9');
    assert.equal(pidAlive(before.pid), false, 'old daemon exited');
  });

  test('a daemon of the same version but other code (another checkout, or changed files) is replaced', async () => {
    const a = await client.ensureDaemon(opts('0.1.0', 'build-a'));
    spawned.add(a.pid);
    assert.equal((await client.ensureDaemon(opts('0.1.0', 'build-a'))).pid, a.pid, 'same version and build: reused');
    const b = await client.ensureDaemon(opts('0.1.0', 'build-b'));
    spawned.add(b.pid);
    assert.notEqual(b.pid, a.pid);
    assert.equal(pidAlive(a.pid), false, 'the daemon running other code exited');
    assert.equal((await client.daemonStatus()).health?.build, 'build-b');
  });

  test('a daemon that reports no build (started by an older CLI) is replaced', async () => {
    const old = await client.ensureDaemon(opts('0.1.0', ''));
    spawned.add(old.pid);
    assert.equal((await client.daemonStatus()).health?.build, undefined);
    const ours = await client.ensureDaemon(opts('0.1.0', 'build-a'));
    spawned.add(ours.pid);
    assert.notEqual(ours.pid, old.pid);
    assert.equal(pidAlive(old.pid), false);
  });

  test('by default the expected build is this package\'s code identity', async () => {
    assert.deepEqual(client.packageIdentity(), codeIdentity(client.PACKAGE_ROOT));
    const live = /** @type {any} */ (await client.daemonStatus()).health;
    assert.notEqual(live.build, client.packageIdentity().build, 'the fake runs "build-a", not this package');
    const info = await client.ensureDaemon({ ...opts(), build: undefined, env: { ...opts().env, FAKE_BUILD: client.packageIdentity().build } });
    spawned.add(info.pid);
    assert.notEqual(info.pid, live.pid, 'replaced by a daemon reporting this package\'s build');
    assert.equal((await client.daemonStatus()).health?.build, client.packageIdentity().build);
  });

  test('doctor says when the running server is another checkout\'s code, or code that changed since it started', async () => {
    const version = client.packageVersion();
    const { root, build } = client.packageIdentity();
    /** @param {any} info @param {any} health */
    const status = (info, health) => async () => ({
      running: true,
      info: { pid: 1, uiPort: 5801, contentPort: 5802, token: 't', secret: 's', version, startedAt: '', ...info },
      health: { ok: true, name: 'specreview', version, pid: 1, ...health },
    });
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-home-user-'));
    /** @param {() => Promise<any>} daemonStatus */
    const doctor = async (daemonStatus) => (await runCli(['doctor'], { env: { SPECREVIEW_HOME: HOME, HOME: userHome }, daemonStatus })).stdout;
    try {
      assert.match(await doctor(status({ root, build }, { build })), /^ok {4}review server running at /m);
      const esc = (/** @type {string} */ t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(
        await doctor(status({ root: '/elsewhere/checkout', build: 'b' }, { build: 'b' })),
        new RegExp(`^WARN {2}review server .* runs the code in /elsewhere/checkout, not ${esc(root)} \\(restarts on next open\\)$`, 'm'),
      );
      assert.match(await doctor(status({ root, build: 'old' }, { build: 'old' })), /^WARN {2}review server .* runs code that has changed since it started \(restarts on next open\)$/m);
      assert.match(await doctor(status({ root }, {})), /runs code that has changed since it started/, 'a server reporting no build (an older CLI started it)');
      assert.match(await doctor(status({}, { version: '9.9.9', build })), /runs version 9\.9\.9, this CLI is /);
    } finally {
      fs.rmSync(userHome, { recursive: true, force: true });
    }
  });

  test('stop, then stop --rotate deletes daemon.json', async () => {
    const live = /** @type {any} */ (await client.daemonStatus()).info;
    const r = await client.stopDaemon();
    assert.deepEqual(r, { wasRunning: true, pid: live.pid, stopped: true, rotated: false });
    assert.equal(pidAlive(live.pid), false);
    assert.ok(fs.existsSync(path.join(HOME, 'daemon.json')), 'token/secret/ports persist across a plain stop');
    const r2 = await client.stopDaemon({ rotate: true });
    assert.equal(r2.wasRunning, false);
    assert.equal(r2.rotated, true);
    assert.equal(fs.existsSync(path.join(HOME, 'daemon.json')), false);
  });

  test('`suiko stop` through main()', async () => {
    const r = await runCli(['stop'], { env: { SPECREVIEW_HOME: HOME } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'suiko: the review server is not running\n');
  });

  test('a daemon that dies during startup is reported with the log tail', async () => {
    const bad = path.join(HOME, 'bad-daemon.mjs');
    fs.writeFileSync(bad, "console.error('boom: cannot bind'); process.exit(3);\n");
    await assert.rejects(
      client.ensureDaemon({ ...opts(), command: [process.execPath, bad] }),
      (/** @type {any} */ err) => /exited during startup \(code 3\)/.test(err.message) && /boom: cannot bind/.test(err.message),
    );
  });

  test('a daemon that never becomes healthy times out', async () => {
    const slow = path.join(HOME, 'slow-daemon.mjs');
    fs.writeFileSync(slow, 'setTimeout(() => {}, 1200);\n');
    await assert.rejects(client.ensureDaemon({ ...opts(), command: [process.execPath, slow], startTimeoutMs: 600 }), /did not become healthy/);
  });
});
