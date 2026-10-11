// @ts-check
// Taking a round of a code review (design 4.3 - 4.6): resolve both sides per the spec, list the changed files
// (untracked included through a temporary index, renames paired, secrets and huge untracked files excluded,
// unsupported names skipped), read every text side (the working tree's new side from disk, never through a symlink),
// store the sides as doc blobs and build the canonical diff text.
//
//   takeCodeSnapshot(ctx, spec, { prev, docId, carry, restrict, maxFiles, dry }) -> { text, buf, code, texts }
//     prev      the head round's CodeManifest (null for v1): a ref base is re-computed every round (baseMoved), an
//               explicit commit-id base stays fixed, a fixed endpoint (--commit, range ending in a commit id) switches
//               to the working tree from v2 on, restricted to `restrict`
//     carry     paths that hold open threads: kept with status '=' (both blobs) when unchanged against base
//     dry       compute everything but write no blob (working-state checks, dry runs, the first round before its doc
//               exists: `bufs` keeps the bytes); `texts` maps every text blob ref of the round to its decoded text

import fsp from 'node:fs/promises';
import path from 'node:path';
import { LIMITS } from '../../shared/protocol.js';
import { NotFoundError, RefusedError, UsageError } from '../store/errors.js';
import { lineHunks } from '../diff/index.js';
import { sha256 } from '../util/hash.js';
import { countLines, decodeText } from '../util/stable-read.js';
import { STORE_EXCLUDE, displayName, literal, looksSecret, openRepo, supportedName } from './git.js';
import { isFixedEndpoint, isShaLike } from './spec.js';
import { canonicalText } from './diff-text.js';
import { fileMaxBytes, mapLimit, maxFilesOf } from './util.js';

/**
 * @typedef {import('../review/context.js').Ctx} Ctx
 * @typedef {import('../../shared/types.js').CodeSpec} CodeSpec
 * @typedef {import('../../shared/types.js').CodeFile} CodeFile
 * @typedef {import('../../shared/types.js').CodeManifest} CodeManifest
 * @typedef {import('./git.js').Repo} Repo
 * @typedef {{ path: string, reason: 'binary' | 'too-large' | 'submodule' | 'excluded' | 'unsupported-name', old?: string, new?: string }} Skip
 * @typedef {{ text: string, buf: Buffer, code: CodeManifest, texts: Map<string, string>, bufs: Map<string, Buffer> }} CodeSnapshot
 *   bufs: a dry round's blob bytes by ref (empty otherwise), to store them later (Store#putDocBlob gives the same ref)
 */

/** Bytes inspected for a NUL (binary detection, like git). */
const BINARY_SNIFF = 8000;

/**
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isBinary(buf) {
  return buf.subarray(0, BINARY_SNIFF).includes(0);
}

/**
 * The sides of a round: base commit and tree, new-side kind, commit and tree source.
 * @param {Repo} repo
 * @param {CodeSpec} spec
 * @param {CodeManifest | null} prev
 * @returns {Promise<{ baseSha: string, headSha: string | null, newSha: string | null, newSide: 'commit' | 'worktree' | 'index' }>}
 */
export async function resolveSides(repo, spec, prev) {
  const headSha = await repo.head();
  const empty = await repo.emptyTree();
  const fixedAfterV1 = Boolean(prev) && isFixedEndpoint(spec);
  /** @type {string} */
  let baseSha;
  /** @type {string | null} */
  let newSha = null;
  /** @type {'commit' | 'worktree' | 'index'} */
  let newSide = 'worktree';
  const commitOf = async (/** @type {string} */ rev, /** @type {string} */ what) => {
    const c = await repo.verifyCommit(rev);
    if (!c) throw new NotFoundError(`${what} not found: "${rev}" does not name a commit in this repository`, { details: { rev } });
    return c;
  };
  switch (spec.mode) {
    case 'since-base':
    case 'branch': {
      if (prev && isShaLike(spec.base)) baseSha = prev.baseSha;
      else {
        const bc = await commitOf(String(spec.base), 'base');
        if (!headSha) throw new NotFoundError(`HEAD has no commits yet: there is no merge-base with ${spec.base} (review --uncommitted instead)`);
        const mb = await repo.mergeBase(bc, headSha);
        if (!mb) throw new NotFoundError(`${spec.base} and HEAD have no common ancestor (no merge-base): review a range instead`, { details: { base: spec.base } });
        baseSha = mb;
      }
      if (spec.mode === 'branch') {
        if (!headSha) throw new NotFoundError('HEAD has no commits yet: nothing is committed to review');
        newSha = headSha;
        newSide = 'commit';
      }
      break;
    }
    case 'uncommitted':
      baseSha = headSha ?? empty;
      break;
    case 'staged':
      baseSha = headSha ?? empty;
      newSide = 'index';
      break;
    case 'range': {
      const toC = await commitOf(String(spec.to), 'range end');
      if (prev && isShaLike(spec.from) && (!spec.threeDot || isShaLike(spec.to))) baseSha = prev.baseSha;
      else {
        const fromC = await commitOf(String(spec.from), 'range start');
        if (spec.threeDot) {
          const mb = await repo.mergeBase(fromC, toC);
          if (!mb) throw new NotFoundError(`${spec.from} and ${spec.to} have no common ancestor (no merge-base): use A..B`);
          baseSha = mb;
        } else baseSha = fromC;
      }
      newSha = toC;
      newSide = 'commit';
      break;
    }
    case 'commit': {
      const c = await commitOf(String(spec.commit), 'commit');
      baseSha = prev ? prev.baseSha : ((await repo.parentOf(c)) ?? empty);
      newSha = c;
      newSide = 'commit';
      break;
    }
    case 'pr':
      throw new UsageError('PR reviews (review --pr) are not available in this build');
    default:
      throw new UsageError(`unsupported code review mode: ${JSON.stringify(spec.mode)}`);
  }
  if (fixedAfterV1) {
    newSide = 'worktree';
    newSha = null;
  }
  return { baseSha, headSha, newSha, newSide };
}

