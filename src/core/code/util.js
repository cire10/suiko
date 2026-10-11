// @ts-check
// Shared helpers of the code-review engine: limits from config, version and blob readers (doc-local blobs, decoded
// and cached), file lookups in a round, the paths open threads hold, the files of a fixed-endpoint review, and the
// anchor helpers every module needs (file anchors on a blob, orphans).

import { LIMITS } from '../../shared/protocol.js';
import { NotFoundError, UsageError } from '../store/errors.js';
import { anchorFromLines } from '../anchor/create.js';
import { decodeText } from '../util/stable-read.js';
import { anchorAt } from '../review/threadstate.js';

/**
 * @typedef {import('../review/context.js').Ctx} Ctx
 * @typedef {import('../../shared/types.js').Doc} Doc
 * @typedef {import('../../shared/types.js').Anchor} Anchor
 * @typedef {import('../../shared/types.js').Thread} Thread
 * @typedef {import('../../shared/types.js').CodeFile} CodeFile
 * @typedef {import('../../shared/types.js').CodeManifest} CodeManifest
 * @typedef {import('../../shared/types.js').VersionManifest} VersionManifest
 */

/** Known empty-tree ids (SHA-1 and SHA-256 repositories). */
const EMPTY_TREES = new Set(['4b825dc642cb6eb9a060e54bf8d69288fbee4904', '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321']);

/**
 * @param {string | null | undefined} sha
 * @returns {boolean}
 */
export function isEmptyTree(sha) {
  return Boolean(sha) && EMPTY_TREES.has(String(sha));
}

/**
 * The largest file side a round reads (config code.maxFileBytes, at most the hard limit).
 * @param {any} config
 * @returns {number}
 */
export function fileMaxBytes(config) {
  const v = Number(config?.code?.maxFileBytes);
  if (Number.isSafeInteger(v) && v > 0) return Math.min(v, LIMITS.codeFileMaxBytesHard);
  return LIMITS.codeFileMaxBytes;
}

/**
 * The most files a round may hold: --max-files (kept in doc.code.maxFiles), else config code.maxFiles, else 500;
 * at most the hard limit.
 * @param {number | undefined | null} given
 * @param {any} config
 * @returns {number}
 */
export function maxFilesOf(given, config) {
  const v = Number(given ?? config?.code?.maxFiles);
  if (Number.isSafeInteger(v) && v > 0) return Math.min(v, LIMITS.codeMaxFilesHard);
  return LIMITS.codeMaxFiles;
}

/**
 * The code manifest of a version (UsageError when the version has none: not a code round).
 * @param {VersionManifest} manifest
 * @returns {CodeManifest}
 */
export function codeOf(manifest) {
  const c = /** @type {any} */ (manifest)?.code;
  if (!c || !Array.isArray(c.files)) throw new UsageError(`v${manifest?.v ?? '?'} is not a code round (no code manifest)`, { details: { version: manifest?.v ?? null } });
  return /** @type {CodeManifest} */ ({ skipped: [], stat: {}, baseMoved: null, ...c });
}

/**
 * Cached reader of a code doc's versions and blobs. Blob texts are decoded (BOM stripped); `overlay` holds texts of a
 * round not stored yet (a dry run).
 * @param {Ctx} ctx
 * @param {string} docId
 * @param {Map<string, string>} [overlay]
 */
export function reader(ctx, docId, overlay) {
  /** @type {Map<number, Promise<{ manifest: VersionManifest, source: string, code: CodeManifest }>>} */
  const versions = new Map();
  /** @type {Map<string, Promise<string | null>>} */
  const texts = new Map();
  return {
    /**
     * @param {number} v
     * @returns {Promise<{ manifest: VersionManifest, source: string, code: CodeManifest }>}
     */
    version(v) {
      let p = versions.get(v);
      if (!p) {
        p = ctx.store.readVersion(docId, v).then((r) => ({ manifest: r.manifest, source: r.source, code: codeOf(r.manifest) }));
        versions.set(v, p);
      }
      return p;
    },
    /**
     * The decoded text of a blob ref, null for no ref; NotFoundError when the blob is missing.
     * @param {string | undefined | null} ref
     * @returns {Promise<string | null>}
     */
    text(ref) {
      if (!ref) return Promise.resolve(null);
      if (overlay?.has(ref)) return Promise.resolve(/** @type {string} */ (overlay.get(ref)));
      let p = texts.get(ref);
      if (!p) {
        p = ctx.store.readDocBlob(docId, ref).then((b) => decodeText(b).text);
        texts.set(ref, p);
      }
      return p;
    },
  };
}

/** @typedef {ReturnType<typeof reader>} Reader */

/**
 * The file of a round with this path (new path; for 'D' the old path), else the file whose old path it is.
 * @param {CodeManifest} code
 * @param {string} p
 * @returns {CodeFile | null}
 */
export function fileAt(code, p) {
  return code.files.find((f) => f.path === p) ?? code.files.find((f) => f.oldPath === p) ?? null;
}

/**
 * Every path a round names (new and old paths, skipped entries).
 * @param {CodeManifest} code
 * @returns {string[]}
 */
export function roundPaths(code) {
  const out = new Set();
  for (const f of code.files) {
    out.add(f.path);
    if (f.oldPath) out.add(f.oldPath);
  }
  for (const s of code.skipped ?? []) out.add(s.path);
  return [...out];
}

/**
 * The repo path of a file side: the old side of a rename is its old path.
 * @param {CodeFile} f
 * @param {'new' | 'old'} side
 * @returns {string}
 */
