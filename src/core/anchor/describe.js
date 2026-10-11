// @ts-check
// How an anchor is presented to the agent (design 7.5, 9.3; BUILD_AMENDMENTS 4.6):
//
//   describeAnchor(anchor, { source, workingSource?, workingMapper?, format?, docPath?, absAttachmentPath?,
//                            absAssetPath?, attachments?, maxChars? })
//     -> { lines: [a, b] | null, label, section, on, src, srcUnique, srcWindow, srcEditable, asset, crops,
//          cropKind, lastKnown }
//   attachmentKindOf(anchor) -> 'region' | 'snip' | 'image' (what the thread's attachments are, see below)
//   anchorLabel(anchor) -> the target label alone (also used for DomTarget labels)
//   elideDataUris(text) -> { text, elided }
//
// Line numbers and src come from the WORKING copy: the anchor (on `source`, i.e. head) is mapped through
// `workingMapper` (offsetMapper(head, working); computed when omitted and the texts differ); when its text is
// no longer at the mapped place, the nearest verbatim occurrence is used, else the mapped range (a range ending
// inside a changed hunk extends to the end of the hunk's new lines).
// src = full source lines of the anchor, extended by whole lines (below, then above, alternating) until the
// string is unique in the working file (srcUnique). More than 8 lines print as the first 3 lines,
// "...(N more lines)" and the last line (srcUnique: false, it is no longer a valid Edit old_string).
// When a line of the range is longer than 300 chars, src is instead the shortest unique window around the
// anchor, grown a word at a time (srcWindow: true; still an exact substring of the file).
// data: URIs with a payload of 64+ chars are elided as `data:image/png;base64,...(512 KB)` (media type and
// parameters kept; srcEditable: false).
// The result is capped at `maxChars` (LIMITS.threadSrcChars = 1200) per thread (srcUnique: false when cut).
// `on` is the rendered quote (<= 120 chars; for snips the visible text inside the box); `asset` is the absolute path
// (via absAssetPath) of the local file an element anchor references; `crops` are the thread's attachments as
// absolute paths (via absAttachmentPath), for every kind of anchor (GENERAL ones included). `cropKind` says what
// they are: 'region' (a crop of an image region: element / cell anchors with a region), 'snip' (the picture of a
// snipped area: snip anchors, or a GENERAL anchor made from a snip over nothing stamped), else 'image' (a screen
// snip or a pasted image).
// Orphaned anchors have no lines/src; `lastKnown` says where they were last found (label = its target label).

import { LIMITS } from '../../shared/protocol.js';
import { offsetMapper } from '../diff/index.js';
import { lineIndex, widenQuote } from '../text/index.js';
import { snipLabel } from './snip.js';
import { assetPathOf, oneLine } from './util.js';

/**
 * @typedef {import('../../shared/types.js').Anchor} Anchor
 * @typedef {import('../diff/offsets.js').OffsetMapper} OffsetMapper
 * @typedef {Object} AnchorDescription
 * @property {[number, number] | null} lines working-copy lines
 * @property {string} label
 * @property {string[]} section
 * @property {string|null} on
 * @property {string|null} src
 * @property {boolean} srcUnique
 * @property {boolean} srcWindow
 * @property {boolean} srcEditable
 * @property {string|null} asset
 * @property {string[]} crops
 * @property {'region' | 'snip' | 'image'} cropKind what the attachments are (attachmentKindOf)
 * @property {{ v: number, lines: [number, number], section: string[], text: string } | null} lastKnown orphans only:
 *   where the anchor was last found (for "(orphaned: was "..." in §5 v1 L260)")
 */

const MAX_LINES = 8;
const LONG_LINE = 300;
const ON_CHARS = 120;
const WINDOW_STEP = 32;
const DATA_URI = /data:([\w.+-]+\/[\w.+-]+)?((?:;[\w.+-]+(?:=[\w.+-]*)?)*?)(;base64)?,([A-Za-z0-9+/=%._~-]{64,})/g;

/**
 * @param {Anchor} anchor
 * @param {{ source: string, workingSource?: string|null, workingMapper?: OffsetMapper|null, format?: string,
 *           docPath?: string, absAttachmentPath?: ((rel: string) => string)|null,
 *           absAssetPath?: ((rel: string) => string)|null, attachments?: string[], maxChars?: number }} opts
 * @returns {AnchorDescription}
 */
