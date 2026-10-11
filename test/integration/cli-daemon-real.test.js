// @ts-check
// WP4 against the REAL daemon (src/daemon/main.js, WP5): `specreview open` (a real process) starts the daemon via
// ensureDaemon() (detached `serve --foreground`, health poll), the printed review URL is served, the daemon reports
// our package version, a second `open` reuses it, `doctor` sees it, and `stop` / `stop --rotate` shut it down.
// Uses a temp SPECREVIEW_HOME and a free port pair in 5800-5899 (never the defaults). Skipped when the daemon or
// the engine is not installed.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'bin', 'specreview.js');
const READY = ['src/daemon/main.js', 'src/core/review/ops.js'].every((f) => fs.existsSync(path.join(ROOT, f)));

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-home-real-daemon-')));
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-ws-real-daemon-')));
process.env.SPECREVIEW_HOME = HOME;

const client = await import('../../src/cli/daemon-client.js');

after(async () => {
  await client.stopDaemon({ timeoutMs: 3000 }).catch(() => {});
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(WS, { recursive: true, force: true });
});

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/**
 * A UI port N in 5800-5848 with N and N+1 free (randomised start to avoid parallel test files; 5850-5899 belongs
 * to e2e-loop.test.js).
 */
async function freePortPair() {
  const start = Math.floor(Math.random() * 25);
  for (let i = 0; i < 25; i++) {
    const p = 5800 + ((start + i) % 25) * 2;
    if ((await portFree(p)) && (await portFree(p + 1))) return p;
  }
  throw new Error('no free port pair in 5800-5849');
}

/**
 * Runs the real CLI as a process.
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: WS,
      env: { PATH: /** @type {string} */ (process.env.PATH), HOME: os.homedir(), SPECREVIEW_BROWSER: 'none', SPECREVIEW_HOME: HOME, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * @param {string} url
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number, body: string, type: string }>}
 */
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, type: String(res.headers['content-type'] ?? '') }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

describe('real daemon lifecycle through the CLI', { skip: READY ? false : 'daemon or engine not installed' }, () => {
  test('open starts the daemon and prints a working review URL; reuse, doctor, stop, stop --rotate', async () => {
    fs.mkdirSync(path.join(WS, '.git'));
    fs.writeFileSync(path.join(WS, 'spec.md'), '# Real daemon\n\nSome text.\n');
    const port = await freePortPair();
    const env = { SPECREVIEW_PORT: String(port) };

    const opened = await run(['open', 'spec.md', '--browser', 'none'], env);
    assert.equal(opened.code, 0, opened.stderr);
    const url = /^review UI: (http:\/\/127\.0\.0\.1:(\d+)\/d\/([0-9a-f]+)\/spec\?k=([0-9a-f]+))$/m.exec(opened.stdout);
    assert.ok(url, opened.stdout);
    assert.equal(Number(url[2]), port);

    const info = JSON.parse(fs.readFileSync(path.join(HOME, 'daemon.json'), 'utf8'));
    assert.equal(info.uiPort, port);
    assert.equal(info.token, url[4]);
    assert.equal((fs.statSync(path.join(HOME, 'daemon.json')).mode & 0o777).toString(8), '600');

    const health = JSON.parse((await get(`http://127.0.0.1:${port}/api/health`)).body);
    assert.equal(health.name, 'specreview');
    assert.equal(health.version, client.packageVersion(), 'the daemon runs our version');
    const page = await get(url[1]);
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    const docs = await get(`http://127.0.0.1:${port}/api/docs`, { authorization: `Bearer ${info.token}` });
    assert.equal(docs.status, 200);
    assert.ok(JSON.parse(docs.body).some((/** @type {any} */ d) => d.id === 'spec' && d.ws === url[3]), docs.body);

    const again = await run(['open', 'spec.md', '--browser', 'none'], env);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(HOME, 'daemon.json'), 'utf8')).pid, info.pid, 'the running daemon is reused');

    const doctor = await run(['doctor'], env);
    assert.match(doctor.stdout, new RegExp(`^ok {4}review server running at http://127\\.0\\.0\\.1:${port} `, 'm'));

    const stop = await run(['stop'], env);
    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(stop.stdout, `specreview: stopped the review server (pid ${info.pid})\n`);
    assert.equal(await client.getHealth(port, 300), null);
    assert.ok(fs.existsSync(path.join(HOME, 'daemon.json')), 'token and secret persist across restarts');

    const restarted = await run(['serve'], env);
    assert.equal(restarted.code, 0, restarted.stderr);
    assert.match(restarted.stdout, new RegExp(`^specreview: review server running at http://127\\.0\\.0\\.1:${port} `));
    assert.equal(JSON.parse(fs.readFileSync(path.join(HOME, 'daemon.json'), 'utf8')).token, info.token, 'same token after a restart');

    const rotate = await run(['stop', '--rotate'], env);
    assert.equal(rotate.code, 0, rotate.stderr);
    assert.match(rotate.stdout, /token and content secret will be regenerated on the next start/);
    assert.equal(fs.existsSync(path.join(HOME, 'daemon.json')), false);
    const none = await run(['stop'], env);
    assert.equal(none.stdout, 'specreview: the review server is not running\n');
  });
});
