// @ts-check
// Unit tests (node:test) for the UI's pure helpers: src/ui/model.js (DocState -> what the panels show, shortcut
// labels and key combos, the command palette's fuzzy search) and the URL helpers of src/ui/util.js. They run without a browser:  node --test test/e2e/model.test.mjs
// (Playwright only picks up *.spec.mjs, so this file is not part of `npx playwright test`.)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acceptableThreads, declinedToVerify, showsDoc, agentPrompt, anchorAt, anchorChipParts, anchorQuote, appCombo, applyErrorText, attachmentName, attachmentUrl, backupHasInput,
  canSendNow, coalesceWordParts, docKindOf, hasMode, kindCaps, modesFor, defaultBase, defaultVerdict, diffLines, draftVersion, fuzzyMatch, groupHunks,
  highlightParts, hunkLines, hunkPreview, hunkSourceText, isComposerDirty, isReplyDirty, isSingleKeyCombo,
  isVerifiable, keyLabel, linesLabel, matchRow, panelItems, presenceInfo, reviewProgress, roundResults, roundSummary,
  singleH1, staleApproveText, statusInfo, suggestionMode, targetLabel, threadMatches, threadRowTitle, timeline,
  trimDiffContext, baseTag, openingMode, plainMode, reviewedThrough, revisionsToAccept,
} from '../../src/ui/model.js';
import { contentUrl, docUrl, wordParts } from '../../src/ui/util.js';

const human = { kind: 'human', name: 'Eric' };
const agent = { kind: 'agent', name: 'claude' };

/** @param {number} v @param {number} start @param {Record<string, any>} [extra] */
const anchor = (v, start, extra = {}) => ({
  v, kind: 'text', state: 'exact', src: { start, end: start + 5, startLine: 1 + Math.floor(start / 10), endLine: 1 + Math.floor(start / 10), text: 'hello' },
  quote: { exact: 'hello', prefix: '', suffix: '' }, section: ['Spec', 'Intro'], ...extra,
});

/** @param {string} id @param {string} status @param {any[]} comments @param {Record<string, any>} [anchors] */
const thread = (id, status, comments, anchors = { 1: anchor(1, 10) }) => ({ id, status, severity: 'normal', type: 'comment', createdIn: 1, anchors, comments });

/** @param {Partial<any>} [over] */
function docState(over = {}) {
  return {
    ws: 'w1',
    doc: { id: 'spec', path: 'docs/spec.md', title: 'Spec', head: 3, lastReviewedVersion: 1, state: 'in_review', final: null },
    versions: [
      { v: 1, author: agent, createdAt: '2026-10-10T10:00:00.000Z', summary: 'initial', respondsTo: null },
      { v: 2, author: agent, createdAt: '2026-10-10T11:00:00.000Z', summary: 'round 1', respondsTo: 'rv1' },
      { v: 3, author: agent, createdAt: '2026-10-10T12:00:00.000Z', summary: 'round 2', respondsTo: null },
    ],
    threads: [],
    locks: [],
    reviews: [],
    drafts: { schema: 1, items: [] },
    waiters: [],
    working: { dirty: false, sha256: 'x' },
    ...over,
  };
}

test('defaultBase: the last review when older than the shown version, else the previous version', () => {
  const ds = docState();
  assert.equal(defaultBase(ds, 3, 'last'), 1);
  assert.equal(defaultBase(ds, 3, 'prev'), 2);
  assert.equal(defaultBase(ds, 1, 'last'), null);
  assert.equal(defaultBase(ds, 2, 'last'), 1);
  assert.equal(defaultBase(docState({ doc: { ...ds.doc, lastReviewedVersion: 3 } }), 3, 'last'), 2);
  assert.equal(defaultBase(ds, 'live', 'last'), 1);
  assert.equal(defaultBase(ds, 'live', 'prev'), 3);
});

test('accepted revisions: "since your last review" starts at the newer of the last review and the accepted version', () => {
  const ds = docState();
  /** @param {Record<string, any>} doc */
  const at = (doc) => docState({ doc: { ...ds.doc, ...doc } });
  assert.equal(reviewedThrough(ds), 1);
  assert.equal(reviewedThrough(at({ acceptedVersion: 2 })), 2);
  assert.equal(reviewedThrough(at({ lastReviewedVersion: 3, acceptedVersion: 2 })), 3);
  assert.equal(reviewedThrough(at({ lastReviewedVersion: null })), null);
  // the Changes base follows it
  assert.equal(defaultBase(at({ acceptedVersion: 2 }), 3, 'last'), 2);
  assert.equal(defaultBase(at({ acceptedVersion: 3 }), 3, 'last'), 2, 'nothing newer: the previous version');
  assert.equal(defaultBase(at({ acceptedVersion: 2 }), 'live', 'last'), 2);
  // labels: the last review, or the accepted version when it is newer
  assert.equal(baseTag(ds, 1), 'review');
  assert.equal(baseTag(at({ acceptedVersion: 2 }), 2), 'accepted');
  assert.equal(baseTag(at({ acceptedVersion: 2 }), 1), 'review');
  assert.equal(baseTag(at({ lastReviewedVersion: 2, acceptedVersion: 2 }), 2), 'review');
  assert.equal(baseTag(ds, 2), null);
  assert.equal(baseTag(ds, null), null);
  // what Accept all revisions accepts: the latest version, while it is newer than both
  assert.deepEqual(revisionsToAccept(ds), { version: 3, since: 1 });
  assert.equal(revisionsToAccept(at({ acceptedVersion: 3 })), null);
  assert.equal(revisionsToAccept(at({ lastReviewedVersion: 3 })), null);
  assert.deepEqual(revisionsToAccept(at({ lastReviewedVersion: null })), { version: 3, since: null }, 'never reviewed');
  assert.equal(revisionsToAccept(at({ head: 1, lastReviewedVersion: null })), null, 'only v1');
});

