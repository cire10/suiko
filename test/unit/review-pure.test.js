// @ts-check
// Pure building blocks of the review engine: suggestion location and Edit-tool splices (apply.js), attribution
// (BUILD_AMENDMENTS 4.3), the precise head->working mapper (workmap.js), thread-state rules (design 9.3), the
// packet size cap (design 9.3, 10,000 chars), decisions.md (export.js) and git auto-commit (design 5.5).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lineHunks } from '../../src/core/diff/index.js';
import { eolOf, findOccurrences, lineWindow, locateSuggestion, matchEol, replaceExact, spliceText } from '../../src/core/review/apply.js';
import { attribute, effectivePendingLines, parseOtherAt } from '../../src/core/review/attribution.js';
import { preciseMapper } from '../../src/core/review/workmap.js';
import { conversation, isActionable, whyOf } from '../../src/core/review/threadstate.js';
import { formatPacket } from '../../src/core/review/packet.js';
import { renderDecisionsMarkdown } from '../../src/core/review/export.js';
import { autoCommit, commitMessage } from '../../src/core/review/git.js';

describe('apply.js', () => {
  test('locateSuggestion: exact at the mapped offset, else nearest inside the anchor window only, else null', () => {
    const text = 'alpha beta gamma\nbeta delta\n';
    assert.deepEqual(locateSuggestion(text, 'beta', 6), { start: 6, end: 10, how: 'exact' });
    // no window: a displaced occurrence is never taken (not even the only one in the doc)
    assert.equal(locateSuggestion(text, 'gamma', 0), null);
    assert.deepEqual(locateSuggestion(text, 'gamma', 0, lineWindow(text, 0, 5)), { start: 11, end: 16, how: 'nearest' });
    assert.deepEqual(locateSuggestion(text, 'beta', 15, lineWindow(text, 17, 21)), { start: 17, end: 21, how: 'nearest' });
    // the same text in another line is outside the window
    assert.equal(locateSuggestion(text, 'delta', 3, lineWindow(text, 0, 5)), null);
    assert.equal(locateSuggestion(text, 'omega', 0, lineWindow(text, 0, text.length)), null);
    assert.deepEqual(lineWindow(text, 7, 7), { start: 0, end: 17 });
    assert.deepEqual(lineWindow(text, 7, 20), { start: 0, end: 28 });
  });

  test('eolOf / matchEol: inserted line breaks follow a CRLF file', () => {
    assert.equal(eolOf('a\r\nb\r\nc\n'), '\r\n');
    assert.equal(eolOf('a\nb\r\nc\n'), '\n');
    assert.equal(matchEol('x\ny\r\nz', '\r\n'), 'x\r\ny\r\nz');
    assert.equal(matchEol('x\ny', '\n'), 'x\ny');
    assert.equal(matchEol('x', '\r\n'), 'x');
  });

  test('findOccurrences counts non-overlapping hits', () => {
    assert.deepEqual(findOccurrences('aaaa', 'aa'), [0, 2]);
    assert.deepEqual(findOccurrences('abc', ''), []);
    assert.deepEqual(findOccurrences('a a a', 'a', 2), [0, 2]);
  });

  test('spliceText records old and new lines', () => {
    const s = spliceText('one\ntwo\nthree\n', 4, 7, 'TWO\nTWO-B');
    assert.equal(s.text, 'one\nTWO\nTWO-B\nthree\n');
    assert.deepEqual([s.oldLines, s.newLines], [[2, 2], [2, 3]]);
  });

  test('replaceExact: unique unless replaceAll; splice lines are re-based top-down', () => {
    const text = 'x\nfoo\ny\nfoo\nz\n';
    assert.deepEqual(replaceExact(text, 'foo', 'bar'), { ok: false, count: 2 });
    assert.deepEqual(replaceExact(text, 'nope', 'bar'), { ok: false, count: 0 });
    const r = replaceExact(text, 'foo', 'bar\nbaz', true);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.text, 'x\nbar\nbaz\ny\nbar\nbaz\nz\n');
    assert.deepEqual(r.splices.map((s) => [s.oldLines, s.newLines]), [[[2, 2], [2, 3]], [[5, 5], [5, 6]]]);
  });
});

