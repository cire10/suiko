// @ts-check
// The `reverted` guard (B): a document built from sources (a template and data, rebuilt by a script) gets a
// suggestion through `suiko apply`, which patches only the built file; the next rebuild brings the old text back.
// The revision is refused, naming the suggestion and where it was applied, unless the hunk that removes it is linked
// explicitly (`at`) or explained by `other`; an inferred overlap link does not count. Putting the suggestion into the
// sources and rebuilding records fine.

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as ops from '../../src/core/review/index.js';
import { runGuards } from '../../src/core/review/guards.js';
import { attribute } from '../../src/core/review/attribution.js';
import { preciseMapper } from '../../src/core/review/workmap.js';
import { lineHunks } from '../../src/core/diff/index.js';
import { defaultConfig } from '../../src/core/store/config.js';
import { engineCtx, makeWorkspace, textCapture } from '../helpers/engine.js';

/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
beforeEach(async () => {
  ws = await makeWorkspace();
  fs.mkdirSync(ws.file('docs/funding/src'), { recursive: true });
});
afterEach(async () => {
  await ws.cleanup();
});

const OUT = 'docs/funding/report.html';
const TEMPLATE = 'docs/funding/src/template.html';
const SENTENCE = 'Stress days cluster around month ends.';
const SUGGESTED = 'Stress days come in runs around month ends.';

/** The template: prose, a {{TABLE}} slot filled from the data. */
const template = (/** @type {string} */ stress = SENTENCE, /** @type {string} */ header = 'Mean spread (bp)') => [
  '<!doctype html>',
  '<html lang="en"><head><meta charset="utf-8"><title>Funding study</title></head><body>',
  '<h1>Funding study</h1>',
  '<h2>1. Method</h2>',
  '<p>We read the trading desk feed for two years and kept every session with a complete order book.</p>',
  '<h2>2. Funding stress</h2>',
  `<p>${stress}</p>`,
  '<p>The spread widens on those days and narrows within a week.</p>',
  '<h2>3. Monthly figures</h2>',
  `<table><thead><tr><th>Month</th><th>${header}</th></tr></thead><tbody>`,
  '{{TABLE}}',
  '</tbody></table>',
  '</body></html>',
  '',
].join('\n');

/**
 * The build script: the template with its table rows from the data, written to the output.
 * @param {(m: number) => number} stat
 */
function build(stat) {
  const rows = Array.from({ length: 12 }, (_, m) => `<tr><td>2024-${String(m + 1).padStart(2, '0')}</td><td>${stat(m).toFixed(1)}</td></tr>`);
  ws.write(OUT, ws.read(TEMPLATE).replace('{{TABLE}}', rows.join('\n')));
}
const MEAN = (/** @type {number} */ m) => 30 + m * 0.7;
const MEDIAN = (/** @type {number} */ m) => 29 + m * 0.65;

/**
 * v1 built from the template; the reviewer suggests a wording (t1); the agent runs `suiko apply` (the built file
 * only) and records v2; the reviewer then asks for medians in the table (t2).
 */
async function appliedThenRebuilt() {
  const ctx = await engineCtx(ws.root);
  ws.write(TEMPLATE, template());
  build(MEAN);
  const { doc } = await ops.openDoc(ctx, { path: OUT });
  const v1 = await ctx.render(doc, 1);
  await ops.saveDraft(ctx, doc.id, {
    kind: 'thread', type: 'suggestion', capture: textCapture(v1, SENTENCE), body: 'Plainer.', suggestion: { mode: 'text', new: SUGGESTED },
  });
  await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', body: '' });
  await ops.feedback(ctx, doc.id, {});
  const applied = await ops.applySuggestions(ctx, doc.id, ['t1']);
  assert.deepEqual(applied.applied.map((a) => a.id), ['t1']);
  assert.ok(ws.read(OUT).includes(SUGGESTED) && !ws.read(TEMPLATE).includes(SUGGESTED), 'apply patched the built file only');
  const r2 = await ops.revise(ctx, doc.id, { threads: {} });
  assert.equal(r2.refused, false, JSON.stringify(r2.guards.errors));
  const t1 = await ctx.store.getThread(doc.id, 't1');
  assert.deepEqual([t1?.status, t1?.suggestion?.status, t1?.suggestion?.appliedIn], ['addressed', 'applied', 2]);

  const v2 = await ctx.render(doc, 2);
  await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: textCapture(v2, 'Mean spread (bp)'), body: 'Use the median, not the mean.' });
  await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', body: '' });
  await ops.feedback(ctx, doc.id, {});
  return { ctx, doc };
}

