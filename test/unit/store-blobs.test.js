// @ts-check
// Code docs in the store (design 2.1, 2.5, 2.8): createSnapshotDoc({kind: 'code'}) (format 'text', origin type
// 'diff', synthetic 'code/<id>.diff' path, always ephemeral with a '.gitignore' of '*'), identity by origin key,
// findDoc never matching a code doc, no working file, `.diff` version files, the per-doc blob store
// (putDocBlob / readDocBlob), recovery of temp files in blobs/ and of stale code-index dirs, and autoCommit
// skipping ephemeral docs.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NotFoundError, RefusedError, UsageError } from '../../src/core/store/errors.js';
import { codePath, isCode, isSnapshot, isVirtual } from '../../src/core/store/snapshot.js';
import { autoCommit } from '../../src/core/review/git.js';
import { getRender, renderSource } from '../../src/core/render/index.js';
import { engineCtx, makeWorkspace } from '../helpers/engine.js';

/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
beforeEach(async () => {
  ws = await makeWorkspace({ files: [] });
});
afterEach(async () => {
  await ws.cleanup();
});

const SPEC = { mode: /** @type {const} */ ('since-base'), base: 'main', context: 3 };
const ORIGIN = { type: 'diff', key: 'diff:since-base:main' };

describe('code docs in the store', () => {
  test('createSnapshotDoc({kind: code}) writes kind, code spec, a .diff path, ephemeral and a .gitignore', async () => {
    const ctx = await engineCtx(ws.root);
    const { doc, created } = await ctx.store.createSnapshotDoc({ kind: 'code', title: 'Feat token refresh', slug: 'cr-feat-token-refresh', origin: ORIGIN, code: SPEC });
    assert.equal(created, true);
    assert.equal(doc.id, 'cr-feat-token-refresh');
    assert.equal(doc.kind, 'code');
    assert.equal(doc.format, 'text');
    assert.equal(doc.path, 'code/cr-feat-token-refresh.diff');
    assert.equal(doc.path, codePath(doc.id));
    assert.equal(doc.ephemeral, true);
    assert.deepEqual(doc.code, SPEC);
    assert.deepEqual(doc.origin, ORIGIN);
    assert.ok(isCode(doc) && isVirtual(doc) && !isSnapshot(doc));
    const dir = path.join(ws.root, '.specreview', 'docs', doc.id);
    assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*\n');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'doc.json'), 'utf8'));
    assert.equal(onDisk.kind, 'code');
    assert.equal(onDisk.ephemeral, true);
    assert.equal(fs.existsSync(path.join(ws.root, 'code')), false, 'nothing is written at the synthetic path');
  });

  test('a code doc needs format text, origin type diff and a valid code spec; unknown kinds are refused', async () => {
    const ctx = await engineCtx(ws.root);
    await assert.rejects(ctx.store.createSnapshotDoc({ kind: 'code', format: 'markdown', origin: ORIGIN, code: SPEC }), UsageError);
    await assert.rejects(ctx.store.createSnapshotDoc({ kind: 'code', origin: { type: 'plan', key: null }, code: SPEC }), UsageError);
    await assert.rejects(ctx.store.createSnapshotDoc({ kind: 'code', origin: ORIGIN }), UsageError);
    await assert.rejects(ctx.store.createSnapshotDoc({ kind: 'code', origin: ORIGIN, code: { mode: 'everything', context: 3 } }), UsageError);
    await assert.rejects(ctx.store.createSnapshotDoc({ kind: 'code', origin: ORIGIN, code: { mode: 'staged', context: -1 } }), UsageError);
    await assert.rejects(ctx.store.createSnapshotDoc({ kind: /** @type {any} */ ('file'), origin: ORIGIN }), UsageError);
    await assert.rejects(ctx.store.createSnapshotDoc({ format: 'text', origin: { type: 'stdin', key: null } }), UsageError, 'snapshots stay markdown or html');
    assert.equal((await ctx.store.listDocs()).length, 0);
  });

  test('findDocByOrigin finds code docs (deduped); findDoc matches them by id only', async () => {
    const ctx = await engineCtx(ws.root);
    const results = await Promise.all([1, 2, 3].map(() => ctx.store.createSnapshotDoc({ kind: 'code', title: 'Review', origin: ORIGIN, code: SPEC })));
    assert.equal(new Set(results.map((r) => r.doc.id)).size, 1);
    assert.equal(results.filter((r) => r.created).length, 1);
    const id = results[0].doc.id;
    assert.equal((await ctx.store.findDocByOrigin(ORIGIN.key))?.id, id);
    assert.equal((await ctx.store.findDoc(id))?.id, id);
    assert.equal(await ctx.store.findDoc(`code/${id}.diff`), null);
    assert.equal(await ctx.store.findDoc(`${id}.diff`), null);
  });

  test('a code doc has no working file: workingPath and writeWorking refuse, readWorking is head', async () => {
    const ctx = await engineCtx(ws.root);
    const { doc } = await ctx.store.createSnapshotDoc({ kind: 'code', title: 'Review', origin: ORIGIN, code: SPEC });
    assert.throws(() => ctx.store.workingPath(doc), RefusedError);
    await assert.rejects(ctx.store.readWorking(doc), NotFoundError, 'no version yet');
    const m = await ctx.store.commitVersion(doc, { source: 'suiko code review\n', manifest: { capturedBy: 'open', code: /** @type {any} */ ({ files: [] }) } });
    assert.equal(m.file, '0001.diff');
    assert.ok(fs.existsSync(path.join(ws.root, '.specreview', 'docs', doc.id, 'versions', '0001.diff')));
    const fresh = await ctx.store.requireDoc(doc.id);
    assert.equal((await ctx.store.readWorking(fresh)).text, 'suiko code review\n');
    await assert.rejects(ctx.store.writeWorking(fresh, 'x', { expectSha256: m.sha256 }), (err) => err instanceof RefusedError && /edit the files with your own tools/.test(err.message));
  });

  test('the text format renders an empty RenderResult', async () => {
    const ctx = await engineCtx(ws.root);
    const { doc } = await ctx.store.createSnapshotDoc({ kind: 'code', title: 'Review', origin: ORIGIN, code: SPEC });
    await ctx.store.commitVersion(doc, { source: 'diff --suiko a/x b/x\n<script>alert(1)</script>\n', manifest: { capturedBy: 'open' } });
    for (const r of [await renderSource({ format: 'text', source: '<h1>x</h1>' }), await getRender(ctx.store, await ctx.store.requireDoc(doc.id), 1), await ctx.render(doc, 'live')]) {
      assert.equal(r.format, 'text');
      assert.equal(r.html, '');
      assert.deepEqual(r.srcmap.order, []);
      assert.deepEqual(r.outline, []);
      assert.deepEqual(r.assets, []);
      assert.deepEqual(r.externals, []);
      assert.equal(r.text.text, '');
    }
  });

  test('autoCommit skips ephemeral docs whatever the config says', async () => {
    const r = await autoCommit({ root: ws.root, config: { git: { autoCommit: true } }, docId: 'x', docPath: null, version: 1, summary: 's', ephemeral: true });
    assert.deepEqual(r, { commit: null, skipped: 'ephemeral doc' });
  });
});

