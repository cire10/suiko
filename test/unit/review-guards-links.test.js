// @ts-check
// What a link to a thread explains (attribution scopes, guards.js header):
// - F1: in a one-line (minified) report an open thread no longer explains the whole line: scopes and overlap anchors
//   widen to whole lines only on lines of up to 1,000 characters, so a prose rewrite no thread asked for is refused
//   while the asked change alone is recorded (also at 2 MB, in bounded time);
// - A: an explicit `at` explains the lines it names (a rebuilt table beyond the anchor's block), for the deletion check
//   and the rewrite measure; an inferred overlap link explains only its thread's text, and the refusal says so;
// - E: no fix line leads with `suiko revert` (for a built document it would only patch the output).

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import * as ops from '../../src/core/review/index.js';
import { WIDEN_MAX_LINE, atRangesOf, widenToLines } from '../../src/core/review/attribution.js';
import { preciseMapper } from '../../src/core/review/workmap.js';
import { lineHunks } from '../../src/core/diff/index.js';
import { lineIndex } from '../../src/core/text/index.js';
import { engineCtx, makeWorkspace, textCapture } from '../helpers/engine.js';

/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
beforeEach(async () => {
  ws = await makeWorkspace();
});
afterEach(async () => {
  await ws.cleanup();
});

const REPORT = 'docs/report.html';
const WORDS = ['margin', 'leverage', 'cohort', 'drawdown', 'spread', 'volume', 'session', 'signal', 'regime', 'basis', 'funding', 'liquidity'];
/** A paragraph of distinct prose (about 40 words). @param {number} i */
const para = (i) =>
  `Finding ${i}: the ${WORDS[i % 12]} of segment ${i} moved with the ${WORDS[(i + 3) % 12]} of the market, ` +
  `and the ${WORDS[(i + 5) % 12]} stayed inside its usual band for most sessions, while the ${WORDS[(i + 7) % 12]} ` +
  `widened only on the days when the ${WORDS[(i + 9) % 12]} of large accounts fell by more than ${i + 2} percent.`;
const REWRITTEN = (/** @type {number} */ i) =>
  `Rewritten ${i}: an entirely different account of what happened, told in new words and with new claims that nobody asked for at all, padded to the length of a real paragraph.`;

/**
 * A report: a short answer (the thread's anchor), 12 findings paragraphs and a data blob; `flat` puts it on one line.
 * @param {{ answer?: string, rewrite?: number, days?: number, flat?: boolean }} o
 */
function report({ answer = 'The price chart covers one year of sessions.', rewrite = 0, days = 365, flat = false }) {
  const data = { prices: Array.from({ length: days }, (_, i) => Math.round(100 * Math.sin(i) * 1000) / 1000) };
  const text = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><title>Deleveraging study</title></head><body>',
    '<h1>Deleveraging study</h1>',
    '<h2>1. Short answers</h2>',
    `<p>${answer}</p>`,
    '<h2>2. Findings</h2>',
    ...Array.from({ length: 12 }, (_, i) => `<p>${i < rewrite ? REWRITTEN(i) : para(i)}</p>`),
    `<script type="application/json" id="data">${JSON.stringify(data)}</script>`,
    '</body></html>',
    '',
  ].join('\n');
  return flat ? text.replace(/\n/g, '') : text;
}

/** open the report, one thread on the short answer, submitted and delivered */
async function reviewed(/** @type {string} */ text) {
  const ctx = await engineCtx(ws.root);
  ws.write(REPORT, text);
  const { doc } = await ops.openDoc(ctx, { path: REPORT });
  const v1 = await ctx.render(doc, 1);
  await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'covers one year of sessions'), body: 'Extend it to two years.' });
  await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', body: '' });
  await ops.feedback(ctx, doc.id, {});
  return { ctx, doc };
}

const TWO_YEARS = 'The price chart covers two years of sessions.';

