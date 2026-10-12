// @ts-check
// What changed, for the reviewer UI and `specreview diff` (design 8.5-8.8; BUILD_AMENDMENTS 3.4, 4.5):
//   changes(ctx, doc, { from, to })        -> Changes + { from, to, threadLinks, assets, guards }; to may be 'live'
//   sourceDiffOp(ctx, doc, { from, to })   -> { from, to, hunks } (sourceDiff rows + thread ids per display hunk)
//   unifiedDiff(ctx, doc, { from, to })    -> { from, to, patch }
//   threadMiniDiff(ctx, doc, tid)          -> { kind: 'text', version, from, before, after, words }
//                                           | { kind: 'image', version, from, path, beforeUrl, afterUrl }
//   domTargets(ctx, doc, ver | 'live')     -> { threads, locks, drafts, outline } (DomTarget[] per amendments 3.4;
//                                            drafts written on older versions are carried forward to `ver`)
// Defaults: from = the last reviewed version (else head-1, else head), to = head.
// Hunk links: adjacent versions use the `to` manifest; a longer span unions the manifests in it, mapping each
// recorded hunk forward to `to` lines; 'live' attributes head -> working on the fly (tagged / overlap / asset).
// Asset URLs are relative to DocState.contentBase: `${contentBase}/${url}` (`v2/docs/img/arch.png`).

import { changeSet, lineHunks, offsetMapper, sourceDiff, unifiedPatch, wordDiff } from '../../diff/index.js';
import { lineIndex } from '../../text/index.js';
import { UsageError } from '../../store/errors.js';
import { compareIds } from '../../store/store.js';
import { domTarget, envOf, forwardAnchor, liveAnchor } from '../anchoring.js';
import { attribute, newLineRange } from '../attribution.js';
import { anchorAssetPath, assetLinks, changedAssets, hashWorkingAssets, sridsReferencing } from '../assets.js';
import { anchorAt, idNumber, isActionable, lastIndexes, originalAnchor } from '../threadstate.js';
import { parseVersionArg, readHead, readWorkingState, requireThread, resolveDoc, versionLoader } from './common.js';
import { isCode } from '../../store/snapshot.js';
import { codeChanges, codeFileDiff, codeThreadMiniDiff, codeUnifiedDiff } from '../../code/files.js';

/**
 * @typedef {import('../context.js').Ctx} Ctx
 * @typedef {import('../../../shared/types.js').Doc} Doc
 * @typedef {import('../../../shared/types.js').Thread} Thread
 * @typedef {import('../../../shared/types.js').Anchor} Anchor
 * @typedef {import('../../../shared/types.js').DomTarget} DomTarget
 * @typedef {import('../../../shared/types.js').VersionManifest} VersionManifest
 * @typedef {import('../../render/index.js').RenderResult} RenderResult
 */

/**
 * Resolves `from` / `to` and loads both sides.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {{ from?: unknown, to?: unknown }} range
 */
async function loadPair(ctx, doc, { from, to }) {
  if (!doc.head) throw new UsageError(`${doc.id} has no recorded version`);
  const defFrom = doc.lastReviewedVersion && doc.lastReviewedVersion < doc.head ? doc.lastReviewedVersion : Math.max(1, doc.head - 1);
  const f = /** @type {number} */ (parseVersionArg(from, { fallback: defFrom }));
  const t = parseVersionArg(to, { allowLive: true, fallback: doc.head });
  if (f > doc.head) throw new UsageError(`v${f} does not exist (head is v${doc.head})`);
  if (t !== 'live' && t > doc.head) throw new UsageError(`v${t} does not exist (head is v${doc.head})`);
  const fromV = await ctx.store.readVersion(doc.id, f);
  /** @type {{ source: string, manifest: VersionManifest | null, assets: Record<string, string | null> }} */
  let toSide;
  if (t === 'live') {
    const head = await readHead(ctx, doc);
    const w = await readWorkingState(ctx, doc, head);
    const render = await ctx.render(doc, 'live').catch(() => ctx.render(doc, head.v));
    toSide = { source: w.text, manifest: null, assets: await hashWorkingAssets(ctx.root, render.assets, ctx.config.assets.maxBytes) };
  } else {
    const v = await ctx.store.readVersion(doc.id, t);
    toSide = { source: v.source, manifest: v.manifest, assets: v.manifest.assets ?? {} };
  }
  const toRender = await ctx.render(doc, t);
  return { from: f, to: t, fromSource: fromV.source, fromManifest: fromV.manifest, toRender, ...toSide };
}

