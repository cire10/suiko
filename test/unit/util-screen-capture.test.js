// @ts-check
// Unit tests for src/core/util/screen-capture.js (screen snips). The real macOS picker is NEVER run: every capture
// goes through SPECREVIEW_SCREENCAPTURE = the fake command of test/fixtures/snip/capture.js, which records its
// arguments and, by mode, writes a PNG to its last argument (ok / big), writes nothing and exits 1 or 0 (Esc),
// never exits (hang: killed by the timeout or an abort signal), or writes bytes that are not an image (garbage).
// The sips paths (downscale, JPEG conversion) only run against the real sips, which is non-interactive.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-screencap-')));
process.env.SPECREVIEW_HOME = path.join(TMP, 'home');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { captureScreenRegion, imageSize, imageMime, SCREENCAPTURE } = await import('../../src/core/util/screen-capture.js');
const { SNIP } = await import('../../src/shared/protocol.js');
const { createFakeCapture, makePng } = await import('../fixtures/snip/capture.js');

const SIPS = ['/usr/bin/sips', '/usr/sbin/sips'].find((p) => fs.existsSync(p)) ?? null;
const fake = createFakeCapture(path.join(TMP, 'fake'));

/** Temp snip directories in os.tmpdir(). */
function leftovers() {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('specreview-snip-'));
}

describe('captureScreenRegion with a fake picker', () => {
  test('success: runs <cmd> -i -x <tmp png>, returns the PNG and its size, removes the temp file', async () => {
    const before = new Set(leftovers());
    const env = { ...process.env, SPECREVIEW_SCREENCAPTURE: fake.command('ok'), FAKE_MARK: 'passed-through' };
    const shot = await captureScreenRegion({ env });
    assert.ok(shot);
    assert.deepEqual(shot.png, fake.small);
    assert.equal(shot.width, 40);
    assert.equal(shot.height, 30);
    const call = fake.calls().at(-1);
    assert.equal(call?.mode, 'ok');
    assert.deepEqual(call?.args.slice(0, 2), ['-i', '-x']);
    const out = /** @type {string} */ (call?.args[2]);
    const tmp = [os.tmpdir(), fs.realpathSync(os.tmpdir())];
    assert.ok(tmp.some((t) => out.startsWith(t)), `temp file ${out} is in os.tmpdir()`);
    assert.match(out, /\.png$/);
    assert.equal(call?.mark, 'passed-through', 'the env is passed to the capture command');
    assert.equal(fs.existsSync(out), false, 'temp file removed');
    assert.deepEqual(leftovers().filter((n) => !before.has(n)), [], 'temp dir removed');
  });

  test('cancel: no file written (exit 1 or exit 0) -> null', async () => {
    assert.equal(await captureScreenRegion({ env: { SPECREVIEW_SCREENCAPTURE: fake.command('cancel') } }), null);
    assert.equal(await captureScreenRegion({ env: { SPECREVIEW_SCREENCAPTURE: fake.command('cancel0') } }), null);
  });

  test('a failing picker (no file, non-zero exit, stderr) is reported, not passed off as a cancel', async () => {
    const script = path.join(TMP, 'failing-capture.sh');
    fs.writeFileSync(script, '#!/bin/sh\necho "could not create image from display" >&2\nexit 1\n', { mode: 0o755 });
    await assert.rejects(captureScreenRegion({ env: { SPECREVIEW_SCREENCAPTURE: script } }), (/** @type {any} */ err) => {
      assert.equal(err.code, 'capture_failed');
      assert.match(err.message, /could not create image from display/);
      assert.match(err.message, /Screen Recording/);
      return true;
    });
  });

  test('timeout: the picker is killed and the capture is null', async () => {
    const t0 = Date.now();
    const shot = await captureScreenRegion({ env: { SPECREVIEW_SCREENCAPTURE: fake.command('hang') }, timeoutMs: 300 });
    assert.equal(shot, null);
    assert.ok(Date.now() - t0 < 5000, 'returned soon after the timeout');
  });

  test('abort signal: the picker is killed (or never started) and the capture is null', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    assert.equal(await captureScreenRegion({ env: { SPECREVIEW_SCREENCAPTURE: fake.command('hang') }, signal: ac.signal }), null);
    const n = fake.calls().length;
    assert.equal(await captureScreenRegion({ env: { SPECREVIEW_SCREENCAPTURE: fake.command('ok') }, signal: AbortSignal.abort() }), null);
    assert.equal(fake.calls().length, n, 'an already aborted capture does not start the picker');
  });

  test('oversize: no downscale under SPECREVIEW_SCREENCAPTURE (sips skipped)', async () => {
    const shot = await captureScreenRegion({ env: { SPECREVIEW_SCREENCAPTURE: fake.command('big') } });
    assert.ok(shot);
    assert.equal(shot.width, 2600, 'returned as captured');
    assert.ok(shot.width > SNIP.maxScreenPx);
    assert.deepEqual(shot.png, fake.big);
  });

  test('bytes that are not an image are an error (capture_failed)', async () => {
    await assert.rejects(captureScreenRegion({ env: { SPECREVIEW_SCREENCAPTURE: fake.command('garbage') } }), (err) => {
      assert.equal(/** @type {any} */ (err).code, 'capture_failed');
      return true;
    });
  });
});

