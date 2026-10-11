// @ts-check
// Unit tests for src/core/store/lock.js: mutual exclusion between processes and between async chains of one
// process, stale-lock takeover (dead pid, expired heartbeat, missing owner record), refresh, re-entrancy,
// timeouts and cleanup on exit.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-lock-')));
process.env.SPECREVIEW_HOME = path.join(TMP, 'home');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const LOCK_URL = pathToFileURL(path.resolve('src/core/store/lock.js')).href;
const { withLock, isLockHeld, readLockOwner, OWNER_FILE } = await import('../../src/core/store/lock.js');
const { LockTimeoutError } = await import('../../src/core/store/errors.js');
const { EXIT } = await import('../../src/shared/protocol.js');

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const freshDir = () => path.join(TMP, 'locks', `l${++n}`);

/**
 * Runs an ES module snippet in a child node process. `LOCK_URL` is available as a global constant.
 * @param {string} code
 * @param {string[]} [args]
 * @returns {{ child: import('node:child_process').ChildProcess, done: Promise<{ code: number | null, out: string, err: string }> }}
 */
function runChild(code, args = []) {
  const file = path.join(TMP, `child-${++n}.mjs`);
  fs.writeFileSync(file, `const LOCK_URL = ${JSON.stringify(LOCK_URL)};\n${code}`);
  const child = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout?.on('data', (d) => (out += d));
  child.stderr?.on('data', (d) => (err += d));
  const done = new Promise((resolve) => child.on('close', (c) => resolve({ code: c, out, err })));
  return { child, done: /** @type {any} */ (done) };
}

/** pid of a process that has exited */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', '']);
  return /** @type {number} */ (r.pid);
}

test('two processes contending for one lock never overlap and lose no updates', async () => {
  const dir = freshDir();
  const counter = path.join(TMP, 'counter.txt');
  const journal = path.join(TMP, 'journal.txt');
  fs.writeFileSync(counter, '0');
  fs.writeFileSync(journal, '');
  const code = `
    import fs from 'node:fs/promises';
    const { withLock } = await import(LOCK_URL);
    const [dir, counter, journal, tag] = process.argv.slice(2);
    for (let i = 0; i < 15; i++) {
      await withLock(dir, async () => {
        await fs.appendFile(journal, 'enter ' + tag + '\\n');
        const v = Number(await fs.readFile(counter, 'utf8'));
        await new Promise((r) => setTimeout(r, 3));
        await fs.writeFile(counter, String(v + 1));
        await fs.appendFile(journal, 'exit ' + tag + '\\n');
      }, { timeoutMs: 30000 });
    }
  `;
  const a = runChild(code, [dir, counter, journal, 'A']);
  const b = runChild(code, [dir, counter, journal, 'B']);
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.equal(ra.code, 0, ra.err);
  assert.equal(rb.code, 0, rb.err);
  assert.equal(fs.readFileSync(counter, 'utf8'), '30');
  const events = fs.readFileSync(journal, 'utf8').trim().split('\n');
  assert.equal(events.length, 60);
  for (let i = 0; i < events.length; i += 2) {
    const [e1, t1] = events[i].split(' ');
    const [e2, t2] = events[i + 1].split(' ');
    assert.equal(e1, 'enter');
    assert.equal(e2, 'exit');
    assert.equal(t1, t2, `critical sections interleaved at ${i}`);
  }
  assert.equal(fs.existsSync(dir), false, 'lock released');
});

test('concurrent async chains in one process are serialised', async () => {
  const dir = freshDir();
  let inside = 0;
  let maxInside = 0;
  const order = /** @type {number[]} */ ([]);
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      withLock(dir, async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await sleep(2);
        order.push(i);
        inside -= 1;
      }),
    ),
  );
  assert.equal(maxInside, 1);
  assert.equal(order.length, 8);
});

test('re-entrant within one async call chain (including nested parallel work)', async () => {
  const dir = freshDir();
  const result = await withLock(dir, async () => {
    assert.equal(isLockHeld(dir), true);
    const inner = await withLock(dir, async () => withLock(dir, () => 42));
    const parallel = await Promise.all([withLock(dir, async () => 1), withLock(dir, async () => 2)]);
    return inner + parallel[0] + parallel[1];
  }, { timeoutMs: 500 });
  assert.equal(result, 45);
  assert.equal(isLockHeld(dir), false);
  assert.equal(fs.existsSync(dir), false);
});

test('a callback that escapes the critical section acquires the lock again instead of re-entering', async () => {
  const dir = freshDir();
  /** @type {Promise<boolean>} */
  let later = Promise.resolve(false);
  await withLock(dir, async () => {
    later = new Promise((resolve) => {
      setTimeout(() => {
        withLock(dir, async () => fs.existsSync(path.join(dir, OWNER_FILE))).then(resolve);
      }, 20);
    });
  });
  assert.equal(await later, true, 'the escaped callback took the lock itself');
});

test('the lock directory carries an owner record while held', async () => {
  const dir = freshDir();
  await withLock(dir, async () => {
    const owner = await readLockOwner(dir);
    assert.equal(owner?.pid, process.pid);
    assert.equal(owner?.host, os.hostname());
    assert.ok(owner?.token);
    assert.ok(Date.now() - Date.parse(/** @type {string} */ (owner?.at)) < 5000);
  });
  assert.equal(await readLockOwner(dir), null);
});