describe('attribution', () => {
  const head = ['# T', '', 'alpha line', '', 'beta line', '', 'gamma line', '', 'delta line', ''].join('\n');

  test('tagged > hint > overlap > other / unlinked', () => {
    const working = head
      .replace('alpha line', 'alpha line edited') // L3: tagged (edit t1)
      .replace('beta line', 'beta line hinted') // L5: hint from t2's "at"
      .replace('gamma line', 'gamma changed') // L7: overlaps t3's anchor
      .replace('delta line', 'delta tweak'); // L9: explained by other
    const hunks = lineHunks(head, working);
    const g = head.indexOf('gamma line');
    const res = attribute({
      hunks,
      headSource: head,
      workingSource: working,
      pending: [{ via: 'edit', threads: ['t1'], oldLines: [3, 3], newLines: [3, 3] }],
      hints: [{ thread: 't2', at: 'L5' }, { thread: 't9', at: 'L5-x' }],
      threads: [{ id: 't3', start: g, end: g + 5 }],
      other: [{ at: 'L9', why: 'wording' }, { at: 'h42', why: 'nothing' }],
    });
    assert.deepEqual(res.hunks.map((h) => [h.id, h.threads, h.linkedBy, h.via, h.other]), [
      ['h1', ['t1'], 'tagged', 'edit', null],
      ['h2', ['t2'], 'hint', null, null],
      ['h3', ['t3'], 'overlap', null, null],
      ['h4', [], null, null, 'wording'],
    ]);
    assert.deepEqual(res.threadLinks, { t1: ['h1'], t2: ['h2'], t3: ['h3'] });
    assert.deepEqual(res.unusedOther, [{ at: 'h42', why: 'nothing', reason: 'matches no hunk' }]);
    assert.equal(res.badHints.length, 1);
    assert.equal(res.badHints[0].thread, 't9');
  });

  test('an untouched anchor next to a changed line is not linked by overlap', () => {
    const working = head.replace('gamma line', 'gamma line\nnew line after gamma');
    const hunks = lineHunks(head, working);
    const a = head.indexOf('alpha line');
    const res = attribute({ hunks, headSource: head, workingSource: working, threads: [{ id: 't1', start: a, end: a + 10 }] });
    assert.deepEqual(res.hunks.map((h) => h.linkedBy), [null]);
  });

  test('hunk stats count removed words and whole removed (non-blank) lines', () => {
    const working = head.replace('beta line\n\ngamma line\n\n', '');
    const res = attribute({ hunks: lineHunks(head, working), headSource: head, workingSource: working });
    assert.equal(res.hunks.length, 1);
    assert.deepEqual(res.hunks[0].stats, { removedWords: 4, insertedWords: 0, removedChars: 23, insertedChars: 0, wholeLinesRemoved: 2 });
  });

  test('parseOtherAt and effectivePendingLines', () => {
    assert.deepEqual(parseOtherAt('del:H6'), { hunk: 'h6', ranges: [] });
    assert.deepEqual(parseOtherAt('h2'), { hunk: 'h2', ranges: [] });
    assert.deepEqual(parseOtherAt('L12-14'), { hunk: null, ranges: [[12, 14]] });
    assert.equal(parseOtherAt('somewhere'), null);
    // an edit that adds 2 lines above an earlier edit shifts it down
    const eff = effectivePendingLines([
      { via: 'edit', threads: ['t1'], oldLines: [10, 10], newLines: [10, 10] },
      { via: 'apply', threads: ['t2'], oldLines: [3, 3], newLines: [3, 5] },
    ]);
    assert.deepEqual(eff.map((e) => e.newLines), [[12, 12], [3, 5]]);
  });
});

describe('workmap', () => {
  test('maps offsets exactly outside and inside hunks; touched() only for edited text', () => {
    const a = 'The quick brown fox.\nJumps over the dog.\n';
    const b = 'The quick red fox.\nJumps over the dog.\n';
    const m = preciseMapper(a, b);
    const fox = a.indexOf('fox');
    assert.equal(b.slice(m.map(fox), m.map(fox) + 3), 'fox', 'unchanged word inside a hunk maps exactly');
    const dog = a.indexOf('dog');
    assert.equal(m.map(dog), b.indexOf('dog'));
    assert.equal(m.touched(fox, fox + 3), false);
    assert.equal(m.touched(a.indexOf('brown'), a.indexOf('brown') + 5), true);
    assert.deepEqual(m.mapRange(fox, fox + 3), { start: b.indexOf('fox'), end: b.indexOf('fox') + 3 });
  });

  test('insertions at a range edge stay outside the range', () => {
    const a = 'aaa bbb ccc\n';
    const b = 'aaa XXX bbb YYY ccc\n';
    const m = preciseMapper(a, b);
    const s = a.indexOf('bbb');
    const r = m.mapRange(s, s + 3);
    assert.equal(b.slice(r.start, r.end), 'bbb');
  });
});

