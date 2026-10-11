// @ts-check
// The code packet grammar (packet.js formatPacket for kind 'code', design 4.10), driven only by Packet fields: the
// golden test/fixtures/packets/code-item-grammar.txt is the design's round-1 example, built here from a hand-made
// Packet (the code engine fills the same fields from a real repo). Also: FILE MISSING (with src> from head), whole
// file and binary items, the "not unique" fallback, whole-review (GENERAL) and orphaned items, code drafts, later
// packets without the PROTOCOL, the approved reply-only footer, and the code status lines.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { formatPacket, formatStatus, formatThreads } from '../../src/core/review/packet.js';
import { PACKET_FIXTURES } from '../helpers/engine.js';

const DOC = 'cr-feat-token-refresh';

/**
 * A PacketThread of a code doc.
 * @param {Record<string, any>} over
 */
function item(over) {
  return {
    id: 't1',
    why: 'new',
    type: 'comment',
    severity: 'normal',
    status: 'open',
    lines: null,
    section: [],
    sectionLabel: '',
    target: 'source',
    label: '',
    on: null,
    src: null,
    srcUnique: true,
    srcWindow: false,
    srcEditable: true,
    anchorState: 'exact',
    note: null,
    comments: [],
    earlier: 0,
    suggestion: null,
    attachments: [],
    attachmentKind: 'image',
    apply: null,
    file: null,
    fileFromCwd: null,
    side: 'new',
    was: null,
    fileState: 'ok',
    nowBetween: null,
    fileStatus: 'M',
    ...over,
  };
}

/** @param {string} body */
const eric = (body) => ({ by: 'Eric', kind: 'human', body, at: '2026-10-11T10:00:00.000Z', version: 1, status: null, hunk: null });

/**
 * The code Packet of the design example (round 1).
 * @param {Record<string, any>} [over]
 */
function packet(over = {}) {
  const threads = [
    item({
      id: 't2',
      type: 'suggestion',
      lines: [88, 88],
      file: 'src/auth/refresh.js',
      fileFromCwd: 'src/auth/refresh.js',
      src: '  const ttlSec = 30 * 24 * 3600;',
      suggestion: { mode: 'lines', file: 'src/auth/refresh.js', version: 1, old: 'const ttlSec = 30 * 24 * 3600;', new: 'const ttlSec = config.refreshTtlSec;', status: 'pending', appliedIn: null },
      apply: `specreview apply ${DOC} t2`,
      comments: [eric('Read it from config.')],
    }),
    item({
      id: 't1',
      severity: 'blocking',
      lines: [41, 44],
      file: 'src/auth/refresh.js',
      fileFromCwd: 'src/auth/refresh.js',
      src: ['if (stored.used) {', '  await revokeFamily(stored.family);', '  throw new TokenReuseError();', '}'].join('\n'),
      comments: [eric('Two tabs refreshing at once will trip this. Allow reuse within 30 s before revoking the family.')],
    }),
    item({
      id: 't3',
      type: 'question',
      lines: [12, 14],
      file: 'src/auth/store.js',
      fileFromCwd: 'src/auth/store.js',
      side: 'old',
      was: ['export function legacyLookup(id) {', '  return db.tokens.findOne({ id });', '}'],
      nowBetween: [11, 12],
      comments: [eric('scripts/migrate.js still calls legacyLookup. Was removing it intended?')],
    }),
    item({
      id: 't4',
      lines: [1, 1],
      file: 'test/refresh.test.js',
      fileFromCwd: 'test/refresh.test.js',
      fileStatus: 'A',
      src: "import { test } from 'node:test';",
      comments: [eric('Add a test for the grace window.')],
    }),
  ];
  return /** @type {any} */ ({
    schema: 1,
    doc: DOC,
    path: `code/${DOC}.diff`,
    kind: 'code',
    origin: 'diff',
    ref: DOC,
    root: '/Users/me/repo',
    file: null,
    pathFromCwd: null,
    code: { label: 'since-base origin/main, merge-base 1a2b3c4', baseSha: '1a2b3c4d5e6f'.padEnd(40, '0'), newSha: null, worktree: true, root: '/Users/me/repo' },
    basis: ['Repo root: /Users/me/repo (paths below are relative to it)', 'Line numbers = files in your working tree now (all identical to v1).'],
    title: 'feat/token-refresh',
    head: 1,
    working: 'clean',
    reviews: [{ id: 'rv1', version: 1, verdict: 'changes_requested', body: 'Mostly good. Fix the reuse race before merging.', by: 'Eric', at: '2026-10-11T10:00:00.000Z' }],
    verdict: 'changes_requested',
    final: null,
    threads,
    locks: [],
    decisions: [],
    drafts: null,
    counts: { actionable: 4, new: 4, reopened: 0, reply: 0, answer: 0, open: 0, awaitingReviewer: 0, resolved: 0, resolvedThisRound: 0, outdated: 0, unresolved: 4, drafts: 0, undelivered: 1 },
    resolvedThisRound: [],
    firstPacket: true,
    replyOnly: false,
    agent: 'claude',
    next: `edit the files -> specreview revise ${DOC} --replies - (records round v2 from your working tree) -> specreview wait ${DOC} (background)`,
    ...over,
  });
}

