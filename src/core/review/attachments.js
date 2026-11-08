// @ts-check
// Agent attachments on thread replies ("rich replies"): an agent answers a thread with pictures or a live preview it
// made (a chart, a mock-up, a rendered table), and the reviewer can iterate on them in the thread and ask for one
// to be put into the doc ("Use in doc", a reviewer reply carrying `use`).
//
//   loadAttachments(ctx, paths, { what })   reads and checks the files in the agent's own process (CLI or MCP;
//                                           relative paths resolve against ctx.cwd) -> LoadedAttachment[]; nothing is
//                                           written, so a bad file fails the whole reply before anything changes
//   storeAttachments(ctx, doc, loaded)      copies them into the doc's store as attachments/aN.<ext> (ids allocated
//                                           on `doc`, whose counters the caller saves with it) -> CommentAttachment[]
//   loadReplyAttachments / storeReplyAttachments: the same for every reply of a revise (threads.tN.attachments)
//   useTargets(thread)                      the attachment paths of a thread a reviewer reply may `use`
//
// Rules (protocol.js AGENT_ATTACHMENT_KINDS, LIMITS):
// - .png .jpg .jpeg .gif .webp .svg (kind 'image') and .html .htm (kind 'html'), by extension; raster images must
//   carry their format's signature and an SVG must contain an <svg> element, so a mislabelled file fails clearly;
// - at most LIMITS.maxAttachmentBytes each, LIMITS.maxReplyAttachments per reply, no empty file;
// - a regular file, never a directory, and never a symlink (the last path component; read with O_NOFOLLOW so the
//   file cannot be swapped for one after the check);
// - never a path the content origin refuses (util/paths.js isDeniedPath: dot-files and dot-directories such as
//   ~/.ssh or .env, key files), so a secret is never copied into the store, which is committed. The check covers the
//   part of the path below the agent's cwd when the file is there, else below the workspace root, else below the
//   home directory, else the whole path, on the path as given and on its real path: a project that itself lives in
//   a dot-directory (a git worktree under .claude/worktrees/) attaches its own files, ~/.ssh/x.png never.
// Stored names are the store's ('a7.png', 'jpeg' -> 'jpg', 'htm' -> 'html'); `name` keeps the original file name
// (control characters dropped, at most 120 characters) for the UI and the packet's `use:` lines.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AGENT_ATTACHMENT_KINDS, LIMITS } from '../../shared/protocol.js';
import { NotFoundError, UsageError } from '../store/errors.js';
import { isDeniedPath, isWithin, toPosix } from '../util/paths.js';

/**
 * @typedef {import('./context.js').Ctx} Ctx
 * @typedef {import('../../shared/types.js').Doc} Doc
 * @typedef {import('../../shared/types.js').Thread} Thread
 * @typedef {import('../../shared/types.js').CommentAttachment} CommentAttachment
 * @typedef {{ abs: string, name: string, ext: string, kind: 'image' | 'html', buf: Buffer }} LoadedAttachment
 */

/** Longest original file name kept. */
const MAX_NAME = 120;

/** Extension a stored attachment gets for each accepted extension. */
const STORED_EXT = /** @type {Record<string, string>} */ ({ jpeg: 'jpg', htm: 'html' });

/** The accepted extensions, for messages: '.png .jpg .jpeg .gif .webp .svg .html .htm'. */
export const ATTACHMENT_EXTS = Object.keys(AGENT_ATTACHMENT_KINDS).map((e) => `.${e}`).join(' ');

/**
 * Reads and checks the files of one reply (see the header). Throws UsageError (wrong type, too large, too many,
 * empty, a directory, a symlink, a hidden or key-like path) or NotFoundError (no such file); never writes.
 * @param {Ctx} ctx
 * @param {unknown} paths
 * @param {{ what?: string }} [opts] what: the reply, for messages ('reply to t3', 'threads.t3.attachments')
 * @returns {Promise<LoadedAttachment[]>}
 */
export async function loadAttachments(ctx, paths, { what = 'attachments' } = {}) {
  if (paths == null) return [];
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && p.trim())) {
    throw new UsageError(`${what}: expected a list of file paths`);
  }
  const list = [...new Set(paths.map((p) => p.trim()))];
  if (list.length > LIMITS.maxReplyAttachments) {
    throw new UsageError(`${what}: at most ${LIMITS.maxReplyAttachments} files per reply (got ${list.length})`);
  }
  const bases = [ctx.cwd, ctx.root, os.homedir()].filter((b) => typeof b === 'string' && b).map((b) => path.resolve(b));
  /** @type {LoadedAttachment[]} */
  const out = [];
  for (const p of list) out.push(await loadOne(path.resolve(ctx.cwd), bases, p, what));
  return out;
}

/**
 * The part of an absolute path the hidden-path rule looks at: below the first base (the cwd, the workspace root, the
 * home directory) that contains it, else the whole path (see the header).
 * @param {string} abs
 * @param {string[]} bases absolute
 * @returns {string} POSIX
 */
