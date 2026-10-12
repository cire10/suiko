// @ts-check
// Doc-level operations (design 3.2, 9.2, 9.6, 10.2):
//   openDoc(ctx, { path, title })              -> { doc, version, created, workingDirty, lines, externals }
//   docState(ctx, doc)                          -> DocState (without contentBase; the daemon adds it)
//   listDocsAcrossWorkspaces(ctx?)              -> [{ ws, root, id, path, title, format, head, state, openThreads,
//                                                    undelivered, listening, final }]
//   docsByActivity(ctx?, { roots? })            -> [{ ws, root, id, path, title, state, head, activeAt }], most
//                                                  recently active first (`specreview snip` without a doc)
//   status(ctx, doc?)                           -> { docs: [...] } (`specreview status`)
//   log(ctx, doc)                               -> { doc, entries, final } (versions and reviews, newest first)
//   sourceLines(ctx, doc, { version, from, to }) -> { v, startLine, lines, total } (version number or 'live')
//   closeSession(ctx, doc)                      -> { ok, doc, state } (waiters exit 5)
//   saveAttachment(ctx, doc, { dataUrl })       -> { path: 'attachments/aN.png', abs }

import fsp from 'node:fs/promises';
import path from 'node:path';
import { LIMITS, SSE } from '../../../shared/protocol.js';
import { NotFoundError, RefusedError, UsageError } from '../../store/errors.js';
import { ALL_DOCS, Store, compareIds } from '../../store/store.js';
import { listWorkspaces } from '../../store/home.js';
import { readLastJsonLine } from '../../store/jsonl.js';
import { renderSource } from '../../render/index.js';
import { lineIndex } from '../../text/index.js';
import { autoCommit } from '../git.js';
import { docKind, docOriginType, docRefFor, isCode, isSnapshot, originType, planFileOf } from '../../store/snapshot.js';
import { deletePrRef } from '../../code/pr.js';
import { kindOf } from '../kinds.js';
import { pathFromCwd } from '../packet-data.js';
import { anchorAt, isActionable, isOutdated } from '../threadstate.js';
import {
  agentActor, emit, parseVersionArg, readHead, readWorkingState, resolveDoc, undeliveredReviews, withDoc,
} from './common.js';

/**
 * @typedef {import('../context.js').Ctx} Ctx
 * @typedef {import('../../../shared/types.js').Doc} Doc
 * @typedef {import('../../../shared/types.js').VersionManifest} VersionManifest
 */

/**
 * Tracks a spec and records v1 when it is new. Re-opening a tracked doc reports its state (and reopens a closed
 * session); a tracked doc without any version (an interrupted open) gets its v1 now.
 * @param {Ctx} ctx
 * @param {{ path: string, title?: string | null }} input
 */
