// @ts-check
// Recording the working copy as a new version (design 8.1, BUILD_AMENDMENTS 4.2-4.5), shared by `revise`,
// the reviewer's "Record as my revision" and "Apply suggestion now". Two phases, both inside the doc lock:
//
// prepareRecord: hunks head -> working, precise mapper, attribution (tagged / hint / overlap / other), the working
//   render, changed assets (+ threads linked through them), lock integrity, decisions, and (optionally) guards.
//   Nothing is written.
// commitRecord: asset blobs + version source, then - still before the commit point - re-anchoring of every thread
//   and lock one version forward (staged overrides first), replies, staged suggestions -> applied when their text
//   is really in the version at a linked hunk (with the automatic reply "Applied the suggestion verbatim." when
//   the agent gave none) else back to pending, broken locks, doc state back to in_review, all written as a redo
//   journal; then the manifest (the commit point); then the journal is applied (thread / lock / doc files, pending
//   edits cleared, `version.created` (+ `lock.changed`) events) and the optional git auto-commit. A crash after the
//   manifest is rolled forward by recoverDoc (design C6: the version, replies and guard result commit atomically).

import { SSE } from '../../../shared/protocol.js';
import { lineHunks } from '../../diff/index.js';
import { deepestBlockAt, renderSource, sectionAt } from '../../render/index.js';
import { formatLines } from '../../util/lines-arg.js';
import { lineIndex } from '../../text/index.js';
import { envOf, sectionExtent, stepAnchor } from '../anchoring.js';
import { attribute, newLineRange, oldLineRange } from '../attribution.js';
import { assetLinks, changedAssets, hashWorkingAssets } from '../assets.js';
import { autoCommit } from '../git.js';
import { issueStrings, lockIntegrity, runGuards } from '../guards.js';
import { lockLabel } from '../packet-data.js';
import { anchorAt, isActionable, originalAnchor } from '../threadstate.js';
import { preciseMapper } from '../workmap.js';
import { addAgentReply } from './threads.js';
import { lastDeliveredAt } from './common.js';
import { eolOf, matchEol } from '../apply.js';

/**
 * @typedef {import('../context.js').Ctx} Ctx
 * @typedef {import('../../../shared/types.js').Doc} Doc
 * @typedef {import('../../../shared/types.js').Thread} Thread
 * @typedef {import('../../../shared/types.js').Lock} Lock
 * @typedef {import('../../../shared/types.js').Review} Review
 * @typedef {import('../../../shared/types.js').Actor} Actor
 * @typedef {import('../../../shared/types.js').Anchor} Anchor
 * @typedef {import('../../../shared/types.js').VersionManifest} VersionManifest
 * @typedef {import('../../diff/hunks.js').Hunk} Hunk
 * @typedef {import('./common.js').HeadState} HeadState
 * @typedef {import('./common.js').WorkingState} WorkingState
 * @typedef {Record<string, { status: string, reply: string, at?: string }>} Replies
 *
 * @typedef {object} Prepared
 * @property {HeadState} head
 * @property {WorkingState & { buf: Buffer }} working
 * @property {Hunk[]} hunks
 * @property {import('../workmap.js').PreciseMapper} mapper
 * @property {import('../attribution.js').Attribution} attribution
 * @property {import('../../render/index.js').RenderResult} render render of the working copy (= the new version)
 * @property {Record<string, string | null>} workingAssets
 * @property {string[]} changedAssets
 * @property {Record<string, string[]>} assetLinks thread id -> changed asset paths
 * @property {Record<string, string>} sections hunk id -> section label
 * @property {Thread[]} threads
 * @property {Lock[]} locks
 * @property {Review[]} reviews
 * @property {import('../guards.js').GuardResult | null} guards
 * @property {Array<{ via: string, thread?: string, lines?: [number, number], quote?: string }>} overrides
 */

