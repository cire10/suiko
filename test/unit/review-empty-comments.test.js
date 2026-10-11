// @ts-check
// Comments without a body (a suggestion submitted with no comment, a status-only agent reply) are left out of
// everything printed to the agent: packets (text and JSON), `show <doc> <tid>`, `threads` and decisions.md. A
// status-only agent reply keeps its meta line (who, version, status) without a dangling colon.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../../src/core/review/index.js';
import { conversation, hasContent } from '../../src/core/review/threadstate.js';
import { formatPacketThread, formatThread } from '../../src/core/review/packet.js';
import { renderDecisionsMarkdown } from '../../src/core/review/export.js';
import { FALLBACK_FORMATTERS, formatThreadList } from '../../src/cli/format.js';
import { setClock } from '../../src/core/util/time.js';
import { engineCtx, makeWorkspace, textCapture } from '../helpers/engine.js';

const DOC = 'kitchen-sink';
/** A line that is only "<name>:" (an empty comment body). */
const EMPTY_LINE = /^\s*(?:v\d+ )?\S+(?: \([^)]*\))?:\s*$/m;

describe('empty comment bodies: real engine', () => {
  /** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
  let ws;
  /** @type {() => void} */
  let restoreClock;
  before(async () => {
    let t = Date.parse('2026-10-10T14:00:00.000Z');
    restoreClock = setClock(() => (t += 1000));
    ws = await makeWorkspace();
  });
  after(async () => {
    restoreClock();
    await ws.cleanup();
  });

  test('a suggestion without a comment: packet, show, threads and decisions.md print no "name:" line', async () => {
    const ctx = await engineCtx(ws.root, { reviewer: 'erictang' });
    const opened = await ops.openDoc(ctx, { path: 'docs/kitchen-sink.md' });
    const v1 = await ctx.render(opened.doc, 1);
    await ops.saveDraft(ctx, DOC, {
      kind: 'thread', type: 'suggestion', capture: textCapture(v1, 'Prototype the issuer.'),
      suggestion: { mode: 'text', new: 'Prototype the issuer behind the gateway.' },
    });
    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'rotated on every use'), body: 'Use a grace window.' });
    await ops.submitReview(ctx, DOC, { verdict: 'changes_requested', body: '' });
    const stored = await ctx.store.getThread(DOC, 't1');
    assert.equal(stored?.comments.length, 1, 'the store keeps the (empty) reviewer comment');
    assert.equal(stored?.comments[0].body, '');

    // packet: text and JSON
    const w1 = await ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20, write: () => {} });
    assert.equal(w1.status, 'delivered');
    assert.doesNotMatch(w1.text, /erictang:\s*$/m, w1.text);
    assert.doesNotMatch(w1.text, EMPTY_LINE, w1.text);
    assert.match(w1.text, /^\[t1\] suggestion · L23 .*\n {2}- Prototype the issuer\.\n {2}\+ Prototype the issuer behind the gateway\.\n\n/m);
    assert.match(w1.text, /^ {2}erictang: Use a grace window\.$/m);
    const p1 = w1.packets[0];
    assert.deepEqual(p1.threads.find((t) => t.id === 't1')?.comments, []);
    assert.equal(p1.threads.find((t) => t.id === 't2')?.comments.length, 1);

    // show <doc> t1: the timeline leaves the empty comment out
    const s1 = await ops.show(ctx, DOC, { thread: 't1' });
    assert.deepEqual(/** @type {any} */ (s1).timeline, []);
    const shown = formatThread(s1);
    assert.doesNotMatch(shown, EMPTY_LINE, shown);
    assert.match(shown, /^ {2}suggestion \(pending\): - Prototype the issuer\.  \+ Prototype the issuer behind the gateway\.$/m);

    // threads: the summary falls back to the suggestion
    const list = await ops.threads(ctx, DOC, { status: 'all' });
    assert.equal(list.threads.find((t) => t.id === 't1')?.summary, 'suggests: Prototype the issuer behind the gateway.');

    // agent: apply t1 and edit t2, then a status-only reply on t1 (ops.reply allows one); approve; decisions.md
    await ops.applySuggestions(ctx, DOC, ['t1']);
    await ops.taggedEdit(ctx, DOC, { threads: ['t2'], oldString: 'rotated on every use', newString: 'rotated with a 30 s grace window' });
    const r = await ops.revise(ctx, DOC, {
      summary: 'rv1',
      threads: { t1: { status: 'addressed', reply: 'Applied.' }, t2: { status: 'addressed', reply: 'Added a 30 s grace window.' } },
    });
    assert.equal(r.refused, false);
    await ops.reply(ctx, DOC, 't1', { status: 'addressed' });
    const s2 = formatThread(await ops.show(ctx, DOC, { thread: 't1' }));
    assert.match(s2, /^ {2}v2 claude \(addressed(?:, h\d+)?\): Applied\.\n {2}v2 claude \(addressed(?:, h\d+)?\)$/m, s2);
    assert.doesNotMatch(s2, EMPTY_LINE, s2);
    await ops.submitReview(ctx, DOC, { verdict: 'approved', body: '', markFinal: true, resolveAddressed: true });
    await ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20, write: () => {} });
    const fin = await ops.finalize(ctx, DOC, { decisions: true });
    assert.equal(fin.decisionsPath, 'docs/kitchen-sink.decisions.md');
    const md = ws.read('docs/kitchen-sink.decisions.md');
    assert.doesNotMatch(md, /^- Asked \(erictang, v1\):\s*$/m, md);
    assert.doesNotMatch(md, /^- Resolution \([^)]*\):\s*$/m, md);
    assert.match(md, /^### t1: suggests: Prototype the issuer behind the gateway\.$/m);
    assert.match(md, /^- Resolution \(claude, v2, addressed\)$/m);
    assert.match(md, /^- Asked \(erictang, v1\): Use a grace window\.$/m);
  });
});