describe('F1: a one-line (minified) report with an open thread', () => {
  test('a prose rewrite no thread asked for is refused, although a thread is open', async () => {
    const { ctx, doc } = await reviewed(report({ flat: true }));
    ws.write(REPORT, report({ flat: true, rewrite: 11 }));
    const r = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'answered', reply: 'Not yet.' } }, dryRun: true });
    assert.equal(r.refused, true);
    // the thread's text was not touched: the hunk is not linked to it just because it shares the line
    assert.deepEqual(r.hunks.map((h) => [h.id, h.threads]), [['h1', []]]);
    assert.deepEqual(r.guards.errors.map((e) => e.code).sort(), ['deletion', 'rewrite']);
    assert.ok(r.guards.unaskedRatio > 0.5, String(r.guards.unaskedRatio));
  });

  test('the change the thread asked for alone is recorded; together with a rewrite of other prose it is refused', async () => {
    const { ctx, doc } = await reviewed(report({ flat: true }));
    ws.write(REPORT, report({ flat: true, answer: TWO_YEARS, days: 730 }));
    const ok = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Two years.' } }, dryRun: true });
    assert.equal(ok.refused, false, JSON.stringify(ok.guards.errors));
    assert.deepEqual(ok.hunks.map((h) => [h.threads, h.linkedBy]), [[['t1'], 'overlap']]);
    assert.deepEqual(ok.guards.warnings, []);

    ws.write(REPORT, report({ flat: true, answer: TWO_YEARS, rewrite: 11 }));
    const bad = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Two years.' } }, dryRun: true });
    assert.equal(bad.refused, true);
    assert.deepEqual(bad.guards.errors.map((e) => e.code).sort(), ['deletion', 'rewrite']);
    const del = bad.guards.errors.find((e) => e.code === 'deletion');
    assert.match(del?.message ?? '', /^h1 removes or replaces \d+ words \(v1 L1\) outside the text of t1 \(linked to t1 only because it overlaps t1's text\)$/);
  });

  test('the trade-off: an explicit "at" can only name the whole line, so it explains it; the large-rewrite measure still shows it', async () => {
    const { ctx, doc } = await reviewed(report({ flat: true }));
    ws.write(REPORT, report({ flat: true, answer: TWO_YEARS, rewrite: 11 }));
    const r = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Two years.', at: 'L1' } }, dryRun: true });
    assert.equal(r.refused, false, JSON.stringify(r.guards.errors));
    assert.ok(r.stats.rewriteRatio > 0.5, `rewriteRatio ${r.stats.rewriteRatio} (the reviewer's "large rewrite")`);
  });

  test('the same report on many lines: the same rewrite is refused, the asked change alone is recorded', async () => {
    const { ctx, doc } = await reviewed(report({}));
    ws.write(REPORT, report({ rewrite: 11 }));
    const r = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'answered', reply: 'Not yet.' } }, dryRun: true });
    assert.deepEqual(r.guards.errors.map((e) => e.code).sort(), ['deletion', 'rewrite']);
    ws.write(REPORT, report({ answer: TWO_YEARS, days: 730 }));
    const ok = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Two years.' } }, dryRun: true });
    assert.equal(ok.refused, false, JSON.stringify(ok.guards.errors));
  });

  test('about 2 MB on one line: a rebuild with the asked change passes, a rewrite of all prose is refused, both in bounded time', async () => {
    const GREEK = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon'.split(' ');
    const big = (/** @type {{ tag?: string, blob?: number, first?: string }} */ { tag = 'a', blob = 1, first = 'The headline number is 42.' }) => [
      '<!doctype html><html><head><title>t</title></head><body>', `<p>${first}</p>`,
      ...Array.from({ length: 4000 }, (_, i) => `<p>${Array.from({ length: 60 }, (_, k) => GREEK[(i * 7 + k * 3) % GREEK.length] + (k % 9 === 0 ? `${i}${tag}` : '')).join(' ')}</p>`),
      `<script type="application/json">${JSON.stringify({ v: Array.from({ length: 50000 }, (_, i) => (i * blob) % 997) })}</script>`,
      '</body></html>', ''].join('');
    const ctx = await engineCtx(ws.root);
    ws.write('docs/big.html', big({}));
    assert.ok(ws.read('docs/big.html').length > 1.6e6);
    const { doc } = await ops.openDoc(ctx, { path: 'docs/big.html' });
    const v1 = await ctx.render(doc, 1);
    await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'The headline number is 42.'), body: 'Use 43.' });
    await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', body: '' });
    await ops.feedback(ctx, doc.id, {});
    const reply = { t1: { status: 'addressed', reply: 'Done.' } };

    ws.write('docs/big.html', big({ blob: 7, first: 'The headline number is 43.' }));
    let t0 = performance.now();
    const rebuild = await ops.revise(ctx, doc.id, { threads: reply, dryRun: true });
    const rebuildMs = performance.now() - t0;
    assert.equal(rebuild.refused, false, JSON.stringify(rebuild.guards.errors));

    ws.write('docs/big.html', big({ tag: 'zz', first: 'The headline number is 43.' }));
    t0 = performance.now();
    const rewrite = await ops.revise(ctx, doc.id, { threads: reply, dryRun: true });
    const rewriteMs = performance.now() - t0;
    assert.equal(rewrite.refused, true);
    assert.deepEqual(rewrite.guards.errors.map((e) => e.code).sort(), ['deletion', 'rewrite']);
    // generous: test files run in parallel (about 0.4-0.8 s each when run alone)
    assert.ok(rebuildMs < 8000 && rewriteMs < 8000, `rebuild ${Math.round(rebuildMs)} ms, rewrite ${Math.round(rewriteMs)} ms`);
  });
});

