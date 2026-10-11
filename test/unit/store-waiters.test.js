// @ts-check
// Unit tests for the waiter registry (BUILD_AMENDMENTS 2.4): registration, heartbeats, liveness, supersede
// semantics per (doc, agent), the '_all' doc for `wait --all`, and cleanup of dead waiters.

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-waiters-')));
process.env.SPECREVIEW_HOME = path.join(TMP, 'home');

const { Store, WAITER_LIVE_MS } = await import('../../src/core/store/store.js');
const { UsageError } = await import('../../src/core/store/errors.js');

/** Long-lived helper processes whose pids stand in for other `wait` processes. */
const helpers = /** @type {import('node:child_process').ChildProcess[]} */ ([]);
const livePid = () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  helpers.push(child);
  return /** @type {number} */ (child.pid);
};
const deadPid = () => /** @type {number} */ (spawnSync(process.execPath, ['-e', '']).pid);

after(() => {
  for (const h of helpers) h.kill('SIGKILL');
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** @type {import('../../src/core/store/store.js').Store} */
let store;
/** @type {string} */
let docId;
before(async () => {
  const root = path.join(TMP, 'ws');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'spec.md'), '# x\n');
  store = await Store.open(root, { create: true });
  docId = (await store.createDoc({ path: 'spec.md' })).id;
});

test('register, list, heartbeat and remove', async () => {
  const w = await store.registerWaiter(docId, { agent: 'claude' });
  assert.equal(w.pid, process.pid);
  assert.equal(w.file, path.join(store.waitersDir(docId), `${process.pid}.json`));
  const rec = JSON.parse(fs.readFileSync(w.file, 'utf8'));
  assert.deepEqual(Object.keys(rec).sort(), ['agent', 'heartbeatAt', 'pid', 'since']);
  let live = await store.listWaiters(docId);
  assert.deepEqual(live.map((x) => [x.pid, x.agent, x.doc, x.live]), [[process.pid, 'claude', docId, true]]);
  const before = rec.heartbeatAt;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await w.heartbeat(), null);
  const after1 = JSON.parse(fs.readFileSync(w.file, 'utf8'));
  assert.ok(after1.heartbeatAt > before);
  assert.equal(after1.since, rec.since);
  await w.remove();
  assert.equal(fs.existsSync(w.file), false);
  assert.equal(await w.heartbeat(), null, 'no resurrection after remove');
  assert.equal(fs.existsSync(w.file), false);
  live = await store.listWaiters(docId);
  assert.deepEqual(live, []);
});

test('a new waiter for the same (doc, agent) supersedes the old one; other agents are untouched', async () => {
  const oldPid = livePid();
  const otherAgentPid = livePid();
  const old = await store.registerWaiter(docId, { agent: 'claude', pid: oldPid });
  const codex = await store.registerWaiter(docId, { agent: 'codex', pid: otherAgentPid });
  assert.equal(await old.isSuperseded(), null);

  const fresh = await store.registerWaiter(docId, { agent: 'claude', pid: process.pid });
  assert.equal(await old.isSuperseded(), process.pid);
  assert.equal(await codex.isSuperseded(), null);
  assert.equal(await fresh.isSuperseded(), null);

  // the superseded waiter's own heartbeat must not erase the mark
  assert.equal(await old.heartbeat(), process.pid);
  assert.equal(await old.isSuperseded(), process.pid);

  const live = await store.listWaiters(docId);
  assert.deepEqual(live.map((w) => w.pid).sort(), [otherAgentPid, process.pid].sort());
  const all = await store.listWaiters(docId, { liveOnly: false });
  const oldEntry = all.find((w) => w.pid === oldPid);
  assert.equal(oldEntry?.live, false);
  assert.equal(oldEntry?.supersededBy, process.pid);

  await Promise.all([old.remove(), codex.remove(), fresh.remove()]);
});

test('waiters with a stale heartbeat or a dead pid are not live; dead ones are cleaned up on register', async () => {
  const dir = store.waitersDir(docId);
  const stalePid = livePid();
  const gone = deadPid();
  const old = new Date(Date.now() - WAITER_LIVE_MS - 1000).toISOString();
  fs.writeFileSync(path.join(dir, `${stalePid}.json`), JSON.stringify({ pid: stalePid, agent: 'claude', since: old, heartbeatAt: old }));
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, `${gone}.json`), JSON.stringify({ pid: gone, agent: 'claude', since: now, heartbeatAt: now }));
  assert.deepEqual(await store.listWaiters(docId), []);
  assert.equal((await store.listWaiters(docId, { liveOnly: false })).length, 2);

  const w = await store.registerWaiter(docId, { agent: 'claude' });
  assert.equal(fs.existsSync(path.join(dir, `${gone}.json`)), false, 'dead waiter file removed');
  const staleRec = JSON.parse(fs.readFileSync(path.join(dir, `${stalePid}.json`), 'utf8'));
  assert.equal(staleRec.supersededBy, undefined, 'a non-live (stale) waiter is not marked');
  await w.remove();
  fs.rmSync(path.join(dir, `${stalePid}.json`));
});

test("'_all' and '*' address the wait --all registry", async () => {
  const w = await store.registerWaiter('*', { agent: 'claude' });
  assert.equal(w.docId, '_all');
  assert.equal(path.basename(path.dirname(w.file)), '_all');
  assert.equal((await store.listWaiters('_all')).length, 1);
  assert.equal((await store.listWaiters('*')).length, 1);
  assert.deepEqual(await store.listWaiters(docId), []);
  await w.remove();
});

test('invalid input is rejected', async () => {
  await assert.rejects(store.registerWaiter(docId, /** @type {any} */ ({})), UsageError);
  await assert.rejects(store.registerWaiter('../x', { agent: 'a' }), UsageError);
  await assert.rejects(store.registerWaiter(docId, { agent: 'a', pid: -1 }), UsageError);
});