describe('per-doc blobs', () => {
  test('putDocBlob is content-addressed, idempotent and stored under blobs/<hex[0..2]>/<hex>', async () => {
    const ctx = await engineCtx(ws.root);
    const { doc } = await ctx.store.createSnapshotDoc({ kind: 'code', title: 'Review', origin: ORIGIN, code: SPEC });
    const ref = await ctx.store.putDocBlob(doc.id, Buffer.from('export const a = 1;\n'));
    assert.match(ref, /^sha256:[0-9a-f]{64}$/);
    assert.equal(await ctx.store.putDocBlob(doc.id, 'export const a = 1;\n'), ref, 'a string is stored as UTF-8: same blob');
    const hex = ref.slice(7);
    const file = path.join(ws.root, '.specreview', 'docs', doc.id, 'blobs', hex.slice(0, 2), hex);
    assert.equal(fs.readFileSync(file, 'utf8'), 'export const a = 1;\n');
    assert.equal((await ctx.store.readDocBlob(doc.id, ref)).toString('utf8'), 'export const a = 1;\n');
    assert.equal(fs.existsSync(path.join(ws.root, '.specreview', 'assets')) && fs.readdirSync(path.join(ws.root, '.specreview', 'assets')).length > 0, false, 'never the shared asset store');
  });

  test('a missing blob is NotFound; a malformed ref is a usage error', async () => {
    const ctx = await engineCtx(ws.root);
    const { doc } = await ctx.store.createSnapshotDoc({ kind: 'code', title: 'Review', origin: ORIGIN, code: SPEC });
    await assert.rejects(ctx.store.readDocBlob(doc.id, `sha256:${'0'.repeat(64)}`), NotFoundError);
    await assert.rejects(ctx.store.readDocBlob(doc.id, 'live'), UsageError);
    await assert.rejects(ctx.store.readDocBlob(doc.id, `sha256:${'0'.repeat(63)}/`), UsageError);
  });

  test('recovery removes stale temp files in blobs/ and stale code-index dirs, and keeps .gitignore', async () => {
    const ctx = await engineCtx(ws.root);
    const { doc } = await ctx.store.createSnapshotDoc({ kind: 'code', title: 'Review', origin: ORIGIN, code: SPEC });
    const ref = await ctx.store.putDocBlob(doc.id, 'x');
    const hex = ref.slice(7);
    const fan = path.join(ws.root, '.specreview', 'docs', doc.id, 'blobs', hex.slice(0, 2));
    const tmp = path.join(fan, `${hex}.tmp-99999999-abcd`);
    fs.writeFileSync(tmp, 'partial');
    const cache = ctx.store.cacheDir();
    const stale = path.join(cache, 'code-index-AbC123');
    const fresh = path.join(cache, 'code-index-XyZ789');
    for (const d of [stale, fresh]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'index'), 'i');
    }
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    fs.utimesSync(stale, old, old);
    const report = await ctx.store.recoverDoc(doc.id);
    assert.equal(fs.existsSync(tmp), false);
    assert.ok(report.removedTmp.some((p) => p.startsWith('blobs/')));
    assert.equal(fs.existsSync(stale), false, 'stale index copy removed');
    assert.equal(fs.existsSync(fresh), true, 'a running engine keeps its index copy');
    assert.deepEqual(report.removedIndexDirs, ['code-index-AbC123']);
    assert.equal(fs.existsSync(path.join(fan, hex)), true, 'the blob itself is kept');
    assert.equal(fs.existsSync(path.join(ws.root, '.specreview', 'docs', doc.id, '.gitignore')), true);
  });
});
