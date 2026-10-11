// @ts-check
// File-level building blocks of the multi-agent installer (src/cli/install/agents.js). Every helper computes one
// FileAction (src/cli/install.js) from the file on disk without writing anything; applyPlan() writes them.
//
// Ownership rules (what "ours" means, so install never clobbers and uninstall removes only what install added):
//   - Markdown: the text between our marker comments (`<!-- specreview:begin ... -->` .. `<!-- specreview:end -->`).
//     Nothing outside the markers is ever rewritten; markers that are not one well-formed pair are refused.
//   - TOML (Codex's config.toml): the marker lines and the [mcp_servers.specreview] table between them, nothing else
//     (Codex adds its own tables inside the markers; see toml.js).
//   - JSON: one named entry (e.g. mcpServers.specreview) or the hook commands that run specreview. The file is parsed,
//     only that entry changes, and a file that is not valid JSON is refused (InstallRefusal), never overwritten.
//   - Whole files we copy (skills, commands): ours when the content is what we install now, or what an earlier install
//     wrote (sha256 in the install manifest, $SPECREVIEW_HOME/install-manifest.json). Uninstall keeps a copy the user
//     edited and says so.
// A file we modify that existed before gets a one-time backup, <file>.specreview-backup (applyPlan with backups); a
// file of the user's that a copy replaces is backed up every time it differs from the last backup.
// Files are written through symlinks (the link stays, its target changes), and uninstall deletes a config file only
// when install created it (recorded in the manifest), never one that was there before or is a symlink.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { SpecReviewError } from '../../core/store/errors.js';
import { EXIT } from '../../shared/protocol.js';
import { TomlScanError, definitionsOutside, findTomlBlock, removeTomlBlock, upsertTomlBlock } from './toml.js';

export const MD_BEGIN = '<!-- specreview:begin';
export const MD_END = '<!-- specreview:end -->';
export const TOML_BEGIN = '# specreview:begin';
export const TOML_END = '# specreview:end';
export const BACKUP_SUFFIX = '.specreview-backup';

/** @typedef {import('../install.js').FileAction} FileAction */

/**
 * A file the installer must not touch (invalid JSON, a conflicting entry it does not own...). The agent's other
 * changes still go ahead; the refusal is reported with `fix` (what to do by hand).
 */
export class InstallRefusal extends SpecReviewError {
  /**
   * @param {string} file
   * @param {string} message
   * @param {string} [fix]
   */
  constructor(file, message, fix) {
    super(message, { exit: EXIT.ERROR, code: 'INSTALL_REFUSED', details: { file, ...(fix ? { fix } : {}) } });
    /** @type {string} */
    this.file = file;
    /** @type {string | undefined} */
    this.fix = fix;
  }
}

/**
 * @param {string} file
 * @returns {string | null} the file's text, or null when it does not exist (or is not a readable file)
 */
export function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------------------------------------------------------
// Install manifest: sha256 of every whole file we wrote, so a later install or uninstall recognises our older copies.

/**
 * @typedef {{ schema: 1, files: Record<string, { sha256: string[] }>, created: string[] }} Manifest
 * `created`: config files install created (uninstall may delete them once only SpecReview's part is left).
 */

/**
 * @param {string | undefined} file
 * @returns {Manifest}
 */
export function loadManifest(file) {
  /** @type {Manifest} */
  const empty = { schema: 1, files: {}, created: [] };
  if (!file) return empty;
  const text = readTextOrNull(file);
  if (!text) return empty;
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && value.files && typeof value.files === 'object') {
      const created = Array.isArray(value.created) ? value.created.filter((/** @type {unknown} */ x) => typeof x === 'string') : [];
      return { schema: 1, files: value.files, created };
    }
  } catch {
    // a damaged manifest only costs us the "older copy" recognition
  }
  return empty;
}

/**
 * Records written copies and created files, forgets deleted ones, then saves the manifest atomically.
 * @param {string} file
 * @param {{ written: Array<{ path: string, content: string }>, deleted: string[], created?: string[] }} change
 */
