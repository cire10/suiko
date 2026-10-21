// @ts-check
// Revision guards (BUILD_AMENDMENTS 4.4): locks (intact / moved / re-wrapped / violated / created after the last
// packet / --break-lock), unexplained deletions (words, whole lines, `other`, config), rewrite ratio (insertion-heavy
// edits are not rewrites, --allow-rewrite), --force, warnings, dry runs; plus runGuards / lockIntegrity directly.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as ops from '../../src/core/review/index.js';
import { runGuards, lockIntegrity } from '../../src/core/review/guards.js';
import { attribute } from '../../src/core/review/attribution.js';
import { preciseMapper } from '../../src/core/review/workmap.js';
import { lineHunks } from '../../src/core/diff/index.js';
import { defaultConfig } from '../../src/core/store/config.js';
import { editFile, engineCtx, findSrid, makeWorkspace, textCapture } from '../helpers/engine.js';

const DOC = 'kitchen-sink';
const FILE = 'docs/kitchen-sink.md';

/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
beforeEach(async () => {
  ws = await makeWorkspace();
});
afterEach(async () => {
  await ws.cleanup();
});

/**
 * open + a comment thread + lock L1 on the blockquote text, submitted and delivered to the agent.
 * @param {{ deliver?: boolean }} [opts]
 */
async function reviewed({ deliver = true } = {}) {
  const ctx = await engineCtx(ws.root);
  const { doc } = await ops.openDoc(ctx, { path: FILE });
  const v1 = await ctx.render(doc, 1);
  await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'rotated on every use'), body: 'Add a grace window.' });
  await ops.addLock(ctx, DOC, { capture: textCapture(v1, 'the gateway never stores tokens; it only forwards them') });
  await ops.submitReview(ctx, DOC, { verdict: 'changes_requested', body: '' });
  if (deliver) await ops.feedback(ctx, DOC, {});
  return { ctx, doc, v1 };
}

const T1 = { t1: { status: 'addressed', reply: 'Added a grace window.' } };

