// @ts-check
// Unit tests for src/core/util/*: hashing, paths, clock, line-range arguments, logger, stable reads and codec.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-util-')));
process.env.SPECREVIEW_HOME = path.join(TMP, 'home');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { sha256, hmacSha256, shortHash, randomHex } = await import('../../src/core/util/hash.js');
const { slugify, toPosix, isDeniedPath, realpathWithin, extOf, formatOfPath, normalizeExt, isWithin } = await import(
  '../../src/core/util/paths.js'
);
const { now, nowIso, setClock, toIso, parseIso } = await import('../../src/core/util/time.js');
const { parseLinesArg, formatLines, formatRange } = await import('../../src/core/util/lines-arg.js');
const { createLogger, configureLogger, levelFor } = await import('../../src/core/util/log.js');
const { stableRead, decodeText, encodeText, countLines } = await import('../../src/core/util/stable-read.js');
const { pidAlive } = await import('../../src/core/util/proc.js');

describe('hash', () => {
  test('sha256 matches known vectors for strings and buffers', () => {
    assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(sha256(Buffer.from('abc')), sha256('abc'));
  });
  test('hmacSha256 matches RFC 4231 test case 2', () => {
    assert.equal(
      hmacSha256('Jefe', 'what do ya want for nothing?'),
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });
  test('shortHash and randomHex', () => {
    assert.equal(shortHash('abc'), 'ba7816bf');
    assert.match(randomHex(4), /^[0-9a-f]{8}$/);
    assert.notEqual(randomHex(), randomHex());
  });
});

describe('paths', () => {
  test('slugify', () => {
    assert.equal(slugify('Token Service.md'), 'token-service');
    assert.equal(slugify('docs/specs/token_service.html'), 'token-service');
    assert.equal(slugify('Ünïcödé Spéc.md'), 'unicode-spec');
    assert.equal(slugify('v1.2 spec.md'), 'v1-2-spec');
    assert.equal(slugify('___.md'), 'doc');
    assert.equal(slugify(''), 'doc');
    assert.equal(slugify('README'), 'readme');
    assert.ok(slugify('x'.repeat(200) + '.md').length <= 64);
    assert.doesNotMatch(slugify('-_-lead.md'), /^[-_]/);
  });
  test('toPosix', () => {
    assert.equal(toPosix('a\\b\\c.md'), 'a/b/c.md');
    assert.equal(toPosix(['a', 'b'].join(path.sep)), 'a/b');
  });
  test('isDeniedPath', () => {
    for (const p of ['.git/config', 'a/.env', '../x.png', 'a/./b', 'certs/server.pem', 'k/private.KEY', 'x.p12',
      'home/id_rsa', 'id_rsa.pub', 'id_ed25519', '', 'a\0b', '/.specreview/config.json']) {
      assert.equal(isDeniedPath(p), true, p);
    }
    for (const p of ['img/arch.png', 'docs/specs/token-service.md', '/img/a.png', 'a//b.css', 'keys.md', 'monkey.png']) {
      assert.equal(isDeniedPath(p), false, p);
    }
  });
  test('realpathWithin rejects lexical and symlink escapes', () => {
    const root = path.join(TMP, 'rw-root');
    const outside = path.join(TMP, 'rw-outside');
    fs.mkdirSync(path.join(root, 'img'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(root, 'img', 'a.png'), 'x');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    fs.symlinkSync(path.join(root, 'img', 'a.png'), path.join(root, 'inner-link.png'));
    assert.equal(realpathWithin(root, 'img/a.png'), path.join(root, 'img', 'a.png'));
    assert.equal(realpathWithin(root, 'inner-link.png'), path.join(root, 'img', 'a.png'));
    assert.equal(realpathWithin(root, 'link.txt'), null);
    assert.equal(realpathWithin(root, '../rw-outside/secret.txt'), null);
    assert.equal(realpathWithin(root, path.join(outside, 'secret.txt')), null);
    assert.equal(realpathWithin(root, 'missing.png'), null);
  });
  test('isWithin, extOf, formatOfPath, normalizeExt', () => {
    assert.equal(isWithin('/a/b', '/a/b'), true);
    assert.equal(isWithin('/a/b', '/a/b/c'), true);
    assert.equal(isWithin('/a/b', '/a/bc'), false);
    assert.equal(isWithin('/a/b', '/a'), false);
    assert.equal(extOf('a/B.MD'), 'md');
    assert.equal(extOf('Makefile'), '');
    assert.equal(extOf('.env'), '');
    assert.equal(formatOfPath('x.markdown'), 'markdown');
    assert.equal(formatOfPath('x.HTM'), 'html');
    assert.equal(formatOfPath('x.txt'), null);
    assert.equal(normalizeExt('.PNG'), 'png');
    assert.equal(normalizeExt('../x'), '');
    assert.equal(normalizeExt(undefined), '');
  });
});

describe('time', () => {
  test('injectable clock and restore', () => {
    const restore = setClock('2026-10-10T13:55:02.000Z');
    try {
      assert.equal(nowIso(), '2026-10-10T13:55:02.000Z');
      assert.equal(now(), Date.parse('2026-10-10T13:55:02Z'));
      const inner = setClock(() => 0);
      assert.equal(nowIso(), '1970-01-01T00:00:00.000Z');
      inner();
      assert.equal(nowIso(), '2026-10-10T13:55:02.000Z');
    } finally {
      restore();
    }
    assert.ok(Math.abs(now() - Date.now()) < 1000);
    assert.throws(() => setClock('not a date'), TypeError);
  });
  test('SPECREVIEW_NOW pins the clock when no clock is installed', () => {
    process.env.SPECREVIEW_NOW = '2030-01-02T03:04:05Z';
    try {
      assert.equal(nowIso(), '2030-01-02T03:04:05.000Z');
    } finally {
      delete process.env.SPECREVIEW_NOW;
    }
  });
  test('toIso / parseIso', () => {
    assert.equal(toIso(0), '1970-01-01T00:00:00.000Z');
    assert.equal(parseIso('1970-01-01T00:00:01Z'), 1000);
    assert.ok(Number.isNaN(parseIso(undefined)));
  });
});

describe('lines-arg', () => {
  test('parses ranges and singles', () => {
    assert.deepEqual(parseLinesArg('L42-46,L90'), [[42, 46], [90, 90]]);
    assert.deepEqual(parseLinesArg('42-46'), [[42, 46]]);
    assert.deepEqual(parseLinesArg(' l7 , L8 - L9 '), [[7, 7], [8, 9]]);
    assert.deepEqual(parseLinesArg(12), [[12, 12]]);
  });
  test('rejects malformed input', () => {
    for (const bad of ['', 'L0', 'L5-3', 'Lx', 'L1-', '1,,2', 'L1-2-3']) {
      assert.throws(() => parseLinesArg(bad), RangeError, bad);
    }
  });
  test('formats', () => {
    assert.equal(formatLines([[42, 46], [90, 90]]), 'L42-46,L90');
    assert.equal(formatLines([42, 46]), 'L42-46');
    assert.equal(formatLines([]), '');
    assert.equal(formatRange([7, 7]), 'L7');
  });
});

describe('log', () => {
  test('levels, scopes and sink', () => {
    /** @type {string[]} */
    const lines = [];
    configureLogger({ sink: (l) => lines.push(l), level: 'info' });
    try {
      const log = createLogger('store');
      log.debug('hidden');
      log.info('shown', { a: 1 });
      log.error('boom', new Error('bad'));
      assert.equal(lines.length, 2);
      assert.equal(lines[0], 'specreview info [store] shown {"a":1}');
      assert.match(lines[1], /^specreview error \[store\] boom Error: bad$/);
      assert.equal(log.child('x').enabled('info'), true);
    } finally {
      configureLogger({ sink: null, level: null });
    }
  });
  test('SPECREVIEW_DEBUG selects scopes', () => {
    process.env.SPECREVIEW_DEBUG = 'lock';
    try {
      assert.equal(levelFor('lock'), 'debug');
      assert.equal(levelFor('lock.refresh'), 'debug');
      assert.equal(levelFor('store'), 'warn');
      process.env.SPECREVIEW_DEBUG = '1';
      assert.equal(levelFor('store'), 'debug');
      process.env.SPECREVIEW_DEBUG = '0';
      assert.equal(levelFor('store'), 'warn');
    } finally {
      delete process.env.SPECREVIEW_DEBUG;
    }
  });
});

describe('stable-read and codec', () => {
  test('decodes BOMs, keeps CRLF, round-trips encodings', () => {
    const cases = /** @type {const} */ (['utf8', 'utf8-bom', 'utf16le', 'utf16be']);
    const text = '# Title\r\nline two — ünïcode 🚀\n';
    for (const enc of cases) {
      const bytes = encodeText(text, enc);
      const back = decodeText(bytes);
      assert.equal(back.text, text, enc);
      assert.equal(back.encoding, enc);
      assert.deepEqual(encodeText(back.text, back.encoding), bytes, enc);
    }
    assert.equal(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x61])).text, 'a');
  });
  test('stableRead returns bytes, text, hash, mode', async () => {
    const file = path.join(TMP, 'spec.md');
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\n')]));
    fs.chmodSync(file, 0o640);
    const r = await stableRead(file);
    assert.equal(r.text, 'a\r\nb\n');
    assert.equal(r.encoding, 'utf8-bom');
    assert.equal(r.sha256, sha256(fs.readFileSync(file)));
    assert.equal(r.mode, 0o640);
    assert.equal(r.size, 8);
    assert.equal(r.stable, true);
    await assert.rejects(stableRead(path.join(TMP, 'nope.md')), { code: 'ENOENT' });
  });
  test('stableRead retries while the file is being rewritten', async () => {
    const file = path.join(TMP, 'busy.md');
    fs.writeFileSync(file, 'v0\n');
    let n = 0;
    const timer = setInterval(() => fs.writeFileSync(file, `v${++n}\n`.repeat(n % 5 + 1)), 1);
    try {
      const r = await stableRead(file, { retries: 50, delayMs: 2 });
      assert.equal(r.size, r.buf.length);
      assert.equal(r.sha256, sha256(r.buf));
    } finally {
      clearInterval(timer);
    }
  });
  test('countLines', () => {
    assert.equal(countLines(''), 0);
    assert.equal(countLines('a'), 1);
    assert.equal(countLines('a\n'), 1);
    assert.equal(countLines('a\r\nb'), 2);
    assert.equal(countLines('\n\n'), 2);
  });
});

test('pidAlive', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(2 ** 22 + 12345), false);
});
