// @ts-check
// Builds the feedback packet data (design 9.3 JSON; BUILD_AMENDMENTS 4.6 caps) from a loaded doc snapshot. The
// text form is produced from this object by packet.js `formatPacket`, so CLI, MCP and hooks share one shape.
//
// - Threads: every actionable thread (open, or the reviewer spoke last), plus with `allOpen` every unresolved one.
//   Order: working-copy line, blocking first within ties, then id; threads without lines (whole doc, orphaned)
//   come last.
// - Lines and `src` come from the working copy: head anchors are mapped through a precise head->working mapper.
// - Locks (active), decisions (resolved threads with a decision), counts, drafts (only with includeDrafts).
// - Attachments (region crops, snips, screenshots, pasted images) are ABSOLUTE paths the agent can Read, for every
//   thread (GENERAL ones included) and for listed drafts; `attachmentKind` says what they show (region | snip |
//   image), which picks the packet line ('crop:' / 'image:' and its Read hint, packet.js attachmentLine).
// - Paths: `path` is workspace-relative (doc.path); `root` (workspace root) and `file` (absolute path) are added
//   when known, and `pathFromCwd` is how the agent's cwd reaches the file (relative when under the cwd, else
//   absolute): in a non-git project whose `.specreview/` sits next to the spec in a subfolder, the bare doc.path
//   does not resolve from the directory the agent runs in.

import fs from 'node:fs';
import nodePath from 'node:path';
import { CONTEXT_CHARS } from '../../shared/protocol.js';
import { compareIds } from '../store/store.js';
import { lineIndex } from '../text/index.js';
import { attachmentKind, describe, envOf, label as anchorLabel, quoteText } from './anchoring.js';
import { linesLabel, quote as quoteLabel, sectionPath, truncate } from './labels.js';
import { anchorAt, conversation, isAwaitingReviewer, isOutdated, whyOf } from './threadstate.js';
import { docRefFor, isSnapshot, originType, planFileOf } from '../store/snapshot.js';

/**
 * @typedef {import('../../shared/types.js').Thread} Thread
 * @typedef {import('../../shared/types.js').Lock} Lock
 * @typedef {import('../../shared/types.js').Review} Review
 * @typedef {import('../../shared/types.js').Doc} Doc
 * @typedef {import('../../shared/types.js').Anchor} Anchor
 * @typedef {import('../../shared/types.js').DraftItem} DraftItem
 * @typedef {import('./threadstate.js').Why} Why
 *
 * @typedef {object} PacketComment
 * @property {string} by
 * @property {'agent' | 'human' | 'external'} kind
 * @property {string} body
 * @property {string} at
 * @property {number} version
 * @property {string | null} status agent reply status
 * @property {string | null} hunk hunk of that version linked to the thread (agent replies)
 *
 * @typedef {object} PacketThread
 * @property {string} id
 * @property {Why | 'awaiting'} why
 * @property {string} type
 * @property {string} severity
 * @property {string} status
 * @property {[number, number] | null} lines working-copy lines of the anchor
 * @property {string[]} section
 * @property {string} sectionLabel display path ('3 Tokens > 3.2 Token refresh')
 * @property {string} target anchor kind
 * @property {string} label target label ('text' for plain text anchors; anchorLabel of the anchor library)
 * @property {string | null} on rendered quote (<= 120 chars)
 * @property {string | null} src
 * @property {boolean} srcUnique
 * @property {boolean} srcWindow
 * @property {boolean} srcEditable
 * @property {string} anchorState
 * @property {string | null} note '(outdated: text changed)' / '(orphaned: ...)'
 * @property {PacketComment[]} comments last agent reply and every reviewer comment after it
 * @property {number} earlier collapsed older comments
 * @property {object | null} suggestion
 * @property {string[]} attachments absolute paths
 * @property {'region' | 'snip' | 'image'} attachmentKind what the attachments show (region crop, snipped area, other image)
 * @property {string | null} apply command applying the suggestion
 *
 * @typedef {object} Packet
 * @property {number} schema
 * @property {string} doc
 * @property {string} path workspace-relative POSIX path (synthetic for a snapshot doc)
 * @property {'file' | 'snapshot'} [kind] a snapshot doc has no working file (store/snapshot.js)
 * @property {string | null} [origin] a snapshot's origin type ('plan', 'message', 'stdin'...)
 * @property {string} [ref] the doc as follow-up commands name it (adds `--workspace` for a scratch workspace)
 * @property {string | null} [root] absolute workspace root
 * @property {string | null} [file] absolute path of the working copy (a plan snapshot: its plan file; other
 *   snapshots: null)
 * @property {string | null} [pathFromCwd] the working copy as reached from the agent's cwd (relative, or absolute);
 *   a snapshot has no working copy: its plan file (plan snapshots), else null
 * @property {string} title
 * @property {number} head
 * @property {'clean' | 'dirty' | 'missing'} working
 * @property {Array<{ id: string, version: number, verdict: string, body: string, by: string, at: string }>} reviews
 * @property {string | null} verdict newest delivered review's verdict
 * @property {Doc['final']} final
 * @property {PacketThread[]} threads
 * @property {Array<{ id: string, lines: [number, number] | null, section: string[], label: string }>} locks
 * @property {Array<{ id: string, thread: string, text: string }>} decisions
 * @property {object[] | null} drafts
 * @property {{ actionable: number, new: number, reopened: number, reply: number, answer: number, open: number,
 *   awaitingReviewer: number, resolved: number, resolvedThisRound: number, outdated: number, unresolved: number,
 *   drafts: number, undelivered: number }} counts
 * @property {string[]} resolvedThisRound
 * @property {boolean} firstPacket no earlier review was delivered to this agent (adds the protocol reminder)
 * @property {boolean} replyOnly approved with a final version that is head, but threads still need action: the agent
 *   answers them with `specreview reply` and must not edit (the working copy has to stay identical to the final)
 * @property {string} agent
 * @property {string} next
 */

