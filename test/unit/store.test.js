// @ts-check
// Unit tests for src/core/store/store.js: open/create, config, docs and ids, versions and blobs, threads /
// reviews / locks, runtime files (drafts, pending edits, events), attachments and the working copy (CAS).

import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-store-')));
const HOME = path.join(TMP, 'home');
process.env.SPECREVIEW_HOME = HOME;
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { Store, compareIds } = await import('../../src/core/store/store.js');
const { NotFoundError, ConflictError, RefusedError, UsageError } = await import('../../src/core/store/errors.js');
const { sha256 } = await import('../../src/core/util/hash.js');
const { setClock } = await import('../../src/core/util/time.js');
const { configureLogger } = await import('../../src/core/util/log.js');
configureLogger({ level: 'error' }); // expected warnings (invalid config, corrupt files) stay out of the output

let n = 0;
/**
 * New workspace root with files.
 * @param {Record<string, string | Buffer>} [files]
 */
function makeRoot(files = {}) {
  const root = path.join(TMP, `ws${++n}`);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

describe('open and config', () => {
  test('open without a store is NotFound; create initialises and registers', async () => {
    const root = makeRoot();
    await assert.rejects(Store.open(root), NotFoundError);
    await assert.rejects(Store.open(path.join(root, 'missing')), NotFoundError);
    const store = await Store.open(root, { create: true });
    assert.equal(store.root, root);
    assert.equal(store.storeDir, path.join(root, '.specreview'));
    assert.equal(store.wsId, sha256(root).slice(0, 8));
    const reg = JSON.parse(fs.readFileSync(path.join(HOME, 'workspaces.json'), 'utf8'));
    assert.equal(reg.workspaces[store.wsId].root, root);
    const again = await Store.open(path.join(root, '.'));
    assert.equal(again.wsId, store.wsId);
  });

  test('create refuses the filesystem root and the home directory', async () => {
    const prev = process.env.HOME;
    const fakeHome = makeRoot();
    process.env.HOME = fakeHome;
    try {
      await assert.rejects(Store.open(fakeHome, { create: true }), RefusedError);
    } finally {
      process.env.HOME = prev;
    }
    assert.equal(fs.existsSync(path.join(fakeHome, '.specreview')), false);
  });

  test('config merges defaults, keeps valid overrides, ignores invalid ones, resolves the reviewer', async () => {
    const root = makeRoot();
    const store = await Store.open(root, { create: true });
    const defaults = await store.config();
    assert.deepEqual(defaults.guards, {
      enforceLocks: true, maxRewriteRatio: 0.5, unexplainedWords: 20, unexplainedDeletionLines: 3,
      unexplainedDeletion: 'refuse', writeHook: 'deny', writeHookRatio: 0.4,
    });
    assert.deepEqual(defaults.anchoring, { minScore: 0.65, minQuoteSim: 0.6, contextChars: 32 });
    assert.deepEqual(defaults.render, { network: 'allow', mermaid: true, math: true, highlight: true });
    assert.deepEqual(defaults.git, { autoCommit: false });
    assert.deepEqual(defaults.assets, { maxBytes: 20971520 });
    assert.ok(defaults.reviewer.name.length > 0);

    fs.writeFileSync(path.join(store.storeDir, 'config.json'), JSON.stringify({
      schema: 1,
      reviewer: { name: 'Eric' },
      guards: { maxRewriteRatio: 0.8, unexplainedDeletion: 'sometimes', enforceLocks: 'yes' },
      render: { network: 'block' },
      extra: { kept: true },
    }));
    const cfg = await store.config();
    assert.equal(cfg.reviewer.name, 'Eric');
    assert.equal(cfg.guards.maxRewriteRatio, 0.8);
    assert.equal(cfg.guards.unexplainedDeletion, 'refuse', 'invalid enum ignored');
    assert.equal(cfg.guards.enforceLocks, true, 'wrong type ignored');
    assert.equal(cfg.guards.writeHookRatio, 0.4);
    assert.equal(cfg.render.network, 'block');
    assert.deepEqual(/** @type {any} */ (cfg).extra, { kept: true });
  });

  test('runtimeDir lives under SPECREVIEW_HOME/ws/<wsId> and never pre-creates lock directories', async () => {
    const store = await Store.open(makeRoot(), { create: true });
    const events = store.runtimeDir('events');
    assert.equal(events, path.join(HOME, 'ws', store.wsId, 'events'));
    assert.ok(fs.statSync(events).isDirectory());
    const lockDir = store.runtimeDir('locks', 'some-doc');
    assert.equal(fs.existsSync(lockDir), false);
    assert.ok(fs.statSync(path.dirname(lockDir)).isDirectory());
    assert.equal(store.cacheDir('render', 'd'), path.join(HOME, 'ws', store.wsId, 'cache', 'render', 'd'));
    assert.equal(store.docLockDir('d'), path.join(HOME, 'ws', store.wsId, 'locks', 'd'));
  });
});

describe('docs and ids', () => {
  /** @type {import('../../src/core/store/store.js').Store} */
  let store;
  /** @type {string} */
  let root;
  before(async () => {
    root = makeRoot({
      'docs/specs/Token Service.md': '# Token\n',
      'other/token-service.md': '# Other\n',
      'app.html': '<h1>x</h1>\n',
      'notes.txt': 'x',
    });
    store = await Store.open(root, { create: true });
  });

  test('createDoc assigns slug ids with -2 on collision and writes canonical doc.json', async () => {
    const restore = setClock('2026-10-10T13:55:02.000Z');
    try {
      const a = await store.createDoc({ path: path.join(root, 'docs/specs/Token Service.md'), createdBy: { kind: 'agent', name: 'claude' } });
      assert.equal(a.id, 'token-service');
      assert.equal(a.path, 'docs/specs/Token Service.md');
      assert.equal(a.format, 'markdown');
      assert.equal(a.title, 'Token Service.md');
      assert.equal(a.head, 0);
      assert.equal(a.state, 'in_review');
      assert.equal(a.createdAt, '2026-10-10T13:55:02.000Z');
      assert.deepEqual(a.counters, { thread: 0, comment: 0, review: 0, lock: 0, decision: 0, draft: 0, attachment: 0 });
      const b = await store.createDoc({ path: 'other/token-service.md', title: 'Other' });
      assert.equal(b.id, 'token-service-2');
      assert.equal(b.title, 'Other');
      const c = await store.createDoc({ path: 'app.html' });
      assert.equal(c.format, 'html');
      const text = fs.readFileSync(path.join(store.storeDir, 'docs', 'token-service', 'doc.json'), 'utf8');
      const keys = [...text.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]);
      assert.deepEqual(keys, [...keys].sort());
      assert.ok(text.endsWith('}\n'));
    } finally {
      restore();
    }
  });

  test('createDoc refuses duplicates, outside paths and unsupported types', async () => {
    await assert.rejects(store.createDoc({ path: 'app.html' }), ConflictError);
    await assert.rejects(store.createDoc({ path: path.join(TMP, 'elsewhere.md') }), RefusedError);
    await assert.rejects(store.createDoc({ path: 'notes.txt' }), UsageError);
  });

  test('concurrent createDoc calls for distinct files get distinct ids', async () => {
    const r = makeRoot({ 'a/spec.md': 'a', 'b/spec.md': 'b', 'c/spec.md': 'c' });
    const s = await Store.open(r, { create: true });
    const docs = await Promise.all(['a', 'b', 'c'].map((d) => s.createDoc({ path: `${d}/spec.md` })));
    assert.deepEqual(docs.map((d) => d.id).sort(), ['spec', 'spec-2', 'spec-3']);
    assert.equal(await s.findDoc('spec.md'), null, 'an ambiguous basename does not resolve');
  });

  test('listDocs, getDoc and findDoc by id, path and unique basename', async () => {
    assert.deepEqual((await store.listDocs()).map((d) => d.id), ['app', 'token-service', 'token-service-2']);
    assert.equal((await store.getDoc('app'))?.path, 'app.html');
    assert.equal(await store.getDoc('../etc'), null);
    assert.equal((await store.findDoc('token-service'))?.id, 'token-service');
    assert.equal((await store.findDoc(path.join(root, 'other', 'token-service.md')))?.id, 'token-service-2');
    assert.equal((await store.findDoc('docs/specs/Token Service.md'))?.id, 'token-service');
    assert.equal((await store.findDoc('app.html'))?.id, 'app');
    assert.equal((await store.findDoc('Token Service.md'))?.id, 'token-service', 'unique basename');
    assert.equal((await store.findDoc('token-service.md'))?.id, 'token-service-2', 'unique basename');
    const prevCwd = process.cwd();
    process.chdir(path.join(root, 'docs'));
    try {
      assert.equal((await store.findDoc('specs/Token Service.md'))?.id, 'token-service', 'cwd-relative path');
    } finally {
      process.chdir(prevCwd);
    }
    assert.equal(await store.findDoc('nope'), null);
    await assert.rejects(store.requireDoc('nope'), NotFoundError);
  });

  test('nextId allocates sequential ids per kind and mutates counters', async () => {
    const doc = /** @type {import('../../src/shared/types.js').Doc} */ (await store.getDoc('app'));
    assert.equal(store.nextId(doc, 'thread'), 't1');
    assert.equal(store.nextId(doc, 'thread'), 't2');
    assert.equal(store.nextId(doc, 'comment'), 'c1');
    assert.equal(store.nextId(doc, 'review'), 'rv1');
    assert.equal(store.nextId(doc, 'lock'), 'L1');
    assert.equal(store.nextId(doc, 'decision'), 'D1');
    assert.equal(store.nextId(doc, 'draft'), 'd1');
    assert.equal(store.nextId(doc, 'attachment'), 'a1');
    assert.equal(doc.counters.thread, 2);
    assert.throws(() => store.nextId(doc, /** @type {any} */ ('bogus')), UsageError);
    await store.saveDoc(doc);
    assert.equal((await store.getDoc('app'))?.counters.thread, 2);
  });

  test('compareIds orders numerically', () => {
    assert.deepEqual(['t10', 't2', 't1', 'rv3'].sort(compareIds), ['rv3', 't1', 't2', 't10']);
  });

  // macOS volumes ignore case and Unicode normalization: every spelling of a file is that one file, and one doc
  const probe = makeRoot({ 'Probe.md': 'x', ['café.md']: 'x' });
  const insensitive = fs.existsSync(path.join(probe, 'probe.md')) && fs.existsSync(path.join(probe, 'café.md'));
  test('a case or Unicode-normalization variant of a tracked path is the same doc', { skip: !insensitive && 'case- or normalization-sensitive volume' }, async () => {
    const nfd = 'docs/café.md';
    const nfc = 'docs/café.md';
    const r = makeRoot({ 'docs/Token-Service.md': '# Token\n', [nfd]: '# Café\n' });
    const s = await Store.open(r, { create: true });
    const doc = await s.createDoc({ path: 'docs/token-service.md' });
    assert.equal(doc.path, 'docs/Token-Service.md', 'recorded as the file is named on disk');
    await assert.rejects(s.createDoc({ path: 'DOCS/TOKEN-SERVICE.MD' }), ConflictError);
    assert.equal((await s.findDoc('docs/TOKEN-service.md'))?.id, doc.id);
    const cafe = await s.createDoc({ path: nfc });
    assert.equal(cafe.path, nfd, 'the on-disk (decomposed) spelling');
    await assert.rejects(s.createDoc({ path: nfd }), ConflictError);
    assert.equal((await s.findDoc(nfc))?.id, cafe.id);
    // a record written before paths were canonical (another spelling) still matches, for lookups and duplicates
    const legacy = /** @type {import('../../src/shared/types.js').Doc} */ (await s.getDoc(doc.id));
    legacy.path = 'docs/token-service.md';
    await s.saveDoc(legacy);
    assert.equal((await s.findDoc('docs/Token-Service.md'))?.id, doc.id);
    await assert.rejects(s.createDoc({ path: 'docs/Token-Service.md' }), ConflictError);
    assert.equal((await s.listDocs()).length, 2);
  });
});