test('openingMode / plainMode: the Default view setting, and Changes when revised since the last review or acceptance', () => {
  const ds = docState();
  const code = docState({ doc: { ...ds.doc, kind: 'code' } });
  assert.equal(openingMode(ds, 'auto'), 'changes');
  assert.equal(openingMode(docState({ doc: { ...ds.doc, acceptedVersion: 3 } }), 'auto'), 'review', 'accepted: nothing new');
  assert.equal(openingMode(docState({ doc: { ...ds.doc, lastReviewedVersion: null } }), 'auto'), 'review', 'never reviewed');
  assert.equal(openingMode(ds, 'read'), 'read');
  assert.equal(openingMode(ds, 'review'), 'review');
  assert.equal(openingMode(code, 'read'), 'review', 'a code review has no Read');
  assert.equal(plainMode(ds, 'read'), 'read');
  assert.equal(plainMode(ds, 'auto'), 'review');
  assert.equal(plainMode(ds, 'review'), 'review');
  assert.equal(plainMode(code, 'read'), 'review');
});

test('anchorAt: the exact version, else the newest earlier anchor, else the oldest', () => {
  const t = { anchors: { 2: anchor(2, 20), 4: anchor(4, 40) } };
  assert.equal(anchorAt(t, 4).v, 4);
  assert.equal(anchorAt(t, 3).v, 2);
  assert.equal(anchorAt(t, 1).v, 2);
  assert.equal(anchorAt(t, 'live').v, 4);
  assert.equal(anchorAt({ anchors: {} }, 1), null);
});

test('Verify queue: agent-answered threads without a newer reviewer comment or pending reply draft', () => {
  const addressed = thread('t1', 'addressed', [{ by: human, body: 'a' }, { by: agent, body: 'b', version: 2 }]);
  const answeredAgain = thread('t2', 'answered', [{ by: agent, body: 'b' }, { by: human, body: 'c' }]);
  const open = thread('t3', 'open', [{ by: human, body: 'a' }]);
  assert.equal(isVerifiable(addressed, { items: [] }), true);
  assert.equal(isVerifiable(answeredAgain, { items: [] }), false);
  assert.equal(isVerifiable(open, { items: [] }), false);
  assert.equal(isVerifiable(addressed, { items: [{ kind: 'reply', thread: 't1', body: 'x' }] }), false);
  assert.equal(threadMatches(addressed, 'verify', { drafts: { items: [] }, version: 2 }), true);
  assert.equal(statusInfo(addressed).label, 'Addressed in v2');
  assert.equal(statusInfo(thread('t9', 'needs_input', []), 'codex').banner, 'codex asked you');
});

test('panelItems: document order, new-thread drafts with Open / Drafts / All, outdated filter', () => {
  const ds = docState({
    threads: [
      thread('t1', 'open', [], { 1: anchor(1, 50) }),
      thread('t2', 'resolved', [], { 1: anchor(1, 5) }),
      thread('t3', 'open', [], { 1: anchor(1, 30, { state: 'changed' }) }),
      thread('t4', 'open', [], { 1: { v: 1, kind: 'doc', state: 'exact', src: { start: 0, end: 0 } } }),
    ],
    drafts: { schema: 1, items: [{ id: 'd1', kind: 'thread', anchor: anchor(1, 40), body: 'x' }, { id: 'd2', kind: 'reply', thread: 't1', body: 'y' }] },
  });
  assert.deepEqual(panelItems(ds, 'open', 1).map((x) => x.id), ['t4', 't3', 'd1', 't1']);
  assert.deepEqual(panelItems(ds, 'all', 1).map((x) => x.id), ['t4', 't2', 't3', 'd1', 't1']);
  assert.deepEqual(panelItems(ds, 'resolved', 1).map((x) => x.id), ['t2']);
  assert.deepEqual(panelItems(ds, 'outdated', 1).map((x) => x.id), ['t3']);
  assert.deepEqual(panelItems(ds, 'drafts', 1).map((x) => x.id), ['d1', 't1']);
  // the thread whose reply box is open stays listed whatever the filter (resolved in another tab, say)
  assert.deepEqual(panelItems(ds, 'resolved', 1, 't1').map((x) => x.id), ['t2', 't1']);
});

test('presence and review progress follow waiters, delivery, the working copy and the answering version', () => {
  const submitted = { id: 'rv2', submittedAt: '2026-10-10T12:30:00.000Z', deliveredTo: {} };
  let ds = docState({ reviews: [submitted] });
  assert.equal(presenceInfo(ds).kind, 'none');
  assert.equal(reviewProgress(ds)?.stage, 'submitted');
  ds = docState({ reviews: [submitted], waiters: [{ agent: 'codex', since: 'x', pid: 1 }] });
  assert.deepEqual(presenceInfo(ds), { kind: 'listening', label: 'codex is listening', tone: 'ok' });
  const delivered = { ...submitted, deliveredTo: { claude: '2026-10-10T12:31:00.000Z' } };
  ds = docState({ reviews: [delivered] });
  assert.equal(presenceInfo(ds).label, 'claude is revising...');
  assert.equal(reviewProgress(ds)?.stage, 'delivered');
  ds = docState({ reviews: [delivered], working: { dirty: true } });
  assert.equal(presenceInfo(ds).label, 'claude is editing (unrecorded)');
  ds = docState({ reviews: [delivered], versions: [...docState().versions, { v: 4, author: agent, createdAt: 'z', respondsTo: 'rv2' }] });
  assert.deepEqual(reviewProgress(ds), { label: 'v4 ready', tone: 'ok', stage: 'ready' });
  assert.equal(presenceInfo(ds).kind, 'none');
});

