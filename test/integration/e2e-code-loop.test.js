// @ts-check
// The full code-review loop on the design's example repository (design 4.10), in-process with the real engine:
// review (default since-base) -> the reviewer's four threads (blocking comment, suggestion, old-side question,
// new-file comment) -> the packet (src> lines exact in the working files) -> apply the suggestion -> the agent edits
// with src> as Edit old_string -> revise with the design's revise input -> v2: every thread linked and re-anchored in
// file space -> diff per file -> round 2 (resolve, a reply that reopens, a decision) -> replies only -> approve and
// mark final -> final --decisions in the doc dir.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as ops from '../../src/core/review/ops.js';
import { setClock } from '../../src/core/util/time.js';
import { designRepo, lineDraft, packetOf, submit } from '../helpers/git-repo.js';

/** @type {Awaited<ReturnType<typeof designRepo>>} */
let r;
/** @type {() => void} */
let restoreClock;
const ID = 'cr-feat-token-refresh';

before(async () => {
  let t = Date.parse('2026-10-10T14:00:00.000Z');
  restoreClock = setClock(() => (t += 1000));
  r = await designRepo();
});
after(async () => {
  restoreClock();
  await r.cleanup();
});

/**
 * An Edit-tool edit: `old` must occur exactly once in the file.
 * @param {string} rel
 * @param {string} old
 * @param {string} replacement
 */
function edit(rel, old, replacement) {
  const text = r.read(rel);
  assert.equal(text.split(old).length, 2, `old_string must be unique in ${rel}:\n${old}`);
  r.write(rel, text.replace(old, replacement));
}

/**
 * The src> lines of a packet item.
 * @param {string} text
 * @param {string} tid
 */
function srcOf(text, tid) {
  const block = text.split('\n\n').find((b) => b.startsWith(`[${tid}]`)) ?? '';
  return block.split('\n').filter((l) => l.startsWith('  src> ')).map((l) => l.slice(7)).join('\n');
}