/**
 * A report built from data: prose, then a monthly table whose header row (the thread's anchor) and generated rows
 * are consecutive lines, so a rebuild makes one hunk of them.
 * @param {(m: number) => number} stat
 * @param {string} header
 */
function tableReport(stat, header) {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><title>Funding study</title></head><body>',
    '<h1>Funding study</h1>',
    '<h2>1. Findings</h2>',
    ...Array.from({ length: 10 }, (_, i) => `<p>${para(i)}</p>`),
    '<h2>2. Monthly figures</h2>',
    `<table id="monthly"><thead><tr><th>Month</th><th>${header}</th><th>Max (bp)</th></tr></thead><tbody>`,
    ...Array.from({ length: 24 }, (_, m) => `<tr><td>2024-${String((m % 12) + 1).padStart(2, '0')}-${m < 12 ? 'a' : 'b'}</td><td>${stat(m).toFixed(1)}</td><td>${(40 + m).toFixed(1)}</td></tr>`),
    '</tbody></table>',
    `<script type="application/json" id="data">${JSON.stringify({ n: 24 })}</script>`,
    '</body></html>',
    '',
  ].join('\n');
}

describe('A: an explicit "at" explains the lines it names; an inferred overlap link only its thread\'s text', () => {
  /** v1 with a thread on the table header asking for medians; the agent changes its build and rebuilds */
  async function rebuiltTable() {
    const ctx = await engineCtx(ws.root);
    ws.write(REPORT, tableReport((m) => 30 + m * 0.7, 'Avg spread (bp)'));
    const { doc } = await ops.openDoc(ctx, { path: REPORT });
    const v1 = await ctx.render(doc, 1);
    await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Avg spread (bp)'), body: 'Use the median, not the mean, for the monthly figures.' });
    await ops.submitReview(ctx, doc.id, { verdict: 'comment', body: '' });
    await ops.feedback(ctx, doc.id, {});
    const next = tableReport((m) => 29 + m * 0.65, 'Median spread (bp)');
    ws.write(REPORT, next);
    const lines = next.split('\n');
    const first = lines.findIndex((l) => l.includes('Median spread')) + 1;
    const last = lines.findIndex((l) => l.includes('</tbody>'));
    return { ctx, doc, first, last };
  }

  test('a rebuild whose generated table changes beyond the anchor\'s block, linked with "at", is recorded', async () => {
    const { ctx, doc, first, last } = await rebuiltTable();
    const r = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Medians now (build script changed, report rebuilt).', at: `L${first}-${last}` } } });
    assert.equal(r.refused, false, JSON.stringify(r.guards.errors));
    assert.deepEqual(r.hunks.map((h) => [h.threads, h.linkedBy]), [[['t1'], 'hint']]);
    assert.deepEqual(r.guards.warnings, []);
  });

  test('header and rows in separate hunks (the rows linked only through "at"): recorded', async () => {
    const ctx = await engineCtx(ws.root);
    const split = (/** @type {(m: number) => number} */ stat, /** @type {string} */ header) => tableReport(stat, header).replace('</thead><tbody>', '</thead>\n<tbody>');
    ws.write(REPORT, split((m) => 30 + m * 0.7, 'Avg spread (bp)'));
    const { doc } = await ops.openDoc(ctx, { path: REPORT });
    const v1 = await ctx.render(doc, 1);
    await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Avg spread (bp)'), body: 'Use the median, not the mean, for the monthly figures.' });
    await ops.submitReview(ctx, doc.id, { verdict: 'comment', body: '' });
    await ops.feedback(ctx, doc.id, {});
    const next = split((m) => 29 + m * 0.65, 'Median spread (bp)');
    ws.write(REPORT, next);
    const lines = next.split('\n');
    const first = lines.findIndex((l) => l.includes('Median spread')) + 1;
    const last = lines.findIndex((l) => l.includes('</tbody>'));
    const r = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Medians now (build script changed, report rebuilt).', at: `L${first}-${last}` } } });
    assert.equal(r.refused, false, JSON.stringify(r.guards.errors));
    assert.deepEqual(r.hunks.map((h) => [h.id, h.threads, h.linkedBy]), [['h1', ['t1'], 'hint'], ['h2', ['t1'], 'hint']]);
  });

  test('the same rebuild linked only by overlap is refused: it says why it is linked and how to link it', async () => {
    const { ctx, doc, first, last } = await rebuiltTable();
    const r = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Medians now.' } }, dryRun: true });
    assert.equal(r.refused, true);
    assert.deepEqual(r.guards.errors.map((e) => e.code), ['deletion']);
    const e = r.guards.errors[0];
    assert.match(e.message, new RegExp(`^h1 removes or replaces \\d+ words \\(v1 L${first}-${last}, §2\\. Monthly figures\\) outside the text of t1 \\(linked to t1 only because it overlaps t1's text\\)$`));
    assert.equal(
      e.fix,
      `undo it where you made it (in the sources, then rebuild, for a document built from them; \`suiko revert ${doc.id} --hunk h1\` restores a file edited directly), ` +
        `or, if t1 asked for the whole change, name its lines ("L${first}-${last}") in t1's "at", or explain it: "other":[{"at":"h1","why":"..."}]`,
    );
  });

  test('an "at" naming some lines of a hunk explains those lines, not the rest', async () => {
    const { ctx, doc, first, last } = await rebuiltTable();
    // only the header line: the regenerated rows are still unexplained
    const some = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Medians now.', at: `L${first}` } }, dryRun: true });
    assert.deepEqual(some.guards.errors.map((e) => e.code), ['deletion']);
    assert.match(some.guards.errors[0].message, /outside the text of t1 and the lines named in its "at"$/);
    assert.match(some.guards.errors[0].fix ?? '', /, or, if a thread asked for it, add its lines \("L\d+-\d+"\) to that thread's "at", or explain it: /);
    // each row loses one figure ("30.7": two measured words); naming all but 8 rows leaves 16 words: under the limit
    const most = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Medians now.', at: `L${first}-${last - 8}` } }, dryRun: true });
    assert.deepEqual(most.guards.errors.map((e) => e.code), [], JSON.stringify(most.guards.errors));
    const fewer = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Medians now.', at: `L${first}-${last - 12},L${last}` } }, dryRun: true });
    assert.deepEqual(fewer.guards.errors.map((e) => e.code), ['deletion'], 'the 11 rows in between are not named');
    // every line of the hunk, in two ranges
    const all = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Medians now.', at: `L${first}-${first + 9},L${first + 10}-${last}` } }, dryRun: true });
    assert.equal(all.refused, false, JSON.stringify(all.guards.errors));
  });

  test('the rewrite measure counts what an "at" names as asked for, and only that', async () => {
    const { ctx, doc } = await reviewed(report({}));
    const next = report({ rewrite: 12 });
    ws.write(REPORT, next);
    const lines = next.split('\n');
    const p0 = lines.findIndex((l) => l.includes('Rewritten 0')) + 1;
    /** @param {string | undefined} at */
    const run = (at) => ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: 'Rewrote the findings as asked.', ...(at ? { at } : {}) } }, dryRun: true });
    const none = await run(undefined);
    assert.ok(none.guards.unaskedRatio > 0.8, String(none.guards.unaskedRatio));
    assert.ok(none.guards.errors.some((e) => e.code === 'rewrite'));
    const half = await run(`L${p0}-${p0 + 5}`);
    assert.ok(half.guards.unaskedRatio > 0.3 && half.guards.unaskedRatio < 0.5, String(half.guards.unaskedRatio));
    assert.deepEqual(half.guards.errors.map((e) => e.code), ['deletion'], 'the other six paragraphs are still unexplained');
    const all = await run(`L${p0}-${p0 + 11}`);
    assert.equal(all.guards.unaskedRatio, 0);
    assert.equal(all.refused, false, JSON.stringify(all.guards.errors));
    assert.ok(all.stats.rewriteRatio > 0.8, 'the version still reports how much it rewrote');
  });
});