test('round summary and round results count the agent replies of the range', () => {
  const ds = docState({
    doc: { ...docState().doc, head: 2 },
    threads: [
      thread('t1', 'addressed', [{ by: human, body: 'a', version: 1 }, { by: agent, body: 'done', version: 2, status: 'addressed' }]),
      thread('t2', 'needs_input', [{ by: agent, body: 'which?', version: 2, status: 'needs_input' }]),
      thread('t3', 'open', [{ by: human, body: 'a', version: 1 }]),
    ],
  });
  assert.equal(roundSummary(ds)?.text, 'v2 ready - 1 to verify, 1 needs you');
  assert.deepEqual(roundResults(ds, 1, 2).map((r) => r.thread.id), ['t1', 't2']);
  assert.deepEqual(roundResults(ds, 2, 2), []);
});

test('changes helpers: section groups, line labels, previews', () => {
  const changes = {
    hunks: [
      { id: 'h1', op: 'mod', new: { start: 4, lines: 2 }, old: { start: 4, lines: 1 }, section: ['Spec', 'Intro'], words: [{ quote: 'new words' }], deleted: { text: 'old' } },
      { id: 'h2', op: 'del', new: { start: 9, lines: 0 }, old: { start: 10, lines: 3 }, section: ['Spec', 'Intro'], words: [], deleted: { text: 'gone' } },
      { id: 'h3', op: 'add', new: { start: 20, lines: 1 }, old: { start: 21, lines: 0 }, section: [], words: [{ quote: 'added' }], deleted: null },
    ],
  };
  assert.deepEqual(groupHunks(changes).map((g) => [g.title, g.hunks.map((h) => h.id)]), [['Spec › Intro', ['h1', 'h2']], ['Top of document', ['h3']]]);
  assert.equal(hunkLines(changes.hunks[0]), 'L4-5');
  assert.equal(hunkLines(changes.hunks[1]), 'removed L10-12');
  assert.equal(hunkLines(changes.hunks[2]), 'L20');
  assert.deepEqual(hunkPreview(changes.hunks[0]), { ins: 'new words', del: 'old' });
  assert.deepEqual(hunkPreview(changes.hunks[1]), { ins: '', del: 'gone' });
  assert.equal(linesLabel([3, 3]), 'L3');
  assert.equal(linesLabel({ startLine: 3, endLine: 7 }), 'L3-7');
});

test('timeline interleaves versions and reviews, newest first', () => {
  const ds = docState({ reviews: [{ id: 'rv1', submittedAt: '2026-10-10T10:30:00.000Z' }] });
  assert.deepEqual(timeline(ds).map((x) => (x.kind === 'version' ? `v${x.v}` : x.review.id)), ['v3', 'v2', 'rv1', 'v1']);
});

test('suggestionMode: text when the source slice equals the rendered quote modulo whitespace', () => {
  assert.equal(suggestionMode(anchor(1, 0)), 'text');
  assert.equal(suggestionMode({ ...anchor(1, 0), src: { ...anchor(1, 0).src, text: '**hello**' } }), 'source');
  assert.equal(suggestionMode({ ...anchor(1, 0), kind: 'element' }), 'source');
  assert.equal(suggestionMode(null), 'source');
});

test('contentUrl resolves engine asset URLs against contentBase and refuses foreign origins', () => {
  const base = 'http://127.0.0.1:4778/c/abc123';
  assert.equal(contentUrl(base, 'v2/docs/img/arch.png'), `${base}/v2/docs/img/arch.png`);
  assert.equal(contentUrl(`${base}/`, '/v1/a b/#1.png'), `${base}/v1/a%20b/%231.png`);
  assert.equal(contentUrl(base, `${base}/v1/x.png`), `${base}/v1/x.png`);
  assert.equal(contentUrl(base, 'https://evil.example/x.png'), null);
  assert.equal(contentUrl(base, 'javascript:alert(1)'), null);
  assert.equal(contentUrl(base, null), null);
  assert.equal(docUrl(base, 2, 'docs/my spec#1.md'), `${base}/v2/docs/my%20spec%231.md`);
  assert.equal(docUrl(base, 'live', 'a.md'), `${base}/live/a.md`);
});

test('wordParts produces a word diff for the live suggestion preview', () => {
  assert.deepEqual(wordParts('a b c', 'a x c'), [
    { op: 'eq', text: 'a ' }, { op: 'del', text: 'b' }, { op: 'ins', text: 'x' }, { op: 'eq', text: ' c' },
  ]);
});

