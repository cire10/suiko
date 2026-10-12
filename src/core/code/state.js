// @ts-check
// Dirty state of a code doc (design 4.13): whether the next round would differ from the head round. Stat-first and
// memoized (2 s per doc and head, while the lstat signature of the head files is unchanged), so the daemon poller and
// `GET D` cost one lstat pass when nothing changed:
//
//   worktree   lstat every head file with a new side and compare with manifest.code.stat; hash only the files whose
//              stat changed; untracked files and tracked changes outside the head file list make it dirty
//   index      a temp copy of the index -> write-tree, compared with manifest.code.newTree
//   commit     the re-resolved new-side commit (branch, range by ref) and the base
//   fixed      a --commit / range-to-sha review's v1 is never dirty; after v1 the worktree rule applies
//
// When the fast path cannot prove "clean", a dry round (no blob written) gives the exact answer: its canonical text,
// sha256 and the files whose content differs from head (`changedFiles`). Not a git repository: UsageError.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { RefusedError } from '../store/errors.js';
import { sha256 } from '../util/hash.js';
import { openRepo, splitNul, supportedName } from './git.js';
import { isFixedEndpoint } from './spec.js';
import { pathspecArgs, readWorktreeSide, resolveSides, takeCodeSnapshot } from './snapshot.js';
import { codeOf, fileMaxBytes, threadPaths } from './util.js';

/**
 * @typedef {import('../review/context.js').Ctx} Ctx
 * @typedef {import('../../shared/types.js').Doc} Doc
 * @typedef {import('../../shared/types.js').CodeFile} CodeFile
 * @typedef {import('../../shared/types.js').CodeManifest} CodeManifest
 * @typedef {import('../review/ops/common.js').HeadState} HeadState
 * @typedef {import('../review/ops/common.js').WorkingState & { changedFiles: string[] }} CodeWorkingState
 */

/** How long a computed state is reused (design 4.13). */
const MEMO_MS = 2000;

/** @type {Map<string, { at: number, sig: string, value: Promise<CodeWorkingState> }>} */
const memo = new Map();

/**
 * The lstat signature of the head round's working-tree files (size, mtime, inode; '-' when missing): a memoized
 * state is reused only while it is unchanged, so an edit is seen at once (an untracked file within MEMO_MS).
 * '' for the index and commit sides.
 * @param {Ctx} ctx
 * @param {CodeManifest} H
 * @returns {Promise<string>}
 */
async function statSignature(ctx, H) {
  if (H.newSide !== 'worktree') return '';
  const parts = await Promise.all(
    H.files
      .filter((f) => f.status !== 'D')
      .map(async (f) => {
        try {
          const st = await fsp.lstat(path.join(ctx.root, ...f.path.split('/')));
          return `${st.size}:${st.mtimeMs}:${st.ino}:${st.mode}`;
        } catch {
          return '-';
        }
      }),
  );
  return parts.join('|');
}

/**
 * Forgets the memoized states of a doc (after the engine wrote one of its files).
 * @param {string} docId
 */
export function invalidateCodeState(docId) {
  for (const k of [...memo.keys()]) if (JSON.parse(k)[0] === docId) memo.delete(k);
}

/**
 * The kind adapter's workingState for code docs (kinds.js). `text`/`sha256`/`buf` describe the canonical diff text
 * of the working tree (what the next round would record); `dirty` compares it with head; `changedFiles` lists the
 * repo-relative paths whose content differs from the head round.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {HeadState | null} head
 * @returns {Promise<CodeWorkingState>}
 */
export async function codeWorkingState(ctx, doc, head) {
  if (!head) return { text: '', sha256: null, buf: null, missing: false, dirty: true, changedFiles: [] };
  const key = JSON.stringify([doc.id, ctx.root, head.v, head.manifest.sha256]);
  const now = Date.now();
  const hit = memo.get(key);
  const sig = await statSignature(ctx, codeOf(head.manifest));
  if (hit && now - hit.at < MEMO_MS && hit.sig === sig) return hit.value;
  const value = computeState(ctx, doc, head);
  memo.set(key, { at: now, sig, value });
  value.catch(() => memo.delete(key));
  if (memo.size > 200) {
    for (const [k, m] of memo) if (now - m.at >= MEMO_MS) memo.delete(k);
  }
  return value;
}

/**
 * @param {HeadState} head
 * @returns {CodeWorkingState}
 */
function cleanState(head) {
  return { text: head.source, sha256: head.manifest.sha256, buf: Buffer.from(head.source, 'utf8'), missing: false, dirty: false, changedFiles: [] };
}

/**
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {HeadState} head
 * @returns {Promise<CodeWorkingState>}
 */
async function computeState(ctx, doc, head) {
  const H = codeOf(head.manifest);
  const spec = /** @type {import('../../shared/types.js').CodeSpec} */ (doc.code);
  const repo = await openRepo(ctx.root);
  if (await provablyClean(ctx, doc, repo, H, head)) return cleanState(head);
  const opts = await roundOptions(ctx, doc, H, head.v, { keepCarried: true });
  let snap;
  try {
    snap = await takeCodeSnapshot(ctx, spec, { prev: H, ...opts, dry: true });
  } catch (err) {
    // the next round would be refused (unmerged index entries, too many files): not recordable as it is
    if (err instanceof RefusedError) return { text: head.source, sha256: null, buf: null, missing: false, dirty: true, changedFiles: [] };
    throw err;
  }
  const hash = sha256(snap.buf);
  const dirty = hash !== head.manifest.sha256;
  return { text: snap.text, sha256: hash, buf: snap.buf, missing: false, dirty, changedFiles: dirty ? changedPaths(H, snap.code) : [] };
}

