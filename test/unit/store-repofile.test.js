// @ts-check
// Store#readRepoFile / Store#writeRepoFile (design 2.8): repo files read and written for code reviews. Never through
// a symlink (the link text, never the target bytes), never inside .git / .specreview (any case, any depth, a .git
// file of a worktree included), never through a symlinked parent directory; the CAS write keeps encoding, line
// endings and mode, refuses symlinks and files outside the round's list, and conflicts on a sha mismatch.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ConflictError, NotFoundError, RefusedError, UsageError } from '../../src/core/store/errors.js';
import { sha256 } from '../../src/core/util/hash.js';
import { engineCtx, makeWorkspace } from '../helpers/engine.js';

/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
beforeEach(async () => {
  ws = await makeWorkspace({ files: [] });
});
afterEach(async () => {
  await ws.cleanup();
});

/**
 * @param {string} rel
 * @param {string | Buffer} data
 */
function put(rel, data) {
  const abs = path.join(ws.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  return abs;
}

describe('readRepoFile', () => {
  test('reads a regular file: bytes, text, sha256 and mode; null when missing', async () => {
    const ctx = await engineCtx(ws.root);
    const abs = put('src/a.js', 'export const a = 1;\n');
    fs.chmodSync(abs, 0o755);
    const r = await ctx.store.readRepoFile('src/a.js');
    assert.ok(r && r.kind === 'file');
    assert.equal(r.text, 'export const a = 1;\n');
    assert.equal(r.sha256, sha256(Buffer.from('export const a = 1;\n')));
    assert.equal(r.mode, 0o755);
    assert.equal(await ctx.store.readRepoFile('src/missing.js'), null);
    assert.equal(await ctx.store.readRepoFile('nodir/missing.js'), null);
    assert.deepEqual(await ctx.store.readRepoFile('src'), { kind: 'other' });
  });

  test('a symlink returns its link text, never the target bytes', async () => {
    const ctx = await engineCtx(ws.root);
    const outside = path.join(path.dirname(ws.root), 'outside.txt');
    fs.writeFileSync(outside, 'SECRET');
    fs.symlinkSync('../outside.txt', path.join(ws.root, 'link.txt'));
    put('src/real.js', 'x');
    fs.symlinkSync('real.js', path.join(ws.root, 'src', 'inside.js'));
    assert.deepEqual(await ctx.store.readRepoFile('link.txt'), { kind: 'symlink', target: '../outside.txt' });
    assert.deepEqual(await ctx.store.readRepoFile('src/inside.js'), { kind: 'symlink', target: 'real.js' });
  });

  test('refuses a symlinked parent dir, .git and .specreview in any case or depth, and non-plain paths', async () => {
    const ctx = await engineCtx(ws.root);
    const outsideDir = path.join(path.dirname(ws.root), 'outside-dir');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'x.js'), 'SECRET');
    fs.symlinkSync(outsideDir, path.join(ws.root, 'linked'));
    put('.git/config', '[core]');
    put('sub/.git', 'gitdir: /elsewhere');
    fs.mkdirSync(path.join(ws.root, 'gitlink'));
    fs.symlinkSync(path.join(ws.root, '.git'), path.join(ws.root, 'gitlink', 'g'));
    for (const rel of ['linked/x.js', '.git/config', '.GIT/config', 'sub/.git', 'sub/.Git/HEAD', '.specreview/config.json', 'a/.SpecReview/x', 'gitlink/g/config']) {
      await assert.rejects(ctx.store.readRepoFile(rel), RefusedError, rel);
    }
    for (const rel of ['../ws2/a.js', 'src/../../a.js', '/etc/passwd', 'src//a.js', './a.js', 'src/']) {
      await assert.rejects(ctx.store.readRepoFile(rel), RefusedError, rel);
    }
    for (const rel of ['', 'a\0b', 'src\\a.js']) {
      await assert.rejects(ctx.store.readRepoFile(rel), UsageError, JSON.stringify(rel));
    }
  });
});

