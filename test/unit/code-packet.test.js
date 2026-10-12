// @ts-check
// The packet of a code review from a real (scripted) repository (design 4.10): the golden round-1 packet
// (test/fixtures/packets/code-round1.txt, the design's example: root and merge-base normalised), src> lines that
// are exact Edit old_strings of the working files (also after the files moved on: lines mapped), grown until
// unique, was> / now between for old-side items, FILE MISSING, binary whole-file items, the JSON packet fields
// and the NEXT line per mode. Set UPDATE_GOLDEN=1 to rewrite the golden packet.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as ops from '../../src/core/review/ops.js';
import { setClock } from '../../src/core/util/time.js';
import { PACKET_FIXTURES } from '../helpers/engine.js';
import { designRepo, fileDraft, lineDraft, lines, makeRepo, packetOf, submit } from '../helpers/git-repo.js';

/** @type {() => void} */
let restoreClock;
beforeEach(() => {
  let t = Date.parse('2026-10-10T14:00:00.000Z');
  restoreClock = setClock(() => (t += 1000));
});
afterEach(() => restoreClock());

/**
 * The design example's four threads on the design repo, submitted.
 * @param {any} ctx
 * @param {string} id
 */
async function designReview(ctx, id) {
  await lineDraft(ctx, id, { file: 'src/auth/refresh.js', lines: [41, 44], severity: 'blocking', body: 'Two tabs refreshing at once will trip this. Allow reuse within 30 s before revoking the family.' });
  await lineDraft(ctx, id, { file: 'src/auth/refresh.js', lines: 88, suggestion: 'const ttlSec = config.refreshTtlSec;', body: 'Read it from config.' });
  await lineDraft(ctx, id, { file: 'src/auth/store.js', side: 'old', lines: [12, 14], type: 'question', body: 'scripts/migrate.js still calls legacyLookup. Was removing it intended?' });
  await lineDraft(ctx, id, { file: 'test/refresh.test.js', lines: 1, body: 'Add a test for the grace window.' });
  await submit(ctx, id, { body: 'Mostly good. Fix the reuse race before merging.' });
}

/**
 * Every `src>` block of a packet item, joined as the Edit old_string it stands for.
 * @param {string} text
 * @param {string} tid
 * @returns {string | null}
 */
function srcOf(text, tid) {
  const block = text.split('\n\n').find((b) => b.startsWith(`[${tid}]`));
  if (!block) return null;
  const src = block.split('\n').filter((l) => l.startsWith('  src> ')).map((l) => l.slice('  src> '.length));
  return src.length ? src.join('\n') : null;
}

/**
 * The item block of a thread.
 * @param {string} text
 * @param {string} tid
 */
function itemOf(text, tid) {
  return text.split('\n\n').find((b) => b.startsWith(`[${tid}]`)) ?? '';
}

