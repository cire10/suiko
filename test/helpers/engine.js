// @ts-check
// Test helpers for the review engine: throwaway workspaces (temp SPECREVIEW_HOME + copies of test/fixtures/docs),
// contexts, guest-like captures built from a render (what the guest would send for a selection or a pick), and
// small file helpers. Never touches ~/.specreview and binds no ports.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTEXT_CHARS } from '../../src/shared/protocol.js';
import { createContext } from '../../src/core/review/context.js';
import { clearRenderMemoryCache } from '../../src/core/render/index.js';
import { collapseWs } from '../../src/core/text/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, '..', 'fixtures', 'docs');
export const PACKET_FIXTURES = path.resolve(here, '..', 'fixtures', 'packets');

/**
 * Creates a temp workspace with fixture copies under `<root>/docs/` and points SPECREVIEW_HOME at a temp dir.
 * @param {{ files?: string[] }} [opts] fixture paths relative to test/fixtures/docs
 * @returns {Promise<{ root: string, home: string, docsDir: string, file: (rel: string) => string,
 *   read: (rel: string) => string, write: (rel: string, text: string) => void, cleanup: () => Promise<void> }>}
 */
export async function makeWorkspace({ files = ['kitchen-sink.md', 'img/arch.png'] } = {}) {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'sr-engine-')));
  const root = path.join(base, 'ws');
  const home = path.join(base, 'home');
  await fsp.mkdir(path.join(root, 'docs'), { recursive: true });
  await fsp.mkdir(home, { recursive: true });
  process.env.SPECREVIEW_HOME = home;
  for (const f of files) {
    const dest = path.join(root, 'docs', f);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(path.join(FIXTURES, f), dest);
  }
  clearRenderMemoryCache();
  const file = (/** @type {string} */ rel) => path.join(root, rel);
  return {
    root,
    home,
    docsDir: path.join(root, 'docs'),
    file,
    read: (rel) => fs.readFileSync(file(rel), 'utf8'),
    write: (rel, text) => fs.writeFileSync(file(rel), text),
    cleanup: () => fsp.rm(base, { recursive: true, force: true }),
  };
}

/**
 * @param {string} root
 * @param {{ agent?: string, reviewer?: string }} [opts]
 */
export function engineCtx(root, { agent = 'claude', reviewer = 'Eric' } = {}) {
  return createContext({ root, cwd: root, agent, reviewer, createStore: true });
}

/**
 * The deepest element (srid) whose rendered-text span contains [g0, g1).
 * @param {any} render
 * @param {number} g0
 * @param {number} g1
 */
function deepestSpan(render, g0, g1) {
  let best = null;
  let bestLen = Infinity;
  for (const srid of render.srcmap.order) {
    const span = render.text.spans[srid];
    if (!span || span[0] > g0 || span[1] < g1) continue;
    const len = span[1] - span[0];
    if (len <= bestLen) {
      best = srid;
      bestLen = len;
    }
  }
  return best;
}

/**
 * A guest-like text capture of the `nth` occurrence of `exact` in the rendered text stream.
 * @param {any} render
 * @param {string} exact
 * @param {number} [nth]
 */
export function textCapture(render, exact, nth = 0) {
  const text = render.text.text;
  let g0 = -1;
  for (let i = 0; i <= nth; i++) g0 = text.indexOf(exact, g0 + 1);
  if (g0 < 0) throw new Error(`textCapture: ${JSON.stringify(exact)} is not in the rendered text`);
  const g1 = g0 + exact.length;
  const start = deepestSpan(render, g0, g0 + 1);
  const end = deepestSpan(render, g1 - 1, g1);
  return {
    kind: /** @type {'text'} */ ('text'),
    startSrid: start,
    endSrid: end,
    exact,
    prefix: collapseWs(text.slice(Math.max(0, g0 - 4 * CONTEXT_CHARS), g0)).slice(-CONTEXT_CHARS),
    suffix: collapseWs(text.slice(g1, g1 + 4 * CONTEXT_CHARS)).slice(0, CONTEXT_CHARS),
  };
}

/**
 * srid of the first element matching a predicate over SrcNodes.
 * @param {any} render
 * @param {(node: any, srid: number) => boolean} pred
 * @returns {number}
 */
export function findSrid(render, pred) {
  for (const srid of render.srcmap.order) if (pred(render.srcmap.nodes[srid], srid)) return srid;
  throw new Error('findSrid: no element matches');
}

/**
 * A guest-like element capture.
 * @param {any} render
 * @param {number} srid
 * @param {object} [extra] region / svg / cell / scope
 */
export function elementCapture(render, srid, extra = {}) {
  const n = render.srcmap.nodes[srid];
  return { kind: /** @type {'element'} */ ('element'), srid, tag: n.t, label: n.a?.alt ? `${n.t} "${n.a.alt}"` : n.t, ...extra };
}

/**
 * A guest-like table-cell capture (0-based grid indices).
 * @param {any} render
 * @param {string} rowKey
 * @param {string} colHeader
 * @param {{ row: number, col: number, text: string }} pos
 */
export function cellCapture(render, rowKey, colHeader, pos) {
  const td = findSrid(render, (n, srid) => n.k === 'cell' && render.text.text.slice(...(render.text.spans[srid] ?? [0, 0])).trim() === pos.text && rowOf(render, srid) === rowKey);
  return elementCapture(render, td, { cell: { row: pos.row, col: pos.col, rowKey, colHeader, text: pos.text }, scope: 'cell' });
}

/**
 * Text of the first cell of the row containing a cell.
 * @param {any} render
 * @param {number} cellSrid
 */
function rowOf(render, cellSrid) {
  const tr = render.srcmap.nodes[cellSrid].p;
  const first = render.srcmap.order.find((s) => render.srcmap.nodes[s].p === tr);
  const span = render.text.spans[first];
  return span ? render.text.text.slice(span[0], span[1]).trim() : '';
}

/** A 1x1 transparent PNG as a data URL. */
export const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * Replaces exactly one occurrence of `from` in a file (throws when absent or ambiguous).
 * @param {string} abs
 * @param {string} from
 * @param {string} to
 */
export function editFile(abs, from, to) {
  const text = fs.readFileSync(abs, 'utf8');
  const i = text.indexOf(from);
  if (i < 0 || text.indexOf(from, i + 1) >= 0) throw new Error(`editFile: ${JSON.stringify(from)} must occur exactly once`);
  fs.writeFileSync(abs, text.slice(0, i) + to + text.slice(i + from.length));
}

/**
 * Normalises volatile parts of a packet for golden comparison: ISO timestamps, the temp workspace root.
 * @param {string} text
 * @param {string} root
 */
export function normalizePacket(text, root) {
  return text.split(root).join('<root>').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>');
}