function exposedPart(abs, bases) {
  for (const b of bases) {
    if (abs !== b && isWithin(b, abs)) return toPosix(path.relative(b, abs));
  }
  return toPosix(abs);
}

/**
 * The real paths of the bases that exist (the real path of a file is checked against them).
 * @param {string[]} bases
 * @returns {Promise<string[]>}
 */
async function realBases(bases) {
  const out = [];
  for (const b of bases) {
    try {
      out.push(await fsp.realpath(b));
    } catch {
      // gone: not a base
    }
  }
  return out;
}

/**
 * @param {string} cwd absolute
 * @param {string[]} bases absolute (see exposedPart)
 * @param {string} given
 * @param {string} what
 * @returns {Promise<LoadedAttachment>}
 */
async function loadOne(cwd, bases, given, what) {
  if (given.includes('\0')) throw new UsageError(`${what}: invalid file path`);
  const abs = path.resolve(cwd, given);
  const ext = path.extname(abs).slice(1).toLowerCase();
  const kind = /** @type {'image' | 'html' | undefined} */ (Object.hasOwn(AGENT_ATTACHMENT_KINDS, ext) ? /** @type {any} */ (AGENT_ATTACHMENT_KINDS)[ext] : undefined);
  if (!kind) throw new UsageError(`${what}: ${given} is not an attachable file (allowed: ${ATTACHMENT_EXTS})`);
  if (isDeniedPath(exposedPart(abs, bases))) {
    throw new UsageError(`${what}: refusing to attach ${given}: it is a hidden (dot) file or directory, or looks like a key file`);
  }
  let st;
  try {
    st = await fsp.lstat(abs);
  } catch {
    throw new NotFoundError(`${what}: no such file: ${given}`, { details: { path: abs } });
  }
  if (st.isSymbolicLink()) throw new UsageError(`${what}: ${given} is a symlink; attach the file itself`);
  if (st.isDirectory()) throw new UsageError(`${what}: ${given} is a directory; attach files`);
  if (!st.isFile()) throw new UsageError(`${what}: ${given} is not a regular file`);
  let real = abs;
  try {
    real = await fsp.realpath(abs);
  } catch {
    // vanished meanwhile: the open below reports it
  }
  if (real !== abs && isDeniedPath(exposedPart(real, await realBases(bases)))) {
    throw new UsageError(`${what}: refusing to attach ${given}: it lies in a hidden (dot) directory`);
  }
  const buf = await readNoFollow(abs, given, what);
  if (!buf.length) throw new UsageError(`${what}: ${given} is empty`);
  const problem = contentProblem(ext, buf);
  if (problem) throw new UsageError(`${what}: ${given} ${problem}`);
  return { abs, name: displayName(abs), ext: STORED_EXT[ext] ?? ext, kind, buf };
}

/**
 * The file's bytes, opened without following a symlink, at most LIMITS.maxAttachmentBytes.
 * @param {string} abs
 * @param {string} given
 * @param {string} what
 * @returns {Promise<Buffer>}
 */