/**
 * @typedef {object} Snapshot
 * @property {Doc} doc
 * @property {{ v: number, source: string }} head
 * @property {{ text: string, dirty: boolean, missing: boolean }} working
 * @property {import('./workmap.js').PreciseMapper} mapper head -> working (mapper.hunks = lineHunks(head, working))
 * @property {Thread[]} threads
 * @property {Lock[]} locks
 * @property {Review[]} reviews
 */

/**
 * @param {Snapshot} snap
 * @param {object} opts
 * @param {string} opts.agent
 * @param {Review[]} opts.deliver reviews being delivered (undelivered to this agent), oldest first
 * @param {(rel: string) => string} opts.attachmentPath doc-relative attachment -> absolute path
 * @param {boolean} [opts.allOpen]
 * @param {DraftItem[] | null} [opts.drafts] reviewer drafts (only listed when includeDrafts)
 * @param {any} [opts.config] Config (anchoring thresholds)
 * @param {string | null} [opts.root] workspace root (adds `root` / `file`)
 * @param {string | null} [opts.cwd] the agent's cwd (adds `pathFromCwd`)
 * @returns {Packet}
 */
export function buildPacket(snap, { agent, deliver, attachmentPath, allOpen = false, drafts = null, config = null, root = null, cwd = null }) {
  const { doc } = snap;
  const env = envOf(doc, config);
  const workingText = snap.working.missing ? snap.head.source : snap.working.text;
  const li = lineIndex(workingText);
  const delivering = new Set(deliver.map((r) => r.id));
  const deliveredBefore = (/** @type {string | null} */ rv) => {
    if (!rv) return true;
    if (delivering.has(rv)) return false;
    const review = snap.reviews.find((r) => r.id === rv);
    return Boolean(review?.deliveredTo?.[agent]);
  };
  /** @type {Set<string>} */
  const reopenedIn = new Set(deliver.flatMap((r) => r.reopened ?? []));
  const mapRange = (/** @type {number} */ s, /** @type {number} */ e) =>
    snap.working.missing ? { start: s, end: e } : snap.mapper.mapRange(s, e);

  /** @type {PacketThread[]} */
  const items = [];
  for (const t of snap.threads) {
    const why = whyOf(t, { deliveredBefore, reopenedIn });
    if (!why && !(allOpen && t.status !== 'resolved')) continue;
    items.push(packetThread(t, why ?? 'awaiting', { snap, workingText, attachmentPath, env }));
  }
  items.sort(byFileOrder);

  const locks = snap.locks
    .filter((l) => l.active)
    .map((l) => {
      const a = anchorAt(l, snap.head.v);
      const lines = a && a.state !== 'orphaned' ? lineRange(li, mapRange(a.src.start, a.src.end)) : null;
      return { id: l.id, lines, section: a?.section ?? [], label: lockLabel(a, doc.title) };
    })
    .sort((x, y) => compareIds(x.id, y.id));

  const decisions = snap.threads
    .filter((t) => t.status === 'resolved' && t.decision?.text)
    .map((t) => ({ id: /** @type {any} */ (t.decision).id, thread: t.id, text: /** @type {any} */ (t.decision).text }))
    .sort((x, y) => compareIds(x.id, y.id));

  const resolvedThisRound = [...new Set(deliver.flatMap((r) => r.resolved ?? []))].sort(compareIds);
  const unresolved = snap.threads.filter((t) => t.status !== 'resolved');
  const counts = {
    actionable: items.filter((i) => i.why !== 'awaiting').length,
    new: items.filter((i) => i.why === 'new').length,
    reopened: items.filter((i) => i.why === 'reopened').length,
    reply: items.filter((i) => i.why === 'reply').length,
    answer: items.filter((i) => i.why === 'answer').length,
    open: items.filter((i) => i.why === 'open').length,
    awaitingReviewer: snap.threads.filter(isAwaitingReviewer).length,
    resolved: snap.threads.filter((t) => t.status === 'resolved').length,
    resolvedThisRound: resolvedThisRound.length,
    outdated: unresolved.filter((t) => isOutdated(anchorAt(t, snap.head.v))).length,
    unresolved: unresolved.length,
    drafts: drafts?.length ?? 0,
    undelivered: deliver.length,
  };
  const latest = deliver[deliver.length - 1] ?? null;
  const approval = approvalOf(doc, latest);
  const replyOnly = approval.approved && approval.finalNow && counts.actionable > 0;
  // nothing to apply once the reviewer approved the final version: a suggestion that came with it gets a reply
  if (replyOnly) for (const i of items) i.apply = null;
  const firstPacket = !snap.reviews.some((r) => r.deliveredTo?.[agent] && !delivering.has(r.id));

  const snapshot = isSnapshot(doc);
  const planFile = planFileOf(doc);
  const file = snapshot ? planFile : root ? nodePath.join(root, ...doc.path.split('/')) : null;
  const ref = docRefFor(doc.id, root);
  // nothing to apply to a snapshot: it has no working file (the agent revises it with `revise --source`)
  if (snapshot) for (const i of items) i.apply = null;
  return {
    schema: 1,
    doc: doc.id,
    path: doc.path,
    kind: snapshot ? 'snapshot' : 'file',
    origin: snapshot ? originType(doc) : null,
    ref,
    root,
    file,
    pathFromCwd: snapshot ? planFile : pathFromCwd(doc.path, root, cwd),
    title: doc.title,
    head: snap.head.v,
    working: snap.working.missing ? 'missing' : snap.working.dirty ? 'dirty' : 'clean',
    reviews: deliver.map((r) => ({ id: r.id, version: r.version, verdict: r.verdict, body: r.body ?? '', by: r.by?.name ?? '', at: r.submittedAt })),
    verdict: latest?.verdict ?? null,
    final: doc.final ?? null,
    threads: items,
    locks,
    decisions,
    drafts: drafts ? drafts.map((d) => draftSummary(d, snap, li, mapRange, attachmentPath)) : null,
    counts,
    resolvedThisRound,
    firstPacket,
    replyOnly,
    agent,
    next: snapshot ? snapshotNextStep(doc, ref, approval, counts.actionable) : nextStep(doc, approval, counts.actionable),
  };
}

