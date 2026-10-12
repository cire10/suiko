// @ts-check
// Packet data of a code doc (design 4.10): what feedback / wait / show print for each thread (repo file, side,
// lines in the working tree, src> / was> lines, file state), the header label, the line basis and NEXT.
//
// - loadCodeSnapshot preloads, for every file a thread cites at head, the head blobs (both sides) and the working
//   file (Store#readRepoFile: never through a symlink), so describeCodeThread is synchronous.
// - New side: the head anchor is mapped from the head blob onto the working file (preciseMapper), widened to whole
//   lines; `src` is those exact working-file lines, grown (up to 8 lines / 1200 chars) until unique in the file
//   (anchor/describe.js linesAround; a long line: the shortest unique window). A missing file prints FILE MISSING
//   and quotes the head blob. A commit-side round whose commit is not checked out quotes the head blob.
// - Old side: `lines` are base lines, `was` the base text, `nowBetween` the working lines the base position maps
//   to (base -> head new side -> working file); none for a deleted file.
// - Whole-file anchors carry no lines and no src.

import fs from 'node:fs';
import nodePath from 'node:path';
import { LIMITS } from '../../shared/protocol.js';
import { lineIndex } from '../text/index.js';
import { linesAround, windowAround } from '../anchor/describe.js';
import { anchorAt } from '../review/threadstate.js';
import { preciseMapper } from '../review/workmap.js';
import { openRepo } from './git.js';
import { baseName, isFixedEndpoint, packetLabel, short } from './spec.js';
import { codeOf, fileOfAnchor, reader } from './util.js';

/**
 * @typedef {import('../review/context.js').Ctx} Ctx
 * @typedef {import('../../shared/types.js').Doc} Doc
 * @typedef {import('../../shared/types.js').Thread} Thread
 * @typedef {import('../../shared/types.js').CodeFile} CodeFile
 * @typedef {import('../../shared/types.js').CodeManifest} CodeManifest
 * @typedef {{ kind: 'file', text: string } | { kind: 'missing' } | { kind: 'other' }} WorkingFile
 *
 * @typedef {object} CodeSnap snap.code
 * @property {CodeManifest} manifest the head round
 * @property {Map<string, string | null>} blobs decoded head blobs of the cited files, by ref
 * @property {Map<string, WorkingFile>} working the cited files in the working tree, by path
 * @property {Set<string>} changed cited paths whose working file differs from the head blob (or is missing)
 * @property {string} root the repo root (the workspace root)
 * @property {boolean} notCheckedOut a commit-side round whose commit is not HEAD (working files are not v<head>)
 * @property {Map<string, import('../review/workmap.js').PreciseMapper>} mappers head blob -> working file, by path
 */

/**
 * The kind adapter's loadExtra for code docs: adds `snap.code` (see CodeSnap) to a loaded snapshot.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {any} snap
 * @returns {Promise<void>}
 */
export async function loadCodeSnapshot(ctx, doc, snap) {
  const H = codeOf(snap.head.manifest);
  const r = reader(ctx, doc.id);
  /** @type {Map<string, string | null>} */
  const blobs = new Map();
  /** @type {Map<string, WorkingFile>} */
  const working = new Map();
  const changed = new Set();
  let notCheckedOut = false;
  if (H.newSide === 'commit') {
    try {
      notCheckedOut = (await (await openRepo(ctx.root)).head()) !== H.newSha;
    } catch {
      notCheckedOut = true;
    }
  }
  for (const t of snap.threads ?? []) {
    const a = anchorAt(t, snap.head.v);
    if (!a?.file) continue;
    const f = fileOfAnchor(H, a.file);
    if (!f) continue;
    for (const ref of [f.new, f.old]) if (ref && !blobs.has(ref)) blobs.set(ref, await r.text(ref).catch(() => null));
    if (f.status === 'D' || working.has(f.path)) continue;
    /** @type {WorkingFile} */
    let w;
    try {
      const got = await ctx.store.readRepoFile(f.path);
      w = !got ? { kind: 'missing' } : got.kind === 'file' ? { kind: 'file', text: got.text } : got.kind === 'symlink' ? { kind: 'file', text: got.target } : { kind: 'other' };
    } catch {
      w = { kind: 'other' };
    }
    working.set(f.path, w);
    const headText = f.new ? blobs.get(f.new) : null;
    if (w.kind !== 'file' || (headText != null && w.text !== headText)) changed.add(f.path);
  }
  /** @type {CodeSnap} */
  const code = { manifest: H, blobs, working, changed, root: ctx.root, notCheckedOut, mappers: new Map() };
  snap.code = code;
}

