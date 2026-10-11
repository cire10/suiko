// @ts-check
// Whitespace normalisation with a back-map to raw offsets.
//
// normalizeWs(s) collapses every run of whitespace (JS \s: spaces, tabs, newlines, NBSP, ...) to one ' ' and
// trims both ends. map[i] is the raw index of text[i]; a collapsed run maps to its first whitespace char.
// A raw half-open range for normalized [i, j) (j > i) is [map[i], map[j - 1] + 1).

/**
 * True when the UTF-16 code unit is whitespace in the JS `\s` sense.
 * @param {number} c
 */
export function isWsCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/**
 * @param {string} s
 * @returns {{ text: string, map: number[] }}
 */
export function normalizeWs(s) {
  /** @type {string[]} */
  const out = [];
  /** @type {number[]} */
  const map = [];
  let pendingWs = -1; // raw index of the first char of a pending whitespace run, -1 if none
  for (let i = 0; i < s.length; i++) {
    if (isWsCode(s.charCodeAt(i))) {
      if (pendingWs < 0) pendingWs = i;
      continue;
    }
    if (pendingWs >= 0) {
      if (out.length > 0) {
        out.push(' ');
        map.push(pendingWs);
      }
      pendingWs = -1;
    }
    out.push(s[i]);
    map.push(i);
  }
  return { text: out.join(''), map };
}

/**
 * Collapse whitespace runs to a single space without trimming (used for context strings, where a
 * boundary space is meaningful).
 * @param {string} s
 */
export function collapseWs(s) {
  return s.replace(/\s+/g, ' ');
}

/**
 * Remove all whitespace, keeping a back-map (used by markup-tolerant matching, which must not depend on
 * whitespace introduced or removed by markup such as table pipes or <br>).
 * @param {string} s
 * @param {ArrayLike<number>} [baseMap]  optional map applied on top (raw index of s[i])
 * @returns {{ text: string, map: number[] }}
 */
export function squeezeWs(s, baseMap) {
  /** @type {string[]} */
  const out = [];
  /** @type {number[]} */
  const map = [];
  for (let i = 0; i < s.length; i++) {
    if (isWsCode(s.charCodeAt(i))) continue;
    out.push(s[i]);
    map.push(baseMap ? baseMap[i] : i);
  }
  return { text: out.join(''), map };
}