/**
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ from?: number | string, to?: number | string }} [range]
 */
export async function changes(ctx, ref, range = {}) {
  const doc = await resolveDoc(ctx, ref);
  if (isCode(doc)) return codeChanges(ctx, doc, range);
  const p = await loadPair(ctx, doc, range);
  const hunks = lineHunks(p.fromSource, p.source);
  const cs = changeSet({ fromSource: p.fromSource, toSource: p.source, toRender: p.toRender, format: doc.format, hunks });
  const threads = await ctx.store.listThreads(doc.id);

  /** @type {Map<string, { threads: string[], linkedBy: string | null, other: string | null }>} */
  const links = new Map();
  /** @type {{ forced: boolean, brokenLocks: string[] }} */
  const guards = { forced: false, brokenLocks: [] };
  const changedPaths = changedAssets(p.fromManifest.assets, p.assets);
  if (p.to === 'live') {
    const pending = await ctx.store.readPendingEdits(doc.id);
    const ranges = threads
      .filter((t) => isActionable(t))
      .map((t) => ({ id: t.id, a: anchorAt(t, doc.head) }))
      .filter(({ a }) => a && a.kind !== 'doc' && a.state !== 'orphaned')
      .map(({ id, a }) => ({ id, start: /** @type {Anchor} */ (a).src.start, end: /** @type {Anchor} */ (a).src.end }));
    if (p.from === doc.head) {
      const attr = attribute({ hunks, headSource: p.fromSource, workingSource: p.source, pending, threads: ranges });
      for (const h of attr.hunks) links.set(h.id, { threads: h.threads, linkedBy: h.linkedBy, other: h.other });
    }
  } else if (p.to === p.from + 1) {
    for (const h of p.manifest?.hunks ?? []) links.set(h.id, { threads: h.threads ?? [], linkedBy: h.linkedBy ?? null, other: h.other ?? null });
    guards.forced = Boolean(p.manifest?.guards?.forced);
    guards.brokenLocks = p.manifest?.guards?.brokenLocks ?? [];
  } else if (p.to > p.from) {
    await spanLinks(ctx, doc, p.from, p.to, hunks, links, guards);
  }

  /** @type {Record<string, string[]>} */
  const threadLinks = {};
  const outHunks = cs.hunks.map((h) => {
    const l = links.get(h.id) ?? { threads: [], linkedBy: null, other: null };
    for (const t of l.threads) (threadLinks[t] ??= []).push(h.id);
    return { ...h, threads: l.threads, linkedBy: /** @type {any} */ (l.linkedBy), other: l.other };
  });

  const toLabel = p.to === 'live' ? 'live' : `v${p.to}`;
  const toAnchorV = p.to === 'live' ? doc.head : p.to;
  const assetThreads = assetLinks(threads.map((t) => ({ id: t.id, anchor: anchorAt(t, toAnchorV) })), changedPaths, doc.path);
  const assets = changedPaths.map((path) => ({
    path,
    from: p.fromManifest.assets?.[path] ?? null,
    to: p.assets[path] ?? null,
    fromUrl: p.fromManifest.assets?.[path] ? `v${p.from}/${path}` : null,
    toUrl: p.assets[path] ? `${toLabel}/${path}` : null,
    srids: sridsReferencing(p.toRender, doc.path, path),
    threads: Object.entries(assetThreads).filter(([, ps]) => ps.includes(path)).map(([t]) => t).sort(compareIds),
  }));
  for (const a of assets) for (const t of a.threads) (threadLinks[t] ??= []).push(`asset:${a.path}`);

  return { from: p.from, to: p.to, stats: cs.stats, hunks: outHunks, assets, threadLinks, guards };
}

