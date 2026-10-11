// @ts-check
// Carrying code anchors across rounds (design 4.7). An anchor lives in FILE space: `anchor.file` names the repo file
// and side, `src` lines are lines of that file side at `anchor.v`. One step vN -> vN+1:
//
//   new side, path P   P in vN+1 (or renamed: an entry with oldPath P)  stepAnchor blob(P@vN,new) -> blob(P'@vN+1,new)
//                                                                      (the round's links for P'#h*), path -> P'
//                      P deleted, or a stub (binary / too large)        orphaned
//                      P dropped from the review                       resolved thread: copied; else orphaned
//   old side           the old blob is unchanged                       copied, exact (path follows a rename)
//                      the base moved                                  stepAnchor old blob -> old blob (by old path);
//                                                                      orphaned when the file left the old side
//   whole file         follows a rename; orphaned when the file is gone
//   whole review       copied
//
// stepCodeAnchor is synchronous (record.js calls Prepared.stepFor synchronously): callers preload the texts it needs
// (stepRefs). codeForwarder (the kind adapter's forwarder: drafts made on older rounds, moveThread) applies the steps
// across several rounds without links. Neither ever re-anchors on the diff text.

import { stepAnchor } from '../review/anchoring.js';
import { anchorSidePath, cleanFile, codeEnv, fileOfAnchor, hasText, orphanAnchor, reader, sidePath } from './util.js';

/**
 * @typedef {import('../review/context.js').Ctx} Ctx
 * @typedef {import('../../shared/types.js').Doc} Doc
 * @typedef {import('../../shared/types.js').Anchor} Anchor
 * @typedef {import('../../shared/types.js').CodeFile} CodeFile
 * @typedef {import('../../shared/types.js').CodeManifest} CodeManifest
 * @typedef {import('../diff/hunks.js').Hunk} Hunk
 * @typedef {{ v: number, code: CodeManifest }} Round
 * @typedef {(ref: string | undefined | null) => string | null} TextOf
 * @typedef {{ path: string, side: 'new' | 'old', oldPath?: string }} AnchorFile
 *
 * @typedef {object} StepPlan
 * @property {'copy' | 'orphan' | 'step' | 'keep'} how keep: whole-review anchor (no file)
 * @property {AnchorFile | null} file the anchor's file at the new round
 * @property {CodeFile | null} from the file at the old round
 * @property {CodeFile | null} to the file at the new round
 * @property {'new' | 'old'} [side]
 */

/**
 * The file of round T a new-side path continues as: the same path (never a 'D' entry), else the rename of it.
 * @param {CodeManifest} code
 * @param {string} p
 * @returns {CodeFile | null}
 */
export function newSideSuccessor(code, p) {
  return code.files.find((f) => f.path === p && f.status !== 'D') ?? code.files.find((f) => f.oldPath === p && f.status === 'R') ?? null;
}

/**
 * How one anchor steps from round F to round T.
 * @param {Anchor} anchor
 * @param {Round} F
 * @param {Round} T
 * @param {{ resolved?: boolean }} [opts] resolved: the item is a resolved thread (kept when its file left the review)
 * @returns {StepPlan}
 */
export function planStep(anchor, F, T, { resolved = false } = {}) {
  const af = /** @type {AnchorFile | undefined} */ (anchor.file);
  if (!af) return { how: 'keep', file: null, from: null, to: null };
  const from = fileOfAnchor(F.code, af);
  if (af.side === 'new') {
    const to = newSideSuccessor(T.code, af.path);
    if (!to) {
      const deleted = T.code.files.some((f) => f.status === 'D' && f.path === af.path);
      return { how: !deleted && resolved ? 'copy' : 'orphan', file: cleanFile(af), from, to: null, side: 'new' };
    }
    const file = { path: to.path, side: /** @type {const} */ ('new') };
    if (anchor.kind === 'doc') return { how: 'copy', file, from, to, side: 'new' };
    if (!hasText(to, 'new')) return { how: 'orphan', file, from, to, side: 'new' };
    if (anchor.state !== 'orphaned' && from?.new && from.new === to.new) return { how: 'copy', file, from, to, side: 'new' };
    return { how: 'step', file, from, to, side: 'new' };
  }
  const p = anchorSidePath(af);
  const to = T.code.files.find((f) => f.status !== 'A' && sidePath(f, 'old') === p) ?? null;
  if (!to) return { how: resolved ? 'copy' : 'orphan', file: cleanFile(af), from, to: null, side: 'old' };
  const file = cleanFile({ path: to.path, side: 'old', ...(to.oldPath ? { oldPath: to.oldPath } : {}) });
  if (anchor.kind === 'doc') return { how: 'copy', file, from, to, side: 'old' };
  if (!hasText(to, 'old')) return { how: 'orphan', file, from, to, side: 'old' };
  if (anchor.state !== 'orphaned' && from?.old && from.old === to.old) return { how: 'copy', file, from, to, side: 'old' };
  return { how: 'step', file, from, to, side: 'old' };
}