test('targetLabel follows the table capture scope; anchorQuote quotes text and picked elements', () => {
  const cell = { rowKey: 'Enterprise', colHeader: 'Rate (req/s)', text: '1000' };
  const el = (/** @type {string} */ tag, /** @type {string} */ text) => ({ tag, label: `<${tag}>`, text });
  assert.equal(targetLabel({ kind: 'cell', cell, scope: 'cell', element: el('td', '1000') }), 'cell "Enterprise" × "Rate (req/s)"');
  assert.equal(targetLabel({ kind: 'cell', cell, element: el('td', '1000') }), 'cell "Enterprise" × "Rate (req/s)"');
  assert.equal(targetLabel({ kind: 'cell', cell, scope: 'row', element: el('tr', 'Enterprise 1000') }), 'table row "Enterprise"');
  assert.equal(targetLabel({ kind: 'cell', cell, scope: 'column', element: el('table', '') }), 'table column "Rate (req/s)"');
  assert.equal(targetLabel({ kind: 'element', scope: 'table', element: el('table', '') }), 'table');
  assert.equal(targetLabel({ kind: 'element', scope: 'table', element: { tag: 'table', label: 'table "Tiers"' } }), 'table "Tiers"');
  assert.equal(targetLabel({ kind: 'element', element: el('li', 'Enforce for all tiers') }), '<li>');

  const long = 'Enforce for all tiers within 7 days of the announcement, then review the limits with every team that asked for an exception.';
  assert.equal(anchorQuote(anchor(1, 0, { quote: { exact: 'Enforce  for all\ntiers' } })), 'Enforce for all tiers');
  assert.equal(anchorQuote(anchor(1, 0, { quote: { exact: long } })).length, 120);
  assert.ok(anchorQuote(anchor(1, 0, { quote: { exact: long } })).endsWith('…'));
  assert.equal(anchorQuote({ kind: 'element', element: el('li', 'Enforce for all tiers') }), 'Enforce for all tiers');
  assert.equal(anchorQuote({ kind: 'cell', cell, scope: 'row', element: el('tr', 'Enterprise 1000') }), 'Enterprise 1000');
  assert.equal(anchorQuote({ kind: 'element', element: el('img', ''), region: { x: 0, y: 0, w: 1, h: 1 } }), '');
  assert.equal(anchorQuote({ kind: 'doc' }), '');
  assert.equal(anchorQuote({ kind: 'section', section: ['A'], element: el('h2', 'A') }), '');
});

test('defaultVerdict: Request changes with a blocking new thread or a reopen of a blocking thread', () => {
  const ds = docState({ threads: [{ ...thread('t1', 'addressed', []), severity: 'blocking' }, thread('t2', 'addressed', [])] });
  const withDrafts = (/** @type {any[]} */ items) => ({ ...ds, drafts: { schema: 1, items } });
  assert.equal(defaultVerdict(ds), 'comment');
  assert.equal(defaultVerdict(withDrafts([{ id: 'd1', kind: 'thread', severity: 'normal' }])), 'comment');
  assert.equal(defaultVerdict(withDrafts([{ id: 'd1', kind: 'thread', severity: 'blocking' }])), 'changes_requested');
  assert.equal(defaultVerdict(withDrafts([{ id: 'd1', kind: 'reply', thread: 't2', reopen: true }])), 'comment');
  assert.equal(defaultVerdict(withDrafts([{ id: 'd1', kind: 'reply', thread: 't1', reopen: false }])), 'comment');
  assert.equal(defaultVerdict(withDrafts([{ id: 'd1', kind: 'reply', thread: 't1', reopen: true }])), 'changes_requested');
  // The Settings choice applies when nothing is blocking; a blocking draft still wins.
  assert.equal(defaultVerdict(ds, 'changes_requested'), 'changes_requested');
  assert.equal(defaultVerdict(ds, 'comment'), 'comment');
  assert.equal(defaultVerdict(withDrafts([{ id: 'd1', kind: 'thread', severity: 'blocking' }]), 'comment'), 'changes_requested');
  assert.equal(agentPrompt(ds), 'Run `suiko feedback spec` and address it.');
});

test('changes: the only H1 leaves the group titles; hunk source text; readable word diffs', () => {
  const changes = {
    hunks: [
      { id: 'h1', op: 'mod', section: ['Rate Limiter Spec', '1. Goals'] },
      { id: 'h2', op: 'mod', section: ['Rate Limiter Spec', '6. Rollout', '6.1 Tiers'] },
      { id: 'h3', op: 'add', section: ['Rate Limiter Spec'] },
    ],
  };
  const outline = [{ level: 1, text: 'Rate Limiter Spec' }, { level: 2, text: '1. Goals' }, { level: 2, text: '6. Rollout' }];
  assert.equal(singleH1(outline), 'Rate Limiter Spec');
  assert.equal(singleH1([...outline, { level: 1, text: 'Appendix' }]), null);
  assert.deepEqual(groupHunks(changes, { h1: singleH1(outline) }).map((g) => g.title), ['1. Goals', '6. Rollout › 6.1 Tiers', 'Rate Limiter Spec']);
  assert.deepEqual(groupHunks(changes).map((g) => g.title), ['Rate Limiter Spec › 1. Goals', '6. Rollout › 6.1 Tiers', 'Rate Limiter Spec']);

  const sdiff = {
    hunks: [{
      id: 'h1',
      rows: [
        { op: ' ', text: 'context' },
        { op: '-', text: '- Enforce for all tiers within 7 days.', hunk: 'h1' },
        { op: '+', text: '- Enforce for Pro and Enterprise within 14 days.', hunk: 'h1' },
        { op: '+', text: '- Free tier: warn only.', hunk: 'h2' },
      ],
    }],
  };
  assert.deepEqual(hunkSourceText(sdiff, 'h1'), { old: '- Enforce for all tiers within 7 days.', new: '- Enforce for Pro and Enterprise within 14 days.' });
  assert.deepEqual(hunkSourceText(sdiff, 'h2'), { old: '', new: '- Free tier: warn only.' });
  assert.equal(hunkSourceText(sdiff, 'h9'), null);

  // "all tiers" -> "Pro and Enterprise" reads as one replaced phrase, not fragments.
  const parts = coalesceWordParts(wordParts('- Enforce for all tiers within 7 days.', '- Enforce for Pro and Enterprise within 14 days.'));
  assert.deepEqual(parts.filter((p) => p.op !== 'eq'), [
    { op: 'del', text: 'all tiers' }, { op: 'ins', text: 'Pro and Enterprise' }, { op: 'del', text: '7' }, { op: 'ins', text: '14' },
  ]);
  assert.equal(parts.filter((p) => p.op !== 'ins').map((p) => p.text).join(''), '- Enforce for all tiers within 7 days.');
  assert.equal(parts.filter((p) => p.op !== 'del').map((p) => p.text).join(''), '- Enforce for Pro and Enterprise within 14 days.');

  // Long unchanged runs keep the context next to the change.
  const before = `${'lorem ipsum '.repeat(20)}rate 10 per second ${'dolor sit '.repeat(20)}`;
  const trimmed = trimDiffContext(coalesceWordParts(wordParts(before, before.replace('10', '20'))), 30);
  assert.equal(trimmed[0].op, 'gap');
  assert.equal(trimmed[trimmed.length - 1].op, 'gap');
  const shown = trimmed.map((p) => p.text).join('');
  assert.ok(shown.length < 120, shown);
  assert.match(shown, /rate 1020 per second/);

  assert.deepEqual(diffLines([{ op: 'eq', text: 'a\nb' }, { op: 'ins', text: 'c\n' }]), [[{ op: 'eq', text: 'a' }], [{ op: 'eq', text: 'b' }, { op: 'ins', text: 'c' }]]);
});