/**
 * How a path is reached from the agent's cwd: the repo path when the cwd is the root (or unknown), else relative
 * when the file is under the cwd, else absolute.
 * @param {string} rel
 * @param {string | null | undefined} root
 * @param {string | null | undefined} cwd
 * @returns {string}
 */
function fromCwd(rel, root, cwd) {
  if (!root || !cwd) return rel;
  const real = (/** @type {string} */ p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return nodePath.resolve(p);
    }
  };
  const r = real(root);
  const c = real(cwd);
  if (r === c) return rel;
  const abs = nodePath.join(r, ...rel.split('/'));
  const out = nodePath.relative(c, abs);
  if (out && !out.startsWith('..') && !nodePath.isAbsolute(out)) return out.split(nodePath.sep).join('/');
  return abs;
}

/**
 * Exact lines a..b of `text` (grown until unique), else the shortest unique window.
 * @param {string} text
 * @param {number} a
 * @param {number} b
 * @returns {{ text: string, unique: boolean, window: boolean }}
 */
function quoteLines(text, a, b) {
  const li = lineIndex(text);
  const s = Math.min(Math.max(1, a), li.count);
  const e = Math.min(Math.max(s, b), li.count);
  return linesAround(text, li, s, e, LIMITS.threadSrcChars) ?? windowAround(text, li.startOf(s), li.endOf(e), LIMITS.threadSrcChars);
}

/**
 * The kind adapter's describeThread for code docs (packet items, `show`, `threads`). See the header.
 * @param {any} snap a loaded snapshot with `snap.code`
 * @param {Thread} thread
 * @param {{ cwd?: string | null, root?: string | null, attachmentPath?: (rel: string) => string }} opts
 * @returns {{ file: string | null, fileFromCwd: string | null, side: 'new' | 'old' | null, lines: [number, number] | null,
 *   src: string | null, was: string[] | null, fileState: 'ok' | 'missing' | 'not-checked-out' | 'binary' | 'too-large' | null,
 *   srcUnique?: boolean, srcWindow?: boolean, nowBetween?: [number, number] | null, fileStatus?: string | null, crops?: string[] }}
 */