describe('unsupported', () => {
  test('a capture command that does not exist -> code unsupported, exit 1', async () => {
    await assert.rejects(captureScreenRegion({ env: { SPECREVIEW_SCREENCAPTURE: path.join(TMP, 'no-such-command') } }), (err) => {
      const e = /** @type {any} */ (err);
      assert.equal(e.code, 'unsupported');
      assert.equal(e.exit, 1);
      assert.match(e.message, /no-such-command/);
      return true;
    });
  });
  test('a capture command that cannot be run -> unsupported', async () => {
    const file = path.join(TMP, 'not-executable.sh');
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    await assert.rejects(captureScreenRegion({ env: { SPECREVIEW_SCREENCAPTURE: file } }), (err) => {
      assert.equal(/** @type {any} */ (err).code, 'unsupported');
      return true;
    });
  });
  test('not macOS and no override -> unsupported (the picker is never run)', async () => {
    await assert.rejects(captureScreenRegion({ env: {}, platform: 'linux' }), (err) => {
      const e = /** @type {any} */ (err);
      assert.equal(e.code, 'unsupported');
      assert.match(e.message, /macOS/);
      return true;
    });
  });
  test('the default command is the macOS one', () => {
    assert.equal(SCREENCAPTURE, '/usr/sbin/screencapture');
  });
});

describe('sips post-processing (real sips, non-interactive)', { skip: SIPS ? false : 'sips is not installed' }, () => {
  test('a capture larger than maxPx is resampled to maxPx on its longest side', async () => {
    const shot = await captureScreenRegion({ env: { SPECREVIEW_SCREENCAPTURE: fake.command('big') }, sips: SIPS, maxPx: 1000 });
    assert.ok(shot);
    assert.equal(shot.width, 1000);
    assert.ok(shot.height >= 15 && shot.height <= 16, `aspect kept: ${shot.height}`);
    assert.equal(imageSize(shot.png)?.width, 1000);
  });
  test('a capture larger than maxBytes is converted to JPEG', async () => {
    const shot = await captureScreenRegion({ env: { SPECREVIEW_SCREENCAPTURE: fake.command('ok') }, sips: SIPS, maxBytes: 10 });
    assert.ok(shot);
    assert.equal(imageMime(shot.png), 'image/jpeg');
    assert.deepEqual([shot.width, shot.height], [40, 30]);
  });
  test('a small capture is left alone', async () => {
    const shot = await captureScreenRegion({ env: { SPECREVIEW_SCREENCAPTURE: fake.command('ok') }, sips: SIPS });
    assert.deepEqual(shot?.png, fake.small);
  });
});

describe('imageSize / imageMime', () => {
  test('PNG IHDR and JPEG SOF sizes', () => {
    assert.deepEqual(imageSize(makePng(7, 5)), { width: 7, height: 5, type: 'png' });
    // minimal JPEG header: SOI, APP0 (length 16), SOF0 (length 17) with height 9 / width 11
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x09, 0x00, 0x0b, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    assert.deepEqual(imageSize(jpeg), { width: 11, height: 9, type: 'jpeg' });
    assert.equal(imageMime(jpeg), 'image/jpeg');
    assert.equal(imageMime(makePng(1, 1)), 'image/png');
    assert.equal(imageSize(Buffer.from('hello world, not an image')), null);
    assert.equal(imageMime(Buffer.from('GIF89a')), null);
  });
});