/**
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {object} p
 * @param {HeadState} p.head
 * @param {WorkingState & { buf: Buffer }} p.working
 * @param {Replies} [p.replies]
 * @param {Array<{ at: string, why: string }>} [p.other]
 * @param {boolean} [p.guards] run the guards (agent revisions)
 * @param {{ force?: boolean, allowRewrite?: boolean, breakLocks?: Record<string, string> }} [p.flags]
 * @returns {Promise<Prepared>}
 */
export async function prepareRecord(ctx, doc, { head, working, replies = {}, other = [], guards = false, flags = {} }) {
  const hunks = lineHunks(head.source, working.text);
  const mapper = preciseMapper(head.source, working.text, hunks);
  const [threads, locks, reviews, pending] = await Promise.all([
    ctx.store.listThreads(doc.id),
    ctx.store.listLocks(doc.id),
    ctx.store.listReviews(doc.id),
    ctx.store.readPendingEdits(doc.id),
  ]);
  const render = await renderSource({ format: doc.format, source: working.text, docPath: doc.path });
  const workingLi = lineIndex(working.text);

  // Attribution inputs: threads the agent is working on (actionable, or replied to now), their hints, and the
  // scope each thread's link explains (deletion guard).
  const replied = new Set(Object.keys(replies));
  const headRender = await ctx.render(doc, head.v);
  /** @type {Array<{ id: string, start: number, end: number }>} */
  const ranges = [];
  /** @type {Array<{ thread: string, at: string }>} */
  const hints = [];
  /** @type {Record<string, [number, number] | null>} */
  const threadLines = {};
  /** @type {Record<string, Array<[number, number]> | 'all'>} */
  const scopes = {};
  for (const t of threads) {
    const a = anchorAt(t, head.v);
    const working_ = t.status !== 'resolved' && (isActionable(t) || replied.has(t.id));
    if (a) scopes[t.id] = scopeOf(a, headRender, head.source);
    if (a && a.kind !== 'doc' && a.state !== 'orphaned') {
      if (working_) ranges.push({ id: t.id, start: a.src.start, end: a.src.end });
      const m = mapper.mapRange(a.src.start, a.src.end);
      const l0 = workingLi.lineOf(m.start);
      threadLines[t.id] = [l0, Math.max(l0, m.end > m.start ? workingLi.lineOf(m.end - 1) : l0)];
    }
    // `at` lines of agent replies made against head since it was recorded (`reply --at`, a replies-only revise).
    // Not those stored WITH head by the revise that recorded it (their lines describe the previous round's
    // changes), and none on resolved threads: a stale hint would claim, and exempt from the guards, an unrelated
    // later change at those lines.
    if (t.status === 'resolved') continue;
    for (const c of t.comments ?? []) {
      const lines = /** @type {any} */ (c).atLines;
      if (/** @type {any} */ (c).recordedWith != null) continue;
      if (c.by?.kind === 'agent' && c.version === head.v && Array.isArray(lines) && lines.length) hints.push({ thread: t.id, at: formatLines(lines) });
    }
  }
  for (const [tid, r] of Object.entries(replies)) if (r?.at) hints.push({ thread: tid, at: String(r.at) });

  const attribution = attribute({ hunks, headSource: head.source, workingSource: working.text, pending, hints, threads: ranges, other, mapper, scopes });

  const workingAssets = await hashWorkingAssets(ctx.root, render.assets, ctx.config.assets.maxBytes);
  const changed = changedAssets(head.manifest.assets, workingAssets);
  const links = assetLinks(
    threads.map((t) => ({ id: t.id, anchor: anchorAt(t, head.v) })),
    changed,
    doc.path,
  );

  /** @type {Record<string, string>} */
  const sections = {};
  for (const h of hunks) sections[h.id] = hunkSection(render, h);

  /** @type {import('../guards.js').GuardResult | null} */
  let guardResult = null;
  if (guards) {
    const activeLocks = locks
      .filter((l) => l.active)
      .map((l) => {
        const a = anchorAt(l, head.v);
        if (!a || a.state === 'orphaned') return null;
        const integrity = lockIntegrity({
          mapper,
          headSource: head.source,
          workingSource: working.text,
          start: a.src.start,
          end: a.src.end,
          format: doc.format,
        });
        return {
          id: l.id,
          label: lockLabel(a, doc.title),
          agreedIn: reviews.find((r) => (r.locksAdded ?? []).includes(l.id))?.id ?? null,
          createdAt: /** @type {string | null} */ (l.createdAt ?? null),
          ...integrity,
        };
      })
      .filter((x) => x !== null);
    const decisions = threads
      .filter((t) => t.status === 'resolved' && t.decision?.text)
      .map((t) => ({ t, a: anchorAt(t, head.v) }))
      .filter(({ a }) => a && a.kind !== 'doc' && a.state !== 'orphaned')
      .map(({ t, a }) => ({ id: /** @type {any} */ (t.decision).id, thread: t.id, start: /** @type {Anchor} */ (a).src.start, end: /** @type {Anchor} */ (a).src.end }));
    guardResult = runGuards({
      docId: doc.id,
      headVersion: head.v,
      headLines: lineIndex(head.source).count,
      headSource: head.source,
      workingSource: working.text,
      hunks: attribution.hunks,
      sections,
      config: ctx.config.guards,
      locks: activeLocks,
      lastDeliveredAt: lastDeliveredAt(reviews, ctx.agent),
      replies,
      actionable: threads.filter((t) => isActionable(t)).map((t) => t.id),
      threadLinks: attribution.threadLinks,
      assetLinks: links,
      threadLines,
      decisions,
      mapper,
      unusedOther: attribution.unusedOther,
      badHints: attribution.badHints,
      flags,
    });
  }

  const overrides = pending.filter((e) => e.via === 'override' && e.thread);
  return {
    head,
    working,
    hunks,
    mapper,
    attribution,
    render,
    workingAssets,
    changedAssets: changed,
    assetLinks: links,
    sections,
    threads,
    locks,
    reviews,
    guards: guardResult,
    overrides: /** @type {any} */ (overrides),
  };
}

