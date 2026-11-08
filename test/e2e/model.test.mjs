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
  isVerifiable, keyLabel, linesLabel, matchRow, panelItems, panelWidthRange, plainBody, presenceInfo, reviewProgress, roundResults, roundSummary,
  singleH1, staleApproveText, statusInfo, suggestionMode, targetLabel, threadMatches, threadRowTitle, timeline,
  trimDiffContext, baseTag, openingMode, plainMode, reviewedThrough, revisionsToAccept,
  agentTitle, approveReady, lostThreads, myTurn, newChangesCount, openThreadCount, problemList, turnInfo,
  agentAttachments, composerKeyAction, defaultFilter, docSize, filterCounts, filterLabel, FILTERS, isLongDoc, normalizeFilter,
  plannedThreads, replyKeyAction, reviewEdits, systemLine, threadAttachmentName, turnReason,
  agentSees, applicablePlanned, approveWarnings,
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
  // the old Verify filter key still finds them (now Your turn)
  assert.equal(threadMatches(addressed, 'verify', { drafts: { items: [] }, version: 2 }), true);
  assert.equal(statusInfo(addressed).label, 'Changed in v2 — check it');
  assert.equal(statusInfo(thread('t9', 'needs_input', []), 'codex').banner, 'Codex asked you');
});

test('statusInfo: one chip per thread in plain words, with the agent\'s name, and "Lost its place" for a lost anchor', () => {
  const ctx = { drafts: { items: [] }, version: 2 };
  const said = (/** @type {string} */ status) => [{ by: human, body: 'a', version: 1 }, { by: agent, body: 'b', version: 2, status }];
  /** @param {string} status @param {any[]} [comments] @param {any} [c] */
  const chip = (status, comments = said(status), c = ctx) => {
    const st = statusInfo(thread('t1', status, comments), 'claude', c);
    return [st.key, st.label, st.tone];
  };
  assert.deepEqual(chip('open', [{ by: human, body: 'a' }]), ['open', 'With Claude', 'accent']);
  assert.deepEqual(chip('planned'), ['planned', 'Will change', 'info']);
  assert.match(String(statusInfo(thread('t1', 'planned', said('planned')), 'claude', ctx).title), /agreed and will make this change when you apply/);
  assert.deepEqual(chip('answered'), ['answered', 'Claude answered', 'ok']);
  assert.deepEqual(chip('addressed'), ['addressed', 'Changed in v2 — check it', 'ok']);
  // not to check any more (a reply of the reviewer is pending): no "check it"
  assert.deepEqual(chip('addressed', said('addressed'), { drafts: { items: [{ kind: 'reply', thread: 't1', body: 'x' }] }, version: 2 }),
    ['addressed', 'Changed in v2', 'ok']);
  assert.deepEqual(chip('declined'), ['declined', 'Claude didn\'t change it', 'warn']);
  assert.deepEqual(chip('needs_input', [{ by: agent, body: 'q', version: 2, status: 'needs_input' }]), ['needs_input', 'Needs your answer', 'attn']);
  assert.deepEqual(chip('resolved', [{ by: human, body: 'a' }]), ['resolved', 'Done', 'muted']);
  assert.equal(statusInfo(thread('t1', 'open', []), 'gpt-5').label, 'With gpt-5');
  // the reviewer replied after the agent's answer: with the agent again (the status stays)
  const replied = statusInfo(thread('t1', 'answered', [...said('answered'), { by: human, body: 'and the TTL?', version: 2 }]), 'claude', ctx);
  assert.deepEqual([replied.key, replied.label, replied.tone], ['answered', 'With Claude', 'accent']);
  const asked = thread('t2', 'needs_input', [{ by: agent, body: 'q', status: 'needs_input' }, { by: human, body: 'yes' }]);
  assert.equal(statusInfo(asked, 'claude', ctx).label, 'With Claude');
  assert.equal(turnReason(asked, ctx), null, 'answered: not the reviewer\'s turn any more');
  // lost: unresolved, its anchor changed or orphaned in the version shown, nothing else waiting for the reviewer
  const lost = thread('t4', 'open', [{ by: human, body: 'a', version: 1 }], { 2: anchor(2, 10, { state: 'changed' }) });
  assert.deepEqual(chip('open', [], ctx).slice(0, 2), ['open', 'With Claude']);
  const st = statusInfo(lost, 'claude', ctx);
  assert.deepEqual([st.key, st.label, st.tone], ['lost', 'Lost its place', 'warn']);
  assert.equal(statusInfo(lost, 'claude').key, 'open', 'without the context (version shown) it is not judged lost');
  const resolvedLost = thread('t6', 'resolved', [], { 2: anchor(2, 10, { state: 'orphaned' }) });
  assert.equal(statusInfo(resolvedLost, 'claude', ctx).key, 'resolved', 'a thread that is done never shows as lost');
});