export async function openDoc(ctx, { path: file, title }) {
  if (!file) throw new UsageError('open: a file path is required');
  const abs = path.resolve(ctx.cwd, file);
  try {
    if (!(await fsp.stat(abs)).isFile()) throw new UsageError(`not a file: ${file}`);
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new NotFoundError(`no such file: ${file}`, { details: { path: file } });
  }
  let doc = await ctx.store.findDoc(abs);
  let created = false;
  if (!doc) {
    doc = await ctx.store.createDoc({ path: abs, title: title ?? undefined, createdBy: agentActor(ctx) });
    created = true;
  }
  return withDoc(ctx, doc.id, async (d) => {
    if (d.head === 0) {
      const w = await ctx.store.readWorking(d);
      const render = await renderSource({ format: d.format, source: w.text, docPath: d.path });
      if (!title && render.title) d.title = render.title;
      /** @type {Record<string, string | null>} */
      const assetFiles = {};
      for (const rel of render.assets) assetFiles[rel] = null;
      const lines = lineIndex(w.text).count;
      const manifest = await ctx.store.commitVersion(d, {
        source: w.buf,
        manifest: {
          author: agentActor(ctx),
          summary: 'initial draft',
          respondsTo: null,
          capturedBy: 'open',
          stats: { added: lines, removed: 0, hunks: 0, rewriteRatio: 0 },
          hunks: [],
          guards: { errors: [], warnings: [], forced: false, brokenLocks: [] },
          git: { commit: null },
        },
        assetFiles,
      });
      await emit(ctx, d.id, SSE.DOC_OPENED, { path: d.path });
      await emit(ctx, d.id, SSE.VERSION_CREATED, { v: manifest.v, author: `agent:${ctx.agent}`, summary: manifest.summary });
      const git = await autoCommit({ root: ctx.root, config: ctx.config, docId: d.id, docPath: d.path, version: manifest.v, summary: manifest.summary });
      return { doc: d, version: manifest, created: true, workingDirty: false, lines: manifest.lines, externals: render.externals, assets: render.assets, git };
    }
    if (d.state === 'closed') {
      d.state = d.final && d.final.version === d.head ? 'approved' : 'in_review';
      await ctx.store.saveDoc(d);
      await emit(ctx, d.id, SSE.DOC_OPENED, { path: d.path, reopened: true });
    }
    const head = await readHead(ctx, d);
    const w = await readWorkingState(ctx, d, head);
    return { doc: d, version: head.manifest, created, workingDirty: w.dirty, lines: head.manifest.lines, externals: [], assets: Object.keys(head.manifest.assets ?? {}), git: null };
  });
}

/**
 * The UI's view of a doc (design 10.2 DocState, without contentBase).
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 */
export async function docState(ctx, ref) {
  const doc = await ctx.store.requireDoc(typeof ref === 'string' ? ref : ref.id);
  const [versions, threads, locks, reviews, drafts, waitersDoc, waitersAll] = await Promise.all([
    ctx.store.listVersions(doc.id),
    ctx.store.listThreads(doc.id),
    ctx.store.listLocks(doc.id),
    ctx.store.listReviews(doc.id),
    ctx.store.getDrafts(doc.id),
    ctx.store.listWaiters(doc.id),
    ctx.store.listWaiters(ALL_DOCS),
  ]);
  const head = doc.head ? versions.find((m) => m.v === doc.head) ?? null : null;
  /** @type {{ dirty: boolean, sha256: string | null, missing: boolean, changedFiles?: string[] }} */
  let working = { dirty: false, sha256: /** @type {string | null} */ (null), missing: false };
  if (isCode(doc)) {
    // a code doc's working state is its repo files (the code engine), never the store's virtual working copy
    const w = /** @type {any} */ (await kindOf(doc).workingState(ctx, doc, doc.head ? await readHead(ctx, doc) : null));
    working = { dirty: Boolean(w.dirty), sha256: w.sha256 ?? null, missing: Boolean(w.missing), changedFiles: w.changedFiles ?? [] };
  } else try {
    const w = await ctx.store.readWorking(doc);
    working = { dirty: head ? w.sha256 !== head.sha256 : true, sha256: w.sha256, missing: false };
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    working = { dirty: true, sha256: null, missing: true };
  }
  return {
    ws: ctx.wsId,
    doc,
    versions: versions.map((m) => ({
      v: m.v,
      author: m.author,
      summary: m.summary ?? '',
      createdAt: m.createdAt,
      stats: m.stats ?? null,
      guards: m.guards ?? null,
      respondsTo: m.respondsTo ?? null,
      capturedBy: m.capturedBy,
      hunks: m.hunks ?? [],
      assets: m.assets ?? {},
    })),
    threads,
    locks,
    reviews,
    drafts,
    waiters: [...waitersDoc, ...waitersAll].map((w) => ({ agent: w.agent, since: w.since, pid: w.pid, all: w.doc === ALL_DOCS })),
    working,
    reviewer: { name: ctx.reviewer },
    decisions: threads
      .filter((t) => t.decision?.text && t.status === 'resolved')
      .map((t) => ({ ...(/** @type {any} */ (t.decision)), thread: t.id }))
      .sort((a, b) => compareIds(a.id, b.id)),
  };
}