/**
 * Links for a multi-version span: every recorded hunk of v in (from, to] whose new lines, mapped forward to `to`,
 * overlap a span hunk's new lines.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {number} from
 * @param {number} to
 * @param {import('../../diff/hunks.js').Hunk[]} hunks span hunks
 * @param {Map<string, { threads: string[], linkedBy: string | null, other: string | null }>} links
 * @param {{ forced: boolean, brokenLocks: string[] }} guards
 */
async function spanLinks(ctx, doc, from, to, hunks, links, guards) {
  /** @type {string[]} */
  const sources = [];
  /** @type {VersionManifest[]} */
  const manifests = [];
  for (let v = from; v <= to; v++) {
    const r = await ctx.store.readVersion(doc.id, v);
    sources.push(r.source);
    manifests.push(r.manifest);
  }
  /** @type {Array<{ range: [number, number], threads: string[], linkedBy: string | null, other: string | null }>} */
  const recorded = [];
  for (let i = 1; i < sources.length; i++) {
    const m = manifests[i];
    guards.forced ||= Boolean(m.guards?.forced);
    for (const b of m.guards?.brokenLocks ?? []) if (!guards.brokenLocks.includes(b)) guards.brokenLocks.push(b);
    for (const h of m.hunks ?? []) {
      /** @type {[number, number]} */
      let range = h.newLines > 0 ? [h.newStart, h.newStart + h.newLines - 1] : [Math.max(1, h.newStart - 1), h.newStart];
      for (let j = i; j < sources.length - 1; j++) {
        const mapper = offsetMapper(sources[j], sources[j + 1]);
        range = [mapper.mapLine(range[0]).line, mapper.mapLine(range[1]).line];
      }
      recorded.push({ range, threads: h.threads ?? [], linkedBy: h.linkedBy ?? null, other: h.other ?? null });
    }
  }
  for (const h of hunks) {
    const r = newLineRange(h);
    const hits = recorded.filter((x) => x.range[0] <= r[1] && r[0] <= x.range[1]);
    const threads = [...new Set(hits.flatMap((x) => x.threads))].sort(compareIds);
    const other = hits.map((x) => x.other).filter((o) => o != null).join('; ') || null;
    links.set(h.id, { threads, linkedBy: hits.find((x) => x.linkedBy)?.linkedBy ?? null, other });
  }
}

/**
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ from?: number | string, to?: number | string, context?: number }} [range]
 */
export async function sourceDiffOp(ctx, ref, range = {}) {
  const doc = await resolveDoc(ctx, ref);
  // code docs: the diff of one repo file (`range.path`; the whole-review text diff means nothing to a reader)
  if (isCode(doc)) return codeFileDiff(ctx, doc, /** @type {any} */ (range));
  const p = await loadPair(ctx, doc, range);
  const diff = sourceDiff(p.fromSource, p.source, { context: range.context ?? 3 });
  /** @type {Record<string, string[]>} */
  const byHunk = {};
  if (p.to !== 'live' && p.to === p.from + 1) for (const h of p.manifest?.hunks ?? []) byHunk[h.id] = h.threads ?? [];
  const hunks = diff.hunks.map((h) => ({ ...h, threads: [...new Set((h.hunkIds ?? [h.id]).flatMap((id) => byHunk[id] ?? []))].sort(compareIds) }));
  return { from: p.from, to: p.to, hunks };
}