export function describeAnchor(anchor, opts) {
  const source = String(opts?.source ?? '');
  const working = typeof opts?.workingSource === 'string' ? opts.workingSource : source;
  const maxChars = opts?.maxChars ?? LIMITS.threadSrcChars;
  const crops = (opts?.attachments ?? []).map((rel) => (opts?.absAttachmentPath ? opts.absAttachmentPath(rel) : rel));
  const assetRel = anchor.element ? assetPathOf({ a: anchor.element.attrs ?? {} }, opts?.docPath) : null;
  /** @type {AnchorDescription} */
  const base = {
    lines: null,
    label: anchorLabel(anchor),
    section: [...(anchor.section ?? [])],
    on: onOf(anchor),
    src: null,
    srcUnique: false,
    srcWindow: false,
    srcEditable: true,
    asset: assetRel ? (opts?.absAssetPath ? opts.absAssetPath(assetRel) : assetRel) : null,
    crops,
    cropKind: attachmentKindOf(anchor),
    lastKnown: null,
  };
  if (anchor.state === 'orphaned') {
    const lk = anchor.lastKnown ?? null;
    if (lk) {
      base.label = anchorLabel(lk);
      base.section = [...(lk.section ?? base.section)];
      base.lastKnown = {
        v: lk.v,
        lines: [lk.src.startLine, lk.src.endLine],
        section: [...(lk.section ?? [])],
        text: oneLine(lk.quote?.exact ? quoteText(lk) : lk.src.text, 60),
      };
    }
    return base;
  }
  if (anchor.kind === 'doc') return base;

  const [ws, we] = toWorking(anchor, source, working, opts?.workingMapper ?? null);
  const li = lineIndex(working);
  const a = li.lineOf(ws);
  const b = we > ws ? li.lineOf(we - 1) : a;
  base.lines = [a, b];

  let picked = longLineIn(working, li, a, b) ? windowAround(working, ws, we, maxChars) : linesAround(working, li, a, b, maxChars);
  if (!picked) picked = windowAround(working, ws, we, maxChars);
  const elided = elideDataUris(picked.text);
  let text = elided.text;
  let unique = picked.unique;
  if (text.length > maxChars) {
    text = `${text.slice(0, Math.max(0, maxChars - 16))}...(truncated)`;
    unique = false;
  }
  base.src = text;
  base.srcUnique = unique && !elided.elided;
  base.srcWindow = picked.window;
  base.srcEditable = !elided.elided;
  return base;
}

/**
 * The target label shown in packets and on DOM targets, e.g. `<img alt="System overview"> region x40-62% y10-30%`,
 * `mermaid node "API Gateway"`, `table cell row "refresh_token" x col "TTL" = "30 d"`, `§3 Tokens`, `GENERAL`,
 * `snip (figure + 2 paragraphs)`.
 * @param {Anchor} anchor
 */
export function anchorLabel(anchor) {
  const q = (/** @type {any} */ s) => JSON.stringify(oneLine(String(s ?? ''), 60));
  switch (/** @type {string} */ (anchor.kind)) {
    case 'snip':
      return snipLabel(/** @type {any} */ (anchor));
    case 'doc':
      return 'GENERAL';
    case 'section':
      return `§${oneLine(anchor.element?.text || anchor.section?.[anchor.section.length - 1] || 'section', 80)}`;
    case 'source':
      return 'source lines';
    case 'code': {
      const c = anchor.code;
      if (!c) return 'code';
      const lines = c.fromLine === c.toLine ? `line ${c.fromLine}` : `lines ${c.fromLine}-${c.toLine}`;
      return `code block${c.lang ? ` (${c.lang})` : ''} ${lines}`;
    }
    case 'cell': {
      const c = anchor.cell;
      const scope = anchor.scope ?? 'cell';
      if (!c) return anchor.element?.label ?? 'table cell';
      if (scope === 'row') return `table row ${q(c.rowKey)}`;
      if (scope === 'column') return `table column ${q(c.colHeader)}`;
      return `table cell row ${q(c.rowKey)} x col ${q(c.colHeader)}${c.text ? ` = ${q(c.text)}` : ''}`;
    }
    case 'element': {
      let label = anchor.element?.label ?? 'element';
      if (anchor.svg && anchor.generated) label = `mermaid node ${q(anchor.svg.label || anchor.svg.nodeId)}`;
      else if (anchor.svg) label = `${label} ${q(anchor.svg.label || anchor.svg.nodeId)}`;
      if (anchor.region) label += ` ${regionLabel(anchor.region)}`;
      return label;
    }
    default:
      if (anchor.generated) {
        const host = /** @type {any} */ (anchor).host;
        return `script-rendered text${host?.label ? ` inside ${host.label}` : ''}`;
      }
      return 'text';
  }
}