export function describeCodeThread(snap, thread, opts = {}) {
  /** @type {CodeSnap} */
  const sc = snap.code;
  const a = anchorAt(thread, snap.head.v);
  const crops = opts.attachmentPath ? (thread.attachments ?? []).map((rel) => /** @type {(rel: string) => string} */ (opts.attachmentPath)(rel)) : undefined;
  const none = { file: null, fileFromCwd: null, side: null, lines: null, src: null, was: null, fileState: null, srcUnique: true, nowBetween: null, fileStatus: null, ...(crops ? { crops } : {}) };
  if (!a || !a.file || !sc) return none;
  const af = a.file;
  const H = sc.manifest;
  const f = fileOfAnchor(H, af);
  const root = opts.root ?? sc.root;
  const base = { ...none, file: af.path, fileFromCwd: fromCwd(af.path, root, opts.cwd), side: af.side, fileStatus: f?.status ?? null };
  if (a.state === 'orphaned') return base;
  if (a.kind === 'doc') {
    const state = f?.binary ? 'binary' : f?.tooLarge ? 'too-large' : af.side === 'new' && f && sc.working.get(f.path)?.kind !== 'file' && !sc.notCheckedOut ? 'missing' : 'ok';
    return { ...base, fileState: /** @type {any} */ (state) };
  }
  if (f?.binary) return { ...base, lines: [a.src.startLine, a.src.endLine], fileState: 'binary' };
  if (af.side === 'old') return describeOld(sc, a, f, base);

  const headText = f?.new ? sc.blobs.get(f.new) ?? null : null;
  if (headText == null) return { ...base, lines: [a.src.startLine, a.src.endLine], fileState: f?.tooLarge ? 'too-large' : 'ok', src: a.src.text || null };
  const w = f ? sc.working.get(f.path) : undefined;
  if (sc.notCheckedOut || !w || w.kind !== 'file') {
    const q = quoteLines(headText, a.src.startLine, a.src.endLine);
    return { ...base, lines: [a.src.startLine, a.src.endLine], src: q.text, srcUnique: q.unique, srcWindow: q.window, fileState: sc.notCheckedOut ? 'not-checked-out' : 'missing' };
  }
  let lines = /** @type {[number, number]} */ ([a.src.startLine, a.src.endLine]);
  if (w.text !== headText) {
    const mapper = mapperFor(sc, /** @type {CodeFile} */ (f).path, headText, w.text);
    const m = mapper.mapRange(a.src.start, a.src.end);
    const li = lineIndex(w.text);
    const l0 = li.lineOf(m.start);
    lines = [l0, Math.max(l0, m.end > m.start ? li.lineOf(m.end - 1) : l0)];
  }
  const q = quoteLines(w.text, lines[0], lines[1]);
  return { ...base, lines, src: q.text, srcUnique: q.unique, srcWindow: q.window, fileState: 'ok' };
}

/**
 * The head blob -> working file mapper of a path (cached on snap.code).
 * @param {CodeSnap} sc
 * @param {string} p
 * @param {string} headText
 * @param {string} workingText
 */
function mapperFor(sc, p, headText, workingText) {
  let m = sc.mappers.get(p);
  if (!m) {
    m = preciseMapper(headText, workingText);
    sc.mappers.set(p, m);
  }
  return m;
}

/**
 * An old-side line anchor: base lines, was> lines, and where that base position now falls in the working file.
 * @param {CodeSnap} sc
 * @param {import('../../shared/types.js').Anchor} a
 * @param {CodeFile | null} f
 * @param {any} base
 */
function describeOld(sc, a, f, base) {
  const all = String(a.src.text ?? '').split('\n').map((l) => l.replace(/\r$/, ''));
  const was = all.length > 8 ? [...all.slice(0, 3), `...(${all.length - 4} more lines)`, all[all.length - 1]] : all;
  /** @type {[number, number] | null} */
  let nowBetween = null;
  const oldText = f?.old ? sc.blobs.get(f.old) ?? null : null;
  const headNew = f?.new ? sc.blobs.get(f.new) ?? null : null;
  const w = f && f.status !== 'D' ? sc.working.get(f.path) : undefined;
  if (oldText != null && headNew != null && f && f.status !== 'D') {
    const toHead = preciseMapper(oldText, headNew);
    let s = toHead.map(a.src.start, 'right');
    let e = toHead.map(a.src.end, 'left');
    let target = headNew;
    if (w?.kind === 'file' && w.text !== headNew && !sc.notCheckedOut) {
      const toWork = mapperFor(sc, f.path, headNew, w.text);
      s = toWork.map(s, 'right');
      e = toWork.map(e, 'left');
      target = w.text;
    }
    const li = lineIndex(target);
    if (e > s && target.slice(s, e).trim()) {
      const l0 = li.lineOf(s);
      nowBetween = [l0, Math.max(l0, li.lineOf(e - 1))];
    } else {
      const l = li.lineOf(Math.min(s, target.length));
      const atLineStart = s === li.startOf(l);
      nowBetween = atLineStart ? [Math.max(1, l - 1), l] : [l, Math.min(li.count, l + 1)];
    }
  }
  return { ...base, lines: [a.src.startLine, a.src.endLine], was, nowBetween, fileState: 'ok', srcUnique: true };
}

