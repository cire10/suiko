// @ts-check
// Small display helpers shared by packets, revise reports, `show`, `threads` and the composer preview: section
// paths ('3 Tokens > 3.2 Token refresh'), line labels ('L42-43'), quoting and truncation. Target labels of
// anchors ('<img alt="...">', 'mermaid node "X"', 'GENERAL') come from the anchor library (anchoring.label).

import { formatRange } from '../util/lines-arg.js';

const MAX_TEXT = 40;

/**
 * Section path for display: '3 Tokens > 3.2 Token refresh'. A leading heading that names the doc (it adds nothing)
 * is dropped: equal to the doc title, or a word-prefix of it or vice versa ('Rate Limiter Service' under the title
 * 'Rate Limiter Service Spec', 'Ops Dashboard' under 'Ops Dashboard Spec'). Empty when the anchor precedes every
 * heading.
 * @param {string[] | null | undefined} section
 * @param {string} [title]
 * @returns {string}
 */
export function sectionPath(section, title) {
  const parts = [...(section ?? [])];
  if (parts.length > 1 && title && namesDoc(parts[0], title)) parts.shift();
  return parts.join(' > ');
}

/**
 * Whether a top heading names the doc: same words as the title, or the words of one start the other's.
 * @param {string} heading
 * @param {string} title
 */
function namesDoc(heading, title) {
  if (norm(heading) === norm(title)) return true;
  const a = words(heading);
  const b = words(title);
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((w, i) => w === long[i]);
}

/** @param {string} s */
function words(s) {
  return String(s ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * The innermost heading only: '3.2 Token refresh' (for compact tables).
 * @param {string[] | null | undefined} section
 * @returns {string}
 */
export function sectionLeaf(section) {
  const parts = section ?? [];
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * 'L42-43' for an inclusive range, '' for null.
 * @param {[number, number] | number[] | null | undefined} lines
 * @returns {string}
 */
export function linesLabel(lines) {
  return lines && lines.length ? formatRange(lines) : '';
}

/**
 * Quotes a short string for labels ("..." with inner quotes escaped, truncated).
 * @param {string} s
 * @param {number} [max]
 * @returns {string}
 */
export function quote(s, max = MAX_TEXT) {
  return `"${truncate(String(s ?? '').replace(/\s+/g, ' ').trim(), max).replace(/"/g, '\\"')}"`;
}

/**
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
export function truncate(s, max) {
  const str = String(s ?? '');
  return str.length > max ? `${str.slice(0, Math.max(1, max - 1))}…` : str;
}

/** @param {string} s */
function norm(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}
