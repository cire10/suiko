// @ts-check
// Pure, import-free helpers that derive what the UI shows from DocState (design 5.3 / 10.2 shapes): the thread
// card's one status chip and whose turn a thread is (turnReason), the panel filters (Your turn, the agent's, Done,
// All), what to check, the planned changes an Apply sends (applicablePlanned), document order, presence and review
// progress, the header's turn pill ("whose turn is it?") and problems chip, what an approval would leave pending
// (approveWarnings), the composer's "Claude will see" line, long documents and the review's `edits`, agent
// attachments, changes grouping, outline badges and the history timeline; plus shortcut labels and key-combo
// classification
// (app-level Cmd/Ctrl combos, single-character keys) and the command palette's fuzzy search. No DOM and no store
// access, so the same functions run in the browser and in Node tests.

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

/**
 * A Markdown body's text for a one-line preview: no bold markers, no list markers.
 * @param {unknown} s
 */
export function plainBody(s) {
  return String(s ?? '').replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/gm, '').replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1');
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

// ------------------------------------------------------------------------------------------------ doc kinds and modes

/** The doc's kind: 'file' (a spec on disk; doc.json has no kind), 'snapshot' or 'code'. @param {DocState} ds */
export function docKindOf(ds) {
  const k = ds?.doc?.kind;
  return k === 'code' || k === 'snapshot' ? k : 'file';
}

/** A plan from Claude Code's plan mode (`suiko plan-gate`): a snapshot doc of origin 'plan'. @param {DocState} ds */
export function isPlanDoc(ds) {
  return docKindOf(ds) === 'snapshot' && ds?.doc?.origin?.type === 'plan';
}

/**
 * The send mode in effect (Settings > Send comments): the setting, except on a plan (isPlanDoc), where comments are
 * always collected until the reviewer sends them together ('batch'). The plan gate answers ExitPlanMode with the first
 * review it gets, and the agent cannot reply on threads while it waits there, so a comment sent alone would end the
 * plan review and cost a plan revision per comment. "Send now" in the composer still sends one on purpose.
 * @param {{ prefs?: { sendMode?: string }, ds?: DocState }} s
 * @returns {'now'|'batch'}
 */
export function sendModeOf(s) {
  return isPlanDoc(s?.ds) || s?.prefs?.sendMode === 'batch' ? 'batch' : 'now';
}

/**
 * What the doc view offers for a kind (design 2.14), read by the components and actions that depend on the rendered
 * doc frame: frame (the doc iframe and its guest), pick / snip / hide (the guest tools), pageErrors (the problems
 * chip's script errors and failed resources), applyNow (the reviewer applies a suggestion to the file: not for
 * snapshots, whose agent applies them when it revises), liveBanners (the working-copy and lost-frame banners), locks
 * ("Mark agreed").
 * A code review has no frame: its view renders diffs as text nodes (src/ui/components/kinds/CodeReviewView.js).
 * @param {DocState} ds
 * @returns {{ frame: boolean, pick: boolean, snip: boolean, hide: boolean, pageErrors: boolean, applyNow: boolean,
 *   liveBanners: boolean, locks: boolean }}
 */
export function kindCaps(ds) {
  const kind = docKindOf(ds);
  if (kind === 'code') {
    return { frame: false, pick: false, snip: false, hide: false, pageErrors: false, applyNow: true, liveBanners: false, locks: false };
  }
  // a snapshot's suggestions are applied by its agent when it revises: no "Apply now"
  const applyNow = ds?.doc?.kind !== 'snapshot';
  return { frame: true, pick: true, snip: true, hide: true, pageErrors: true, applyNow, liveBanners: true, locks: true };
}

/**
 * @typedef {{ key: 'read'|'review'|'changes'|'source'|'history', label: string, n: number, description: string }} ModeInfo
 *   n: its number key (stable per mode key across kinds)
 */

/** @type {readonly ModeInfo[]} */
const FILE_MODES = Object.freeze([
  { key: 'read', label: 'Read', n: 0, description: 'The latest version as its readers see it: no highlights, change marks or threads' },
  { key: 'review', label: 'Review', n: 1, description: 'Comment on the rendered document, with your threads highlighted' },
  { key: 'changes', label: 'Changes', n: 2, description: 'What changed since your last review, marked in the document' },
  { key: 'source', label: 'Source', n: 3, description: 'The source with line numbers and its diff' },
  { key: 'history', label: 'History', n: 4, description: 'Versions and reviews, newest first' },
]);

/** @type {readonly ModeInfo[]} */
const CODE_MODES = Object.freeze([
  { key: 'review', label: 'Files', n: 1, description: 'The changed files of the review, as diffs' },
  { key: 'changes', label: 'Changes', n: 2, description: 'What changed in the files since your last review' },
  { key: 'history', label: 'History', n: 4, description: 'Rounds and reviews, newest first' },
]);

/**
 * The modes (tabs) of a doc, in order. A code review reuses the mode key 'review' for its file diffs (labelled
 * "Files") and has no Source mode.
 * @param {DocState} ds
 * @returns {readonly ModeInfo[]}
 */
export function modesFor(ds) {
  return docKindOf(ds) === 'code' ? CODE_MODES : FILE_MODES;
}

/** Whether the doc offers a mode. @param {DocState} ds @param {string} mode */
export function hasMode(ds, mode) {
  return modesFor(ds).some((m) => m.key === mode);
}

/**
 * Whether a mode shows the rendered doc (Read, Review, Changes), where text can be selected, picked or snipped;
 * Source and History hide it.
 * @param {string} mode
 */
export function showsDoc(mode) {
  return mode === 'read' || mode === 'review' || mode === 'changes';
}

/**
 * The mode a doc opens in (Settings: Default view). 'read' and 'review' as chosen (a code review has no Read: it
 * opens on its files); 'auto': Changes when the agent revised the doc since the reviewer's last review or acceptance,
 * else Review.
 * @param {DocState} ds
 * @param {'auto'|'read'|'review'} pref
 * @returns {'read'|'review'|'changes'}
 */
export function openingMode(ds, pref) {
  if (pref === 'read' || pref === 'review') return plainMode(ds, pref);
  const head = Number(ds?.doc?.head) || 1;
  const since = reviewedThrough(ds);
  return since != null && head > since ? 'changes' : 'review';
}

/**
 * The mode without change marks that the reviewer prefers (Settings: Default view): Read when they chose it, else
 * Review. Turning "Show changes" off goes there when the doc was opened on its changes.
 * @param {DocState} ds
 * @param {'auto'|'read'|'review'} pref
 * @returns {'read'|'review'}
 */