test('turnReason: pending > answer > check > lost, and null for what waits for the agent', () => {
  const ctx = (/** @type {any[]} */ items = []) => ({ drafts: { items }, version: 2 });
  const answered = thread('t1', 'answered', [{ by: human, body: 'q', version: 1 }, { by: agent, body: 'a', version: 2, status: 'answered' }]);
  const orphan = { 2: anchor(2, 10, { state: 'orphaned' }) };
  assert.equal(turnReason(answered, ctx()), 'check');
  assert.equal(turnReason(answered, ctx([{ kind: 'reply', thread: 't1', body: 'x' }])), 'pending');
  assert.equal(turnReason(answered, ctx([{ kind: 'resolve', thread: 't1' }])), 'pending');
  assert.equal(turnReason(thread('t2', 'needs_input', [{ by: agent, body: 'q', status: 'needs_input' }], orphan), ctx()), 'answer');
  assert.equal(turnReason({ ...answered, anchors: orphan }, ctx()), 'check', 'answered and lost: to check first');
  assert.equal(turnReason(thread('t3', 'open', [{ by: human, body: 'a' }], orphan), ctx()), 'lost');
  assert.equal(turnReason(thread('t3', 'planned', [{ by: agent, body: 'will do', status: 'planned' }], orphan), ctx()), 'lost');
  assert.equal(turnReason(thread('t3', 'open', [{ by: human, body: 'a' }]), ctx()), null);
  assert.equal(turnReason(thread('t3', 'planned', [{ by: human, body: 'a' }, { by: agent, body: 'will do', status: 'planned' }]), ctx()), null);
  assert.equal(turnReason(thread('t3', 'resolved', [], orphan), ctx()), null);
});

