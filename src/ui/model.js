// @ts-check
// Pure, import-free helpers that derive what the UI shows from DocState (design 5.3 / 10.2 shapes): thread status
// and anchor-state chips, panel filters and the Verify queue, document order, presence and review progress,
// changes grouping, outline badges and the history timeline. No DOM and no store access, so the same functions
// run in the browser and in Node tests.

/** @typedef {any} DocState */
/** @typedef {any} Thread */
/** @typedef {any} Anchor */

// ------------------------------------------------------------------------------------------------ text helpers

/** Collapses whitespace runs and trims. @param {unknown} s */
export function normWs(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** Whitespace-normalised and shortened with an ellipsis. @param {unknown} s @param {number} n */
export function clip(s, n) {
  const t = normWs(s);
  return t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t;
}

/** 'L42' or 'L42-43' from [start, end] or {startLine, endLine}. @param {any} lines */
export function linesLabel(lines) {
  if (!lines) return '';
  const s = Array.isArray(lines) ? lines[0] : lines.startLine;
  const e = Array.isArray(lines) ? lines[1] ?? lines[0] : lines.endLine ?? lines.startLine;
  if (!Number.isFinite(s)) return '';
  return e != null && e !== s ? `L${s}-${e}` : `L${s}`;
}

/** Last element of a heading chain (array) or the string itself. @param {unknown} section */
export function sectionTail(section) {
  if (Array.isArray(section)) return section.length ? String(section[section.length - 1]) : '';
  return section ? String(section) : '';
}

/** @param {string|null|undefined} iso */
export function formatClock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Short relative time ("just now", "5 min ago", "3 h ago", or a date). @param {string|null|undefined} iso @param {number} [now] */
export function relTime(iso, now = Date.now()) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ------------------------------------------------------------------------------------------------ actors

/** @param {any} actor */
export function isAgent(actor) {
  return !!actor && actor.kind === 'agent';
}

/** @param {any} actor */
export function isHuman(actor) {
  return !!actor && actor.kind === 'human';
}

/** Name of the agent the doc talks to (live waiter, last delivery, last agent author; default 'claude'). @param {DocState} ds */
export function agentName(ds) {
  const w = ds?.waiters?.find((/** @type {any} */ x) => x?.agent);
  if (w) return String(w.agent);
  const reviews = sortedReviews(ds);
  for (let i = reviews.length - 1; i >= 0; i--) {
    const names = Object.keys(reviews[i].deliveredTo || {});
    if (names.length) return names[0];
  }
  const versions = ds?.versions || [];
  for (let i = versions.length - 1; i >= 0; i--) {
    if (isAgent(versions[i].author) && versions[i].author.name) return String(versions[i].author.name);
  }
  return 'claude';
}

/** 'You' for the reviewer, else the actor's name. @param {any} actor @param {DocState} [ds] */
export function actorLabel(actor, ds) {
  if (!actor) return 'unknown';
  if (isHuman(actor)) return 'You';
  return String(actor.name || actor.kind || 'unknown');
}

// ------------------------------------------------------------------------------------------------ versions

/** Recorded version numbers, ascending. @param {DocState} ds @returns {number[]} */
export function versionNumbers(ds) {
  return (ds?.versions || []).map((/** @type {any} */ v) => Number(v.v)).filter(Number.isFinite).sort((a, b) => a - b);
}

/** @param {DocState} ds @param {number} v */
export function versionMeta(ds, v) {
  return (ds?.versions || []).find((/** @type {any} */ x) => Number(x.v) === Number(v)) || null;
}

/** Numeric version for a selection ('live' -> head). @param {DocState} ds @param {number|'live'|null} version */
export function numericVersion(ds, version) {
  if (version === 'live' || version == null) return Number(ds?.doc?.head) || 1;
  return Number(version);
}

/**
 * Default Changes base: 'last' = the version of the newest review if older than the shown version, else the
 * previous version; 'prev' = the previous version. Null when there is nothing to compare (v1).
 * @param {DocState} ds
 * @param {number|'live'|null} version
 * @param {'last'|'prev'|'custom'} kind
 * @returns {number|null}
 */
export function defaultBase(ds, version, kind) {
  const head = Number(ds?.doc?.head) || 1;
  if (version === 'live') {
    const last = Number(ds?.doc?.lastReviewedVersion);
    return kind === 'last' && last >= 1 && last <= head ? last : head;
  }
  const v = Number(version ?? head);
  const last = Number(ds?.doc?.lastReviewedVersion);
  if (kind === 'last' && last >= 1 && last < v) return last;
  return v > 1 ? v - 1 : null;
}

/** Guard badges of a version manifest summary. @param {any} meta @param {number} [maxRatio] */
export function guardBadges(meta, maxRatio = 0.5) {
  /** @type {Array<{ key: string, label: string, tone: string }>} */
  const out = [];
  const g = meta?.guards;
  if (g?.forced) out.push({ key: 'forced', label: 'forced', tone: 'danger' });
  if (g?.brokenLocks?.length) out.push({ key: 'lock', label: `lock broken (${g.brokenLocks.join(', ')})`, tone: 'danger' });
  if (Number(meta?.stats?.rewriteRatio) > maxRatio) out.push({ key: 'rewrite', label: 'large rewrite', tone: 'warn' });
  if (g?.warnings?.length) out.push({ key: 'warnings', label: `${g.warnings.length} warning${g.warnings.length > 1 ? 's' : ''}`, tone: 'warn' });
  return out;
}

// ------------------------------------------------------------------------------------------------ anchors

/**
 * The anchor of a thread / lock at version v: anchors[v], else the newest anchor before v, else the oldest one.
 * @param {any} item thread or lock
 * @param {number|'live'|null} v
 * @returns {Anchor|null}
 */
export function anchorAt(item, v) {
  const anchors = item?.anchors;
  if (!anchors || typeof anchors !== 'object') return item?.anchor || null;
  const keys = Object.keys(anchors).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!keys.length) return null;
  if (v === 'live' || v == null) return anchors[String(keys[keys.length - 1])];
  if (anchors[String(v)]) return anchors[String(v)];
  let best = null;
  for (const k of keys) if (k <= Number(v)) best = k;
  return anchors[String(best ?? keys[0])];
}