describe('locks', () => {
  test('an edit inside an agreed lock is refused and nothing is recorded', async () => {
    const { ctx } = await reviewed();
    editFile(ws.file(FILE), 'never stores tokens', 'caches tokens briefly');
    const before = ws.read(FILE);
    const r = await ops.revise(ctx, DOC, { threads: T1 });
    assert.equal(r.refused, true);
    assert.deepEqual(r.guards.errors.map((e) => e.code), ['lock']);
    assert.match(r.guards.errors[0].message, /^h1 L38 changes L1 §2 Architecture ".*" \(agreed in rv1\)$/);
    assert.equal(r.guards.errors[0].fix, 'suiko revert kitchen-sink --hunk h1   or   --break-lock L1="<reason>"');
    assert.equal((await ctx.store.getDoc(DOC))?.head, 1, 'no version recorded');
    assert.equal(ws.read(FILE), before, 'working copy untouched');
    const text = ops.formatReviseReport(r);
    assert.match(text, /^suiko: REFUSED - nothing recorded \(exit 3\)\n {2}ERR lock: h1 L38 changes L1/);
    assert.match(text, /^ {6}fix: suiko revert kitchen-sink --hunk h1 {3}or {3}--break-lock L1="<reason>"$/m);
    assert.match(text, /working copy left untouched\. Preview with --dry-run\.\n$/);
  });

  test('moving or re-wrapping the locked text keeps the lock intact', async () => {
    const { ctx } = await reviewed();
    // re-wrap inside the lock (whitespace only) and insert a paragraph above it
    editFile(ws.file(FILE), 'never stores tokens; it only', 'never stores tokens;\n> it only');
    editFile(ws.file(FILE), '## 2 Architecture\n', '## 2 Architecture\n\nA new intro paragraph.\n');
    const r = await ops.revise(ctx, DOC, { threads: T1, other: [{ at: 'L29', why: 'intro' }, { at: 'L40-41', why: 're-wrap' }] });
    assert.equal(r.refused, false, JSON.stringify(r.guards.errors));
    assert.deepEqual(r.guards.intactLocks, ['L1']);
    const lock = await ctx.store.getLock(DOC, 'L1');
    // The source text differs (a "\n> " continuation), so re-anchoring may report a fuzzy 'changed' match; what
    // matters is that the lock still covers the same rendered text.
    const a2 = lock?.anchors['2'];
    assert.ok(a2 && a2.state !== 'orphaned', JSON.stringify(a2));
    assert.equal(a2?.quote?.exact, 'the gateway never stores tokens; it only forwards them');
    assert.deepEqual([a2?.src.startLine, a2?.src.endLine], [40, 41]);
    assert.equal(lock?.active, true);
  });

  test('--break-lock records the break and deactivates the lock', async () => {
    const { ctx } = await reviewed();
    editFile(ws.file(FILE), 'never stores tokens', 'caches tokens briefly');
    const r = await ops.revise(ctx, DOC, { threads: T1, breakLocks: { L1: 'user asked to allow caching' }, other: [{ at: 'L38', why: 'caching' }] });
    assert.equal(r.refused, false);
    assert.deepEqual(r.guards.brokenLocks, ['L1']);
    const lock = await ctx.store.getLock(DOC, 'L1');
    assert.equal(lock?.active, false);
    assert.deepEqual(lock?.breaks.map((b) => [b.version, b.reason, b.by]), [[2, 'user asked to allow caching', 'claude']]);
    const m = (await ctx.store.readVersion(DOC, 2)).manifest;
    assert.deepEqual(m.guards?.brokenLocks, ['L1']);
    assert.match(ops.formatReviseReport(r), /lock L1 BROKEN/);
  });

  test('a lock agreed after the last packet only warns', async () => {
    const { ctx, v1 } = await reviewed();
    const sec = findSrid(v1, (n) => n.t === 'h3' && n.h?.text === '1.1 Milestones');
    await ops.addLock(ctx, DOC, { capture: { kind: 'section', headingSrid: sec } });
    editFile(ws.file(FILE), '2. Ship rotation behind a flag.', '2. Ship rotation behind a feature flag.');
    const r = await ops.revise(ctx, DOC, { threads: T1, other: [{ at: 'L24', why: 'wording' }] });
    assert.equal(r.refused, false);
    assert.deepEqual(r.guards.warnings.filter((w) => w.code === 'lock-new').map((w) => w.lock), ['L2']);
  });

  test('a lock the agent never received (no packet delivered) only warns', async () => {
    const { ctx } = await reviewed({ deliver: false });
    editFile(ws.file(FILE), 'never stores tokens', 'caches tokens briefly');
    const r = await ops.revise(ctx, DOC, { threads: T1, other: [{ at: 'L38', why: 'x' }] });
    assert.equal(r.refused, false);
    assert.deepEqual(r.guards.warnings.filter((w) => w.code === 'lock-new').map((w) => w.lock), ['L1']);
  });
});

describe('unexplained deletions', () => {
  test('removing >= 20 words linked to no thread is refused; an other entry explains it', async () => {
    const { ctx } = await reviewed();
    editFile(ws.file(FILE), 'This spec describes the **token service** that issues and rotates credentials for the\n`api-gateway`. See the [OAuth 2.1 draft](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/) for\nbackground &amp; terminology.[^rfc]\n', 'This spec describes the token service.\n');
    const r = await ops.revise(ctx, DOC, { threads: T1 });
    assert.equal(r.refused, true);
    const err = r.guards.errors.find((e) => e.code === 'deletion');
    assert.ok(err, JSON.stringify(r.guards.errors));
    assert.match(err.message, /^h1 removes .* \(v1 L9-11, §Token Service Implementation Spec\) linked to no thread$/);
    assert.equal(err.fix, 'suiko revert kitchen-sink --hunk h1   or   add "other":[{"at":"h1","why":"..."}]');

    const ok = await ops.revise(ctx, DOC, { threads: T1, other: [{ at: 'h1', why: 'Shortened the intro on request' }] });
    assert.equal(ok.refused, false);
    assert.equal(ok.hunks[0].other, 'Shortened the intro on request');
  });

  test('removing 3 whole lines (few words) is refused; del:hN explains it', async () => {
    const { ctx } = await reviewed();
    editFile(ws.file(FILE), '- [x] Write the design doc\n- [ ] Load test the issuer\n- [ ] Enable rotation for 10% of clients\n', '');
    const r = await ops.revise(ctx, DOC, { threads: T1 });
    assert.equal(r.refused, true);
    assert.match(r.guards.errors[0].message, /^h1 removes 3 lines \(v1 L68-70, §4 Rollout checklist\) linked to no thread$/);
    assert.match(r.guards.errors[0].fix ?? '', /"at":"del:h1"/);
    const ok = await ops.revise(ctx, DOC, { threads: T1, other: [{ at: 'del:h1', why: 'checklist moved to the tracker' }] });
    assert.equal(ok.refused, false);
  });

  test('guards.unexplainedDeletion = warn downgrades the refusal', async () => {
    const { ctx } = await reviewed();
    fs.writeFileSync(ws.file('.specreview/config.json'), JSON.stringify({ guards: { unexplainedDeletion: 'warn' } }));
    const ctx2 = await engineCtx(ws.root);
    editFile(ws.file(FILE), '- [x] Write the design doc\n- [ ] Load test the issuer\n- [ ] Enable rotation for 10% of clients\n', '');
    const r = await ops.revise(ctx2, DOC, { threads: T1 });
    assert.equal(r.refused, false);
    assert.deepEqual(r.guards.warnings.filter((w) => w.code === 'deletion').map((w) => w.hunk), ['h1']);
    void ctx;
  });
});

