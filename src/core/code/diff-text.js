// @ts-check
// The canonical diff text of a round (design 4.5): the version source of a code doc. Suiko generates it from the
// file sides (never from `git diff`), so its bytes depend only on the contents, the spec and the base: no timestamps,
// no repo config (colours, prefixes, external diff), files sorted by path. "Nothing changed" is the existing check
// that its sha256 equals head's; a moved base changes the header, so it records a round even when the per-file
// diffs are identical.
//
//   suiko code review · since-base origin/main (merge-base 1a2b3c4d5e6f) .. working tree
//   files: 5 · +120 -30 · skipped: assets/logo.png (binary)
//
//   diff --suiko a/src/auth/refresh.js b/src/auth/refresh.js
//   status: M
//   --- a/src/auth/refresh.js
//   +++ b/src/auth/refresh.js
//   @@ -38,6 +38,10 @@
//   ...

import { unifiedPatch } from '../diff/index.js';
import { specLabel } from './spec.js';

/**
 * @typedef {import('../../shared/types.js').CodeSpec} CodeSpec
 * @typedef {import('../../shared/types.js').CodeManifest} CodeManifest
 * @typedef {import('../../shared/types.js').CodeFile} CodeFile
 */

/** How a skipped file is named in texts. */
export const SKIP_LABEL = /** @type {Record<string, string>} */ ({
  binary: 'binary',
  'too-large': 'too large',
  submodule: 'submodule',
  excluded: 'excluded: looks like a secret',
  'unsupported-name': 'unsupported file name',
});

/**
 * 'assets/logo.png (binary), .env (excluded: looks like a secret)'.
 * @param {CodeManifest['skipped']} skipped
 * @returns {string}
 */
export function skippedText(skipped) {
  return skipped.map((s) => `${s.path} (${SKIP_LABEL[s.reason] ?? s.reason})`).join(', ');
}

/**
 * Totals of a round: files, added and removed lines.
 * @param {CodeFile[]} files
 */
export function codeStats(files) {
  return {
    files: files.length,
    added: files.reduce((n, f) => n + (f.added || 0), 0),
    removed: files.reduce((n, f) => n + (f.removed || 0), 0),
  };
}

/**
 * The canonical text of a round.
 * @param {CodeSpec} spec
 * @param {CodeManifest} code
 * @param {(ref: string | undefined) => string | null} textOf the decoded text of a blob ref (null: none)
 * @returns {string}
 */
export function canonicalText(spec, code, textOf) {
  const st = codeStats(code.files);
  const head = [`suiko code review · ${specLabel(spec, code, { abbrev: 12 })}`];
  head.push(`files: ${st.files} · +${st.added} -${st.removed}${code.skipped.length ? ` · skipped: ${skippedText(code.skipped)}` : ''}`);
  const blocks = [head.join('\n')];
  const files = [...code.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of files) blocks.push(fileBlock(f, spec.context, textOf, code.skipped));
  return `${blocks.join('\n\n')}\n`;
}

/**
 * @param {string} id a git object id or 'sha256:<hex>'
 * @returns {string}
 */
function shortId(id) {
  return id.replace(/^sha256:/, '').slice(0, 12);
}

/**
 * One file's block.
 * @param {CodeFile} f
 * @param {number} context
 * @param {(ref: string | undefined) => string | null} textOf
 * @param {CodeManifest['skipped']} skipped
 * @returns {string}
 */
function fileBlock(f, context, textOf, skipped) {
  const oldName = f.status === 'A' ? null : (f.oldPath ?? f.path);
  const newName = f.status === 'D' ? null : f.path;
  const out = [`diff --suiko a/${oldName ?? f.path} b/${newName ?? f.path}`, `status: ${f.status}`];
  if (f.mode?.old && f.mode?.new && f.mode.old !== f.mode.new) out.push(`mode: ${f.mode.old} -> ${f.mode.new}`);
  else if (f.status === 'A' && f.mode?.new && f.mode.new !== '100644') out.push(`mode: ${f.mode.new}`);
  const skip = skipped.find((s) => s.path === f.path);
  if (skip?.reason === 'submodule') {
    const sm = /** @type {any} */ (skip);
    out.push(`submodule ${sm.old ? sm.old.slice(0, 12) : '(none)'} -> ${sm.new ? sm.new.slice(0, 12) : '(none)'}`);
    return out.join('\n');
  }
  const ids = /** @type {any} */ (f).ids;
  const idText = ids ? ` (${ids.old ? shortId(ids.old) : 'none'} -> ${ids.new ? shortId(ids.new) : 'none'})` : '';
  if (f.binary) {
    out.push(`binary file${idText}`);
    return out.join('\n');
  }
  if (f.tooLarge) {
    out.push(`too large (${f.tooLarge.side} side${f.tooLarge.bytes != null ? `: ${f.tooLarge.bytes} bytes` : ', not available'})${idText}`);
    return out.join('\n');
  }
  if (f.status === '=') {
    out.push('unchanged against base (kept: open threads live here)');
    return out.join('\n');
  }
  const a = f.old ? textOf(f.old) ?? '' : '';
  const b = f.new ? textOf(f.new) ?? '' : '';
  const fromLabel = oldName ? `a/${oldName}` : '/dev/null';
  const toLabel = newName ? `b/${newName}` : '/dev/null';
  const patch = unifiedPatch(a, b, { fromLabel, toLabel, context });
  if (patch) out.push(patch.replace(/\n$/, ''));
  else out.push(`--- ${fromLabel}`, `+++ ${toLabel}`);
  return out.join('\n');
}