export function updateManifest(file, change) {
  const manifest = loadManifest(file);
  for (const w of change.written) {
    const list = manifest.files[w.path]?.sha256 ?? [];
    const h = sha256(w.content);
    manifest.files[w.path] = { sha256: [h, ...list.filter((x) => x !== h)].slice(0, 20) };
  }
  const created = new Set([...manifest.created, ...(change.created ?? [])]);
  for (const p of change.deleted) {
    delete manifest.files[p];
    created.delete(p);
  }
  manifest.created = [...created].sort();
  writeAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * @param {string} file
 * @returns {boolean}
 */
export function isSymlink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Whether install created this file (so uninstall may delete it): recorded in the manifest, and not a symlink (a
 * symlinked config belongs to a dotfiles setup, whatever the manifest says).
 * @param {string} file
 * @param {Manifest | undefined} manifest
 * @returns {boolean}
 */
export function createdByUs(file, manifest) {
  return Boolean(manifest?.created.includes(file)) && !isSymlink(file);
}

/**
 * mkdir -p + write to a temp file + rename. A symlink is written through: the temp file goes next to the link's
 * target and replaces the target, so the link (stow, home-manager, chezmoi...) stays. A dangling link is refused.
 * @param {string} file
 * @param {string} content
 */
export function writeAtomic(file, content) {
  if (isSymlink(file)) {
    try {
      file = fs.realpathSync(file);
    } catch {
      throw new Error(`${file} is a symlink to a missing file (${fs.readlinkSync(file)}); SpecReview does not replace the link`);
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  let mode;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    mode = undefined;
  }
  fs.writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------------------------------------------
// Whole-file copies.

/**
 * @typedef {object} CopyOpts
 * @property {string} [source] integration file the content comes from (for the listing)
 * @property {string} [template] the content without the not-on-PATH invocation note (recognises our copies)
 * @property {Manifest} [manifest]
 * @property {string} [share] shared-resource tag (one file written for several agents)
 * @property {string} [note]
 */

/**
 * Whether `current` is a copy we wrote: the content we would write now, the template without (or with another)
 * invocation note, or a version recorded in the manifest.
 * @param {string} file
 * @param {string} current
 * @param {string} content
 * @param {CopyOpts} o
 * @returns {boolean}
 */
export function isOurCopy(file, current, content, o) {
  if (current === content) return true;
  if (o.template !== undefined && (current === o.template || stripInvocationNote(current) === stripInvocationNote(content))) return true;
  return Boolean(o.manifest?.files[file]?.sha256.includes(sha256(current)));
}

/**
 * Removes the "not on PATH" note that withInvocationNote() inserts (any node/script path).
 * @param {string} text
 * @returns {string}
 */
export function stripInvocationNote(text) {
  return text.replace(/^> \*\*On this machine `specreview` is not on PATH\.\*\*[^\n]*\n> [^\n]*\n/m, '');
}

/**
 * Install a whole file. An existing file that is not our copy (an older or edited one) is backed up before it is replaced.
 * @param {string} file
 * @param {string} content
 * @param {CopyOpts} [o]
 * @returns {FileAction}
 */
export function copyAction(file, content, o = {}) {
  const current = readTextOrNull(file);
  /** @type {FileAction} */
  const a = {
    path: file,
    action: current === null ? 'create' : current === content ? 'unchanged' : 'update',
    content,
    record: true,
    ...(o.source ? { source: o.source } : {}),
    ...(o.share ? { share: o.share } : {}),
    ...(o.note ? { note: o.note } : {}),
  };
  if (a.action === 'update' && current !== null && !isOurCopy(file, current, content, o)) {
    // The user's file is replaced: back it up, every time it differs from the last backup (not just once).
    const once = `${file}${BACKUP_SUFFIX}`;
    const prev = readTextOrNull(once);
    let what;
    if (prev === current) {
      what = `its current content is already in ${path.basename(once)}`;
    } else {
      a.backupPath = prev === null ? once : stampedBackupPath(file);
      what = `backed up to ${path.basename(a.backupPath)}`;
    }
    a.note = `${a.note ? `${a.note}; ` : ''}replaces an older or edited copy (${what})`;
  }
  return a;
}

/**
 * <file>.specreview-backup-<UTC timestamp>, unused.
 * @param {string} file
 * @returns {string}
 */
export function stampedBackupPath(file) {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
  let p = `${file}${BACKUP_SUFFIX}-${stamp}`;
  for (let k = 2; fs.existsSync(p); k++) p = `${file}${BACKUP_SUFFIX}-${stamp}-${k}`;
  return p;
}

/**
 * Uninstall a whole file: delete it when it is still our copy, keep it (action unchanged + note) when it was edited.
 * @param {string} file
 * @param {string} content what install would write now
 * @param {CopyOpts & { rmdirs?: string[] }} [o]
 * @returns {FileAction | null} null when the file does not exist
 */
export function removeCopyAction(file, content, o = {}) {
  const current = readTextOrNull(file);
  if (current === null) return null;
  if (isOurCopy(file, current, content, o)) {
    return { path: file, action: 'delete', content: '', ...(o.rmdirs ? { rmdirs: o.rmdirs } : {}), ...(o.share ? { share: o.share } : {}), note: 'installed by SpecReview' };
  }
  return { path: file, action: 'unchanged', content: current, kept: true, note: 'kept: changed since SpecReview installed it (delete it yourself if you no longer need it)' };
}

// ---------------------------------------------------------------------------------------------------------------
// Marker blocks (Markdown and TOML).

/**
 * @typedef {{ begin: string, end: string }} Markers
 */
export const MD_MARKERS = { begin: MD_BEGIN, end: MD_END };
export const TOML_MARKERS = { begin: TOML_BEGIN, end: TOML_END };

/**
 * Location of our block in a text: [start, end) covering the begin line through the end marker.
 * @param {string} text
 * @param {Markers} m
 * @returns {{ start: number, end: number } | null}
 */
export function findBlock(text, m) {
  const re = new RegExp(`^[ \\t]*${escapeRe(m.begin)}`, 'm');
  const hit = re.exec(text);
  if (!hit) return null;
  const start = hit.index;
  const endRe = new RegExp(`^[ \\t]*${escapeRe(m.end)}[^\\n]*`, 'm');
  const rest = text.slice(start);
  const endHit = endRe.exec(rest);
  if (!endHit) return null;
  return { start, end: start + endHit.index + endHit[0].length };
}

/**
 * Refuses markers that are not one well-formed pair: several begin lines, a begin line without an end line after it,
 * or an end line without a begin line. Guessing where the block ends could delete the user's text.
 * @param {string} file
 * @param {string} text
 * @param {Markers} m
 */
export function checkMarkers(file, text, m) {
  const at = (/** @type {string} */ marker) => [...text.matchAll(new RegExp(`^[ \\t]*${escapeRe(marker)}`, 'gm'))].map((x) => x.index ?? 0);
  const begins = at(m.begin);
  const ends = at(m.end);
  let problem = null;
  if (begins.length > 1) problem = `it has ${begins.length} "${m.begin}" lines`;
  else if (begins.length === 1 && !ends.some((e) => e > begins[0])) problem = `its "${m.begin}" line has no "${m.end}" line after it`;
  else if (ends.length > (begins.length ? 1 : 0)) problem = begins.length ? `it has ${ends.length} "${m.end}" lines` : `it has a "${m.end}" line but no "${m.begin}" line`;
  if (!problem) return;
  throw new InstallRefusal(
    file,
    `${file}: ${problem}, so where SpecReview's block ends is unclear; the file is left as is`,
    `repair the markers by hand (one "${m.begin} ... -->" line and one "${m.end}" line around the SpecReview block, or delete the block with both markers), then re-run`,
  );
}

/**
 * Inserts (appends) or replaces our block. `block` starts with the begin marker and ends with the end marker.
 * @param {string | null} current
 * @param {string} block
 * @param {Markers} m
 * @returns {string}
 */
export function upsertBlock(current, block, m) {
  if (current === null || current.trim() === '') return `${block}\n`;
  const at = findBlock(current, m);
  if (at) return `${current.slice(0, at.start)}${block}${current.slice(at.end)}`;
  return `${current.replace(/\s+$/, '')}\n\n${block}\n`;
}

/**
 * Removes our block (the inverse of upsertBlock): the blank lines it was separated by go with it.
 * @param {string} current
 * @param {Markers} m
 * @returns {string | null} the new text, or null when there is no block
 */
export function removeBlock(current, m) {
  const at = findBlock(current, m);
  if (!at) return null;
  const before = current.slice(0, at.start).replace(/\s+$/, '');
  const after = current.slice(at.end).replace(/^\s+/, '');
  if (!before) return after;
  if (!after) return `${before}\n`;
  return `${before}\n\n${after}`;
}

/**
 * @typedef {object} BlockOpts
 * @property {string} [source] integration file the block comes from
 * @property {string} [share]
 * @property {string} [what] e.g. 'the SpecReview protocol block'
 * @property {boolean} [showBlock] print the block in the dry run (small blocks such as the TOML table)
 */

/**
 * Install our block into a Markdown/TOML file (created when missing).
 * @param {string} file
 * @param {string} block
 * @param {Markers} m
 * @param {BlockOpts} [o]
 * @returns {FileAction}
 */
export function blockAction(file, block, m, o = {}) {
  const current = readTextOrNull(file);
  if (current !== null) checkMarkers(file, current, m);
  const content = upsertBlock(current, block, m);
  const what = o.what ?? 'the SpecReview block';
  const lines = block.split('\n').length;
  const from = o.source ? ` from ${o.source}` : '';
  const note =
    current === null
      ? `new file with ${what}${from} (${lines} lines)`
      : current.trim() === ''
        ? `fills the empty file with ${what}${from} (${lines} lines)`
        : findBlock(current, m)
          ? `replaces ${what} between the specreview markers`
          : `appends ${what}${from} (${lines} lines); the rest of the file is kept`;
  /** @type {FileAction} */
  const a = {
    path: file,
    action: current === null ? 'create' : current === content ? 'unchanged' : 'update',
    content,
    note,
    ...(current !== null && current.trim() !== '' ? { backup: true } : {}),
    ...(o.share ? { share: o.share } : {}),
    ...(o.showBlock ? { detail: block } : {}),
  };
  return a;
}

/**
 * Uninstall our block. The file is deleted when nothing else is left in it and install created it.
 * @param {string} file
 * @param {Markers} m
 * @param {{ share?: string, what?: string, manifest?: Manifest }} [o]
 * @returns {FileAction | null} null when there is no block
 */
export function removeBlockAction(file, m, o = {}) {
  const current = readTextOrNull(file);
  if (current === null) return null;
  checkMarkers(file, current, m);
  const next = removeBlock(current, m);
  if (next === null) return null;
  return removalAction(file, next, o.what ?? 'the SpecReview block', o);
}

/**
 * The uninstall action for a file whose remaining text is `next`: delete it when nothing is left and install created
 * it, else write what is left.
 * @param {string} file
 * @param {string} next
 * @param {string} what
 * @param {{ share?: string, manifest?: Manifest, extra?: string }} o
 * @returns {FileAction}
 */
function removalAction(file, next, what, o) {
  const share = o.share ? { share: o.share } : {};
  const extra = o.extra ? `; ${o.extra}` : '';
  if (next.trim() === '' && createdByUs(file, o.manifest)) return { path: file, action: 'delete', content: '', note: `only ${what} was left in it${extra}`, ...share };
  const rest = next.trim() === '' ? `nothing else is in it, but ${isSymlink(file) ? 'it is a symlink' : 'it existed before SpecReview'}, so the file stays` : 'the rest of the file is kept';
  return { path: file, action: 'update', content: next, note: `removes ${what}; ${rest}${extra}`, backup: true, ...share };
}

// ---------------------------------------------------------------------------------------------------------------
// TOML block (Codex config.toml): see toml.js for what is ours.

/**
 * Scans a TOML file for our block; a file that cannot be scanned, or holds several blocks, is refused.
 * @param {string} file
 * @param {string} text
 * @param {string[]} ours
 * @param {string} [fix]
 * @returns {import('./toml.js').TomlBlock}
 */
export function scanTomlFile(file, text, ours, fix) {
  try {
    return findTomlBlock(text, ours);
  } catch (err) {
    const msg = /** @type {Error} */ (err).message;
    if (err instanceof TomlScanError) throw new InstallRefusal(file, `${file} could not be parsed as TOML (${msg}); SpecReview never rewrites a file it cannot parse`, fix);
    throw new InstallRefusal(file, `${file}: ${msg}; the file is left as is`, fix);
  }
}

/**
 * Install our TOML block: replace it in place (tables Codex added inside the markers move below them) or append it.
 * The result is scanned again and refused unless it defines the table exactly once.
 * @param {string} file
 * @param {string | null} current
 * @param {import('./toml.js').TomlBlock} blk
 * @param {string} block
 * @param {string[]} ours
 * @param {{ what: string, fix?: string }} o
 * @returns {FileAction}
 */
export function tomlBlockAction(file, current, blk, block, ours, o) {
  const content = upsertTomlBlock(current ?? '', blk, block);
  let after;
  try {
    after = findTomlBlock(content, ours);
  } catch (err) {
    throw new InstallRefusal(file, `${file}: adding ${o.what} would not give valid TOML (${/** @type {Error} */ (err).message}); the file is left as is`, o.fix);
  }
  const headers = after.statements.filter((s) => s.kind === 'header' && s.key?.length === ours.length && s.key.every((k, j) => k === ours[j])).length;
  if (headers !== 1 || definitionsOutside(after, ours).defined) {
    throw new InstallRefusal(file, `${file}: adding ${o.what} would define it twice; the file is left as is`, o.fix);
  }
  const moved = blk.foreignTables.length
    ? `; moves ${blk.foreignTables.join(', ')} (found inside the markers, not SpecReview's) below them`
    : '';
  const lines = block.split('\n').length;
  const note =
    current === null
      ? `new file with ${o.what} (${lines} lines)`
      : current.trim() === ''
        ? `fills the empty file with ${o.what} (${lines} lines)`
        : blk.region
          ? `replaces ${o.what} between the specreview markers${moved}`
          : `appends ${o.what} (${lines} lines); the rest of the file is kept`;
  return {
    path: file,
    action: current === null ? 'create' : current === content ? 'unchanged' : 'update',
    content,
    note,
    detail: block,
    ...(current !== null && current.trim() !== '' ? { backup: true } : {}),
  };
}

/**
 * Uninstall our TOML block: the markers and our table go; other tables found inside the markers stay.
 * @param {string} file
 * @param {string} text
 * @param {import('./toml.js').TomlBlock} blk
 * @param {{ what: string, manifest?: Manifest }} o
 * @returns {FileAction | null} null when there is nothing of ours
 */
export function removeTomlBlockAction(file, text, blk, o) {
  const next = removeTomlBlock(text, blk);
  if (next === null) return null;
  const what = blk.region ? o.what : 'a leftover "# specreview:end" line';
  const extra = blk.foreignTables.length ? `keeps ${blk.foreignTables.join(', ')} (found inside the markers, not SpecReview's)` : undefined;
  return removalAction(file, next, what, { manifest: o.manifest, extra });
}

// ---------------------------------------------------------------------------------------------------------------
// JSON entries.

/**
 * Parses a JSON object file. Missing or empty -> null. Invalid JSON or not an object -> InstallRefusal.
 * @param {string} file
 * @param {string} [fix] what to add by hand, for the refusal message
 * @returns {{ text: string, value: Record<string, any> } | null}
 */
export function readJsonFile(file, fix) {
  const text = readTextOrNull(file);
  if (text === null || text.trim() === '') return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new InstallRefusal(file, `${file} is not valid JSON (${/** @type {Error} */ (err).message}); SpecReview never rewrites a file it cannot parse`, fix);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InstallRefusal(file, `${file} does not contain a JSON object`, fix);
  return { text, value };
}

/**
 * The indentation unit of a JSON text (default two spaces).
 * @param {string} text
 * @returns {string | number}
 */
export function detectIndent(text) {
  const m = /^\{\s*?\n([ \t]+)\S/.exec(text);
  return m ? m[1] : 2;
}

/**
 * Serialises like the original file: same indentation, same trailing newline (default: newline).
 * @param {Record<string, any>} value
 * @param {string | null} original
 * @returns {string}
 */
export function stringifyLike(value, original) {
  const indent = original ? detectIndent(original) : 2;
  const eol = original && !/\n$/.test(original) ? '' : '\n';
  return `${JSON.stringify(value, null, indent)}${eol}`;
}

/**
 * Applies `mutate` to a JSON object file. Unchanged when the result is structurally equal to the file. A removal
 * (`deleteWhenEmpty`) puts back the empty containers the file had before install (from its backup, e.g.
 * `"mcpServers": {}`), and deletes the file when nothing is left in it and install created it (manifest).
 * @param {string} file
 * @param {(value: Record<string, any>) => Record<string, any>} mutate gets a deep copy
 * @param {{ note?: string, detail?: string, fix?: string, deleteWhenEmpty?: boolean, share?: string, manifest?: Manifest }} [o]
 * @returns {FileAction | null} null for a removal from a missing file
 */
export function jsonAction(file, mutate, o = {}) {
  const raw = readTextOrNull(file);
  const exists = raw !== null;
  const parsed = readJsonFile(file, o.fix);
  const current = parsed?.value ?? {};
  /** @type {Record<string, any>} */
  let next;
  try {
    next = mutate(structuredClone(current));
  } catch (err) {
    if (err instanceof InstallRefusal && !err.file) throw new InstallRefusal(file, `${file}: ${err.message}`, o.fix ?? err.fix);
    throw err;
  }
  const original = parsed?.text ?? null;
  if (!exists && o.deleteWhenEmpty) return null;
  if (o.deleteWhenEmpty) next = restoreEmptyContainers(next, current, file);
  if (exists && isDeepStrictEqual(next, current)) {
    if (o.deleteWhenEmpty) return null;
    return { path: file, action: 'unchanged', content: /** @type {string} */ (raw), ...(o.note ? { note: o.note } : {}) };
  }
  if (o.deleteWhenEmpty && Object.keys(next).length === 0 && createdByUs(file, o.manifest)) {
    // Nothing but SpecReview's entries was in it, and install created it: no backup worth keeping.
    return { path: file, action: 'delete', content: '', note: 'only SpecReview\'s entries were left in it' };
  }
  return {
    path: file,
    action: exists ? 'update' : 'create',
    content: stringifyLike(next, original),
    ...(o.note ? { note: o.note } : {}),
    ...(o.detail ? { detail: o.detail } : {}),
    ...(exists ? { backup: true } : {}),
    ...(o.share ? { share: o.share } : {}),
  };
}

/**
 * After a removal: top-level keys that held an empty object/array in the pre-install backup and that the removal
 * dropped (deleteEntry/removeOurHooks drop emptied containers) come back, in the file's key order.
 * @param {Record<string, any>} next
 * @param {Record<string, any>} current
 * @param {string} file
 * @returns {Record<string, any>}
 */
function restoreEmptyContainers(next, current, file) {
  let backup;
  try {
    backup = JSON.parse(readTextOrNull(`${file}${BACKUP_SUFFIX}`) ?? 'null');
  } catch {
    return next;
  }
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) return next;
  const isEmpty = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && Object.keys(v).length === 0;
  const restore = Object.keys(current).filter((k) => !(k in next) && Object.hasOwn(backup, k) && isEmpty(backup[k]));
  if (!restore.length) return next;
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of Object.keys(current)) {
    if (k in next) out[k] = next[k];
    else if (restore.includes(k)) out[k] = backup[k];
  }
  for (const k of Object.keys(next)) if (!(k in out)) out[k] = next[k];
  return out;
}

/**
 * Sets `obj[container][name] = entry`, keeping every other key (and the key's position when it exists). A
 * `container` that is not an object is refused (InstallRefusal without a file; jsonAction adds it).
 * @param {Record<string, any>} obj
 * @param {string} container e.g. 'mcpServers' or 'mcp'
 * @param {string} name
 * @param {unknown} entry
 * @returns {Record<string, any>}
 */
export function setEntry(obj, container, name, entry) {
  const present = obj[container] !== undefined && obj[container] !== null;
  if (present && (typeof obj[container] !== 'object' || Array.isArray(obj[container]))) {
    throw new InstallRefusal('', `"${container}" is not a JSON object; SpecReview does not replace it`);
  }
  const box = present ? obj[container] : {};
  box[name] = entry;
  obj[container] = box;
  return obj;
}

/**
 * Deletes `obj[container][name]`; drops the container when it is left empty.
 * @param {Record<string, any>} obj
 * @param {string} container
 * @param {string} name
 * @returns {Record<string, any>}
 */
export function deleteEntry(obj, container, name) {
  const box = obj[container];
  if (!box || typeof box !== 'object' || Array.isArray(box) || !Object.hasOwn(box, name)) return obj;
  delete box[name];
  if (Object.keys(box).length === 0) delete obj[container];
  return obj;
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