describe('thread state', () => {
  const human = (/** @type {string} */ body) => ({ by: { kind: 'human', name: 'Eric' }, body, at: '', version: 1 });
  const agent = (/** @type {string} */ body, /** @type {string} */ status) => ({ by: { kind: 'agent', name: 'claude' }, body, at: '', version: 1, status });
  /** @param {any} t */
  const T = (t) => /** @type {any} */ ({ id: 't1', review: 'rv1', comments: [], ...t });

  test('actionable and why', () => {
    const fresh = T({ status: 'open', comments: [human('fix')] });
    assert.equal(isActionable(fresh), true);
    assert.equal(whyOf(fresh, { deliveredBefore: () => false }), 'new');
    assert.equal(whyOf(fresh, { deliveredBefore: () => true }), 'open');
    const addressed = T({ status: 'addressed', comments: [human('fix'), agent('done', 'addressed')] });
    assert.equal(isActionable(addressed), false);
    const replied = T({ status: 'addressed', comments: [human('fix'), agent('done', 'addressed'), human('not quite')] });
    assert.equal(whyOf(replied, { deliveredBefore: () => true }), 'reply');
    const answered = T({ status: 'needs_input', comments: [human('fix'), agent('which?', 'needs_input'), human('A')] });
    assert.equal(whyOf(answered, { deliveredBefore: () => true }), 'answer');
    const reopened = T({ status: 'open', comments: [human('fix'), agent('done', 'addressed'), human('again')] });
    assert.equal(whyOf(reopened, { deliveredBefore: () => true, reopenedIn: new Set(['t1']) }), 'reopened');
    assert.equal(isActionable(T({ status: 'resolved', comments: [human('x')] })), false);
    assert.deepEqual(conversation(replied), { shown: replied.comments.slice(1), earlier: 1 });
  });
});

describe('packet size cap', () => {
  test('threads beyond the cap are listed one line each with a show command', () => {
    const threads = Array.from({ length: 40 }, (_, i) => ({
      id: `t${i + 1}`, why: 'new', type: 'comment', severity: 'normal', status: 'open', lines: [i + 1, i + 1],
      section: ['S'], sectionLabel: 'S', target: 'text', label: 'text', on: 'quote', src: `line ${i + 1}`, srcUnique: true,
      srcWindow: false, srcEditable: true, anchorState: 'exact', note: null, earlier: 0, suggestion: null, attachments: [], apply: null,
      comments: [{ by: 'Eric', kind: 'human', body: 'x'.repeat(500), at: '', version: 1, status: null, hunk: null }],
    }));
    const packet = /** @type {any} */ ({
      schema: 1, doc: 'd', path: 'd.md', title: 'D', head: 1, working: 'clean', firstPacket: false, agent: 'claude',
      reviews: [{ id: 'rv1', version: 1, verdict: 'changes_requested', body: '', by: 'Eric', at: '' }], verdict: 'changes_requested',
      final: null, threads, locks: [], decisions: [], drafts: null, resolvedThisRound: [],
      counts: { actionable: 40, new: 40, reopened: 0, reply: 0, answer: 0, open: 0, awaitingReviewer: 0, resolved: 0, resolvedThisRound: 0, outdated: 0, unresolved: 40, drafts: 0, undelivered: 1 },
      next: 'edits -> specreview revise d --replies - -> specreview wait d (background)',
    });
    const text = formatPacket(packet);
    const capped = text.match(/^\((\d+) more threads - packet size cap; run the commands to see them\)$/m);
    assert.ok(capped, text.slice(0, 300));
    const more = Number(capped[1]);
    assert.ok(more > 0 && more < 40);
    assert.match(text, /^\[t40\] comment · L40 · §S · specreview show d t40$/m);
    const beforeOverflow = text.slice(0, text.indexOf('(' + more + ' more threads'));
    assert.ok(beforeOverflow.length <= 10000, `${beforeOverflow.length} chars before the overflow list`);
    assert.match(text, /\nNEXT: edits -> specreview revise d --replies - -> specreview wait d \(background\)\n$/);
  });
});