/**
 * The blob refs stepCodeAnchor reads for this anchor (preload them).
 * @param {Anchor} anchor
 * @param {Round} F
 * @param {Round} T
 * @param {{ resolved?: boolean }} [opts]
 * @returns {string[]}
 */
export function stepRefs(anchor, F, T, opts) {
  const plan = planStep(anchor, F, T, opts);
  if (plan.how !== 'step') return [];
  const key = plan.side === 'old' ? 'old' : 'new';
  return /** @type {string[]} */ ([plan.from?.[key], plan.to?.[key]].filter((x) => typeof x === 'string'));
}

/**
 * Steps one anchor from round F to round T (see the header).
 * @param {Anchor} anchor the anchor at F.v
 * @param {object} p
 * @param {Round} p.from
 * @param {Round} p.to
 * @param {TextOf} p.textOf decoded text of a blob ref (preloaded; null when unknown)
 * @param {{ format: 'text', docPath: string, config: any }} p.env
 * @param {Anchor | null} [p.original] the item's first anchor (relocation fallback; used when on the same side)
 * @param {string[]} [p.links] hunk ids of this step linked to the thread ('<path>#h<n>')
 * @param {boolean} [p.linked]
 * @param {boolean} [p.resolved]
 * @param {(from: CodeFile | null, to: CodeFile) => Hunk[] | null} [p.hunksFor] the step's line hunks of a file pair
 *   (ids 'h<n>', those the links name), null: computed here
 * @returns {Anchor}
 */
export function stepCodeAnchor(anchor, { from, to, textOf, env, original = null, links = [], linked = false, resolved = false, hunksFor }) {
  const v = to.v;
  const plan = planStep(anchor, from, to, { resolved });
  if (plan.how === 'keep') return /** @type {Anchor} */ ({ ...anchor, v });
  const file = /** @type {AnchorFile} */ (plan.file);
  if (plan.how === 'orphan') return orphanAnchor(anchor, v, file);
  if (plan.how === 'copy') {
    /** @type {any} */
    const out = { ...anchor, v, section: [file.path], file: cleanFile(file) };
    if (anchor.state === 'orphaned') return orphanAnchor(anchor, v, file);
    if (anchor.kind !== 'doc') out.state = 'exact';
    return out;
  }
  const key = plan.side === 'old' ? 'old' : 'new';
  const toFile = /** @type {CodeFile} */ (plan.to);
  const fromText = plan.from ? textOf(plan.from[key]) : null;
  const toText = textOf(toFile[key]);
  if (toText == null) return orphanAnchor(anchor, v, file);
  const sameSide = original?.file?.side === plan.side ? original : null;
  const prefix = `${toFile.path}#`;
  const linkIds = key === 'new' ? links.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length)) : [];
  const hs = key === 'new' && hunksFor ? hunksFor(plan.from, toFile) : null;
  const next = stepAnchor({
    anchor,
    original: sameSide,
    fromSource: fromText ?? '',
    toSource: toText,
    toVersion: v,
    toRender: null,
    env,
    ...(hs ? { hunks: hs } : {}),
    linkIds,
    linked: key === 'new' && (linked || linkIds.length > 0),
  });
  return /** @type {Anchor} */ ({ ...next, v, section: [file.path], file: cleanFile(file) });
}

/**
 * The kind adapter's forwarder for code docs: maps an anchor of round `anchor.v` to every round up to `toVersion`
 * (keys are version numbers as strings, like forwardAnchor). It keeps `anchor.file` (following renames) and maps
 * the line numbers of that file side; it never re-anchors on the diff text.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @returns {(anchor: Anchor, toVersion: number) => Promise<Record<string, Anchor>>}
 */
export function codeForwarder(ctx, doc) {
  const r = reader(ctx, doc.id);
  const env = codeEnv(doc, ctx.config);
  return async (anchor, toVersion) => {
    /** @type {Record<string, Anchor>} */
    const out = { [String(anchor.v)]: anchor };
    let cur = anchor;
    for (let v = anchor.v + 1; v <= toVersion; v++) {
      const [a, b] = await Promise.all([r.version(v - 1), r.version(v)]);
      const F = { v: v - 1, code: a.code };
      const T = { v, code: b.code };
      /** @type {Map<string, string | null>} */
      const texts = new Map();
      for (const ref of stepRefs(cur, F, T)) texts.set(ref, await r.text(ref));
      cur = stepCodeAnchor(cur, { from: F, to: T, textOf: (ref) => (ref ? texts.get(ref) ?? null : null), env, original: anchor });
      out[String(v)] = cur;
    }
    return out;
  };
}
