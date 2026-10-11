// @ts-check
// Store: the single gateway to a workspace's persistent data (design 4.4 / 5, BUILD_AMENDMENTS 2.1-2.4).
//
// Durable, commit-worthy data lives in `<root>/.specreview/`:
//   config.json  .gitignore  assets/sha256/<2>/<hex>.<ext>
//   docs/<docId>/{doc.json, versions/NNNN.<ext>, versions/NNNN.json, threads/tN.json, reviews/rvN.json,
//                 locks/LN.json, attachments/aN.png}
// Volatile state lives under `<SPECREVIEW_HOME>/ws/<wsId>/` (runtimeDir): events/<docId>.jsonl,
// waiters/<docId>/<pid>.json, locks/<docId>/ (mkdir lock), cache/, drafts/<docId>.json, pending/<docId>.jsonl.
//
// Concurrency: every mutating op (WP3 ops.js) wraps its work in `withDocLock(docId, fn)`. Methods that must be
// atomic on their own (commitVersion, appendEvent) take the doc lock themselves; the lock is re-entrant within one
// async call chain, so calling them inside withDocLock is free. Plain getters/savers do not lock.
// Readers ignore uncommitted data: a version source without its manifest, `*.tmp-*` files, and threads whose
// `review` has no review file (unless `review` is null). `recoverDoc` deletes such leftovers (amendments 2.3).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CODE_MODES, ID_PREFIX } from '../../shared/protocol.js';
import { ConflictError, NotFoundError, RefusedError, UsageError } from './errors.js';
import { exists, readJson, writeFileAtomic, writeJson } from './atomic.js';
import { appendJsonLine, readJsonLines, readLastJsonLine } from './jsonl.js';
import { withLock } from './lock.js';
import { homeDir, registerWorkspace, wsIdOf } from './home.js';
import { STORE_DIR, initStoreDir, isForbiddenRoot } from './workspace.js';
import { defaultConfig, defaultReviewerName, mergeConfig } from './config.js';
import { recoverDoc } from './recovery.js';
import { sha256 } from '../util/hash.js';
import { extOf, formatOfPath, isWithin, normalizeExt, realpathWithin, slugify, toPosix } from '../util/paths.js';
import { countLines, decodeText, encodeText, roundTrips, stableRead } from '../util/stable-read.js';
import { nowIso } from '../util/time.js';
import { pidAlive } from '../util/proc.js';
import { createLogger } from '../util/log.js';
import { CODE_KIND, codeEditRefusal, codePath, isCode, isVirtual, normalizeOrigin, snapshotPath, snapshotRefusal, SNAPSHOT_KIND } from './snapshot.js';

const log = createLogger('store');

/** @typedef {import('../../shared/types.js').Config} Config */
/** @typedef {import('../../shared/types.js').Doc} Doc */
/** @typedef {import('../../shared/types.js').DocFormat} DocFormat */
/** @typedef {import('../../shared/types.js').Actor} Actor */
/** @typedef {import('../../shared/types.js').VersionManifest} VersionManifest */
/** @typedef {import('../../shared/types.js').Thread} Thread */
/** @typedef {import('../../shared/types.js').Review} Review */
/** @typedef {import('../../shared/types.js').Lock} Lock */
/** @typedef {import('../../shared/types.js').Drafts} Drafts */
/** @typedef {import('../../shared/types.js').PendingEdit} PendingEdit */
/** @typedef {import('../../shared/types.js').StoreEvent} StoreEvent */
/** @typedef {import('../../shared/types.js').Waiter} Waiter */
/** @typedef {import('../../shared/types.js').WaiterHandle} WaiterHandle */
/** @typedef {import('../../shared/types.js').IdKind} IdKind */
/** @typedef {import('../util/stable-read.js').StableReadResult} StableReadResult */
/**
 * Redo journal of a multi-file commit (see Store.writeJournal). Exactly one of `version` (committed when
 * versions/NNNN.json exists) and `review` (committed when reviews/<id>.json exists) is set.
 * @typedef {object} Journal
 * @property {number} [version]
 * @property {string} [review]
 * @property {Doc | null} [doc] doc.json after the commit
 * @property {Thread[]} [threads] thread files after the commit
 * @property {Lock[]} [locks] lock files after the commit
 * @property {string[]} [removeDrafts] reviewer drafts consumed by the commit
 * @property {boolean} [clearPending] clear the pending tagged edits
 * @property {Array<{ type: string } & Record<string, unknown>>} [events] events to append once applied
 */

/** A waiter counts as live while its heartbeat is younger than this (and its pid is alive). */
export const WAITER_LIVE_MS = 30000;
/** docId used by `wait --all` for its waiter files. */
export const ALL_DOCS = '_all';

const DOC_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const RUNTIME_DOC_ID_RE = /^[a-z0-9_][a-z0-9_-]{0,127}$/i;
const ITEM_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ATTACHMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(\.[A-Za-z0-9]{1,10})?$/;
const VERSION_FILE_RE = /^(\d{4,})\.([a-z0-9]{1,16})$/;
const BLOB_REF_RE = /^sha256:([0-9a-f]{64})$/;

export class Store {
  /**
   * Opens the store of a workspace root. With `create`, initialises `.specreview/` (refusing $HOME and '/').
   * Registers the workspace in SPECREVIEW_HOME/workspaces.json.
   * @param {string} root
   * @param {{ create?: boolean }} [opts]
   * @returns {Promise<Store>}
   */
  static async open(root, { create = false } = {}) {
    let real;
    try {
      real = await fsp.realpath(path.resolve(root));
    } catch {
      throw new NotFoundError(`workspace root does not exist: ${root}`, { details: { root } });
    }
    const storeDir = path.join(real, STORE_DIR);
    if (create) {
      if (isForbiddenRoot(real)) {
        throw new RefusedError(`refusing to create a SpecReview store in ${real}`, { details: { root: real } });
      }
      await initStoreDir(real);
    } else if (!(await isDirectory(storeDir))) {
      throw new NotFoundError(`no SpecReview store at ${storeDir}`, { details: { root: real } });
    }
    let wsId;
    try {
      wsId = await registerWorkspace(real);
    } catch (err) {
      log.warn(`could not register workspace ${real} in ${homeDir()}`, err);
      wsId = wsIdOf(real);
    }
    return new Store(real, storeDir, wsId);
  }

  /**
   * Use Store.open().
   * @param {string} root
   * @param {string} storeDir
   * @param {string} wsId
   */
  constructor(root, storeDir, wsId) {
    /** @readonly absolute real path of the workspace root */
    this.root = root;
    /** @readonly `<root>/.specreview` */
    this.storeDir = storeDir;
    /** @readonly first 8 hex of sha256(root) */
    this.wsId = wsId;
  }

  // ---------------------------------------------------------------- config

  /**
   * Config with defaults merged; `reviewer.name` defaults to `git config user.name`, then the OS user name.
   * @returns {Promise<Config>}
   */
  async config() {
    /** @type {unknown} */
    let user = null;
    try {
      user = await readJson(path.join(this.storeDir, 'config.json'));
    } catch (err) {
      log.warn('ignoring unreadable config.json', err);
    }
    const cfg = mergeConfig(defaultConfig(), user ?? {});
    if (!cfg.reviewer.name) cfg.reviewer.name = await defaultReviewerName(this.root);
    return cfg;
  }

  // ---------------------------------------------------------------- paths and locks

  /**
   * Runtime directory for this workspace: `<SPECREVIEW_HOME>/ws/<wsId>/...parts`, created on demand.
   * Under 'locks' only the 'locks' directory itself is created (a lock is the existence of its directory).
   * @param {...string} parts
   * @returns {string}
   */
  runtimeDir(...parts) {
    const base = path.join(homeDir(), 'ws', this.wsId);
    const dir = path.join(base, ...parts);
    fs.mkdirSync(parts[0] === 'locks' ? path.join(base, 'locks') : dir, { recursive: true });
    return dir;
  }