/**
 * Short human label of what an anchor targets. Table anchors follow their capture scope like the packet the agent
 * gets (amendments 3.3): a row pick is 'table row "Enterprise"', a column pick 'table column "Rate (req/s)"', a
 * whole-table pick 'table', and only a cell pick names both keys.
 * @param {Anchor|null} a
 */
export function targetLabel(a) {
  if (!a) return '';
  if (a.kind === 'doc') return 'General comment';
  if (a.kind === 'section') return `§ ${sectionTail(a.section) || 'section'}`;
  if (a.kind === 'source') return linesLabel(a.src) || 'source lines';
  if (a.svg) return `diagram node "${clip(a.svg.label || a.svg.nodeId, 40)}"`;
  const table = tableLabel(a);
  if (table) return table;
  if (a.element) {
    const base = a.element.label || `<${a.element.tag}>`;
    return a.region ? `${base} (region)` : base;
  }
  if (a.quote?.exact) return `“${clip(a.quote.exact, 80)}”`;
  if (a.src?.text) return `“${clip(a.src.text, 80)}”`;
  return a.kind || '';
}

/** Label of a table anchor (cell / row / column / table scope), or '' for other anchors. @param {Anchor} a */
function tableLabel(a) {
  const c = a.cell;
  const scope = a.scope || (c ? 'cell' : null);
  if (!scope || (!c && scope !== 'table')) return '';
  if (scope === 'row') return `table row "${clip(c.rowKey, 40)}"`;
  if (scope === 'column') return `table column "${clip(c.colHeader, 40)}"`;
  if (scope === 'table') {
    const label = String(a.element?.label || '');
    return label && !/^<table>$/i.test(label) ? label : 'table';
  }
  return `cell "${clip(c.rowKey, 24)}" × "${clip(c.colHeader, 24)}"`;
}

/**
 * The text a card quotes for its anchor (at most `max` characters, whitespace collapsed): the selected text of
 * text / code / source anchors, the element's text sample for picked elements (a list item, a paragraph, a table
 * row). Empty for doc and section anchors, diagrams, regions and elements without text (images).
 * @param {Anchor|null} a
 * @param {number} [max]
 */
export function anchorQuote(a, max = 120) {
  if (!a || a.kind === 'doc' || a.kind === 'section') return '';
  if (a.kind === 'text' || a.kind === 'code' || a.kind === 'source') return clip(a.quote?.exact || a.src?.text || '', max);
  if (a.svg || a.region) return '';
  return clip(a.element?.text || '', max);
}

/** Anchor-state chip, or null for a plain exact anchor. @param {Anchor|null} a */
export function anchorStateInfo(a) {
  if (!a) return null;
  switch (a.state) {
    case 'moved': return { key: 'moved', label: 'Moved', tone: 'info' };
    case 'changed': return { key: 'outdated', label: 'Outdated', tone: 'warn' };
    case 'orphaned': return { key: 'orphaned', label: 'Orphaned', tone: 'danger' };
    default: return a.generated ? { key: 'generated', label: 'Generated', tone: 'muted' } : null;
  }
}

/** @param {Thread} t @param {number|'live'|null} v */
export function isOutdated(t, v) {
  const a = anchorAt(t, v);
  return !!a && (a.state === 'changed' || a.state === 'orphaned');
}

