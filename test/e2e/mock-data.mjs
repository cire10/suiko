// @ts-check
// Scenarios for the e2e mock server, built from the real fixtures in test/fixtures/docs.
//
//   'fresh'  - kitchen-sink.md v1 only (no threads, no reviews) + app-spec.html v1.
//   'round2' - kitchen-sink.md after one review round: rv1 (changes requested, delivered to claude) created
//              t1..t5 and lock L1, then claude recorded v2 answering rv1:
//                t1 blocking comment on "rotated on every use"   -> addressed (text extended in v2)
//                t2 question on the architecture image          -> answered (image bytes changed in v2)
//                t3 comment on the refresh_token TTL cell        -> still open
//                t4 nit on "Load test the issuer"                -> declined (line removed in v2: orphaned)
//                t5 comment on "Prototype the issuer."           -> resolved with decision D1
//                t6 agent question (needs_input) on the open-questions paragraph
//              plus app-spec.html v1.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { deepestBlockAt, elementText } from '../../src/core/render/index.js';
import { lineHunks } from '../../src/core/diff/index.js';
import { MockDoc } from './mock-engine.mjs';

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'docs');
export const WS = 'ws0e2e01';

/** @param {Buffer|string} b */
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** Encodes an RGBA PNG (plain zlib). @param {number} w @param {number} h @param {(x: number, y: number) => number[]} px */
export function makePng(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 4 + 1) + 1 + x * 4);
  }
  /** @param {string} type @param {Buffer} data */
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** The "redrawn" architecture image served for v2+ of kitchen-sink (purple / teal halves). */
export const ARCH_V2_PNG = makePng(240, 160, (x) => (x < 120 ? [120, 70, 200, 255] : [20, 160, 150, 255]));

/**
 * A text capture of `needle` (as the guest would send it) in version v.
 * @param {MockDoc} doc @param {number} v @param {string} needle
 */
export function textCapture(doc, v, needle) {
  const src = doc.source(v);
  const off = src.indexOf(needle);
  if (off < 0) throw new Error(`fixture text not found: ${needle}`);
  const render = doc.render(v);
  const srid = deepestBlockAt(render, off, off + needle.length);
  const text = srid == null ? '' : elementText(render, srid);
  const i = text.indexOf(needle);
  return {
    kind: 'text',
    startSrid: srid,
    endSrid: srid,
    exact: needle,
    prefix: i >= 0 ? text.slice(Math.max(0, i - 32), i).replace(/\s+/g, ' ') : '',
    suffix: i >= 0 ? text.slice(i + needle.length, i + needle.length + 32).replace(/\s+/g, ' ') : '',
  };
}

/** srid of the first node with a tag (and optional predicate). @param {MockDoc} doc @param {number} v @param {string} tag @param {(n: any) => boolean} [pred] */
export function sridOf(doc, v, tag, pred = () => true) {
  const nodes = doc.render(v).srcmap.nodes;
  for (const [k, n] of Object.entries(nodes)) if (/** @type {any} */ (n).t === tag && pred(n)) return Number(k);
  throw new Error(`no <${tag}> in fixture`);
}

/** @param {{ clock?: () => string }} [opts] */
function kitchenSink(opts = {}) {
  const source = readFileSync(join(FIXTURE_DIR, 'kitchen-sink.md'), 'utf8');
  const doc = new MockDoc({ ws: WS, id: 'kitchen-sink', path: 'kitchen-sink.md', format: 'markdown', source, clock: opts.clock });
  const archHash = `sha256:${sha(readFileSync(join(FIXTURE_DIR, 'img', 'arch.png')))}`;
  doc.assetHashes[1] = { 'img/arch.png': archHash };
  doc.versions[0].manifest.assets = doc.assetHashes[1];
  return doc;
}

/** @param {{ clock?: () => string }} [opts] */
function appSpec(opts = {}) {
  const source = readFileSync(join(FIXTURE_DIR, 'app-spec.html'), 'utf8');
  const doc = new MockDoc({ ws: WS, id: 'app-spec', path: 'app-spec.html', format: 'html', source, clock: opts.clock });
  doc.assetHashes[1] = { 'img/arch.png': `sha256:${sha(readFileSync(join(FIXTURE_DIR, 'img', 'arch.png')))}` };
  return doc;
}

/** v2 of kitchen-sink.md: the edits claude makes in answer to rv1. @param {string} v1 */
export function kitchenSinkV2(v1) {
  return v1
    .replace('Refresh tokens are rotated on every use, and', 'Refresh tokens are rotated on every use with a 30 s reuse-detection grace window, and')
    .replace('- [ ] Load test the issuer\n', '')
    .replace('Last revised 2026-10-10.', 'Last revised 2026-10-11.');
}