  /**
   * Render/derived-data cache directory: runtimeDir('cache', ...parts).
   * @param {...string} parts
   * @returns {string}
   */
  cacheDir(...parts) {
    return this.runtimeDir('cache', ...parts);
  }

  /** @param {string} docId @returns {string} */
  docDir(docId) {
    assertDocId(docId);
    return path.join(this.storeDir, 'docs', docId);
  }

  /** @param {string} docId @returns {string} */
  versionsDir(docId) {
    return path.join(this.docDir(docId), 'versions');
  }

  /** @param {string} docId @returns {string} */
  reviewsDir(docId) {
    return path.join(this.docDir(docId), 'reviews');
  }

  /** @param {string} docId @returns {string} lock directory of a doc (not created) */
  docLockDir(docId) {
    assertRuntimeDocId(docId);
    return path.join(this.runtimeDir('locks'), docId);
  }

  /** @param {string} docId @returns {string} */
  eventsFile(docId) {
    assertDocId(docId);
    return path.join(this.runtimeDir('events'), `${docId}.jsonl`);
  }

  /** @param {string} docId doc id, '_all' or '*' @returns {string} */
  waitersDir(docId) {
    const id = waiterDocId(docId);
    return this.runtimeDir('waiters', id);
  }

  /** @param {string} docId @returns {string} */
  draftsFile(docId) {
    assertDocId(docId);
    return path.join(this.runtimeDir('drafts'), `${docId}.json`);
  }

  /** @param {string} docId @returns {string} redo journal of an in-flight multi-file commit (see writeJournal) */
  journalFile(docId) {
    return path.join(this.docDir(docId), 'journal.json');
  }

  /** @param {string} docId @returns {string} */
  pendingFile(docId) {
    assertDocId(docId);
    return path.join(this.runtimeDir('pending'), `${docId}.jsonl`);
  }

  /**
   * Absolute path of a doc's working copy. RefusedError when doc.path (e.g. a hand-edited or malicious doc.json)
   * would resolve outside the workspace root, and for a snapshot or code doc (its path is synthetic: there is no
   * file).
   * @param {Pick<Doc, 'path'> & { kind?: string }} doc
   * @returns {string}
   */
  workingPath(doc) {
    if (isVirtual(doc)) {
      const kind = isCode(doc) ? CODE_KIND : SNAPSHOT_KIND;
      throw new RefusedError(`${/** @type {any} */ (doc).id ?? doc.path} is a ${kind} doc: it has no working file`, { details: { path: doc.path, kind } });
    }
    const rel = String(doc?.path ?? '');
    const abs = path.resolve(this.root, ...rel.split('/'));
    if (!rel || path.isAbsolute(rel) || abs === this.root || !isWithin(this.root, abs)) {
      throw new RefusedError(`doc path is outside the workspace: ${rel}`, { details: { path: rel, root: this.root } });
    }
    return abs;
  }

  /**
   * Workspace-relative POSIX path of a file (absolute, or relative to the root). Throws RefusedError when it is
   * outside the workspace.
   * @param {string} p
   * @returns {string}
   */
  relPath(p) {
    const abs = path.isAbsolute(p) ? p : path.resolve(this.root, p);
    const real = realOrResolved(abs);
    if (!isWithin(this.root, real) || real === this.root) {
      throw new RefusedError(`${p} is outside the workspace ${this.root}`, { details: { path: p, root: this.root } });
    }
    return toPosix(path.relative(this.root, real));
  }

  /**
   * Runs `fn` under the doc's cross-process lock (re-entrant within one async call chain).
   * @template T
   * @param {string} docId
   * @param {() => Promise<T> | T} fn
   * @param {import('./lock.js').LockOptions} [opts]
   * @returns {Promise<T>}
   */
  withDocLock(docId, fn, opts) {
    return withLock(this.docLockDir(docId), fn, opts);
  }

  /**
   * Workspace-wide lock (doc creation).
   * @template T
   * @param {() => Promise<T> | T} fn
   * @returns {Promise<T>}
   */
  withWorkspaceLock(fn) {
    return withLock(path.join(this.runtimeDir('locks'), '_workspace'), fn);
  }

  /**
   * Deletes uncommitted leftovers of a doc (see recovery.js). Takes the doc lock.
   * @param {string} docId
   */
  recoverDoc(docId) {
    return recoverDoc(this, docId);
  }

  // ---------------------------------------------------------------- docs

  /**
   * Every tracked doc, sorted by id. Unreadable doc.json files are skipped with a warning.
   * @returns {Promise<Doc[]>}
   */
  async listDocs() {
    const dir = path.join(this.storeDir, 'docs');
    /** @type {Doc[]} */
    const docs = [];
    for (const name of await readDirNames(dir)) {
      if (!DOC_ID_RE.test(name)) continue;
      try {
        const doc = await readJson(path.join(dir, name, 'doc.json'));
        if (doc) docs.push(withDirId(doc, name));
      } catch (err) {
        log.warn(`skipping doc ${name}`, err);
      }
    }
    return docs.sort((a, b) => cmp(a.id, b.id));
  }

  /**
   * @param {string} docId
   * @returns {Promise<Doc | null>}
   */
  async getDoc(docId) {
    if (typeof docId !== 'string' || !DOC_ID_RE.test(docId)) return null;
    const doc = await readJson(path.join(this.docDir(docId), 'doc.json'));
    return doc ? withDirId(doc, docId) : null;
  }

  /**
   * Finds a doc by id, by path (absolute, relative to the cwd, or relative to the root), or by a unique basename.
   * Snapshot and code docs match by id only: their synthetic path must never shadow (or be taken for) a real file.
   * @param {string} idOrPath
   * @returns {Promise<Doc | null>}
   */
  async findDoc(idOrPath) {
    if (typeof idOrPath !== 'string' || !idOrPath) return null;
    const byId = await this.getDoc(idOrPath);
    if (byId) return byId;
    const docs = (await this.listDocs()).filter((d) => !isVirtual(d));
    const candidates = path.isAbsolute(idOrPath)
      ? [idOrPath]
      : [path.resolve(process.cwd(), idOrPath), path.resolve(this.root, idOrPath)];
    for (const candidate of candidates) {
      const real = realOrResolved(candidate);
      if (!isWithin(this.root, real)) continue;
      const rel = toPosix(path.relative(this.root, real));
      const hit = docs.find((d) => d.path === rel);
      if (hit) return hit;
    }
    if (!/[\\/]/.test(idOrPath)) {
      const hits = docs.filter((d) => path.posix.basename(d.path) === idOrPath);
      if (hits.length === 1) return hits[0];
    }
    return null;
  }

  /**
   * findDoc that throws NotFoundError.
   * @param {string} idOrPath
   * @returns {Promise<Doc>}
   */
  async requireDoc(idOrPath) {
    const doc = await this.findDoc(idOrPath);
    if (!doc) throw new NotFoundError(`doc not found: ${idOrPath}`, { details: { doc: idOrPath } });
    return doc;
  }

  /**
   * Starts tracking a file. The id is the slug of its basename, with '-2', '-3'... on collision. head is 0 until
   * the first version is committed. Throws ConflictError if the path is already tracked.
   * @param {{ path: string, format?: DocFormat, title?: string, createdBy?: Actor }} input
   * @returns {Promise<Doc>}
   */
  async createDoc({ path: filePath, format, title, createdBy }) {
    const rel = this.relPath(filePath);
    const fmt = format ?? formatOfPath(rel);
    if (fmt !== 'markdown' && fmt !== 'html') {
      throw new UsageError(`unsupported spec type: ${rel} (expected .md, .markdown, .html or .htm)`, { details: { path: rel } });
    }
    return this.withWorkspaceLock(async () => {
      const existing = (await this.listDocs()).find((d) => d.path === rel && !isVirtual(d));
      if (existing) {
        throw new ConflictError(`${rel} is already tracked as ${existing.id}`, { details: { doc: existing.id, path: rel } });
      }
      const id = await this.#allocateDocDir(slugify(rel));
      /** @type {Doc} */
      const doc = {
        schema: 1,
        id,
        path: rel,
        format: fmt,
        title: title || path.posix.basename(rel),
        createdAt: nowIso(),
        createdBy: createdBy ?? { kind: 'agent', name: 'agent' },
        state: 'in_review',
        head: 0,
        lastReviewedVersion: null,
        final: null,
        counters: { thread: 0, comment: 0, review: 0, lock: 0, decision: 0, draft: 0, attachment: 0 },
      };
      await this.saveDoc(doc);
      return doc;
    });
  }