describe('rewrite ratio', () => {
  test('rewriting most of a long doc is refused unless --allow-rewrite', async () => {
    const { ctx } = await reviewed();
    const lines = ws.read(FILE).split('\n');
    const rewritten = lines.map((l, i) => (i >= 6 && i < 66 && i !== 37 && l.trim() ? `Rewritten line ${i} with different words entirely.` : l)).join('\n');
    fs.writeFileSync(ws.file(FILE), rewritten);
    const r = await ops.revise(ctx, DOC, { threads: T1, other: [{ at: 'L7-66', why: 'rewrite' }] });
    assert.equal(r.refused, true);
    const err = r.guards.errors.find((e) => e.code === 'rewrite');
    assert.ok(err);
    assert.match(err.message, /^rewrites \d+% of v1 \(limit 50%\)$/);
    const ok = await ops.revise(ctx, DOC, { threads: T1, other: [{ at: 'L7-66', why: 'rewrite' }], allowRewrite: true });
    assert.equal(ok.refused, false, JSON.stringify(ok.guards.errors));
    assert.ok(ok.stats.rewriteRatio > 0.5);
  });

  test('an insertion-heavy edit is not a rewrite', async () => {
    const { ctx } = await reviewed();
    const extra = Array.from({ length: 300 }, (_, i) => `- Added requirement number ${i} for the token service.`).join('\n');
    editFile(ws.file(FILE), '## 4 Rollout checklist\n', `## 3.3 More requirements\n\n${extra}\n\n## 4 Rollout checklist\n`);
    const r = await ops.revise(ctx, DOC, { threads: T1, other: [{ at: 'L66', why: 'requirements list' }] });
    assert.equal(r.refused, false, JSON.stringify(r.guards.errors));
    assert.equal(r.stats.rewriteRatio, 0);
  });
});