/**
 * The pathspec arguments of a round (diff-tree, ls-files): the user's --path values (magic kept), or for a fixed
 * endpoint after v1 the literal paths of `restrict`; always the store exclude. null: nothing can match (an empty
 * restriction).
 * @param {CodeSpec} spec
 * @param {boolean} restricted
 * @param {string[] | null | undefined} restrict
 * @returns {string[] | null}
 */
export function pathspecArgs(spec, restricted, restrict) {
  if (restricted) {
    const list = [...new Set(restrict ?? [])].sort();
    if (!list.length) return null;
    return [...list.map(literal), STORE_EXCLUDE];
  }
  return [...(spec.paths ?? []), STORE_EXCLUDE];
}

/**
 * Takes a round (see the header).
 * @param {Ctx} ctx
 * @param {CodeSpec} spec
 * @param {{ prev?: CodeManifest | null, docId?: string | null, carry?: string[], restrict?: string[] | null,
 *   maxFiles?: number | null, dry?: boolean }} [opts]
 * @returns {Promise<CodeSnapshot>}
 */
export async function takeCodeSnapshot(ctx, spec, { prev = null, docId = null, carry = [], restrict = null, maxFiles = null, dry = false } = {}) {
  if (!dry && !docId) throw new UsageError('takeCodeSnapshot: docId is required to store blobs');
  const repo = await openRepo(ctx.root);
  const maxBytes = fileMaxBytes(ctx.config);
  const limit = maxFilesOf(maxFiles, ctx.config);
  const sides = await resolveSides(repo, spec, prev);
  const restricted = Boolean(prev) && isFixedEndpoint(spec);
  const specArgs = pathspecArgs(spec, restricted, restrict);
  const baseTree = await repo.treeOf(sides.baseSha);

  /** @type {Skip[]} */
  const skipped = [];
  /** @type {Array<{ path: string, bytes: number, mode: string, stat: { size: number, mtimeMs: number } }>} */
  const largeUntracked = [];
  /** @type {Buffer[]} */
  const excludedRaw = [];
  /** @type {string | null} */
  let newTree = null;

  if (specArgs) {
    if (sides.newSide === 'worktree') {
      // untracked files first: secrets and huge files are kept out of the temp index (no object is written)
      for (const raw of await repo.untracked(specArgs)) {
        if (raw[raw.length - 1] === 0x2f) continue; // a nested repository (git add records it as a submodule)
        const name = supportedName(raw);
        if (looksSecret(raw.toString('latin1'))) {
          excludedRaw.push(raw);
          skipped.push({ path: name ?? displayName(raw), reason: 'excluded' });
          continue;
        }
        let st;
        try {
          st = await fsp.lstat(Buffer.concat([Buffer.from(`${repo.root}${path.sep}`), raw]));
        } catch {
          continue;
        }
        if (st.isFile() && st.size > maxBytes) {
          excludedRaw.push(raw);
          if (name) largeUntracked.push({ path: name, bytes: st.size, mode: st.mode & 0o111 ? '100755' : '100644', stat: { size: st.size, mtimeMs: st.mtimeMs } });
          else skipped.push({ path: displayName(raw), reason: 'unsupported-name' });
        }
      }
      if (excludedRaw.length > LIMITS.untrackedExcludeMax) {
        throw new RefusedError(`${excludedRaw.length} untracked files are too large or look like secrets (more than ${LIMITS.untrackedExcludeMax}): add them to .gitignore, or narrow the review with --path`, {
          details: { excluded: excludedRaw.length },
        });
      }
      newTree = await worktreeTreeOf(repo, ctx, spec, restricted, restrict, excludedRaw);
    } else if (sides.newSide === 'index') {
      newTree = await repo.indexTree(ctx.store);
    } else {
      newTree = await repo.treeOf(/** @type {string} */ (sides.newSha));
    }
  }

  const raw = specArgs && newTree ? await repo.diffTrees(baseTree, newTree, specArgs) : [];
  if (raw.length + largeUntracked.length > limit) {
    throw new RefusedError(
      `${raw.length + largeUntracked.length} files changed, more than the limit of ${limit}: narrow the review with --path <pathspec>, or raise --max-files (at most ${LIMITS.codeMaxFilesHard})`,
      { details: { files: raw.length + largeUntracked.length, limit } },
    );
  }

  /** @type {Map<string, string>} */
  const texts = new Map();
  /** @type {Map<string, Buffer>} */
  const bufs = new Map();
  /** @type {Record<string, { size: number, mtimeMs: number }>} */
  const stat = {};
  /** @type {CodeFile[]} */
  const files = [];
  const store = async (/** @type {Buffer} */ buf) => {
    const ref = dry ? `sha256:${sha256(buf)}` : await ctx.store.putDocBlob(/** @type {string} */ (docId), buf);
    if (!texts.has(ref)) texts.set(ref, decodeText(buf).text);
    if (dry) bufs.set(ref, buf);
    return ref;
  };

  // classify, then read the git-side contents in one batch
  /** @type {Array<{ f: CodeFile, oldId: string | null, newId: string | null, newPath: string | null }>} */
  const work = [];
  for (const e of raw) {
    const name = supportedName(e.path);
    const oldName = e.oldPath ? supportedName(e.oldPath) : null;
    if (!name || (e.oldPath && !oldName)) {
      skipped.push({ path: displayName(e.path), reason: 'unsupported-name' });
      continue;
    }
    const status = /** @type {CodeFile['status']} */ (['A', 'M', 'D', 'R', 'T'].includes(e.status) ? e.status : 'M');
    /** @type {CodeFile} */
    const f = { path: name, status, added: 0, removed: 0 };
    if (status === 'R' && oldName) f.oldPath = oldName;
    /** @type {{ old?: string, new?: string }} */
    const mode = {};
    if (!/^0+$/.test(e.oldMode)) mode.old = e.oldMode;
    if (!/^0+$/.test(e.newMode)) mode.new = e.newMode;
    if (mode.old || mode.new) f.mode = mode;
    if (e.oldMode === '160000' || e.newMode === '160000') {
      /** @type {Skip} */
      const sk = { path: name, reason: 'submodule' };
      if (e.oldMode === '160000') sk.old = e.oldId;
      if (e.newMode === '160000') sk.new = e.newId;
      skipped.push(sk);
      files.push(f);
      continue;
    }
    work.push({ f, oldId: status === 'A' ? null : e.oldId, newId: status === 'D' ? null : e.newId, newPath: status === 'D' ? null : name });
  }

  const gitIds = work.flatMap((w) => [w.oldId, sides.newSide === 'worktree' ? null : w.newId]).filter((x) => typeof x === 'string');
  const objects = await repo.blobs(/** @type {string[]} */ (gitIds), maxBytes);

  /**
   * A git-side blob -> bytes, or a tooLarge marker.
   * @param {string} id
   * @returns {{ buf: Buffer } | { tooLarge: number | null }}
   */
  const gitSide = (id) => {
    const o = objects.get(id);
    if (!o || o.missing) return { tooLarge: null };
    if ((o.size ?? 0) > maxBytes || !o.buf) return { tooLarge: o.size };
    return { buf: o.buf };
  };

  await mapLimit(work, 16, async (w) => {
    const f = w.f;
    /** @type {Buffer | null} */
    let oldBuf = null;
    /** @type {Buffer | null} */
    let newBuf = null;
    if (w.oldId) {
      const r = gitSide(w.oldId);
      if ('buf' in r) oldBuf = r.buf;
      else f.tooLarge = { side: 'old', bytes: r.tooLarge };
    }
    if (w.newPath) {
      if (sides.newSide === 'worktree') {
        const r = await readWorktreeSide(ctx, repo.root, w.newPath, maxBytes);
        if (r.stat) stat[w.newPath] = r.stat;
        if (r.kind === 'missing') {
          // removed while the round was taken: the bytes read win
          if (f.status === 'A') {
            f.status = /** @type {any} */ ('gone');
            return;
          }
          f.status = 'D';
          if (f.oldPath) {
            f.path = f.oldPath;
            delete f.oldPath;
          }
        } else if (r.kind === 'too-large') f.tooLarge ??= { side: 'new', bytes: r.bytes };
        else if (r.kind === 'refused') {
          f.status = /** @type {any} */ ('gone');
          skipped.push({ path: f.path, reason: 'unsupported-name' });
          return;
        } else newBuf = r.buf;
      } else if (w.newId) {
        const r = gitSide(w.newId);
        if ('buf' in r) newBuf = r.buf;
        else f.tooLarge ??= { side: 'new', bytes: r.tooLarge };
      }
    }
    if ((oldBuf && isBinary(oldBuf)) || (newBuf && isBinary(newBuf))) {
      f.binary = true;
      /** @type {any} */ (f).ids = gitIdsOf(w, oldBuf, newBuf);
      return;
    }
    if (f.tooLarge) {
      /** @type {any} */ (f).ids = gitIdsOf(w, oldBuf, newBuf);
      return;
    }
    const oldText = oldBuf ? decodeText(oldBuf).text : '';
    const newText = newBuf ? decodeText(newBuf).text : '';
    if (oldBuf && countLines(oldText) > LIMITS.codeFileMaxLines) f.tooLarge = { side: 'old', bytes: oldBuf.length };
    else if (newBuf && countLines(newText) > LIMITS.codeFileMaxLines) f.tooLarge = { side: 'new', bytes: newBuf.length };
    if (f.tooLarge) {
      /** @type {any} */ (f).ids = gitIdsOf(w, oldBuf, newBuf);
      return;
    }
    if (oldBuf) f.old = await store(oldBuf);
    if (newBuf) f.new = await store(newBuf);
    const hs = lineHunks(oldText, newText);
    f.added = hs.reduce((n, h) => n + h.newLines, 0);
    f.removed = hs.reduce((n, h) => n + h.oldLines, 0);
  });
  for (const w of work) if (/** @type {string} */ (w.f.status) !== 'gone') files.push(w.f);

  for (const u of largeUntracked) {
    files.push({ path: u.path, status: 'A', tooLarge: { side: 'new', bytes: u.bytes }, mode: { new: u.mode }, added: 0, removed: 0 });
    stat[u.path] = u.stat;
  }
  for (const f of files) {
    if (f.binary && !skipped.some((s) => s.path === f.path)) skipped.push({ path: f.path, reason: 'binary' });
    else if (f.tooLarge && !skipped.some((s) => s.path === f.path)) skipped.push({ path: f.path, reason: 'too-large' });
  }

  // carried files: open threads keep their file in the round while it is unchanged against base
  const listed = new Set(files.flatMap((f) => [f.path, f.oldPath].filter(Boolean)));
  const toCarry = [...new Set(carry)].filter((p) => !listed.has(p) && !skipped.some((s) => s.path === p));
  if (toCarry.length && newTree !== null) {
    const inBase = await repo.lsTree(baseTree, toCarry);
    const inNew = sides.newSide === 'worktree' ? null : await repo.lsTree(newTree, toCarry);
    const ids = [...inBase.values(), ...(inNew ? [...inNew.values()] : [])].filter((x) => x.type === 'blob').map((x) => x.id);
    const objs = await repo.blobs(ids, maxBytes);
    for (const p of toCarry) {
      const b = inBase.get(p);
      if (!b || b.type !== 'blob') continue;
      const ob = objs.get(b.id);
      if (!ob?.buf || isBinary(ob.buf)) continue;
      /** @type {Buffer | null} */
      let nb = null;
      if (sides.newSide === 'worktree') {
        const r = await readWorktreeSide(ctx, repo.root, p, maxBytes);
        if (r.kind !== 'file') continue;
        nb = r.buf;
        if (r.stat) stat[p] = r.stat;
      } else {
        const n = inNew?.get(p);
        nb = n ? objs.get(n.id)?.buf ?? null : null;
      }
      if (!nb || isBinary(nb)) continue;
      files.push({ path: p, status: '=', old: await store(ob.buf), new: await store(nb), mode: { old: b.mode, new: b.mode }, added: 0, removed: 0 });
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.reason < b.reason ? -1 : 1));
  const uniqSkipped = skipped.filter((s, i) => i === 0 || s.path !== skipped[i - 1].path || s.reason !== skipped[i - 1].reason);

  /** @type {CodeManifest} */
  const code = {
    root: repo.root,
    baseSha: sides.baseSha,
    headSha: sides.headSha,
    newSha: sides.newSha,
    newTree,
    newSide: sides.newSide,
    baseMoved: prev && prev.baseSha !== sides.baseSha ? { from: prev.baseSha, to: sides.baseSha } : null,
    files,
    skipped: uniqSkipped,
    stat: sides.newSide === 'worktree' ? sortKeys(stat) : {},
  };
  const text = canonicalText(spec, code, (ref) => (ref ? texts.get(ref) ?? null : null));
  return { text, buf: Buffer.from(text, 'utf8'), code, texts, bufs };
}

