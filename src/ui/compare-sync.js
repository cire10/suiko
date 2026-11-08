// @ts-check
// Scroll sync of Changes side by side (actions.js): which point of the older version goes with a point of the newer
// one; and the links drawn between the frames (ComparePane: changeLinks). Pure functions, no DOM (tested in
// test/e2e/compare-sync.test.mjs).
//
// Both guests report where things are in their own document (POSITIONS, document coordinates): the tops of the
// outline's headings, and the top and end of every change (hunks / hunkEnds; a change with nothing on one side, a
// pure deletion or addition, has its top and end at the point where the other version's lines would be). The anchors
// pair what both versions share: matched headings (same text, same occurrence), each change's top with its top and
// its end with its end, and the two documents' starts and ends. Kept: the longest chain that is monotonic in both
// versions, so a section that moved elsewhere cannot twist the mapping. Between anchors the mapping is linear, so
// unchanged stretches stay level and a changed stretch is spread over its counterpart; where one version has lines
// the other lacks, the other one waits (the newer version leads) or jumps over them (the older one leads).
// The line that is kept level is a third down the frame, where the change stepper puts a change (n / p), so stepping
// and scrolling agree. Near the top of the leading version that line rises to the top edge, and in its last screen it
// sinks to the bottom edge, so both versions are at their tops together and reach their ends together.

/**
 * What a guest reports about its document (POSITIONS), as far as the sync needs it.
 * @typedef {{ hunks?: Record<string, number|null>, hunkEnds?: Record<string, number|null>,
 *   headings?: Record<string, number>, docH?: number, viewportH?: number }} FramePositions
 */

/** @typedef {[number, number]} Anchor  [y in the newer version, y in the older one] (document coordinates) */

/** @param {unknown} v @returns {v is number} */
const num = (v) => typeof v === 'number' && Number.isFinite(v);

/** @param {string} s */
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Pairs the headings of the newer version's outline with the older one's: the same text and the same occurrence (the
 * second "Notes" with the second "Notes"), else the only heading with that text.
 * @param {Array<{ srid: number, text: string }>} main the newer version's outline
 * @param {Array<{ srid: number, text: string }>} base the older version's outline
 * @returns {Array<[number, number]>} [srid in main, srid in base]
 */
export function pairHeadings(main, base) {
  /** @type {Map<string, number[]>} */
  const byText = new Map();
  for (const h of base || []) {
    const t = norm(h.text);
    const list = byText.get(t);
    if (list) list.push(h.srid);
    else byText.set(t, [h.srid]);
  }
  /** @type {Map<string, number>} */
  const nth = new Map();
  /** @type {Array<[number, number]>} */
  const out = [];
  for (const h of main || []) {
    const t = norm(h.text);
    const n = nth.get(t) ?? 0;
    nth.set(t, n + 1);
    const list = byText.get(t) || [];
    const m = list[n] ?? (list.length === 1 ? list[0] : undefined);
    if (m != null) out.push([h.srid, m]);
  }
  return out;
}

/**
 * The longest chain of points that never goes back in either coordinate (exact duplicates once).
 * @param {Anchor[]} points
 * @returns {Anchor[]} sorted by the first coordinate, then the second
 */
