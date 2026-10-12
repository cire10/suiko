// @ts-check
// Opening a code review (`suiko review`, MCP suiko_review; design 4.2): resolves the spec, takes round 1
// and creates the code doc, or reopens the existing doc of the same spec (identity: its origin key) and records a
// new round when the snapshot changed.
//
//   openCodeReview(ctx, { input, title }) -> { doc, created, version, recorded, code }
//     not a git repository / git too old / a git failure    UsageError (exit 1)
//     too many files / unmerged entries (--staged) / ...     RefusedError (exit 3)
//     base, range end or commit not found; nothing to review NotFoundError (exit 4)

import { SSE } from '../../shared/protocol.js';
import { NotFoundError } from '../store/errors.js';
import { agentActor, emit, readHead, withDoc } from '../review/ops/common.js';
import { openRepo } from './git.js';
import { docIdFor, resolveSpec, short, specKey, specLabel } from './spec.js';
import { codeStats, skippedText } from './diff-text.js';
import { takeCodeSnapshot } from './snapshot.js';
import { recordCodeRound } from './round.js';
import { codeOf, maxFilesOf } from './util.js';

/**
 * @typedef {import('../review/context.js').Ctx} Ctx
 * @typedef {import('../../shared/types.js').Doc} Doc
 * @typedef {import('../../shared/types.js').CodeSpec} CodeSpec
 * @typedef {import('../../shared/types.js').CodeManifest} CodeManifest
 * @typedef {import('../../shared/types.js').VersionManifest} VersionManifest
 */

/**
 * ReviewInput = { mode?, base?, range?, commit?, paths?, context?, maxFiles? } (cli/commands/review.js reviewInput).
 * Creates the code doc for the spec, or reopens the existing one and records a new round when the snapshot changed.
 * @param {Ctx} ctx
 * @param {{ input: Record<string, unknown>, title?: string }} p
 * @returns {Promise<{ doc: Doc, created: boolean, version: VersionManifest, recorded: boolean, code: CodeManifest }>}
 */
export async function openCodeReview(ctx, { input, title }) {
  const repo = await openRepo(ctx.root);
  const spec = await resolveSpec(repo, /** @type {any} */ (input ?? {}), ctx.config);
  const maxFiles = input?.maxFiles != null ? maxFilesOf(Number(input.maxFiles), ctx.config) : null;
  if (maxFiles) /** @type {any} */ (spec).maxFiles = maxFiles;
  const key = specKey(spec);

  const existing = await ctx.store.findDocByOrigin(key);
  if (existing) return rerun(ctx, existing, maxFiles, spec);

  // round 1 is taken before the doc exists (dry: the blobs are stored once the doc is there), so "nothing to
  // review" leaves nothing behind
  const snap = await takeCodeSnapshot(ctx, spec, { dry: true, maxFiles });
  if (!snap.code.files.length) {
    const skipped = snap.code.skipped.length ? ` (only skipped files: ${skippedText(snap.code.skipped)})` : '';
    throw new NotFoundError(`nothing to review: no changes in ${specLabel(spec, snap.code)}${skipped}`, { details: { mode: spec.mode } });
  }
  const branch = await repo.branch();
  const { doc, created } = await ctx.store.createSnapshotDoc({
    kind: 'code',
    format: 'text',
    title: title?.trim() || (await defaultTitle(repo, spec, branch)),
    origin: { type: 'diff', key },
    slug: docIdFor(spec, branch),
    createdBy: agentActor(ctx),
    code: spec,
  });
  if (!created) return rerun(ctx, doc, maxFiles, spec);
  return withDoc(ctx, doc.id, async (d) => {
    if (d.head !== 0) return rerun(ctx, d, maxFiles, spec);
    const used = new Set(snap.code.files.flatMap((f) => [f.old, f.new]).filter(Boolean));
    for (const [ref, buf] of snap.bufs) if (used.has(ref)) await ctx.store.putDocBlob(d.id, buf);
    const st = codeStats(snap.code.files);
    const manifest = await ctx.store.commitVersion(d, {
      source: snap.buf,
      manifest: {
        author: agentActor(ctx),
        summary: 'round 1',
        respondsTo: null,
        capturedBy: 'open',
        code: snap.code,
        stats: { added: st.added, removed: st.removed, hunks: 0, rewriteRatio: 0 },
        hunks: [],
        guards: { errors: [], warnings: [], forced: false, brokenLocks: [] },
        git: { commit: null },
      },
      assetFiles: {},
    });
    await emit(ctx, d.id, SSE.DOC_OPENED, { path: d.path, kind: 'code' });
    await emit(ctx, d.id, SSE.VERSION_CREATED, { v: manifest.v, author: `agent:${ctx.agent}`, summary: manifest.summary });
    return { doc: d, created: true, version: manifest, recorded: true, code: snap.code };
  });
}