/**
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {{ from?: number | string, to?: number | string }} [range]
 */
export async function unifiedDiff(ctx, ref, range = {}) {
  const doc = await resolveDoc(ctx, ref);
  if (isCode(doc)) return codeUnifiedDiff(ctx, doc, range);
  const p = await loadPair(ctx, doc, range);
  const toLabel = p.to === 'live' ? `${doc.path} (working copy)` : `${doc.path} (v${p.to})`;
  return { from: p.from, to: p.to, patch: unifiedPatch(p.fromSource, p.source, { fromLabel: `${doc.path} (v${p.from})`, toLabel }) };
}

/**
 * Before/after of a thread between the version the reviewer last commented on and head (clipped to 6 lines), or
 * an image pair when the anchored element's asset changed.
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {string} tid
 */
export async function threadMiniDiff(ctx, ref, tid) {
  const doc = await resolveDoc(ctx, ref);
  if (isCode(doc)) return codeThreadMiniDiff(ctx, doc, tid);
  const t = await requireThread(ctx, doc.id, tid);
  const head = doc.head;
  const { lastHuman } = lastIndexes(t);
  const base = Math.min(head, Math.max(t.createdIn ?? 1, lastHuman >= 0 ? t.comments[lastHuman].version ?? 1 : t.createdIn ?? 1));
  const before = anchorAt(t, base);
  const after = anchorAt(t, head);
  if (after?.kind !== 'doc' && before && after) {
    const path = anchorAssetPath(after, doc.path) ?? anchorAssetPath(before, doc.path);
    if (path && base !== head) {
      const [b, a] = await Promise.all([ctx.store.readVersion(doc.id, base), ctx.store.readVersion(doc.id, head)]);
      const ra = b.manifest.assets?.[path] ?? null;
      const rb = a.manifest.assets?.[path] ?? null;
      if (ra !== rb) return { kind: 'image', version: head, from: base, path, beforeUrl: ra ? `v${base}/${path}` : null, afterUrl: rb ? `v${head}/${path}` : null };
    }
  }
  const textOf = async (/** @type {Anchor | null} */ a, /** @type {number} */ v) => {
    if (!a || a.kind === 'doc' || a.state === 'orphaned') return '';
    const { source } = await ctx.store.readVersion(doc.id, v);
    const li = lineIndex(source);
    const lines = source.slice(li.startOf(a.src.startLine), li.endOf(a.src.endLine)).split('\n');
    return lines.length > 6 ? [...lines.slice(0, 5), `…(${lines.length - 5} more lines)`].join('\n') : lines.join('\n');
  };
  const b = await textOf(before, base);
  const a = await textOf(after, head);
  return { kind: 'text', version: head, from: base, before: b, after: a, words: wordDiff(b, a), state: after?.state ?? null };
}

/**
 * DomTargets of threads, locks and drafts for a version ('live' = head anchors mapped to the working copy).
 * @param {Ctx} ctx
 * @param {string | Doc} ref
 * @param {number | string} ver
 */