/**
 * The git blob ids of a stub's sides (so a changed binary or huge file changes the round's text).
 * @param {{ oldId: string | null, newId: string | null }} w
 * @param {Buffer | null} oldBuf
 * @param {Buffer | null} newBuf
 */
function gitIdsOf(w, oldBuf, newBuf) {
  /** @type {{ old?: string, new?: string }} */
  const ids = {};
  if (w.oldId) ids.old = w.oldId;
  if (w.newId && !/^0+$/.test(w.newId)) ids.new = w.newId;
  else if (newBuf) ids.new = `sha256:${sha256(newBuf)}`;
  void oldBuf;
  return ids;
}

/**
 * @param {Record<string, any>} o
 */
function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/**
 * The new-side tree of a worktree round: a temp index with `add -A` of the review's pathspecs (positive ones that
 * match nothing are dropped: `git add` refuses them), minus the store and the excluded untracked files.
 * @param {Repo} repo
 * @param {Ctx} ctx
 * @param {CodeSpec} spec
 * @param {boolean} restricted
 * @param {string[] | null | undefined} restrict
 * @param {Buffer[]} excludedRaw
 * @returns {Promise<string>}
 */
async function worktreeTreeOf(repo, ctx, spec, restricted, restrict, excludedRaw) {
  const positives = restricted ? [...new Set(restrict ?? [])].map(literal) : [...(spec.paths ?? [])];
  /** @type {string[]} */
  let matching = positives;
  if (positives.length) {
    matching = [];
    for (const p of positives) {
      const r = await repo.run(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', p]);
      if (r.stdout.length) matching.push(p);
    }
  }
  const excludes = [Buffer.from(STORE_EXCLUDE), ...excludedRaw.map((r) => Buffer.concat([Buffer.from(':(exclude,literal)'), r]))];
  if (positives.length && !matching.length) {
    // nothing on disk or in the index matches: the tree of the index as it is (deletions show against base)
    return repo.tempIndex(ctx.store, (idx) => repo.text(['write-tree'], { indexFile: idx }));
  }
  return repo.worktreeTree(ctx.store, [...matching.map((p) => Buffer.from(p)), ...excludes]);
}

/**
 * Reads the new side of a file from the working tree (Store#readRepoFile: lstat, never following a symlink; a
 * symlink's side is its link text). The stat is taken BEFORE the read: a change during the read changes the stat,
 * so the next dirty check re-reads the file.
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} rel
 * @param {number} maxBytes
 * @returns {Promise<{ kind: 'file', buf: Buffer, stat: { size: number, mtimeMs: number } } | { kind: 'too-large', bytes: number, stat: { size: number, mtimeMs: number } }
 *   | { kind: 'missing', stat?: undefined } | { kind: 'refused', stat?: undefined }>}
 */
export async function readWorktreeSide(ctx, root, rel, maxBytes) {
  let st;
  try {
    st = await fsp.lstat(path.join(root, ...rel.split('/')));
  } catch {
    return { kind: 'missing' };
  }
  const s = { size: st.size, mtimeMs: st.mtimeMs };
  if (!st.isSymbolicLink() && !st.isFile()) return { kind: 'missing' };
  if (st.isFile() && st.size > maxBytes) return { kind: 'too-large', bytes: st.size, stat: s };
  let r;
  try {
    r = await ctx.store.readRepoFile(rel);
  } catch (err) {
    if (err instanceof RefusedError || err instanceof UsageError) return { kind: 'refused' };
    throw err;
  }
  if (!r) return { kind: 'missing' };
  if (r.kind === 'symlink') return { kind: 'file', buf: Buffer.from(r.target, 'utf8'), stat: s };
  if (r.kind !== 'file') return { kind: 'missing' };
  return { kind: 'file', buf: r.buf, stat: s };
}