/** The agent's change for t2: medians in the template's header and the build script, then a rebuild. */
function rebuildWithMedians(/** @type {string} */ stress = SENTENCE) {
  ws.write(TEMPLATE, template(stress, 'Median spread (bp)'));
  build(MEDIAN);
  const lines = ws.read(OUT).split('\n');
  const first = lines.findIndex((l) => l.includes('Median spread')) + 1;
  const last = lines.findIndex((l) => l.includes('</tbody>'));
  return `L${first}-${last}`;
}

test('a rebuild that brings back the text a suggestion replaced is refused, naming the suggestion and its version', async () => {
  const { ctx, doc } = await appliedThenRebuilt();
  const at = rebuildWithMedians();
  assert.ok(!ws.read(OUT).includes(SUGGESTED), 'the rebuild lost the applied wording');
  const r = await ops.revise(ctx, doc.id, { threads: { t2: { status: 'addressed', reply: 'Medians now.', at } }, dryRun: true });
  assert.equal(r.refused, true);
  assert.deepEqual(r.guards.errors.map((e) => e.code), ['reverted']);
  const e = r.guards.errors[0];
  assert.equal(e.thread, 't1');
  assert.equal(e.message, `${e.hunk} removes t1's applied suggestion "${SUGGESTED}" (applied in v2)`);
  const stressLine = ws.read(OUT).split('\n').findIndex((l) => l.includes(SENTENCE)) + 1;
  assert.equal(
    e.fix,
    'a rebuild from sources brings back the old text: put the suggestion into the sources and rebuild. ' +
      `If a thread asked to change it again, add its lines ("L${stressLine}") to that thread's "at"`,
  );
  const text = ops.formatReviseReport(r);
  assert.match(text, /^ {2}ERR reverted: h\d+ removes t1's applied suggestion "Stress days come in runs around month ends\." \(applied in v2\)$/m);
  assert.match(text, /^ {6}fix: a rebuild from sources brings back the old text: put the suggestion into the sources and rebuild\. If a thread asked/m);
  // no generic "linked to no thread ... explain it" note for that hunk: the error's fix is the one to follow
  assert.deepEqual(r.guards.warnings.filter((w) => w.hunk === e.hunk), []);

  // the fix: the suggestion goes into the sources, then the rebuild keeps it
  const atFixed = rebuildWithMedians(SUGGESTED);
  const ok = await ops.revise(ctx, doc.id, { threads: { t2: { status: 'addressed', reply: 'Medians now.', at: atFixed } } });
  assert.equal(ok.refused, false, JSON.stringify(ok.guards.errors));
  assert.ok(ws.read(OUT).includes(SUGGESTED));
});

test('a change to the applied wording that a thread asked for is recorded when linked with "at" or explained by other; linked only by overlap it is refused', async () => {
  const { ctx, doc } = await appliedThenRebuilt();
  // the reviewer asks about that very sentence (t3): an actionable thread whose anchor the rebuild overlaps
  const v2 = await ctx.render(doc, 2);
  await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: textCapture(v2, SUGGESTED), body: 'Say how long the runs last.' });
  await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', body: '' });
  await ops.feedback(ctx, doc.id, {});
  const longer = 'Stress days come in runs of two to four sessions around month ends.';
  rebuildWithMedians(longer);
  const lines = ws.read(OUT).split('\n');
  const stressLine = `L${lines.findIndex((l) => l.includes(longer)) + 1}`;
  const t2 = { status: 'addressed', reply: 'Medians now.', at: rebuildWithMedians(longer) };

  // linked only by overlap (t3's anchor): inferred links do not count
  const inferred = await ops.revise(ctx, doc.id, { threads: { t2, t3: { status: 'addressed', reply: 'Two to four sessions.' } }, dryRun: true });
  assert.ok(inferred.hunks.some((h) => h.threads.includes('t3') && h.linkedBy === 'overlap'), JSON.stringify(inferred.hunks));
  assert.deepEqual(inferred.guards.errors.map((e) => e.code), ['reverted']);

  // t3's "at" names the line: the change was asked for
  const linked = await ops.revise(ctx, doc.id, { threads: { t2, t3: { status: 'addressed', reply: 'Two to four sessions.', at: stressLine } }, dryRun: true });
  assert.equal(linked.refused, false, JSON.stringify(linked.guards.errors));

  // or an `other` entry explains it
  const other = await ops.revise(ctx, doc.id, { threads: { t2, t3: { status: 'answered', reply: 'See the new wording.' } }, other: [{ at: stressLine, why: 'the reviewer asked in chat' }], dryRun: true });
  assert.equal(other.refused, false, JSON.stringify(other.guards.errors));
});