export async function domTargets(ctx, ref, ver) {
  const doc = await resolveDoc(ctx, ref);
  const v = parseVersionArg(ver, { allowLive: true, fallback: doc.head });
  // code docs are never framed: nothing to paint
  if (isCode(doc)) return { version: v, threads: [], locks: [], drafts: [], outline: [] };
  const render = await ctx.render(doc, v);
  const env = envOf(doc, ctx.config);
  const anchorV = v === 'live' ? doc.head : v;
  /** @type {((a: Anchor, item: any) => Anchor) | null} */
  let toLive = null;
  if (v === 'live') {
    const head = await readHead(ctx, doc);
    const w = await readWorkingState(ctx, doc, head);
    if (w.dirty && !w.missing) {
      const hunks = lineHunks(head.source, w.text);
      toLive = (a, item) => liveAnchor(a, { headSource: head.source, workingSource: w.text, hunks, render, env, original: originalAnchor(item) });
    }
  }
  /** @param {Anchor} a @param {any} item */
  const at = (a, item) => (toLive && a.kind !== 'doc' ? toLive(a, item) : a);

  const threads = await ctx.store.listThreads(doc.id);
  /** @type {DomTarget[]} */
  const threadTargets = [];
  for (const t of threads) {
    const a = anchorAt(t, anchorV);
    if (!a || (t.createdIn ?? 0) > anchorV) continue;
    threadTargets.push(domTarget(at(a, t), render, { id: t.id, num: idNumber(t.id), state: threadState(t, a), severity: t.severity, type: t.type, env }));
  }
  /** @type {DomTarget[]} */
  const lockTargets = [];
  for (const l of await ctx.store.listLocks(doc.id)) {
    if (!l.active || (l.createdIn ?? 0) > anchorV) continue;
    const a = anchorAt(l, anchorV);
    if (!a || a.state === 'orphaned') continue;
    lockTargets.push(domTarget(at(a, l), render, { id: l.id, num: idNumber(l.id), state: 'lock', env }));
  }
  /** @type {DomTarget[]} */
  const draftTargets = [];
  if (v !== 'live') {
    /** @type {ReturnType<typeof versionLoader> | null} */
    let load = null;
    for (const d of (await ctx.store.getDrafts(doc.id)).items) {
      if (d.kind !== 'thread' || !d.anchor || d.anchor.v > v) continue;
      // A draft written on an older version is carried forward to this one, as submitReview will do; a draft
      // whose text is gone here is not painted (the UI says where it was written).
      let a = d.anchor;
      if (a.v < v) {
        load ??= versionLoader(ctx, doc);
        try {
          a = await forwardedDraftAnchor(ctx, doc, a, v, load, env);
        } catch {
          continue; // never let one draft cost the page its other targets
        }
        if (a.state === 'orphaned') continue;
      }
      draftTargets.push(domTarget(a, render, { id: d.id, num: idNumber(d.id), state: 'draft', severity: d.severity, type: d.type, env }));
    }
  }
  return { version: v, threads: threadTargets, locks: lockTargets, drafts: draftTargets, outline: render.outline };
}

/** Forwarded draft anchors per store (versions are immutable, so an anchor + target version always maps the same). */
/** @type {WeakMap<object, Map<string, Anchor>>} */
const forwardCache = new WeakMap();
const FORWARD_CACHE_MAX = 500;

/**
 * A draft anchor carried forward to version `v` (memoised).
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {Anchor} anchor
 * @param {number} v
 * @param {ReturnType<typeof versionLoader>} load
 * @param {ReturnType<typeof envOf>} env
 * @returns {Promise<Anchor>}
 */
async function forwardedDraftAnchor(ctx, doc, anchor, v, load, env) {
  let cache = forwardCache.get(ctx.store);
  if (!cache) forwardCache.set(ctx.store, (cache = new Map()));
  const key = `${doc.id}\0${v}\0${JSON.stringify(anchor)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const a = (await forwardAnchor(anchor, v, load, env))[String(v)] ?? anchor;
  if (cache.size >= FORWARD_CACHE_MAX) cache.delete(/** @type {string} */ (cache.keys().next().value));
  cache.set(key, a);
  return a;
}

/**
 * DomTarget state of a thread (amendments 3.4).
 * @param {Thread} t
 * @param {Anchor} a
 * @returns {DomTarget['state']}
 */
function threadState(t, a) {
  if (t.status === 'resolved') return 'resolved';
  if (a.state === 'orphaned') return 'orphaned';
  if (a.state === 'changed') return 'outdated';
  if (t.status === 'needs_input' && !isActionable(t)) return 'needs_input';
  if (t.status === 'addressed' || t.status === 'answered' || t.status === 'declined') return isActionable(t) ? 'open' : 'addressed';
  return 'open';
}
