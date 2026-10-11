// @ts-check
// Element fingerprints and fingerprint scoring (design 7.2 "Element", 7.4 "Element anchors", BUILD_AMENDMENTS 4.5).
//
// A fingerprint captures what identifies an element across versions without relying on its srid (srids are
// renumbered on every render): tag, the identifying attributes (id, src, alt, href, class, poster, data), the
// hash of the referenced local asset (from the version manifest), a sample of its rendered text, the heading it
// sits under and its ordinal among same-tag elements in that section.
//
// fingerprintScore(a, b) = 0.4 * idEqual + 0.25 * attrSim + 0.25 * contentSim + 0.1 * context      (0..1)
//   idEqual    identity: the `id` attributes when either side has one (1 equal, 0 different); otherwise the
//              referenced resource (src, else data, else poster; compared exactly, a different path is a
//              different file) when either side has one; 0.5 when neither side has an identity at all
//   attrSim    mean similarity of src/href/alt/class/poster/data over the keys present on either side
//              (0.5 when neither side has any)
//   contentSim mean of the informative signals: asset-hash equality (when both hashes are known) and rendered-text
//              similarity (when either side has text); 0.5 when there is neither
//   context    0.5 * same section + 0.5 * same ordinal
// Different tags never match (score 0). A score >= FINGERPRINT_ACCEPT (0.5) identifies the same element.

import { similarity } from '../text/index.js';
import { assetShaOf, elementLabelOf, elementTextOf, elementsByTag, nodeOf, renderIndex } from './util.js';

/** Minimum fingerprint score that identifies the same element. */
export const FINGERPRINT_ACCEPT = 0.5;

const ATTR_KEYS = /** @type {const} */ (['src', 'href', 'alt', 'class', 'poster', 'data']);

/**
 * @typedef {import('../render/index.js').RenderResult} RenderResult
 * @typedef {Object} Fingerprint
 * @property {string} tag
 * @property {Record<string, string>} attrs
 * @property {string|null} assetSha256
 * @property {string} text
 * @property {string} section  innermost heading text ('' before the first heading)
 * @property {number} ordinal  index among same-tag elements with the same heading chain
 */

/**
 * Fingerprint of a rendered element.
 * @param {RenderResult} render
 * @param {number} srid
 * @param {{ docPath?: string, assets?: Record<string, string>|null }} [opts]
 * @returns {Fingerprint|null}
 */
export function elementFingerprint(render, srid, opts = {}) {
  const n = nodeOf(render, srid);
  if (!n) return null;
  const chain = renderIndex(render).section.get(srid) ?? [];
  return {
    tag: n.t.toLowerCase(),
    attrs: { ...(n.a ?? {}) },
    assetSha256: assetShaOf(n, opts),
    text: elementTextOf(render, srid, 80),
    section: chain[chain.length - 1] ?? '',
    ordinal: ordinalOf(render, srid),
  };
}

/**
 * The AnchorElement stored on element/section anchors: the fingerprint plus srid and a label.
 * @param {RenderResult} render
 * @param {number} srid
 * @param {{ docPath?: string, assets?: Record<string, string>|null }} [opts]
 * @returns {import('../../shared/types.js').AnchorElement & { text: string }}
 */
export function anchorElement(render, srid, opts = {}) {
  const fp = /** @type {Fingerprint} */ (elementFingerprint(render, srid, opts));
  return {
    srid,
    tag: fp.tag,
    attrs: fp.attrs,
    assetSha256: fp.assetSha256,
    label: elementLabelOf(render, srid),
    ordinal: fp.ordinal,
    text: fp.text,
  };
}

/**
 * Fingerprint of a stored AnchorElement (section = innermost heading of the anchor's section chain).
 * @param {any} element AnchorElement (+ text)
 * @param {string[]} [section]
 * @returns {Fingerprint}
 */
export function fingerprintOfElement(element, section = []) {
  return {
    tag: String(element?.tag ?? '').toLowerCase(),
    attrs: { ...(element?.attrs ?? {}) },
    assetSha256: element?.assetSha256 ?? null,
    text: element?.text ?? '',
    section: section[section.length - 1] ?? '',
    ordinal: Number.isInteger(element?.ordinal) ? element.ordinal : -1,
  };
}

/**
 * Index of an element among same-tag elements in the same section (heading chain).
 * @param {RenderResult} render @param {number} srid
 */
export function ordinalOf(render, srid) {
  return nodeOf(render, srid) ? (renderIndex(render).ordinal.get(srid) ?? -1) : -1;
}

/**
 * @param {Fingerprint} a @param {Fingerprint} b
 * @returns {number} 0..1
 */
export function fingerprintScore(a, b) {
  if (!a || !b || a.tag !== b.tag) return 0;
  const idEqual = identity(a, b);
  const keys = ATTR_KEYS.filter((k) => a.attrs[k] || b.attrs[k]);
  const attrSim = keys.length
    ? keys.reduce((sum, k) => sum + similarity(a.attrs[k] ?? '', b.attrs[k] ?? ''), 0) / keys.length
    : 0.5;
  /** @type {number[]} */
  const content = [];
  if (a.assetSha256 && b.assetSha256) content.push(a.assetSha256 === b.assetSha256 ? 1 : 0);
  if (a.text || b.text) content.push(similarity(a.text, b.text));
  const contentSim = content.length ? content.reduce((x, y) => x + y, 0) / content.length : 0.5;
  const context = 0.5 * (a.section === b.section ? 1 : 0) + 0.5 * (a.ordinal >= 0 && a.ordinal === b.ordinal ? 1 : 0);
  return 0.4 * idEqual + 0.25 * attrSim + 0.25 * contentSim + 0.1 * context;
}

/**
 * Identity component of the score: ids, else the referenced resource path, else unknown (0.5).
 * @param {Fingerprint} a @param {Fingerprint} b
 */
function identity(a, b) {
  const idA = a.attrs.id ?? '';
  const idB = b.attrs.id ?? '';
  if (idA || idB) return idA === idB ? 1 : 0;
  const res = (/** @type {Fingerprint} */ f) => f.attrs.src || f.attrs.data || f.attrs.poster || '';
  const rA = res(a);
  const rB = res(b);
  if (rA || rB) return rA === rB ? 1 : 0;
  return 0.5;
}

/**
 * Best-scoring element among candidates (default: every same-tag element of the render).
 * @param {RenderResult} render
 * @param {Fingerprint} fp
 * @param {{ candidates?: number[], minScore?: number, docPath?: string, assets?: Record<string, string>|null,
 *           hint?: number|null }} [opts]
 * @returns {{ srid: number, score: number } | null}
 */
export function bestFingerprintMatch(render, fp, opts = {}) {
  const minScore = opts.minScore ?? FINGERPRINT_ACCEPT;
  const cands = opts.candidates ?? elementsByTag(render, fp.tag);
  /** @type {{ srid: number, score: number, dist: number } | null} */
  let best = null;
  for (const srid of cands) {
    const other = elementFingerprint(render, srid, opts);
    if (!other) continue;
    const score = fingerprintScore(fp, other);
    if (score < minScore) continue;
    const dist = opts.hint == null ? 0 : Math.abs(render.srcmap.nodes[srid].s - opts.hint);
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && dist < best.dist)) {
      best = { srid, score, dist };
    }
  }
  return best ? { srid: best.srid, score: best.score } : null;
}