/**
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @param {Prepared} prep
 * @param {object} p
 * @param {Actor} p.author
 * @param {string} p.summary
 * @param {'revise' | 'ui-record' | 'ui-apply'} p.capturedBy
 * @param {string | null} p.respondsTo
 * @param {Replies} [p.replies]
 * @param {boolean} [p.autoReply] add "Applied the suggestion verbatim." to applied suggestions without a reply
 * @param {Record<string, string>} [p.breakLocks]
 * @param {(threads: Map<string, Thread>, v: number, events: Array<{ type: string } & Record<string, unknown>>) => void} [p.finish]
 *   last in-memory changes to the threads of the new version (e.g. "Apply now" resolving its thread), made before
 *   the commit point so they are committed with it
 * @returns {Promise<{ manifest: VersionManifest, anchors: { threads: number, locks: number, exact: number, moved: number,
 *   edited: number, changed: number, orphaned: number }, git: { commit: string | null, skipped?: string, error?: string } }>}
 */
export async function commitRecord(ctx, doc, prep, { author, summary, capturedBy, respondsTo, replies = {}, autoReply = true, breakLocks = {}, finish }) {
  const { head, working, attribution, render } = prep;
  const g = prep.guards;
  const brokenLocks = g?.brokenLocks ?? [];
  const at = ctx.now();
  const stats = {
    added: prep.hunks.reduce((n, h) => n + h.newLines, 0),
    removed: prep.hunks.reduce((n, h) => n + h.oldLines, 0),
    hunks: prep.hunks.length,
    rewriteRatio: Math.round((g?.rewriteRatio ?? 0) * 10000) / 10000,
  };
  /** @type {Record<string, string | null>} */
  const assetFiles = {};
  for (const rel of render.assets) assetFiles[rel] = null;
  const counts = { threads: 0, locks: 0, exact: 0, moved: 0, edited: 0, changed: 0, orphaned: 0 };
  for (const tid of Object.keys(replies)) {
    if (prep.threads.some((t) => t.id === tid)) continue;
    const t = await ctx.store.getThread(doc.id, tid);
    if (t) prep.threads.push(t);
  }

  // Everything that changes with the version (re-anchored threads and locks, replies, suggestion states, doc state,
  // pending edits, events) is computed and written as a redo journal BEFORE the manifest, the commit point: an
  // exception or a crash before it records nothing; a crash after it is rolled forward by recoverDoc.
  /** @type {import('../../store/store.js').Journal | null} */
  let journal = null;
  const manifest = await ctx.store.commitVersion(doc, {
    source: working.buf,
    manifest: {
      author,
      summary,
      respondsTo,
      capturedBy,
      stats,
      hunks: attribution.hunks.map((h) => ({
        id: h.id,
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        threads: h.threads,
        linkedBy: h.linkedBy,
        other: h.other,
      })),
      guards: {
        errors: issueStrings(g?.errors ?? []),
        warnings: issueStrings(g?.warnings ?? []),
        forced: Boolean(g?.forced),
        brokenLocks,
      },
      git: { commit: null },
    },
    assetFiles,
    beforeCommit: async (final) => {
      journal = versionJournal(ctx, doc, prep, final, { author, summary, replies, autoReply, breakLocks, brokenLocks, stats, at, counts, finish });
      await ctx.store.writeJournal(doc.id, journal);
    },
  });
  await ctx.store.applyJournal(doc.id, /** @type {import('../../store/store.js').Journal} */ (/** @type {unknown} */ (journal)));

  const threadIds = [...new Set(attribution.hunks.flatMap((h) => h.threads))].sort();
  const git = await autoCommit({ root: ctx.root, config: ctx.config, docId: doc.id, docPath: doc.path, version: manifest.v, summary, threads: threadIds });
  return { manifest, anchors: counts, git };
}