/** Sort key in document order (doc-level anchors first, then by source offset / line). @param {Anchor|null} a */
export function docOrderKey(a) {
  if (!a) return Number.MAX_SAFE_INTEGER;
  if (a.kind === 'doc') return -1;
  if (Number.isFinite(a.src?.start)) return a.src.start;
  if (Number.isFinite(a.src?.startLine)) return a.src.startLine * 1000;
  return Number.MAX_SAFE_INTEGER - 1;
}

/** Numeric part of an id like 't12' (for stable ordering). @param {string} id */
export function idNumber(id) {
  const m = /(\d+)$/.exec(String(id));
  return m ? Number(m[1]) : 0;
}

// ------------------------------------------------------------------------------------------------ threads

/** @param {Thread} t */
export function lastAgentComment(t) {
  const cs = t?.comments || [];
  for (let i = cs.length - 1; i >= 0; i--) if (isAgent(cs[i].by)) return cs[i];
  return null;
}

/**
 * Status chip of a thread (design 11.5).
 * @param {Thread} t
 * @param {string} [agent]
 */
export function statusInfo(t, agent = 'claude') {
  switch (t?.status) {
    case 'addressed': {
      const c = lastAgentComment(t);
      return { key: 'addressed', label: c?.version ? `Addressed in v${c.version}` : 'Addressed', tone: 'ok' };
    }
    case 'answered': return { key: 'answered', label: 'Answered', tone: 'ok' };
    case 'declined': return { key: 'declined', label: 'Declined', tone: 'warn' };
    case 'needs_input': return { key: 'needs_input', label: 'Needs you', tone: 'attn', banner: `${agent} asked you` };
    case 'resolved': return { key: 'resolved', label: 'Resolved', tone: 'muted' };
    default: return { key: 'open', label: 'Open', tone: 'accent' };
  }
}

/** Reply drafts pending for a thread. @param {any} drafts Drafts @param {string} threadId */
export function replyDraftsFor(drafts, threadId) {
  return (drafts?.items || []).filter((/** @type {any} */ d) => d.kind === 'reply' && d.thread === threadId);
}

/**
 * Verify queue membership (design 8.8): addressed / answered / declined threads with no newer reviewer comment and
 * no pending reply draft.
 * @param {Thread} t
 * @param {any} drafts
 */
export function isVerifiable(t, drafts) {
  if (!['addressed', 'answered', 'declined'].includes(t?.status)) return false;
  if (replyDraftsFor(drafts, t.id).length) return false;
  const cs = t.comments || [];
  let lastAgent = -1;
  let lastHuman = -1;
  cs.forEach((/** @type {any} */ c, /** @type {number} */ i) => {
    if (isAgent(c.by)) lastAgent = i;
    else if (isHuman(c.by)) lastHuman = i;
  });
  return lastAgent > lastHuman;
}

export const FILTERS = Object.freeze([
  { key: 'open', label: 'Open' },
  { key: 'needs', label: 'Needs me' },
  { key: 'verify', label: 'Verify' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'outdated', label: 'Outdated' },
  { key: 'all', label: 'All' },
]);

/**
 * @param {Thread} t
 * @param {string} filter
 * @param {{ drafts: any, version: number|'live'|null }} ctx
 */
export function threadMatches(t, filter, ctx) {
  switch (filter) {
    case 'open': return t.status !== 'resolved';
    case 'needs': return t.status === 'needs_input';
    case 'verify': return isVerifiable(t, ctx.drafts);
    case 'drafts': return replyDraftsFor(ctx.drafts, t.id).length > 0;
    case 'resolved': return t.status === 'resolved';
    case 'outdated': return isOutdated(t, ctx.version);
    default: return true;
  }
}

/** New-thread drafts of the review being prepared. @param {any} drafts */
export function threadDrafts(drafts) {
  return (drafts?.items || []).filter((/** @type {any} */ d) => d.kind === 'thread');
}

/**
 * Items the thread panel lists for a filter, in document order (List layout, amendments 1). New-thread drafts are
 * listed with 'open', 'drafts' and 'all'.
 * @param {DocState} ds
 * @param {string} filter
 * @param {number|'live'|null} version
 * @returns {Array<{ kind: 'thread'|'draft', id: string, item: any, anchor: Anchor|null }>}
 */
