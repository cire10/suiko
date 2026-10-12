// @ts-check
// The code `at` grammar (src/core/util/code-at.js, design 2.11): every accepted form, quoted paths with commas,
// parsing from the right (a ':' inside a path), bare items continuing a file or taking the thread's file, hunk forms
// of other[].at, round-trip formatting, malformed input, and path resolution against a round's file list
// (repo-root-relative, cwd-relative, absolute, suffix; ambiguous -> candidates).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCodeAt, isCodeAt, isCodeOtherAt, parseCodeAt, parseCodeOtherAt, resolveCodePath } from '../../src/core/util/code-at.js';
import { parseLinesArg } from '../../src/core/util/lines-arg.js';

describe('parseCodeAt', () => {
  test('the documented forms', () => {
    assert.deepEqual(parseCodeAt('src/a.js:L12-14'), [{ file: 'src/a.js', startLine: 12, endLine: 14 }]);
    assert.deepEqual(parseCodeAt('src/a.js:L12'), [{ file: 'src/a.js', startLine: 12, endLine: 12 }]);
    assert.deepEqual(parseCodeAt('"a,b.js":L3'), [{ file: 'a,b.js', startLine: 3, endLine: 3 }]);
    assert.deepEqual(parseCodeAt('src/a.js:L12,src/b.js:L3-4'), [
      { file: 'src/a.js', startLine: 12, endLine: 12 },
      { file: 'src/b.js', startLine: 3, endLine: 4 },
    ]);
  });

  test('variants: L before the end, lower case, spaces, a bare item continuing the file', () => {
    assert.deepEqual(parseCodeAt('src/a.js:L12-L14'), [{ file: 'src/a.js', startLine: 12, endLine: 14 }]);
    assert.deepEqual(parseCodeAt('src/a.js:l3 - 4'), [{ file: 'src/a.js', startLine: 3, endLine: 4 }]);
    assert.deepEqual(parseCodeAt('src/a.js:L1, L20-22 ,src/b.js:L2'), [
      { file: 'src/a.js', startLine: 1, endLine: 1 },
      { file: 'src/a.js', startLine: 20, endLine: 22 },
      { file: 'src/b.js', startLine: 2, endLine: 2 },
    ]);
  });

  test('paths are parsed from the right: a ":" (or "L12") inside the path stays in it', () => {
    assert.deepEqual(parseCodeAt('docs/a:b.md:L5'), [{ file: 'docs/a:b.md', startLine: 5, endLine: 5 }]);
    assert.deepEqual(parseCodeAt('x:L1.js:L2-3'), [{ file: 'x:L1.js', startLine: 2, endLine: 3 }]);
    assert.deepEqual(parseCodeAt('/abs/repo/src/a.js:L7'), [{ file: '/abs/repo/src/a.js', startLine: 7, endLine: 7 }]);
    assert.deepEqual(parseCodeAt('"weird, name:L1.txt":L9,"b,c":L1'), [
      { file: 'weird, name:L1.txt', startLine: 9, endLine: 9 },
      { file: 'b,c', startLine: 1, endLine: 1 },
    ]);
  });

  test('a bare leading item needs a default file (the one file a thread anchors)', () => {
    assert.throws(() => parseCodeAt('L12'), RangeError);
    assert.deepEqual(parseCodeAt('L12-13,L20', { defaultFile: 'src/a.js' }), [
      { file: 'src/a.js', startLine: 12, endLine: 13 },
      { file: 'src/a.js', startLine: 20, endLine: 20 },
    ]);
  });

  test('malformed input is a RangeError', () => {
    for (const bad of ['', '   ', 'src/a.js', 'src/a,b.js:L3', 'a.js:L0', 'a.js:L5-3', '"a.js:L3', ':L3', 'a.js:L3,', 'a.js#h3', 'a.js:3']) {
      assert.throws(() => parseCodeAt(bad), RangeError, JSON.stringify(bad));
    }
    assert.throws(() => parseCodeAt(/** @type {any} */ (12)), RangeError);
  });

  test('spec forms stay with lines-arg; isCodeAt tells the two apart', () => {
    assert.deepEqual(parseLinesArg('L12-14'), [[12, 14]]);
    assert.equal(isCodeAt('L12-14'), false);
    assert.equal(isCodeAt('src/a.js:L12-14'), true);
    assert.throws(() => parseLinesArg('src/a.js:L12'), RangeError);
  });

  test('formatCodeAt round-trips, quoting paths with commas', () => {
    for (const s of ['src/a.js:L12-14', 'src/a.js:L12-14,L20,"a,b.js":L3', 'x:y.js:L1,src/b.js:L3-4']) {
      assert.equal(formatCodeAt(parseCodeAt(s)), s);
    }
    assert.equal(formatCodeAt(parseCodeAt('src/a.js:L12-L14, L20')), 'src/a.js:L12-14,L20');
  });
});