/**
 * How a doc's working copy is named for someone in `cwd`: doc.path when cwd is the workspace root (or unknown),
 * else the path relative to cwd when the file is under it, else the absolute path.
 * @param {string} docPath workspace-relative POSIX path
 * @param {string | null | undefined} root
 * @param {string | null | undefined} cwd
 * @returns {string}
 */
export function pathFromCwd(docPath, root, cwd) {
  if (!root || !cwd) return docPath;
  const real = (/** @type {string} */ p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return nodePath.resolve(p);
    }
  };
  const r = real(root);
  const c = real(cwd);
  if (r === c) return docPath;
  const file = nodePath.join(r, ...docPath.split('/'));
  const rel = nodePath.relative(c, file);
  if (rel && !rel.startsWith('..') && !nodePath.isAbsolute(rel)) return rel.split(nodePath.sep).join('/');
  return file;
}

/**
 * @param {Thread} t
 * @param {Why | 'awaiting'} why
 * @param {{ snap: Snapshot, workingText: string, attachmentPath: (rel: string) => string,
 *   env: import('./anchoring.js').AnchorEnv }} ctx
 * @returns {PacketThread}
 */
function packetThread(t, why, { snap, workingText, attachmentPath, env }) {
  const anchor = anchorAt(t, snap.head.v);
  const d = anchor
    ? describe(anchor, { headSource: snap.head.source, workingSource: workingText, hunks: snap.mapper.hunks, env, attachments: t.attachments ?? [], absAttachmentPath: attachmentPath })
    : null;
  /** @type {string | null} */
  let note = null;
  if (anchor?.state === 'changed') note = '(outdated: text changed)';
  if (anchor?.state === 'orphaned') {
    const lk = d?.lastKnown;
    const where = lk
      ? [lk.section.length ? `§${sectionPath(lk.section, snap.doc.title)}` : '', `v${lk.v}`, linesLabel(lk.lines)].filter(Boolean).join(' ')
      : `v${anchor.v}`;
    note = `(orphaned: was ${quoteLabel(lk?.text ?? '', 60)} in ${where}; reanchor with specreview reanchor ${snap.doc.id} ${t.id} --lines A-B)`;
  }
  const conv = conversation(t);
  const suggestion = t.suggestion ? { ...t.suggestion } : null;
  const pendingSuggestion = suggestion && (suggestion.status === 'pending' || suggestion.status === 'conflict');
  const section = anchor?.state === 'orphaned' ? d?.lastKnown?.section ?? anchor.section ?? [] : anchor?.section ?? [];
  return {
    id: t.id,
    why,
    type: t.type,
    severity: t.severity ?? 'normal',
    status: t.status,
    lines: d?.lines ?? null,
    section,
    sectionLabel: sectionPath(section, snap.doc.title),
    target: anchor?.kind ?? 'doc',
    label: d?.label ?? 'GENERAL',
    on: d?.on ?? null,
    src: d?.src ?? null,
    srcUnique: d?.srcUnique ?? false,
    srcWindow: d?.srcWindow ?? false,
    srcEditable: d?.srcEditable ?? true,
    anchorState: anchor?.state ?? 'exact',
    note,
    comments: conv.shown.map((c) => ({
      by: c.by?.name ?? '',
      kind: c.by?.kind ?? 'human',
      body: c.body ?? '',
      at: c.at,
      version: c.version,
      status: c.status ?? null,
      hunk: c.by?.kind === 'agent' ? (t.changes ?? []).find((ch) => ch.version === c.version)?.hunk ?? null : null,
    })),
    earlier: conv.earlier,
    suggestion,
    attachments: d?.crops ?? (t.attachments ?? []).map((a) => attachmentPath(a)),
    attachmentKind: d?.cropKind ?? attachmentKind(anchor),
    apply: pendingSuggestion ? `specreview apply ${snap.doc.id} ${t.id}` : null,
  };
}

