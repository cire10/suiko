// @ts-check
// Queries over a RenderResult's source map and text stream (BUILD_AMENDMENTS 3.1, FROZEN):
//   elementText(render, srid)                       -> rendered text of an element (raw, not normalised)
//   deepestBlockAt(render, startOff, endOff)        -> deepest block element whose [s, e] contains [start, end)
//   elementsIntersecting(render, s, e, opts)        -> srids whose [s, e) intersects [s, e), document order
// Ranges are half-open source offsets. An empty query range [p, p) intersects an element when s <= p < e.
// `leafBlocks` keeps only block elements none of whose block descendants also intersect (the deepest blocks).

/**
 * @typedef {import('./srcmap.js').SrcNode} SrcNode
 * @typedef {{ srcmap: { order: number[], nodes: Record<string, SrcNode> },
 *             text: { text: string, spans: Record<string, [number, number]> } }} RenderLike
 */

/**
 * @param {RenderLike} render
 * @param {number} srid
 * @returns {string}
 */
export function elementText(render, srid) {
  const span = render?.text?.spans?.[srid];
  if (!span) return '';
  return render.text.text.slice(span[0], span[1]);
}

/**
 * @param {RenderLike} render
 * @param {number} srid
 */
export function depthOf(render, srid) {
  let d = 0;
  for (let n = render.srcmap.nodes[srid]; n && n.p; n = render.srcmap.nodes[n.p]) d++;
  return d;
}

/**
 * @param {RenderLike} render
 * @param {number} startOff
 * @param {number} endOff
 * @returns {number|null}
 */
export function deepestBlockAt(render, startOff, endOff) {
  const end = Math.max(startOff, endOff);
  // Element ranges nest, and descendants follow their ancestors in document order, so the deepest containing
  // block is the last containing block in order.
  let best = null;
  for (const srid of render.srcmap.order) {
    const n = render.srcmap.nodes[srid];
    if (!n.b || n.s > startOff || n.e < end) continue;
    if (startOff === end && startOff === n.e && n.e > n.s) continue; // a point at the very end belongs to what follows
    best = srid;
  }
  return best;
}

/**
 * @param {RenderLike} render
 * @param {number} startOff
 * @param {number} endOff
 * @param {{ blocksOnly?: boolean, leafBlocks?: boolean }} [opts]
 * @returns {number[]}
 */
export function elementsIntersecting(render, startOff, endOff, opts = {}) {
  const blocksOnly = Boolean(opts.blocksOnly || opts.leafBlocks);
  const end = Math.max(startOff, endOff);
  const hits = render.srcmap.order.filter((srid) => {
    const n = render.srcmap.nodes[srid];
    if (blocksOnly && !n.b) return false;
    return intersects(n.s, n.e, startOff, end);
  });
  if (!opts.leafBlocks) return hits;
  const hitSet = new Set(hits);
  /** @type {Set<number>} */
  const hasBlockChildHit = new Set();
  for (const srid of hits) {
    for (let p = render.srcmap.nodes[srid].p; p; p = render.srcmap.nodes[p]?.p ?? 0) {
      if (hitSet.has(p)) hasBlockChildHit.add(p);
    }
  }
  return hits.filter((srid) => !hasBlockChildHit.has(srid));
}

/**
 * Half-open intersection; an empty query range [p, p) intersects [s, e) when s <= p < e (or s === e === p).
 * @param {number} s @param {number} e @param {number} qs @param {number} qe
 */
export function intersects(s, e, qs, qe) {
  if (qe === qs) return (s <= qs && qs < e) || (s === e && s === qs);
  if (e === s) return qs <= s && s < qe;
  return s < qe && qs < e;
}

/**
 * Heading chain (outline texts) in effect at a source offset: the last heading of each level that starts at or
 * before `off`, as ['3 Tokens', '3.2 Token refresh'].
 * @param {{ outline: { srid: number, level: number, text: string }[], srcmap: { nodes: Record<string, SrcNode> } }} render
 * @param {number} off
 * @returns {string[]}
 */
export function sectionAt(render, off) {
  /** @type {{ level: number, text: string }[]} */
  const stack = [];
  for (const h of render.outline ?? []) {
    const n = render.srcmap.nodes[h.srid];
    if (!n || n.s > off) break;
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    stack.push({ level: h.level, text: h.text });
  }
  return stack.map((h) => h.text);
}