/**
 * The fast path: true when the next round is certainly identical to head.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {import('./git.js').Repo} repo
 * @param {CodeManifest} H
 * @param {HeadState} head
 * @returns {Promise<boolean>}
 */
async function provablyClean(ctx, doc, repo, H, head) {
  const spec = /** @type {import('../../shared/types.js').CodeSpec} */ (doc.code);
  if (isFixedEndpoint(spec) && head.v === 1 && H.newSide === 'commit') return true;
  let sides;
  try {
    sides = await resolveSides(repo, spec, H);
  } catch {
    return false;
  }
  if (sides.baseSha !== H.baseSha || sides.newSide !== H.newSide) return false;
  if (sides.newSide === 'commit') return sides.newSha === H.newSha;
  if (sides.newSide === 'index') {
    try {
      return (await repo.indexTree(ctx.store)) === H.newTree;
    } catch {
      return false;
    }
  }
  // worktree: the head files by stat (hash on a stat change), then anything new
  const maxBytes = fileMaxBytes(ctx.config);
  for (const f of H.files) {
    if (f.status === 'D') {
      try {
        await fsp.lstat(path.join(repo.root, ...f.path.split('/')));
        return false;
      } catch {
        continue;
      }
    }
    let st;
    try {
      st = await fsp.lstat(path.join(repo.root, ...f.path.split('/')));
    } catch {
      return false;
    }
    const known = H.stat?.[f.path];
    if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) continue;
    const ref = f.new ?? /** @type {any} */ (f).ids?.new ?? null;
    if (!ref || !String(ref).startsWith('sha256:')) return false;
    const r = await readWorktreeSide(ctx, repo.root, f.path, maxBytes);
    if (r.kind !== 'file' || `sha256:${sha256(r.buf)}` !== ref) return false;
  }
  const listed = new Set([...H.files.flatMap((f) => [f.path, f.oldPath ?? '']), ...(H.skipped ?? []).map((s) => s.path)]);
  const opts = await roundOptions(ctx, doc, H, head.v, { keepCarried: true });
  const specArgs = pathspecArgs(spec, H.newSide === 'worktree' && isFixedEndpoint(spec), opts.restrict);
  if (!specArgs) return true;
  for (const raw of await repo.untracked(specArgs)) {
    if (raw[raw.length - 1] === 0x2f) continue;
    const name = supportedName(raw);
    if (!name || !listed.has(name)) return false;
  }
  const r = await repo.run(['diff-index', '-z', '--name-only', '--no-ext-diff', '--end-of-options', H.baseSha, '--', ...specArgs], { timeoutMs: 120000 });
  for (const raw of splitNul(r.stdout)) {
    const name = supportedName(raw);
    if (!name || !listed.has(name)) return false;
  }
  return true;
}

/**
 * The options of the next round of a doc: `carry` (paths of unresolved threads at head; with keepCarried also the
 * head's carried '=' files, so a resolved thread alone does not change the round), `restrict` (a fixed-endpoint
 * review after v1: the files of v1 and head plus `carry`) and `maxFiles` (doc.code.maxFiles).
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {CodeManifest} H the head round
 * @param {number} headV
 * @param {{ keepCarried?: boolean }} [opts]
 * @returns {Promise<{ carry: string[], restrict: string[] | null, maxFiles: number | null }>}
 */
export async function roundOptions(ctx, doc, H, headV, { keepCarried = false } = {}) {
  const spec = /** @type {any} */ (doc.code);
  const threads = await ctx.store.listThreads(doc.id);
  const carry = new Set(threadPaths(threads, headV));
  if (keepCarried) for (const f of H.files) if (f.status === '=') carry.add(f.path);
  /** @type {string[] | null} */
  let restrict = null;
  if (isFixedEndpoint(spec)) {
    const set = new Set(carry);
    const add = (/** @type {CodeManifest} */ c) => {
      for (const f of c.files) {
        set.add(f.path);
        if (f.oldPath) set.add(f.oldPath);
      }
    };
    add(H);
    if (headV > 1) {
      try {
        add(codeOf((await ctx.store.readVersion(doc.id, 1)).manifest));
      } catch {
        // v1 unreadable: head's files are the review's files
      }
    }
    restrict = [...set].sort();
  }
  const mf = Number(spec?.maxFiles);
  return { carry: [...carry].sort(), restrict, maxFiles: Number.isSafeInteger(mf) && mf > 0 ? mf : null };
}

/**
 * Paths whose content (or presence) differs between two rounds: added, dropped, or a different side or status.
 * @param {CodeManifest} H
 * @param {CodeManifest} N
 * @returns {string[]}
 */
export function changedPaths(H, N) {
  const sig = (/** @type {CodeFile} */ f) => JSON.stringify([f.status, f.oldPath ?? null, f.new ?? null, /** @type {any} */ (f).ids?.new ?? null, f.tooLarge ?? null, f.mode?.new ?? null]);
  const h = new Map(H.files.map((f) => [f.path, sig(f)]));
  const n = new Map(N.files.map((f) => [f.path, sig(f)]));
  const out = new Set();
  for (const [p, s] of n) if (h.get(p) !== s) out.add(p);
  for (const p of h.keys()) if (!n.has(p)) out.add(p);
  return [...out].sort();
}
