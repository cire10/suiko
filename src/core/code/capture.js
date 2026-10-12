// @ts-check
// Captures on a code doc (design 4.7): a line range of one file side, a whole file, or the whole review.
//
//   {kind: 'line', file, side, startLine, endLine}  anchorFromLines on blob(file@v, side) + `file` + section [file]
//   {kind: 'file', file}                            a whole-file anchor (kind 'doc' with `file`; side 'old' for a
//                                                   deleted file): binary, too-large, deleted or skipped files
//   {kind: 'doc'}                                   a whole-review anchor (no file)
// Any other capture kind is refused (UsageError). Suggestions are for new-side line anchors only
// (codeSuggestionFor: mode 'lines', the anchored whole lines of the blob).

import { UsageError } from '../store/errors.js';
import { lineIndex } from '../text/index.js';
import { decodeText } from '../util/stable-read.js';
import { codeOf, fileAt, hasText, lineAnchor, notInRound, wholeAnchor } from './util.js';

/**
 * @typedef {import('../review/context.js').Ctx} Ctx
 * @typedef {import('../../shared/types.js').Doc} Doc
 * @typedef {import('../../shared/types.js').Anchor} Anchor
 * @typedef {import('../../shared/types.js').Capture} Capture
 * @typedef {import('../../shared/types.js').CodeFile} CodeFile
 * @typedef {import('../../shared/types.js').CodeManifest} CodeManifest
 * @typedef {{ label: string, lines: [number, number] | null, section: string[], src: string, text: string }} Preview
 */

/**
 * 'L3' or 'L3-4'.
 * @param {number} a
 * @param {number} b
 */
function linesText(a, b) {
  return a === b ? `L${a}` : `L${a}-${b}`;
}

/**
 * Why a file side has no text ('binary', 'too large', 'deleted', 'added').
 * @param {CodeFile} f
 * @param {'new' | 'old'} side
 */
function noTextReason(f, side) {
  if (f.binary) return 'a binary file';
  if (f.tooLarge) return 'too large to show';
  if (side === 'new' && f.status === 'D') return 'deleted (it has no new side)';
  if (side === 'old' && f.status === 'A') return 'added (it has no old side)';
  return 'not available';
}

/**
 * The kind adapter's capture for code docs (see the header).
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {Capture} capture
 * @param {number} v
 * @returns {Promise<{ anchor: Anchor, preview: Preview }>}
 */