export function panelItems(ds, filter, version) {
  if (!ds) return [];
  const ctx = { drafts: ds.drafts, version };
  /** @type {Array<{ kind: 'thread'|'draft', id: string, item: any, anchor: Anchor|null }>} */
  const out = [];
  for (const t of ds.threads || []) {
    if (threadMatches(t, filter, ctx)) out.push({ kind: 'thread', id: t.id, item: t, anchor: anchorAt(t, version) });
  }
  if (filter === 'open' || filter === 'drafts' || filter === 'all') {
    for (const d of threadDrafts(ds.drafts)) out.push({ kind: 'draft', id: d.id, item: d, anchor: d.anchor || null });
  }
  out.sort((a, b) => docOrderKey(a.anchor) - docOrderKey(b.anchor)
    || (a.kind === b.kind ? 0 : a.kind === 'thread' ? -1 : 1)
    || idNumber(a.id) - idNumber(b.id));
  return out;
}

/** Count per filter key. @param {DocState} ds @param {number|'live'|null} version @returns {Record<string, number>} */
export function filterCounts(ds, version) {
  /** @type {Record<string, number>} */
  const counts = {};
  const ctx = { drafts: ds?.drafts, version };
  const nDrafts = threadDrafts(ds?.drafts).length;
  for (const f of FILTERS) {
    let n = 0;
    for (const t of ds?.threads || []) if (threadMatches(t, f.key, ctx)) n++;
    if (f.key === 'open' || f.key === 'drafts' || f.key === 'all') n += nDrafts;
    counts[f.key] = n;
  }
  return counts;
}

/** All draft items (thread + reply + resolve). @param {DocState} ds */
export function draftCount(ds) {
  return (ds?.drafts?.items || []).length;
}

/** Open blocking threads (warn before approving). @param {DocState} ds */
export function blockingOpen(ds) {
  return (ds?.threads || []).filter((/** @type {any} */ t) => t.severity === 'blocking' && t.status !== 'resolved');
}

/**
 * The verdict the Submit dialog starts with: "Request changes" when the review carries a blocking comment (a
 * blocking new thread, or a reopen of a blocking thread), else "Comment".
 * @param {DocState} ds
 * @returns {'changes_requested'|'comment'}
 */
export function defaultVerdict(ds) {
  const threads = ds?.threads || [];
  const blocking = (ds?.drafts?.items || []).some((/** @type {any} */ d) => (d.kind === 'thread' && d.severity === 'blocking')
    || (d.kind === 'reply' && d.reopen && threads.some((/** @type {any} */ t) => t.id === d.thread && t.severity === 'blocking')));
  return blocking ? 'changes_requested' : 'comment';
}

/** Threads an Approve with "resolve addressed" would resolve. @param {DocState} ds */
export function addressedThreads(ds) {
  return (ds?.threads || []).filter((/** @type {any} */ t) => ['addressed', 'answered'].includes(t.status));
}

/** Locks not yet announced by a submitted review. @param {DocState} ds */
export function locksAddedThisRound(ds) {
  const announced = new Set();
  for (const r of ds?.reviews || []) for (const id of r.locksAdded || []) announced.add(id);
  return (ds?.locks || []).filter((/** @type {any} */ l) => l.active !== false && !announced.has(l.id));
}

// ------------------------------------------------------------------------------------------------ reviews, presence

/** Reviews sorted by submission time. @param {DocState} ds */
export function sortedReviews(ds) {
  return [...(ds?.reviews || [])].sort((a, b) => String(a.submittedAt || '').localeCompare(String(b.submittedAt || ''))
    || idNumber(a.id) - idNumber(b.id));
}

/** @param {DocState} ds */
export function latestReview(ds) {
  const r = sortedReviews(ds);
  return r.length ? r[r.length - 1] : null;
}

/** The version recorded in answer to a review, or null. @param {DocState} ds @param {any} review */
export function answeringVersion(ds, review) {
  if (!review) return null;
  const vs = (ds?.versions || []).filter((/** @type {any} */ v) => v.respondsTo === review.id);
  return vs.length ? vs[vs.length - 1] : null;
}

/** True when the agent replied on any thread after the review was submitted. @param {DocState} ds @param {any} review */
function agentRepliedSince(ds, review) {
  const since = String(review?.submittedAt || '');
  return (ds?.threads || []).some((/** @type {any} */ t) => (t.comments || [])
    .some((/** @type {any} */ c) => isAgent(c.by) && String(c.at || '') > since));
}

/**
 * Presence chip (design 11.7).
 * @param {DocState} ds
 * @returns {{ kind: 'editing'|'listening'|'revising'|'none', label: string, tone: string }}
 */
export function presenceInfo(ds) {
  const agent = agentName(ds);
  if (ds?.working?.dirty && !ds.working.missing) return { kind: 'editing', label: `${agent} is editing (unrecorded)`, tone: 'warn' };
  if (ds?.waiters?.length) return { kind: 'listening', label: `${agent} is listening`, tone: 'ok' };
  const last = latestReview(ds);
  if (last && Object.keys(last.deliveredTo || {}).length && !answeringVersion(ds, last) && !agentRepliedSince(ds, last)) {
    return { kind: 'revising', label: `${agent} is revising...`, tone: 'warn' };
  }
  return { kind: 'none', label: 'No agent listening', tone: 'muted' };
}