/**
 * The redo journal of a new version (pure in-memory work on prep's threads, locks and `doc`): every thread and lock
 * re-anchored one version forward (staged overrides first), replies, staged suggestions settled, broken locks, doc
 * state, pending edits cleared, `version.created` (+ `lock.changed`) events.
 * @param {Ctx} ctx
 * @param {Doc} doc mutated: state, counters (comment ids)
 * @param {Prepared} prep
 * @param {VersionManifest} final the manifest about to be committed
 * @param {{ author: Actor, summary: string, replies: Replies, autoReply: boolean, breakLocks: Record<string, string>,
 *   brokenLocks: string[], stats: { hunks: number }, at: string, counts: Record<string, number>,
 *   finish?: (threads: Map<string, Thread>, v: number, events: Array<{ type: string } & Record<string, unknown>>) => void }} o
 * @returns {import('../../store/store.js').Journal}
 */
function versionJournal(ctx, doc, prep, final, { author, summary, replies, autoReply, breakLocks, brokenLocks, stats, at, counts, finish }) {
  const { head, working, attribution, render } = prep;
  const newV = final.v;
  const linkedByOf = new Map(attribution.hunks.map((h) => [h.id, h.linkedBy]));
  /** @type {Map<string, any>} */
  const overrideFor = new Map();
  for (const o of prep.overrides) overrideFor.set(/** @type {string} */ (o.thread), o);

  const env = envOf(doc, ctx.config);
  /**
   * @param {Anchor} prev
   * @param {{ anchors?: any, createdIn?: number }} item
   * @param {string[]} linkIds
   * @param {{ linked?: boolean, override?: { lines?: [number, number], quote?: string } | null }} [extra]
   */
  const step = (prev, item, linkIds, extra = {}) =>
    stepAnchor({
      anchor: prev,
      original: originalAnchor(/** @type {any} */ (item)),
      fromSource: head.source,
      toSource: working.text,
      toVersion: newV,
      toRender: render,
      env,
      hunks: prep.hunks,
      linkIds,
      linked: extra.linked,
      override: extra.override ?? null,
      assets: final.assets ?? null,
    });
  /** @param {Anchor} a */
  const tally = (a) => {
    const st = /** @type {keyof typeof counts} */ (a.state);
    if (st in counts) counts[st] += 1;
  };

  for (const t of prep.threads) {
    const prev = anchorAt(t, head.v);
    if (!prev) continue;
    const links = attribution.threadLinks[t.id] ?? [];
    const ov = overrideFor.get(t.id);
    const override = ov ? (ov.lines ? { lines: ov.lines } : { quote: ov.quote }) : null;
    const next = step(prev, t, links, { linked: Boolean(prep.assetLinks[t.id]?.length), override });
    if (override && next.mappedBy === 'override') t.override = { version: newV, ...override, by: 'agent' };
    t.anchors = { ...t.anchors, [String(newV)]: next };
    for (const hid of links) t.changes = [...(t.changes ?? []), { version: newV, hunk: hid, linkedBy: /** @type {any} */ (linkedByOf.get(hid)) }];
    counts.threads += 1;
    tally(next);
  }

  for (const l of prep.locks) {
    const prev = anchorAt(l, head.v);
    if (!prev) continue;
    const next = step(prev, l, []);
    l.anchors = { ...l.anchors, [String(newV)]: next };
    if (brokenLocks.includes(l.id)) {
      l.active = false;
      l.breaks = [...(l.breaks ?? []), { version: newV, reason: String(breakLocks[l.id] ?? ''), by: author.name, at }];
    }
    counts.locks += 1;
    tally(next);
  }

  // Replies, then staged suggestions. Replies stored with the version are marked (`recordedWith`) so their `at`
  // lines are not taken as hints for the NEXT revision.
  const byId = new Map(prep.threads.map((t) => [t.id, t]));
  for (const [tid, r] of Object.entries(replies)) {
    const t = byId.get(tid);
    if (!t) continue;
    /** @type {any} */ (addAgentReply(ctx, doc, t, { body: r.reply, status: r.status, at: r.at }, newV)).recordedWith = newV;
  }
  // After this version no tagged edit is pending, so no suggestion stays `staged`: it is `applied` when its new text
  // really is in the version at a hunk linked to its thread, else (undone, reverted, rewritten, or a stale tag)
  // `pending` again - never an "Applied the suggestion verbatim." for text that is not there.
  const eol = eolOf(working.text);
  for (const t of byId.values()) {
    const sg = t.suggestion;
    if (!sg || sg.status !== 'staged') continue;
    if (!suggestionLanded(attribution.hunks.filter((h) => h.threads.includes(t.id)), working.text, sg.new, eol)) {
      sg.status = 'pending';
      continue;
    }
    sg.status = 'applied';
    sg.appliedIn = newV;
    if (autoReply && !replies[t.id] && t.status !== 'resolved') {
      /** @type {any} */ (addAgentReply(ctx, doc, t, { body: 'Applied the suggestion verbatim.', status: 'addressed' }, newV)).recordedWith = newV;
    }
  }

  /** @type {Array<{ type: string } & Record<string, unknown>>} */
  const events = [
    {
      type: SSE.VERSION_CREATED,
      v: newV,
      author: `${author.kind}:${author.name}`,
      summary,
      counts: {
        hunks: stats.hunks,
        replies: Object.keys(replies).length,
        addressed: Object.values(replies).filter((r) => r.status === 'addressed').length,
        needsInput: Object.values(replies).filter((r) => r.status === 'needs_input').length,
      },
    },
  ];
  if (brokenLocks.length) events.push({ type: SSE.LOCK_CHANGED, locks: brokenLocks, broken: true });
  if (finish) finish(byId, newV, events);

  if (doc.state !== 'closed') doc.state = 'in_review';
  return {
    version: newV,
    doc: { ...doc, head: newV },
    threads: [...byId.values()],
    locks: prep.locks,
    clearPending: true,
    events,
  };
}