test('isComposerDirty: a comment, an edited suggestion, attachments or a lock note are input; the capture and crop are not', () => {
  const base = { body: '', suggestion: null, pendingSuggestion: null, attachments: [], note: '', crop: 'data:image/png;base64,x' };
  assert.equal(isComposerDirty(null), false);
  assert.equal(isComposerDirty(base), false, 'an empty composer (even with an automatic crop) holds nothing');
  assert.equal(isComposerDirty({ ...base, body: '  ' }), false);
  assert.equal(isComposerDirty({ ...base, body: 'Why?' }), true);
  // UIR-4: a suggestion-only composer (empty "Why?") is input.
  const sug = { mode: 'text', old: 'Ship rotation behind a flag.', new: 'Ship rotation behind a flag.' };
  assert.equal(isComposerDirty({ ...base, suggestion: sug }), false, 'an untouched suggestion editor');
  assert.equal(isComposerDirty({ ...base, suggestion: { ...sug, new: 'Ship rotation behind the token-rotation flag.' } }), true);
  assert.equal(isComposerDirty({ ...base, suggestion: { ...sug, new: '', loading: true } }), false, 'still loading');
  assert.equal(isComposerDirty({ ...base, pendingSuggestion: { ...sug, new: 'restored' } }), true, 'a restored suggestion waiting for the editor');
  assert.equal(isComposerDirty({ ...base, attachments: [{ path: 'attachments/a1.png', preview: '' }] }), true);
  assert.equal(isComposerDirty({ ...base, note: 'Agreed with legal' }), true);
});

test('backupHasInput mirrors isComposerDirty for stored backups', () => {
  assert.equal(backupHasInput(null), false);
  assert.equal(backupHasInput({ body: '' }), false);
  assert.equal(backupHasInput({ body: 'x' }), true);
  assert.equal(backupHasInput({ body: '', suggestion: { old: 'a', new: 'a' } }), false);
  assert.equal(backupHasInput({ body: '', suggestion: { old: 'a', new: 'b' } }), true);
  assert.equal(backupHasInput({ body: '', attachments: ['attachments/a1.png'] }), true);
  assert.equal(backupHasInput({ body: '', note: 'n' }), true);
});

test('isReplyDirty: unsaved reply text, or edits to its reply draft', () => {
  const drafts = { items: [{ id: 'd2', kind: 'reply', thread: 't1', body: 'Old reply text', reopen: false }] };
  assert.equal(isReplyDirty(null, drafts), false);
  assert.equal(isReplyDirty({ body: '', reopen: false, draftId: null }, drafts), false);
  assert.equal(isReplyDirty({ body: 'A new reply', reopen: false, draftId: null }, drafts), true);
  assert.equal(isReplyDirty({ body: 'Old reply text', reopen: false, draftId: 'd2' }, drafts), false, 'as saved');
  assert.equal(isReplyDirty({ body: 'New reply text after edit', reopen: false, draftId: 'd2' }, drafts), true);
  assert.equal(isReplyDirty({ body: 'Old reply text', reopen: true, draftId: 'd2' }, drafts), true, 'reopen toggled');
  assert.equal(isReplyDirty({ body: 'Old reply text', reopen: false, draftId: 'd9' }, drafts), true, 'its draft is gone');
});

test('draftVersion is the version of the draft\'s anchor', () => {
  assert.equal(draftVersion({ anchor: anchor(1, 10), version: 1 }), 1);
  assert.equal(draftVersion({ anchor: anchor(3, 10) }), 3);
  assert.equal(draftVersion({ version: 2 }), 2);
  assert.equal(draftVersion({}), null);
});

test('staleApproveText refuses an approve of a head the reviewer is not looking at (UIR-1)', () => {
  assert.equal(staleApproveText(docState(), 3), null);
  assert.equal(staleApproveText(docState(), 2), 'v3 arrived while you were reviewing v2. Review v3 before approving.');
  assert.match(String(staleApproveText(docState({ doc: { id: 'spec', head: 1 } }), 2)), /latest version is v1/);
});