/**
 * Progress of the newest review: Submitted -> Delivered to claude 14:02 -> revising... -> v3 ready.
 * @param {DocState} ds
 * @returns {{ label: string, tone: string, stage: string }|null}
 */
export function reviewProgress(ds) {
  const r = latestReview(ds);
  if (!r) return null;
  const agent = agentName(ds);
  const answer = answeringVersion(ds, r);
  if (answer) return { label: `v${answer.v} ready`, tone: 'ok', stage: 'ready' };
  const delivered = Object.entries(r.deliveredTo || {});
  if (!delivered.length) return { label: `Submitted ${formatClock(r.submittedAt)}`.trim(), tone: 'muted', stage: 'submitted' };
  if (ds?.working?.dirty) return { label: `${agent} is revising...`, tone: 'warn', stage: 'revising' };
  const [name, at] = delivered[0];
  return { label: `Delivered to ${name} ${formatClock(String(at))}`.trim(), tone: 'info', stage: 'delivered' };
}

/**
 * "v3 ready - 3 addressed, 1 needs you" when the head version answers a review.
 * @param {DocState} ds
 */
export function roundSummary(ds) {
  const head = Number(ds?.doc?.head);
  const meta = versionMeta(ds, head);
  if (!meta || !meta.respondsTo) return null;
  const threads = ds.threads || [];
  const addressed = threads.filter((/** @type {any} */ t) => isVerifiable(t, ds.drafts)).length;
  const needs = threads.filter((/** @type {any} */ t) => t.status === 'needs_input').length;
  const parts = [];
  if (addressed) parts.push(`${addressed} addressed`);
  if (needs) parts.push(`${needs} needs you`);
  return { text: parts.length ? `v${head} ready - ${parts.join(', ')}` : `v${head} ready`, addressed, needs, version: head };
}

// ------------------------------------------------------------------------------------------------ changes

/**
 * The text of the doc's only level-1 heading, or null when the outline has none or several (then every H1 is a
 * real part of the breadcrumbs).
 * @param {any[]|null|undefined} outline [{ level, text }]
 * @returns {string|null}
 */
export function singleH1(outline) {
  const h1 = (outline || []).filter((h) => Number(h?.level) === 1);
  return h1.length === 1 ? normWs(h1[0].text) : null;
}

/**
 * Hunks grouped by their section (document order kept). The title is the last two headings of the chain; a leading
 * level-1 heading is dropped when it is the doc's only H1 (`opts.h1`, the title of the whole spec, which would
 * otherwise prefix every group: "1. Goals", not "Rate Limiter Spec › 1. Goals").
 * @param {any} changes
 * @param {{ h1?: string|null }} [opts]
 * @returns {Array<{ key: string, title: string, hunks: any[] }>}
 */
export function groupHunks(changes, opts = {}) {
  const h1 = opts.h1 ? normWs(opts.h1) : null;
  /** @type {Map<string, { key: string, title: string, hunks: any[] }>} */
  const groups = new Map();
  for (const h of changes?.hunks || []) {
    const chain = Array.isArray(h.section) ? h.section : [];
    const key = chain.join('\u0000');
    const shown = h1 && chain.length > 1 && normWs(chain[0]) === h1 ? chain.slice(1) : chain;
    const title = shown.length ? shown.slice(-2).join(' › ') : 'Top of document';
    if (!groups.has(key)) groups.set(key, { key, title, hunks: [] });
    groups.get(key)?.hunks.push(h);
  }
  return [...groups.values()];
}

/**
 * Old and new source text of one change hunk, from the source diff of the same comparison (GET .../diff/source:
 * display hunks whose changed rows carry the id of their line hunk, which is the change hunk's id).
 * @param {any} sourceDiff { hunks: [{ rows: [{ op: ' '|'-'|'+', text, hunk? }] }] }
 * @param {string} hunkId
 * @returns {{ old: string, new: string }|null}
 */
export function hunkSourceText(sourceDiff, hunkId) {
  /** @type {string[]} */
  const before = [];
  /** @type {string[]} */
  const after = [];
  for (const dh of sourceDiff?.hunks || []) {
    for (const r of dh.rows || []) {
      if (r.hunk !== hunkId) continue;
      if (r.op === '-') before.push(String(r.text ?? ''));
      else if (r.op === '+') after.push(String(r.text ?? ''));
    }
  }
  if (!before.length && !after.length) return null;
  return { old: before.join('\n'), new: after.join('\n') };
}

