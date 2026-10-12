// @ts-check
// Screen snips on the reviewer's Mac (key `B` in the review UI via the daemon, and `suiko snip`):
//
//   captureScreenRegion({ timeoutMs = 120000, maxPx = SNIP.maxScreenPx, env = process.env, signal?, platform?,
//                         sips?, maxBytes? }) -> Promise<{ png: Buffer, width: number, height: number } | null>
//
// Runs macOS's interactive region picker (the Cmd+Shift+4 crosshair): `screencapture -i -x <tmp>.png` (-i
// interactive, -x no shutter sound) with the file in a fresh private directory under os.tmpdir(). The reviewer drags
// a box (or presses Space and clicks a window); Esc writes no file. Then:
//   - no file (Esc, any exit code), the picker killed after `timeoutMs` (SIGTERM, then SIGKILL 2 s later) or
//     `signal` aborted -> null ("cancelled");
//   - the image is resampled with `sips -Z <maxPx>` when its longest side exceeds maxPx, and converted to JPEG
//     (quality 80) when it is still larger than `maxBytes` (LIMITS.maxAttachmentBytes), so it can be stored as an
//     attachment. `png` holds the final bytes (PNG, or JPEG after that conversion; check the magic bytes);
//   - the temporary directory is always removed.
// Command: env.SPECREVIEW_SCREENCAPTURE (tests point it at a fake that writes a PNG to its last argument, or exits 1
// without writing to simulate Esc), else /usr/sbin/screencapture. sips (/usr/bin/sips, else /usr/sbin/sips) is not
// used when SPECREVIEW_SCREENCAPTURE is set or when it is missing (the image is then returned as captured); pass
// `sips` (a path, or null) to choose explicitly.
// Errors: SuikoError code 'unsupported' (exit 1) when not on macOS and no override is set, or when the capture
// command does not exist / cannot run; code 'capture_failed' when the picker wrote something that is not a PNG/JPEG.
// Never call this from automated tests without SPECREVIEW_SCREENCAPTURE: the real picker takes over the screen.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EXIT, LIMITS, SNIP } from '../../shared/protocol.js';
import { SuikoError } from '../store/errors.js';

/** macOS's screenshot tool. */
export const SCREENCAPTURE = '/usr/sbin/screencapture';
/** Where macOS keeps sips (scriptable image processing); the first one that exists is used. */
const SIPS_CANDIDATES = ['/usr/bin/sips', '/usr/sbin/sips'];
const KILL_GRACE_MS = 2000;
const TOOL_TIMEOUT_MS = 30000;
const JPEG_QUALITY = 80;

/**
 * @typedef {{ png: Buffer, width: number, height: number }} ScreenCapture
 * @typedef {{ timeoutMs?: number, maxPx?: number, env?: Record<string, string | undefined>, signal?: AbortSignal,
 *   platform?: string, sips?: string | null, maxBytes?: number }} CaptureOptions
 */

/**
 * Lets the reviewer pick a screen region with the macOS picker and returns the image (null when cancelled).
 * @param {CaptureOptions} [opts]
 * @returns {Promise<ScreenCapture | null>}
 */
export async function captureScreenRegion({
  timeoutMs = 120000,
  maxPx = SNIP.maxScreenPx,
  env = process.env,
  signal,
  platform = process.platform,
  sips,
  maxBytes = LIMITS.maxAttachmentBytes,
} = {}) {
  const override = env.SPECREVIEW_SCREENCAPTURE || '';
  const cmd = override || SCREENCAPTURE;
  if (!override && platform !== 'darwin') {
    throw unsupported(`screen snips need macOS (its screencapture region picker); this is ${platform}`);
  }
  if (path.isAbsolute(cmd) && !fs.existsSync(cmd)) throw unsupported(`screen snips need ${cmd}, which does not exist`);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'suiko-snip-'));
  const file = path.join(dir, 'snip.png');
  try {
    const { outcome, code, stderr } = await runPicker(cmd, ['-i', '-x', file], { timeoutMs, env, signal });
    if (outcome !== 'exited') return null;
    let buf = await readNonEmpty(file);
    if (!buf) {
      // Esc (or a click without a drag) ends the picker quietly. A failure says why on stderr: report it instead of
      // passing it off as a cancel (most often a missing Screen Recording permission).
      if (code !== 0 && stderr) {
        throw new SuikoError(
          `the screen capture failed: ${stderr}. If macOS blocked it, allow Screen Recording for the app that runs ` +
            'Suiko (System Settings > Privacy & Security > Screen & System Audio Recording) and try again',
          { code: 'capture_failed', exit: EXIT.ERROR },
        );
      }
      return null;
    }
    let size = imageSize(buf);
    if (!size) throw new SuikoError('the screen capture is not a PNG or JPEG image', { code: 'capture_failed', exit: EXIT.ERROR });
    const tool = sips === undefined ? (override ? null : findSips()) : sips;
    if (tool && maxPx > 0 && Math.max(size.width, size.height) > maxPx) {
      if (await runTool(tool, ['-Z', String(Math.floor(maxPx)), file])) {
        const b = await readNonEmpty(file);
        const s = b && imageSize(b);
        if (b && s) [buf, size] = [b, s];
      }
    }
    if (tool && buf.length > maxBytes) {
      const jpg = path.join(dir, 'snip.jpg');
      if (await runTool(tool, ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(JPEG_QUALITY), file, '--out', jpg])) {
        const b = await readNonEmpty(jpg);
        const s = b && imageSize(b);
        if (b && s) [buf, size] = [b, s];
      }
    }
    return { png: buf, width: size.width, height: size.height };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Width and height of a PNG (IHDR) or JPEG (first SOFn marker), else null.
 * @param {Buffer | Uint8Array} buf
 * @returns {{ width: number, height: number, type: 'png' | 'jpeg' } | null}
 */
