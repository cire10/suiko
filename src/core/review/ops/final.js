// @ts-check
// `specreview final <doc> [--decisions] [--out <dir>]` (design 3.12, 8.9):
//   finalize(ctx, doc, { decisions, outDir }) -> { doc, final, versions, reviews, resolved, decisions,
//                                                  workingMatches, decisionsPath, decisionsAbs }
// Requires a final version (an approved review with "Mark final") and a working copy identical to it
// (RefusedError, exit 3, otherwise). With `decisions`, writes `<name>.decisions.md` next to the spec (or into
// outDir, resolved against ctx.cwd). An agent op: acknowledges delivered reviews.

import path from 'node:path';
import { RefusedError } from '../../store/errors.js';
import { writeFileAtomic } from '../../store/atomic.js';
import { toPosix } from '../../util/paths.js';
import { renderDecisionsMarkdown } from '../export.js';
import { withDoc } from './common.js';
import { isSnapshot } from '../../store/snapshot.js';

/**
 * @typedef {import('../context.js').Ctx} Ctx
 * @typedef {import('../../../shared/types.js').Doc} Doc
 */

/**
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ decisions?: boolean, outDir?: string | null }} [opts]
 */
export async function finalize(ctx, ref, { decisions = false, outDir = null } = {}) {
  return withDoc(
    ctx,
    ref,
    async (doc) => {
      if (!doc.final) {
        throw new RefusedError(`${doc.id} has no final version yet (the reviewer approves with "Mark v${doc.head} final")`, { details: { doc: doc.id } });
      }
      const final = doc.final;
      const { manifest } = await ctx.store.readVersion(doc.id, final.version);
      const working = await ctx.store.readWorking(doc);
      if (working.sha256 !== manifest.sha256) {
        throw new RefusedError(`the working copy of ${doc.path} differs from the final v${final.version}; record or revert the changes first`, {
          details: { doc: doc.id, final: final.version },
        });
      }
      const [threads, reviews, versions] = await Promise.all([ctx.store.listThreads(doc.id), ctx.store.listReviews(doc.id), ctx.store.listVersions(doc.id)]);
      const resolved = threads.filter((t) => t.status === 'resolved');
      const decisionCount = resolved.filter((t) => t.decision?.text).length;
      let decisionsPath = null;
      let decisionsAbs = null;
      if (decisions) {
        const base = path.posix.basename(doc.path).replace(/\.[^.]+$/, '');
        // A snapshot doc has no file to sit next to: its decisions go to the cwd.
        const dir = outDir ? path.resolve(ctx.cwd, outDir) : isSnapshot(doc) ? ctx.cwd : path.dirname(ctx.store.workingPath(doc));
        decisionsAbs = path.join(dir, `${base}.decisions.md`);
        await writeFileAtomic(decisionsAbs, renderDecisionsMarkdown({ doc, threads, reviews, versions: versions.length }));
        const rel = path.relative(ctx.root, decisionsAbs);
        decisionsPath = rel.startsWith('..') || path.isAbsolute(rel) ? decisionsAbs : toPosix(rel);
      }
      return {
        doc: doc.id,
        final,
        versions: versions.length,
        reviews: reviews.length,
        resolved: resolved.length,
        decisions: decisionCount,
        workingMatches: true,
        decisionsPath,
        decisionsAbs,
      };
    },
    { ack: true },
  );
}