describe('versions and blobs', () => {
  test('commitVersion writes blobs, source, manifest, head; readVersion and listVersions read them back', async () => {
    const root = makeRoot({
      'spec.md': '# A\n\n![x](img/a.png)\n',
      'img/a.png': Buffer.from([1, 2, 3]),
      'img/big.png': Buffer.alloc(64, 7),
    });
    const store = await Store.open(root, { create: true });
    fs.writeFileSync(path.join(store.storeDir, 'config.json'), JSON.stringify({ assets: { maxBytes: 32 } }));
    const doc = await store.createDoc({ path: 'spec.md' });
    const restore = setClock('2026-10-10T14:00:00.000Z');
    let m1;
    try {
      m1 = await store.commitVersion(doc, {
        source: '# A\n\n![x](img/a.png)\n',
        manifest: { author: { kind: 'agent', name: 'claude' }, summary: 'initial draft', respondsTo: null, capturedBy: 'open' },
        assetFiles: { 'img/a.png': path.join(root, 'img/a.png'), 'img/big.png': null, 'img/missing.png': null },
      });
    } finally {
      restore();
    }
    assert.equal(m1.v, 1);
    assert.equal(m1.parent, null);
    assert.equal(m1.file, '0001.md');
    assert.equal(m1.sha256, sha256('# A\n\n![x](img/a.png)\n'));
    assert.equal(m1.bytes, 21);
    assert.equal(m1.lines, 3);
    assert.equal(m1.createdAt, '2026-10-10T14:00:00.000Z');
    assert.equal(m1.summary, 'initial draft');
    assert.equal(m1.schema, 1);
    assert.deepEqual(Object.keys(m1.assets), ['img/a.png', 'img/big.png']);
    assert.equal(m1.assets['img/a.png'], `sha256:${sha256(Buffer.from([1, 2, 3]))}`);
    assert.equal(m1.assets['img/big.png'], 'live');
    assert.equal(doc.head, 1, 'the passed Doc object is updated');
    assert.equal((await store.getDoc(doc.id))?.head, 1);
    const blob = store.blobPath(m1.assets['img/a.png']);
    assert.ok(blob?.endsWith('.png'));
    assert.deepEqual(fs.readFileSync(/** @type {string} */ (blob)), Buffer.from([1, 2, 3]));
    assert.equal(store.blobPath('live'), null);

    // by id, with a Buffer source (exact bytes, BOM kept)
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# B\r\n')]);
    const m2 = await store.commitVersion(doc.id, { source: bytes, manifest: { summary: 'v2' } });
    assert.equal(m2.v, 2);
    assert.equal(m2.parent, 1);
    assert.equal(m2.sha256, sha256(bytes));
    assert.equal((await store.getDoc(doc.id))?.head, 2);
    const r2 = await store.readVersion(doc.id, 'v2');
    assert.equal(r2.source, '# B\r\n');
    assert.deepEqual(r2.buf, bytes);
    assert.equal((await store.readVersion(doc.id, 1)).source, '# A\n\n![x](img/a.png)\n');

    // a crashed commit leaves a source without a manifest: readers ignore it
    fs.writeFileSync(path.join(store.versionsDir(doc.id), '0003.md'), 'uncommitted');
    assert.deepEqual((await store.listVersions(doc.id)).map((m) => m.v), [1, 2]);
    await assert.rejects(store.readVersion(doc.id, 3), NotFoundError);
    // and the next commit simply overwrites it
    const m3 = await store.commitVersion(doc.id, { source: 'three\n', manifest: { summary: 'v3' } });
    assert.equal(m3.v, 3);
    assert.equal((await store.readVersion(doc.id, 3)).source, 'three\n');

    await assert.rejects(store.commitVersion(doc.id, { source: 'x', manifest: { v: 3 } }), ConflictError);
    await assert.rejects(store.commitVersion(doc.id, { source: 'x', manifest: { v: 9 } }), ConflictError);
    await assert.rejects(store.readVersion(doc.id, 'bogus'), UsageError);
    await assert.rejects(store.commitVersion('nope', { source: 'x' }), NotFoundError);
  });

  test('commitVersion never copies what the content origin refuses: dot-files, key files, symlinks to them', async () => {
    const root = makeRoot({
      'spec.md': '# A\n',
      'img/ok.png': Buffer.from([1, 2, 3]),
      'docs/.env': 'API_KEY=secret\n',
      'secrets/server.pem': 'PRIVATE KEY\n',
      'docs/ID_RSA': 'PRIVATE KEY\n',
      '.git/config': '[core]\n',
    });
    fs.symlinkSync(path.join(root, 'docs', '.env'), path.join(root, 'img', 'alias.png'));
    const store = await Store.open(root, { create: true });
    const doc = await store.createDoc({ path: 'spec.md' });
    const refs = ['img/ok.png', 'docs/.env', 'secrets/server.pem', 'docs/ID_RSA', '.git/config', 'img/alias.png'];
    const m = await store.commitVersion(doc, { source: '# A\n', assetFiles: Object.fromEntries(refs.map((r) => [r, null])) });
    assert.deepEqual(Object.keys(m.assets), ['img/ok.png']);
    const stored = fs.readdirSync(path.join(store.storeDir, 'assets', 'sha256'), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile()).map((e) => fs.readFileSync(path.join(e.parentPath, e.name)));
    assert.deepEqual(stored, [Buffer.from([1, 2, 3])], 'no secret reached the store');
  });

  test('putBlob is content addressed and idempotent', async () => {
    const store = await Store.open(makeRoot(), { create: true });
    const ref = await store.putBlob(Buffer.from('hello'), '.PNG');
    assert.equal(ref, `sha256:${sha256('hello')}`);
    const p = /** @type {string} */ (store.blobPath(ref));
    assert.equal(p, path.join(store.storeDir, 'assets', 'sha256', sha256('hello').slice(0, 2), `${sha256('hello')}.png`));
    const mtime = fs.statSync(p).mtimeMs;
    assert.equal(await store.putBlob(Buffer.from('hello'), 'png'), ref);
    assert.equal(fs.statSync(p).mtimeMs, mtime);
    const noExt = await store.putBlob(new Uint8Array([9]));
    assert.ok(store.blobPath(noExt));
    assert.equal(store.blobPath(`sha256:${'0'.repeat(64)}`), null);
    assert.equal(store.blobPath('sha256:../../etc'), null);
  });
});