/**
 * Docs of every registered workspace (GET /api/docs). Workspaces that cannot be opened are skipped.
 * @param {Ctx} [_ctx]
 */
export async function listDocsAcrossWorkspaces(_ctx) {
  const out = [];
  for (const ws of await listWorkspaces()) {
    if (!ws.exists) continue;
    let store;
    try {
      store = await Store.open(ws.root);
    } catch {
      continue;
    }
    const all = await store.listWaiters(ALL_DOCS);
    for (const doc of await store.listDocs()) {
      const [threads, reviews, waiters] = await Promise.all([store.listThreads(doc.id), store.listReviews(doc.id), store.listWaiters(doc.id)]);
      out.push({
        ws: ws.wsId,
        root: ws.root,
        id: doc.id,
        path: doc.path,
        kind: docKind(doc),
        origin: docOriginType(doc),
        title: doc.title,
        format: doc.format,
        head: doc.head,
        state: doc.state,
        openThreads: threads.filter((t) => t.status !== 'resolved').length,
        undelivered: reviews.filter((r) => !Object.keys(r.deliveredTo ?? {}).length).length,
        listening: waiters.length > 0 || all.length > 0,
        final: doc.final ?? null,
      });
    }
  }
  return out;
}

/**
 * Docs of the registered workspaces (or of `roots` only), most recently active first. A doc's activity is the time
 * of the latest event in its runtime feed (any review, draft, version, reply or open), else the time of its head
 * version, else its creation; ties go by workspace root, then doc id. Workspaces that cannot be opened are skipped.
 * @param {Ctx | null} [_ctx]
 * @param {{ roots?: string[] | null }} [opts]
 * @returns {Promise<Array<{ ws: string, root: string, id: string, path: string, title: string, state: string,
 *   head: number, activeAt: string }>>}
 */
export async function docsByActivity(_ctx = null, { roots = null } = {}) {
  const candidates = roots ? roots.map((root) => ({ root })) : (await listWorkspaces()).filter((w) => w.exists);
  /** @type {Set<string>} */
  const seen = new Set();
  const out = [];
  for (const { root } of candidates) {
    let store;
    try {
      store = await Store.open(root);
    } catch {
      continue;
    }
    if (seen.has(store.wsId)) continue;
    seen.add(store.wsId);
    for (const doc of await store.listDocs()) {
      out.push({
        ws: store.wsId,
        root: store.root,
        id: doc.id,
        path: doc.path,
        title: doc.title,
        state: doc.state,
        head: doc.head,
        activeAt: await lastActivity(store, doc),
      });
    }
  }
  return out.sort((a, b) => (a.activeAt > b.activeAt ? -1 : a.activeAt < b.activeAt ? 1 : a.root < b.root ? -1 : a.root > b.root ? 1 : compareIds(a.id, b.id)));
}

/**
 * ISO time of a doc's latest activity (see docsByActivity).
 * @param {Store} store
 * @param {Doc} doc
 * @returns {Promise<string>}
 */
async function lastActivity(store, doc) {
  try {
    const last = await readLastJsonLine(store.eventsFile(doc.id));
    if (typeof last?.at === 'string' && last.at) return last.at;
  } catch {
    // an unreadable feed: fall back to the versions
  }
  if (doc.head) {
    try {
      const { manifest } = await store.readVersion(doc.id, doc.head);
      if (manifest.createdAt) return manifest.createdAt;
    } catch {
      // a version without a manifest: fall back to the doc itself
    }
  }
  return doc.createdAt ?? '';
}

/**
 * `specreview status [<doc>]`.
 * @param {Ctx} ctx
 * @param {string | Doc | null} [ref]
 */