export function imageSize(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (isPng(b)) {
    if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
    const width = b.readUInt32BE(16);
    const height = b.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height, type: 'png' } : null;
  }
  if (isJpeg(b)) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += marker === 0xff ? 1 : 2; // fill byte / markers without a length
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = b.readUInt16BE(i + 5);
        const width = b.readUInt16BE(i + 7);
        return width > 0 && height > 0 ? { width, height, type: 'jpeg' } : null;
      }
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

/** @param {Buffer} b */
export function isPng(b) {
  return b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

/** @param {Buffer} b */
export function isJpeg(b) {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/**
 * MIME type of image bytes ('image/png' | 'image/jpeg'), else null.
 * @param {Buffer} b
 * @returns {'image/png' | 'image/jpeg' | null}
 */
export function imageMime(b) {
  return isPng(b) ? 'image/png' : isJpeg(b) ? 'image/jpeg' : null;
}

// ------------------------------------------------------------------------------------------------------ internals

/** @param {string} message */
function unsupported(message) {
  return new SuikoError(message, { code: 'unsupported', exit: EXIT.ERROR });
}

/** The first existing sips binary, else null. */
function findSips() {
  return SIPS_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

/** @param {string} file @returns {Promise<Buffer | null>} */
async function readNonEmpty(file) {
  try {
    const buf = await fsp.readFile(file);
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Runs the picker to completion. outcome 'exited' when it ended by itself (with its exit code and trimmed stderr),
 * 'timeout' / 'aborted' when it was killed. Spawn failures (missing / not executable command) reject with an
 * 'unsupported' error.
 * @param {string} cmd @param {string[]} args
 * @param {{ timeoutMs: number, env: Record<string, string | undefined>, signal?: AbortSignal }} o
 * @returns {Promise<{ outcome: 'exited' | 'timeout' | 'aborted', code: number | null, stderr: string }>}
 */
function runPicker(cmd, args, { timeoutMs, env, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({ outcome: 'aborted', code: null, stderr: '' });
      return;
    }
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(cmd, args, { env: /** @type {NodeJS.ProcessEnv} */ (env), stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      reject(spawnError(cmd, err));
      return;
    }
    /** @type {'exited' | 'timeout' | 'aborted'} */
    let outcome = 'exited';
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (/** @type {string} */ chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    let settled = false;
    /** @type {NodeJS.Timeout | null} */
    let hardKill = null;
    const stop = (/** @type {'timeout' | 'aborted'} */ why) => {
      if (outcome !== 'exited') return;
      outcome = why;
      child.kill('SIGTERM');
      hardKill = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      hardKill.unref();
    };
    const timer = timeoutMs > 0 ? setTimeout(() => stop('timeout'), timeoutMs) : null;
    const onAbort = () => stop('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = () => {
      if (timer) clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      signal?.removeEventListener('abort', onAbort);
    };
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      finish();
      reject(spawnError(cmd, err));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      finish();
      resolve({ outcome, code, stderr: stderr.trim().slice(0, 500) });
    });
  });
}

/**
 * Runs a helper tool (sips) and reports whether it succeeded; failures leave the image as it was.
 * @param {string} cmd @param {string[]} args
 * @returns {Promise<boolean>}
 */
function runTool(cmd, args) {
  return new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(cmd, args, { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), TOOL_TIMEOUT_MS);
    timer.unref();
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/** @param {string} cmd @param {unknown} err */
function spawnError(cmd, err) {
  const code = /** @type {NodeJS.ErrnoException} */ (err)?.code;
  if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
    return unsupported(`screen snips need ${cmd}, which ${code === 'EACCES' ? 'cannot be run' : 'does not exist'}`);
  }
  return new SuikoError(`could not run ${cmd}: ${/** @type {Error} */ (err)?.message ?? err}`, { code: 'capture_failed', exit: EXIT.ERROR, cause: err });
}