describe('threads, reviews, locks', () => {
  test('save/get/list/delete with numeric order and uncommitted-review filtering', async () => {
    const store = await Store.open(makeRoot({ 's.md': 'x' }), { create: true });
    const doc = await store.createDoc({ path: 's.md' });
    const base = { doc: doc.id, type: 'comment', severity: 'normal', status: 'open', anchors: {}, comments: [] };
    await store.saveThread(doc.id, /** @type {any} */ ({ ...base, id: 't10', review: 'rv1' }));
    await store.saveThread(doc.id, /** @type {any} */ ({ ...base, id: 't2', review: 'rv1' }));
    await store.saveThread(doc.id, /** @type {any} */ ({ ...base, id: 't3', review: null, type: 'agent-question' }));
    await store.saveThread(doc.id, /** @type {any} */ ({ ...base, id: 't11', review: 'rv2' }));
    fs.writeFileSync(path.join(store.docDir(doc.id), 'threads', 't12.json.tmp-1-abc'), '{');

    // rv1 not committed yet: only the agent question is visible
    assert.deepEqual((await store.listThreads(doc.id)).map((t) => t.id), ['t3']);
    assert.equal(await store.getThread(doc.id, 't2'), null);
    assert.equal((await store.getThread(doc.id, 't2', { includeUncommitted: true }))?.id, 't2');
    assert.deepEqual((await store.listThreads(doc.id, { includeUncommitted: true })).map((t) => t.id), ['t2', 't3', 't10', 't11']);

    await store.saveReview(doc.id, /** @type {any} */ ({ id: 'rv1', version: 1, verdict: 'comment', deliveredTo: {}, ackedBy: {} }));
    assert.deepEqual((await store.listThreads(doc.id)).map((t) => t.id), ['t2', 't3', 't10']);
    const t2 = await store.getThread(doc.id, 't2');
    assert.equal(t2?.schema, 1);
    assert.equal(await store.getThread(doc.id, '../doc'), null);

    assert.equal(await store.deleteThread(doc.id, 't10'), true);
    assert.equal(await store.deleteThread(doc.id, 't10'), false);
    await assert.rejects(store.saveThread(doc.id, /** @type {any} */ ({ id: '../x' })), UsageError);

    assert.deepEqual((await store.listReviews(doc.id)).map((r) => r.id), ['rv1']);
    assert.equal((await store.getReview(doc.id, 'rv1'))?.verdict, 'comment');
    assert.equal(await store.getReview(doc.id, 'rv9'), null);

    await store.saveLock(doc.id, /** @type {any} */ ({ id: 'L2', active: true }));
    await store.saveLock(doc.id, /** @type {any} */ ({ id: 'L1', active: false }));
    assert.deepEqual((await store.listLocks(doc.id)).map((l) => l.id), ['L1', 'L2']);
    assert.equal((await store.getLock(doc.id, 'L2'))?.active, true);
  });

  test('a corrupt thread file is skipped by listings, not fatal', async () => {
    const store = await Store.open(makeRoot({ 's.md': 'x' }), { create: true });
    const doc = await store.createDoc({ path: 's.md' });
    await store.saveThread(doc.id, /** @type {any} */ ({ id: 't1', review: null }));
    fs.writeFileSync(path.join(store.docDir(doc.id), 'threads', 't2.json'), '{"id":"t2", <<<<<<< merge conflict');
    assert.deepEqual((await store.listThreads(doc.id)).map((t) => t.id), ['t1']);
    await assert.rejects(store.getThread(doc.id, 't2'), /corrupt JSON/);
  });
});