describe('parseCodeOtherAt', () => {
  test('hunks, deletion hunks and line locations', () => {
    assert.deepEqual(parseCodeOtherAt('src/a.js#h3'), { file: 'src/a.js', hunk: 'h3', del: false });
    assert.deepEqual(parseCodeOtherAt('del:src/a.js#h3'), { file: 'src/a.js', hunk: 'h3', del: true });
    assert.deepEqual(parseCodeOtherAt('"a,b.js"#H2'), { file: 'a,b.js', hunk: 'h2', del: false });
    assert.deepEqual(parseCodeOtherAt('a:b.js#h1'), { file: 'a:b.js', hunk: 'h1', del: false });
    assert.deepEqual(parseCodeOtherAt('src/index.js:L3'), { file: 'src/index.js', lines: [[3, 3]] });
    assert.deepEqual(parseCodeOtherAt('src/index.js:L3-4,L9'), { file: 'src/index.js', lines: [[3, 4], [9, 9]] });
  });

  test('refusals: del: without a hunk, several files, bare forms', () => {
    for (const bad of ['del:src/a.js:L3', 'src/a.js:L1,src/b.js:L2', 'h3', 'del:h3', 'L3', '#h3', '']) {
      assert.throws(() => parseCodeOtherAt(bad), RangeError, JSON.stringify(bad));
    }
    assert.equal(isCodeOtherAt('del:src/a.js#h3'), true);
    assert.equal(isCodeOtherAt('del:h6'), false);
  });
});

describe('resolveCodePath', () => {
  const files = ['a.js', 'lib/refresh.js', 'src/a.js', 'src/auth/refresh.js', 'test/a.js'];

  test('repo-root-relative, ./ prefix, cwd-relative and absolute paths', () => {
    assert.deepEqual(resolveCodePath('src/a.js', files), { file: 'src/a.js', candidates: ['src/a.js'] });
    assert.deepEqual(resolveCodePath('./src/a.js', files), { file: 'src/a.js', candidates: ['src/a.js'] });
    assert.equal(resolveCodePath('auth/refresh.js', files, { root: '/r', cwd: '/r/src' }).file, 'src/auth/refresh.js');
    assert.equal(resolveCodePath('/r/test/a.js', files, { root: '/r' }).file, 'test/a.js');
    assert.equal(resolveCodePath('/elsewhere/a.js', files, { root: '/r' }).file, null);
  });

  test('a unique suffix matches; an ambiguous path lists its candidates', () => {
    assert.equal(resolveCodePath('auth/refresh.js', files).file, 'src/auth/refresh.js');
    assert.deepEqual(resolveCodePath('refresh.js', files), { file: null, candidates: ['lib/refresh.js', 'src/auth/refresh.js'] });
    // root-relative 'a.js' and cwd-relative src/a.js both exist: ambiguous
    assert.deepEqual(resolveCodePath('a.js', files, { root: '/r', cwd: '/r/src' }), { file: null, candidates: ['a.js', 'src/a.js'] });
    assert.deepEqual(resolveCodePath('missing.js', files), { file: null, candidates: [] });
  });
});