  /**
   * Creates the directory of a new doc: `base`, else `base-2`, `base-3`... (atomic mkdir). Returns the id.
   * Call under the workspace lock.
   * @param {string} base
   * @returns {Promise<string>}
   */
  async #allocateDocDir(base) {
    const docsDir = path.join(this.storeDir, 'docs');
    await fsp.mkdir(docsDir, { recursive: true });
    for (let n = 1; ; n += 1) {
      const id = n === 1 ? base : `${base}-${n}`;
      try {
        await fsp.mkdir(path.join(docsDir, id));
        return id;
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EEXIST') continue;
        throw err;
      }
    }
  }

  /**
   * The snapshot or code doc with this origin key, or null (see snapshot.js).
   * @param {string} key
   * @returns {Promise<Doc | null>}
   */
  async findDocByOrigin(key) {
    if (typeof key !== 'string' || !key) return null;
    return (await this.listDocs()).find((d) => isVirtual(d) && /** @type {any} */ (d).origin?.key === key) ?? null;
  }

  /**
   * Creates a snapshot doc (see snapshot.js): no working file, synthetic path '<dir>/<id>.md', head 0 until the first
   * version is committed from bytes. With an origin key, an existing doc with that key is returned instead
   * (`created: false`); the check and the creation run under the workspace lock, so concurrent callers with the same
   * key get one doc.
   *
   * `kind: 'code'` creates a code review doc instead: format 'text', origin type 'diff', `code` (the CodeSpec) kept
   * in doc.json, synthetic path 'code/<id>.diff', and always ephemeral: the doc dir gets a '.gitignore' of '*' (its
   * versions and blobs hold repo file contents and are never committed) and `doc.ephemeral` is set.
   * @param {{ title?: string, format?: DocFormat, origin: { type: string, key?: string | null } & Record<string, unknown>,
   *   slug?: string, createdBy?: Actor, kind?: 'snapshot' | 'code', code?: import('../../shared/types.js').CodeSpec }} input
   * @returns {Promise<{ doc: Doc, created: boolean }>}
   */
  async createSnapshotDoc({ title, kind = SNAPSHOT_KIND, format = kind === CODE_KIND ? 'text' : 'markdown', origin, slug, createdBy, code = undefined }) {
    const o = normalizeOrigin(origin);
    if (kind === CODE_KIND) {
      if (format !== 'text') throw new UsageError(`a code doc has format 'text', not ${JSON.stringify(format)}`);
      if (o.type !== 'diff') throw new UsageError(`a code doc needs origin type 'diff', not ${JSON.stringify(o.type)}`);
      assertCodeSpec(code);
    } else if (kind !== SNAPSHOT_KIND) {
      throw new UsageError(`unsupported doc kind: ${JSON.stringify(kind)}`);
    } else if (format !== 'markdown' && format !== 'html') {
      throw new UsageError(`unsupported snapshot format: ${format}`);
    }
    return this.withWorkspaceLock(async () => {
      if (o.key) {
        const existing = await this.findDocByOrigin(o.key);
        if (existing) return { doc: existing, created: false };
      }
      const base = slugify(String(slug || title || o.type).replace(/[\\/.]+/g, ' ')).slice(0, 60).replace(/-+$/, '') || o.type;
      const id = await this.#allocateDocDir(base);
      const isCodeDoc = kind === CODE_KIND;
      // the ignore file first: a crash between the two never leaves code contents committable
      if (isCodeDoc) await writeFileAtomic(path.join(this.docDir(id), '.gitignore'), '*\n');
      /** @type {Doc} */
      const doc = /** @type {any} */ ({
        schema: 1,
        id,
        kind,
        origin: o,
        ...(isCodeDoc ? { code: { ...code }, ephemeral: true } : {}),
        path: isCodeDoc ? codePath(id) : snapshotPath(o.type, id, /** @type {'markdown' | 'html'} */ (format)),
        format,
        title: title || id,
        createdAt: nowIso(),
        createdBy: createdBy ?? { kind: 'agent', name: 'agent' },
        state: 'in_review',
        head: 0,
        lastReviewedVersion: null,
        final: null,
        counters: { thread: 0, comment: 0, review: 0, lock: 0, decision: 0, draft: 0, attachment: 0 },
      });
      await this.saveDoc(doc);
      return { doc, created: true };
    });
  }

  /**
   * @param {Doc} doc
   */
  async saveDoc(doc) {
    await writeJson(path.join(this.docDir(doc.id), 'doc.json'), { schema: 1, ...doc });
  }

  /**
   * Allocates the next sequential id of a kind ('thread' -> 't5'). Mutates doc.counters; the caller saves the doc.
   * @param {Doc} doc
   * @param {IdKind} kind
   * @returns {string}
   */
  nextId(doc, kind) {
    const prefix = /** @type {Record<string, string>} */ (ID_PREFIX)[kind];
    if (!prefix) throw new UsageError(`unknown id kind: ${kind}`);
    const counters = /** @type {Record<string, number>} */ (doc.counters ?? (doc.counters = /** @type {any} */ ({})));
    const n = (Number(counters[kind]) || 0) + 1;
    counters[kind] = n;
    return `${prefix}${n}`;
  }

  // ---------------------------------------------------------------- versions and blobs

  /**
   * Committed version manifests, sorted by v. Sources without a manifest are ignored.
   * @param {string} docId
   * @returns {Promise<VersionManifest[]>}
   */
  async listVersions(docId) {
    const dir = this.versionsDir(docId);
    /** @type {VersionManifest[]} */
    const out = [];
    for (const name of await readDirNames(dir)) {
      if (!/^\d{4,}\.json$/.test(name)) continue;
      try {
        const m = await readJson(path.join(dir, name));
        if (m && Number.isSafeInteger(m.v)) out.push(m);
      } catch (err) {
        log.warn(`skipping unreadable manifest ${docId}/${name}`, err);
      }
    }
    return out.sort((a, b) => a.v - b.v);
  }

  /**
   * Reads a committed version. `source` is the decoded text (BOM stripped), `buf` the exact bytes.
   * @param {string} docId
   * @param {number | string} v 3, '3' or 'v3'
   * @returns {Promise<{ manifest: VersionManifest, source: string, buf: Buffer }>}
   */
  async readVersion(docId, v) {
    const n = parseVersion(v);
    const dir = this.versionsDir(docId);
    /** @type {VersionManifest | null} */
    const manifest = await readJson(path.join(dir, `${pad(n)}.json`));
    if (!manifest) throw new NotFoundError(`version v${n} of ${docId} not found`, { details: { doc: docId, version: n } });
    let file = typeof manifest.file === 'string' && VERSION_FILE_RE.test(manifest.file) ? manifest.file : null;
    if (!file) file = (await readDirNames(dir)).find((f) => VERSION_FILE_RE.test(f) && f.startsWith(`${pad(n)}.`) && !f.endsWith('.json')) ?? null;
    if (!file) throw new NotFoundError(`source of v${n} of ${docId} is missing`, { details: { doc: docId, version: n } });
    let buf;
    try {
      buf = await fsp.readFile(path.join(dir, file));
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
        throw new NotFoundError(`source of v${n} of ${docId} is missing`, { details: { doc: docId, version: n } });
      }
      throw err;
    }
    if (manifest.sha256 && manifest.sha256 !== sha256(buf)) log.warn(`v${n} of ${docId}: source does not match its manifest hash`);
    return { manifest, source: decodeText(buf).text, buf };
  }

  /**
   * Records a new version: (1) asset blobs, (2) versions/NNNN.<ext>, (3) versions/NNNN.json (the commit point),
   * (4) doc.head. Runs under the doc lock.
   *
   * - `docOrId`: pass the Doc object you hold so its `head` is updated (and saved with it); with an id, doc.json is
   *   re-read and saved.
   * - `source`: a Buffer is written verbatim (pass `readWorking().buf` to keep exact bytes); a string is UTF-8.
   * - `manifest`: caller fields (author, summary, respondsTo, capturedBy, stats, hunks, guards, git...). `v` defaults
   *   to head+1 (a given `v` must equal it). `parent` defaults to v-1 (null for v1). `file`, `sha256`, `bytes` are
   *   always computed; `lines`, `createdAt` and `schema` are defaulted.
   * - `assetFiles`: {workspace-relative POSIX path: absolute path | null}. Each existing file is stored as a blob and
   *   recorded in `manifest.assets[rel] = 'sha256:<hex>'`; files over config.assets.maxBytes are recorded as
   *   'live'; missing files are skipped. Entries already in `manifest.assets` are kept.
   * - `beforeCommit(final)`: called with the complete manifest after (1) and (2) and before (3); work done there
   *   (and anything it throws) happens before the commit point.
   * @param {string | Doc} docOrId
   * @param {{ source: string | Buffer, ext?: string, manifest?: Partial<VersionManifest>, assetFiles?: Record<string, string | null>,
   *   beforeCommit?: (final: VersionManifest) => Promise<void> }} input
   * @returns {Promise<VersionManifest>}
   */
  async commitVersion(docOrId, { source, ext, manifest = {}, assetFiles = {}, beforeCommit }) {
    const docId = typeof docOrId === 'string' ? docOrId : docOrId.id;
    return this.withDocLock(docId, async () => {
      const doc = typeof docOrId === 'string' ? await this.getDoc(docId) : docOrId;
      if (!doc) throw new NotFoundError(`doc not found: ${docId}`, { details: { doc: docId } });
      const existing = await this.listVersions(docId);
      const next = (existing.length ? existing[existing.length - 1].v : 0) + 1;
      const v = manifest.v ?? next;
      if (v !== next) {
        throw new ConflictError(`cannot record v${v} of ${docId}: the next version is v${next}`, { details: { doc: docId, version: v, expected: next } });
      }
      const fileExt = normalizeExt(ext ?? extOf(doc.path)) || 'txt';
      const dir = this.versionsDir(docId);

      // (1) asset blobs
      const cfg = await this.config();
      /** @type {Record<string, string>} */
      const assets = { ...(manifest.assets ?? {}) };
      for (const rel of Object.keys(assetFiles).sort()) {
        const abs = assetFiles[rel] ?? realpathWithin(this.root, rel);
        if (!abs) continue;
        let st;
        try {
          st = await fsp.stat(abs);
        } catch {
          log.debug(`asset ${rel} is missing; not snapshotted`);
          continue;
        }
        if (!st.isFile()) continue;
        if (st.size > cfg.assets.maxBytes) {
          assets[rel] = 'live';
          continue;
        }
        assets[rel] = await this.putBlob(await fsp.readFile(abs), extOf(abs));
      }

      // (2) source
      const buf = Buffer.isBuffer(source) ? source : Buffer.from(String(source), 'utf8');
      const file = `${pad(v)}.${fileExt}`;
      await writeFileAtomic(path.join(dir, file), buf);

      // (3) manifest: the commit point
      /** @type {VersionManifest} */
      const final = /** @type {VersionManifest} */ ({
        ...manifest,
        schema: 1,
        v,
        parent: manifest.parent !== undefined ? manifest.parent : v > 1 ? v - 1 : null,
        file,
        sha256: sha256(buf),
        bytes: buf.length,
        lines: manifest.lines ?? countLines(decodeText(buf).text),
        createdAt: manifest.createdAt ?? nowIso(),
        assets: sortKeys(assets),
      });
      // (2b) the caller's pre-commit work (e.g. the redo journal of everything that changes with this version)
      if (beforeCommit) await beforeCommit(final);
      await writeJson(path.join(dir, `${pad(v)}.json`), final);

      // (4) head
      doc.head = v;
      await this.saveDoc(doc);
      return final;
    });
  }

  /**
   * Stores bytes in the content-addressed asset store (idempotent).
   * @param {Buffer | Uint8Array} buf
   * @param {string} [ext] file extension ('png' or '.png'); kept so the blob has a meaningful name
   * @returns {Promise<string>} 'sha256:<hex>'
   */
  async putBlob(buf, ext) {
    const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const hex = sha256(data);
    const e = normalizeExt(ext);
    const file = path.join(this.storeDir, 'assets', 'sha256', hex.slice(0, 2), e ? `${hex}.${e}` : hex);
    try {
      const st = await fsp.stat(file);
      if (st.isFile() && st.size === data.length) return `sha256:${hex}`;
    } catch {
      // not stored yet
    }
    await writeFileAtomic(file, data);
    return `sha256:${hex}`;
  }

  /**
   * Absolute path of a stored blob ('sha256:<hex>'), whatever extension it was stored with; null when absent or
   * when `ref` is not a blob reference (e.g. 'live').
   * @param {string} ref
   * @returns {string | null}
   */
  blobPath(ref) {
    const m = typeof ref === 'string' ? BLOB_REF_RE.exec(ref) : null;
    if (!m) return null;
    const hex = m[1];
    const dir = path.join(this.storeDir, 'assets', 'sha256', hex.slice(0, 2));
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return null;
    }
    const name = names.filter((n) => (n === hex || n.startsWith(`${hex}.`)) && !n.includes('.tmp-')).sort()[0];
    return name ? path.join(dir, name) : null;
  }

  // ---------------------------------------------------------------- threads, reviews, locks

  /**
   * Threads sorted by number. Threads whose review has not been committed are hidden unless includeUncommitted.
   * @param {string} docId
   * @param {{ includeUncommitted?: boolean }} [opts]
   * @returns {Promise<Thread[]>}
   */
  async listThreads(docId, { includeUncommitted = false } = {}) {
    /** @type {Thread[]} */
    const threads = await this.#listItems(docId, 'threads');
    if (includeUncommitted) return threads;
    const reviews = new Set(await this.#listItemIds(docId, 'reviews'));
    return threads.filter((t) => !t.review || reviews.has(t.review));
  }

  /**
   * @param {string} docId
   * @param {string} id
   * @param {{ includeUncommitted?: boolean }} [opts]
   * @returns {Promise<Thread | null>}
   */
  async getThread(docId, id, { includeUncommitted = false } = {}) {
    /** @type {Thread | null} */
    const thread = await this.#getItem(docId, 'threads', id);
    if (!thread || includeUncommitted || !thread.review) return thread;
    return (await exists(path.join(this.reviewsDir(docId), `${thread.review}.json`))) ? thread : null;
  }

  /** @param {string} docId @param {Thread} thread */
  async saveThread(docId, thread) {
    await this.#saveItem(docId, 'threads', thread);
  }

  /**
   * @param {string} docId
   * @param {string} id
   * @returns {Promise<boolean>} whether a file was removed
   */
  async deleteThread(docId, id) {
    return this.#deleteItem(docId, 'threads', id);
  }

  /** @param {string} docId @returns {Promise<Review[]>} */
  async listReviews(docId) {
    return this.#listItems(docId, 'reviews');
  }

  /** @param {string} docId @param {string} id @returns {Promise<Review | null>} */
  async getReview(docId, id) {
    return this.#getItem(docId, 'reviews', id);
  }

  /** @param {string} docId @param {Review} review */
  async saveReview(docId, review) {
    await this.#saveItem(docId, 'reviews', review);
  }

  /** @param {string} docId @returns {Promise<Lock[]>} */
  async listLocks(docId) {
    return this.#listItems(docId, 'locks');
  }

  /** @param {string} docId @param {string} id @returns {Promise<Lock | null>} */
  async getLock(docId, id) {
    return this.#getItem(docId, 'locks', id);
  }

  /** @param {string} docId @param {Lock} lock */
  async saveLock(docId, lock) {
    await this.#saveItem(docId, 'locks', lock);
  }

  /**
   * @param {string} docId
   * @param {string} sub
   * @returns {Promise<any[]>}
   */
  async #listItems(docId, sub) {
    const dir = path.join(this.docDir(docId), sub);
    const out = [];
    for (const id of await this.#listItemIds(docId, sub)) {
      try {
        const item = await readJson(path.join(dir, `${id}.json`));
        if (item) out.push(item);
      } catch (err) {
        log.warn(`skipping unreadable ${sub}/${id}.json of ${docId}`, err);
      }
    }
    return out;
  }

  /**
   * Ids of the item files in a subdirectory, in numeric order.
   * @param {string} docId
   * @param {string} sub
   * @returns {Promise<string[]>}
   */
  async #listItemIds(docId, sub) {
    const names = await readDirNames(path.join(this.docDir(docId), sub));
    return names
      .filter((n) => n.endsWith('.json') && ITEM_ID_RE.test(n.slice(0, -5)))
      .map((n) => n.slice(0, -5))
      .sort(compareIds);
  }

  /**
   * @param {string} docId
   * @param {string} sub
   * @param {string} id
   * @returns {Promise<any>}
   */
  async #getItem(docId, sub, id) {
    if (typeof id !== 'string' || !ITEM_ID_RE.test(id)) return null;
    return readJson(path.join(this.docDir(docId), sub, `${id}.json`));
  }

  /**
   * @param {string} docId
   * @param {string} sub
   * @param {{ id: string }} item
   */
  async #saveItem(docId, sub, item) {
    if (!item || typeof item.id !== 'string' || !ITEM_ID_RE.test(item.id)) {
      throw new UsageError(`invalid ${sub} id: ${item?.id}`);
    }
    await writeJson(path.join(this.docDir(docId), sub, `${item.id}.json`), { schema: 1, ...item });
  }

  /**
   * @param {string} docId
   * @param {string} sub
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async #deleteItem(docId, sub, id) {
    if (typeof id !== 'string' || !ITEM_ID_RE.test(id)) return false;
    try {
      await fsp.unlink(path.join(this.docDir(docId), sub, `${id}.json`));
      return true;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return false;
      throw err;
    }
  }

  // ---------------------------------------------------------------- runtime: drafts, pending edits, events

  /**
   * Reviewer drafts ({schema:1, items:[]} when none).
   * @param {string} docId
   * @returns {Promise<Drafts>}
   */
  async getDrafts(docId) {
    const file = this.draftsFile(docId);
    let drafts = null;
    try {
      drafts = await readJson(file);
    } catch (err) {
      log.warn(`unreadable drafts for ${docId}; starting empty`, err);
    }
    if (!drafts || !Array.isArray(drafts.items)) return { schema: 1, items: [] };
    return drafts;
  }

  /** @param {string} docId @param {Drafts} drafts */
  async saveDrafts(docId, drafts) {
    await writeJson(this.draftsFile(docId), { schema: 1, ...drafts, items: drafts?.items ?? [] });
  }

  /**
   * Appends a tagged edit since head (`at` defaults to now).
   * @param {string} docId
   * @param {PendingEdit} edit
   */
  async appendPendingEdit(docId, edit) {
    await appendJsonLine(this.pendingFile(docId), { at: nowIso(), ...edit });
  }

  /** @param {string} docId @returns {Promise<PendingEdit[]>} */
  async readPendingEdits(docId) {
    return readJsonLines(this.pendingFile(docId));
  }

  /** @param {string} docId */
  async clearPendingEdits(docId) {
    await fsp.rm(this.pendingFile(docId), { force: true });
  }

  // ---------------------------------------------------------------- commit journal

  /**
   * Writes the redo journal of a commit that spans several files (`revise` / reviewer versions, review submit).
   * The caller computes every post-commit change BEFORE its commit point, writes the journal, writes the commit
   * point (a version manifest or a review file), then calls applyJournal. A crash anywhere in between is repaired
   * by recoverDoc: a journal whose commit point exists is applied (rolled forward), one whose commit point does not
   * exist is dropped. Call inside the doc lock.
   * @param {string} docId
   * @param {Journal} journal
   */
  async writeJournal(docId, journal) {
    if (!journal || (journal.version == null) === (journal.review == null)) throw new UsageError('writeJournal: exactly one of version / review is required');
    await writeJson(this.journalFile(docId), { schema: 1, ...journal, createdAt: nowIso() });
  }

  /**
   * @param {string} docId
   * @returns {Promise<Journal | null>}
   */
  async readJournal(docId) {
    try {
      return await readJson(this.journalFile(docId));
    } catch (err) {
      log.warn(`unreadable commit journal of ${docId}; ignoring it`, err);
      return null;
    }
  }

  /**
   * Whether the commit point a journal belongs to exists.
   * @param {string} docId
   * @param {Journal} journal
   * @returns {Promise<boolean>}
   */
  async journalCommitted(docId, journal) {
    if (journal?.version != null && Number.isSafeInteger(Number(journal.version))) {
      return exists(path.join(this.versionsDir(docId), `${pad(Number(journal.version))}.json`));
    }
    if (typeof journal?.review === 'string' && ITEM_ID_RE.test(journal.review)) {
      return exists(path.join(this.reviewsDir(docId), `${journal.review}.json`));
    }
    return false;
  }

  /**
   * Applies a committed journal (idempotent: every entry is a full replacement), removes it, then appends its
   * events. Call inside the doc lock.
   * @param {string} docId
   * @param {Journal} journal
   */
  async applyJournal(docId, journal) {
    for (const t of journal.threads ?? []) await this.saveThread(docId, t);
    for (const l of journal.locks ?? []) await this.saveLock(docId, l);
    if (journal.doc) {
      const { schema: _s, ...doc } = /** @type {any} */ (journal.doc);
      const cur = await this.getDoc(docId);
      // never move head backwards (a version recorded after a review's journal was written keeps its head)
      await this.saveDoc({ ...doc, id: docId, head: Math.max(Number(doc.head) || 0, Number(cur?.head) || 0) });
    }
    if (journal.removeDrafts?.length) {
      const gone = new Set(journal.removeDrafts);
      const drafts = await this.getDrafts(docId);
      if (drafts.items.some((d) => gone.has(d.id))) await this.saveDrafts(docId, { ...drafts, items: drafts.items.filter((d) => !gone.has(d.id)) });
    }
    if (journal.clearPending) await this.clearPendingEdits(docId);
    await fsp.rm(this.journalFile(docId), { force: true });
    for (const e of journal.events ?? []) await this.appendEvent(docId, e);
  }

  /**
   * Appends an event to the doc's feed and returns its seq (1, 2, ...). Takes the doc lock (re-entrant).
   * The record is {seq, at, type, ...rest}; `at` defaults to now.
   * @param {string} docId
   * @param {{ type: string, at?: string } & Record<string, unknown>} event
   * @returns {Promise<number>}
   */
  async appendEvent(docId, event) {
    if (!event || typeof event.type !== 'string' || !event.type) throw new UsageError('appendEvent: event.type is required');
    const file = this.eventsFile(docId);
    return this.withDocLock(docId, async () => {
      const seq = (await this.lastSeq(docId)) + 1;
      const { seq: _ignoredSeq, at, type, ...rest } = event;
      await appendJsonLine(file, { seq, at: at ?? nowIso(), type, ...rest });
      return seq;
    });
  }

  /**
   * Events with seq > afterSeq, in order.
   * @param {string} docId
   * @param {number} [afterSeq=0]
   * @returns {Promise<StoreEvent[]>}
   */
  async readEvents(docId, afterSeq = 0) {
    /** @type {StoreEvent[]} */
    const all = await readJsonLines(this.eventsFile(docId));
    return all.filter((e) => Number.isSafeInteger(e?.seq) && e.seq > afterSeq);
  }

  /**
   * Seq of the last event (0 when none).
   * @param {string} docId
   * @returns {Promise<number>}
   */
  async lastSeq(docId) {
    const last = await readLastJsonLine(this.eventsFile(docId));
    return last && Number.isSafeInteger(last.seq) ? last.seq : 0;
  }

  // ---------------------------------------------------------------- runtime: waiters (amendments 2.4)

  /**
   * Registers a waiting agent process for a doc (or '_all' / '*' for `wait --all`). Every other live waiter of the
   * same (doc, agent) is marked `supersededBy: pid`; files of dead pids are removed.
   * @param {string} docId
   * @param {{ agent: string, pid?: number }} who
   * @returns {Promise<WaiterHandle>}
   */
  async registerWaiter(docId, { agent, pid = process.pid }) {
    const id = waiterDocId(docId);
    if (typeof agent !== 'string' || !agent) throw new UsageError('registerWaiter: agent is required');
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new UsageError(`registerWaiter: invalid pid ${pid}`);
    const dir = this.waitersDir(id);
    const file = path.join(dir, `${pid}.json`);
    const since = new Date().toISOString();
    await this.#withWaitersLock(id, async () => {
      for (const w of await this.#readWaiterFiles(id)) {
        if (w.pid === pid) continue;
        const wFile = path.join(dir, `${w.pid}.json`);
        if (!pidAlive(w.pid)) {
          await fsp.rm(wFile, { force: true });
        } else if (w.agent === agent && isFresh(w)) {
          await writeJson(wFile, { ...w, supersededBy: pid });
        }
      }
      await writeJson(file, { pid, agent, since, heartbeatAt: since });
    });

    let removed = false;
    /** @returns {Promise<Waiter | null>} */
    const readOwn = async () => {
      try {
        return await readJson(file);
      } catch {
        return null;
      }
    };
    return {
      docId: id,
      agent,
      pid,
      file,
      heartbeat: async () => {
        if (removed) return null;
        return this.#withWaitersLock(id, async () => {
          const cur = await readOwn();
          /** @type {Waiter} */
          const rec = { pid, agent, since: cur?.since ?? since, heartbeatAt: new Date().toISOString() };
          if (cur?.supersededBy) rec.supersededBy = cur.supersededBy;
          await writeJson(file, rec);
          return rec.supersededBy ?? null;
        });
      },
      isSuperseded: async () => (await readOwn())?.supersededBy ?? null,
      remove: async () => {
        removed = true;
        await fsp.rm(file, { force: true });
      },
    };
  }

  /**
   * Waiters of a doc ('_all' / '*' for wait --all), sorted by `since`. With liveOnly (default), only waiters whose
   * heartbeat is < 30 s old, whose pid is alive and that are not superseded. Each entry has `doc` and `live`.
   * @param {string} docId
   * @param {{ liveOnly?: boolean }} [opts]
   * @returns {Promise<Array<Waiter & { doc: string, live: boolean }>>}
   */
  async listWaiters(docId, { liveOnly = true } = {}) {
    const id = waiterDocId(docId);
    const out = [];
    for (const w of await this.#readWaiterFiles(id)) {
      const live = isFresh(w) && pidAlive(w.pid) && !w.supersededBy;
      if (liveOnly && !live) continue;
      out.push({ ...w, doc: id, live });
    }
    return out.sort((a, b) => cmp(a.since, b.since) || a.pid - b.pid);
  }

  /**
   * @param {string} id
   * @returns {Promise<Waiter[]>}
   */
  async #readWaiterFiles(id) {
    const dir = this.waitersDir(id);
    /** @type {Waiter[]} */
    const out = [];
    for (const name of await readDirNames(dir)) {
      if (!/^\d+\.json$/.test(name)) continue;
      try {
        const w = await readJson(path.join(dir, name));
        if (w && Number.isSafeInteger(w.pid)) out.push(w);
      } catch {
        // a waiter file being replaced or corrupt: skip
      }
    }
    return out;
  }

  /**
   * @template T
   * @param {string} id
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  #withWaitersLock(id, fn) {
    return withLock(path.join(this.runtimeDir('locks'), `_waiters-${id}`), fn, { timeoutMs: 5000 });
  }

  // ---------------------------------------------------------------- attachments

  /**
   * Saves an attachment (region crop, pasted image) and returns its doc-relative path 'attachments/<name>'
   * (the form stored in threads and drafts). The caller allocates `name`, e.g. `${nextId(doc,'attachment')}.png`.
   * @param {string} docId
   * @param {string} name
   * @param {Buffer | Uint8Array} buf
   * @returns {Promise<string>}
   */
  async saveAttachment(docId, name, buf) {
    if (typeof name !== 'string' || !ATTACHMENT_RE.test(name)) throw new UsageError(`invalid attachment name: ${name}`);
    await writeFileAtomic(path.join(this.docDir(docId), 'attachments', name), buf);
    return `attachments/${name}`;
  }

  /**
   * Absolute path of an attachment given 'attachments/<name>' or '<name>'.
   * @param {string} docId
   * @param {string} rel
   * @returns {string}
   */
  attachmentPath(docId, rel) {
    const name = String(rel).replace(/^attachments\//, '');
    if (!ATTACHMENT_RE.test(name)) throw new UsageError(`invalid attachment path: ${rel}`);
    return path.join(this.docDir(docId), 'attachments', name);
  }

  // ---------------------------------------------------------------- working copy

  /**
   * Stable read of the tracked file (see util/stable-read.js). NotFoundError when it does not exist.
   * The working copy of a snapshot or code doc is its newest committed version (never dirty; NotFoundError before
   * v1). A code doc's real working state (its repo files) comes from kindOf(doc).workingState, not from here.
   * @param {Pick<Doc, 'path'> & { id?: string, kind?: string }} doc
   * @returns {Promise<StableReadResult>}
   */
  async readWorking(doc) {
    if (isVirtual(doc)) return this.#snapshotWorking(/** @type {Doc} */ (doc));
    try {
      return await stableRead(this.workingPath(doc));
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
        throw new NotFoundError(`working copy is missing: ${doc.path}`, { details: { path: doc.path } });
      }
      throw err;
    }
  }

  /**
   * readWorking of a snapshot or code doc: the bytes of its newest committed version, in the StableReadResult shape.
   * @param {Doc} doc
   * @returns {Promise<StableReadResult>}
   */
  async #snapshotWorking(doc) {
    const versions = await this.listVersions(doc.id);
    const last = versions[versions.length - 1];
    if (!last) throw new NotFoundError(`${doc.id} has no version yet`, { details: { doc: doc.id, path: doc.path } });
    const { buf } = await this.readVersion(doc.id, last.v);
    const { text, encoding } = decodeText(buf);
    const mtimeMs = Date.parse(String(last.createdAt ?? '')) || 0;
    return { buf, text, sha256: sha256(buf), mtimeMs, mode: 0o644, size: buf.length, encoding, stable: true };
  }

  /**
   * Compare-and-swap write of the working copy: the file's current sha256 (of its bytes) must equal
   * `expectSha256`, checked before writing and again just before the atomic rename. Keeps the file mode and its
   * encoding/BOM (strings are encoded like the current file). A symlinked working file is written through to its
   * target. Throws ConflictError (exit 3) when the file changed, and RefusedError when the file's bytes do not
   * decode losslessly (legacy charset): re-encoding would corrupt every non-ASCII character of the file.
   * @param {Pick<Doc, 'path'>} doc
   * @param {string | Buffer} text
   * @param {{ expectSha256: string }} opts
   * @returns {Promise<{ sha256: string, bytes: number }>}
   */
  async writeWorking(doc, text, { expectSha256 }) {
    if (isCode(doc)) throw new RefusedError(codeEditRefusal(doc), { details: { doc: /** @type {any} */ (doc).id, kind: CODE_KIND } });
    if (isVirtual(doc)) throw new RefusedError(snapshotRefusal(doc, 'write'), { details: { doc: /** @type {any} */ (doc).id, kind: SNAPSHOT_KIND } });
    if (typeof expectSha256 !== 'string' || !expectSha256) throw new UsageError('writeWorking requires expectSha256');
    const abs = this.workingPath(doc);
    let real;
    try {
      real = await fsp.realpath(abs);
    } catch {
      throw new NotFoundError(`working copy is missing: ${doc.path}`, { details: { path: doc.path } });
    }
    const conflict = () =>
      new ConflictError(`${doc.path} changed since it was read; re-read it and retry`, { details: { path: doc.path, expectSha256 } });
    const current = await stableRead(real);
    if (current.sha256 !== expectSha256) throw conflict();
    // Re-encoding a file that did not decode losslessly (a legacy charset read as UTF-8) would replace every
    // non-ASCII byte of the whole file with U+FFFD: refuse instead of corrupting it.
    if (typeof text === 'string' && !roundTrips(current.buf)) {
      throw new RefusedError(
        `${doc.path} is not valid UTF-8 or UTF-16 (a legacy charset such as windows-1252?); SpecReview cannot rewrite it without corrupting its non-ASCII characters. Make the change with your editor, or convert the file to UTF-8 first.`,
        { details: { path: doc.path, encoding: 'legacy' } },
      );
    }
    const buf = typeof text === 'string' ? encodeText(text, current.encoding) : Buffer.from(text);
    await writeFileAtomic(real, buf, {
      mode: current.mode,
      mkdir: false,
      beforeRename: async () => {
        if ((await stableRead(real, { retries: 2 })).sha256 !== expectSha256) throw conflict();
      },
    });
    return { sha256: sha256(buf), bytes: buf.length };
  }

  // ---------------------------------------------------------------- code docs: per-doc blobs and repo files

  /**
   * Stores bytes in a doc's own content-addressed blob store (`docs/<id>/blobs/<hex[0..2]>/<hex>`): code docs keep
   * the file sides of every round there. Idempotent and atomic. Never the shared `assets/` store: those blobs are
   * served by the content origin and meant to be committed, these hold repo contents of an ephemeral doc.
   * @param {string} docId
   * @param {Buffer | Uint8Array | string} buf strings are stored as UTF-8
   * @returns {Promise<string>} 'sha256:<hex>'
   */
  async putDocBlob(docId, buf) {
    const data = Buffer.isBuffer(buf) ? buf : typeof buf === 'string' ? Buffer.from(buf, 'utf8') : Buffer.from(buf);
    const hex = sha256(data);
    const file = this.#docBlobFile(docId, hex);
    try {
      const st = await fsp.stat(file);
      if (st.isFile() && st.size === data.length) return `sha256:${hex}`;
    } catch {
      // not stored yet
    }
    await writeFileAtomic(file, data);
    return `sha256:${hex}`;
  }

  /**
   * Bytes of a doc blob stored with putDocBlob. NotFoundError when it is absent; UsageError for a malformed ref.
   * @param {string} docId
   * @param {string} ref 'sha256:<hex>'
   * @returns {Promise<Buffer>}
   */
  async readDocBlob(docId, ref) {
    const m = typeof ref === 'string' ? BLOB_REF_RE.exec(ref) : null;
    if (!m) throw new UsageError(`invalid blob reference: ${JSON.stringify(ref)}`, { details: { doc: docId, ref } });
    try {
      return await fsp.readFile(this.#docBlobFile(docId, m[1]));
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new NotFoundError(`blob ${ref} of ${docId} is missing`, { details: { doc: docId, ref } });
      throw err;
    }
  }

  /**
   * @param {string} docId
   * @param {string} hex
   * @returns {string}
   */
  #docBlobFile(docId, hex) {
    return path.join(this.docDir(docId), 'blobs', hex.slice(0, 2), hex);
  }

  /**
   * Reads one repo file (a path relative to the workspace root, which for code reviews is the repo top level),
   * NEVER through a symlink: the last component is lstat'ed and opened with O_NOFOLLOW, and a symlink returns its
   * link text only. Refuses (RefusedError) a path whose parent directory's real path leaves the root (a symlinked
   * directory), any component equal to '.git' or '.specreview' (case-insensitive; covers the .git file of a
   * worktree), and '..' / empty / absolute forms. Returns null when the file does not exist.
   * @param {string} rel POSIX path relative to the root
   * @returns {Promise<import('../../shared/types.js').RepoRead | null>}
   */
  async readRepoFile(rel) {
    const abs = await this.#repoFilePath(rel, { mustExist: false });
    if (!abs) return null;
    let st;
    try {
      st = await fsp.lstat(abs);
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    if (st.isSymbolicLink()) return { kind: 'symlink', target: await fsp.readlink(abs) };
    if (!st.isFile()) return { kind: 'other' };
    const read = await readNoFollow(abs);
    if (read === 'symlink') return { kind: 'symlink', target: await fsp.readlink(abs) };
    if (read === null) return null;
    return read;
  }

  /**
   * Compare-and-swap write of a repo file, with writeWorking's rules: the file's current sha256 (hex of its bytes;
   * a 'sha256:' prefix is accepted) must equal `expectSha256`, checked before writing and again just before the
   * atomic rename (ConflictError otherwise); the file mode and the encoding/BOM are kept; text is written as given
   * (callers match the file's line endings, see review/apply.js matchEol); a file that does not decode losslessly
   * is refused. Refuses the paths readRepoFile refuses, a symlink (never written through), anything that is not a
   * regular file, and any `rel` not in `allowed` (the head manifest's file list). NotFoundError when it is missing.
   * @param {string} rel POSIX path relative to the root
   * @param {string | Buffer} text
   * @param {{ expectSha256: string, allowed: Iterable<string> }} opts
   * @returns {Promise<{ sha256: string, bytes: number }>}
   */
  async writeRepoFile(rel, text, { expectSha256, allowed } = /** @type {any} */ ({})) {
    const expect = typeof expectSha256 === 'string' ? expectSha256.replace(/^sha256:/, '') : '';
    if (!expect) throw new UsageError('writeRepoFile requires expectSha256');
    if (!allowed || typeof allowed !== 'object' || typeof /** @type {any} */ (allowed)[Symbol.iterator] !== 'function') {
      throw new UsageError('writeRepoFile requires the allowed file list');
    }
    if (!new Set(allowed).has(rel)) {
      throw new RefusedError(`${rel} is not a file of this review; SpecReview only writes files listed in the reviewed round`, { details: { path: rel } });
    }
    const abs = /** @type {string} */ (await this.#repoFilePath(rel, { mustExist: true }));
    const missing = () => new NotFoundError(`${rel} is missing`, { details: { path: rel } });
    const conflict = () => new ConflictError(`${rel} changed since it was read; re-read it and retry`, { details: { path: rel, expectSha256: expect } });
    const current = await this.#regularRepoFile(rel, abs);
    if (!current) throw missing();
    if (current.sha256 !== expect) throw conflict();
    if (typeof text === 'string' && !roundTrips(current.buf)) {
      throw new RefusedError(
        `${rel} is not valid UTF-8 or UTF-16 (a legacy charset such as windows-1252?); SpecReview cannot rewrite it without corrupting its non-ASCII characters. Make the change with your editor, or convert the file to UTF-8 first.`,
        { details: { path: rel, encoding: 'legacy' } },
      );
    }
    const buf = typeof text === 'string' ? encodeText(text, decodeText(current.buf).encoding) : Buffer.from(text);
    await writeFileAtomic(abs, buf, {
      mode: current.mode,
      mkdir: false,
      beforeRename: async () => {
        const again = await this.#regularRepoFile(rel, abs);
        if (!again || again.sha256 !== expect) throw conflict();
      },
    });
    return { sha256: sha256(buf), bytes: buf.length };
  }

  /**
   * readRepoFile for a writer: the regular file's bytes, null when missing; RefusedError for a symlink or a
   * non-file.
   * @param {string} rel
   * @param {string} abs
   * @returns {Promise<{ buf: Buffer, text: string, sha256: string, mode: number } | null>}
   */
  async #regularRepoFile(rel, abs) {
    let st;
    try {
      st = await fsp.lstat(abs);
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    const refuse = (/** @type {string} */ what) => new RefusedError(`${rel} is ${what}; SpecReview does not write it`, { details: { path: rel } });
    if (st.isSymbolicLink()) throw refuse('a symlink');
    if (!st.isFile()) throw refuse('not a regular file');
    const read = await readNoFollow(abs);
    if (read === 'symlink') throw refuse('a symlink');
    return read;
  }

  /**
   * Validates a repo-relative path and returns its absolute path (see readRepoFile for the refusals). With
   * `mustExist: false`, a missing parent directory returns null.
   * @param {string} rel
   * @param {{ mustExist: boolean }} opts
   * @returns {Promise<string | null>}
   */
  async #repoFilePath(rel, { mustExist }) {
    if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.includes('\\')) {
      throw new UsageError(`invalid repo path: ${JSON.stringify(rel)}`, { details: { path: rel } });
    }
    const segs = rel.split('/');
    if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || segs.some((s) => s === '' || s === '.' || s === '..')) {
      throw new RefusedError(`${rel} is not a plain path relative to the repository root`, { details: { path: rel } });
    }
    const refuseInternal = () =>
      new RefusedError(`${rel} is inside .git or .specreview; SpecReview never reads or writes there`, { details: { path: rel } });
    if (segs.some(isInternalSegment)) throw refuseInternal();
    const abs = path.join(this.root, ...segs);
    let realParent;
    try {
      realParent = await fsp.realpath(path.dirname(abs));
    } catch (err) {
      if (!mustExist && isMissing(err)) return null;
      if (isMissing(err)) throw new NotFoundError(`${rel} is missing`, { details: { path: rel } });
      throw err;
    }
    if (!isWithin(this.root, realParent)) {
      throw new RefusedError(`${rel} resolves outside the repository (through a symlinked directory)`, { details: { path: rel, root: this.root } });
    }
    const relParent = path.relative(this.root, realParent);
    if (relParent && relParent.split(path.sep).some(isInternalSegment)) throw refuseInternal();
    return path.join(realParent, segs[segs.length - 1]);
  }
}

