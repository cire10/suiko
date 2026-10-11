// @ts-check
// File-level building blocks of the multi-agent installer (src/cli/install/agents.js). Every helper computes one
// FileAction (src/cli/install.js) from the file on disk without writing anything; applyPlan() writes them.
//
// Ownership rules (what "ours" means, so install never clobbers and uninstall removes only what install added):
//   - Markdown / TOML: the text between our marker comments (`<!-- specreview:begin ... -->` .. `<!-- specreview:end -->`,
//     `# specreview:begin ...` .. `# specreview:end`). Nothing outside the markers is ever rewritten.
//   - JSON: one named entry (e.g. mcpServers.specreview) or the hook commands that run specreview. The file is parsed,
//     only that entry changes, and a file that is not valid JSON is refused (InstallRefusal), never overwritten.
//   - Whole files we copy (skills, commands): ours when the content is what we install now, or what an earlier install
//     wrote (sha256 in the install manifest, $SPECREVIEW_HOME/install-manifest.json). Uninstall keeps a copy the user
//     edited and says so.
// A file we modify that existed before gets a one-time backup, <file>.specreview-backup (applyPlan with backups).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { SpecReviewError } from '../../core/store/errors.js';
import { EXIT } from '../../shared/protocol.js';

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
 * @typedef {{ schema: 1, files: Record<string, { sha256: string[] }> }} Manifest
 */

/**
 * @param {string | undefined} file
 * @returns {Manifest}
 */
export function loadManifest(file) {
  /** @type {Manifest} */
  const empty = { schema: 1, files: {} };
  if (!file) return empty;
  const text = readTextOrNull(file);
  if (!text) return empty;
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && value.files && typeof value.files === 'object') return { schema: 1, files: value.files };
  } catch {
    // a damaged manifest only costs us the "older copy" recognition
  }
  return empty;
}

/**
 * Records written copies and forgets deleted ones, then saves the manifest atomically.
 * @param {string} file
 * @param {{ written: Array<{ path: string, content: string }>, deleted: string[] }} change
 */
export function updateManifest(file, change) {
  const manifest = loadManifest(file);
  for (const w of change.written) {
    const list = manifest.files[w.path]?.sha256 ?? [];
    const h = sha256(w.content);
    manifest.files[w.path] = { sha256: [h, ...list.filter((x) => x !== h)].slice(0, 20) };
  }
  for (const p of change.deleted) delete manifest.files[p];
  writeAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * mkdir -p + write to a temp file + rename.
 * @param {string} file
 * @param {string} content
 */
export function writeAtomic(file, content) {
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
 * Install a whole file. An existing file we did not write is backed up once before it is replaced.
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
    a.backup = true;
    a.note = `${a.note ? `${a.note}; ` : ''}replaces a file SpecReview did not write (backed up to ${path.basename(file)}${BACKUP_SUFFIX})`;
  }
  return a;
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
  const content = upsertBlock(current, block, m);
  const what = o.what ?? 'the SpecReview block';
  const lines = block.split('\n').length;
  const from = o.source ? ` from ${o.source}` : '';
  const note =
    current === null || current.trim() === ''
      ? `new file with ${what}${from} (${lines} lines)`
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
 * Uninstall our block. The file is deleted when nothing else is left in it.
 * @param {string} file
 * @param {Markers} m
 * @param {{ share?: string, what?: string }} [o]
 * @returns {FileAction | null} null when there is no block
 */
export function removeBlockAction(file, m, o = {}) {
  const current = readTextOrNull(file);
  if (current === null) return null;
  const next = removeBlock(current, m);
  if (next === null) return null;
  const what = o.what ?? 'the SpecReview block';
  if (next.trim() === '') return { path: file, action: 'delete', content: '', note: `only ${what} was left in it`, ...(o.share ? { share: o.share } : {}) };
  return { path: file, action: 'update', content: next, note: `removes ${what}; the rest of the file is kept`, backup: true, ...(o.share ? { share: o.share } : {}) };
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
 * Applies `mutate` to a JSON object file. Unchanged when the result is structurally equal to the file. When the
 * result is an empty object, a removal deletes the file (`deleteWhenEmpty`).
 * @param {string} file
 * @param {(value: Record<string, any>) => Record<string, any>} mutate gets a deep copy
 * @param {{ note?: string, detail?: string, fix?: string, deleteWhenEmpty?: boolean, share?: string }} [o]
 * @returns {FileAction | null} null for a removal from a missing file
 */
export function jsonAction(file, mutate, o = {}) {
  const raw = readTextOrNull(file);
  const exists = raw !== null;
  const parsed = readJsonFile(file, o.fix);
  const current = parsed?.value ?? {};
  let next;
  try {
    next = mutate(structuredClone(current));
  } catch (err) {
    if (err instanceof InstallRefusal && !err.file) throw new InstallRefusal(file, `${file}: ${err.message}`, o.fix ?? err.fix);
    throw err;
  }
  const original = parsed?.text ?? null;
  if (!exists && o.deleteWhenEmpty) return null;
  if (exists && isDeepStrictEqual(next, current)) {
    if (o.deleteWhenEmpty) return null;
    return { path: file, action: 'unchanged', content: /** @type {string} */ (raw), ...(o.note ? { note: o.note } : {}) };
  }
  if (o.deleteWhenEmpty && Object.keys(next).length === 0) {
    // Nothing but SpecReview's entries was in it (install created it): no backup worth keeping.
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