describe('empty comment bodies: pure helpers', () => {
  const human = (/** @type {string} */ body) => ({ by: { kind: 'human', name: 'erictang' }, body, at: '', version: 1, review: 'rv1' });
  const agent = (/** @type {string} */ body, /** @type {string | null} */ status, version = 2) => ({ by: { kind: 'agent', name: 'claude' }, body, at: '', version, status });

  test('hasContent / conversation leave empty comments out and do not count them as earlier', () => {
    assert.equal(hasContent(/** @type {any} */ (human(''))), false);
    assert.equal(hasContent(/** @type {any} */ (human('  \n '))), false);
    assert.equal(hasContent(/** @type {any} */ (human('x'))), true);
    assert.equal(hasContent(/** @type {any} */ (agent('', 'declined'))), true, 'a status-only agent reply says something');
    assert.equal(hasContent(/** @type {any} */ (agent('', null))), false);
    const t = /** @type {any} */ ({ id: 't1', status: 'open', comments: [human(''), human('first'), agent('done', 'addressed'), human(''), human('again')] });
    const conv = conversation(t);
    assert.deepEqual(conv.shown.map((c) => c.body), ['done', 'again']);
    assert.equal(conv.earlier, 1);
  });

  test('formatPacketThread: no "name:" line for an empty comment; status-only agent replies keep their meta', () => {
    const base = /** @type {any} */ ({
      id: 't1', why: 'reopened', type: 'comment', severity: 'normal', status: 'open', lines: [5, 5], section: [], sectionLabel: '',
      target: 'text', label: 'text', on: 'q', src: 'line', srcUnique: true, srcWindow: false, srcEditable: true, anchorState: 'exact',
      note: null, earlier: 0, suggestion: null, attachments: [], apply: null,
    });
    const text = formatPacketThread({
      ...base,
      comments: [
        { by: 'claude', kind: 'agent', body: '', at: '', version: 2, status: 'declined', hunk: null },
        { by: 'erictang', kind: 'human', body: '', at: '', version: 2, status: null, hunk: null },
      ],
    }, 'd');
    assert.equal(text, '[t1] REOPENED · comment · L5\n  on: "q"\n  src> line\n  claude (v2, declined)');
    const addressed = formatPacketThread({ ...base, comments: [{ by: 'claude', kind: 'agent', body: ' ', at: '', version: 2, status: 'addressed', hunk: null }] }, 'd');
    assert.match(addressed, /\n {2}claude \(v2, addressed\)$/);
    const withBody = formatPacketThread({ ...base, comments: [{ by: 'claude', kind: 'agent', body: 'Done.', at: '', version: 2, status: 'addressed', hunk: null }] }, 'd');
    assert.match(withBody, /\n {2}claude \(v2\): Done\.$/, 'the default status stays elided when there is a message');
  });

  test('decisions.md: an empty first comment is skipped for the headline and "Asked"', () => {
    const anchor = { v: 1, kind: 'text', state: 'exact', src: { text: 'x', startLine: 5, endLine: 5 }, section: [] };
    const doc = /** @type {any} */ ({ id: 'spec', title: 'T', path: 'spec.md', head: 2, final: null });
    const threads = /** @type {any[]} */ ([
      { id: 't1', type: 'suggestion', status: 'resolved', resolvedIn: 2, anchors: { 1: anchor }, suggestion: { new: 'y', status: 'applied', appliedIn: 2 }, comments: [human(''), agent('', 'addressed')] },
      { id: 't2', type: 'comment', status: 'resolved', resolvedIn: 2, anchors: { 1: anchor }, decision: { id: 'D1', text: 'keep x' }, comments: [human(''), human('Why x?'), agent('Because.', 'addressed')] },
    ]);
    const md = renderDecisionsMarkdown({ doc, threads, reviews: /** @type {any} */ ([{}]), versions: 2 });
    assert.doesNotMatch(md, /^- (?:Asked|Resolution) .*:\s*$/m, md);
    assert.match(md, /^### t1: suggests: y$/m);
    assert.match(md, /^- Resolution \(claude, v2, addressed\)$/m);
    assert.match(md, /^- Asked \(erictang, v1\): Why x\?$/m);
    assert.match(md, /^- Resolution \(claude, v2, addressed\): Because\.$/m);
  });

  test('CLI fallback formatters (packet, thread, thread list) skip empty comments', () => {
    const packet = /** @type {any} */ ({
      schema: 1, doc: 'd', path: 'd.md', head: 1, working: 'clean', verdict: 'changes_requested', final: null, locks: [], decisions: [], drafts: null,
      reviews: [{ id: 'rv1', version: 1, verdict: 'changes_requested', body: '', by: 'erictang', at: '' }],
      threads: [{ id: 't1', why: 'new', type: 'suggestion', severity: 'normal', status: 'open', lines: [3, 3], section: [], target: 'text', label: 'text',
        on: 'a', src: 'a', suggestion: { old: 'a', new: 'b', status: 'pending' }, attachments: [], comments: [{ by: 'erictang', kind: 'human', body: '' }] }],
      counts: { actionable: 1, new: 1, reopened: 0, reply: 0, answer: 0, awaitingReviewer: 0, resolved: 0, outdated: 0 },
      next: 'edits',
    });
    const text = FALLBACK_FORMATTERS.formatPacket(packet);
    assert.doesNotMatch(text, /erictang:\s*$/m, text);
    const thread = /** @type {any} */ ({ id: 't1', type: 'suggestion', status: 'open', comments: [human(''), agent('', 'addressed')] });
    const shown = FALLBACK_FORMATTERS.formatThread(thread);
    assert.doesNotMatch(shown, /:\s*$/m, shown);
    assert.match(shown, /^ {2}v2 claude \(addressed\)$/m);
    const listed = formatThreadList([/** @type {any} */ ({ id: 't1', type: 'suggestion', status: 'open', comments: [human('hi'), human('')] })]);
    assert.match(listed, /erictang: hi/);
  });
});