/**
 * @param {string} s a path component
 * @returns {boolean}
 */
function isInternalSegment(s) {
  const l = s.toLowerCase();
  return l === '.git' || l === STORE_DIR.toLowerCase();
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isMissing(err) {
  const code = /** @type {NodeJS.ErrnoException} */ (err)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Stable read of a regular file through a handle opened with O_NOFOLLOW (where the platform has it): 'symlink'
 * when the last component turned into a symlink, null when it vanished.
 * @param {string} abs
 * @returns {Promise<{ kind: 'file', buf: Buffer, text: string, sha256: string, mode: number } | 'symlink' | null>}
 */
async function readNoFollow(abs) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  for (let attempt = 0; ; attempt += 1) {
    let handle;
    try {
      handle = await fsp.open(abs, flags);
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'ELOOP' || code === 'EMLINK') return 'symlink';
      if (isMissing(err)) return null;
      throw err;
    }
    try {
      const before = await handle.stat();
      if (!before.isFile()) return null;
      const buf = await handle.readFile();
      const after = await handle.stat();
      const stable = before.size === after.size && before.mtimeMs === after.mtimeMs && buf.length === after.size;
      if (stable || attempt >= 4) {
        return { kind: 'file', buf, text: decodeText(buf).text, sha256: sha256(buf), mode: after.mode & 0o7777 };
      }
    } finally {
      await handle.close();
    }
  }
}