/** @param {MockDoc} doc */
function seedRound2(doc) {
  const img = sridOf(doc, 1, 'img');
  const cell = sridOf(doc, 1, 'td', (n) => doc.source(1).slice(n.s, n.e).includes('30 d'));
  /** @type {Array<[any, string, string, string]>} capture, type, severity, body */
  const items = [
    [textCapture(doc, 1, 'rotated on every use'), 'comment', 'blocking', 'Rotation on every use breaks clients that refresh concurrently. Add a grace window.'],
    [{ kind: 'element', srid: img, tag: 'img', label: 'img "System overview"' }, 'question', 'normal', 'Is the token store really behind the auth service? The diagram shows it next to the gateway.'],
    [{ kind: 'element', srid: cell, tag: 'td', label: 'td refresh_token / TTL', cell: { row: 2, col: 1, rowKey: 'refresh_token', colHeader: 'TTL', text: '30 d' }, scope: 'cell' }, 'comment', 'normal', '30 days is long for a refresh token. Can we justify it?'],
    [textCapture(doc, 1, 'Load test the issuer'), 'comment', 'nit', 'Add a target RPS for the load test.'],
    [textCapture(doc, 1, 'Prototype the issuer.'), 'comment', 'normal', 'Which language for the prototype?'],
  ];
  for (const [capture, type, severity, body] of items) doc.saveDraft({ kind: 'thread', type, severity, capture, body, version: 1 });
  const goals = doc.render(1).outline.find((h) => h.text === '1 Goals');
  doc.addLock({ version: 1, capture: { kind: 'section', headingSrid: goals?.srid }, note: 'Agreed' });
  const rv1 = doc.submitReview({ verdict: 'changes_requested', body: 'Good start. The goals are agreed; keep them as they are.' });
  doc.deliver(rv1.id, 'claude');
  doc.resolve('t5', 'Prototype in TypeScript first');

  const v1 = doc.source(1);
  const v2 = kitchenSinkV2(v1);
  const hunks = lineHunks(v1, v2);
  /** @type {Record<string, { threads?: string[], other?: string|null }>} */
  const hunkLinks = {};
  for (const h of hunks) {
    const oldText = v1.split('\n').slice(h.oldStart - 1, h.oldStart - 1 + h.oldLines).join('\n');
    if (oldText.includes('rotated on every use')) hunkLinks[h.id] = { threads: ['t1'] };
    else if (oldText.includes('Load test the issuer')) hunkLinks[h.id] = { threads: ['t4'] };
    else hunkLinks[h.id] = { other: 'Bumped the "Last revised" date' };
  }
  doc.revise({
    source: v2,
    summary: 'rv1: grace window, redrawn diagram, dropped the load-test item',
    replies: {
      t1: { status: 'addressed', reply: 'Added a **30 s reuse-detection grace window**, so concurrent refreshes no longer revoke the family.' },
      t2: { status: 'answered', reply: 'Yes. I redrew the diagram so the token store sits behind the auth service.' },
      t4: { status: 'declined', reply: 'Load testing moved to the rollout doc, so I removed the item here.' },
    },
    hunkLinks,
    assets: { 'img/arch.png': `sha256:${sha(ARCH_V2_PNG)}` },
  });
  doc.assetBlobs.set(`sha256:${sha(ARCH_V2_PNG)}`, ARCH_V2_PNG);

  // An agent question (suiko ask) on the open-questions paragraph.
  const q = doc.resolveCapture(2, textCapture(doc, 2, 'Should the grace window be'));
  const tid = doc.nextId('thread');
  doc.threads.push({
    schema: 1, id: tid, doc: doc.id, type: 'agent-question', severity: 'normal', status: 'needs_input', createdIn: 2,
    createdBy: { kind: 'agent', name: 'claude' }, review: null, anchors: { 2: q }, override: null, suggestion: null,
    comments: [{ id: doc.nextId('comment'), by: { kind: 'agent', name: 'claude' }, body: 'Should the grace window be configurable per client? I kept a fixed 30 s for now.', at: doc.clock(), version: 2, status: 'needs_input' }],
    changes: [], attachments: [], decision: null, resolvedIn: null, updatedAt: doc.clock(),
  });
  doc.events.length = 0;
  doc.seq = 0;
}

/**
 * Builds the docs of a scenario.
 * @param {'fresh'|'round2'} scenario
 * @param {{ clock?: () => string }} [opts]
 * @returns {MockDoc[]}
 */
export function buildScenario(scenario, opts = {}) {
  const ks = kitchenSink(opts);
  if (scenario === 'round2') seedRound2(ks);
  return [ks, appSpec(opts)];
}