export function monotonicChain(points) {
  const sorted = points.filter((p) => num(p[0]) && num(p[1])).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  /** @type {Anchor[]} */
  const pts = [];
  for (const p of sorted) {
    const last = pts[pts.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
  }
  // longest non-decreasing subsequence in the second coordinate (the first is sorted): patience sorting
  /** @type {number[]} tails[k]: the point ending the best chain of length k + 1 with the smallest second coordinate */
  const tails = [];
  const prev = new Array(pts.length).fill(-1);
  for (let i = 0; i < pts.length; i++) {
    const y = pts[i][1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[tails[mid]][1] <= y) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  /** @type {Anchor[]} */
  const out = [];
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.push(pts[i]);
  return out.reverse();
}

/**
 * The anchors of a side-by-side comparison (see the header).
 * @param {FramePositions|null} main the newer version's positions
 * @param {FramePositions|null} base the older version's positions
 * @param {Array<[number, number]>} headingPairs from pairHeadings
 * @returns {Anchor[]}
 */
export function syncAnchors(main, base, headingPairs) {
  if (!main || !base) return [];
  /** @type {Anchor[]} */
  const pts = [[0, 0]];
  for (const [ms, bs] of headingPairs || []) {
    const a = main.headings?.[ms];
    const b = base.headings?.[bs];
    if (num(a) && num(b)) pts.push([a, b]);
  }
  for (const id of Object.keys(main.hunks || {})) {
    const a = main.hunks?.[id];
    const b = base.hunks?.[id];
    if (num(a) && num(b)) pts.push([a, b]);
    const ae = main.hunkEnds?.[id];
    const be = base.hunkEnds?.[id];
    if (num(ae) && num(be)) pts.push([ae, be]);
  }
  if (num(main.docH) && num(base.docH)) pts.push([main.docH, base.docH]);
  return monotonicChain(pts);
}

/**
 * The anchors seen from the older version (each pair swapped; still in order).
 * @param {Anchor[]} anchors
 * @returns {Anchor[]}
 */
export function swapAnchors(anchors) {
  return anchors.map(([a, b]) => /** @type {Anchor} */ ([b, a]));
}

/**
 * Where y (in the first coordinate) goes in the second: linear between anchors, the later of two anchors at the same
 * y (a jump over lines the first version lacks), slope 1 beyond the first and the last.
 * @param {Anchor[]} anchors sorted, never decreasing in either coordinate
 * @param {number} y
 */
export function mapThrough(anchors, y) {
  if (!anchors.length) return y;
  if (y < anchors[0][0]) return anchors[0][1] + (y - anchors[0][0]);
  // the last anchor at or before y
  let lo = 0;
  let hi = anchors.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (anchors[mid][0] <= y) lo = mid;
    else hi = mid - 1;
  }
  const [x0, y0] = anchors[lo];
  if (lo === anchors.length - 1) return y0 + (y - x0);
  const [x1, y1] = anchors[lo + 1];
  return y0 + ((y - x0) * (y1 - y0)) / (x1 - x0);
}

/**
 * The links drawn between the two frames: each change that both frames show on screen right now, with where it is in
 * the older frame and in the newer one (from the top of the frames, which share their top and height). A change with
 * nothing on one side (a pure deletion or addition) is the point where its lines are missing there.
 * @param {FramePositions & { scrollY?: number }} main the newer version's positions
 * @param {FramePositions & { scrollY?: number }} base the older version's positions
 * @param {Array<{ id: string, op: string }>} hunks the comparison's changes, in order
 * @param {number} height the frames' height
 * @returns {Array<{ id: string, op: string, old: [number, number], new: [number, number] }>}
 */
export function changeLinks(main, base, hunks, height) {
  /** @type {Array<{ id: string, op: string, old: [number, number], new: [number, number] }>} */
  const out = [];
  const my = Number(main?.scrollY) || 0;
  const by = Number(base?.scrollY) || 0;
  /** @param {[number, number]} r */
  const onScreen = (r) => r[1] >= 0 && r[0] <= height;
  for (const h of hunks || []) {
    const nt = main?.hunks?.[h.id];
    const ot = base?.hunks?.[h.id];
    if (!num(nt) || !num(ot)) continue;
    const ne = main?.hunkEnds?.[h.id];
    const oe = base?.hunkEnds?.[h.id];
    /** @type {[number, number]} */
    const n = [nt - my, (num(ne) ? ne : nt) - my];
    /** @type {[number, number]} */
    const o = [ot - by, (num(oe) ? oe : ot) - by];
    if (onScreen(n) && onScreen(o)) out.push({ id: h.id, op: h.op, old: o, new: n });
  }
  return out;
}

/**
 * The scroll offset of the following version for where the leading one is (see the header).
 * @param {Anchor[]} anchors from the leader's point of view (swapAnchors when the older version leads)
 * @param {{ y: number, vh: number, docH: number }} lead its scrollY, viewport height and document height
 * @param {{ vh: number, docH: number }} follow
 * @returns {number}
 */
export function followScroll(anchors, lead, follow) {
  const vh = Math.max(0, lead.vh);
  const third = vh / 3;
  const leadMax = Math.max(0, lead.docH - vh);
  const y = Math.min(leadMax, Math.max(0, lead.y));
  // the level line: a third down, rising to the top edge in the first third of a screen of scrolling, sinking to the
  // bottom edge in the last screen (both offsets add up in a document shorter than that)
  const fromTop = Math.min(third, y);
  const fromEnd = vh - Math.min(leadMax - y, vh - third);
  const line = fromTop + fromEnd - third;
  const t = mapThrough(anchors, y + line) - line;
  const followMax = Math.max(0, follow.docH - follow.vh);
  return Math.round(Math.min(followMax, Math.max(0, t)));
}