describe('force, warnings and dry runs', () => {
  test('--force overrides refusals and is recorded', async () => {
    const { ctx } = await reviewed();
    editFile(ws.file(FILE), 'never stores tokens', 'caches tokens briefly');
    const r = await ops.revise(ctx, DOC, { threads: T1, force: true });
    assert.equal(r.refused, false);
    assert.equal(r.guards.forced, true);
    assert.equal(r.version, 2);
    const m = (await ctx.store.readVersion(DOC, 2)).manifest;
    assert.equal(m.guards?.forced, true);
    assert.ok(m.guards?.errors.some((e) => e.startsWith('lock: ')));
    assert.match(ops.formatReviseReport(r), /^guards: FORCED \(--force\)/m);
    assert.match(ops.formatReviseReport(r), /^ {2}ERR \(forced\) lock: /m);
  });

  test('warns about missing replies and addressed threads without a linked hunk', async () => {
    const { ctx } = await reviewed();
    editFile(ws.file(FILE), 'Last revised 2026-10-10.', 'Last revised 2026-10-11.');
    const r = await ops.revise(ctx, DOC, { threads: {}, other: [{ at: 'L81', why: 'date' }] });
    assert.equal(r.refused, false);
    assert.deepEqual(r.guards.warnings.map((w) => w.code), ['reply']);
    const ctx2 = await engineCtx(ws.root);
    editFile(ws.file(FILE), 'Last revised 2026-10-11.', 'Last revised 2026-10-12.');
    const r2 = await ops.revise(ctx2, DOC, { threads: T1, other: [{ at: 'L81', why: 'date' }] });
    const w = r2.guards.warnings.find((x) => x.code === 'addressed');
    assert.equal(w?.message, 't1 marked addressed but no hunk is linked to it (add "at":"L51" if you changed it)');
  });

  test('a dry run reports without recording', async () => {
    const { ctx } = await reviewed();
    editFile(ws.file(FILE), 'rotated on every use', 'rotated with a grace window');
    const r = await ops.revise(ctx, DOC, { threads: T1, dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.version, 2);
    assert.equal((await ctx.store.getDoc(DOC))?.head, 1);
    assert.match(ops.formatReviseReport(r), /^suiko: dry run - would record v2 for kitchen-sink/);
    assert.equal((await ctx.store.getThread(DOC, 't1'))?.comments.length, 1, 'no reply posted');
  });

  test('a decision region changed by an unrelated hunk warns', async () => {
    const { ctx } = await reviewed();
    editFile(ws.file(FILE), 'rotated on every use', 'rotated with a grace window');
    await ops.revise(ctx, DOC, { threads: T1 });
    await ops.resolveThread(ctx, DOC, 't1', { decision: 'grace window' });
    editFile(ws.file(FILE), 'rotated with a grace window', 'rotated with a 10 s grace window');
    const r = await ops.revise(ctx, DOC, { threads: {}, other: [{ at: 'L51', why: 'tweak' }] });
    assert.deepEqual(r.guards.warnings.filter((w) => w.code === 'decision').map((w) => w.message), [
      'decision D1 (t1) region modified by h1, which is not linked to t1',
    ]);
  });
});

describe('runGuards / lockIntegrity (pure)', () => {
  const head = 'one two three\nfour five six\nseven eight nine\n';
  const cfg = defaultConfig().guards;

  test('lockIntegrity: untouched, re-wrapped, changed', () => {
    const range = { start: head.indexOf('four'), end: head.indexOf('six') + 3 };
    const untouched = head.replace('one', 'uno');
    let m = preciseMapper(head, untouched);
    assert.deepEqual(lockIntegrity({ mapper: m, headSource: head, workingSource: untouched, ...range }), { intact: true, hunks: [] });
    const wrapped = head.replace('four five six', 'four five\nsix');
    m = preciseMapper(head, wrapped);
    assert.equal(lockIntegrity({ mapper: m, headSource: head, workingSource: wrapped, ...range }).intact, true);
    // re-wrapped with Markdown continuation markup: same rendered text
    const quoted = '> one two three\n> four five six\n';
    const requoted = '> one two three\n> four five\n> six\n';
    const qr = { start: quoted.indexOf('four'), end: quoted.indexOf('six') + 3 };
    m = preciseMapper(quoted, requoted);
    assert.equal(lockIntegrity({ mapper: m, headSource: quoted, workingSource: requoted, ...qr, format: 'markdown' }).intact, true);
    const reworded = '> one two three\n> four 5\n> six\n';
    m = preciseMapper(quoted, reworded);
    assert.equal(lockIntegrity({ mapper: m, headSource: quoted, workingSource: reworded, ...qr, format: 'markdown' }).intact, false);
    const changed = head.replace('five', 'FIVE');
    m = preciseMapper(head, changed);
    assert.deepEqual(lockIntegrity({ mapper: m, headSource: head, workingSource: changed, ...range }), { intact: false, hunks: ['h1'] });
  });

  test('lockIntegrity: locked text that only grows (a prefix kept) is changed; moved, it is intact', () => {
    const doc = '# Limits\n\n## Agreed limits\n\n- Max retries: 3\n- Request timeout: 30 s\n\n## Notes\n\nFree text.\n';
    /** @param {string} locked @param {string} working */
    const check = (locked, working) => {
      const start = doc.indexOf(locked);
      return lockIntegrity({ mapper: preciseMapper(doc, working), headSource: doc, workingSource: working, start, end: start + locked.length }).intact;
    };
    assert.equal(check('Max retries: 3', doc.replace('Max retries: 3', 'Max retries: 30')), false);
    assert.equal(check('Request timeout: 30 s', doc.replace('timeout: 30 s', 'timeout: 30 s, or 300 s for batch jobs')), false);
    assert.equal(check('## Notes', doc.replace('## Notes', '## Notes (cache)')), false);
    assert.equal(check('- Max retries: 3', doc.replace('- Max retries: 3', '- Retries: 1\n- Max retries: 3')), true, 'a line added above');
    const moved = doc.replace('- Max retries: 3\n- Request timeout: 30 s\n', '- Request timeout: 30 s\n- Max retries: 3\n');
    assert.equal(check('Max retries: 3', moved), true, 'moved');
  });

  test('lock refusal, then forced', () => {
    const working = head.replace('five', 'FIVE');
    const hunks = lineHunks(head, working);
    const attr = attribute({ hunks, headSource: head, workingSource: working, other: [{ at: 'h1', why: 'x' }] });
    const base = {
      docId: 'd', headVersion: 3, headLines: 3, headSource: head, workingSource: working, hunks: attr.hunks, config: cfg,
      locks: [{ id: 'L1', label: '§X', agreedIn: 'rv1', createdAt: '2026-01-01T00:00:00.000Z', intact: false, hunks: ['h1'] }],
      lastDeliveredAt: '2026-02-01T00:00:00.000Z',
    };
    const refused = runGuards(base);
    assert.equal(refused.refused, true);
    assert.equal(refused.errors[0].message, 'h1 L2 changes L1 §X (agreed in rv1)');
    const forced = runGuards({ ...base, flags: { force: true } });
    assert.equal(forced.refused, false);
    assert.equal(forced.forced, true);
    const fresh = runGuards({ ...base, lastDeliveredAt: '2025-12-01T00:00:00.000Z' });
    assert.equal(fresh.refused, false);
    assert.equal(fresh.warnings[0].code, 'lock-new');
  });

  test('the fixes run in the order printed: hunks bottom-up, each one reverted once', () => {
    const h = 'S1 a\nS1 b\nS1 c\nS1 d\n\nS2 a\nS2 b\nS2 c\nS2 d\n\nS3 a\n';
    const working = h.replace('S1 b\nS1 c\nS1 d\n', '').replace('S2 b\nS2 c\nS2 d\n', '');
    const attr = attribute({ hunks: lineHunks(h, working), headSource: h, workingSource: working });
    const r = runGuards({
      docId: 'd', headVersion: 2, headLines: 11, headSource: h, workingSource: working, hunks: attr.hunks, config: cfg,
      locks: [{ id: 'L1', label: '§S1', agreedIn: 'rv1', createdAt: '2026-01-01T00:00:00.000Z', intact: false, hunks: ['h1'] }],
      lastDeliveredAt: '2026-02-01T00:00:00.000Z',
    });
    // reverting h1 first would turn h2 into h1: the later hunk comes first, and h1's revert is suggested once
    assert.deepEqual(r.errors.map((e) => [e.hunk, e.fix?.split('   or   ')[0]]), [
      ['h2', 'suiko revert d --hunk h2'],
      ['h1', 'suiko revert d --hunk h1'],
      ['h1', 'the revert of h1 above'],
    ]);
  });

  test('enforceLocks off turns lock errors into warnings', () => {
    const working = head.replace('five', 'FIVE');
    const hunks = lineHunks(head, working);
    const attr = attribute({ hunks, headSource: head, workingSource: working, other: [{ at: 'L2', why: 'x' }] });
    const r = runGuards({
      docId: 'd', headVersion: 1, headLines: 3, headSource: head, workingSource: working, hunks: attr.hunks,
      config: { ...cfg, enforceLocks: false }, locks: [{ id: 'L1', label: '§X', agreedIn: null, createdAt: null, intact: false, hunks: ['h1'] }],
      lastDeliveredAt: '2026-02-01T00:00:00.000Z',
    });
    assert.equal(r.refused, false);
    assert.equal(r.warnings[0].code, 'lock');
  });
});