/**
 * What a thread's attachments show, from its anchor: 'region' (element / cell anchors with a region: the crop of
 * that region), 'snip' (snip anchors, and GENERAL anchors made from a snip: the picture of the snipped area), else
 * 'image' (a screen snip or a pasted image). Orphans answer for their last known anchor.
 * @param {Anchor | null | undefined} anchor
 * @returns {'region' | 'snip' | 'image'}
 */
export function attachmentKindOf(anchor) {
  if (!anchor) return 'image';
  const a = anchor.state === 'orphaned' && anchor.lastKnown ? anchor.lastKnown : anchor;
  if (/** @type {string} */ (a.kind) === 'snip' || /** @type {any} */ (a).snip) return 'snip';
  if ((a.kind === 'element' || a.kind === 'cell') && a.region) return 'region';
  return 'image';
}

/**
 * `region x40-62% y10-30%`
 * @param {{ x: number, y: number, w: number, h: number }} r
 */
export function regionLabel(r) {
  const pct = (/** @type {number} */ v) => Math.round(v * 100);
  return `region x${pct(r.x)}-${pct(r.x + r.w)}% y${pct(r.y)}-${pct(r.y + r.h)}%`;
}

/**
 * Replace long data: URIs with a short placeholder naming their type and size.
 * @param {string} text
 * @returns {{ text: string, elided: boolean }}
 */
export function elideDataUris(text) {
  let elided = false;
  const out = text.replace(DATA_URI, (_m, mime, params, b64, payload) => {
    elided = true;
    const bytes = b64 ? Math.floor((payload.replace(/=+$/, '').length * 3) / 4) : payload.length;
    return `data:${mime ?? ''}${params ?? ''}${b64 ? ';base64' : ''},...(${formatBytes(bytes)})`;
  });
  return { text: out, elided };
}

/** @param {number} n */
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The rendered quote / visible text of a target (<= 120 chars).
 * @param {Anchor} anchor
 * @returns {string|null}
 */
function onOf(anchor) {
  const last = anchor.state === 'orphaned' ? (anchor.lastKnown ?? anchor) : anchor;
  const snipText = /** @type {any} */ (last).snip?.text;
  switch (/** @type {string} */ (last.kind)) {
    case 'snip':
      return snipText ? oneLine(snipOn(snipText), ON_CHARS) : null;
    case 'doc':
      // a GENERAL anchor made from a selection of generated text outside every source element keeps its quote (a
      // snip over nothing stamped keeps the text inside its box)
      if (last.quote?.exact) return oneLine(quoteText(last), ON_CHARS);
      return snipText ? oneLine(snipOn(snipText), ON_CHARS) : null;
    case 'section':
      return null;
    case 'cell':
      return last.cell?.text ? oneLine(last.cell.text, ON_CHARS) : null;
    case 'element': {
      if (last.svg) return null;
      const t = /** @type {any} */ (last.element)?.text;
      return t ? oneLine(t, ON_CHARS) : null;
    }
    default:
      return last.quote?.exact ? oneLine(quoteText(last), ON_CHARS) : null;
  }
}

/**
 * Snips made before the guest dropped zero-width characters (KaTeX struts) can still hold them.
 * @param {string} text
 */
function snipOn(text) {
  return text.replace(/[\u200b-\u200d\u2060\ufeff]/g, '');
}

/**
 * The rendered quote, widened to whole words where the source shows the selection cut a word (display only).
 * @param {Pick<Anchor, 'quote' | 'src'>} a
 */
export function quoteText(a) {
  return widenQuote(a.quote, a.src);
}

// ------------------------------------------------------------------------------------------- working-copy range

/**
 * Map the anchor's range from `source` (head) to `working`.
 * @param {Anchor} anchor @param {string} source @param {string} working @param {OffsetMapper|null} mapper
 * @returns {[number, number]}
 */