test('filters: Your turn, the agent\'s, Done, All; every unresolved thread in exactly one of the first two', () => {
  assert.deepEqual(FILTERS.map((f) => f.key), ['mine', 'agent', 'done', 'all']);
  assert.equal(filterLabel('mine', 'claude'), 'Your turn');
  assert.equal(filterLabel('agent', 'claude'), 'Claude');
  assert.equal(filterLabel('agent', 'codex'), 'Codex');
  assert.equal(filterLabel('done'), 'Done');
  // earlier keys (palette commands, keys, saved state) map to the new ones; anything else is the doc's default
  assert.deepEqual(['needs', 'verify', 'drafts', 'outdated', 'open', 'resolved', 'all', 'mine'].map((k) => normalizeFilter(k)),
    ['mine', 'mine', 'mine', 'mine', 'agent', 'done', 'all', 'mine']);
  assert.equal(normalizeFilter('nonsense'), 'all');
  const ds = docState({
    doc: { ...docState().doc, head: 2 },
    threads: [
      thread('t1', 'addressed', [{ by: human, body: 'a', version: 1 }, { by: agent, body: 'done', version: 2, status: 'addressed' }]),
      thread('t2', 'needs_input', [{ by: agent, body: 'which?', version: 2, status: 'needs_input' }]),
      thread('t3', 'open', [{ by: human, body: 'a', version: 1 }]),
      thread('t4', 'open', [{ by: human, body: 'a', version: 1 }], { 2: anchor(2, 10, { state: 'orphaned' }) }),
      thread('t5', 'answered', [{ by: human, body: 'q', version: 1 }, { by: agent, body: 'yes', version: 2, status: 'answered' }]),
      thread('t6', 'resolved', [{ by: human, body: 'a', version: 1 }], { 2: anchor(2, 10, { state: 'orphaned' }) }),
      thread('t7', 'planned', [{ by: human, body: 'a', version: 1 }, { by: agent, body: 'will', version: 2, status: 'planned' }]),
      thread('t8', 'open', [{ by: human, body: 'a', version: 1 }, { by: agent, body: 'b', version: 2, status: 'answered' }, { by: human, body: 'c', version: 2 }]),
    ],
    drafts: { schema: 1, items: [{ id: 'd1', kind: 'thread', body: 'new', anchor: anchor(2, 30) }, { id: 'd2', kind: 'reply', thread: 't5', body: 'more' }] },
  });
  const ids = (/** @type {string} */ f) => panelItems(ds, f, 2).map((x) => x.id).sort();
  assert.deepEqual(ids('mine'), ['d1', 't1', 't2', 't4', 't5']);
  assert.deepEqual(ids('agent'), ['t3', 't7', 't8']);
  assert.deepEqual(ids('done'), ['t6']);
  assert.deepEqual(ids('all'), ['d1', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']);
  for (const t of ds.threads.filter((x) => x.status !== 'resolved')) {
    assert.equal(Number(threadMatches(t, 'mine', { drafts: ds.drafts, version: 2 })) + Number(threadMatches(t, 'agent', { drafts: ds.drafts, version: 2 })), 1, t.id);
  }
  const counts = filterCounts(ds, 2);
  assert.deepEqual(counts, { mine: 5, agent: 3, done: 1, all: 9 });
  assert.equal(counts.mine, myTurn(ds, 2).count, 'the panel counts what the turn pill counts');
  // legacy keys from old call sites
  assert.deepEqual(panelItems(ds, 'resolved', 2).map((x) => x.id), ['t6']);
  assert.deepEqual(plannedThreads(ds).map((t) => t.id), ['t7']);
});

test('defaultFilter: Your turn when something waits for the reviewer, else the agent\'s, else All', () => {
  const answered = thread('t1', 'answered', [{ by: human, body: 'q', version: 1 }, { by: agent, body: 'a', version: 2, status: 'answered' }]);
  const open = thread('t2', 'open', [{ by: human, body: 'q', version: 1 }]);
  const done = thread('t3', 'resolved', [{ by: human, body: 'q', version: 1 }]);
  assert.equal(defaultFilter(docState({ threads: [answered, open, done] }), 3), 'mine');
  assert.equal(defaultFilter(docState({ threads: [open, done] }), 3), 'agent');
  assert.equal(defaultFilter(docState({ threads: [done] }), 3), 'all');
  assert.equal(defaultFilter(docState(), 3), 'all');
  assert.equal(defaultFilter(docState({ threads: [open], drafts: { items: [{ id: 'd1', kind: 'thread', body: 'x' }] } }), 3), 'mine');
  assert.equal(normalizeFilter('bogus', docState({ threads: [open] }), 3), 'agent', 'unknown keys get the default');
});

test('docSize / isLongDoc / reviewEdits: over 20,000 characters of text (or 800 lines without the count) batches with Auto', () => {
  /** @param {any} meta */
  const at = (meta) => docState({ doc: { ...docState().doc, head: 1 }, versions: [{ v: 1, author: agent, ...meta }] });
  assert.deepEqual(docSize(at({ lines: 100, textChars: 34120 })), { long: true, chars: 34120, lines: 100 });
  assert.deepEqual(docSize(at({ lines: 2000, textChars: 1500 })), { long: false, chars: 1500, lines: 2000 }, 'the characters decide when counted');
  assert.deepEqual(docSize(at({ lines: 801 })), { long: true, chars: null, lines: 801 });
  assert.deepEqual(docSize(at({ lines: 800 })), { long: false, chars: null, lines: 800 });
  assert.equal(isLongDoc(at({ lines: 10, textChars: 20001 })), true);
  assert.equal(isLongDoc(at({ lines: 10, textChars: 20000 })), false);
  assert.equal(isLongDoc(at({})), false);
  assert.equal(isLongDoc(null), false);
  const long = at({ lines: 10, textChars: 30000 });
  const short = at({ lines: 10, textChars: 3000 });
  assert.equal(reviewEdits(long, { editMode: 'auto' }), 'batch');
  assert.equal(reviewEdits(short, { editMode: 'auto' }), 'now');
  assert.equal(reviewEdits(long, { editMode: 'now' }), 'now');
  assert.equal(reviewEdits(short, { editMode: 'batch' }), 'batch');
  assert.equal(reviewEdits(long, {}), 'batch', 'no setting: Auto');
});

test('composer and reply keys follow Send comments: right away Enter sends, else Enter adds to the review', () => {
  const comment = { draftId: null, type: 'comment' };
  assert.equal(composerKeyAction(comment, false, 'now'), 'send');
  assert.equal(composerKeyAction(comment, true, 'now'), 'save');
  assert.equal(composerKeyAction(comment, false, 'batch'), 'save');
  assert.equal(composerKeyAction(comment, true, 'batch'), 'send');
  // a draft being edited and "Mark agreed" are never sent alone: Enter saves, Shift is the whole review's Send dialog
  for (const c of [{ draftId: 'd1', type: 'comment' }, { draftId: null, type: 'agree' }]) {
    for (const mode of ['now', 'batch']) {
      assert.equal(composerKeyAction(c, false, mode), 'save');
      assert.equal(composerKeyAction(c, true, mode), 'review');
    }
  }
  assert.equal(replyKeyAction(false, 'now'), 'send');
  assert.equal(replyKeyAction(true, 'now'), 'save');
  assert.equal(replyKeyAction(false, 'batch'), 'save');
  assert.equal(replyKeyAction(true, 'batch'), 'send');
});

test('agent attachments, attachment names and the compact lines of an Apply or a Use in doc', () => {
  const c = {
    by: agent,
    attachments: [
      { path: 'attachments/a7.png', name: 'lifetimes.png', kind: 'image' },
      { path: 'attachments/a8.html', name: 'chart.html', kind: 'html' },
      { path: 'attachments/a9.htm' },
      { path: '../etc/passwd', name: 'x', kind: 'image' },
      'attachments/a10.svg',
      null,
    ],
  };
  assert.deepEqual(agentAttachments(c), [
    { path: 'attachments/a7.png', name: 'lifetimes.png', kind: 'image' },
    { path: 'attachments/a8.html', name: 'chart.html', kind: 'html' },
    { path: 'attachments/a9.htm', name: 'a9.htm', kind: 'html' },
    { path: 'attachments/a10.svg', name: 'a10.svg', kind: 'image' },
  ]);
  assert.deepEqual(agentAttachments({ by: agent }), []);
  const t = thread('t7', 'answered', [{ by: human, body: 'chart?' }, c]);
  assert.equal(threadAttachmentName(t, 'attachments/a8.html'), 'chart.html');
  assert.equal(threadAttachmentName(t, 'attachments/a99.png'), 'a99.png');
  assert.deepEqual(systemLine(t, { by: human, body: 'Apply this change.', apply: true }, 'claude'),
    { kind: 'apply', text: 'You asked Claude to make this change', body: '' });
  assert.deepEqual(systemLine(t, { by: human, body: 'Put this in the doc.', use: ['attachments/a8.html'] }, 'claude'),
    { kind: 'use', text: 'You asked Claude to put chart.html in the document', body: '' });
  assert.deepEqual(systemLine(t, { by: human, body: 'Under section 3, please.', use: ['attachments/a7.png', 'attachments/a8.html'] }, 'claude'),
    { kind: 'use', text: 'You asked Claude to put lifetimes.png and chart.html in the document', body: 'Under section 3, please.' });
  assert.equal(systemLine(t, { by: human, body: 'An ordinary reply' }), null);
  assert.equal(systemLine(t, { by: agent, body: 'Apply this change.', apply: true }), null, 'only the reviewer\'s requests');
});

test('panelItems: document order, new-thread drafts with Your turn / All, earlier filter keys mapped', () => {
  const ds = docState({
    threads: [
      thread('t1', 'open', [], { 1: anchor(1, 50) }),
      thread('t2', 'resolved', [], { 1: anchor(1, 5) }),
      thread('t3', 'open', [], { 1: anchor(1, 30, { state: 'changed' }) }),
      thread('t4', 'open', [], { 1: { v: 1, kind: 'doc', state: 'exact', src: { start: 0, end: 0 } } }),
    ],
    drafts: { schema: 1, items: [{ id: 'd1', kind: 'thread', anchor: anchor(1, 40), body: 'x' }, { id: 'd2', kind: 'reply', thread: 't1', body: 'y' }] },
  });
  // Your turn: the lost t3, the draft d1 and t1 (its reply is pending), in document order; the agent's: t4
  assert.deepEqual(panelItems(ds, 'mine', 1).map((x) => x.id), ['t3', 'd1', 't1']);
  assert.deepEqual(panelItems(ds, 'agent', 1).map((x) => x.id), ['t4']);
  assert.deepEqual(panelItems(ds, 'all', 1).map((x) => x.id), ['t4', 't2', 't3', 'd1', 't1']);
  assert.deepEqual(panelItems(ds, 'done', 1).map((x) => x.id), ['t2']);
  // earlier keys: outdated / drafts are Your turn now, open the agent's, resolved Done
  assert.deepEqual(panelItems(ds, 'outdated', 1).map((x) => x.id), ['t3', 'd1', 't1']);
  assert.deepEqual(panelItems(ds, 'open', 1).map((x) => x.id), ['t4']);
  assert.deepEqual(panelItems(ds, 'resolved', 1).map((x) => x.id), ['t2']);
  // the thread whose reply box is open stays listed whatever the filter (resolved in another tab, say)
  assert.deepEqual(panelItems(ds, 'done', 1, 't1').map((x) => x.id), ['t2', 't1']);
});

test('presence and review progress follow waiters, delivery, the working copy and the answering version', () => {
  const submitted = { id: 'rv2', submittedAt: '2026-10-10T12:30:00.000Z', deliveredTo: {} };
  let ds = docState({ reviews: [submitted] });
  assert.deepEqual(presenceInfo(ds), { kind: 'none', label: 'Claude isn\'t connected', short: 'Not connected', tone: 'muted' });
  assert.equal(reviewProgress(ds)?.stage, 'submitted');
  assert.match(String(reviewProgress(ds)?.label), /^Sent \d\d:\d\d$/, '"Sent 12:30", not "Submitted"');
  ds = docState({ reviews: [submitted], waiters: [{ agent: 'codex', since: 'x', pid: 1 }] });
  assert.deepEqual(presenceInfo(ds), { kind: 'listening', label: 'Codex is listening', short: 'Listening', tone: 'ok' });
  const delivered = { ...submitted, deliveredTo: { claude: '2026-10-10T12:31:00.000Z' } };
  ds = docState({ reviews: [delivered] });
  assert.equal(presenceInfo(ds).label, 'Claude is working…');
  assert.equal(presenceInfo(ds).kind, 'revising');
  assert.equal(reviewProgress(ds)?.stage, 'delivered');
  assert.match(String(reviewProgress(ds)?.label), /^Claude has it · \d\d:\d\d$/, 'plain words, the agent\'s name capitalised');
  ds = docState({ reviews: [delivered], working: { dirty: true } });
  assert.equal(presenceInfo(ds).label, 'Claude is editing');
  assert.equal(reviewProgress(ds)?.label, 'Claude is editing…');
  ds = docState({ reviews: [delivered], versions: [...docState().versions, { v: 4, author: agent, createdAt: 'z', respondsTo: 'rv2' }] });
  assert.deepEqual(reviewProgress(ds), { label: 'v4 ready', tone: 'ok', stage: 'ready' });
  assert.equal(presenceInfo(ds).kind, 'none');
});

test('agentTitle capitalises a plain lowercase agent name only', () => {
  assert.equal(agentTitle('claude'), 'Claude');
  assert.equal(agentTitle('codex'), 'Codex');
  assert.equal(agentTitle('gpt-5'), 'gpt-5');
  assert.equal(agentTitle('MyBot'), 'MyBot');
  assert.equal(agentTitle(''), '');
});

test('myTurn: drafts, pending replies, answers to check, questions and lost threads, each thread once', () => {
  const ds = docState({
    doc: { ...docState().doc, head: 2 },
    threads: [
      thread('t1', 'addressed', [{ by: human, body: 'a', version: 1 }, { by: agent, body: 'done', version: 2, status: 'addressed' }]),
      thread('t2', 'needs_input', [{ by: agent, body: 'which?', version: 2, status: 'needs_input' }]),
      thread('t3', 'open', [{ by: human, body: 'a', version: 1 }]),
      thread('t4', 'open', [{ by: human, body: 'a', version: 1 }], { 2: anchor(2, 10, { state: 'orphaned' }) }),
      // answered, but the reviewer already wrote a reply: pending, not "to check"
      thread('t5', 'answered', [{ by: human, body: 'q', version: 1 }, { by: agent, body: 'yes', version: 2, status: 'answered' }]),
      thread('t6', 'resolved', [{ by: human, body: 'a', version: 1 }], { 2: anchor(2, 10, { state: 'orphaned' }) }),
    ],
    drafts: { schema: 1, items: [{ id: 'd1', kind: 'thread', body: 'new' }, { id: 'd2', kind: 'reply', thread: 't5', body: 'more' }] },
  });
  const m = myTurn(ds, 2);
  assert.deepEqual({ ...m, ids: [...m.ids].sort() }, { count: 5, drafts: 1, pending: 1, check: 1, answer: 1, lost: 1, ids: ['t1', 't2', 't4', 't5'] });
  assert.equal(openThreadCount(ds), 6);
  assert.deepEqual(lostThreads(ds, 2).map((t) => t.id), ['t4']);
  assert.deepEqual(myTurn(docState(), 3), { count: 0, drafts: 0, pending: 0, check: 0, answer: 0, lost: 0, ids: [] });
});

test('turnInfo: your turn first, then closed / approved, else where the agent is; the dot is always the presence', () => {
  const answered = thread('t1', 'answered', [{ by: human, body: 'q', version: 1 }, { by: agent, body: 'a', version: 2, status: 'answered' }]);
  let t = turnInfo(docState({ threads: [answered], waiters: [{ agent: 'claude' }] }), 3);
  assert.deepEqual([t.kind, t.label, t.short, t.presence.kind], ['yours', 'Your turn · 1', 'Your turn · 1', 'listening']);
  t = turnInfo(docState({ waiters: [{ agent: 'claude' }] }), 3);
  assert.deepEqual([t.kind, t.label, t.short, t.tone], ['listening', 'Claude is listening', 'Listening', 'ok']);
  t = turnInfo(docState(), 3);
  assert.deepEqual([t.kind, t.label, t.short], ['none', 'Claude isn\'t connected', 'Not connected']);
  t = turnInfo(docState({ doc: { ...docState().doc, state: 'approved', final: { version: 3 } } }), 3);
  assert.deepEqual([t.kind, t.label, t.short, t.tone], ['approved', 'Approved v3', 'Approved', 'ok']);
  // approved at v2, but v3 is newer: not "Approved"
  t = turnInfo(docState({ doc: { ...docState().doc, state: 'approved', final: { version: 2 } } }), 3);
  assert.equal(t.kind, 'none');
  t = turnInfo(docState({ doc: { ...docState().doc, state: 'closed' } }), 3);
  assert.deepEqual([t.kind, t.label], ['closed', 'Review closed']);
});

test('approveReady: the agent answered the newest review and nothing waits for either side', () => {
  const review = { id: 'rv2', submittedAt: '2026-10-10T12:30:00.000Z', deliveredTo: { claude: 'x' } };
  const answeredBy4 = [...docState().versions, { v: 4, author: agent, createdAt: 'z', respondsTo: 'rv2' }];
  const resolved = thread('t1', 'resolved', [{ by: human, body: 'a', version: 1 }]);
  assert.equal(approveReady(docState({ reviews: [review], versions: answeredBy4, threads: [resolved] }), 4), true);
  // not answered yet
  assert.equal(approveReady(docState({ reviews: [review], threads: [resolved] }), 3), false);
  // a thread still waits for the agent
  assert.equal(approveReady(docState({ reviews: [review], versions: answeredBy4, threads: [thread('t2', 'open', [])] }), 4), false);
  // a draft waits for the reviewer
  assert.equal(approveReady(docState({ reviews: [review], versions: answeredBy4, drafts: { items: [{ id: 'd1', kind: 'thread' }] } }), 4), false);
  // no review at all
  assert.equal(approveReady(docState(), 3), false);
});

test('newChangesCount: the changes of the latest version while it is new to the reviewer and shown', () => {
  const changes = { hunks: [{ id: 'h1' }, { id: 'h2' }] };
  assert.equal(newChangesCount(docState(), 3, changes), 2);
  assert.equal(newChangesCount(docState(), 2, changes), 0);
  assert.equal(newChangesCount(docState({ doc: { ...docState().doc, lastReviewedVersion: 3 } }), 3, changes), 0);
  assert.equal(newChangesCount(docState(), 3, null), 0);
});

test('problemList: script errors, failed resources and a missing file; nothing when all is well; a lost thread is not a problem', () => {
  const lost = thread('t4', 'open', [], { 3: anchor(3, 10, { state: 'changed' }) });
  const ds = docState({ threads: [lost, thread('t5', 'resolved', [], { 3: anchor(3, 10, { state: 'orphaned' }) })] });
  assert.deepEqual(problemList(docState(), { version: 3, pageErrors: { count: 0, last: null, resourcesFailed: [] }, externalsFailed: [] }), []);
  const list = problemList({ ...ds, working: { missing: true } }, {
    version: 3,
    pageErrors: { count: 2, last: 'TypeError: x is undefined', resourcesFailed: ['http://c/v3/img/a.png'] },
    externalsFailed: ['https://cdn.example/lib.js'],
  });
  assert.deepEqual(list.map((p) => [p.key, p.count, p.label]), [
    ['errors', 2, '2 script errors in the page'],
    ['resources', 2, '2 resources did not load'],
    ['missing', 1, 'The file is missing on disk'],
  ]);
  assert.equal(list[0].detail, 'TypeError: x is undefined');
  assert.deepEqual(list[1].items, ['https://cdn.example/lib.js', 'http://c/v3/img/a.png']);
  // the thread that lost its place is in Your turn (its card offers Move here): not a problem (V15)
  assert.deepEqual(problemList(ds, { version: 3 }), []);
  assert.deepEqual(myTurn(ds, 3).ids, ['t4']);
  // a code review has no rendered page: nothing of it is a problem
  const code = { ...ds, doc: { ...ds.doc, kind: 'code' } };
  assert.deepEqual(problemList(code, { version: 3, pageErrors: { count: 5 }, externalsFailed: ['x'] }).map((p) => p.key), []);
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
  assert.equal(roundSummary(ds)?.text, 'v2 ready: 1 to check, 1 needs your answer');
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
  assert.equal(agentPrompt(ds), 'Run suiko feedback spec and address it.', 'what the UI shows is what is copied: no Markdown');
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

test('attachmentUrl: attachmentBase + the file name, only on the content origin and only for attachment names', () => {
  const ds = { contentBase: 'http://127.0.0.1:4778/c/abc123', attachmentBase: 'http://127.0.0.1:4778/c/abc123/__att/' };
  assert.equal(attachmentUrl(ds, 'attachments/a3.png'), 'http://127.0.0.1:4778/c/abc123/__att/a3.png');
  assert.equal(attachmentUrl(ds, 'a4.jpg'), 'http://127.0.0.1:4778/c/abc123/__att/a4.jpg');
  assert.equal(attachmentUrl({ ...ds, attachmentBase: 'http://127.0.0.1:4778/c/abc123/__att' }, 'attachments/a1.png'),
    'http://127.0.0.1:4778/c/abc123/__att/a1.png', 'a base without the trailing slash');
  assert.equal(attachmentUrl({ contentBase: ds.contentBase }, 'attachments/a1.png'), null, 'no attachmentBase (older daemon)');
  assert.equal(attachmentUrl(ds, 'attachments/notes.txt'), null);
  // an agent's SVG and HTML preview (served with their own restrictive CSPs on the content origin)
  assert.equal(attachmentUrl(ds, 'attachments/a7.svg'), 'http://127.0.0.1:4778/c/abc123/__att/a7.svg');
  assert.equal(attachmentUrl(ds, 'attachments/a8.html'), 'http://127.0.0.1:4778/c/abc123/__att/a8.html');
  assert.equal(attachmentUrl(ds, 'attachments/a8.js'), null);
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

test('panelWidthRange: the doc keeps 360 px; a window with no room for more still allows the panel its minimum', () => {
  assert.deepEqual(panelWidthRange(1400), { min: 280, max: 1040 });
  assert.deepEqual(panelWidthRange(640), { min: 280, max: 280 });
  assert.deepEqual(panelWidthRange(100), { min: 280, max: 280 });
});

test('plainBody: bold and list markers come off, other text stays', () => {
  assert.equal(plainBody('**Fix** this:\n- first\n  * second\n1. third\n2) fourth'), 'Fix this:\nfirst\nsecond\nthird\nfourth');
  assert.equal(plainBody('2 * 3 - 1 and -5'), '2 * 3 - 1 and -5');
  assert.equal(plainBody('** not bold ** 1.5'), '** not bold ** 1.5');
  assert.equal(plainBody(undefined), '');
});

// ------------------------------------------------------------------------------------- UI fix round (UA)

test('L7: applicablePlanned is every planned thread; one that also waits for the reviewer is in Your turn and the agent\'s list', () => {
  const planned = (/** @type {string} */ id) => thread(id, 'planned', [{ by: human, body: 'a', version: 1 }, { by: agent, body: 'will', version: 2, status: 'planned' }]);
  const ds = docState({
    doc: { ...docState().doc, head: 2 },
    // t8 first: the ids come out in id order whatever the order of the threads
    threads: [planned('t8'), planned('t3'), thread('t2', 'open', [{ by: human, body: 'a', version: 1 }])],
    // a reply not sent yet on t3: it waits for the reviewer too
    drafts: { schema: 1, items: [{ id: 'd1', kind: 'reply', thread: 't3', body: 'one more thing' }] },
  });
  assert.deepEqual(applicablePlanned(ds).map((t) => t.id), ['t3', 't8']);
  assert.deepEqual(plannedThreads(ds).map((t) => t.id), ['t3', 't8'], 'the earlier name: the same set');
  const ctx = { drafts: ds.drafts, version: 2 };
  const t3 = ds.threads[1];
  assert.equal(turnReason(t3, ctx), 'pending');
  assert.equal(threadMatches(t3, 'mine', ctx), true);
  assert.equal(threadMatches(t3, 'agent', ctx), true, 'Planned changes lists what Apply sends');
  assert.deepEqual(panelItems(ds, 'agent', 2).map((x) => x.id).sort(), ['t2', 't3', 't8']);
  assert.deepEqual(panelItems(ds, 'mine', 2).map((x) => x.id), ['t3']);
  // the counts are what each filter lists; Your turn is still the turn pill's count
  assert.deepEqual(filterCounts(ds, 2), { mine: 1, agent: 3, done: 0, all: 3 });
  assert.equal(filterCounts(ds, 2).mine, myTurn(ds, 2).count);
  // a resolved thread is never the agent's
  assert.equal(threadMatches(thread('t9', 'resolved', []), 'agent', ctx), false);
});

test('L9: panelItems keeps every thread with input open on its card (a reply box, a decision being typed)', () => {
  const ds = docState({
    threads: [thread('t1', 'open', [], { 1: anchor(1, 50) }), thread('t2', 'resolved', [], { 1: anchor(1, 5) }), thread('t3', 'open', [], { 1: anchor(1, 30) })],
  });
  assert.deepEqual(panelItems(ds, 'done', 1).map((x) => x.id), ['t2']);
  assert.deepEqual(panelItems(ds, 'done', 1, ['t1', 't3']).map((x) => x.id), ['t2', 't3', 't1']);
  assert.deepEqual(panelItems(ds, 'done', 1, [null, 't3', undefined, '']).map((x) => x.id), ['t2', 't3']);
  assert.deepEqual(panelItems(ds, 'done', 1, 't1').map((x) => x.id), ['t2', 't1'], 'one id still works');
});

test('V3: turnInfo reads "Apply N planned" when only planned changes wait; your turn still comes first', () => {
  const planned = thread('t3', 'planned', [{ by: human, body: 'a', version: 1 }, { by: agent, body: 'will', version: 2, status: 'planned' }]);
  const answered = thread('t1', 'answered', [{ by: human, body: 'q', version: 1 }, { by: agent, body: 'a', version: 2, status: 'answered' }]);
  let t = turnInfo(docState({ threads: [planned, { ...planned, id: 't8' }] }), 3);
  assert.deepEqual([t.kind, t.label, t.short, t.tone, t.planned], ['apply', 'Apply 2 planned', 'Apply 2', 'accent', 2]);
  assert.equal(t.presence.kind, 'none', 'the dot is still the presence');
  t = turnInfo(docState({ threads: [planned, answered] }), 3);
  assert.deepEqual([t.kind, t.label, t.planned], ['yours', 'Your turn · 1', 1]);
  t = turnInfo(docState({ threads: [answered] }), 3);
  assert.equal(t.planned, 0);
});

test('V2: approveWarnings says what an approval would leave pending: planned changes, threads for you, threads with the agent', () => {
  const asked = { by: human, body: 'a', version: 1 };
  const ds = docState({
    doc: { ...docState().doc, head: 2 },
    threads: [
      thread('t1', 'planned', [asked, { by: agent, body: 'will', version: 2, status: 'planned' }]),
      thread('t2', 'planned', [asked, { by: agent, body: 'will', version: 2, status: 'planned' }]),
      thread('t3', 'needs_input', [{ by: agent, body: 'which?', version: 2, status: 'needs_input' }]),
      thread('t4', 'addressed', [asked, { by: agent, body: 'done', version: 2, status: 'addressed' }]),
      thread('t5', 'declined', [asked, { by: agent, body: 'no', version: 2, status: 'declined' }]),
      thread('t6', 'open', [asked]),
      thread('t7', 'resolved', [asked]),
    ],
  });
  const keys = (/** @type {any[]} */ w) => w.map((x) => [x.key, x.count, x.label, x.ids]);
  // with "Mark answered threads done" (the default) the addressed t4 is not left waiting; the declined t5 is
  assert.deepEqual(keys(approveWarnings(ds, 2)), [
    ['planned', 2, "2 planned changes aren't in v2 yet", ['t1', 't2']],
    ['yours', 2, '2 threads still wait for you', ['t3', 't5']],
    ['agent', 1, '1 thread is still with Claude', ['t6']],
  ]);
  assert.deepEqual(keys(approveWarnings(ds, 2, { resolveAddressed: false }))[1], ['yours', 3, '3 threads still wait for you', ['t3', 't4', 't5']]);
  // singular wording; a reply in the review is not left waiting (it goes out with the approval)
  const one = docState({
    doc: { ...docState().doc, head: 2 },
    threads: [thread('t1', 'planned', [asked, { by: agent, body: 'will', version: 2, status: 'planned' }]), thread('t3', 'needs_input', [{ by: agent, body: 'q', version: 2, status: 'needs_input' }])],
    drafts: { schema: 1, items: [{ id: 'd1', kind: 'reply', thread: 't3', body: 'this one' }] },
  });
  assert.deepEqual(keys(approveWarnings(one, 2)), [['planned', 1, "1 planned change isn't in v2 yet", ['t1']]]);
  // nothing pending: no warning
  assert.deepEqual(approveWarnings(docState({ threads: [thread('t7', 'resolved', [asked])] }), 3), []);
  assert.deepEqual(approveWarnings(null, 3), []);
});

test('V9: agentSees says what the agent will see in plain words; the lines only in the tooltip', () => {
  const a = anchor(1, 10, { quote: { exact: 'Remove the legacy session store.', prefix: '', suffix: '' }, section: ['Spec', '1.1 Milestones'] });
  const preview = { label: 'text', lines: [25, 25], section: ['Spec', '1.1 Milestones'], text: 'Agent will see: L25 §1.1 Milestones "Remove the legacy session store."' };
  assert.deepEqual(agentSees(preview, a, 'claude'), {
    what: '“Remove the legacy session store.”', section: '§1.1 Milestones', title: 'Claude will see: L25 §1.1 Milestones “Remove the legacy session store.”',
  });
  // a picked table row: the engine's label; a section: no second §
  const row = { v: 1, kind: 'cell', scope: 'row', state: 'exact', src: { startLine: 30, endLine: 30 }, cell: { rowKey: 'refresh_token' }, section: ['Spec', '2 Tokens'] };
  assert.deepEqual(agentSees({ label: 'table row "refresh_token"', lines: [30, 30], section: ['Spec', '2 Tokens'] }, row, 'codex'),
    { what: 'table row "refresh_token"', section: '§2 Tokens', title: 'Codex will see: L30 §2 Tokens table row "refresh_token"' });
  const sec = { v: 1, kind: 'section', state: 'exact', src: { startLine: 5, endLine: 9 }, section: ['Spec', '3 Rollout'] };
  assert.equal(agentSees({ label: '§3 Rollout', lines: [5, 9] }, sec).section, '');
  assert.equal(agentSees({ label: '§3 Rollout', lines: [5, 9] }, sec).what, '§3 Rollout');
  // lines picked in Source: the lines are what it is about
  const src = { v: 1, kind: 'source', state: 'exact', src: { startLine: 51, endLine: 52 }, section: ['Spec', '1 Goals'] };
  assert.deepEqual(agentSees({ label: 'source lines', lines: [51, 52], section: ['Spec', '1 Goals'] }, src),
    { what: 'lines 51-52', section: '§1 Goals', title: 'Claude will see: L51-52 §1 Goals lines 51-52' });
  // a general comment, and a code review's file label (its lines are part of the label)
  assert.equal(agentSees({ label: 'GENERAL', text: 'Agent will see: GENERAL' }, { v: 1, kind: 'doc', state: 'exact' }).what, 'General comment');
  const code = { v: 1, kind: 'source', state: 'exact', src: { startLine: 3, endLine: 4 }, file: { path: 'src/a.js', side: 'new' } };
  assert.deepEqual(agentSees({ label: 'src/a.js:L3-4' }, code), { what: 'src/a.js:L3-4', section: '', title: 'Claude will see: src/a.js:L3-4' });
});