/**
 * Whether a staged suggestion's new text is in the new version where a hunk linked to its thread changed it (an
 * empty / blank replacement: whether such a hunk exists).
 * @param {import('../attribution.js').AttributedHunk[]} linked hunks linked to the thread
 * @param {string} text new version
 * @param {string} neu suggestion.new
 * @param {'\r\n' | '\n'} eol
 */
function suggestionLanded(linked, text, neu, eol) {
  if (!linked.length) return false;
  if (!String(neu ?? '').trim()) return true;
  for (const v of new Set([neu, matchEol(neu, eol)])) {
    for (let p = text.indexOf(v); p >= 0; p = text.indexOf(v, p + 1)) {
      const e = p + v.length;
      if (linked.some((h) => p <= h.newEndOff && e >= h.newStartOff)) return true;
    }
  }
  return false;
}

/** Paragraph-level blocks: a thread anchored on text inside one explains changes anywhere in it. */
const SCOPE_BLOCKS = new Set(['p', 'li', 'dt', 'dd', 'td', 'th', 'tr', 'pre', 'blockquote', 'figcaption', 'caption', 'summary']);

/**
 * Head source ranges a link to a thread explains (attribution `scopes`): the anchor's range, plus the paragraph-level
 * block holding a text / code anchor (a comment on one sentence of a hard-wrapped paragraph explains rewording the
 * paragraph) - for a heading, the section it opens; a GENERAL (doc) thread explains the whole doc.
 * @param {Anchor} a head anchor
 * @param {import('../../render/index.js').RenderResult | null} render head render
 * @param {string} source head source
 * @returns {Array<[number, number]> | 'all'}
 */