test('runGuards: only an applied suggestion whose text is in head and gone from the working copy counts', () => {
  const cfg = defaultConfig().guards;
  const head = `# Notes\n\nIntro line.\n\n${SUGGESTED}\n\nOutro line.\n`;
  /** @param {string} working @param {object} [extra] */
  const run = (working, extra = {}) => {
    const hunks = lineHunks(head, working);
    const mapper = preciseMapper(head, working, hunks);
    const attr = attribute({ hunks, headSource: head, workingSource: working, mapper, ...extra });
    return runGuards({
      docId: 'd', headVersion: 3, headLines: 7, headSource: head, workingSource: working, hunks: attr.hunks, config: cfg, mapper,
      applied: [{ thread: 't4', text: SUGGESTED, appliedIn: 2 }],
    });
  };
  const back = head.replace(SUGGESTED, SENTENCE);
  assert.deepEqual(run(back).errors.map((e) => [e.code, e.hunk, e.thread]), [['reverted', 'h1', 't4']]);
  assert.equal(run(back, { other: [{ at: 'h1', why: 'reworded on request' }] }).errors.length, 0, 'other explains it');
  assert.equal(run(back, { hints: [{ thread: 't9', at: 'L5' }] }).errors.length, 0, 'an explicit at link explains it');
  assert.equal(run(head.replace('Intro line.', 'Intro.')).errors.length, 0, 'the applied text is still there');
  assert.equal(run(`${head}\n${SUGGESTED}\n`.replace(`${SUGGESTED}\n\nOutro`, `${SENTENCE}\n\nOutro`)).errors.length, 0, 'still in the working copy elsewhere');
  assert.equal(run(head.replace('come in runs ', 'come in runs\n')).errors.length, 0, 're-wrapped: whitespace aside, the text is still there');

  // a CRLF doc and a suggestion typed with '\n' (a <textarea>): the same text
  const crlf = head.replace(/\n/g, '\r\n');
  /** @param {string} working */
  const runCrlf = (working) => {
    const hunks = lineHunks(crlf, working);
    const mapper = preciseMapper(crlf, working, hunks);
    return runGuards({
      docId: 'd', headVersion: 3, headLines: 7, headSource: crlf, workingSource: working, hunks: attribute({ hunks, headSource: crlf, workingSource: working, mapper }).hunks,
      config: cfg, mapper, applied: [{ thread: 't4', text: `${SUGGESTED}\n\nOutro line.`, appliedIn: 2 }],
    });
  };
  assert.deepEqual(runCrlf(crlf.replace('Intro line.', 'Intro.')).errors, []);
  assert.deepEqual(runCrlf(crlf.replace(SUGGESTED, SENTENCE)).errors.map((e) => e.code), ['reverted']);
});
