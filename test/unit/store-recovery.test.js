// @ts-check
// Unit tests for src/core/store/recovery.js: leftovers of crashed writes are ignored by readers and removed by
// recoverDoc (manifest-less sources, stale temp files, threads of uncommitted reviews), and doc.head is repaired.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-recovery-')));
process.env.SPECREVIEW_HOME = path.join(TMP, 'home');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { Store } = await import('../../src/core/store/store.js');
const { recoverDoc } = await import('../../src/core/store/recovery.js');
const { configureLogger } = await import('../../src/core/util/log.js');
configureLogger({ level: 'error' });

const deadPid = () => /** @type {number} */ (spawnSync(process.execPath, ['-e', '']).pid);

/** @returns {Promise<{ store: import('../../src/core/store/store.js').Store, docId: string }>} */
async function setup() {
  const root = fs.mkdtempSync(path.join(TMP, 'ws-'));
  fs.writeFileSync(path.join(root, 'spec.md'), '# v1\n');
  const store = await Store.open(root, { create: true });
  const doc = await store.createDoc({ path: 'spec.md' });
  await store.commitVersion(doc, { source: '# v1\n', manifest: { summary: 'v1' } });
  return { store, docId: doc.id };
}

test('removes manifest-less sources and stale temp files, keeps live ones, repairs head', async () => {
  const { store, docId } = await setup();
  const vdir = store.versionsDir(docId);
  const docDir = store.docDir(docId);
  // crash after writing the v2 source but before its manifest
  fs.writeFileSync(path.join(vdir, '0002.md'), '# v2\n');
  // crash during atomic writes: one by a dead process, one in flight in this (live) process
  const deadTmp = `0002.json.tmp-${deadPid()}-abcd`;
  fs.writeFileSync(path.join(vdir, deadTmp), '{');
  const liveTmp = `doc.json.tmp-${process.pid}-beef`;
  fs.writeFileSync(path.join(docDir, liveTmp), '{');
  // a very old temp file whose pid happens to be alive (pid reuse)
  const oldTmp = `t9.json.tmp-${process.ppid}-0001`;
  fs.mkdirSync(path.join(docDir, 'threads'), { recursive: true });
  fs.writeFileSync(path.join(docDir, 'threads', oldTmp), '{');
  const past = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(path.join(docDir, 'threads', oldTmp), past, past);
  // crash between manifest and doc.json: head lags behind
  await store.commitVersion(docId, { source: '# v2 for real\n', manifest: { summary: 'v2' } });
  const doc = /** @type {any} */ (await store.getDoc(docId));
  doc.head = 1;
  await store.saveDoc(doc);

  // readers already ignore the leftovers
  assert.deepEqual((await store.listVersions(docId)).map((m) => m.v), [1, 2]);

  fs.writeFileSync(path.join(vdir, '0003.md'), '# v3 uncommitted\n');
  const report = await recoverDoc(store, docId);
  assert.deepEqual(report.removedSources, ['versions/0003.md']);
  assert.deepEqual(report.removedTmp.sort(), [`threads/${oldTmp}`, `versions/${deadTmp}`].sort());
  assert.deepEqual(report.head, { from: 1, to: 2 });
  assert.equal(fs.existsSync(path.join(docDir, liveTmp)), true, 'in-flight temp file of a live process kept');
  assert.equal((await store.getDoc(docId))?.head, 2);
  assert.deepEqual(fs.readdirSync(vdir).sort(), ['0001.json', '0001.md', '0002.json', '0002.md']);

  const again = await store.recoverDoc(docId);
  assert.deepEqual(again, { removedSources: [], removedTmp: [], removedThreads: [], head: null, journal: null, final: null }, 'idempotent');
});

test('threads of a review that never reached its commit point are deleted; agent questions are kept', async () => {
  const { store, docId } = await setup();
  const base = { doc: docId, type: 'comment', severity: 'normal', status: 'open', anchors: {}, comments: [] };
  await store.saveReview(docId, /** @type {any} */ ({ id: 'rv1', version: 1, deliveredTo: {}, ackedBy: {} }));
  await store.saveThread(docId, /** @type {any} */ ({ ...base, id: 't1', review: 'rv1' }));
  await store.saveThread(docId, /** @type {any} */ ({ ...base, id: 't2', review: 'rv2' })); // rv2 never written
  await store.saveThread(docId, /** @type {any} */ ({ ...base, id: 't3', review: null, type: 'agent-question' }));

  assert.deepEqual((await store.listThreads(docId)).map((t) => t.id), ['t1', 't3'], 'readers ignore t2');
  const report = await store.recoverDoc(docId);
  assert.deepEqual(report.removedThreads, ['t2']);
  assert.deepEqual((await store.listThreads(docId, { includeUncommitted: true })).map((t) => t.id), ['t1', 't3']);
});

test('recoverDoc runs under the doc lock and is safe inside an op that already holds it', async () => {
  const { store, docId } = await setup();
  const report = await store.withDocLock(docId, () => store.recoverDoc(docId), { timeoutMs: 1000 });
  assert.equal(report.head, null);
});

test('a doc without versions recovers to head 0', async () => {
  const root = fs.mkdtempSync(path.join(TMP, 'ws-'));
  fs.writeFileSync(path.join(root, 'a.md'), 'x');
  const store = await Store.open(root, { create: true });
  const doc = await store.createDoc({ path: 'a.md' });
  fs.mkdirSync(store.versionsDir(doc.id), { recursive: true });
  fs.writeFileSync(path.join(store.versionsDir(doc.id), '0001.md'), 'x');
  const report = await store.recoverDoc(doc.id);
  assert.deepEqual(report.removedSources, ['versions/0001.md']);
  assert.equal((await store.getDoc(doc.id))?.head, 0);
});