/**
 * Shape check of a code doc's CodeSpec (the engine validates the refs).
 * @param {unknown} code
 */
function assertCodeSpec(code) {
  const c = /** @type {any} */ (code);
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new UsageError('a code doc needs its code spec {mode, context, ...}');
  if (!CODE_MODES.includes(c.mode)) throw new UsageError(`invalid code review mode: ${JSON.stringify(c.mode)} (expected ${CODE_MODES.join(', ')})`);
  if (!Number.isSafeInteger(c.context) || c.context < 0) throw new UsageError(`invalid code review context: ${JSON.stringify(c.context)}`);
  if (c.paths !== undefined && (!Array.isArray(c.paths) || c.paths.some((/** @type {unknown} */ p) => typeof p !== 'string' || !p))) {
    throw new UsageError('code review paths must be non-empty strings');
  }
}

// ---------------------------------------------------------------- helpers

/**
 * @param {string} docId
 */
function assertDocId(docId) {
  if (typeof docId !== 'string' || !DOC_ID_RE.test(docId)) throw new UsageError(`invalid doc id: ${docId}`);
}

/**
 * Runtime files also accept reserved ids such as '_all'.
 * @param {string} docId
 */
function assertRuntimeDocId(docId) {
  if (typeof docId !== 'string' || !RUNTIME_DOC_ID_RE.test(docId)) throw new UsageError(`invalid doc id: ${docId}`);
}