test('applyErrorText: only a dirty working copy gets the "record first" advice (UIR-12)', () => {
  const dirty = { status: 409, message: 'the working copy of docs/spec.md has unrecorded changes; apply needs a clean working copy', body: { code: 'CONFLICT' } };
  assert.equal(applyErrorText('t3', dirty), 'The working copy has unrecorded changes. Record them first, then apply.');
  const applied = { status: 409, message: 't3 was already applied in v2', body: { error: 't3 was already applied in v2', code: 'REFUSED' } };
  assert.equal(applyErrorText('t3', applied), 'Could not apply t3: t3 was already applied in v2');
  const conflict = { status: 409, message: 'conflict t3: the suggested text was not found in v2', body: { code: 'REFUSED' } };
  assert.equal(applyErrorText('t3', conflict), 'Could not apply t3: conflict t3: the suggested text was not found in v2');
  assert.equal(applyErrorText('t3', { status: 500, message: 'boom' }), 'Could not apply t3: boom');
});

test('attachmentUrl: attachmentBase + the file name, only on the content origin and only for image names', () => {
  const ds = { contentBase: 'http://127.0.0.1:4778/c/abc123', attachmentBase: 'http://127.0.0.1:4778/c/abc123/__att/' };
  assert.equal(attachmentUrl(ds, 'attachments/a3.png'), 'http://127.0.0.1:4778/c/abc123/__att/a3.png');
  assert.equal(attachmentUrl(ds, 'a4.jpg'), 'http://127.0.0.1:4778/c/abc123/__att/a4.jpg');
  assert.equal(attachmentUrl({ ...ds, attachmentBase: 'http://127.0.0.1:4778/c/abc123/__att' }, 'attachments/a1.png'),
    'http://127.0.0.1:4778/c/abc123/__att/a1.png', 'a base without the trailing slash');
  assert.equal(attachmentUrl({ contentBase: ds.contentBase }, 'attachments/a1.png'), null, 'no attachmentBase (older daemon)');
  assert.equal(attachmentUrl(ds, 'attachments/notes.txt'), null);
  assert.equal(attachmentUrl(ds, 'attachments/evil.svg'), null);
  assert.equal(attachmentUrl(ds, 'attachments/..'), null);
  assert.equal(attachmentUrl(ds, 'attachments/.hidden.png'), null);
  assert.equal(attachmentUrl(ds, 'a1.png?x=1'), null);
  assert.equal(attachmentUrl(ds, null), null);
  assert.equal(attachmentUrl({ ...ds, attachmentBase: 'http://evil.example/__att/' }, 'a1.png'), null, 'another origin');
  assert.equal(attachmentUrl({ ...ds, attachmentBase: 'javascript:alert(1)//' }, 'a1.png'), null);
  assert.equal(attachmentName('attachments/a3.png'), 'a3.png');
  assert.equal(attachmentName(undefined), '');
});

test('keyLabel: Mac symbols or Ctrl / Shift names', () => {
  assert.equal(keyLabel('mod+shift+enter', true), '⌘⇧↵');
  assert.equal(keyLabel('mod+shift+enter', false), 'Ctrl+Shift+Enter');
  assert.equal(keyLabel('mod+enter', true), '⌘↵');
  assert.equal(keyLabel('mod+enter', false), 'Ctrl+Enter');
  assert.equal(keyLabel('shift+B', true), '⇧B');
  assert.equal(keyLabel('shift+B', false), 'Shift+B');
  assert.equal(keyLabel('b', false), 'b');
  assert.equal(keyLabel('esc', true), 'Esc');
  assert.equal(keyLabel('mod+shift+enter', false, { compact: true }), 'Ctrl+⇧+↵');
  assert.equal(keyLabel('mod+shift+enter', true, { compact: true }), '⌘⇧↵');
  assert.equal(keyLabel('\\', false), '\\');
  // A letter after a modifier is a capital, like menus write it; the macOS Ctrl fallback is ⌃.
  assert.equal(keyLabel('mod+k', true), '⌘K');
  assert.equal(keyLabel('mod+k', false), 'Ctrl+K');
  assert.equal(keyLabel('mod+,', true), '⌘,');
  assert.equal(keyLabel('mod+/', false), 'Ctrl+/');
  assert.equal(keyLabel('ctrl+k', true), '⌃K');
  assert.equal(keyLabel('mod+k', false, { compact: true }), 'Ctrl+K');
});

test('isSingleKeyCombo: letters, digits and punctuation (Shift allowed); not Esc, Enter or Cmd / Ctrl / Alt combos', () => {
  for (const k of ['c', 'shift+B', '?', '1', '[', '\\']) assert.equal(isSingleKeyCombo(k), true, k);
  for (const k of ['esc', 'mod+enter', 'mod+shift+enter', 'mod+k', 'alt+x', 'ctrl+,']) assert.equal(isSingleKeyCombo(k), false, k);
});

test('appCombo: Cmd or Ctrl + K / , / / on any platform; not with Alt, not Shift+K', () => {
  assert.equal(appCombo({ key: 'k', meta: true }), 'palette');
  assert.equal(appCombo({ key: 'k', ctrl: true }), 'palette');
  assert.equal(appCombo({ key: 'K', meta: true }), 'palette'); // Caps Lock
  assert.equal(appCombo({ key: 'K', meta: true, shift: true }), null);
  assert.equal(appCombo({ key: ',', meta: true }), 'settings');
  assert.equal(appCombo({ key: ',', ctrl: true }), 'settings');
  assert.equal(appCombo({ key: '/', meta: true }), 'help');
  assert.equal(appCombo({ key: '?', ctrl: true, shift: true }), 'help');
  assert.equal(appCombo({ key: 'k' }), null);
  assert.equal(appCombo({ key: 'k', ctrl: true, alt: true }), null);
  assert.equal(appCombo({ key: 'Enter', meta: true }), null);
});