export async function status(ctx, ref = null) {
  const docs = ref ? [await resolveDoc(ctx, ref)] : await ctx.store.listDocs();
  const all = await ctx.store.listWaiters(ALL_DOCS);
  const out = [];
  for (const doc of docs) {
    const [threads, locks, reviews, drafts, waiters, versions] = await Promise.all([
      ctx.store.listThreads(doc.id),
      ctx.store.listLocks(doc.id),
      ctx.store.listReviews(doc.id),
      ctx.store.getDrafts(doc.id),
      ctx.store.listWaiters(doc.id),
      ctx.store.listVersions(doc.id),
    ]);
    const headM = versions.find((m) => m.v === doc.head) ?? null;
    /** @type {Record<string, number>} */
    const counts = { open: 0, addressed: 0, answered: 0, declined: 0, needs_input: 0, resolved: 0, outdated: 0, actionable: 0 };
    for (const t of threads) {
      counts[t.status] = (counts[t.status] ?? 0) + 1;
      if (t.status !== 'resolved' && isOutdated(anchorAt(t, doc.head))) counts.outdated += 1;
      if (isActionable(t)) counts.actionable += 1;
    }
    const sortedReviews = [...reviews].sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : 1));
    const last = sortedReviews[sortedReviews.length - 1] ?? null;
    let working = 'clean';
    if (headM && isCode(doc)) {
      // the code engine reads the repo; one unreadable repo must not cost the listing its other docs
      try {
        working = (await kindOf(doc).workingState(ctx, doc, await readHead(ctx, doc))).dirty ? 'dirty' : 'clean';
      } catch {
        working = 'unknown';
      }
    } else if (headM) {
      try {
        const w = await ctx.store.readWorking(doc);
        working = w.sha256 === headM.sha256 ? 'clean' : 'dirty';
      } catch {
        working = 'missing';
      }
    }
    const snapshot = isSnapshot(doc);
    const code = isCode(doc);
    out.push({
      doc: doc.id,
      path: doc.path,
      // a snapshot doc has no working file (its path is synthetic): say what it is instead
      ...(snapshot ? { kind: 'snapshot', origin: originType(doc), ref: docRefFor(doc.id, ctx.root) } : {}),
      // a code doc reviews repo files: there is no single file to name
      ...(code ? { kind: 'code', origin: docOriginType(doc), ref: docRefFor(doc.id, ctx.root) } : {}),
      // (a plan snapshot names its plan file; other snapshots have no file to reach)
      file: code ? null : snapshot ? planFileOf(doc) : path.join(ctx.root, ...doc.path.split('/')),
      pathFromCwd: code ? null : snapshot ? planFileOf(doc) : pathFromCwd(doc.path, ctx.root, ctx.cwd),
      title: doc.title,
      head: doc.head,
      headAuthor: headM?.author?.name ?? null,
      headAt: headM?.createdAt ?? null,
      state: doc.state,
      final: doc.final ?? null,
      counts,
      locks: locks.filter((l) => l.active).map((l) => l.id),
      lastReview: last ? { id: last.id, version: last.version, verdict: last.verdict } : null,
      drafts: drafts.items.length,
      undelivered: undeliveredReviews(reviews, ctx.agent).map((r) => r.id),
      listening: [...waiters, ...all].map((w) => ({ agent: w.agent, pid: w.pid })),
      working,
    });
  }
  return { agent: ctx.agent, docs: out };
}

/**
 * `specreview log <doc>`: versions and reviews interleaved, newest first.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 */