/**
 * Joins a run of changes separated only by spaces into one removed and one added part, so "~~all tiers~~ Pro and
 * Enterprise" reads as two phrases rather than word-by-word fragments. Whitespace between changes belongs to both
 * texts, so it goes into both parts (a removed part left with whitespace only is dropped).
 * @param {Array<{ op: string, text: string }>} parts
 * @returns {Array<{ op: string, text: string }>}
 */
export function coalesceWordParts(parts) {
  /** @type {Array<{ op: string, text: string }>} */
  const out = [];
  let i = 0;
  while (i < parts.length) {
    if (parts[i].op === 'eq') {
      out.push(parts[i]);
      i++;
      continue;
    }
    let del = '';
    let ins = '';
    let j = i;
    for (; j < parts.length; j++) {
      const p = parts[j];
      if (p.op === 'del') del += p.text;
      else if (p.op === 'ins') ins += p.text;
      else if (/^[ \t]+$/.test(p.text) && j + 1 < parts.length && parts[j + 1].op !== 'eq') {
        del += p.text;
        ins += p.text;
      } else break;
    }
    // Whitespace both sides end with is unchanged text: "~~all tiers~~ Pro and Enterprise within".
    const tail = /\s*$/.exec(del)?.[0] || '';
    const common = tail && ins.endsWith(tail) && del.trim() && ins.trim() ? tail : '';
    if (common) {
      del = del.slice(0, -common.length);
      ins = ins.slice(0, -common.length);
    }
    if (del.trim()) out.push({ op: 'del', text: del });
    if (ins.trim() || (ins && !del.trim())) out.push({ op: 'ins', text: ins });
    if (common) out.push({ op: 'eq', text: common });
    i = j;
  }
  return out;
}

/**
 * Shortens the unchanged runs of a word diff so the change stays readable: the run before the first change keeps
 * its last `keep` characters of the same line, the run after the last change its first `keep` characters, and a
 * long run between changes keeps both ends around a gap. Shortened ends get an 'gap' part ('…').
 * @param {Array<{ op: string, text: string }>} parts
 * @param {number} [keep]
 * @returns {Array<{ op: string, text: string }>}
 */