test('fuzzyMatch: subsequences ranked by prefix, word starts and runs; no letters from the middle of other words', () => {
  const gt = fuzzyMatch('gt', 'Go to thread');
  assert.deepEqual(gt?.positions, [0, 3]);
  assert.ok(/** @type {any} */ (fuzzyMatch('verif', 'Verify queue')).score > /** @type {any} */ (fuzzyMatch('verif', 'Never if you')).score || !fuzzyMatch('verif', 'Never if you'));
  // A prefix beats the same letters later on.
  assert.ok(/** @type {any} */ (fuzzyMatch('com', 'Comment on the selection')).score > /** @type {any} */ (fuzzyMatch('com', 'Submit review as Comment')).score);
  // Abbreviations inside one word.
  assert.deepEqual(fuzzyMatch('stng', 'Open settings')?.positions, [5, 7, 10, 11]);
  assert.ok(fuzzyMatch('kbd', 'Keyboard shortcuts'));
  // Letters picked from the middle of different words are no match.
  assert.equal(fuzzyMatch('mode', 'comment · Rollout — load test'), null);
  assert.equal(fuzzyMatch('snip', 'Send now: this comment alone, the composer'), null);
  assert.equal(fuzzyMatch('xyz', 'Go to thread'), null);
  assert.deepEqual(fuzzyMatch('', 'anything'), { score: 0, positions: [] });
});

test('matchRow: words in any order, keywords and descriptions, exact ids first; highlightParts', () => {
  const approve = matchRow('approve submit', { title: 'Submit review as Approve' });
  assert.ok(approve);
  assert.deepEqual(highlightParts('Submit review as Approve', /** @type {any} */ (approve).positions).filter((p) => p.hit).map((p) => p.text), ['Submit', 'Approve']);
  // A keyword (a thread's comment text) finds the row without highlighting the title.
  const byKeyword = matchRow('grace window', { title: 't1 · comment · §3 Tokens', keywords: ['Add a grace window for concurrent refreshes.'] });
  assert.ok(byKeyword);
  assert.deepEqual(/** @type {any} */ (byKeyword).positions, []);
  assert.equal(matchRow('nothing here', { title: 'Go to thread', keywords: ['jump'] }), null);
  // An exact id outranks any fuzzy match.
  const t4 = /** @type {any} */ (matchRow('t4', { title: 't4 · comment · §Rollout', exact: ['t4'] }));
  const other = /** @type {any} */ (matchRow('t4', { title: 'Toggle 4 things' }));
  assert.ok(t4.score > (other?.score ?? 0));
  assert.deepEqual(t4.positions, [0, 1]);
  assert.deepEqual(matchRow('  ', { title: 'x' }), { score: 0, positions: [] });
  assert.deepEqual(highlightParts('abc', [0, 2]), [{ text: 'a', hit: true }, { text: 'b', hit: false }, { text: 'c', hit: true }]);
});

test('threadRowTitle: "t4 · comment · §section — first words", drafts and doc-level comments', () => {
  const t = {
    ...thread('t4', 'open', [{ by: human, body: 'Add a **target RPS** for the load test, and the p99 latency we accept under that load.' }]),
    anchors: { 1: anchor(1, 10, { section: ['Spec', '4 Rollout checklist'] }) },
  };
  const row = threadRowTitle({ kind: 'thread', id: 't4', item: t, anchor: anchorAt(t, 1) });
  assert.match(row.title, /^t4 · comment · §4 Rollout checklist — Add a target RPS for the load test, and the p99 latency we…$/);
  assert.match(row.body, /p99 latency we accept under that load\.$/);
  const draft = threadRowTitle({ kind: 'draft', id: 'd2', item: { type: 'question', body: 'Why?' }, anchor: { kind: 'doc' } });
  assert.equal(draft.title, 'd2 · draft question · General comment — Why?');
  const agentQ = threadRowTitle({ kind: 'thread', id: 't6', item: { type: 'agent-question', comments: [] }, anchor: null });
  assert.equal(agentQ.title, 't6 · agent question · document');
});

test('canSendNow: a new comment, question or suggestion; not a draft being edited or "Mark agreed"', () => {
  assert.equal(canSendNow(null), false);
  assert.equal(canSendNow({ type: 'comment', draftId: null }), true);
  assert.equal(canSendNow({ type: 'suggestion', draftId: null }), true);
  assert.equal(canSendNow({ type: 'comment', draftId: 'd2' }), false);
  assert.equal(canSendNow({ type: 'agree', draftId: null }), false);
});

test('snip anchors: the card names the snipped area and quotes the text inside the box', () => {
  const snip = {
    v: 1, kind: 'snip', state: 'exact', quote: null, src: { start: 10, end: 90, startLine: 29, endLine: 36, text: '![x](a.png)' },
    snip: { label: 'area over "2. Request flow" (figure + 2 paragraphs)', covers: 'figure + 2 paragraphs', text: 'Client  app\nGateway', region: null, container: null },
  };
  assert.equal(targetLabel(snip), 'area over "2. Request flow" (figure + 2 paragraphs)');
  assert.equal(targetLabel({ ...snip, snip: { ...snip.snip, label: '' } }), 'snip (figure + 2 paragraphs)');
  assert.equal(targetLabel({ ...snip, snip: undefined }), 'snipped area');
  assert.equal(anchorQuote(snip), 'Client app Gateway');
  assert.equal(anchorQuote({ ...snip, snip: { ...snip.snip, text: '' } }), '');
});