/**
 * @param {DraftItem} d
 * @param {Snapshot} snap
 * @param {ReturnType<typeof lineIndex>} li
 * @param {(s: number, e: number) => { start: number, end: number }} mapRange
 * @param {(rel: string) => string} attachmentPath
 */
function draftSummary(d, snap, li, mapRange, attachmentPath) {
  if (d.kind === 'thread') {
    const a = d.anchor;
    const lines = a && a.kind !== 'doc' ? (a.v === snap.head.v ? lineRange(li, mapRange(a.src.start, a.src.end)) : [a.src.startLine, a.src.endLine]) : null;
    return {
      id: d.id,
      kind: 'thread',
      type: d.type,
      severity: d.severity ?? 'normal',
      version: a?.v ?? null,
      lines,
      label: anchorLabel(a),
      on: a?.quote?.exact ? truncate(quoteText(a).replace(/\s+/g, ' ').trim(), 120) : null,
      body: d.body ?? '',
      suggestion: d.suggestion ?? null,
      attachments: (d.attachments ?? []).map((rel) => attachmentPath(rel)),
    };
  }
  if (d.kind === 'reply') return { id: d.id, kind: 'reply', thread: d.thread, body: d.body ?? '', reopen: Boolean(d.reopen) };
  return { id: d.id, kind: d.kind, thread: /** @type {any} */ (d).thread ?? null, body: /** @type {any} */ (d).decision ?? '' };
}

/**
 * @param {ReturnType<typeof lineIndex>} li
 * @param {{ start: number, end: number }} r
 * @returns {[number, number]}
 */