export function sidePath(f, side) {
  return side === 'old' && f.oldPath ? f.oldPath : f.path;
}

/**
 * Whether a side of a file has text (not a stub, the side exists).
 * @param {CodeFile} f
 * @param {'new' | 'old'} side
 * @returns {boolean}
 */
export function hasText(f, side) {
  return !f.binary && !(f.tooLarge && f.tooLarge.side === side) && Boolean(side === 'new' ? f.new : f.old);
}

/**
 * Paths that unresolved threads anchor at version v (kept in the next round with status '=' when unchanged against
 * base, design 4.6 "carried files").
 * @param {Thread[]} threads
 * @param {number} v
 * @returns {string[]}
 */
export function threadPaths(threads, v) {
  const out = new Set();
  for (const t of threads) {
    if (t.status === 'resolved') continue;
    const a = anchorAt(t, v);
    if (!a?.file) continue;
    out.add(a.file.path);
    if (a.file.oldPath) out.add(a.file.oldPath);
  }
  return [...out].sort();
}

/**
 * A line anchor on a file side's text (design 4.7): anchorFromLines + `file` + `section: [path]`.
 * @param {{ v: number, text: string, startLine: number, endLine: number, file: { path: string, side: 'new' | 'old', oldPath?: string }, config?: any }} p
 * @returns {Anchor}
 */
export function lineAnchor({ v, text, startLine, endLine, file, config }) {
  const a = anchorFromLines({ version: v, startLine, endLine, source: text, render: null, format: 'text', config });
  return /** @type {Anchor} */ ({ ...a, section: [file.path], file: cleanFile(file) });
}

/**
 * A whole-file anchor ('doc' kind with `file`) or a whole-review anchor (no file).
 * @param {number} v
 * @param {{ path: string, side: 'new' | 'old', oldPath?: string } | null} file
 * @returns {Anchor}
 */
export function wholeAnchor(v, file) {
  /** @type {any} */
  const a = {
    v,
    kind: 'doc',
    state: 'exact',
    mappedBy: 'block',
    src: { start: 0, end: 0, startLine: 1, endLine: 1, text: '', prefix: '', suffix: '' },
    quote: null,
    srid: null,
    endSrid: null,
    section: file ? [file.path] : [],
    generated: false,
    element: null,
    region: null,
    svg: null,
    cell: null,
    code: null,
    media: null,
  };
  if (file) a.file = cleanFile(file);
  return a;
}

/**
 * @param {{ path: string, side: 'new' | 'old', oldPath?: string }} f
 */
export function cleanFile(f) {
  return f.oldPath && f.oldPath !== f.path ? { path: f.path, side: f.side, oldPath: f.oldPath } : { path: f.path, side: f.side };
}

/**
 * An anchor without its `lastKnown` (what an orphan keeps of its last position, like the anchor library).
 * @param {Anchor} a
 * @returns {Anchor}
 */
export function stripLastKnown(a) {
  const { lastKnown: _drop, ...rest } = /** @type {any} */ (a);
  void _drop;
  return /** @type {Anchor} */ (rest);
}

/**
 * An orphaned copy of an anchor at version v (its file gone): empty src, lastKnown = the previous position (the
 * anchor library's shape: the last good anchor, so a later round can retry from its text).
 * @param {Anchor} prev
 * @param {number} v
 * @param {{ path: string, side: 'new' | 'old', oldPath?: string } | null} [file]
 * @returns {Anchor}
 */
export function orphanAnchor(prev, v, file) {
  const last = prev.state === 'orphaned' ? (prev.lastKnown ?? null) : stripLastKnown(prev);
  /** @type {any} */
  const out = { ...prev, v, state: 'orphaned', srid: null, endSrid: null, src: { start: 0, end: 0, startLine: 1, endLine: 1, text: '', prefix: '', suffix: '' }, lastKnown: last };
  const f = file ?? prev.file;
  if (f) out.file = cleanFile(f);
  return out;
}

/**
 * The repo path of an anchor's file side: the old path of an old-side anchor on a renamed file, else its path.
 * @param {{ path: string, side: 'new' | 'old', oldPath?: string }} f
 * @returns {string}
 */
export function anchorSidePath(f) {
  return f.side === 'old' && f.oldPath ? f.oldPath : f.path;
}

/**
 * The file of a round an anchor's file side is on: new side by path (never a 'D' entry); old side by old path.
 * @param {CodeManifest} code
 * @param {{ path: string, side: 'new' | 'old', oldPath?: string }} af
 * @returns {CodeFile | null}
 */
export function fileOfAnchor(code, af) {
  if (af.side === 'new') return code.files.find((f) => f.path === af.path && f.status !== 'D') ?? null;
  const p = anchorSidePath(af);
  return code.files.find((f) => sidePath(f, 'old') === p && f.status !== 'A') ?? code.files.find((f) => f.path === af.path && f.status !== 'A') ?? null;
}

/**
 * The anchor environment of a code doc (anchor library calls).
 * @param {Doc | { path: string }} doc
 * @param {any} config
 * @returns {{ format: 'text', docPath: string, config: any }}
 */
export function codeEnv(doc, config) {
  return { format: 'text', docPath: doc.path, config };
}

/**
 * NotFoundError for a path that is not in a round.
 * @param {string} p
 * @param {number} v
 * @returns {NotFoundError}
 */
export function notInRound(p, v) {
  return new NotFoundError(`${p} is not a file of round v${v}`, { details: { path: p, version: v } });
}

/**
 * Runs `fn` over items with at most `limit` in flight; results in order.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, i: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
