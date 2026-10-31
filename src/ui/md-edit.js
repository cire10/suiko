// @ts-check
// Markdown formatting of a plain textarea: the text edits behind the formatting toolbar and its keys
// (components/MarkdownTextarea.js). Bold wraps the selection or the word under the caret and takes the markers off
// again; the list commands turn whole lines into bullets or numbers and back; Enter continues a list. Each function
// takes the text and its selection and returns one replacement, which the component applies so that the browser's
// undo history keeps it. No DOM and no store access, so the same functions run in the browser and in Node tests.

/**
 * What a textarea holds.
 * @typedef {{ value: string, start: number, end: number }} TextState
 */

/**
 * Replace [from, to) with `text`, then select [start, end] (from === to and no text: only the selection moves).
 * @typedef {{ from: number, to: number, text: string, start: number, end: number }} TextEdit
 */

const BOLD = '**';
/** A list item's indent and marker (the marker needs a space after it, like in Markdown): indent, bullet | number, delimiter. */
const LIST_ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))[ \t]+/;
/** Bold text on one line, as Markdown reads it: no space just inside the markers. */
const BOLD_SPAN = /\*\*(?=\S)(.+?)(?<=\S)\*\*(?!\*)/g;
const WORD_END = /[\p{L}\p{N}_]+$/u;
const WORD_START = /^[\p{L}\p{N}_]+/u;

/** @param {string} value @param {number} i */
function lineStart(value, i) {
  return i <= 0 ? 0 : value.lastIndexOf('\n', i - 1) + 1;
}

/** @param {string} value @param {number} i */
function lineEnd(value, i) {
  const n = value.indexOf('\n', i);
  return n < 0 ? value.length : n;
}

/**
 * Bold on or off.
 * @param {TextState} state
 * @returns {TextEdit}
 */
export function toggleBold({ value, start, end }) {
  if (start === end) return boldAtCaret(value, start);
  const selected = value.slice(start, end);
  // Inside bold text (wrapping leaves its text selected): the markers come off, the same letters stay selected.
  const lineFrom = lineStart(value, start);
  for (const m of value.slice(lineFrom, lineEnd(value, start)).matchAll(BOLD_SPAN)) {
    const open = lineFrom + m.index;
    const close = open + m[0].length;
    if (start >= open + 2 && end <= close - 2) return { from: open, to: close, text: m[1], start: start - 2, end: end - 2 };
  }
  if (!selected.trim()) return boldAtCaret(value, end);
  const lines = selected.split('\n').map(splitLine);
  const filled = lines.filter((l) => l.core);
  const off = filled.every((l) => l.core.length > 4 && l.core.startsWith(BOLD) && l.core.endsWith(BOLD));
  for (const l of filled) l.core = off ? l.core.slice(2, -2) : l.core.replaceAll(BOLD, '');
  const text = lines.map((l) => (l.core ? `${l.lead}${off ? '' : BOLD}${l.core}${off ? '' : BOLD}${l.trail}` : `${l.lead}${l.trail}`)).join('\n');
  if (lines.length > 1) return { from: start, to: end, text, start, end: start + text.length };
  // One line: the text stays selected, without its markers, so that typing keeps it bold and pressing again undoes it.
  const inner = start + lines[0].lead.length + (off ? 0 : 2);
  return { from: start, to: end, text, start: inner, end: inner + lines[0].core.length };
}

/**
 * One selected line split into what stays outside the markers (indent, list marker, surrounding spaces: Markdown does
 * not read `**word **` as bold) and the text to make bold.
 * @param {string} line
 */
function splitLine(line) {
  const lead = (line.match(LIST_ITEM) || line.match(/^[ \t]*/))?.[0] ?? '';
  const rest = line.slice(lead.length);
  const core = rest.trimEnd();
  return { lead, core, trail: rest.slice(core.length) };
}

/**
 * Bold with nothing selected: toggles the bold text the caret touches (at the end of bold text the caret steps past the
 * closing marker instead, so that "bold, type, bold, type" works), makes the word around the caret bold, or inserts
 * empty markers for the text about to be typed.
 * @param {string} value
 * @param {number} pos
 * @returns {TextEdit}
 */