describe('decisions.md', () => {
  test('lists decisions then other resolved threads', () => {
    const anchor = { v: 1, kind: 'text', state: 'exact', src: { text: 'rotated on every use', startLine: 5, endLine: 5 }, section: ['T', '3 Tokens'] };
    const doc = /** @type {any} */ ({ id: 'spec', title: 'T', path: 'docs/spec.md', head: 2, final: { version: 2, review: 'rv2', by: 'Eric', at: '2026-10-10T12:00:00.000Z' } });
    const threads = /** @type {any[]} */ ([
      {
        id: 't1', type: 'comment', severity: 'blocking', status: 'resolved', resolvedIn: 2, anchors: { 1: anchor },
        decision: { id: 'D1', text: '30 s grace window' }, changes: [{ version: 2, hunk: 'h1' }],
        comments: [
          { by: { kind: 'human', name: 'Eric' }, body: 'Use a grace window.', version: 1 },
          { by: { kind: 'agent', name: 'claude' }, body: 'Added it.', version: 2, status: 'addressed' },
        ],
      },
      { id: 't2', type: 'question', severity: 'normal', status: 'resolved', resolvedIn: 2, anchors: { 1: anchor }, decision: null, comments: [{ by: { kind: 'human', name: 'Eric' }, body: 'Why?', version: 1 }] },
      { id: 't3', type: 'comment', status: 'open', anchors: {}, comments: [] },
    ]);
    const md = renderDecisionsMarkdown({ doc, threads, reviews: /** @type {any} */ ([{}, {}]), versions: 2 });
    assert.match(md, /^# Decisions: T\n\n- Spec: `docs\/spec\.md`\n- Final version: v2 \(approved in rv2 by Eric on 2026-10-10\)\n- History: 2 versions, 2 reviews\n/);
    assert.match(md, /^### D1: 30 s grace window\n\n- Thread: t1 \(comment, blocking\) · §3 Tokens · resolved in v2\n- Context:\n\n {2}> rotated on every use\n/m);
    assert.match(md, /^- Resolution \(claude, v2, addressed\): Added it\.$/m);
    assert.match(md, /^- Changed in: v2 h1$/m);
    assert.match(md, /^## Resolved threads\n\n### t2: Why\?$/m);
    assert.doesNotMatch(md, /t3/);
  });
});

describe('git auto-commit', () => {
  test('commitMessage', () => {
    assert.equal(commitMessage('spec', 3, '  rv2:\ncaption ', ['t2', 't4']), 'spec(spec): v3 - rv2: caption [t2 t4]');
    assert.equal(commitMessage('spec', 1, '', []), 'spec(spec): v1');
  });

  test('off by default, skipped outside a repo, commits only the spec and its store data', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-git-')));
    try {
      fs.mkdirSync(path.join(root, 'docs'));
      fs.mkdirSync(path.join(root, '.specreview', 'docs', 'spec'), { recursive: true });
      fs.writeFileSync(path.join(root, 'docs', 'spec.md'), '# Spec\n');
      fs.writeFileSync(path.join(root, '.specreview', 'docs', 'spec', 'doc.json'), '{}\n');
      fs.writeFileSync(path.join(root, 'unrelated.txt'), 'keep me out\n');
      const base = { root, docId: 'spec', docPath: 'docs/spec.md', version: 1, summary: 'initial draft' };
      assert.deepEqual(await autoCommit({ ...base, config: { git: { autoCommit: false } } }), { commit: null, skipped: 'git.autoCommit is off' });
      assert.deepEqual(await autoCommit({ ...base, config: { git: { autoCommit: true } } }), { commit: null, skipped: 'not a git repository' });

      const git = (/** @type {string[]} */ ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
      git('init', '-q');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.invalid');
      git('config', 'commit.gpgsign', 'false');
      const r = await autoCommit({ ...base, config: { git: { autoCommit: true } }, threads: ['t1'] });
      assert.match(String(r.commit), /^[0-9a-f]{40}$/, JSON.stringify(r));
      assert.equal(git('log', '-1', '--format=%s').trim(), 'spec(spec): v1 - initial draft [t1]');
      assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), ['.specreview/docs/spec/doc.json', 'docs/spec.md']);
      assert.match(git('status', '--porcelain'), /\?\? unrelated\.txt/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