function scopeOf(a, render, source) {
  if (a.kind === 'doc') return 'all';
  /** @type {Array<[number, number]>} */
  const out = [[a.src.start, a.src.end]];
  if ((a.kind === 'text' || a.kind === 'code' || a.kind === 'source') && render && !a.generated) {
    const srid = deepestBlockAt(render, a.src.start, Math.max(a.src.start, a.src.end));
    const n = srid != null ? render.srcmap.nodes[srid] : null;
    if (n && n.h && srid != null) {
      const sec = sectionExtent(render, source, srid);
      out.push([sec.start, sec.end]);
    } else if (n && (SCOPE_BLOCKS.has(String(n.t).toLowerCase()) || n.k === 'code' || n.k === 'math' || n.k === 'mermaid')) {
      out.push([n.s, n.e]);
    }
  }
  return out;
}

/**
 * Section label of a hunk for reports: 'front matter', the innermost heading, or '' before any heading.
 * @param {import('../../render/index.js').RenderResult} render
 * @param {Hunk} h
 * @returns {string}
 */
function hunkSection(render, h) {
  // a pure deletion belongs to the section that held the removed lines: the one ending at the deletion point
  const off = h.newLines === 0 ? Math.max(0, h.newStartOff - 1) : h.newStartOff;
  for (const srid of render.srcmap.order) {
    const n = render.srcmap.nodes[srid];
    if (n.k === 'frontmatter' && n.s <= off && off < n.e) return 'front matter';
  }
  const chain = sectionAt(render, off);
  return chain.length ? chain[chain.length - 1] : '';
}

/**
 * Report rows for the hunks of a prepared record.
 * @param {Prepared} prep
 */
export function reportHunks(prep) {
  return prep.attribution.hunks.map((h) => ({
    id: h.id,
    oldRange: h.oldLines > 0 ? oldLineRange(h) : null,
    newRange: h.newLines > 0 ? newLineRange(h) : null,
    fromVersion: prep.head.v,
    section: prep.sections[h.id] ?? '',
    threads: h.threads,
    linkedBy: h.linkedBy,
    via: h.via,
    other: h.other,
    stats: h.stats,
  }));
}