function lineRange(li, r) {
  const a = li.lineOf(r.start);
  const b = r.end > r.start ? li.lineOf(r.end - 1) : a;
  return [a, Math.max(a, b)];
}

/**
 * '§7 Rollout plan' for section locks, else the section plus a short quote.
 * @param {Anchor | null} a
 * @param {string} title
 * @returns {string}
 */
export function lockLabel(a, title) {
  if (!a) return '';
  const sec = sectionPath(a.section, title);
  if (a.kind === 'section') return sec ? `§${sec}` : 'section';
  const what = a.quote?.exact || a.src?.text || '';
  const q = what ? quoteLabel(what, CONTEXT_CHARS) : anchorLabel(a);
  return [sec ? `§${sec}` : '', q].filter(Boolean).join(' ');
}

/**
 * @param {PacketThread} a
 * @param {PacketThread} b
 */
function byFileOrder(a, b) {
  const la = a.lines ? a.lines[0] : Infinity;
  const lb = b.lines ? b.lines[0] : Infinity;
  if (la !== lb) return la - lb;
  const ba = a.severity === 'blocking' ? 0 : 1;
  const bb = b.severity === 'blocking' ? 0 : 1;
  return ba - bb || compareIds(a.id, b.id);
}

/**
 * Whether the doc stands approved, and whether its final version is the current head (so `final` will succeed).
 * `latest` is the newest review being delivered; without one (`feedback` after the approved packet was delivered or
 * lost) the doc's own state decides. A later revise puts the doc back in review, so an older final is not current.
 * @param {Doc} doc
 * @param {Review | null} latest
 * @returns {{ approved: boolean, finalNow: boolean }}
 */
function approvalOf(doc, latest) {
  const finalNow = doc.state === 'approved' && doc.final?.version === doc.head;
  return { approved: latest ? latest.verdict === 'approved' : finalNow, finalNow };
}

/**
 * The NEXT line (without the 'NEXT: ' prefix).
 * @param {Doc} doc
 * @param {{ approved: boolean, finalNow: boolean }} approval
 * @param {number} actionable
 */
function nextStep(doc, { approved, finalNow }, actionable) {
  if (doc.state === 'closed') return 'the review session is closed; stop waiting';
  if (approved && actionable === 0) {
    return finalNow ? `specreview final ${doc.id} --decisions   (then stop waiting)` : 'approved (no final version marked); stop waiting unless the reviewer asks for more';
  }
  // Approved with a final version, but the same submission reopened a thread or answered a question. A revise would
  // make the working copy differ from the final version, so the threads get replies only; a status clears them.
  if (approved && finalNow) {
    return `approved: answer each thread with specreview reply ${doc.id} <tid> -m <md> --status answered|declined (no edits, no new version) -> specreview final ${doc.id} --decisions   (then stop waiting)`;
  }
  if (actionable === 0) return `nothing to act on; specreview wait ${doc.id} (background)`;
  return `edits -> specreview revise ${doc.id} --replies - -> specreview wait ${doc.id} (background)`;
}

/**
 * The NEXT line of a snapshot doc: it is revised by recording new text (`revise --source`), or, for a plan, by
 * editing the plan file and calling ExitPlanMode again (the plan gate records the version).
 * @param {Doc} doc
 * @param {string} ref
 * @param {{ approved: boolean, finalNow: boolean }} approval
 * @param {number} actionable
 */
function snapshotNextStep(doc, ref, { approved, finalNow }, actionable) {
  if (doc.state === 'closed') return 'the review session is closed; stop waiting';
  if (originType(doc) === 'plan') {
    if (approved && actionable === 0) return 'the plan is approved; go ahead with it';
    const file = planFileOf(doc);
    return `targeted Edit-tool changes to the plan file${file ? ` ${file}` : ''} (never rewrite it) -> call ExitPlanMode again (the plan gate records the new version)`;
  }
  if (approved && actionable === 0) {
    return finalNow ? `specreview final ${ref}   (then stop waiting)` : 'approved; stop waiting unless the reviewer asks for more';
  }
  if (approved && finalNow) {
    return `approved: answer each thread with specreview reply ${ref} <tid> -m <md> --status answered|declined (no new version) -> specreview final ${ref}   (then stop waiting)`;
  }
  if (actionable === 0) return `nothing to act on; specreview wait ${ref} (background)`;
  return `write the complete revised text to a file -> specreview revise ${ref} --source <file> --replies - -> specreview wait ${ref} (background)`;
}