describe('code packet grammar', () => {
  test('golden: the design example (path:L.., apply verbatim, old side with was>, new file, Repo root, PROTOCOL)', () => {
    const golden = fs.readFileSync(path.join(PACKET_FIXTURES, 'code-item-grammar.txt'), 'utf8');
    assert.equal(formatPacket(packet()), golden);
  });

  test('FILE MISSING (src> from head), whole file, binary, not unique, GENERAL and orphaned items', () => {
    const text = formatPacket(
      packet({
        threads: [
          item({ id: 't5', lines: [3, 4], file: 'src/gone.js', fileState: 'missing', src: 'old line 3\nold line 4', comments: [eric('Why was this deleted?')] }),
          item({ id: 't6', file: 'assets/logo.png', fileState: 'binary', target: 'doc', comments: [eric('Use the new logo.')] }),
          item({ id: 't7', file: 'src/big.json', fileState: 'too-large', target: 'doc', comments: [eric('Generated?')] }),
          item({ id: 't8', lines: [42, 42], file: 'src/dup.js', src: 'return x;', srcUnique: false, comments: [eric('Return early.')] }),
          item({ id: 't9', file: null, side: null, fileState: null, target: 'doc', comments: [eric('Overall: split this PR.')] }),
          item({ id: 't10', file: 'src/moved.js', anchorState: 'orphaned', note: `(orphaned: reanchor with specreview reanchor ${DOC} t10 --file src/moved.js --lines A-B)`, comments: [eric('Here.')] }),
          item({ id: 't11', lines: [7, 9], file: 'src/x.js', anchorState: 'changed', note: '(outdated: text changed)', src: 'a\nb\nc', comments: [eric('Edited since.')] }),
        ],
      }),
    );
    assert.match(text, /^\[t5\] comment · src\/gone\.js:L3-4\n {2}FILE MISSING in your working tree \(restore it, or reply declined\/answered explaining the deletion\)\n {2}src> old line 3\n {2}src> old line 4\n/m);
    assert.match(text, /^\[t6\] comment · assets\/logo\.png \(whole file\)\n {2}\(binary file: nothing to quote\)\n {2}Eric: Use the new logo\.$/m);
    assert.match(text, /^\[t7\] comment · src\/big\.json \(whole file\)\n {2}\(file too large to quote: Read it\)$/m);
    assert.match(text, /^ {2}src> return x;\n {2}\(not unique in the file: Read around L42 before editing\)$/m);
    assert.match(text, /^\[t9\] comment · GENERAL\n {2}Eric: Overall: split this PR\.$/m);
    assert.match(text, /^\[t10\] comment · src\/moved\.js \(orphaned: reanchor with specreview reanchor cr-feat-token-refresh t10 --file src\/moved\.js --lines A-B\)$/m);
    assert.match(text, /^\[t11\] comment · src\/x\.js:L7-9 \(outdated: text changed\)$/m);
    assert.doesNotMatch(text, /LOCKED/, 'code reviews have no locks');
    assert.doesNotMatch(text, /§/, 'no sections in code items');
    assert.doesNotMatch(text, /^ {2}on: /m, 'no on: lines in code items');
  });

  test('a later packet has no PROTOCOL; drafts name their file; the header always carries the code label', () => {
    const text = formatPacket(
      packet({
        firstPacket: false,
        drafts: [{ id: 'd1', kind: 'thread', type: 'comment', severity: 'normal', version: 1, lines: [5, 6], file: 'src/a.js', side: 'new', label: 'src/a.js', on: null, body: 'Draft note', suggestion: null, attachments: [] }],
      }),
    );
    assert.doesNotMatch(text, /PROTOCOL/);
    assert.match(text, /^SPECREVIEW FEEDBACK · cr-feat-token-refresh \(code review: since-base origin\/main, merge-base 1a2b3c4\) · /);
    assert.match(text, /^ {2}\[d1\] comment · src\/a\.js:L5-6: Draft note$/m);
  });

  test('approved with a final version and threads to answer: reply only, no file changes', () => {
    const text = formatPacket(
      packet({
        verdict: 'approved',
        final: { version: 1, review: 'rv1', at: '2026-10-11T10:00:00.000Z', by: 'Eric' },
        reviews: [{ id: 'rv1', version: 1, verdict: 'approved', body: '', by: 'Eric', at: '2026-10-11T10:00:00.000Z' }],
        replyOnly: true,
        next: 'approved: answer each thread',
      }),
    );
    assert.match(text, /APPROVED with FINAL = v1: reply to each thread; do not change the reviewed files/);
    assert.doesNotMatch(text, /PROTOCOL/);
  });

  test('status and threads lines of a code doc', () => {
    const status = formatStatus({
      agent: 'claude',
      docs: [{ doc: DOC, path: `code/${DOC}.diff`, kind: 'code', origin: 'diff', ref: DOC, file: null, pathFromCwd: null, title: 't', head: 2, headAuthor: 'claude', headAt: null, state: 'in_review', final: null, counts: { open: 1, addressed: 0, answered: 0, declined: 0, needs_input: 0, resolved: 0, outdated: 0, actionable: 1 }, locks: [], lastReview: null, drafts: 0, undelivered: [], listening: [], working: 'dirty' }],
    });
    assert.match(status, /^cr-feat-token-refresh {2}\(code review\) {2}head v2/m);
    assert.match(status, /working tree: dirty/);
    const threads = formatThreads({ doc: DOC, filter: 'unresolved', threads: [{ id: 't1', status: 'open', actionable: true, type: 'comment', severity: 'normal', lines: [3, 4], file: 'src/a.js', side: 'old', target: 'source', anchorState: 'exact', sectionLabel: '', summary: 'x' }] });
    assert.match(threads, /^t1 {2}open\* {2}comment {2}src\/a\.js \(old side\):L3-4 {2}x$/m);
  });
});