describe('runtime state', () => {
  /** @type {import('../../src/core/store/store.js').Store} */
  let store;
  /** @type {string} */
  let docId;
  before(async () => {
    store = await Store.open(makeRoot({ 's.md': 'x' }), { create: true });
    docId = (await store.createDoc({ path: 's.md' })).id;
  });

  test('drafts default to empty and round-trip', async () => {
    assert.deepEqual(await store.getDrafts(docId), { schema: 1, items: [] });
    const items = [{ id: 'd1', kind: 'reply', thread: 't1', body: 'hi', updatedAt: 'x' }];
    await store.saveDrafts(docId, /** @type {any} */ ({ items }));
    assert.deepEqual(await store.getDrafts(docId), { schema: 1, items });
    assert.ok(store.draftsFile(docId).startsWith(path.join(HOME, 'ws', store.wsId, 'drafts')));
  });

  test('pending edits append, read, clear', async () => {
    assert.deepEqual(await store.readPendingEdits(docId), []);
    await store.appendPendingEdit(docId, /** @type {any} */ ({ via: 'apply', threads: ['t3'], newLines: [120, 120] }));
    await store.appendPendingEdit(docId, /** @type {any} */ ({ via: 'override', thread: 't2', lines: [90, 91], at: 'fixed' }));
    const edits = await store.readPendingEdits(docId);
    assert.equal(edits.length, 2);
    assert.ok(edits[0].at && edits[0].at !== 'fixed');
    assert.equal(edits[1].at, 'fixed');
    await store.clearPendingEdits(docId);
    assert.deepEqual(await store.readPendingEdits(docId), []);
  });

  test('events get increasing seqs, even when appended concurrently', async () => {
    assert.equal(await store.lastSeq(docId), 0);
    assert.equal(await store.appendEvent(docId, { type: 'doc.opened' }), 1);
    const seqs = await Promise.all(Array.from({ length: 15 }, (_, i) => store.appendEvent(docId, { type: 'thread.updated', thread: `t${i}` })));
    assert.deepEqual([...seqs].sort((a, b) => a - b), Array.from({ length: 15 }, (_, i) => i + 2));
    assert.equal(await store.lastSeq(docId), 16);
    const after10 = await store.readEvents(docId, 10);
    assert.deepEqual(after10.map((e) => e.seq), [11, 12, 13, 14, 15, 16]);
    const first = (await store.readEvents(docId))[0];
    assert.deepEqual(Object.keys(first).slice(0, 3), ['seq', 'at', 'type']);
    assert.equal(await store.appendEvent(docId, { type: 'x', seq: 999 }), 17, 'caller seq is ignored');
    await assert.rejects(store.appendEvent(docId, /** @type {any} */ ({})), UsageError);
  });

  test('appendEvent inside withDocLock re-enters the lock', async () => {
    const seq = await store.withDocLock(docId, () => store.appendEvent(docId, { type: 'lock.changed' }), { timeoutMs: 1000 });
    assert.equal(seq, await store.lastSeq(docId));
  });

  test('attachments are saved under the doc and addressed doc-relative', async () => {
    const rel = await store.saveAttachment(docId, 'a1.png', Buffer.from([1]));
    assert.equal(rel, 'attachments/a1.png');
    const abs = store.attachmentPath(docId, rel);
    assert.equal(abs, path.join(store.docDir(docId), 'attachments', 'a1.png'));
    assert.deepEqual(fs.readFileSync(abs), Buffer.from([1]));
    assert.equal(store.attachmentPath(docId, 'a1.png'), abs);
    await assert.rejects(store.saveAttachment(docId, '../x.png', Buffer.from([1])), UsageError);
    assert.throws(() => store.attachmentPath(docId, 'attachments/../../doc.json'), UsageError);
  });

  test('ids are validated before touching the filesystem', async () => {
    assert.throws(() => store.docDir('../x'), UsageError);
    assert.throws(() => store.eventsFile('a/b'), UsageError);
    await assert.rejects(store.getDrafts('..'), UsageError);
  });
});