export function trimDiffContext(parts, keep = 60) {
  const changed = parts.map((p, i) => (p.op === 'eq' ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return parts;
  const first = changed[0];
  const last = changed[changed.length - 1];
  /** @type {Array<{ op: string, text: string }>} */
  const out = [];
  parts.forEach((p, i) => {
    if (p.op !== 'eq') {
      out.push(p);
      return;
    }
    if (i < first) {
      const line = p.text.slice(p.text.lastIndexOf('\n') + 1);
      const tail = line.length > keep ? line.slice(line.length - keep).replace(/^\S*\s/, '') : line;
      if (tail.length < p.text.length) out.push({ op: 'gap', text: '…' });
      if (tail) out.push({ op: 'eq', text: tail });
    } else if (i > last) {
      const nl = p.text.indexOf('\n');
      const line = nl >= 0 ? p.text.slice(0, nl) : p.text;
      const head = line.length > keep ? line.slice(0, keep).replace(/\s\S*$/, '') : line;
      if (head) out.push({ op: 'eq', text: head });
      if (head.length < p.text.length) out.push({ op: 'gap', text: '…' });
    } else if (p.text.length > keep * 3) {
      out.push({ op: 'eq', text: p.text.slice(0, keep).replace(/\s\S*$/, ' ') });
      out.push({ op: 'gap', text: '…' });
      out.push({ op: 'eq', text: p.text.slice(p.text.length - keep).replace(/^\S*\s/, ' ') });
    } else {
      out.push(p);
    }
  });
  return out;
}

/**
 * Splits diff parts into display lines at '\n' (each line a list of parts; empty parts dropped).
 * @param {Array<{ op: string, text: string }>} parts
 * @returns {Array<Array<{ op: string, text: string }>>}
 */
export function diffLines(parts) {
  /** @type {Array<Array<{ op: string, text: string }>>} */
  const lines = [[]];
  for (const p of parts) {
    const pieces = String(p.text).split('\n');
    pieces.forEach((text, i) => {
      if (i > 0) lines.push([]);
      if (text) lines[lines.length - 1].push({ op: p.op, text });
    });
  }
  while (lines.length > 1 && !lines[lines.length - 1].length) lines.pop();
  return lines;
}

/** Short text of what a hunk changed. @param {any} h */
export function hunkPreview(h) {
  const ins = (h?.words || []).map((/** @type {any} */ w) => w.quote).filter(Boolean).join(' … ');
  if (h?.op === 'del') return { ins: '', del: clip(h.deleted?.text || '', 160) };
  return { ins: clip(ins, 160), del: h?.op === 'mod' ? clip(h.deleted?.text || '', 120) : '' };
}

/** Line label of a hunk in the new version ('L42-46', or 'after L41' for deletions). @param {any} h */
export function hunkLines(h) {
  if (!h) return '';
  if (h.op === 'del') return `removed L${h.old?.start}${h.old?.lines > 1 ? `-${h.old.start + h.old.lines - 1}` : ''}`;
  const s = h.new?.start;
  const n = h.new?.lines || 0;
  return n > 1 ? `L${s}-${s + n - 1}` : `L${s}`;
}

/**
 * Agent replies in versions (from, to]: the Changes "Round results" list.
 * @param {DocState} ds
 * @param {number|null} from
 * @param {number} to
 */
export function roundResults(ds, from, to) {
  /** @type {Array<{ thread: any, comment: any }>} */
  const out = [];
  for (const t of ds?.threads || []) {
    const cs = (t.comments || []).filter((/** @type {any} */ c) => isAgent(c.by)
      && Number(c.version) > Number(from ?? 0) && Number(c.version) <= Number(to));
    if (cs.length) out.push({ thread: t, comment: cs[cs.length - 1] });
  }
  return out.sort((a, b) => idNumber(a.thread.id) - idNumber(b.thread.id));
}

// ------------------------------------------------------------------------------------------------ outline

/**
 * Badges per outline heading: open threads, changed (~) / added (+) hunks and locks (matched by the last element
 * of each item's heading chain).
 * @param {any[]} outline [{srid, level, text}]
 * @param {DocState} ds
 * @param {any} changes
 * @param {number|'live'|null} version
 * @returns {Map<number, { open: number, changed: boolean, added: boolean, locked: boolean }>}
 */
export function headingBadges(outline, ds, changes, version) {
  /** @type {Map<string, number[]>} */
  const byText = new Map();
  for (const h of outline || []) {
    const k = normWs(h.text);
    if (!byText.has(k)) byText.set(k, []);
    byText.get(k)?.push(h.srid);
  }
  /** @type {Map<number, { open: number, changed: boolean, added: boolean, locked: boolean }>} */
  const out = new Map();
  /** @param {unknown} section */
  const slot = (section) => {
    const srids = byText.get(normWs(sectionTail(section)));
    if (!srids) return null;
    const srid = srids[0];
    if (!out.has(srid)) out.set(srid, { open: 0, changed: false, added: false, locked: false });
    return out.get(srid) || null;
  };
  for (const t of ds?.threads || []) {
    if (t.status === 'resolved') continue;
    const s = slot(anchorAt(t, version)?.section);
    if (s) s.open++;
  }
  for (const h of changes?.hunks || []) {
    const s = slot(h.section);
    if (!s) continue;
    if (h.op === 'add') s.added = true;
    else s.changed = true;
  }
  for (const l of ds?.locks || []) {
    if (l.active === false) continue;
    const a = anchorAt(l, version);
    const s = slot(a?.section);
    if (s) s.locked = true;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ history

/**
 * Versions and reviews interleaved, newest first (design 8.9).
 * @param {DocState} ds
 * @returns {Array<{ kind: 'version', at: string, v: number, meta: any } | { kind: 'review', at: string, review: any }>}
 */
export function timeline(ds) {
  /** @type {any[]} */
  const items = [];
  for (const meta of ds?.versions || []) items.push({ kind: 'version', at: String(meta.createdAt || ''), v: Number(meta.v), meta });
  for (const review of ds?.reviews || []) items.push({ kind: 'review', at: String(review.submittedAt || ''), review });
  items.sort((a, b) => b.at.localeCompare(a.at)
    || (a.kind === b.kind ? (a.kind === 'version' ? b.v - a.v : idNumber(b.review.id) - idNumber(a.review.id))
      : a.kind === 'version' ? -1 : 1));
  return items;
}

/** Threads linked to a version (thread.changes entries). @param {DocState} ds @param {number} v */
export function threadsOfVersion(ds, v) {
  return (ds?.threads || []).filter((/** @type {any} */ t) => (t.changes || []).some((/** @type {any} */ c) => Number(c.version) === Number(v)))
    .map((/** @type {any} */ t) => t.id);
}

// ------------------------------------------------------------------------------------------------ composer

/**
 * The composer's anchor chip: "L42-43 §3.2 Token refresh 'rotated on every use'".
 * @param {any} preview {label, lines, section, src}
 * @param {any} [anchor]
 */
export function anchorChipParts(preview, anchor) {
  const lines = linesLabel(preview?.lines ?? (anchor?.src ? [anchor.src.startLine, anchor.src.endLine] : null));
  const section = sectionTail(preview?.section ?? anchor?.section);
  const label = preview?.label || targetLabel(anchor);
  return { lines, section: section ? `§${section}` : '', label: clip(label, 90) };
}

/**
 * Suggestion editor mode (design 11.4): text mode when the anchor's source slice equals the rendered quote modulo
 * whitespace, otherwise source mode (whole lines).
 * @param {Anchor|null} a
 * @returns {'text'|'source'}
 */
export function suggestionMode(a) {
  if (!a || a.kind !== 'text' || !a.src || !a.quote) return 'source';
  return normWs(a.src.text) === normWs(a.quote.exact) && normWs(a.src.text) !== '' ? 'text' : 'source';
}

/**
 * Offset of the anchor's start within its first source line (best effort; the server re-derives the slice from the
 * line numbers for source-mode suggestions).
 * @param {Anchor} a
 * @param {string} firstLine
 */
export function anchorColumn(a, firstLine) {
  const prefix = String(a?.src?.prefix || '');
  const pre = prefix.slice(prefix.lastIndexOf('\n') + 1);
  const head = String(a?.src?.text || '').split('\n')[0];
  const both = firstLine.indexOf(pre + head);
  if (both >= 0) return both + pre.length;
  const only = firstLine.indexOf(head);
  return only >= 0 ? only : 0;
}

// ------------------------------------------------------------------------------------------------ unsaved input

/**
 * Whether an open composer holds input the reviewer would lose if it were replaced or closed: a comment, an edited
 * suggestion (also one restored from a backup that is waiting for the suggestion editor), attachments, or a lock
 * note. The capture itself and the automatic crop of a pick are not input.
 * @param {any} comp Composer (state.js)
 */
export function isComposerDirty(comp) {
  if (!comp) return false;
  if (String(comp.body ?? '').trim()) return true;
  const s = comp.suggestion;
  if (s && !s.loading && s.new !== s.old) return true;
  const p = comp.pendingSuggestion;
  if (p && p.new !== p.old) return true;
  if (Array.isArray(comp.attachments) && comp.attachments.length) return true;
  return !!String(comp.note ?? '').trim();
}

/**
 * Whether a stored composer backup (localStorage) holds input worth restoring (same rules as isComposerDirty).
 * @param {any} b
 */
export function backupHasInput(b) {
  if (!b || typeof b !== 'object') return false;
  if (String(b.body ?? '').trim() || String(b.note ?? '').trim()) return true;
  if (Array.isArray(b.attachments) && b.attachments.length) return true;
  return !!(b.suggestion && typeof b.suggestion.new === 'string' && b.suggestion.new !== b.suggestion.old);
}

/**
 * Whether an open reply box holds text that is not saved: a new reply with text, or edits to its reply draft.
 * @param {{ body: string, reopen: boolean, draftId: string|null }|null} reply
 * @param {any} drafts Drafts
 */
export function isReplyDirty(reply, drafts) {
  if (!reply || !String(reply.body ?? '').trim()) return false;
  if (!reply.draftId) return true;
  const d = (drafts?.items || []).find((/** @type {any} */ x) => x.id === reply.draftId);
  return !d || String(d.body ?? '') !== String(reply.body) || !!d.reopen !== !!reply.reopen;
}

/**
 * The version a draft was made on (its anchor's version).
 * @param {any} d DraftItem
 * @returns {number|null}
 */
export function draftVersion(d) {
  const v = Number(d?.anchor?.v ?? d?.version);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Why Approve cannot go out for the version on screen, or null. The daemon marks its head final, so a newer version
 * than the one reviewed must be looked at first.
 * @param {DocState} ds
 * @param {number} reviewed the version on screen
 * @returns {string|null}
 */
export function staleApproveText(ds, reviewed) {
  const head = Number(ds?.doc?.head) || 0;
  if (!head || head === reviewed) return null;
  return head > reviewed
    ? `v${head} arrived while you were reviewing v${reviewed}. Review v${head} before approving.`
    : `You are viewing v${reviewed}, but the latest version is v${head}.`;
}

/**
 * Message for a failed "Apply now". Only a dirty working copy (the daemon's 409 CONFLICT) gets the "record first"
 * advice; every other refusal (already applied, lost anchor, suggested text not found) is reported as the daemon
 * words it.
 * @param {string} id thread id
 * @param {any} err ApiError ({ status, message, body: { error, code } })
 */
export function applyErrorText(id, err) {
  const message = String(err?.message || err || 'Unknown error');
  const code = err?.body?.code;
  const dirty = err?.status === 409 && (code === 'CONFLICT' || (!code && /unrecorded|dirty/i.test(message)));
  return dirty ? 'The working copy has unrecorded changes. Record them first, then apply.' : `Could not apply ${id}: ${message}`;
}
