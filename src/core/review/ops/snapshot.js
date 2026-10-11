// @ts-check
// Snapshot docs (store/snapshot.js): docs whose versions are recorded from bytes, not from a workspace file.
//   openSnapshot(ctx, { source, format, title, origin, slug })  -> { doc, version, created, lines, externals }
//     creates the doc (or finds it by origin key) and records v1; an existing doc is reported as is (a closed
//     session is reopened), like openDoc.
//   recordSnapshot(ctx, doc, { source, origin, summary, replies, other, breakLocks, dryRun, autoAddress })
//     -> ReviseReport
//     records vN+1 from the bytes: the usual attribution, re-anchoring and replies of `revise`, with the snapshot
//     guard profile (errors are stored as warnings, never refuse) and the origin on the manifest. autoAddress: open
//     threads the new version's hunks are linked to get the reply "Changed in vN." (status addressed), for sources
//     with no reply channel (the plan gate), so a thread already handled is not sent back as still open.
//   takeSnapshot(ctx, input) -> { doc, created, reopened, version, report, externals }
//     openSnapshot, then (when the doc already existed and its origin type re-records: store/snapshot.js
//     ORIGIN_TYPES) recordSnapshot (the plan gate, `last`, `open -`). A message is never re-recorded: re-taking it
//     only reopens the doc, so the agent's revisions are not reverted to the original text.

import { SSE } from '../../../shared/protocol.js';
import { UsageError } from '../../store/errors.js';
import { isSnapshot, normalizeOrigin, originInfo, snapshotPath } from '../../store/snapshot.js';
import { renderSource } from '../../render/index.js';
import { lineIndex } from '../../text/index.js';
import { decodeText } from '../../util/stable-read.js';
import { autoCommit } from '../git.js';
import { agentActor, emit, readHead, withDoc } from './common.js';
import { revise } from './revise.js';

/**
 * @typedef {import('../context.js').Ctx} Ctx
 * @typedef {import('../../../shared/types.js').Doc} Doc
 * @typedef {import('../../../shared/types.js').VersionManifest} VersionManifest
 * @typedef {{ source: string | Buffer, format?: 'markdown' | 'html', title?: string | null,
 *   origin: { type: string, key?: string | null } & Record<string, unknown>, slug?: string | null }} SnapshotInput
 */

/**
 * @param {string | Buffer} source
 * @returns {Buffer}
 */
function toBuffer(source) {
  const buf = Buffer.isBuffer(source) ? source : Buffer.from(String(source ?? ''), 'utf8');
  if (!buf.length || !decodeText(buf).text.trim()) throw new UsageError('nothing to review: the text is empty');
  return buf;
}

/**
 * Creates a snapshot doc (or finds it by origin key) and records v1 from `source`.
 * @param {Ctx} ctx
 * @param {SnapshotInput} input
 */
export async function openSnapshot(ctx, { source, format = 'markdown', title = null, origin, slug = null }) {
  const buf = toBuffer(source);
  const o = normalizeOrigin(origin);
  const text = decodeText(buf).text;
  const render = await renderSource({ format, source: text, docPath: snapshotPath(o.type, 'snapshot', format) });
  const name = title || render.title || null;
  const { doc } = await ctx.store.createSnapshotDoc({ title: name ?? undefined, format, origin: o, slug: slug ?? name ?? o.type, createdBy: agentActor(ctx) });
  return withDoc(ctx, doc.id, async (d) => {
    if (d.head === 0) {
      const lines = lineIndex(text).count;
      const manifest = await ctx.store.commitVersion(d, {
        source: buf,
        manifest: {
          origin: o,
          author: agentActor(ctx),
          summary: 'initial snapshot',
          respondsTo: null,
          capturedBy: 'open',
          stats: { added: lines, removed: 0, hunks: 0, rewriteRatio: 0 },
          hunks: [],
          guards: { errors: [], warnings: [], forced: false, brokenLocks: [] },
          git: { commit: null },
        },
      });
      await emit(ctx, d.id, SSE.DOC_OPENED, { path: d.path, kind: 'snapshot' });
      await emit(ctx, d.id, SSE.VERSION_CREATED, { v: manifest.v, author: `agent:${ctx.agent}`, summary: manifest.summary });
      const git = await autoCommit({ root: ctx.root, config: ctx.config, docId: d.id, docPath: null, version: manifest.v, summary: manifest.summary });
      return { doc: d, version: manifest, created: true, workingDirty: false, lines: manifest.lines, externals: render.externals, assets: [], git };
    }
    if (d.state === 'closed') {
      d.state = d.final && d.final.version === d.head ? 'approved' : 'in_review';
      await ctx.store.saveDoc(d);
      await emit(ctx, d.id, SSE.DOC_OPENED, { path: d.path, reopened: true, kind: 'snapshot' });
    }
    const head = await readHead(ctx, d);
    return { doc: d, version: head.manifest, created: false, workingDirty: false, lines: head.manifest.lines, externals: render.externals, assets: [], git: null };
  });
}

/**
 * Records a new version of a snapshot doc from bytes (see revise: snapshot profile). Identical bytes record nothing
 * (replies, if any, are still added).
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ source: string | Buffer, origin?: Record<string, unknown> | null, summary?: string,
 *   replies?: Record<string, { status: string, reply: string, at?: string }>, other?: Array<{ at: string, why: string }>,
 *   breakLocks?: Record<string, string>, dryRun?: boolean, autoAddress?: boolean }} input
 */
export async function recordSnapshot(ctx, ref, { source, origin = null, summary = '', replies = {}, other = [], breakLocks = {}, dryRun = false, autoAddress = false }) {
  const buf = toBuffer(source);
  const doc = typeof ref === 'string' ? await ctx.store.requireDoc(ref) : ref;
  if (!isSnapshot(doc)) throw new UsageError(`${doc.id} is not a snapshot doc`, { details: { doc: doc.id } });
  return revise(ctx, doc.id, { summary, threads: replies, other, breakLocks, dryRun }, { source: buf, origin: origin ? normalizeOrigin(origin) : null, autoAddress });
}

/**
 * openSnapshot, then recordSnapshot when the doc existed already (same origin key) and its origin type re-records.
 * @param {Ctx} ctx
 * @param {SnapshotInput & { summary?: string, autoAddress?: boolean }} input
 * @returns {Promise<{ doc: Doc, created: boolean, reopened: boolean, version: VersionManifest, report: any, externals: string[] }>}
 */
export async function takeSnapshot(ctx, input) {
  const opened = await openSnapshot(ctx, input);
  const externals = opened.externals ?? [];
  if (opened.created) return { doc: opened.doc, created: true, reopened: false, version: opened.version, report: null, externals };
  if (!originInfo(String(opened.doc.origin?.type ?? '')).rerecord) {
    return { doc: opened.doc, created: false, reopened: true, version: opened.version, report: null, externals };
  }
  const report = await recordSnapshot(ctx, opened.doc.id, { source: input.source, origin: input.origin, summary: input.summary ?? '', autoAddress: Boolean(input.autoAddress) });
  const doc = await ctx.store.requireDoc(opened.doc.id);
  const { manifest } = await ctx.store.readVersion(doc.id, doc.head);
  return { doc, created: false, reopened: false, version: manifest, report, externals };
}