/**
 * A `review` re-run of an existing doc: reopened when closed, --max-files kept, a PR's head and merge-base refreshed
 * (`review --pr` resolved them again), a new round when the snapshot changed.
 * @param {Ctx} ctx
 * @param {Doc} existing
 * @param {number | null} maxFiles
 * @param {CodeSpec} spec the spec resolved now
 */
async function rerun(ctx, existing, maxFiles, spec) {
  return withDoc(ctx, existing.id, async (d) => {
    let dirtyDoc = false;
    if (d.state === 'closed') {
      d.state = d.final && d.final.version === d.head ? 'approved' : 'in_review';
      dirtyDoc = true;
      await emit(ctx, d.id, SSE.DOC_OPENED, { path: d.path, reopened: true, kind: 'code' });
    }
    if (maxFiles && /** @type {any} */ (d.code)?.maxFiles !== maxFiles) {
      d.code = /** @type {any} */ ({ ...d.code, maxFiles });
      dirtyDoc = true;
    }
    if (spec.mode === 'pr' && spec.pr && JSON.stringify(/** @type {any} */ (d.code)?.pr) !== JSON.stringify(spec.pr)) {
      d.code = /** @type {any} */ ({ ...d.code, pr: spec.pr });
      dirtyDoc = true;
    }
    if (dirtyDoc) await ctx.store.saveDoc(d);
    const r = await recordCodeRound(ctx, d, { author: agentActor(ctx), capturedBy: 'round' });
    const fresh = (await ctx.store.getDoc(d.id)) ?? d;
    const head = await readHead(ctx, fresh);
    return { doc: fresh, created: false, version: head.manifest, recorded: !('nothing' in r), code: codeOf(head.manifest) };
  });
}

/**
 * The title of a new review: 'feat/token-refresh vs origin/main', 'Uncommitted changes', 'Commit 1a2b3c4: subject'.
 * @param {import('./git.js').Repo} repo
 * @param {CodeSpec} spec
 * @param {string | null} branch
 * @returns {Promise<string>}
 */
async function defaultTitle(repo, spec, branch) {
  const paths = spec.paths?.length ? ` (${spec.paths.join(', ')})` : '';
  switch (spec.mode) {
    case 'since-base':
      return `${branch ?? 'HEAD'} vs ${spec.base}${paths}`;
    case 'branch':
      return `${branch ?? 'HEAD'} vs ${spec.base} (committed)${paths}`;
    case 'uncommitted':
      return `Uncommitted changes${paths}`;
    case 'staged':
      return `Staged changes${paths}`;
    case 'range':
      return `${spec.from}${spec.threeDot ? '...' : '..'}${spec.to}${paths}`;
    case 'commit': {
      const subject = await repo.maybe(['log', '-1', '--format=%s', '--end-of-options', String(spec.commit)]);
      return `Commit ${short(spec.commit)}${subject ? `: ${subject.trim().slice(0, 80)}` : ''}${paths}`;
    }
    case 'pr':
      return `PR #${spec.pr?.number}${spec.pr?.title ? `: ${spec.pr.title.slice(0, 80)}` : ''}${paths}`;
    default:
      return `Code review${paths}`;
  }
}