export async function log(ctx, ref) {
  const doc = await resolveDoc(ctx, ref);
  const [versions, reviews, threads] = await Promise.all([ctx.store.listVersions(doc.id), ctx.store.listReviews(doc.id), ctx.store.listThreads(doc.id)]);
  /** @type {any[]} */
  const entries = [];
  for (const m of versions) {
    const hunks = m.hunks ?? [];
    entries.push({
      kind: 'version',
      v: m.v,
      at: m.createdAt,
      author: m.author ?? { kind: 'agent', name: '?' },
      summary: m.summary ?? '',
      stats: m.v === 1 && m.capturedBy === 'open' ? null : m.stats ?? null,
      lines: m.lines,
      threads: [...new Set(hunks.flatMap((h) => h.threads ?? []))].sort(compareIds),
      other: hunks.filter((h) => h.other != null && !(h.threads ?? []).length).length,
      respondsTo: m.respondsTo ?? null,
      capturedBy: m.capturedBy,
      forced: Boolean(m.guards?.forced),
      brokenLocks: m.guards?.brokenLocks ?? [],
    });
  }
  for (const r of reviews) {
    const decisions = threads
      .filter((t) => t.decision?.text && r.resolved?.includes(t.id))
      .map((t) => /** @type {any} */ (t.decision).id)
      .sort(compareIds);
    entries.push({
      kind: 'review',
      id: r.id,
      at: r.submittedAt,
      by: r.by?.name ?? '',
      version: r.version,
      verdict: r.verdict,
      threads: new Set([...(r.newThreads ?? []), ...(r.replies ?? []).map((x) => x.thread)]).size,
      newThreads: r.newThreads ?? [],
      resolved: r.resolved ?? [],
      decisions,
      locksAdded: r.locksAdded ?? [],
      markFinal: Boolean(r.markFinal),
      deliveredTo: r.deliveredTo ?? {},
    });
  }
  entries.sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : a.kind === b.kind ? 0 : a.kind === 'version' ? -1 : 1));
  return { doc: doc.id, entries, final: doc.final ?? null };
}

/**
 * Source lines of a version or of the working copy (1-based, inclusive, clamped).
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ version?: number | string, from?: number, to?: number }} [opts]
 */
export async function sourceLines(ctx, ref, { version, from, to } = {}) {
  const doc = await resolveDoc(ctx, ref);
  const v = parseVersionArg(version, { allowLive: true, fallback: doc.head });
  const text = v === 'live' ? (await ctx.store.readWorking(doc)).text : (await ctx.store.readVersion(doc.id, v)).source;
  const li = lineIndex(text);
  const total = text === '' ? 0 : li.count;
  const a = Math.max(1, Math.floor(Number(from) || 1));
  const b = Math.min(total, Math.floor(Number(to) || total));
  const lines = [];
  for (let l = a; l <= b; l++) lines.push(li.lineText(l));
  return { v, startLine: a, lines, total };
}

/**
 * Ends the review session: doc state 'closed' and a session.closed event (waiters exit 5). A PR review also loses
 * its local ref (refs/specreview/pr/<n>); `review --pr` fetches it again.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 */
export async function closeSession(ctx, ref) {
  return withDoc(ctx, ref, async (doc) => {
    if (doc.state !== 'closed') {
      doc.state = 'closed';
      await ctx.store.saveDoc(doc);
    }
    const spec = /** @type {any} */ (doc).code;
    if (isCode(doc) && spec?.mode === 'pr') await deletePrRef(ctx.root, Number(spec.pr?.number));
    await emit(ctx, doc.id, SSE.SESSION_CLOSED, {});
    return { ok: true, doc: doc.id, state: doc.state };
  });
}

const DATA_URL_RE = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=\s]+)$/;

/**
 * Stores a region crop or pasted image (PNG or JPEG, <= LIMITS.maxAttachmentBytes) as attachments/aN.<ext>.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ dataUrl: string }} input
 * @returns {Promise<{ path: string, abs: string }>}
 */
export async function saveAttachment(ctx, ref, { dataUrl }) {
  const m = DATA_URL_RE.exec(String(dataUrl ?? ''));
  if (!m) throw new UsageError('attachment must be a PNG or JPEG data URL');
  const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (!buf.length) throw new UsageError('attachment is empty');
  if (buf.length > LIMITS.maxAttachmentBytes) throw new RefusedError(`attachment is larger than ${LIMITS.maxAttachmentBytes} bytes`);
  const png = buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (m[1] === 'image/png' ? !png : !jpeg) throw new UsageError(`attachment bytes are not a valid ${m[1]}`);
  return withDoc(ctx, ref, async (doc) => {
    const name = `${ctx.store.nextId(doc, 'attachment')}.${png ? 'png' : 'jpg'}`;
    await ctx.store.saveDoc(doc);
    const rel = await ctx.store.saveAttachment(doc.id, name, buf);
    return { path: rel, abs: ctx.store.attachmentPath(doc.id, rel) };
  });
}
