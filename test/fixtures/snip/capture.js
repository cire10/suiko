// @ts-check
// Test fixtures for screen snips: a PNG generator (plain node zlib) and a FAKE `screencapture` command, so tests
// never open the real macOS picker. Point SPECREVIEW_SCREENCAPTURE at fake.command(mode); the command is a shell
// wrapper around a node script, called like screencapture (`<cmd> -i -x <out.png>`), that logs every call
// ({mode, args, mark: $FAKE_MARK}) and by mode:
//   ok       writes a 40x30 PNG to its last argument          big      writes a 2600x40 PNG
//   cancel   writes nothing, exits 1 (like Esc)              cancel0  writes nothing, exits 0
//   hang     never exits (killed by the caller's timeout)     garbage  writes bytes that are not an image
//   fail     writes nothing, exits 3 and logs (a test asserting the picker is NOT used can check calls())

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * A valid RGB PNG of w x h pixels (a horizontal gradient, so it does not compress to nothing).
 * @param {number} w
 * @param {number} h
 * @returns {Buffer}
 */
export function makePng(w, h) {
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.fill((x * 7) & 0xff, 1 + x * 3, 4 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  /** @param {string} type @param {Buffer} data */
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Creates the fake capture command in `dir` (created when missing).
 * @param {string} dir
 * @returns {{ command: (mode: string) => string, calls: () => Array<{ mode: string, args: string[], mark: string | null }>,
 *   small: Buffer, big: Buffer, dir: string }}
 */
export function createFakeCapture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'calls.log');
  const small = makePng(40, 30);
  const big = makePng(2600, 40);
  const smallFile = path.join(dir, 'small.png');
  const bigFile = path.join(dir, 'big.png');
  fs.writeFileSync(smallFile, small);
  fs.writeFileSync(bigFile, big);
  const script = path.join(dir, 'fake-capture.mjs');
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
const [mode, ...args] = process.argv.slice(2);
const out = args[args.length - 1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ mode, args, mark: process.env.FAKE_MARK ?? null }) + '\\n');
if (mode === 'ok') fs.copyFileSync(${JSON.stringify(smallFile)}, out);
else if (mode === 'big') fs.copyFileSync(${JSON.stringify(bigFile)}, out);
else if (mode === 'garbage') fs.writeFileSync(out, 'not an image');
else if (mode === 'cancel') process.exit(1);
else if (mode === 'cancel0') process.exit(0);
else if (mode === 'fail') process.exit(3);
else if (mode === 'hang') setInterval(() => {}, 1000);
`,
  );
  return {
    dir,
    small,
    big,
    command(mode) {
      const file = path.join(dir, `capture-${mode}.sh`);
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${mode} "$@"\n`, { mode: 0o755 });
      }
      return file;
    },
    calls() {
      if (!fs.existsSync(log)) return [];
      return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}