export async function resolveCodeCapture(ctx, doc, capture, v) {
  const c = /** @type {any} */ (capture ?? {});
  if (c.kind === 'doc') {
    return { anchor: wholeAnchor(v, null), preview: { label: 'GENERAL', lines: null, section: [], src: '', text: 'Agent will see: GENERAL' } };
  }
  if (c.kind !== 'line' && c.kind !== 'file') {
    throw new UsageError(`code reviews take line, file or whole-review captures, not ${JSON.stringify(c.kind ?? null)}`, { details: { kind: c.kind ?? null } });
  }
  if (typeof c.file !== 'string' || !c.file) throw new UsageError('a code capture needs `file` (a repo-root-relative path of the round)');
  const code = codeOf((await ctx.store.readVersion(doc.id, v)).manifest);
  const f = fileAt(code, c.file);
  if (c.kind === 'file') {
    if (!f) {
      const sk = (code.skipped ?? []).find((s) => s.path === c.file);
      if (!sk) throw notInRound(c.file, v);
      const anchor = wholeAnchor(v, { path: sk.path, side: 'new' });
      return { anchor, preview: { label: `${sk.path} (whole file)`, lines: null, section: [sk.path], src: '', text: `Agent will see: ${sk.path} (whole file)` } };
    }
    const side = f.status === 'D' ? 'old' : 'new';
    const anchor = wholeAnchor(v, { path: f.path, side, ...(f.oldPath ? { oldPath: f.oldPath } : {}) });
    return { anchor, preview: { label: `${f.path} (whole file)`, lines: null, section: [f.path], src: '', text: `Agent will see: ${f.path} (whole file)` } };
  }
  if (!f) throw notInRound(c.file, v);
  if (c.side !== 'new' && c.side !== 'old') throw new UsageError(`a line capture needs side "new" or "old", not ${JSON.stringify(c.side ?? null)}`);
  /** @type {'new' | 'old'} */
  const side = c.side;
  if (!hasText(f, side)) throw new UsageError(`${f.path} (${side} side) is ${noTextReason(f, side)} in v${v}: comment on the whole file instead`, { details: { path: f.path, side } });
  const text = /** @type {string} */ (await readText(ctx, doc, /** @type {string} */ (f[side])));
  const count = lineIndex(text).count;
  const a = Number(c.startLine);
  const b = Number(c.endLine ?? c.startLine);
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < a) throw new UsageError(`invalid line range ${JSON.stringify([c.startLine, c.endLine])}`);
  if (b > count) throw new UsageError(`${f.path} (${side} side) has ${count} lines in v${v}; L${b} is past its end`, { details: { path: f.path, side, lines: count } });
  const anchor = lineAnchor({ v, text, startLine: a, endLine: b, file: { path: f.path, side, ...(f.oldPath ? { oldPath: f.oldPath } : {}) }, config: ctx.config });
  const label = side === 'old' ? `${f.path} (old side) ${linesText(a, b)}` : `${f.path}:${linesText(a, b)}`;
  const shown = side === 'old' ? `${f.path} (old side) base ${linesText(a, b)}` : `${f.path}:${linesText(a, b)}`;
  return { anchor, preview: { label, lines: [a, b], section: [f.path], src: previewSrc(anchor.src.text), text: `Agent will see: ${shown}` } };
}

/**
 * The first 3 lines of a capture, then '...(N more lines)'.
 * @param {string} text
 */
function previewSrc(text) {
  const all = String(text ?? '').split('\n');
  return all.length > 3 ? [...all.slice(0, 3), `...(${all.length - 3} more lines)`].join('\n') : all.join('\n');
}

/**
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {string} ref
 */
async function readText(ctx, doc, ref) {
  return decodeText(await ctx.store.readDocBlob(doc.id, ref)).text;
}

/**
 * The stored suggestion of a code draft: mode 'lines', `file` (new side only), `old` = the anchored whole lines of
 * that file at version `v`. The caller sets `new` (the reviewer's text), `status: 'pending'`, `appliedIn: null`.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {Anchor} anchor
 * @param {number} v
 * @returns {Promise<import('../../shared/types.js').Suggestion>}
 */
export async function codeSuggestionFor(ctx, doc, anchor, v) {
  const af = anchor?.file;
  if (!af || anchor.kind === 'doc' || anchor.state === 'orphaned') throw new UsageError('a suggestion needs lines of a file (a line capture on the new side)');
  if (af.side !== 'new') throw new UsageError('suggestions replace new-side lines; comment on old-side lines instead');
  const { manifest } = await ctx.store.readVersion(doc.id, v);
  const code = codeOf(manifest);
  const f = code.files.find((x) => x.path === af.path && x.status !== 'D');
  if (!f) throw notInRound(af.path, v);
  if (!hasText(f, 'new')) throw new UsageError(`${f.path} is ${noTextReason(f, 'new')} in v${v}: suggestions need text lines`);
  const text = /** @type {string} */ (await readText(ctx, doc, /** @type {string} */ (f.new)));
  const li = lineIndex(text);
  const startLine = Math.min(Math.max(1, anchor.src.startLine), li.count);
  const endLine = Math.min(Math.max(startLine, anchor.src.endLine), li.count);
  const start = li.startOf(startLine);
  const end = li.endOf(endLine);
  return /** @type {any} */ ({ mode: 'lines', file: f.path, version: v, start, end, startLine, endLine, old: text.slice(start, end) });
}