async function readNoFollow(abs, given, what) {
  let fh;
  try {
    fh = await fsp.open(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ELOOP') throw new UsageError(`${what}: ${given} is a symlink; attach the file itself`);
    if (code === 'ENOENT') throw new NotFoundError(`${what}: no such file: ${given}`, { details: { path: abs } });
    throw new UsageError(`${what}: cannot read ${given}: ${/** @type {Error} */ (err).message}`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new UsageError(`${what}: ${given} is not a regular file`);
    if (st.size > LIMITS.maxAttachmentBytes) {
      throw new UsageError(`${what}: ${given} is ${mb(st.size)}; attachments are limited to ${mb(LIMITS.maxAttachmentBytes)}`);
    }
    const buf = await fh.readFile();
    if (buf.length > LIMITS.maxAttachmentBytes) {
      throw new UsageError(`${what}: ${given} is larger than ${mb(LIMITS.maxAttachmentBytes)}`);
    }
    return buf;
  } finally {
    await fh.close().catch(() => {});
  }
}

/** @param {number} n */
function mb(n) {
  return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
}

const SIGNATURES = /** @type {Record<string, (b: Buffer) => boolean>} */ ({
  png: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')),
  webp: (b) => b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
});

/**
 * Why the bytes do not match the extension ('is not a PNG image'), or null.
 * @param {string} ext lowercase, as given
 * @param {Buffer} buf
 * @returns {string | null}
 */
function contentProblem(ext, buf) {
  const e = STORED_EXT[ext] ?? ext;
  const sig = SIGNATURES[e];
  if (sig) return sig(buf) ? null : `is not a ${e === 'jpg' ? 'JPEG' : e.toUpperCase()} image`;
  if (e === 'svg') return /<svg[\s>]/i.test(buf.toString('utf8')) ? null : 'is not an SVG image (no <svg> element)';
  // HTML: text, not a binary file renamed
  return buf.subarray(0, 8192).includes(0) ? 'is not a text (HTML) file' : null;
}

/**
 * The original file name for display: the basename, control characters dropped, at most MAX_NAME characters (the
 * extension kept).
 * @param {string} abs
 * @returns {string}
 */
function displayName(abs) {
  const base = path.basename(abs).replace(/[\u0000-\u001f\u007f]/g, '');
  if (base.length <= MAX_NAME) return base;
  const ext = path.extname(base);
  return `${base.slice(0, MAX_NAME - ext.length - 1)}…${ext}`;
}

/**
 * Copies loaded attachments into the doc's store (attachments/aN.<ext>); the ids are allocated on `doc` (the caller
 * saves doc.json, or commits it with a journal, after this).
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {LoadedAttachment[] | null | undefined} loaded
 * @returns {Promise<CommentAttachment[]>}
 */
export async function storeAttachments(ctx, doc, loaded) {
  /** @type {CommentAttachment[]} */
  const out = [];
  for (const a of loaded ?? []) {
    const rel = await ctx.store.saveAttachment(doc.id, `${ctx.store.nextId(doc, 'attachment')}.${a.ext}`, a.buf);
    out.push({ path: rel, name: a.name, kind: a.kind });
  }
  return out;
}

/**
 * loadAttachments for every reply of a revise (ReviseInput.threads): replaces each reply's `attachments` (paths)
 * by `files` (LoadedAttachment[], not stored yet). Mutates `replies`.
 * @param {Ctx} ctx
 * @param {Record<string, { attachments?: unknown, files?: LoadedAttachment[] }>} replies
 */
export async function loadReplyAttachments(ctx, replies) {
  for (const [tid, r] of Object.entries(replies ?? {})) {
    if (r.attachments === undefined) continue;
    const files = await loadAttachments(ctx, r.attachments, { what: `threads.${tid}.attachments` });
    delete r.attachments;
    if (files.length) r.files = files;
  }
}

/**
 * Stores the loaded files of every reply (see loadReplyAttachments) and sets the reply's `attachments` to their
 * CommentAttachment records, which addAgentReply puts on the reply's comment. Mutates `replies` and doc counters.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {Record<string, { files?: LoadedAttachment[], attachments?: unknown }>} replies
 * @returns {Promise<number>} files stored
 */
export async function storeReplyAttachments(ctx, doc, replies) {
  let n = 0;
  for (const r of Object.values(replies ?? {})) {
    if (!r.files?.length) continue;
    r.attachments = await storeAttachments(ctx, doc, r.files);
    n += r.files.length;
    delete r.files;
  }
  return n;
}

/**
 * Every attachment of a thread a reviewer reply may `use`, by doc-relative path: the agent's reply attachments
 * (with their original names) and the reviewer's own (thread.attachments, named by their stored file name).
 * @param {Thread} thread
 * @returns {Map<string, { path: string, name: string, kind: string }>}
 */
export function useTargets(thread) {
  /** @type {Map<string, { path: string, name: string, kind: string }>} */
  const out = new Map();
  for (const rel of thread?.attachments ?? []) {
    if (typeof rel === 'string') out.set(rel, { path: rel, name: path.posix.basename(rel), kind: 'image' });
  }
  for (const c of thread?.comments ?? []) {
    for (const a of /** @type {any} */ (c).attachments ?? []) {
      if (a && typeof a.path === 'string') out.set(a.path, { path: a.path, name: String(a.name ?? path.posix.basename(a.path)), kind: String(a.kind ?? 'image') });
    }
  }
  return out;
}

/**
 * Normalises and checks the `use` list of a reviewer reply on `thread`: 'attachments/a7.html' or 'a7.html', each an
 * attachment of that thread (useTargets), no duplicates, at most LIMITS.maxUseAttachments. Returns the doc-relative
 * paths ([] when `use` is absent or empty); UsageError otherwise.
 * @param {Thread} thread
 * @param {unknown} use
 * @returns {string[]}
 */
export function normalizeUse(thread, use) {
  if (use == null) return [];
  if (!Array.isArray(use) || !use.every((u) => typeof u === 'string' && u.trim())) {
    throw new UsageError(`use: expected a list of attachment paths of ${thread.id} (e.g. "attachments/a7.html")`);
  }
  const list = [...new Set(use.map((u) => (u.trim().startsWith('attachments/') ? u.trim() : `attachments/${u.trim()}`)))];
  if (list.length > LIMITS.maxUseAttachments) throw new UsageError(`use: at most ${LIMITS.maxUseAttachments} attachments per reply`);
  const known = useTargets(thread);
  for (const u of list) {
    if (!known.has(u)) throw new UsageError(`use: ${u} is not an attachment of ${thread.id}`, { details: { thread: thread.id, use: u } });
  }
  return list;
}
