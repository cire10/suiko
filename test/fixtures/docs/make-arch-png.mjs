// Generates test/fixtures/docs/img/arch.png: a small, deterministic architecture-style diagram (three boxes
// joined by arrows) encoded as an RGB PNG with nothing but node:zlib. Run: node test/fixtures/docs/make-arch-png.mjs
// The PNG is committed; re-running produces identical bytes.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const W = 160;
const H = 90;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Draw the diagram into an RGB pixel buffer. */
function draw() {
  const px = Buffer.alloc(W * H * 3);
  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  };
  const rect = (x0, y0, w, h, fill, stroke) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const edge = x === x0 || y === y0 || x === x0 + w - 1 || y === y0 + h - 1;
        set(x, y, edge ? stroke : fill);
      }
    }
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, [248, 249, 251]);
  rect(8, 30, 36, 28, [219, 233, 255], [11, 107, 203]);
  rect(62, 30, 36, 28, [227, 247, 232], [31, 138, 76]);
  rect(116, 30, 36, 28, [255, 241, 214], [183, 121, 31]);
  for (const x0 of [44, 98]) {
    for (let x = x0; x < x0 + 18; x++) set(x, 44, [85, 85, 85]);
    for (let d = 1; d <= 3; d++) {
      set(x0 + 17 - d, 44 - d, [85, 85, 85]);
      set(x0 + 17 - d, 44 + d, [85, 85, 85]);
    }
  }
  return px;
}

export function makeArchPng() {
  const px = draw();
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0; // filter: none
    px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = join(dirname(fileURLToPath(import.meta.url)), 'img', 'arch.png');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, makeArchPng());
  console.log(`wrote ${out}`);
}