describe('writeRepoFile', () => {
  test('compare-and-swap write; a sha mismatch is a conflict and leaves the file alone', async () => {
    const ctx = await engineCtx(ws.root);
    put('src/a.js', 'one\n');
    const r = /** @type {any} */ (await ctx.store.readRepoFile('src/a.js'));
    const out = await ctx.store.writeRepoFile('src/a.js', 'two\n', { expectSha256: r.sha256, allowed: ['src/a.js'] });
    assert.equal(fs.readFileSync(path.join(ws.root, 'src/a.js'), 'utf8'), 'two\n');
    assert.equal(out.sha256, sha256(Buffer.from('two\n')));
    assert.equal(out.bytes, 4);
    await assert.rejects(ctx.store.writeRepoFile('src/a.js', 'three\n', { expectSha256: r.sha256, allowed: ['src/a.js'] }), ConflictError);
    assert.equal(fs.readFileSync(path.join(ws.root, 'src/a.js'), 'utf8'), 'two\n');
    // a 'sha256:' blob-style prefix is accepted
    await ctx.store.writeRepoFile('src/a.js', 'four\n', { expectSha256: `sha256:${out.sha256}`, allowed: new Set(['src/a.js']) });
    assert.equal(fs.readFileSync(path.join(ws.root, 'src/a.js'), 'utf8'), 'four\n');
  });

  test('keeps line endings as given, the BOM / encoding and the file mode', async () => {
    const ctx = await engineCtx(ws.root);
    const abs = put('win.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n')]));
    fs.chmodSync(abs, 0o750);
    const r = /** @type {any} */ (await ctx.store.readRepoFile('win.txt'));
    assert.equal(r.text, 'a\r\nb\r\n');
    await ctx.store.writeRepoFile('win.txt', 'a\r\nB\r\n', { expectSha256: r.sha256, allowed: ['win.txt'] });
    const buf = fs.readFileSync(abs);
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM kept');
    assert.equal(buf.subarray(3).toString('utf8'), 'a\r\nB\r\n', 'CRLF kept');
    assert.equal(fs.statSync(abs).mode & 0o7777, 0o750);
  });

  test('refuses files outside the allowed list, symlinks, internal paths; NotFound when missing', async () => {
    const ctx = await engineCtx(ws.root);
    put('src/a.js', 'x');
    put('src/real.js', 'y');
    fs.symlinkSync('real.js', path.join(ws.root, 'src', 'link.js'));
    put('.git/config', '[core]');
    const sha = sha256(Buffer.from('x'));
    await assert.rejects(ctx.store.writeRepoFile('src/a.js', 'z', { expectSha256: sha, allowed: ['src/b.js'] }), RefusedError);
    await assert.rejects(ctx.store.writeRepoFile('src/link.js', 'z', { expectSha256: sha256(Buffer.from('y')), allowed: ['src/link.js'] }), RefusedError);
    assert.equal(fs.readFileSync(path.join(ws.root, 'src/real.js'), 'utf8'), 'y', 'the symlink target is untouched');
    assert.equal(fs.lstatSync(path.join(ws.root, 'src/link.js')).isSymbolicLink(), true);
    await assert.rejects(ctx.store.writeRepoFile('.git/config', 'z', { expectSha256: sha256(Buffer.from('[core]')), allowed: ['.git/config'] }), RefusedError);
    await assert.rejects(ctx.store.writeRepoFile('src/gone.js', 'z', { expectSha256: sha, allowed: ['src/gone.js'] }), NotFoundError);
    await assert.rejects(ctx.store.writeRepoFile('src/a.js', 'z', /** @type {any} */ ({ allowed: ['src/a.js'] })), UsageError);
    await assert.rejects(ctx.store.writeRepoFile('src/a.js', 'z', /** @type {any} */ ({ expectSha256: sha })), UsageError);
    assert.equal(fs.readFileSync(path.join(ws.root, 'src/a.js'), 'utf8'), 'x');
  });

  test('refuses to re-encode a file that does not decode losslessly', async () => {
    const ctx = await engineCtx(ws.root);
    put('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const r = /** @type {any} */ (await ctx.store.readRepoFile('latin1.txt'));
    await assert.rejects(ctx.store.writeRepoFile('latin1.txt', 'cafe\n', { expectSha256: r.sha256, allowed: ['latin1.txt'] }), RefusedError);
  });
});