/**
 * The header label of a code packet: 'since-base origin/main, merge-base 1a2b3c4'.
 * @param {any} snap
 * @returns {string}
 */
export function codePacketLabel(snap) {
  return packetLabel(/** @type {any} */ (snap.doc.code), snap.code?.manifest ?? null);
}

/**
 * The basis lines printed under the header, Repo root line first: 'Repo root: /Users/me/repo (paths below are
 * relative to it)', 'Line numbers = files in your working tree now (all identical to v1).' (or 'k of n files
 * changed since vN: lines mapped'), and a base change line.
 * @param {any} snap
 * @param {import('../review/packet-data.js').PacketThread[]} threads
 * @returns {string[]}
 */
export function codeLineBasis(snap, threads) {
  /** @type {CodeSnap | undefined} */
  const sc = snap.code;
  const v = snap.head.v;
  const root = sc?.root ?? snap.code?.manifest?.root ?? '';
  const out = [`Repo root: ${root} (paths below are relative to it)`];
  const files = [...new Set(threads.filter((t) => t.file && t.lines && t.anchorState !== 'orphaned').map((t) => /** @type {string} */ (t.file)))];
  const pr = /** @type {any} */ (snap.doc.code ?? {}).mode === 'pr' ? /** @type {any} */ (snap.doc.code).pr : null;
  if (sc?.notCheckedOut && pr) {
    out.push(`PR #${pr.number} is not checked out here: run \`gh pr checkout ${pr.number}\` before editing; line numbers are the PR head ${short(sc.manifest.newSha)}.`);
  } else if (sc?.notCheckedOut) {
    out.push(`Line numbers = files of v${v} (commit ${short(sc.manifest.newSha)}), which is not checked out: check it out before editing.`);
  } else if (files.length) {
    const k = files.filter((p) => sc?.changed.has(p)).length;
    out.push(k ? `Line numbers = files in your working tree now (${k} of ${files.length} files changed since v${v}: lines mapped).` : `Line numbers = files in your working tree now (all identical to v${v}).`);
  }
  const H = sc?.manifest;
  if (H?.baseMoved && v > 1) {
    const spec = /** @type {any} */ (snap.doc.code ?? {});
    out.push(`Base moved since v${v - 1} (rebase or merge): old-side lines are lines of ${baseName(spec.mode, H.baseSha, spec.threeDot)}.`);
  }
  return out;
}

/**
 * The NEXT line of a code packet (without 'NEXT: '), per mode (design 4.6).
 * @param {Doc} doc
 * @param {string} ref the doc as follow-up commands name it
 * @param {{ approved: boolean, finalNow: boolean }} approval
 * @param {number} actionable
 * @returns {string}
 */
export function codeNextStep(doc, ref, { approved, finalNow }, actionable) {
  if (doc.state === 'closed') return 'the review session is closed; stop waiting';
  if (approved && actionable === 0) {
    return finalNow ? `specreview final ${ref} --decisions   (then stop waiting)` : 'approved (no final version marked); stop waiting unless the reviewer asks for more';
  }
  if (approved && finalNow) {
    return `approved: answer each thread with specreview reply ${ref} <tid> -m <md> --status answered|declined (no edits, no new round) -> specreview final ${ref} --decisions   (then stop waiting)`;
  }
  if (actionable === 0) return `nothing to act on; specreview wait ${ref} (background)`;
  const spec = /** @type {any} */ (doc.code ?? {});
  if (spec.mode === 'staged') return `edit the files -> git add <files> -> specreview revise ${ref} --replies - -> specreview wait ${ref} (background)`;
  if ((spec.mode === 'branch' || spec.mode === 'range') && !isFixedEndpoint(spec)) {
    return `edit -> commit -> specreview revise ${ref} --replies - -> specreview wait ${ref} (background)`;
  }
  return `edit the files -> specreview revise ${ref} --replies - (records round v${(doc.head ?? 0) + 1} from your working tree) -> specreview wait ${ref} (background)`;
}