describe('the pieces', () => {
  test('widenToLines: whole short lines; on a long line the exact range', () => {
    const short = 'one line\nsecond line here\nthird\n';
    const li = lineIndex(short);
    const at = short.indexOf('line here');
    assert.deepEqual(widenToLines(li, short, at, at + 4), { start: short.indexOf('second'), end: short.indexOf('third') });
    const long = `${'x'.repeat(WIDEN_MAX_LINE)} tail\nnext\n`;
    const ll = lineIndex(long);
    const t = long.indexOf('tail');
    assert.deepEqual(widenToLines(ll, long, t, t + 4), { start: t, end: t + 4 });
    // a range from a short line into a long one widens only its short edge
    const mixed = `head line\n${'y'.repeat(WIDEN_MAX_LINE + 1)} end\n`;
    const ml = lineIndex(mixed);
    const s = mixed.indexOf('line');
    const e = mixed.indexOf(' end');
    assert.deepEqual(widenToLines(ml, mixed, s, e), { start: 0, end: e });
  });

  test('atRangesOf: the old text that lands on the named lines, a replacement reaching onto them, the whole hunk when all are named', () => {
    const a = 'keep\nA one\nB two\nC three\nD four\nkeep\n';
    const b = 'keep\nA uno\nB dos\nC tres\nD cuatro\nkeep\n';
    const hunks = lineHunks(a, b);
    assert.equal(hunks.length, 1);
    const h = hunks[0];
    const pm = preciseMapper(a, b, hunks);
    const wli = lineIndex(b);
    const words = (/** @type {Array<[number, number]>} */ rs) => rs.map(([s, e]) => a.slice(s, e).trim()).join('|');
    assert.deepEqual(atRangesOf(pm, h, wli, [[2, 5]]), [[h.oldStartOff, h.oldEndOff]], 'every new line named');
    const third = words(atRangesOf(pm, h, wli, [[4, 4]]));
    assert.ok(third.includes('three') && !/one|two|four/.test(third), third);
    // a pure deletion is explained by naming the lines around it
    const c = 'keep\nX gone\nY gone\nkeep\n';
    const d = 'keep\nkeep\n';
    const dh = lineHunks(c, d);
    assert.deepEqual(atRangesOf(preciseMapper(c, d, dh), dh[0], lineIndex(d), [[1, 2]]), [[dh[0].oldStartOff, dh[0].oldEndOff]]);
    // 'alpha' became 'zeta\neta' (new lines 2-3), 'beta gamma' became 'theta' (line 3): a replacement that starts
    // above the named line and reaches onto it is explained by it
    const e = 'keep\nalpha beta gamma\nkeep\n';
    const f = 'keep\nzeta\neta theta\nkeep\n';
    const fh = lineHunks(e, f);
    const reach = (/** @type {Array<[number, number]>} */ rs) => rs.map(([s, t]) => e.slice(s, t)).join('|');
    assert.equal(reach(atRangesOf(preciseMapper(e, f, fh), fh[0], lineIndex(f), [[3, 3]])), 'alpha beta gamma\n');
    // ... while the line above explains only what landed on it
    assert.equal(reach(atRangesOf(preciseMapper(e, f, fh), fh[0], lineIndex(f), [[2, 2]])), 'alpha');
  });
});