/**
 * @param {string} docId
 * @returns {string}
 */
function waiterDocId(docId) {
  const id = docId === '*' ? ALL_DOCS : docId;
  assertRuntimeDocId(id);
  return id;
}

/**
 * The directory name is the doc's identity: a doc.json whose `id` disagrees (hand-edited, copied) is corrected in
 * memory so that later saves go back to the same directory.
 * @param {Doc} doc
 * @param {string} dirName
 * @returns {Doc}
 */
function withDirId(doc, dirName) {
  if (doc.id !== dirName) {
    log.warn(`doc.json in docs/${dirName} has id ${JSON.stringify(doc.id)}; using ${dirName}`);
    doc.id = dirName;
  }
  return doc;
}

/**
 * @param {Waiter} w
 * @returns {boolean}
 */
function isFresh(w) {
  const at = Date.parse(w.heartbeatAt);
  return Number.isFinite(at) && Date.now() - at < WAITER_LIVE_MS;
}

/**
 * @param {number | string} v
 * @returns {number}
 */
function parseVersion(v) {
  const m = typeof v === 'number' ? [String(v), String(v)] : /^v?(\d+)$/i.exec(String(v));
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new UsageError(`invalid version: ${v}`);
  return n;
}

/**
 * @param {number} v
 * @returns {string}
 */
function pad(v) {
  return String(v).padStart(4, '0');
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>} sorted entry names; [] when the directory does not exist
 */
async function readDirNames(dir) {
  try {
    return (await fsp.readdir(dir)).sort();
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
}

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function isDirectory(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {string} p
 * @returns {string}
 */
function realOrResolved(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Orders ids by prefix, then numeric suffix: t2 < t10.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareIds(a, b) {
  const ma = /^(.*?)(\d+)$/.exec(a);
  const mb = /^(.*?)(\d+)$/.exec(b);
  if (ma && mb && ma[1] === mb[1]) return Number(ma[2]) - Number(mb[2]) || cmp(a, b);
  return cmp(a, b);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * @param {Record<string, string>} obj
 * @returns {Record<string, string>}
 */
function sortKeys(obj) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}