test('code review loop: review -> packet -> apply -> edit -> revise -> v2 linked and re-anchored -> approve -> final', async () => {
  const ctx = await r.ctx();

  // ---- round 1
  const opened = await ops.openCodeReview(ctx, { input: {} });
  assert.equal(opened.doc.id, ID);
  assert.equal(/** @type {any} */ (opened.doc.code).mode, 'since-base');
  await lineDraft(ctx, ID, { file: 'src/auth/refresh.js', lines: [41, 44], severity: 'blocking', body: 'Allow reuse within 30 s before revoking the family.' });
  await lineDraft(ctx, ID, { file: 'src/auth/refresh.js', lines: 88, suggestion: 'const ttlSec = config.refreshTtlSec;', body: 'Read it from config.' });
  await lineDraft(ctx, ID, { file: 'src/auth/store.js', side: 'old', lines: [12, 14], type: 'question', body: 'scripts/migrate.js still calls legacyLookup. Was removing it intended?' });
  await lineDraft(ctx, ID, { file: 'test/refresh.test.js', lines: 1, body: 'Add a test for the grace window.' });
  await submit(ctx, ID, { body: 'Mostly good.' });

  // ---- the agent's wait delivers the packet
  /** @type {string[]} */
  const delivered = [];
  const w = /** @type {any} */ (await ops.waitForFeedback(ctx, { docIds: [ID], timeoutMs: 5000, pollMs: 20, write: async (/** @type {string} */ text) => void delivered.push(text) }));
  assert.equal(w.status, 'delivered');
  const p1 = delivered.join('');
  assert.match(p1, /^SPECREVIEW FEEDBACK · cr-feat-token-refresh \(code review: since-base origin\/main, merge-base [0-9a-f]{7}\) · review rv1 on v1 · CHANGES REQUESTED\n/);
  const t1src = srcOf(p1, 't1');
  const t4src = srcOf(p1, 't4');
  assert.equal(t1src, 'if (stored.used) {\n  await revokeFamily(stored.family);\n  throw new TokenReuseError();\n}');

  // ---- apply the suggestion, then edit bottom-up with src> as old_string
  const ap = await ops.applySuggestions(ctx, ID, ['t2'], {});
  assert.deepEqual(ap.applied.map((a) => [a.id, a.file, a.lines]), [['t2', 'src/auth/refresh.js', [88, 88]]]);
  assert.equal(r.read('src/auth/refresh.js').split('\n')[87], 'const ttlSec = config.refreshTtlSec;');
  edit('src/auth/refresh.js', t1src, [
    'if (stored.used) {',
    '  if (Date.now() - stored.usedAt < 30_000) {',
    '    return stored.next;',
    '  }',
    '  await revokeFamily(stored.family);',
    '  throw new TokenReuseError();',
    '}',
  ].join('\n'));
  // restore legacyLookup where it was (now between L11-12)
  const store = r.read('src/auth/store.js').split('\n');
  store.splice(11, 0, 'export function legacyLookup(id) {', '  return db.tokens.findOne({ id });', '}');
  r.write('src/auth/store.js', store.join('\n'));
  edit('test/refresh.test.js', t4src, `${t4src}\nimport assert from 'node:assert/strict';`);
  fs.appendFileSync(`${r.root}/src/auth/index.js`, "export { TokenReuseError } from './errors.js';\n");

  const dirty = /** @type {any} */ (await ops.docState(ctx, ID));
  assert.equal(dirty.working.dirty, true);

  // ---- revise (the design's revise input, adapted to these files)
  const rep = /** @type {any} */ (await ops.revise(ctx, ID, {
    summary: 'grace window, config TTL, keep legacyLookup, test',
    threads: {
      t1: { status: 'addressed', reply: 'Added a 30 s reuse grace window.', at: 'src/auth/refresh.js:L41-47' },
      t2: { status: 'addressed', reply: 'Applied.' },
      t3: { status: 'addressed', reply: 'Restored legacyLookup.', at: 'src/auth/store.js:L12-14' },
      t4: { status: 'addressed', reply: 'Added an import for the test.', at: 'test/refresh.test.js:L2' },
    },
    other: [{ at: 'src/auth/index.js:L1', why: 'export the new error type' }],
  }));
  assert.equal(rep.version, 2);
  const rows = rep.text.split('\n');
  const row = (/** @type {string} */ hunkFile, /** @type {RegExp} */ re) => rows.some((/** @type {string} */ l) => l.trimStart().startsWith(`${hunkFile}#`) && re.test(l));
  assert.ok(row('src/auth/refresh.js', /L42-44\s+-> t1 addressed\s+\(hint\)/), rep.text);
  assert.ok(row('src/auth/refresh.js', /L91\s+-> t2 addressed\s+\(tagged: apply\)/), rep.text);
  assert.ok(row('src/auth/store.js', /L12-14\s+-> t3 addressed\s+\(hint\)/), rep.text);
  assert.ok(row('test/refresh.test.js', /L2\s+-> t4 addressed\s+\(hint\)/), rep.text);
  assert.ok(row('src/auth/index.js', /L1\s+-> other: export the new error type/), rep.text);
  assert.match(rep.text, /^guards: code profile · ok/m);
  assert.match(rep.text, /^base: merge-base [0-9a-f]{7} \(unchanged\) · files in review: 4/m);

  // threads re-anchored in file space at v2
  const anchor = async (/** @type {string} */ tid) => {
    const a = /** @type {any} */ (await ctx.store.getThread(ID, tid)).anchors['2'];
    return [a.file.path, a.file.side, a.src.startLine, a.src.endLine];
  };
  assert.deepEqual(await anchor('t1'), ['src/auth/refresh.js', 'new', 41, 47]);
  assert.deepEqual(await anchor('t2'), ['src/auth/refresh.js', 'new', 91, 91]);
  assert.deepEqual(await anchor('t3'), ['src/auth/store.js', 'old', 12, 14]);
  assert.deepEqual(await anchor('t4'), ['test/refresh.test.js', 'new', 1, 1]);
  assert.equal(/** @type {any} */ (await ctx.store.getThread(ID, 't2')).suggestion.status, 'applied');
  assert.equal(/** @type {any} */ (await ops.docState(ctx, ID)).working.dirty, false);

  // ---- the interdiff per file
  const files = /** @type {any} */ (await ops.codeFiles(ctx, ID, { from: 1, to: 2 }));
  assert.deepEqual(files.files.map((/** @type {any} */ f) => [f.path, f.change, f.threads]), [
    ['src/auth/index.js', 'added', []],
    ['src/auth/refresh.js', 'changed', ['t1', 't2']],
    ['src/auth/store.js', 'changed', ['t3']],
    ['test/refresh.test.js', 'changed', ['t4']],
  ]);

  // ---- round 2: resolve t1 and t2 (a decision on t1), reopen t3 with a reply, leave t4
  await ops.saveDraft(ctx, ID, { kind: 'resolve', thread: 't1', decision: 'Reuse within 30 s is allowed before revoking.' });
  await ops.saveDraft(ctx, ID, { kind: 'resolve', thread: 't2' });
  await ops.saveDraft(ctx, ID, { kind: 'reply', thread: 't3', body: 'Add a deprecation comment too.', reopen: true });
  await submit(ctx, ID, { body: 'Almost.' });
  const p2 = (await packetOf(ctx, ID)).text;
  assert.match(p2, /Line numbers = files in your working tree now \(all identical to v2\)\./);
  assert.match(p2, /\[t3\] REOPENED · question · src\/auth\/store\.js \(old side\) base L12-14, now between L12-14\n {2}was> export function legacyLookup\(id\) \{/, p2);
  assert.match(p2, /DECISIONS to keep true: D1 \(t1\) Reuse within 30 s is allowed before revoking\./);

  // the agent answers without a code change: replies only, no round
  const answer = /** @type {any} */ (await ops.revise(ctx, ID, { summary: 'answer', threads: { t3: { status: 'answered', reply: 'It is marked deprecated in the changelog.' } } }));
  assert.equal(answer.repliesOnly, true);
  assert.equal((await ctx.store.requireDoc(ID)).head, 2);

  // ---- approve and mark final, then final --decisions
  await ops.submitReview(ctx, ID, { verdict: 'approved', body: 'Ship it.', markFinal: true, expectHead: 2, resolveAddressed: true, by: 'Eric' });
  const fin = /** @type {any} */ (await ops.finalize(ctx, ID, { decisions: true }));
  assert.equal(fin.final.version, 2);
  assert.equal(fin.decisionsAbs, `${ctx.store.docDir(ID)}/decisions.md`);
  assert.match(fs.readFileSync(fin.decisionsAbs, 'utf8'), /Reuse within 30 s is allowed before revoking\./);
});