describe('working copy', () => {
  test('readWorking / writeWorking with compare-and-swap, mode and BOM preservation', async () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# T\r\nold\r\n')]);
    const root = makeRoot({ 'd/spec.md': bom });
    fs.chmodSync(path.join(root, 'd/spec.md'), 0o640);
    const store = await Store.open(root, { create: true });
    const doc = await store.createDoc({ path: 'd/spec.md' });
    const w = await store.readWorking(doc);
    assert.equal(w.text, '# T\r\nold\r\n');
    assert.equal(w.sha256, sha256(bom));

    const res = await store.writeWorking(doc, '# T\r\nnew\r\n', { expectSha256: w.sha256 });
    const bytes = fs.readFileSync(path.join(root, 'd/spec.md'));
    assert.deepEqual(bytes.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]), 'BOM kept');
    assert.equal(bytes.subarray(3).toString(), '# T\r\nnew\r\n');
    assert.equal(res.sha256, sha256(bytes));
    assert.equal(fs.statSync(path.join(root, 'd/spec.md')).mode & 0o777, 0o640, 'mode kept');

    await assert.rejects(store.writeWorking(doc, 'lost update', { expectSha256: w.sha256 }), (err) => {
      assert.ok(err instanceof ConflictError);
      assert.equal(err.exit, 3);
      return true;
    });
    assert.equal(fs.readFileSync(path.join(root, 'd/spec.md')).subarray(3).toString(), '# T\r\nnew\r\n');
    await assert.rejects(store.writeWorking(doc, 'x', /** @type {any} */ ({})), UsageError);
    assert.deepEqual(fs.readdirSync(path.join(root, 'd')), ['spec.md'], 'no temp files left');
  });

  test('a symlinked working file is written through to its target', async () => {
    const root = makeRoot({ 'real/spec.md': 'one\n' });
    fs.symlinkSync(path.join(root, 'real/spec.md'), path.join(root, 'link.md'));
    const store = await Store.open(root, { create: true });
    const doc = { path: 'link.md' };
    const w = await store.readWorking(doc);
    await store.writeWorking(doc, 'two\n', { expectSha256: w.sha256 });
    assert.ok(fs.lstatSync(path.join(root, 'link.md')).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(root, 'real/spec.md'), 'utf8'), 'two\n');
  });

  test('a doc path that escapes the workspace is refused', async () => {
    const store = await Store.open(makeRoot(), { create: true });
    for (const bad of ['../outside.md', '/etc/hosts', '', 'a/../../x.md']) {
      assert.throws(() => store.workingPath({ path: bad }), RefusedError, bad);
      await assert.rejects(store.readWorking({ path: bad }), RefusedError, bad);
      await assert.rejects(store.writeWorking({ path: bad }, 'x', { expectSha256: 'abc' }), RefusedError, bad);
    }
    assert.equal(store.workingPath({ path: 'a/b.md' }), path.join(store.root, 'a', 'b.md'));
  });

  test('the doc directory name wins over a mismatching id in doc.json', async () => {
    const store = await Store.open(makeRoot({ 'x.md': 'x' }), { create: true });
    const doc = await store.createDoc({ path: 'x.md' });
    const file = path.join(store.docDir(doc.id), 'doc.json');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"id": "x"', '"id": "renamed"'));
    assert.equal((await store.getDoc('x'))?.id, 'x');
    assert.deepEqual((await store.listDocs()).map((d) => d.id), ['x']);
  });

  test('a missing working copy is NotFound', async () => {
    const store = await Store.open(makeRoot(), { create: true });
    await assert.rejects(store.readWorking({ path: 'gone.md' }), NotFoundError);
    await assert.rejects(store.writeWorking({ path: 'gone.md' }, 'x', { expectSha256: 'abc' }), NotFoundError);
  });
});