export function plainMode(ds, pref) {
  return pref === 'read' && hasMode(ds, 'read') ? 'read' : 'review';
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
 * Where "since your last review" starts: the newer of the version the reviewer last submitted a review on and the
 * version whose revisions they accepted all at once (Accept all revisions). Null before either.
 * @param {DocState} ds
 * @returns {number|null}
 */
export function reviewedThrough(ds) {
  const last = Number(ds?.doc?.lastReviewedVersion);
  const accepted = Number(ds?.doc?.acceptedVersion);
  const v = Math.max(last >= 1 ? last : 0, accepted >= 1 ? accepted : 0);
  return v >= 1 ? v : null;
}

/**
 * What a version is to the reviewer, for the comparison labels: 'review' (their last review), 'accepted' (the
 * revisions they accepted, when newer than that review), or null.
 * @param {DocState} ds
 * @param {number|null} v
 * @returns {'review'|'accepted'|null}
 */
export function baseTag(ds, v) {
  if (v == null) return null;
  const last = Number(ds?.doc?.lastReviewedVersion);
  const accepted = Number(ds?.doc?.acceptedVersion);
  if (accepted >= 1 && v === accepted && !(last >= accepted)) return 'accepted';
  return last >= 1 && v === last ? 'review' : null;
}

/**
 * The revisions "Accept all revisions" accepts: those of the newest version, when it is newer than the reviewer's
 * last review and acceptance (`since`, null before either). Null when there is nothing new (or only v1).
 * @param {DocState} ds
 * @returns {{ version: number, since: number|null }|null}
 */
export function revisionsToAccept(ds) {
  const head = Number(ds?.doc?.head) || 0;
  if (head < 2) return null;
  const since = reviewedThrough(ds);
  return since != null && since >= head ? null : { version: head, since };
}

/**
 * Default Changes base: 'last' = where "since your last review" starts (reviewedThrough) if older than the shown
 * version, else the previous version; 'prev' = the previous version. Null when there is nothing to compare (v1).
 * @param {DocState} ds
 * @param {number|'live'|null} version
 * @param {'last'|'prev'|'custom'} kind
 * @returns {number|null}
 */
export function defaultBase(ds, version, kind) {
  const head = Number(ds?.doc?.head) || 1;
  const last = reviewedThrough(ds) ?? 0;
  if (version === 'live') return kind === 'last' && last >= 1 && last <= head ? last : head;
  const v = Number(version ?? head);
  if (kind === 'last' && last >= 1 && last < v) return last;
  return v > 1 ? v - 1 : null;
}

/** Over this many visible text characters (or, without that count, source lines) a doc is long: batched edits. */
export const LONG_DOC = Object.freeze({ chars: 20000, lines: 800 });

/**
 * The size of the doc's latest version, as DocState.versions records it: `textChars` (the visible text, absent on old
 * versions and code rounds) and `lines` (source lines). long: over LONG_DOC (characters when counted, else lines).
 * @param {DocState} ds
 * @returns {{ long: boolean, chars: number|null, lines: number|null }}
 */
export function docSize(ds) {
  const meta = versionMeta(ds, Number(ds?.doc?.head));
  const chars = meta && meta.textChars != null && Number.isFinite(Number(meta.textChars)) ? Number(meta.textChars) : null;
  const lines = meta && meta.lines != null && Number.isFinite(Number(meta.lines)) ? Number(meta.lines) : null;
  const long = chars != null ? chars > LONG_DOC.chars : lines != null && lines > LONG_DOC.lines;
  return { long, chars, lines };
}

/** Whether the doc is long (docSize): its edits are batched with the Auto setting. @param {DocState} ds */
export function isLongDoc(ds) {
  return docSize(ds).long;
}

/**
 * The `edits` every review the UI sends carries (Settings > Doc edits): 'now' (the agent edits the doc for each
 * review) or 'batch' (it answers now, plans the edits, and makes them in one pass when the reviewer applies them).
 * 'auto' batches on long docs (isLongDoc).
 * @param {DocState} ds
 * @param {{ editMode?: string }|null|undefined} prefs
 * @returns {'now'|'batch'}
 */
export function reviewEdits(ds, prefs) {
  const mode = prefs?.editMode;
  if (mode === 'now' || mode === 'batch') return mode;
  return isLongDoc(ds) ? 'batch' : 'now';
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
  // code reviews: 'src/a.js:L3-4', 'src/a.js (old side) L3-4', 'src/a.js (whole file)'
  if (a.file?.path) {
    const lines = a.kind === 'doc' ? '' : linesLabel(a.src);
    if (!lines) return `${a.file.path} (whole file)`;
    return a.file.side === 'old' ? `${a.file.path} (old side) ${lines}` : `${a.file.path}:${lines}`;
  }
  if (a.kind === 'doc') return 'General comment';
  if (a.kind === 'section') return `§ ${sectionTail(a.section) || 'section'}`;
  if (a.kind === 'source') return linesLabel(a.src) || 'source lines';
  if (a.kind === 'snip') return snipTargetLabel(a);
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

/**
 * Label of a snip anchor (a box dragged over the doc with `b`): the guest's label ('area over "2. Request flow"
 * (figure + 2 paragraphs)'), else what the box covers.
 * @param {Anchor} a
 */
function snipTargetLabel(a) {
  const s = a.snip || {};
  if (s.label) return clip(s.label, 90);
  return s.covers ? `snip (${clip(s.covers, 60)})` : 'snipped area';
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
 * row), the visible text inside a snip's box. Empty for doc and section anchors, diagrams, regions and elements
 * without text (images).
 * @param {Anchor|null} a
 * @param {number} [max]
 */
export function anchorQuote(a, max = 120) {
  if (!a || a.kind === 'doc' || a.kind === 'section') return '';
  if (a.kind === 'snip') return clip(a.snip?.text || '', max);
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

/** Code anchors: compares their file paths ('' for anchors without a file). @param {Anchor|null} a @param {Anchor|null} b */
function fileOrder(a, b) {
  const fa = String(a?.file?.path ?? '');
  const fb = String(b?.file?.path ?? '');
  return fa === fb ? 0 : fa < fb ? -1 : 1;
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
 * The one status chip of a thread card, in plain words that say whose turn it is (calm review vocabulary; the agent's
 * name where "Claude" appears): open "With Claude", planned "Will change", answered "Claude answered", addressed
 * "Changed in v3 — check it" while the reviewer has to check it (isVerifiable) else "Changed in v3", declined "Claude
 * didn't change it", needs_input "Needs your answer" (with the banner "Claude asked you"), resolved "Done"; an answer
 * the reviewer has replied to since is "With Claude" again. An unresolved thread whose anchor lost its place in the
 * version shown (turnReason 'lost', which needs `ctx`) says "Lost its place" instead. `key` is the status, or 'lost';
 * `title` explains a chip that needs it.
 * @param {Thread} t
 * @param {string} [agent]
 * @param {{ drafts: any, version: number|'live'|null }|null} [ctx] the drafts and the version shown
 * @returns {{ key: string, label: string, tone: string, banner?: string, title?: string }}
 */
export function statusInfo(t, agent = 'claude', ctx = null) {
  const name = agentTitle(agent);
  if (ctx && turnReason(t, ctx) === 'lost') {
    return { key: 'lost', label: 'Lost its place', tone: 'warn', title: 'The text this thread was on changed or was removed in this version' };
  }
  // The agent answered, then the reviewer replied (sent): the agent has the last word to say again.
  if (['addressed', 'answered', 'declined', 'needs_input'].includes(t?.status) && reviewerSpokeLast(t)) {
    return { key: t.status, label: `With ${name}`, tone: 'accent', title: `You replied; ${name} answers on this thread` };
  }
  switch (t?.status) {
    case 'addressed': {
      const c = lastAgentComment(t);
      const changed = c?.version ? `Changed in v${c.version}` : 'Changed';
      return isVerifiable(t, ctx ? ctx.drafts : null)
        ? { key: 'addressed', label: `${changed} — check it`, tone: 'ok', title: `${name} changed the document for this thread: check the change` }
        : { key: 'addressed', label: changed, tone: 'ok' };
    }
    case 'answered': return { key: 'answered', label: `${name} answered`, tone: 'ok' };
    case 'declined': return { key: 'declined', label: `${name} didn't change it`, tone: 'warn' };
    case 'needs_input': return { key: 'needs_input', label: 'Needs your answer', tone: 'attn', banner: `${name} asked you` };
    case 'planned': {
      return { key: 'planned', label: 'Will change', tone: 'info', title: `${name} agreed and will make this change when you apply planned changes` };
    }
    case 'resolved': return { key: 'resolved', label: 'Done', tone: 'muted' };
    default: return { key: 'open', label: `With ${name}`, tone: 'accent' };
  }
}

/**
 * Whether the reviewer wrote the newest comment of a thread (a reply they sent after the agent's last word).
 * @param {Thread} t
 */
export function reviewerSpokeLast(t) {
  const cs = t?.comments || [];
  for (let i = cs.length - 1; i >= 0; i--) {
    if (isHuman(cs[i].by)) return true;
    if (isAgent(cs[i].by)) return false;
  }
  return false;
}

/** Reply drafts pending for a thread. @param {any} drafts Drafts @param {string} threadId */
export function replyDraftsFor(drafts, threadId) {
  return (drafts?.items || []).filter((/** @type {any} */ d) => d.kind === 'reply' && d.thread === threadId);
}

/**
 * What the reviewer has to check (design 8.8; formerly the Verify queue): addressed / answered / declined threads with
 * no newer reviewer comment and no pending reply draft.
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

/**
 * Why a thread waits for the reviewer ("your turn", Gerrit's attention set), or null when it does not: 'pending' (a
 * reply or resolve of the review being prepared is on it), 'answer' (the agent asked, needs_input, and the reviewer
 * has not answered yet), 'check' (the agent changed or answered it and spoke last: isVerifiable), 'lost'
 * (unresolved, and its anchor lost its place in the version shown), in that order. The one rule behind the turn pill's count (myTurn) and the thread panel's "Your
 * turn" filter, so the two can never differ. A thread with no reason and not resolved waits for the agent.
 * @param {Thread} t
 * @param {{ drafts: any, version: number|'live'|null }} ctx
 * @returns {'pending'|'answer'|'check'|'lost'|null}
 */
export function turnReason(t, ctx) {
  const items = ctx?.drafts?.items || [];
  if (items.some((/** @type {any} */ d) => d.kind !== 'thread' && d.thread === t?.id)) return 'pending';
  // the agent's question, until the reviewer has answered it
  if (t?.status === 'needs_input' && !reviewerSpokeLast(t)) return 'answer';
  if (isVerifiable(t, ctx?.drafts)) return 'check';
  if (t?.status !== 'resolved' && isOutdated(t, ctx?.version ?? null)) return 'lost';
  return null;
}

/**
 * The thread panel's filters (a segmented control): 'mine' "Your turn" (new-thread drafts and every thread with a
 * turnReason), 'agent' (the agent's name, "Claude": unresolved threads with no turnReason, and every planned thread,
 * listed first), 'done' "Done" (resolved), 'all'. Every unresolved thread is in exactly one of mine / agent, except a
 * planned thread that also waits for the reviewer (a reply not sent yet, a lost anchor): it is in both, so the
 * agent's "Planned changes" always lists what Apply sends (applicablePlanned). The 'agent' label is a placeholder:
 * filterLabel names the agent.
 */
export const FILTERS = Object.freeze([
  { key: 'mine', label: 'Your turn' },
  { key: 'agent', label: 'Claude' },
  { key: 'done', label: 'Done' },
  { key: 'all', label: 'All' },
]);

/** @typedef {'mine'|'agent'|'done'|'all'} FilterKey */

/** Filter keys of earlier versions (palette commands, keys, saved state, old call sites) and the filter they are now. */
const LEGACY_FILTERS = /** @type {Record<string, FilterKey>} */ ({
  needs: 'mine', verify: 'mine', drafts: 'mine', outdated: 'mine', open: 'agent', resolved: 'done',
});

/**
 * A filter key as the panel knows it: the current keys as they are, an earlier one mapped (needs / verify / drafts /
 * outdated -> mine, open -> agent, resolved -> done), anything else the default filter of the doc (defaultFilter;
 * 'all' without a doc).
 * @param {unknown} key
 * @param {DocState} [ds]
 * @param {number|'live'|null} [version]
 * @returns {FilterKey}
 */
export function normalizeFilter(key, ds = null, version = null) {
  const k = String(key ?? '');
  if (FILTERS.some((f) => f.key === k)) return /** @type {FilterKey} */ (k);
  if (Object.hasOwn(LEGACY_FILTERS, k)) return LEGACY_FILTERS[k];
  return ds ? defaultFilter(ds, version) : 'all';
}

/**
 * The filter the panel shows while the reviewer has not picked one for this doc: Your turn when something waits for
 * them, else the agent's when something waits for it, else All.
 * @param {DocState} ds
 * @param {number|'live'|null} version
 * @returns {FilterKey}
 */
export function defaultFilter(ds, version) {
  const counts = filterCounts(ds, version);
  if (counts.mine) return 'mine';
  if (counts.agent) return 'agent';
  return 'all';
}

/** A filter's label: the agent's name for 'agent' ("Claude"). @param {string} key @param {string} [agent] */
export function filterLabel(key, agent = 'claude') {
  if (key === 'agent') return agentTitle(agent);
  return FILTERS.find((f) => f.key === key)?.label ?? key;
}

/**
 * @param {Thread} t
 * @param {string} filter a filter key (an earlier one is mapped: normalizeFilter)
 * @param {{ drafts: any, version: number|'live'|null }} ctx
 */
export function threadMatches(t, filter, ctx) {
  switch (normalizeFilter(filter)) {
    case 'mine': return turnReason(t, ctx) != null;
    case 'agent': return t.status === 'planned' || (t.status !== 'resolved' && turnReason(t, ctx) == null);
    case 'done': return t.status === 'resolved';
    default: return true;
  }
}

/** New-thread drafts of the review being prepared. @param {any} drafts */
export function threadDrafts(drafts) {
  return (drafts?.items || []).filter((/** @type {any} */ d) => d.kind === 'thread');
}

/**
 * Items the thread panel lists for a filter, in document order (List layout, amendments 1). New-thread drafts are
 * listed with 'mine' (Your turn) and 'all'. `keep`, the threads with input open on their card (the reply box, a
 * "Record as decision…" being typed: actions.js keptThreads), is listed whatever the filter, so the text being typed
 * never disappears with its card (the agent answered it, or it was accepted in another tab, say).
 * @param {DocState} ds
 * @param {string} filter a filter key (an earlier one is mapped: normalizeFilter)
 * @param {number|'live'|null} version
 * @param {string|null|Array<string|null|undefined>} [keep] a thread id or a list of them
 * @returns {Array<{ kind: 'thread'|'draft', id: string, item: any, anchor: Anchor|null }>}
 */
export function panelItems(ds, filter, version, keep = null) {
  if (!ds) return [];
  const key = normalizeFilter(filter, ds, version);
  const ctx = { drafts: ds.drafts, version };
  const kept = new Set((Array.isArray(keep) ? keep : [keep]).filter(Boolean));
  /** @type {Array<{ kind: 'thread'|'draft', id: string, item: any, anchor: Anchor|null }>} */
  const out = [];
  for (const t of ds.threads || []) {
    if (kept.has(t.id) || threadMatches(t, key, ctx)) out.push({ kind: 'thread', id: t.id, item: t, anchor: anchorAt(t, version) });
  }
  if (key === 'mine' || key === 'all') {
    for (const d of threadDrafts(ds.drafts)) out.push({ kind: 'draft', id: d.id, item: d, anchor: d.anchor || null });
  }
  // code reviews: by file first (whole-review threads, which have no file, come first)
  out.sort((a, b) => fileOrder(a.anchor, b.anchor)
    || docOrderKey(a.anchor) - docOrderKey(b.anchor)
    || (a.kind === b.kind ? 0 : a.kind === 'thread' ? -1 : 1)
    || idNumber(a.id) - idNumber(b.id));
  return out;
}

/**
 * Count per filter key (new-thread drafts count with Your turn and All), the number of cards each filter lists. `mine`
 * always equals the turn pill's count (myTurn): both come from turnReason.
 * @param {DocState} ds @param {number|'live'|null} version @returns {Record<string, number>}
 */
export function filterCounts(ds, version) {
  /** @type {Record<string, number>} */
  const counts = {};
  const ctx = { drafts: ds?.drafts, version };
  const nDrafts = threadDrafts(ds?.drafts).length;
  for (const f of FILTERS) {
    let n = 0;
    for (const t of ds?.threads || []) if (threadMatches(t, f.key, ctx)) n++;
    if (f.key === 'mine' || f.key === 'all') n += nDrafts;
    counts[f.key] = n;
  }
  return counts;
}

/**
 * The planned changes an Apply sends (batched edits): every thread the agent planned to change (status 'planned'),
 * whichever filter lists it (one that also waits for the reviewer, a reply not sent yet or a lost anchor, is in Your
 * turn too), in id order. The one set behind the panel's "Apply N", a card's "Apply this now", the turn pill, the
 * Approve dialog's warning and the palette, so they can never apply different changes.
 * @param {DocState} ds
 * @returns {any[]}
 */
export function applicablePlanned(ds) {
  return (ds?.threads || []).filter((/** @type {any} */ t) => t.status === 'planned')
    .sort((/** @type {any} */ a, /** @type {any} */ b) => idNumber(a.id) - idNumber(b.id));
}

/** Threads the agent planned to change: applicablePlanned (the name callers used first). @param {DocState} ds */
export function plannedThreads(ds) {
  return applicablePlanned(ds);
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
 * The verdict the Send dialog starts with when there are drafts: "Needs changes" when the review carries a Must fix
 * comment (a blocking new thread, or a reopen of a blocking thread), else `otherwise` (the reviewer's Settings
 * choice, "Send feedback" by default).
 * @param {DocState} ds
 * @param {'comment'|'changes_requested'} [otherwise]
 * @returns {'changes_requested'|'comment'}
 */
export function defaultVerdict(ds, otherwise = 'comment') {
  const threads = ds?.threads || [];
  const blocking = (ds?.drafts?.items || []).some((/** @type {any} */ d) => (d.kind === 'thread' && d.severity === 'blocking')
    || (d.kind === 'reply' && d.reopen && threads.some((/** @type {any} */ t) => t.id === d.thread && t.severity === 'blocking')));
  return blocking ? 'changes_requested' : otherwise === 'changes_requested' ? 'changes_requested' : 'comment';
}

/**
 * What to paste into the agent's chat when it is not listening (the Send dialog, the turn pill, Settings, Document
 * info, the command palette): plain words, no Markdown, so what the UI shows is exactly what gets copied.
 * @param {DocState} ds
 */
export function agentPrompt(ds) {
  return `Run suiko feedback ${ds?.doc?.id ?? ''} and address it.`;
}

/**
 * What "Accept all" accepts: the addressed and answered threads to check (the agent changed the doc, or answered
 * a question). Declined threads stay in the queue: each needs the reviewer's own decision.
 * @param {DocState} ds
 * @returns {any[]}
 */
export function acceptableThreads(ds) {
  return (ds?.threads || []).filter((/** @type {any} */ t) => (t.status === 'addressed' || t.status === 'answered')
    && isVerifiable(t, ds.drafts));
}

/** The declined threads to check (the agent did not change them; left out of "Accept all"). @param {DocState} ds @returns {any[]} */
export function declinedToVerify(ds) {
  return (ds?.threads || []).filter((/** @type {any} */ t) => t.status === 'declined' && isVerifiable(t, ds.drafts));
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
 * The agent's name at the start of a sentence: 'claude' -> 'Claude'. A name that is not one plain lowercase word
 * ('gpt-5', 'MyBot') is left as it is.
 * @param {unknown} name
 */
export function agentTitle(name) {
  const n = String(name ?? '');
  return /^[a-z]+$/.test(n) ? n[0].toUpperCase() + n.slice(1) : n;
}

/**
 * Where the agent is (the turn pill's dot, design 11.7): editing the file (unrecorded changes on disk), listening (a
 * `suiko wait` is running), working on the feedback it got (delivered, not answered yet), or not connected (feedback
 * waits for its next `suiko wait`). `label` is the sentence, `short` the pill's narrow form.
 * @param {DocState} ds
 * @returns {{ kind: 'editing'|'listening'|'revising'|'none', label: string, short: string, tone: string }}
 */
export function presenceInfo(ds) {
  const agent = agentTitle(agentName(ds));
  if (ds?.working?.dirty && !ds.working.missing) return { kind: 'editing', label: `${agent} is editing`, short: 'Editing', tone: 'warn' };
  if (ds?.waiters?.length) return { kind: 'listening', label: `${agent} is listening`, short: 'Listening', tone: 'ok' };
  const last = latestReview(ds);
  if (last && Object.keys(last.deliveredTo || {}).length && !answeringVersion(ds, last) && !agentRepliedSince(ds, last)) {
    return { kind: 'revising', label: `${agent} is working…`, short: 'Working…', tone: 'accent' };
  }
  return { kind: 'none', label: `${agent} isn't connected`, short: 'Not connected', tone: 'muted' };
}

/**
 * Progress of the newest review, in plain words: "Sent 14:01" -> "Claude has it · 14:02" -> "Claude is editing…" ->
 * "v3 ready". `stage`: submitted, delivered, revising, ready.
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
  if (!delivered.length) return { label: `Sent ${formatClock(r.submittedAt)}`.trim(), tone: 'muted', stage: 'submitted' };
  if (ds?.working?.dirty) return { label: `${agentTitle(agent)} is editing…`, tone: 'warn', stage: 'revising' };
  const [name, at] = delivered[0];
  const clock = formatClock(String(at));
  return { label: `${agentTitle(name)} has it${clock ? ` · ${clock}` : ''}`, tone: 'info', stage: 'delivered' };
}

/**
 * What waits for the reviewer: the thread panel's "Your turn" and the turn pill's count. New-thread drafts, threads
 * with a pending reply or resolve in the review being prepared, threads the agent answered (addressed / answered /
 * declined with the agent speaking last: isVerifiable), its questions (needs_input), and unresolved threads that lost
 * their place in the version shown. Each thread counts once.
 * @param {DocState} ds
 * @param {number|'live'|null} version
 * @returns {{ count: number, drafts: number, pending: number, check: number, answer: number, lost: number, ids: string[] }}
 *   drafts: new-thread drafts; pending: threads with a reply / resolve draft; check: answered by the agent;
 *   answer: its questions; lost: lost their place; ids: the threads counted
 */
export function myTurn(ds, version) {
  const drafts = threadDrafts(ds?.drafts).length;
  const counts = { pending: 0, check: 0, answer: 0, lost: 0 };
  /** @type {string[]} */
  const ids = [];
  const ctx = { drafts: ds?.drafts, version };
  for (const t of ds?.threads || []) {
    const why = turnReason(t, ctx);
    if (!why) continue;
    counts[why]++;
    ids.push(t.id);
  }
  return { count: drafts + ids.length, drafts, ...counts, ids };
}

/** Unresolved threads plus new-thread drafts: the count on the thread panel's button. @param {DocState} ds */
export function openThreadCount(ds) {
  return (ds?.threads || []).filter((/** @type {any} */ t) => t.status !== 'resolved').length + threadDrafts(ds?.drafts).length;
}

/** Unresolved threads whose anchor lost its place (changed or orphaned) in a version. @param {DocState} ds @param {number|'live'|null} version */
export function lostThreads(ds, version) {
  return (ds?.threads || []).filter((/** @type {any} */ t) => t.status !== 'resolved' && isOutdated(t, version));
}

/**
 * The turn pill (top bar): one short answer to "whose turn is it?" plus what is behind it (the presence, the newest
 * review's progress, the round summary, what waits for the reviewer, the planned changes). Its label: "Your turn · N"
 * while something waits for the reviewer; else "Apply N planned" while the agent's planned changes (batched edits)
 * wait for the reviewer's Apply, the next step; else "Review closed", "Approved vN" (the final version is the latest),
 * or where the agent is ("Claude is working…", "Claude is listening", ...). The dot always shows the agent's presence.
 * `planned`: the planned changes (applicablePlanned), also while it is your turn.
 * @param {DocState} ds
 * @param {number|'live'|null} version
 */
export function turnInfo(ds, version) {
  const presence = presenceInfo(ds);
  const progress = reviewProgress(ds);
  const mine = myTurn(ds, version);
  const planned = applicablePlanned(ds).length;
  const head = Number(ds?.doc?.head) || 0;
  const final = Number(ds?.doc?.final?.version) || 0;
  /** @type {{ kind: string, label: string, short: string, tone: string }} */
  let turn;
  if (mine.count) turn = { kind: 'yours', label: `Your turn · ${mine.count}`, short: `Your turn · ${mine.count}`, tone: 'accent' };
  else if (planned) turn = { kind: 'apply', label: `Apply ${planned} planned`, short: `Apply ${planned}`, tone: 'accent' };
  else if (ds?.doc?.state === 'closed') turn = { kind: 'closed', label: 'Review closed', short: 'Closed', tone: 'muted' };
  else if (ds?.doc?.state === 'approved' && final && final >= head) turn = { kind: 'approved', label: `Approved v${final}`, short: 'Approved', tone: 'ok' };
  else turn = { kind: presence.kind, label: presence.label, short: presence.short, tone: presence.tone };
  return { ...turn, presence, progress, round: roundSummary(ds), mine, planned };
}

/**
 * Whether the primary button's "Approve" is the obvious next step (accent): the agent answered the newest review
 * with a version, nothing waits for the reviewer and no thread waits for the agent.
 * @param {DocState} ds
 * @param {number|'live'|null} version
 */
export function approveReady(ds, version) {
  if (reviewProgress(ds)?.stage !== 'ready' || myTurn(ds, version).count) return false;
  return !(ds?.threads || []).some((/** @type {any} */ t) => t.status === 'open' || t.status === 'planned');
}

/**
 * What an approval of the version shown would leave pending, for the Approve dialog's warning rows (each with its
 * way out):
 * - 'planned': the agent's planned changes, not in the version yet ("2 planned changes aren't in v2 yet", Apply 2);
 * - 'yours': threads that still wait for the reviewer after it ("3 threads still wait for you", Show): its questions,
 *   threads that lost their place, and answers to check, except the ones the approval marks done (addressed and
 *   answered, with "Mark N answered threads done": `resolveAddressed`) and the ones with a reply or a resolve in the
 *   review (they go out with it);
 * - 'agent': threads still waiting for the agent ("1 thread is still with Claude").
 * Empty when nothing would be left.
 * @param {DocState} ds
 * @param {number|'live'|null} version
 * @param {{ resolveAddressed?: boolean }} [opts]
 * @returns {Array<{ key: 'planned'|'yours'|'agent', count: number, label: string, ids: string[] }>}
 */
export function approveWarnings(ds, version, { resolveAddressed = true } = {}) {
  if (!ds) return [];
  const v = numericVersion(ds, version);
  const ctx = { drafts: ds.drafts, version };
  const agent = agentTitle(agentName(ds));
  /** @type {Array<{ key: 'planned'|'yours'|'agent', count: number, label: string, ids: string[] }>} */
  const out = [];
  /** @param {any[]} list */
  const idsOf = (list) => list.map((t) => String(t.id));
  const planned = applicablePlanned(ds);
  if (planned.length) {
    const n = planned.length;
    out.push({ key: 'planned', count: n, label: `${n} planned ${n === 1 ? "change isn't" : "changes aren't"} in v${v} yet`, ids: idsOf(planned) });
  }
  const yours = (ds.threads || []).filter((/** @type {any} */ t) => {
    const why = turnReason(t, ctx);
    if (why === 'answer' || why === 'lost') return true;
    return why === 'check' && !(resolveAddressed && (t.status === 'addressed' || t.status === 'answered'));
  });
  if (yours.length) {
    const n = yours.length;
    out.push({ key: 'yours', count: n, label: `${n} ${n === 1 ? 'thread still waits' : 'threads still wait'} for you`, ids: idsOf(yours) });
  }
  const withAgent = (ds.threads || []).filter((/** @type {any} */ t) => t.status !== 'resolved' && t.status !== 'planned' && turnReason(t, ctx) == null);
  if (withAgent.length) {
    const n = withAgent.length;
    out.push({ key: 'agent', count: n, label: `${n} ${n === 1 ? 'thread is' : 'threads are'} still with ${agent}`, ids: idsOf(withAgent) });
  }
  return out;
}

/**
 * The count on the Changes tab: how many changes the latest version brings since the reviewer's last review or
 * acceptance, while that version is shown (0 otherwise, and for a doc with nothing new).
 * @param {DocState} ds
 * @param {number|'live'|null} version
 * @param {any} changes the comparison loaded (Changes for base -> version)
 */
export function newChangesCount(ds, version, changes) {
  const todo = revisionsToAccept(ds);
  return todo && version === todo.version ? (changes?.hunks || []).length : 0;
}

/**
 * What is wrong, for the header's problems chip (which shows only when this is not empty): script errors and
 * resources that failed to load in the rendered doc (kinds with a doc frame), and a file missing on disk. A thread
 * that lost its place is not a problem but a routine part of a review (the agent removed or rewrote that text): Your
 * turn counts it and its card offers Move here / Keep as general. Unrecorded changes on disk are not a problem either
 * (the agent is editing): the banner and the turn pill say so.
 * @param {DocState} ds
 * @param {{ version?: number|'live'|null, pageErrors?: { count?: number, last?: string|null, resourcesFailed?: string[] },
 *   externalsFailed?: string[] }} g
 * @returns {Array<{ key: 'errors'|'resources'|'missing', count: number, label: string, detail?: string, items?: string[] }>}
 */
export function problemList(ds, { pageErrors, externalsFailed }) {
  if (!ds) return [];
  const caps = kindCaps(ds);
  /** @type {Array<{ key: 'errors'|'resources'|'missing', count: number, label: string, detail?: string, items?: string[] }>} */
  const out = [];
  /** @param {number} n @param {string} one @param {string} many */
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  if (caps.pageErrors) {
    const errors = Number(pageErrors?.count) || 0;
    if (errors) out.push({ key: 'errors', count: errors, label: plural(errors, 'script error in the page', 'script errors in the page'), detail: pageErrors?.last || '' });
    const failed = [...(externalsFailed || []), ...(pageErrors?.resourcesFailed || [])];
    if (failed.length) out.push({ key: 'resources', count: failed.length, label: plural(failed.length, 'resource did not load', 'resources did not load'), items: failed });
  }
  if (caps.liveBanners && ds.working?.missing) out.push({ key: 'missing', count: 1, label: 'The file is missing on disk', detail: String(ds.doc?.path || '') });
  return out;
}

/**
 * "v3 ready: 3 to check, 1 needs your answer" when the head version answers a review. `addressed` counts the
 * threads the agent answered that wait for the reviewer's check (addressed, answered and declined: isVerifiable).
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
  if (addressed) parts.push(`${addressed} to check`);
  if (needs) parts.push(`${needs} ${needs === 1 ? 'needs' : 'need'} your answer`);
  return { text: parts.length ? `v${head} ready: ${parts.join(', ')}` : `v${head} ready`, addressed, needs, version: head };
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
  // a code anchor names its file and lines in one label ('src/a.js:L3-4')
  if (anchor?.file?.path) return { lines: '', section: '', label: clip(preview?.label || targetLabel(anchor), 90) };
  const lines = linesLabel(preview?.lines ?? (anchor?.src ? [anchor.src.startLine, anchor.src.endLine] : null));
  const section = sectionTail(preview?.section ?? anchor?.section);
  const label = preview?.label || targetLabel(anchor);
  return { lines, section: section ? `§${section}` : '', label: clip(label, 90) };
}

/**
 * The composer's "Claude will see" line, in plain words: `what` (the quote, “…”, or what the anchor targets: "General
 * comment", 'table row "Enterprise"', a code review's 'src/a.js:L3-4') and its section ("§1.1 Milestones", '' when
 * there is none or `what` says it); `title`, for the tooltip, adds the source lines ("Claude will see: L25 §1.1
 * Milestones “Remove the legacy session store.”"). The engine's own preview text ("Agent will see: ...") is not shown.
 * @param {any} preview the server's preview {label, lines, section, text}
 * @param {Anchor|null} anchor
 * @param {string} [agent]
 * @returns {{ what: string, section: string, title: string }}
 */
export function agentSees(preview, anchor, agent = 'claude') {
  const name = agentTitle(agent);
  const chip = anchorChipParts(preview, anchor);
  if (anchor?.file?.path || !anchor) {
    const what = chip.label || targetLabel(anchor);
    return { what, section: '', title: `${name} will see: ${what}` };
  }
  if (anchor.kind === 'doc') return { what: 'General comment', section: '', title: `${name} will see: a comment about the whole document` };
  const quote = anchor.kind !== 'section' ? normWs(anchor.quote?.exact || '') : '';
  const label = String(preview?.label || '');
  // lines picked in Source: the lines are what it is about ("lines 51-52")
  const source = anchor.kind === 'source' && chip.lines ? `lines ${chip.lines.slice(1)}` : '';
  // the engine labels a text selection 'text' and a general comment 'GENERAL': the UI's own label is better then
  const what = quote ? `“${clip(quote, 80)}”`
    : source || (anchor.kind === 'section' ? `§${sectionTail(anchor.section) || 'section'}`
      : label && label !== 'text' && label !== 'GENERAL' && label !== 'source lines' ? clip(label, 90) : targetLabel(anchor));
  const section = anchor.kind === 'section' ? '' : chip.section;
  return { what, section, title: `${name} will see: ${[chip.lines, chip.section, what].filter(Boolean).join(' ')}` };
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

/**
 * Whether the composer can "Send now" (Cmd/Ctrl+Shift+Enter): a new comment, question or suggestion. A draft being
 * edited is already part of the pending review, and "Mark agreed" creates a lock, so for those the keys submit the
 * whole review instead.
 * @param {any} comp Composer (state.js)
 */
export function canSendNow(comp) {
  return !!comp && !comp.draftId && comp.type !== 'agree';
}

/**
 * What Cmd/Ctrl+Enter (`shift`: Cmd/Ctrl+Shift+Enter) does while a composer is open, by Settings > Send comments:
 * 'send' (the comment alone, to the agent now), 'save' (a draft; also Save draft for a draft being edited and "Mark
 * agreed"), or 'review' (the key is the whole review's: the Send dialog). Right away ('now'): Enter sends, Shift
 * saves as a draft; When I click Send ('batch'): Enter adds to the review, Shift sends now. A draft being edited or
 * "Mark agreed" cannot be sent alone: Enter saves, Shift opens the Send dialog.
 * @param {any} comp Composer (state.js)
 * @param {boolean} shift
 * @param {'now'|'batch'|string} sendMode
 * @returns {'send'|'save'|'review'}
 */
export function composerKeyAction(comp, shift, sendMode) {
  if (!canSendNow(comp)) return shift ? 'review' : 'save';
  if (sendMode === 'batch') return shift ? 'send' : 'save';
  return shift ? 'save' : 'send';
}

/**
 * What Cmd/Ctrl+Enter (`shift`: Cmd/Ctrl+Shift+Enter) does in a reply box: 'send' (the reply alone, now) or 'save'
 * (a reply draft of the review), the same way round as in the composer.
 * @param {boolean} shift
 * @param {'now'|'batch'|string} sendMode
 * @returns {'send'|'save'}
 */
export function replyKeyAction(shift, sendMode) {
  if (sendMode === 'batch') return shift ? 'send' : 'save';
  return shift ? 'save' : 'send';
}

// ------------------------------------------------------------------------------------------------ attachments

/**
 * File names the daemon gives stored attachments ('a3.png'; an agent's 'a7.svg' or HTML preview 'a8.html'); anything
 * else is never turned into a URL.
 */
const ATTACHMENT_NAME = /^[A-Za-z0-9][\w.-]*\.(?:png|jpe?g|gif|webp|svg|html?)$/i;

/**
 * URL of a stored attachment ('attachments/a3.png') for thumbnails and previews: DocState.attachmentBase plus its
 * file name. Only URLs on the content origin are returned (attachmentBase lives under contentBase), so a crafted path
 * or base can never make the UI load an image or a preview from anywhere else. Null when the daemon serves no
 * attachments.
 * @param {DocState} ds
 * @param {unknown} path
 * @returns {string|null}
 */
export function attachmentUrl(ds, path) {
  const base = typeof ds?.attachmentBase === 'string' ? ds.attachmentBase : '';
  const name = typeof path === 'string' ? path.split('/').pop() || '' : '';
  if (!base || !ATTACHMENT_NAME.test(name)) return null;
  try {
    const url = new URL(encodeURIComponent(name), base.endsWith('/') ? base : `${base}/`);
    const content = new URL(typeof ds.contentBase === 'string' && ds.contentBase ? ds.contentBase : base);
    if (!/^https?:$/.test(url.protocol) || url.origin !== content.origin) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** The file name of an attachment path, for labels and alt texts. @param {unknown} path */
export function attachmentName(path) {
  return String(path ?? '').split('/').pop() || '';
}

/**
 * The files the agent attached to a comment (Comment.attachments: {path, name, kind}), checked: a doc-relative
 * 'attachments/...' path, the name it gave (else the file name), and the kind ('html' for .html / .htm, else
 * 'image').
 * @param {any} comment
 * @returns {Array<{ path: string, name: string, kind: 'image'|'html' }>}
 */
export function agentAttachments(comment) {
  const list = Array.isArray(comment?.attachments) ? comment.attachments : [];
  /** @type {Array<{ path: string, name: string, kind: 'image'|'html' }>} */
  const out = [];
  for (const a of list) {
    const path = typeof a === 'string' ? a : a?.path;
    if (typeof path !== 'string' || !/^attachments\/[^/]+$/.test(path)) continue;
    const kind = a?.kind === 'html' || /\.html?$/i.test(path) ? 'html' : 'image';
    out.push({ path, name: typeof a?.name === 'string' && a.name.trim() ? a.name.trim() : attachmentName(path), kind });
  }
  return out;
}

/**
 * The name an attachment of a thread goes by: the name the agent gave it on a reply ('chart.html'), else its file
 * name ('a7.html').
 * @param {Thread} t @param {string} path
 */
export function threadAttachmentName(t, path) {
  for (const c of t?.comments || []) {
    const hit = agentAttachments(c).find((a) => a.path === path);
    if (hit) return hit.name;
  }
  return attachmentName(path);
}

/** The body of the reply "Use in doc" sends (actions.js useAttachment); a reply with only it shows as one line. */
export const USE_REPLY_BODY = 'Put this in the doc.';
/** The body of the reviewer comment an Apply adds to a planned thread (the server's, `apply: true`). */
export const APPLY_COMMENT_BODY = 'Apply this change.';

/**
 * A reviewer comment that is a request rather than a message, shown as one compact line: the Apply of a planned
 * change ('apply', "You asked Claude to make this change") or a "Use in doc" ('use', "You asked Claude to put
 * chart.html in the document", plus the comment's own words when they are not the default ones). Null for an
 * ordinary comment.
 * @param {Thread} t
 * @param {any} c
 * @param {string} [agent]
 * @returns {{ kind: 'apply'|'use', text: string, body: string }|null}
 */
export function systemLine(t, c, agent = 'claude') {
  if (!c || !isHuman(c.by)) return null;
  const name = agentTitle(agent);
  const body = String(c.body ?? '').trim();
  if (c.apply === true) {
    return { kind: 'apply', text: `You asked ${name} to make this change`, body: body && body !== APPLY_COMMENT_BODY ? body : '' };
  }
  const use = Array.isArray(c.use) ? c.use.filter((/** @type {any} */ u) => typeof u === 'string') : [];
  if (!use.length) return null;
  const names = use.map((/** @type {string} */ u) => threadAttachmentName(t, u));
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return { kind: 'use', text: `You asked ${name} to put ${list} in the document`, body: body && body !== USE_REPLY_BODY ? body : '' };
}

// ------------------------------------------------------------------------------------------------ layout

const PANEL_MIN_WIDTH = 280;
/** What the doc keeps when the side panel is dragged wider; --doc-min (tokens.css) is the same for a smaller window. */
const DOC_MIN_WIDTH = 360;

/**
 * The widths the side panel can be dragged to.
 * @param {number} room what the doc and the panel share (px)
 */
export function panelWidthRange(room) {
  return { min: PANEL_MIN_WIDTH, max: Math.max(PANEL_MIN_WIDTH, room - DOC_MIN_WIDTH) };
}

// ------------------------------------------------------------------------------------------------ shortcuts

/**
 * A shortcut as buttons and the help show it: '+'-separated parts, where mod / shift / alt / enter / esc are
 * named and anything else is the key itself. On a Mac 'mod+shift+enter' is '⌘⇧↵'; elsewhere 'Ctrl+Shift+Enter',
 * or 'Ctrl+⇧+↵' when compact (the small hint inside a button).
 * @param {string} combo e.g. 'mod+enter', 'shift+B', 'b'
 * @param {boolean} mac
 * @param {{ compact?: boolean }} [opts]
 */
export function keyLabel(combo, mac, opts = {}) {
  const MAC = /** @type {Record<string, string>} */ ({ mod: '⌘', ctrl: '⌃', shift: '⇧', alt: '⌥', enter: '↵', esc: 'Esc' });
  const PC = /** @type {Record<string, string>} */ (opts.compact
    ? { mod: 'Ctrl', ctrl: 'Ctrl', shift: '⇧', alt: 'Alt', enter: '↵', esc: 'Esc' }
    : { mod: 'Ctrl', ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', enter: 'Enter', esc: 'Esc' });
  const names = mac ? MAC : PC;
  // 'mod+k' splits into ['mod', 'k']; 'mod++' would be ambiguous and is not used.
  const raw = String(combo).split('+').filter(Boolean);
  const modified = raw.length > 1;
  const parts = raw.map((p, i) => {
    const named = names[p.toLowerCase()];
    if (named != null && (i < raw.length - 1 || p.length > 1)) return named;
    // A letter after a modifier is written in capitals, like menus do ('⌘K', 'Ctrl+K').
    return modified && i === raw.length - 1 && /^[a-z]$/.test(p) ? p.toUpperCase() : p;
  });
  return parts.join(mac ? '' : '+');
}

/**
 * Whether a shortcut combo is a single-character key (letters, digits, punctuation, with or without Shift): the
 * shortcuts the reviewer can switch off in Settings. Esc, Enter and anything with Cmd / Ctrl / Alt are not.
 * @param {string} combo e.g. 'c', 'shift+B', '?', 'mod+k', 'esc'
 */
export function isSingleKeyCombo(combo) {
  const parts = String(combo).split('+').filter(Boolean);
  const key = parts[parts.length - 1] || '';
  if (parts.slice(0, -1).some((p) => p.toLowerCase() !== 'shift')) return false;
  return key.length === 1;
}

/**
 * The app-level combo a key press is, if any: Mod+K (command palette), Mod+, (settings), Mod+/ (keyboard
 * shortcuts; also Mod+? where '/' needs Shift). Mod is Cmd or Ctrl on every platform (Ctrl is the macOS fallback for
 * hosts that keep the Cmd combos for themselves); Alt must not be held (AltGr characters on Windows). Shift+Mod+K is
 * not the palette. Caps Lock reports 'K' without Shift.
 * @param {{ key: string, meta?: boolean, ctrl?: boolean, shift?: boolean, alt?: boolean }} k
 * @returns {'palette'|'settings'|'help'|null}
 */
export function appCombo(k) {
  if (!k || !(k.meta || k.ctrl) || k.alt) return null;
  const key = String(k.key || '');
  if ((key === 'k' || key === 'K') && !k.shift) return 'palette';
  if (key === ',') return 'settings';
  if (key === '/' || key === '?') return 'help';
  return null;
}

// ------------------------------------------------------------------------------------------------ palette search

/** Characters after which a match starts a "word" (bonus). */
const WORD_SEP = /[\s\-_/.:,;()[\]{}§·—–"'“”‘’<>|+…#@]/;
const FZ = Object.freeze({
  base: 1, first: 10, word: 8, camel: 7, digit: 4, consec: 5, gap: 0.6, lead: 0.2, leadMax: 3, prefix: 25, substring: 10,
  skip: 2,
});

/**
 * Fuzzy subsequence match of `query` in `text` (case-insensitive), scored like fuzzy finders do: every matched
 * character scores, more at the start of the text, at a word start (after a space or punctuation, or a camelCase
 * hump) and right after the previous match; skipped characters cost a little, and so does starting late. A text that
 * starts with the query, or contains it, gets a bonus. The best alignment is found by dynamic programming (titles are
 * short), so 'gt' in 'Go to thread' matches the word starts g and t.
 * After a gap, the next letter must start a word, or be in the same word as the previous match (an abbreviation,
 * which costs a little more): 'stng' finds 'settings' and 'kbd' 'Keyboard', but 'mode' does not find 'comment ·
 * Rollout — load test' (letters from the middle of four different words). The first letter may be anywhere.
 * @param {string} query
 * @param {string} text
 * @returns {{ score: number, positions: number[] } | null} positions: indexes in `text` of the matched characters
 */
export function fuzzyMatch(query, text) {
  const q = String(query ?? '').toLowerCase();
  const t = String(text ?? '');
  const tl = t.toLowerCase();
  const n = q.length;
  const m = t.length;
  if (!n) return { score: 0, positions: [] };
  if (n > m || tl.length !== m) return null; // (lowercasing changed the length: no reliable positions)
  let k = 0;
  for (let j = 0; j < m && k < n; j++) if (tl[j] === q[k]) k++;
  if (k < n) return null;
  const bonus = new Float64Array(m);
  const boundary = new Uint8Array(m);
  // word[j]: which word character j belongs to (a new one starts at every word start).
  const word = new Int32Array(m);
  for (let j = 0; j < m; j++) {
    const b = charBonus(t, j);
    bonus[j] = FZ.base + b;
    boundary[j] = b > 0 ? 1 : 0;
    word[j] = j === 0 ? 0 : word[j - 1] + boundary[j];
  }
  const NEG = -1e9;
  let prev = new Float64Array(m).fill(NEG);
  /** @type {Int32Array[]} */
  const back = [];
  for (let i = 0; i < n; i++) {
    const cur = new Float64Array(m).fill(NEG);
    const bk = new Int32Array(m).fill(-1);
    // Over p <= j-2, of prev[p] - gap * (j - 1 - p) (the best earlier match with a gap before j): any p (allowed
    // when j starts a word), and p in j's own word (allowed anywhere).
    let gAny = NEG;
    let gAnyArg = -1;
    let gWord = NEG;
    let gWordArg = -1;
    for (let j = 0; j < m; j++) {
      if (i > 0 && j >= 2) {
        const cand = prev[j - 2] - FZ.gap;
        gAny -= FZ.gap;
        if (cand > gAny) {
          gAny = cand;
          gAnyArg = j - 2;
        }
        if (word[j - 1] !== word[j]) {
          gWord = NEG;
          gWordArg = -1;
        } else {
          gWord -= FZ.gap;
          if (word[j - 2] === word[j] && cand > gWord) {
            gWord = cand;
            gWordArg = j - 2;
          }
        }
      }
      if (j < i || tl[j] !== q[i]) continue;
      if (i === 0) {
        cur[j] = bonus[j] - Math.min(j * FZ.lead, FZ.leadMax);
        continue;
      }
      let s = NEG;
      let p = -1;
      if (prev[j - 1] > NEG / 2) {
        s = prev[j - 1] + FZ.consec;
        p = j - 1;
      }
      const g = boundary[j] ? gAny : gWord - FZ.skip;
      if (g > NEG / 2 && g > s) {
        s = g;
        p = boundary[j] ? gAnyArg : gWordArg;
      }
      if (p < 0) continue;
      cur[j] = s + bonus[j];
      bk[j] = p;
    }
    back.push(bk);
    prev = cur;
  }
  let end = -1;
  let best = NEG;
  for (let j = 0; j < m; j++) {
    if (prev[j] > best) {
      best = prev[j];
      end = j;
    }
  }
  if (end < 0 || best <= NEG / 2) return null;
  const positions = new Array(n);
  for (let i = n - 1, j = end; i >= 0; i--) {
    positions[i] = j;
    j = back[i][j];
  }
  const at = tl.indexOf(q);
  const extra = at === 0 ? FZ.prefix : at > 0 ? FZ.substring + (WORD_SEP.test(t[at - 1]) ? 5 : 0) : 0;
  return { score: best + extra, positions };
}

/** @param {string} t @param {number} j */
function charBonus(t, j) {
  if (j === 0) return FZ.first;
  const prev = t[j - 1];
  const c = t[j];
  if (WORD_SEP.test(prev)) return FZ.word;
  if (prev !== prev.toUpperCase() && c !== c.toLowerCase()) return FZ.camel;
  if (/\d/.test(c) && !/\d/.test(prev)) return FZ.digit;
  return 0;
}

/**
 * @typedef {object} SearchRow  what the command palette matches a query against
 * @property {string} title shown, and highlighted where it matched
 * @property {string} [description]
 * @property {string} [category]
 * @property {string[]} [keywords] extra words that find the row (synonyms, a thread's comment text)
 * @property {string[]} [exact] queries that put the row first ('t4' for thread t4, 'v2' for version 2)
 */

/**
 * Scores a palette row for a query (null: no match). The whole query is fuzzy-matched against the title; besides,
 * each word of the query may match the title (fuzzy) or the keywords / description / category (as a word or a
 * substring), in any order, so 'approve submit' finds 'Approve this version…' and words of a comment find its
 * thread. An `exact` hit ranks first.
 * @param {string} query
 * @param {SearchRow} row
 * @returns {{ score: number, positions: number[] } | null} positions: matched characters of the title
 */
export function matchRow(query, row) {
  const q = normWs(query).toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const title = String(row.title ?? '');
  if ((row.exact || []).some((e) => String(e).toLowerCase() === q)) {
    const at = title.toLowerCase().indexOf(q);
    return { score: 1000, positions: at < 0 ? [] : Array.from({ length: q.length }, (_, i) => at + i) };
  }
  /** @type {Array<{ score: number, positions: number[] }>} */
  const found = [];
  const whole = fuzzyMatch(q, title);
  if (whole) found.push(whole);
  const tokens = q.split(' ');
  const other = [...(row.keywords || []), row.description || '', row.category || ''].join(' ').toLowerCase();
  let score = 0;
  const pos = new Set();
  let all = true;
  for (const tok of tokens) {
    const f = tokens.length > 1 || !whole ? fuzzyMatch(tok, title) : whole;
    const at = wordAt(other, tok);
    const kw = at < 0 ? null : (at === 0 || WORD_SEP.test(other[at - 1]) ? 6 : 2) + tok.length * 1.5;
    if (f && (kw == null || f.score >= kw)) {
      score += f.score;
      for (const p of f.positions) pos.add(p);
    } else if (kw != null) {
      score += kw;
    } else {
      all = false;
      break;
    }
  }
  if (all && (tokens.length > 1 || !whole)) found.push({ score: score - 2, positions: [...pos].sort((a, b) => a - b) });
  if (!found.length) return null;
  return found.reduce((a, b) => (b.score > a.score ? b : a));
}

/** Index of `word` in `text`, preferring an occurrence at a word start; -1 when absent. @param {string} text @param {string} word */
function wordAt(text, word) {
  let first = -1;
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
    if (i === 0 || WORD_SEP.test(text[i - 1])) return i;
    if (first < 0) first = i;
  }
  return first;
}

/**
 * Splits a text into plain and matched runs for highlighting.
 * @param {string} text
 * @param {number[]} positions sorted indexes of matched characters
 * @returns {Array<{ text: string, hit: boolean }>}
 */
export function highlightParts(text, positions) {
  const t = String(text ?? '');
  const hits = new Set(positions || []);
  /** @type {Array<{ text: string, hit: boolean }>} */
  const out = [];
  for (let i = 0; i < t.length; i++) {
    const hit = hits.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += t[i];
    else out.push({ text: t[i], hit });
  }
  return out;
}

const THREAD_TYPE = /** @type {Record<string, string>} */ ({
  comment: 'comment', question: 'question', suggestion: 'suggestion', 'agent-question': 'agent question',
});

/**
 * The "Go to thread" row of a thread or new-thread draft (a panelItems entry):
 * 't4 · comment · §3.2 Token refresh — first words of the comment'.
 * @param {{ kind: 'thread'|'draft', id: string, item: any, anchor: Anchor|null }} it
 * @returns {{ title: string, body: string }} body: the whole first comment (for search)
 */
export function threadRowTitle(it) {
  const t = it.item || {};
  const type = THREAD_TYPE[t.type] || 'comment';
  const a = it.anchor;
  const section = a && a.kind !== 'doc' ? sectionTail(a.section) : '';
  const where = section ? `§${section}` : targetLabel(a) || 'document';
  const body = it.kind === 'draft'
    ? String(t.body || t.suggestion?.new || '')
    : String((t.comments || [])[0]?.body || t.suggestion?.new || '');
  const words = clip(body.replace(/[*_`#>[\]]+/g, ''), 60).replace(/\s+…$/, '…');
  const title = `${it.id} · ${it.kind === 'draft' ? `draft ${type}` : type} · ${where}${words ? ` — ${words}` : ''}`;
  return { title, body: normWs(body).slice(0, 400) };
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