function boldAtCaret(value, pos) {
  if (pos >= 2 && value.slice(pos - 2, pos + 2) === BOLD + BOLD) return { from: pos - 2, to: pos + 2, text: '', start: pos - 2, end: pos - 2 };
  const from = lineStart(value, pos);
  const to = lineEnd(value, pos);
  const col = pos - from;
  for (const m of value.slice(from, to).matchAll(BOLD_SPAN)) {
    const open = m.index;
    const close = open + m[0].length;
    if (col < open || col > close) continue;
    if (col === close - 2) return { from: pos, to: pos, text: '', start: pos + 2, end: pos + 2 };
    const caret = from + open + Math.max(0, Math.min(col - open - 2, m[1].length));
    return { from: from + open, to: from + close, text: m[1], start: caret, end: caret };
  }
  const before = value.slice(from, pos).match(WORD_END)?.[0] ?? '';
  const after = value.slice(pos, to).match(WORD_START)?.[0] ?? '';
  if (before && after) {
    return { from: pos - before.length, to: pos + after.length, text: `${BOLD}${before}${after}${BOLD}`, start: pos + 2, end: pos + 2 };
  }
  return { from: pos, to: pos, text: BOLD + BOLD, start: pos + 2, end: pos + 2 };
}

/** @param {string} line */
function parseItem(line) {
  const m = line.match(LIST_ITEM);
  if (!m) {
    const indent = line.match(/^[ \t]*/)?.[0] ?? '';
    return { indent, kind: null, number: 0, prefix: indent.length, text: line.slice(indent.length) };
  }
  return { indent: m[1], kind: m[2] ? 'bullet' : 'number', number: Number(m[3]), prefix: m[0].length, text: line.slice(m[0].length) };
}

/**
 * Bullets or numbers on the lines of the selection, or off when they all have them already. A line of the other kind
 * of list is converted. Numbers count from 1, or on from a numbered item right above; blank lines stay blank (unless
 * the caret is on one: that starts a list).
 * @param {TextState} state
 * @param {'bullet'|'number'} kind
 * @returns {TextEdit}
 */
export function toggleList({ value, start, end }, kind) {
  const from = lineStart(value, start);
  // A selection that ends right after a line break does not touch the next line.
  const to = lineEnd(value, end > start && value[end - 1] === '\n' ? end - 1 : end);
  const items = value.slice(from, to).split('\n').map(parseItem);
  const filled = items.filter((it) => it.kind || it.text);
  const off = filled.length > 0 && filled.every((it) => it.kind === kind);
  const above = from > 0 ? parseItem(value.slice(lineStart(value, from - 1), from - 1)) : null;
  let number = above?.kind === 'number' && above.indent === items[0].indent ? above.number + 1 : 1;
  const lines = items.map((it) => {
    if (filled.length > 0 && !it.kind && !it.text) return it.indent;
    if (off) return `${it.indent}${it.text}`;
    return `${it.indent}${kind === 'bullet' ? '-' : `${number++}.`} ${it.text}`;
  });
  const text = lines.join('\n');
  if (start !== end) return { from, to, text, start: from, end: from + text.length };
  // The caret stays in the same place in the line's text.
  const prefix = lines[0].length - items[0].text.length;
  const caret = from + prefix + Math.max(0, start - from - items[0].prefix);
  return { from, to, text, start: caret, end: caret };
}

/**
 * Enter in a list: the next item, or, on an item with no text, the end of the list. Ending it leaves a blank line
 * after the items, since Markdown would read the next line as part of the last item.
 * @param {TextState} state
 * @returns {TextEdit|null} null: Enter does what it always does
 */
export function continueList({ value, start, end }) {
  if (start !== end) return null;
  const from = lineStart(value, start);
  const to = lineEnd(value, start);
  const line = value.slice(from, to);
  const m = line.match(LIST_ITEM);
  if (!m || start - from < m[0].length) return null;
  if (!line.slice(m[0].length).trim()) {
    const afterItem = from > 0 && !!parseItem(value.slice(lineStart(value, from - 1), from - 1)).kind;
    const text = afterItem ? '\n' : '';
    return { from, to, text, start: from + text.length, end: from + text.length };
  }
  const text = `\n${m[1]}${m[2] || `${Number(m[3]) + 1}${m[4]}`} `;
  return { from: start, to: start, text, start: start + text.length, end: start + text.length };
}

/**
 * The formatting command a key press in the textarea is, if any. On a Mac only Cmd: Ctrl+B moves the caret back there.
 * The digits go by physical key, since Shift+7 types another character on most layouts.
 * @param {{ key?: string, code?: string, metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean, altKey?: boolean }} e
 * @param {boolean} mac
 * @returns {'bold'|'bullet'|'number'|null}
 */
export function formatKey(e, mac) {
  if (!(mac ? e.metaKey : e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (!e.shiftKey) return String(e.key).toLowerCase() === 'b' ? 'bold' : null;
  if (e.code === 'Digit8') return 'bullet';
  return e.code === 'Digit7' ? 'number' : null;
}