test('doc kinds: docKindOf, kindCaps and modesFor (code reviews: no frame, no locks, "Files" instead of Source)', () => {
  const file = { doc: { id: 'spec', path: 'docs/spec.md' } };
  const snapshot = { doc: { id: 'plan', kind: 'snapshot', origin: { type: 'plan' } } };
  const code = { doc: { id: 'cr-feat', kind: 'code', origin: { type: 'diff' } } };
  assert.deepEqual([file, snapshot, code, null].map(docKindOf), ['file', 'snapshot', 'code', 'file']);
  assert.deepEqual(kindCaps(file), { frame: true, pick: true, snip: true, hide: true, pageErrors: true, applyNow: true, liveBanners: true, locks: true });
  assert.equal(kindCaps(snapshot).applyNow, false, 'a snapshot agent applies suggestions when it revises');
  assert.equal(kindCaps(snapshot).frame, true);
  assert.deepEqual(kindCaps(code), { frame: false, pick: false, snip: false, hide: false, pageErrors: false, applyNow: true, liveBanners: false, locks: false });
  assert.deepEqual(modesFor(file).map((m) => [m.key, m.label, m.n]),
    [['read', 'Read', 0], ['review', 'Review', 1], ['changes', 'Changes', 2], ['source', 'Source', 3], ['history', 'History', 4]]);
  assert.deepEqual(modesFor(snapshot), modesFor(file));
  assert.deepEqual(modesFor(code).map((m) => [m.key, m.label, m.n]), [['review', 'Files', 1], ['changes', 'Changes', 2], ['history', 'History', 4]]);
  assert.equal(hasMode(code, 'source'), false);
  assert.equal(hasMode(code, 'read'), false, 'a code review has no rendered doc to read');
  assert.equal(hasMode(code, 'review'), true);
  assert.equal(hasMode(file, 'source'), true);
  assert.equal(hasMode(file, 'read'), true);
  // the modes that show the rendered doc (select, pick, snip work there)
  assert.deepEqual(['read', 'review', 'changes', 'source', 'history'].filter(showsDoc), ['read', 'review', 'changes']);
});

test('Accept all: the addressed and answered threads of the Verify queue; declines stay', () => {
  const replied = (/** @type {string} */ id, /** @type {string} */ status) => thread(id, status,
    [{ by: human, body: 'q', version: 1 }, { by: agent, body: 'done', version: 2, status }]);
  const ds = docState({
    threads: [
      replied('t1', 'addressed'),
      replied('t2', 'answered'),
      replied('t3', 'declined'),
      thread('t4', 'open', [{ by: human, body: 'still open', version: 1 }]),
      thread('t5', 'resolved', [{ by: human, body: 'a', version: 1 }, { by: agent, body: 'b', version: 2, status: 'addressed' }]),
      // the reviewer answered after the agent: not in Verify any more
      thread('t6', 'addressed', [{ by: agent, body: 'done', version: 2, status: 'addressed' }, { by: human, body: 'but...', version: 2 }]),
      // a reply draft pending on it: not in Verify either
      replied('t7', 'addressed'),
      thread('t8', 'needs_input', [{ by: agent, body: 'which?', version: 2, status: 'needs_input' }]),
    ],
    drafts: { schema: 1, items: [{ id: 'd1', kind: 'reply', thread: 't7', body: 'hm' }] },
  });
  assert.deepEqual(acceptableThreads(ds).map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(declinedToVerify(ds).map((t) => t.id), ['t3']);
  assert.deepEqual(acceptableThreads(null), []);
  assert.deepEqual(declinedToVerify(docState()), []);
});

test('code anchors: card targets name the file, side and lines; panel order is by file', () => {
  const src = (/** @type {number} */ a, /** @type {number} */ b) => ({ start: a * 10, end: b * 10 + 5, startLine: a, endLine: b, text: 'x' });
  const line = { v: 1, kind: 'source', state: 'exact', src: src(3, 4), section: ['src/a.js'], file: { path: 'src/a.js', side: 'new' } };
  const old = { ...line, src: src(7, 7), file: { path: 'src/a.js', side: 'old' } };
  const whole = { v: 1, kind: 'doc', state: 'exact', section: ['img/logo.png'], file: { path: 'img/logo.png', side: 'new' } };
  assert.equal(targetLabel(line), 'src/a.js:L3-4');
  assert.equal(targetLabel(old), 'src/a.js (old side) L7');
  assert.equal(targetLabel(whole), 'img/logo.png (whole file)');
  assert.equal(targetLabel({ v: 1, kind: 'doc', state: 'exact' }), 'General comment', 'a whole-review comment');
  assert.deepEqual(anchorChipParts(null, line), { lines: '', section: '', label: 'src/a.js:L3-4' });
  const t = (/** @type {string} */ id, /** @type {any} */ a) => ({ id, status: 'open', severity: 'normal', type: 'comment', createdIn: 1, anchors: { 1: a }, comments: [] });
  const ds = {
    doc: { id: 'cr', kind: 'code', head: 1 },
    threads: [t('t1', { ...line, file: { path: 'src/z.js', side: 'new' } }), t('t2', line), t('t3', whole), t('t4', { v: 1, kind: 'doc', state: 'exact' }), t('t5', { ...line, src: src(1, 1) })],
    drafts: { items: [] },
  };
  assert.deepEqual(panelItems(ds, 'all', 1).map((x) => x.id), ['t4', 't3', 't5', 't2', 't1']);
});