function toWorking(anchor, source, working, mapper) {
  const { start, end, text } = anchor.src;
  if (working === source) return [Math.min(start, working.length), Math.min(end, working.length)];
  if (!mapper) mapper = offsetMapper(source, working);
  const m = mapper.mapOffset(start);
  if (!m.hunk && working.startsWith(text, m.off)) return [m.off, m.off + text.length];
  if (text) {
    const hit = nearestOccurrence(working, text, m.off);
    if (hit >= 0) return [hit, hit + text.length];
  }
  const me = mapper.mapOffset(end);
  const ws = m.off;
  let we = me.hunk ? me.hunk.newEndOff : me.off;
  while (we > ws && (working[we - 1] === '\n' || working[we - 1] === '\r')) we--;
  return [ws, Math.max(ws, we)];
}

/** @param {string} hay @param {string} needle @param {number} near */
function nearestOccurrence(hay, needle, near) {
  let best = -1;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
    if (i > near && best >= 0 && i - near > Math.abs(best - near)) break;
  }
  return best;
}

// ------------------------------------------------------------------------------------------------------- src text

/** @param {string} hay @param {string} s */
function isUnique(hay, s) {
  if (!s) return false;
  const i = hay.indexOf(s);
  return i >= 0 && hay.indexOf(s, i + 1) === -1;
}

/** @param {string} text @param {import('../text/lines.js').LineIndex} li @param {number} a @param {number} b */
function longLineIn(text, li, a, b) {
  for (let l = a; l <= b; l++) if (li.endOf(l) - li.startOf(l) > LONG_LINE) return true;
  return false;
}

/**
 * Whole lines a..b, extended until unique; shortened beyond MAX_LINES.
 * @param {string} working @param {import('../text/lines.js').LineIndex} li @param {number} a0 @param {number} b0
 * @param {number} maxChars
 * @returns {{ text: string, unique: boolean, window: boolean } | null} null when windowing is needed
 */
export function linesAround(working, li, a0, b0, maxChars) {
  const slice = (/** @type {number} */ a, /** @type {number} */ b) => working.slice(li.startOf(a), li.endOf(b));
  let a = a0;
  let b = b0;
  let text = slice(a, b);
  let unique = isUnique(working, text);
  let down = true;
  while (!unique && b - a + 1 < MAX_LINES) {
    const canDown = b < li.count && !longLineIn(working, li, b + 1, b + 1);
    const canUp = a > 1 && !longLineIn(working, li, a - 1, a - 1);
    if (!canDown && !canUp) break;
    if ((down && canDown) || !canUp) b++;
    else a--;
    down = !down;
    text = slice(a, b);
    unique = isUnique(working, text);
  }
  const count = b - a + 1;
  if (count > MAX_LINES) {
    const lines = text.split('\n');
    const shown = [...lines.slice(0, 3), `...(${count - 4} more lines)`, lines[lines.length - 1]].join('\n');
    return { text: shown, unique: false, window: false };
  }
  if (text.length > maxChars) return null;
  return { text, unique, window: false };
}

/**
 * The shortest unique substring around [ws, we), grown about a word at a time on each side.
 * @param {string} working @param {number} ws @param {number} we @param {number} maxChars
 * @returns {{ text: string, unique: boolean, window: boolean }}
 */
export function windowAround(working, ws, we, maxChars) {
  let lo = ws;
  let hi = we;
  let text = working.slice(lo, hi);
  while ((!text.trim() || !isUnique(working, text)) && (lo > 0 || hi < working.length) && hi - lo < maxChars) {
    lo = wordBoundaryBefore(working, lo);
    hi = wordBoundaryAfter(working, hi);
    text = working.slice(lo, hi);
  }
  return { text, unique: isUnique(working, text), window: true };
}

/** @param {string} s @param {number} i */
function wordBoundaryBefore(s, i) {
  let j = i - 1;
  while (j > 0 && i - j < WINDOW_STEP && /\s/.test(s[j])) j--;
  while (j > 0 && i - j < WINDOW_STEP && !/\s/.test(s[j - 1])) j--;
  return Math.max(0, j);
}

/** @param {string} s @param {number} i */
function wordBoundaryAfter(s, i) {
  let j = i + 1;
  while (j < s.length && j - i < WINDOW_STEP && /\s/.test(s[j - 1])) j++;
  while (j < s.length && j - i < WINDOW_STEP && !/\s/.test(s[j])) j++;
  return Math.min(s.length, j);
}
