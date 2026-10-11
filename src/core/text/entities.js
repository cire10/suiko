// @ts-check
// HTML character-reference decoding without extra dependencies.
//
// parse5 (a direct dependency) implements the full WHATWG named-reference table, so a single reference is
// decoded by parsing it as a text-only fragment. Results are memoised; references are short and repetitive.

import { parseFragment } from 'parse5';

/** Matches one character reference at the start of a string (named, decimal or hex; ';' optional). */
export const ENTITY_RE = /^&(?:#[0-9]{1,8};?|#[xX][0-9a-fA-F]{1,8};?|[A-Za-z][A-Za-z0-9]{1,31};?)/;

/** @type {Map<string, string>} */
const cache = new Map();

/**
 * Decode one character reference such as "&amp;" or "&#x2014;". Returns the input unchanged when it is not a
 * known reference.
 * @param {string} ref
 * @returns {string}
 */
export function decodeEntity(ref) {
  let out = cache.get(ref);
  if (out !== undefined) return out;
  const frag = parseFragment(ref.replace(/</g, '&lt;'));
  out = '';
  for (const n of frag.childNodes) if ('value' in n && typeof n.value === 'string') out += n.value;
  if (cache.size > 4096) cache.clear();
  cache.set(ref, out);
  return out;
}

/**
 * Match a character reference at `src[i]` (which must be '&').
 * @param {string} src
 * @param {number} i
 * @param {{ requireSemicolon?: boolean }} [opts]  Markdown (CommonMark) requires the ';'.
 * @returns {{ end: number, text: string } | null}  end = index just past the reference
 */
export function matchEntityAt(src, i, opts = {}) {
  const m = ENTITY_RE.exec(src.slice(i, i + 42));
  if (!m) return null;
  const raw = m[0];
  if (opts.requireSemicolon && !raw.endsWith(';')) return null;
  const text = decodeEntity(raw);
  if (text === raw || text === '') return null;
  // A legacy reference may decode only a prefix (e.g. "&notit;" -> "¬it;"): keep the decoded prefix and
  // consume exactly the characters it stands for.
  const tailLen = commonSuffixLen(text, raw);
  return { end: i + raw.length - tailLen, text: text.slice(0, text.length - tailLen) };
}

/**
 * Decode every character reference in a string.
 * @param {string} s
 * @param {{ requireSemicolon?: boolean }} [opts]
 */
export function decodeEntities(s, opts = {}) {
  if (!s.includes('&')) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const amp = s.indexOf('&', i);
    if (amp < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, amp);
    const m = matchEntityAt(s, amp, opts);
    if (m) {
      out += m.text;
      i = m.end;
    } else {
      out += '&';
      i = amp + 1;
    }
  }
  return out;
}

/**
 * @param {string} a
 * @param {string} b
 */
function commonSuffixLen(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n] && n < a.length - 1) n++;
  // Only treat the suffix as "undecoded tail" when it is not part of the decoded character itself.
  return n > 0 && b.length - n > 1 ? n : 0;
}