describe('code packet', () => {
  test('golden: round 1 of the design example, from a real repository', async () => {
    const r = await designRepo();
    try {
      const ctx = await r.ctx();
      const { doc } = await ops.openCodeReview(ctx, { input: {} });
      assert.equal(doc.id, 'cr-feat-token-refresh');
      await designReview(ctx, doc.id);
      const { text, packet } = await packetOf(ctx, doc.id);
      const normal = text.split(r.root).join('/Users/me/repo').split(r.mergeBase.slice(0, 7)).join('1a2b3c4');
      const file = path.join(PACKET_FIXTURES, 'code-round1.txt');
      if (process.env.UPDATE_GOLDEN) fs.writeFileSync(file, normal);
      assert.equal(normal, fs.readFileSync(file, 'utf8'));

      // the JSON packet (design 4.10)
      const p = /** @type {any} */ (packet);
      assert.equal(p.kind, 'code');
      assert.deepEqual(Object.keys(p.code).sort(), ['baseSha', 'label', 'newSha', 'root', 'worktree']);
      assert.equal(p.code.baseSha, r.mergeBase);
      assert.equal(p.code.worktree, true);
      assert.equal(p.code.root, r.root);
      const byId = Object.fromEntries(p.threads.map((/** @type {any} */ t) => [t.id, t]));
      assert.deepEqual([byId.t1.file, byId.t1.side, byId.t1.lines, byId.t1.fileState], ['src/auth/refresh.js', 'new', [41, 44], 'ok']);
      assert.deepEqual([byId.t3.file, byId.t3.side, byId.t3.was, byId.t3.nowBetween], ['src/auth/store.js', 'old', ['export function legacyLookup(id) {', '  return db.tokens.findOne({ id });', '}'], [11, 12]]);
      assert.equal(byId.t4.fileStatus, 'A');
      for (const t of p.threads) assert.equal(t.fileFromCwd, t.file);
    } finally {
      await r.cleanup();
    }
  });

  test('src> lines are exact Edit old_strings of the working file, also after the file moved on (lines mapped)', async () => {
    const r = await designRepo();
    try {
      const ctx = await r.ctx();
      const { doc } = await ops.openCodeReview(ctx, { input: {} });
      await designReview(ctx, doc.id);
      // the agent edits the file after round 1: three lines above the reuse check
      const refresh = r.read('src/auth/refresh.js');
      r.write('src/auth/refresh.js', `// a\n// b\n// c\n${refresh}`);
      const { text, packet } = await packetOf(ctx, doc.id);
      assert.match(text, /Line numbers = files in your working tree now \(1 of 3 files changed since v1: lines mapped\)\./);
      assert.match(text, /\[t1\] blocking · comment · src\/auth\/refresh\.js:L44-47\n/);
      const working = r.read('src/auth/refresh.js');
      const t1 = /** @type {string} */ (srcOf(text, 't1'));
      assert.equal(t1, 'if (stored.used) {\n  await revokeFamily(stored.family);\n  throw new TokenReuseError();\n}');
      // an Edit old_string: present exactly once, on the cited lines
      assert.equal(working.split(t1).length, 2);
      assert.equal(working.split('\n').slice(43, 47).join('\n'), t1);
      const t4 = /** @type {string} */ (srcOf(text, 't4'));
      assert.equal(r.read('test/refresh.test.js').split('\n')[0], t4);
      // the suggestion follows too (apply locates it in the working file)
      assert.match(itemOf(text, 't2'), /src\/auth\/refresh\.js:L91 · apply verbatim/);
      const json = /** @type {any} */ (packet).threads.find((/** @type {any} */ t) => t.id === 't1');
      assert.deepEqual(json.lines, [44, 47]);
      assert.equal(json.src, t1);
    } finally {
      await r.cleanup();
    }
  });

  test('a src> that is not unique grows until it is; FILE MISSING; binary files carry no src', async () => {
    const block = (/** @type {string} */ name) => `function ${name}() {\n  return 1;\n}\n`;
    const r = await makeRepo({ files: { 'a.js': 'x\n' } });
    try {
      r.write('a.js', `${block('one')}${block('two')}${block('three')}`);
      r.write('gone.txt', 'soon gone\n');
      r.write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 1, 2, 3]));
      const ctx = await r.ctx();
      const { doc } = await ops.openCodeReview(ctx, { input: { mode: 'uncommitted' } });
      await lineDraft(ctx, doc.id, { file: 'a.js', lines: 5, body: 'why 1?' }); // "  return 1;" appears 3 times
      await lineDraft(ctx, doc.id, { file: 'gone.txt', lines: 1, body: 'keep?' });
      await fileDraft(ctx, doc.id, { file: 'logo.png', body: 'too big' });
      await submit(ctx, doc.id);
      r.rm('gone.txt');
      const { text } = await packetOf(ctx, doc.id);
      const src = /** @type {string} */ (srcOf(text, 't1'));
      const working = r.read('a.js');
      assert.ok(src.includes('  return 1;'));
      assert.equal(working.split(src).length, 2, `src> must be unique in the file:\n${src}`);
      assert.ok(working.includes(src));
      const t2 = itemOf(text, 't2');
      assert.match(t2, /FILE MISSING in your working tree/);
      assert.match(t2, /src> soon gone/);
      const t3 = itemOf(text, 't3');
      assert.match(t3, /logo\.png \(whole file\)/);
      assert.doesNotMatch(t3, /src>/);
    } finally {
      await r.cleanup();
    }
  });

  test('the NEXT line follows the mode: working tree, staged (git add), branch (commit)', async () => {
    const r = await makeRepo({ files: { 'a.js': lines(5) } });
    try {
      r.git('checkout', '-q', '-b', 'feat');
      r.write('a.js', lines(5, (i) => (i === 3 ? 'changed' : `line ${i}`)));
      r.commit('c');
      r.write('a.js', lines(5, (i) => (i === 3 ? 'changed' : i === 4 ? 'again' : `line ${i}`)));
      r.git('add', 'a.js');
      const ctx = await r.ctx();
      const expect = /** @type {Array<[object, RegExp]>} */ ([
        [{ mode: 'uncommitted' }, /NEXT: edit the files -> specreview revise cr-uncommitted --replies - \(records round v2 from your working tree\)/],
        [{ mode: 'staged' }, /NEXT: edit the files -> git add <files> -> specreview revise cr-staged --replies -/],
        [{ mode: 'branch', base: 'main' }, /NEXT: edit -> commit -> specreview revise cr-feat --replies -/],
      ]);
      for (const [input, re] of expect) {
        const { doc } = await ops.openCodeReview(ctx, { input });
        await lineDraft(ctx, doc.id, { file: 'a.js', lines: 3 });
        await submit(ctx, doc.id);
        assert.match((await packetOf(ctx, doc.id)).text, re, JSON.stringify(input));
      }
    } finally {
      await r.cleanup();
    }
  });
});