test('times out with LockTimeoutError while another process holds the lock', async () => {
  const dir = freshDir();
  const holder = runChild(`
    const { withLock } = await import(LOCK_URL);
    await withLock(process.argv[2], async () => {
      console.log('held');
      await new Promise((r) => setTimeout(r, 1500));
    });
  `, [dir]);
  await new Promise((resolve) => holder.child.stdout?.once('data', resolve));
  const t0 = Date.now();
  await assert.rejects(withLock(dir, async () => {}, { timeoutMs: 300 }), (err) => {
    assert.ok(err instanceof LockTimeoutError);
    assert.equal(err.exit, EXIT.ERROR);
    assert.equal(/** @type {any} */ (err.details.owner).pid, holder.child.pid);
    return true;
  });
  assert.ok(Date.now() - t0 >= 280);
  // with enough patience we get it once the holder releases
  const got = await withLock(dir, async () => 'ok', { timeoutMs: 10000 });
  assert.equal(got, 'ok');
  assert.equal((await holder.done).code, 0);
});

test('times out while another async chain of this process holds the lock', async () => {
  const dir = freshDir();
  /** @type {() => void} */
  let release = () => {};
  const holding = withLock(dir, () => new Promise((r) => (release = () => r(undefined))));
  await sleep(20);
  await assert.rejects(withLock(dir, async () => {}, { timeoutMs: 100 }), LockTimeoutError);
  release();
  await holding;
  assert.equal(await withLock(dir, async () => 'free'), 'free');
});

test('a lock owned by a dead pid is taken over immediately', async () => {
  const dir = freshDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify({ pid: deadPid(), at: new Date().toISOString(), host: os.hostname(), token: 'x' }));
  const t0 = Date.now();
  assert.equal(await withLock(dir, async () => 'mine', { timeoutMs: 2000 }), 'mine');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(fs.readdirSync(path.dirname(dir)).filter((x) => x.includes('.stale-')), []);
});

test('a lock whose heartbeat expired is taken over even if the pid is alive', async () => {
  const dir = freshDir();
  fs.mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify({ pid: process.ppid, at: old, host: os.hostname(), token: 'x' }));
  assert.equal(await withLock(dir, async () => 'mine', { timeoutMs: 2000, staleMs: 30000 }), 'mine');
});

test('a lock directory without an owner record is stale only after staleMs', async () => {
  const dir = freshDir();
  fs.mkdirSync(dir, { recursive: true });
  await assert.rejects(withLock(dir, async () => {}, { timeoutMs: 150, staleMs: 30000 }), LockTimeoutError);
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(dir, past, past);
  assert.equal(await withLock(dir, async () => 'mine', { timeoutMs: 2000 }), 'mine');
});

test('a leftover lock carrying our own pid but not held by us is stale', async () => {
  const dir = freshDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), host: os.hostname(), token: 'old' }));
  assert.equal(await withLock(dir, async () => 'mine', { timeoutMs: 1000 }), 'mine');
});

test('a live holder that refreshes its heartbeat is not considered stale', async () => {
  const dir = freshDir();
  const holder = runChild(`
    const { withLock } = await import(LOCK_URL);
    await withLock(process.argv[2], async () => {
      console.log('held');
      await new Promise((r) => setTimeout(r, 1200));
    }, { refreshMs: 100 });
  `, [dir]);
  await new Promise((resolve) => holder.child.stdout?.once('data', resolve));
  // staleMs (400) is far shorter than the hold time (1200): only the refresh keeps the lock valid
  await assert.rejects(withLock(dir, async () => {}, { timeoutMs: 700, staleMs: 400 }), LockTimeoutError);
  assert.equal((await holder.done).code, 0);
});

test('a process that exits while holding the lock removes it', async () => {
  const dir = freshDir();
  const child = runChild(`
    const { withLock } = await import(LOCK_URL);
    await withLock(process.argv[2], async () => { process.exit(0); });
  `, [dir]);
  assert.equal((await child.done).code, 0);
  assert.equal(fs.existsSync(dir), false);
});

test('a killed holder leaves a lock that the next process takes over', async () => {
  const dir = freshDir();
  const holder = runChild(`
    const { withLock } = await import(LOCK_URL);
    await withLock(process.argv[2], async () => {
      console.log('held');
      await new Promise((r) => setTimeout(r, 60000));
    });
  `, [dir]);
  await new Promise((resolve) => holder.child.stdout?.once('data', resolve));
  holder.child.kill('SIGKILL');
  await holder.done;
  assert.equal(fs.existsSync(dir), true, 'SIGKILL leaves the directory behind');
  assert.equal(await withLock(dir, async () => 'recovered', { timeoutMs: 2000 }), 'recovered');
});

test('errors thrown inside the critical section propagate and release the lock', async () => {
  const dir = freshDir();
  await assert.rejects(withLock(dir, async () => {
    throw new Error('inside');
  }), /inside/);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(await withLock(dir, () => 'again'), 'again');
});
