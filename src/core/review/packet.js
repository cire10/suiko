// @ts-check
// Text formatters for everything the engine reports to agents and terminals (design 1.3 "one formatter",
// 3.6 / 3.8 / 3.11 / 3.12 / 9.6). The CLI, the MCP server and the hooks print these strings verbatim; `--json`
// prints the objects they are made from.
//   formatPacket(packet)          feedback packet (wait / feedback), capped at LIMITS.packetChars
//   formatReviseReport(report)    revise result, dry run, refusal (with fix hints), replies-only
//   formatStatus(status)          `suiko status`
//   formatLog(log)                `suiko log`
//   formatDiffStat(changes)       `suiko diff --stat`
//   formatThread(show)            `suiko show <doc> <tid>`
//   formatThreads(list)           `suiko threads`
//   formatApply / formatEdit / formatRevert / formatFinal / formatSourceLines / formatReply / formatAsk
// Output is deterministic: no clocks, no locale-dependent formatting except `hhmm` (local time of day).

import { LIMITS } from '../../shared/protocol.js';
import { linesLabel, sectionLeaf, truncate } from './labels.js';
import { originInfo } from '../store/snapshot.js';

/**
 * @typedef {import('./packet-data.js').Packet} Packet
 * @typedef {import('./packet-data.js').PacketThread} PacketThread
 */

/**
 * Targets whose `on:` (rendered quote) is printed; elements and cells are named by their label instead, and snips by
 * their label, src> lines and picture (their `on`, the visible text in the box, is in the JSON only).
 */
const TEXT_TARGETS = new Set(['text', 'code', 'source']);

/** What each kind of attachment is called in a packet item, and how the agent is told to look at it. */
const ATTACHMENT_LINE = /** @type {Record<string, { tag: string, hint: string }>} */ ({
  region: { tag: 'crop', hint: 'Read it to see the region' },
  snip: { tag: 'image', hint: 'Read it to see what the reviewer snipped' },
  image: { tag: 'image', hint: 'Read it to see the image the reviewer attached' },
});

/**
 * One attachment line of a packet item / `show`: '  image: /abs/.../attachments/a3.png  (Read it to see what the
 * reviewer snipped)'. `kind` is PacketThread.attachmentKind ('region' -> 'crop:', 'snip' / 'image' -> 'image:').
 * @param {string} absPath
 * @param {string | null | undefined} kind
 * @returns {string}
 */
export function attachmentLine(absPath, kind) {
  const l = ATTACHMENT_LINE[kind ?? 'image'] ?? ATTACHMENT_LINE.image;
  return `  ${l.tag}: ${absPath}  (${l.hint})`;
}

const PROTOCOL = [
  'PROTOCOL: targeted edits only; src> lines are exact Edit old_string; edit bottom-up. Suggestions: `suiko apply`.',
  "  Questions: answer in the thread's reply; edit only if the answer belongs in the spec. Unsure: status needs_input.",
];

/**
 * Every packet with threads to act on (not a plan's: plan mode answers in the plan or the chat): replies belong on
 * the threads, where the reviewer reads them in Suiko and the conversation stays with the doc.
 */
const REPLIES = 'REPLIES: answer every thread above on the thread itself, with a status (the reviewer reads replies in Suiko, not in this chat).';

/** The protocol reminder of a snapshot doc (no working file: no `suiko apply`, no Edit of a workspace file). */
const SNAPSHOT_PROTOCOL = [
  'PROTOCOL: change only what the threads ask for and keep the rest of the text as it is; src> lines quote the current version.',
  "  Questions: answer in the thread's reply; change the text only if the answer belongs in it. Unsure: status needs_input.",
];

/** The protocol reminder of a web-page snapshot of a page you build (a private host): change its sources. */
const PAGE_SOURCES_PROTOCOL = [
  'PROTOCOL: the doc is a snapshot of a web page, not a file: change the sources that produce the page (only what the threads ask for), then snapshot it again.',
  "  src> lines quote Suiko's conversion of the page. Questions: answer in the thread's reply. Unsure: status needs_input.",
];

/** The protocol reminder of a public web page's snapshot: there is nothing to edit; threads get replies. */
const PAGE_REPLY_PROTOCOL = [
  'PROTOCOL: the doc is a snapshot of a public web page: there is nothing for you to edit. Answer each thread with a reply',
  '  (status answered, or declined with the reason). Unsure: status needs_input.',
];

/** The protocol reminder of a plan snapshot: the plan file is edited in place. */
const PLAN_PROTOCOL = [
  'PROTOCOL: targeted Edit-tool changes to the plan file only (never rewrite it); src> lines are exact Edit old_string.',
  '  Questions: answer in your reply; change the plan only if the answer belongs in it.',
];

/** The protocol reminder of a code review: repo files, paths relative to the repo root. */
const CODE_PROTOCOL = [
  'PROTOCOL: Read each cited file (or range) before editing; paths are relative to the repo root above; src> lines are exact Edit old_string for that file; edit bottom-up per file.',
  "  Suggestions: `suiko apply`. Questions: answer in the thread's reply; change code only if the answer needs it. Unsure: status needs_input.",
];

/** @param {string | null | undefined} v */
export function verdictLabel(v) {
  return String(v ?? '').replace(/_/g, ' ').toUpperCase();
}

/**
 * @param {number} n
 * @param {string} one
 * @param {string} [many]
 */
function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Indents continuation lines of a multi-line body.
 * @param {string} body
 * @param {string} indent
 */
function indentBody(body, indent) {
  return String(body ?? '').replace(/\r\n/g, '\n').trimEnd().split('\n').join(`\n${indent}`);
}

/**
 * 'HH:MM' local time of an ISO timestamp ('' when invalid).
 * @param {string | null | undefined} iso
 */
export function hhmm(iso) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ------------------------------------------------------------------------------------------------ packet

/**
 * @param {Packet} packet
 * @param {{ maxChars?: number }} [opts]
 * @returns {string}
 */
export function formatPacket(packet, opts = {}) {
  const maxChars = opts.maxChars ?? LIMITS.packetChars;
  const p = packet;
  if (p.kind === 'code') return formatCodePacket(p, maxChars);
  /** @type {string[]} */
  const head = [packetHeader(p)];
  const snapshot = p.kind === 'snapshot';
  // The workspace root is not the agent's cwd (a non-git project whose .specreview/ sits next to the spec):
  // name the file as it is reached from there. A snapshot has no working file; a plan snapshot names its plan file.
  if (snapshot) {
    if (p.origin === 'plan' && p.file) head.push(`Plan file: ${p.file}`);
  } else if (p.pathFromCwd && p.pathFromCwd !== p.path) head.push(`File: ${p.pathFromCwd} (from your working directory)`);
  const items = p.threads;
  if (items.length) head.push(lineBasis(p));
  for (const r of p.reviews) {
    if (!r.body?.trim()) continue;
    const tag = p.reviews.length > 1 ? ` (${r.id})` : '';
    head.push(`Reviewer summary${tag}: ${indentBody(r.body, '  ')}`);
  }
  head.push(countsLine(p));
  if (p.reviews.length === 0 && p.drafts) {
    head.push(`0 submitted reviews pending; ${plural(p.drafts.length, 'DRAFT comment')} not yet submitted (ask the reviewer to click Submit review)`);
  }

  /** @type {string[]} */
  const footer = [];
  const approvedDone = p.verdict === 'approved' && p.counts.actionable === 0;
  if (!approvedDone) {
    footer.push(`LOCKED (agreed - do not modify): ${p.locks.length ? p.locks.map((l) => `${l.id} ${l.label}${l.lines ? ` (${linesLabel(l.lines)})` : ' (orphaned)'}`).join(' · ') : '(none)'}`);
    footer.push(`DECISIONS to keep true: ${p.decisions.length ? p.decisions.map((d) => `${d.id} (${d.thread}) ${oneLine(d.text, 160)}`).join(' · ') : '(none yet)'}`);
  }
  if (p.drafts && p.drafts.length) {
    footer.push('DRAFTS (not submitted - do not act on them):');
    for (const d of p.drafts) footer.push(`  ${draftLine(/** @type {any} */ (d))}`);
  }
  if (p.replyOnly) footer.push(`APPROVED with FINAL = v${p.final?.version}: reply to each thread; do not edit the spec (it must stay identical to the final version).`);
  else if (p.firstPacket && !approvedDone && items.length) footer.push(...protocolLines(p));
  if (!p.replyOnly && !approvedDone && p.counts.actionable > 0 && !(snapshot && p.origin === 'plan')) footer.push(REPLIES);
  footer.push(`NEXT: ${nextText(p)}`);

  return assemble(head, items, footer, maxChars, p.ref ?? p.doc);
}

/**
 * The packet of a code review (design 4.10): the code label in the header, the basis lines (Repo root first), items
 * in the code grammar (`path:L42-44`, `(new file)`, `(old side)` with was> lines, `FILE MISSING`), no LOCKED line,
 * the code PROTOCOL.
 * @param {Packet} p
 * @param {number} maxChars
 * @returns {string}
 */
function formatCodePacket(p, maxChars) {
  /** @type {string[]} */
  const head = [packetHeader(p)];
  const items = p.threads;
  if (items.length) head.push(...(p.basis ?? []));
  for (const r of p.reviews) {
    if (!r.body?.trim()) continue;
    const tag = p.reviews.length > 1 ? ` (${r.id})` : '';
    head.push(`Reviewer summary${tag}: ${indentBody(r.body, '  ')}`);
  }
  head.push(countsLine(p));
  if (p.reviews.length === 0 && p.drafts) {
    head.push(`0 submitted reviews pending; ${plural(p.drafts.length, 'DRAFT comment')} not yet submitted (ask the reviewer to click Submit review)`);
  }

  /** @type {string[]} */
  const footer = [];
  const approvedDone = p.verdict === 'approved' && p.counts.actionable === 0;
  if (!approvedDone) footer.push(`DECISIONS to keep true: ${p.decisions.length ? p.decisions.map((d) => `${d.id} (${d.thread}) ${oneLine(d.text, 160)}`).join(' · ') : '(none yet)'}`);
  if (p.drafts && p.drafts.length) {
    footer.push('DRAFTS (not submitted - do not act on them):');
    for (const d of p.drafts) footer.push(`  ${draftLine(/** @type {any} */ (d))}`);
  }
  if (p.replyOnly) footer.push(`APPROVED with FINAL = v${p.final?.version}: reply to each thread; do not change the reviewed files (they must stay identical to the final version).`);
  else if (p.firstPacket && !approvedDone && items.length) footer.push(...CODE_PROTOCOL);
  if (!p.replyOnly && !approvedDone && p.counts.actionable > 0) footer.push(REPLIES);
  footer.push(`NEXT: ${nextText(p)}`);
  return assemble(head, items, footer, maxChars, p.ref ?? p.doc);
}

/**
 * Header lines, the thread blocks (as many as fit in maxChars; the rest listed with their `show` command) and the
 * footer lines, as the packet text.
 * @param {string[]} head
 * @param {PacketThread[]} items
 * @param {string[]} footer
 * @param {number} maxChars
 * @param {string} ref the doc as commands name it
 * @returns {string}
 */
function assemble(head, items, footer, maxChars, ref) {
  const headText = head.join('\n');
  const footText = footer.join('\n');
  let budget = maxChars - headText.length - footText.length - 4;
  /** @type {string[]} */
  const blocks = [];
  /** @type {PacketThread[]} */
  const overflow = [];
  for (const t of items) {
    if (overflow.length) {
      overflow.push(t);
      continue;
    }
    const block = formatPacketThread(t, ref);
    if (block.length + 2 > budget && blocks.length) {
      overflow.push(t);
      continue;
    }
    blocks.push(block);
    budget -= block.length + 2;
  }
  if (overflow.length) {
    blocks.push(
      [`(${plural(overflow.length, 'more thread')} - packet size cap; run the commands to see them)`, ...overflow.map((t) => `${itemHeader(t)} · suiko show ${ref} ${t.id}`)].join('\n'),
    );
  }
  const parts = [headText];
  if (blocks.length) parts.push(blocks.join('\n\n'));
  parts.push(footText);
  return `${parts.join('\n\n')}\n`;
}

/**
 * The plan gate's feedback for Claude Code when a plan is not approved (the `message` of the PermissionRequest
 * deny): the packet's threads with their src> lines, citing the real plan file and its line numbers, and what to do
 * next: targeted Edit-tool changes to that file, every thread addressed, ExitPlanMode again.
 * @param {Packet} packet a plan snapshot's packet
 * @param {{ planFilePath?: string | null, maxChars?: number }} [opts]
 * @returns {string}
 */
export function formatPlanFeedback(packet, opts = {}) {
  const p = packet;
  const file = opts.planFilePath ?? p.file ?? null;
  const maxChars = opts.maxChars ?? LIMITS.packetChars;
  const ids = p.reviews.map((r) => r.id).join(', ');
  const versions = [...new Set(p.reviews.map((r) => r.version))].sort((a, b) => a - b);
  const on = versions.length ? ` on v${versions[versions.length - 1]}` : '';
  const what = p.verdict === 'changes_requested' ? 'the reviewer requested changes' : 'the reviewer commented on it';
  /** @type {string[]} */
  const head = [`YOUR PLAN WAS NOT APPROVED: ${what} (Suiko ${ids || 'review'}${on}).`];
  head.push(file ? `Plan file: ${file}   (line numbers below are lines of this file)` : `The plan has no plan file: line numbers below are lines of the plan text you submitted.`);
  for (const r of p.reviews) {
    if (!r.body?.trim()) continue;
    const tag = p.reviews.length > 1 ? ` (${r.id})` : '';
    head.push(`Reviewer summary${tag}: ${indentBody(r.body, '  ')}`);
  }
  head.push(countsLine(p));

  /** @type {string[]} */
  const footer = [];
  if (p.locks.length) footer.push(`LOCKED (agreed - do not modify): ${p.locks.map((l) => `${l.id} ${l.label}${l.lines ? ` (${linesLabel(l.lines)})` : ''}`).join(' · ')}`);
  if (p.decisions.length) footer.push(`DECISIONS to keep true: ${p.decisions.map((d) => `${d.id} (${d.thread}) ${oneLine(d.text, 160)}`).join(' · ')}`);
  footer.push('WHAT TO DO:');
  if (file) {
    footer.push(`- Make targeted changes to ${file} with the Edit tool (src> lines are exact old_string). Never rewrite the whole plan or write a new plan file.`);
  } else {
    footer.push('- Revise the plan: change only what the threads ask for and keep the rest as it is.');
  }
  footer.push('- Address every thread above: change the plan where a thread asks for it; answer questions in the plan (or tell the user, if the answer does not belong in it).');
  footer.push(`- Then call ExitPlanMode again. The reviewer will see a diff of your changes (v${p.head} -> v${p.head + 1}) and approve or comment again.`);
  return assemble(head, p.threads, footer, maxChars, p.ref ?? p.doc);
}

/** @param {Packet} p */
function packetHeader(p) {
  const name =
    p.kind === 'code' ? `${p.doc} (code review${p.code?.label ? `: ${p.code.label}` : ''})` : p.firstPacket ? `${p.doc} (${p.kind === 'snapshot' ? originInfo(p.origin ?? '').label : p.path})` : p.doc;
  /** @type {string[]} */
  const parts = ['SPECREVIEW FEEDBACK', name];
  if (!p.reviews.length) {
    parts.push(`no new review · head v${p.head}`);
  } else {
    const ids = p.reviews.map((r) => r.id);
    const versions = [...new Set(p.reviews.map((r) => r.version))].sort((a, b) => a - b);
    const on = versions.length === 1 ? `v${versions[0]}` : `v${versions[0]}-v${versions[versions.length - 1]}`;
    parts.push(`${ids.length === 1 ? 'review' : 'reviews'} ${ids.join(', ')} on ${on}`);
    parts.push(verdictLabel(p.verdict));
    if (p.final && ids.includes(p.final.review)) parts.push(`FINAL = v${p.final.version}`);
  }
  if (p.working === 'missing') parts.push('WORKING COPY MISSING');
  return parts.join(' · ');
}

/**
 * The protocol reminder for the kind of doc.
 * @param {Packet} p
 * @returns {string[]}
 */
function protocolLines(p) {
  if (p.kind !== 'snapshot') return PROTOCOL;
  if (p.origin === 'plan') return PLAN_PROTOCOL;
  if (p.origin === 'url' && p.page) return p.page.private ? PAGE_SOURCES_PROTOCOL : PAGE_REPLY_PROTOCOL;
  return SNAPSHOT_PROTOCOL;
}

/**
 * '2026-10-11 14:02 UTC' ('' when invalid).
 * @param {string | null | undefined} iso
 */
function utcMinute(iso) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return '';
  return `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** @param {Packet} p */
function lineBasis(p) {
  if (p.kind === 'snapshot' && p.origin === 'url' && p.page) {
    const when = utcMinute(p.page.fetchedAt);
    return `Line numbers = lines of Suiko's ${p.page.format === 'html' ? 'HTML' : 'Markdown'} snapshot of ${p.page.finalUrl}${when ? ` (fetched ${when})` : ''}; there is no file for you to edit.`;
  }
  if (p.kind === 'snapshot') {
    return p.origin === 'plan' && p.file
      ? `Line numbers = lines of the plan file as submitted (v${p.head}).`
      : `Line numbers = v${p.head} of this ${originInfo(p.origin ?? '').noun} (\`suiko show ${p.ref ?? p.doc}\` prints it).`;
  }
  if (p.working === 'missing') return `Line numbers = v${p.head} (the working copy is missing; restore it before editing).`;
  if (p.working === 'dirty') return `Line numbers = current file on disk (working copy differs from v${p.head}: lines mapped).`;
  return `Line numbers = current file on disk (identical to v${p.head}).`;
}

/** @param {Packet} p */
function countsLine(p) {
  const c = p.counts;
  const need = `${plural(c.actionable, 'thread')} ${c.actionable === 1 ? 'needs' : 'need'} action`;
  if (p.verdict === 'approved' && c.actionable === 0) {
    return `${need} · ${c.resolved} resolved · ${c.unresolved} open`;
  }
  const resolved = c.resolvedThisRound ? `   (${c.resolvedThisRound} resolved this round)` : '';
  if (c.actionable === 0) {
    const waiting = c.awaitingReviewer ? ` · ${plural(c.awaitingReviewer, 'thread')} awaiting the reviewer` : '';
    return `${need}${waiting}${resolved}`;
  }
  const actionable = p.threads.filter((t) => t.why !== 'awaiting');
  if (c.new === c.actionable) return `${need} (${c.new} new): ${typeBreakdown(actionable)}${resolved}`;
  /** @type {string[]} */
  const parts = [];
  if (c.new) parts.push(`${c.new} new`);
  if (c.reopened) parts.push(`${c.reopened} reopened`);
  if (c.reply) parts.push(plural(c.reply, 'reply', 'replies'));
  if (c.answer) parts.push(c.answer === 1 ? '1 answer to your question' : `${c.answer} answers to your questions`);
  if (c.open) parts.push(`${c.open} still open`);
  return `${need}: ${parts.join(' · ')}${resolved}`;
}

/**
 * '1 blocking · 1 question · 1 suggestion · 1 comment' (types counted among non-blocking threads).
 * @param {PacketThread[]} threads
 */
function typeBreakdown(threads) {
  /** @type {string[]} */
  const parts = [];
  const blocking = threads.filter((t) => t.severity === 'blocking').length;
  if (blocking) parts.push(`${blocking} blocking`);
  for (const type of ['question', 'suggestion', 'comment', 'agent-question']) {
    const n = threads.filter((t) => t.severity !== 'blocking' && t.type === type).length;
    if (n) parts.push(type === 'agent-question' ? `${n} answered question${n === 1 ? '' : 's'}` : plural(n, type));
  }
  return parts.join(' · ');
}

/** @param {Packet} p */
function nextText(p) {
  if (p.next.includes('--replies - ->')) return p.next.replace('--replies - ->', '--replies - (JSON, one entry per thread) ->');
  return p.next;
}

/** @param {PacketThread} t */
function whyLabel(t) {
  switch (t.why) {
    case 'reopened':
      return 'REOPENED';
    case 'reply':
      return 'REPLY';
    case 'answer':
      return 'ANSWER';
    case 'open':
      return 'STILL OPEN';
    case 'awaiting':
      return 'AWAITING REVIEWER';
    default:
      return '';
  }
}

/**
 * '[t1] blocking · comment · L42-43 · §3 Tokens > 3.2 Token refresh'.
 * @param {PacketThread} t
 */
export function itemHeader(t) {
  /** @type {string[]} */
  const parts = [];
  const why = whyLabel(t);
  if (why) parts.push(why);
  if (t.severity && t.severity !== 'normal') parts.push(t.severity);
  parts.push(t.type);
  if (isCodeItem(t)) {
    parts.push(codeLocation(t));
    if (t.apply) parts.push(`apply verbatim: ${t.apply}`);
    return `[${t.id}] ${parts.join(' · ')}`;
  }
  if (t.target === 'doc') parts.push('GENERAL');
  else if (t.lines) parts.push(`${linesLabel(t.lines)}${t.note && t.anchorState === 'changed' ? ` ${t.note}` : ''}`);
  else if (t.note) parts.push(t.note);
  if (t.sectionLabel) parts.push(`§${t.sectionLabel}`);
  if (t.label && t.label !== 'text' && t.target !== 'doc' && t.target !== 'section') parts.push(t.label);
  if (t.apply) parts.push(`apply verbatim: ${t.apply}`);
  return `[${t.id}] ${parts.join(' · ')}`;
}

/**
 * Whether a packet item is a code item (code packets always carry `file`, null for a whole-review thread).
 * @param {PacketThread} t
 */
function isCodeItem(t) {
  return t.file !== undefined;
}

/**
 * Where a code item is: 'src/a.js:L42-44', 'src/a.js:L1 (new file)', 'src/a.js (old side) base L12-14, now between
 * L11-12', 'src/a.js (whole file)', 'GENERAL' (the whole review). Paths are repo-root-relative.
 * @param {PacketThread} t
 * @returns {string}
 */
function codeLocation(t) {
  if (!t.file) return t.note && t.anchorState === 'orphaned' ? `GENERAL ${t.note}` : 'GENERAL';
  if (t.anchorState === 'orphaned') return `${t.file} ${t.note ?? '(orphaned)'}`;
  const changed = t.note && t.anchorState === 'changed' ? ` ${t.note}` : '';
  if (t.side === 'old') {
    const base = t.lines ? ` base ${linesLabel(t.lines)}` : '';
    const now = t.nowBetween ? `, now between ${linesLabel(t.nowBetween)}` : '';
    return `${t.file} (old side)${base}${now}${changed}`;
  }
  if (!t.lines) return `${t.file} (whole file)`;
  return `${t.file}:${linesLabel(t.lines)}${t.fileStatus === 'A' ? ' (new file)' : ''}${changed}`;
}

/** What a code item says about its file when it cannot quote it from the working tree. */
const FILE_STATE_LINE = /** @type {Record<string, string>} */ ({
  missing: 'FILE MISSING in your working tree (restore it, or reply declined/answered explaining the deletion)',
  'not-checked-out': '(the file is not in your working tree: check out the reviewed revision to edit it)',
  binary: '(binary file: nothing to quote)',
  'too-large': '(file too large to quote: Read it)',
});

/**
 * @param {PacketThread} t
 * @param {string} docId
 * @returns {string}
 */
export function formatPacketThread(t, docId) {
  const out = [itemHeader(t)];
  const code = isCodeItem(t);
  const sug = /** @type {any} */ (t.suggestion);
  const showSuggestion = sug && sug.status !== 'applied';
  if (code && t.fileState && FILE_STATE_LINE[t.fileState]) out.push(`  ${FILE_STATE_LINE[t.fileState]}`);
  if (t.on && !showSuggestion && TEXT_TARGETS.has(t.target)) out.push(`  on: "${t.on}"`);
  if (showSuggestion) {
    for (const l of String(sug.old ?? '').split('\n')) out.push(`  - ${l}`);
    for (const l of String(sug.new ?? '').split('\n')) out.push(`  + ${l}`);
    if (sug.status === 'staged') out.push('  (staged: already applied to the working copy, not recorded yet)');
    if (sug.status === 'conflict') out.push('  (conflict: the expected text was not found; treat it as a normal comment)');
  }
  if (code) for (const l of t.was ?? []) out.push(`  was> ${l}`);
  if (t.src != null && (!showSuggestion || sug.status === 'conflict')) {
    for (const l of t.src.split('\n')) out.push(`  src> ${l}`);
    if (!t.srcEditable) out.push('  (data: URIs elided above; Read the file for the exact text)');
    else if (code && !t.srcUnique && t.lines) out.push(`  (not unique in the file: Read around L${t.lines[0]} before editing)`);
    else if (!t.srcUnique && t.lines) out.push(`  (src> is shortened or not unique; Read around ${linesLabel(t.lines)} before editing)`);
  }
  const kind = t.attachmentKind ?? (t.label.includes('region') ? 'region' : 'image');
  for (const a of t.attachments ?? []) out.push(attachmentLine(a, kind));
  // One older comment is the reviewer's original request, which the agent already acted on (design 3.11).
  if (t.earlier >= 2) out.push(`  (+${t.earlier} earlier, suiko show ${docId} ${t.id})`);
  for (const c of t.comments) {
    const body = String(c.body ?? '').trim() ? `: ${indentBody(c.body, '    ')}` : '';
    if (c.kind === 'agent') {
      // a reply without a message (status only) still says what the agent did; the default status is elided only
      // when there is a message to read
      const status = c.status && (c.status !== 'addressed' || !body) ? `, ${c.status}` : '';
      if (body || status) out.push(`  ${c.by} (v${c.version}${status})${body}`);
    } else if (body) {
      out.push(`  ${c.by}${body}`);
    }
  }
  return out.join('\n');
}

/** @param {any} d */
function draftLine(d) {
  if (d.kind === 'thread') {
    const where = d.file !== undefined ? (d.file ? `${d.file}${d.side === 'old' ? ' (old side)' : ''}${d.lines ? `:${linesLabel(d.lines)}` : ''}` : 'GENERAL') : d.lines ? linesLabel(d.lines) : d.label;
    const on = d.on ? ` "${truncate(d.on, 60)}"` : '';
    return `[${d.id}] ${d.type} · ${where}${on}: ${oneLine(d.body, 200)}`;
  }
  if (d.kind === 'reply') return `[${d.id}] ${d.reopen ? 'reopen' : 'reply'} ${d.thread}: ${oneLine(d.body, 200)}`;
  return `[${d.id}] ${d.kind} ${d.thread ?? ''}`;
}

/**
 * @param {string} s
 * @param {number} max
 */
function oneLine(s, max) {
  return truncate(String(s ?? '').replace(/\s+/g, ' ').trim(), max);
}

// ------------------------------------------------------------------------------------------------ revise

/**
 * @param {any} r ReviseReport (see ops/revise.js)
 * @returns {string}
 */
export function formatReviseReport(r) {
  const doc = r.doc;
  const ref = r.ref ?? doc;
  const same = r.snapshot ? `the text is identical to v${r.from}` : `working copy matches v${r.from}`;
  if (r.nothing) return `suiko: nothing to record (${same}, no replies)\n`;
  /** @type {string[]} */
  const out = [];
  if (r.repliesOnly) {
    out.push(`suiko: ${same}; posted ${plural(r.replies.length, 'reply', 'replies')} (no new version)`);
    for (const rep of r.replies) out.push(`  ${rep.thread} ${rep.status}`);
    out.push(`next: suiko wait ${ref} (background)`);
    return `${out.join('\n')}\n`;
  }
  if (r.refused) {
    out.push(r.dryRun ? 'suiko: dry run - would be REFUSED (exit 3)' : 'suiko: REFUSED - nothing recorded (exit 3)');
    for (const e of r.guards.errors) {
      out.push(`  ERR ${e.code}: ${e.message}`);
      if (e.fix) out.push(`      fix: ${e.fix}`);
    }
    for (const w of r.guards.warnings) out.push(`  WARN ${w.message}`);
    out.push(r.dryRun ? 'working copy left untouched.' : 'working copy left untouched. Preview with --dry-run.');
    return `${out.join('\n')}\n`;
  }
  const stats = `+${r.stats.added} -${r.stats.removed} lines, ${plural(r.stats.hunks, 'hunk')}`;
  const responds = r.respondsTo ? ` · responds to ${r.respondsTo}` : '';
  out.push(r.dryRun
    ? `suiko: dry run - would record v${r.version} for ${doc} (${stats})${responds}; nothing recorded`
    : `suiko: recorded v${r.version} for ${doc} (${stats})${responds}`);
  out.push(...hunkTable(r.hunks, r.replies));
  for (const a of r.assets ?? []) out.push(`  asset ${a.path} changed${a.threads?.length ? ` -> ${a.threads.join(', ')}` : ''}`);
  const linked = new Set((r.hunks ?? []).flatMap((/** @type {any} */ h) => h.threads));
  const assetThreads = new Set((r.assets ?? []).flatMap((/** @type {any} */ a) => a.threads ?? []));
  for (const rep of r.replies) {
    if (!linked.has(rep.thread) && !assetThreads.has(rep.thread)) out.push(`  ${rep.thread} ${rep.status} (reply only)`);
  }
  out.push(guardsLine(r));
  for (const e of r.guards.errors) out.push(`  ERR (forced) ${e.code}: ${e.message}`);
  for (const w of r.guards.warnings) out.push(`  WARN ${w.message}`);
  if (r.anchors) {
    const a = r.anchors;
    out.push(`anchors: ${plural(a.threads, 'thread')} + ${plural(a.locks, 'lock')} -> ${a.exact} exact, ${a.moved} moved, ${a.edited} edited, ${a.changed} changed, ${a.orphaned} orphaned`);
  }
  if (r.git?.commit) out.push(`git: committed ${String(r.git.commit).slice(0, 12)}`);
  else if (r.git?.error) out.push(`git: auto-commit failed: ${oneLine(r.git.error, 200)}`);
  if (!r.dryRun) out.push(`reviewer notified. next: suiko wait ${ref} (background)`);
  return `${out.join('\n')}\n`;
}

/**
 * Section column of hunk tables (design 3.5 / 9.2): '§3.2 Token refresh', 'front matter', or '(top)' before any heading.
 * @param {string | undefined | null} leaf
 * @returns {string}
 */
function sectionCell(leaf) {
  if (!leaf) return '(top)';
  return leaf === 'front matter' ? leaf : `§${leaf}`;
}

/**
 * Aligned 'h1 L42-46  §3.2 Token refresh  -> t1 addressed  (overlap)' rows.
 * @param {any[]} hunks
 * @param {Array<{ thread: string, status: string }>} replies
 * @returns {string[]}
 */
function hunkTable(hunks, replies) {
  const status = new Map((replies ?? []).map((r) => [r.thread, r.status]));
  const rows = (hunks ?? []).map((h) => {
    const where = h.newRange ? linesLabel(h.newRange) : `del v${h.fromVersion ?? ''} ${linesLabel(h.oldRange)}`.replace('del v ', 'del ');
    const section = sectionCell(h.section);
    let target;
    if (h.threads.length) {
      const ts = h.threads.map((/** @type {string} */ t) => (status.get(t) ? `${t} ${status.get(t)}` : t)).join(', ');
      const how = h.linkedBy ? `  (${h.linkedBy}${h.via ? `: ${h.via}` : ''})` : '';
      target = `-> ${ts}${how}${h.other ? `  [other: ${oneLine(h.other, 80)}]` : ''}`;
    } else if (h.other != null) {
      target = `-> other: ${oneLine(h.other, 120)}`;
    } else {
      target = '-> (unlinked)';
    }
    return { a: `${h.id} ${where}`, b: section, c: target };
  });
  const wa = Math.max(0, ...rows.map((r) => r.a.length));
  const wb = Math.max(0, ...rows.map((r) => r.b.length));
  return rows.map((r) => `  ${r.a.padEnd(wa)}  ${r.b.padEnd(wb)}  ${r.c}`);
}

/** @param {any} r */
function guardsLine(r) {
  const g = r.guards;
  /** @type {string[]} */
  const parts = [g.forced ? 'FORCED (--force)' : g.errors.length ? 'errors' : 'ok'];
  for (const id of g.intactLocks ?? []) parts.push(`lock ${id} untouched`);
  for (const id of g.brokenLocks ?? []) parts.push(`lock ${id} BROKEN`);
  const unexplainedBig = g.errors.filter((/** @type {any} */ e) => e.code === 'deletion').length + g.warnings.filter((/** @type {any} */ w) => w.code === 'deletion').length;
  parts.push(unexplainedBig ? `${plural(unexplainedBig, 'unexplained deletion')}` : 'no unexplained deletions');
  parts.push(`rewrite ${Math.round((g.rewriteRatio ?? 0) * 100)}%`);
  return `guards: ${parts.join(' · ')}`;
}

// ------------------------------------------------------------------------------------------------ status / log / diff

/**
 * @param {any} s result of ops.status
 * @returns {string}
 */
export function formatStatus(s) {
  if (!s.docs.length) return 'suiko: no tracked docs in this workspace (run suiko open <file>)\n';
  /** @type {string[]} */
  const out = [];
  for (const d of s.docs) {
    const head = d.head ? `head v${d.head}${d.headAuthor ? ` (${d.headAuthor}${d.headAt ? `, ${hhmm(d.headAt)}` : ''})` : ''}` : 'no versions';
    const final = d.final ? `  FINAL = v${d.final.version}` : '';
    const where = d.kind === 'code' ? '(code review)' : d.kind === 'snapshot' ? `(${originInfo(d.origin ?? '').label})` : d.path;
    out.push(`${d.doc}  ${where}  ${head}  ${d.state}${final}`);
    if (d.kind !== 'snapshot' && d.pathFromCwd && d.pathFromCwd !== d.path) out.push(`  file: ${d.pathFromCwd} (from your working directory)`);
    const c = d.counts;
    out.push(`  threads: open ${c.open} · addressed ${c.addressed} · answered ${c.answered} · declined ${c.declined} · needs_input ${c.needs_input} · resolved ${c.resolved} · outdated ${c.outdated}   locks: ${d.locks.length ? d.locks.join(' ') : 'none'}`);
    const last = d.lastReview ? `last review ${d.lastReview.id} on v${d.lastReview.version}` : 'no reviews yet';
    const und = d.undelivered.length ? d.undelivered.join(', ') : 'none';
    out.push(`  reviewer: ${last} · drafts ${d.drafts} · undelivered reviews: ${und}`);
    const listening = d.listening.length ? d.listening.map((/** @type {any} */ w) => `${w.agent} (pid ${w.pid})`).join(', ') : 'nobody';
    out.push(`  listening: ${listening}${d.kind === 'code' ? `   working tree: ${d.working}` : d.kind === 'snapshot' ? '' : `   working copy: ${d.working}`}`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * @param {any} l result of ops.log
 * @returns {string}
 */
export function formatLog(l) {
  /** @type {string[]} */
  const out = [];
  const rows = l.entries.map((/** @type {any} */ e) => {
    if (e.kind === 'version') {
      const what = e.v === 1 && !e.stats ? `${e.lines} lines` : `+${e.stats?.added ?? 0} -${e.stats?.removed ?? 0}`;
      const extra = e.other ? ` (+${e.other} other)` : '';
      const flags = [e.forced ? 'FORCED' : '', e.brokenLocks?.length ? `lock broken: ${e.brokenLocks.join(' ')}` : ''].filter(Boolean).join(' ');
      return { a: `v${e.v}`, b: `${e.author.kind} ${e.author.name}`, c: hhmm(e.at), d: truncate(e.summary || '', 48), e: what, f: `${e.threads.join(' ')}${extra}${flags ? `  ${flags}` : ''}`.trim() };
    }
    const resolved = e.resolved.length ? `${e.resolved.join(', ')} resolved` : '';
    const decisions = e.decisions.length ? e.decisions.join(', ') : '';
    const detail = [resolved, decisions].filter(Boolean).join('; ');
    const locks = e.locksAdded.length ? `, lock${e.locksAdded.length > 1 ? 's' : ''} ${e.locksAdded.join(' ')}` : '';
    const final = e.markFinal ? ', FINAL' : '';
    return { a: '', b: `${e.id}  ${e.by}`, c: hhmm(e.at), d: verdictLabel(e.verdict).replace(/ /g, '_'), e: `${plural(e.threads, 'thread')}${detail ? ` (${detail})` : ''}${locks}${final}`, f: '' };
  });
  const w = (/** @type {'a'|'b'|'c'|'d'|'e'} */ k) => Math.max(0, ...rows.filter((/** @type {any} */ r) => r.a).map((/** @type {any} */ r) => r[k].length));
  const [wa, wb, wd, we] = [w('a'), w('b'), w('d'), w('e')];
  for (const r of rows) {
    if (r.a) out.push(`${r.a.padEnd(wa)}  ${r.b.padEnd(wb)}  ${r.c}  ${r.d.padEnd(wd)}  ${r.e.padEnd(we)}  ${r.f}`.trimEnd());
    else out.push(`${''.padEnd(wa)}  ${r.b}  ${r.c}  ${r.d}  ${r.e}`.trimEnd());
  }
  out.push(`final: ${l.final ? `v${l.final.version} (${l.final.review}, ${l.final.by})` : 'none'}`);
  return `${out.join('\n')}\n`;
}

/**
 * @param {any} c result of ops.changes
 * @returns {string}
 */
export function formatDiffStat(c) {
  const out = [`v${c.from}..${c.to === 'live' ? 'live' : `v${c.to}`}  +${c.stats.added} -${c.stats.removed}  ${plural(c.stats.hunks, 'hunk')}`];
  const rows = c.hunks.map((/** @type {any} */ h) => {
    const where = h.new.lines > 0 ? linesLabel([h.new.start, h.new.start + h.new.lines - 1]) : `del ${linesLabel([h.old.start, h.old.start + h.old.lines - 1])}`;
    const sec = sectionCell(sectionLeaf(h.section));
    const link = h.threads?.length ? `${h.threads.join(' ')}${h.linkedBy ? ` (${h.linkedBy})` : ''}` : h.other != null ? `other: ${oneLine(h.other, 100)}` : '(unlinked)';
    return { a: `${h.id} ${where}`, b: sec, c: link };
  });
  const wa = Math.max(0, ...rows.map((/** @type {any} */ r) => r.a.length));
  const wb = Math.max(0, ...rows.map((/** @type {any} */ r) => r.b.length));
  for (const r of rows) out.push(`  ${r.a.padEnd(wa)}  ${r.b.padEnd(wb)}  ${r.c}`);
  const changed = (c.assets ?? []).map((/** @type {any} */ a) => a.path);
  out.push(`  assets: ${changed.length ? `${changed.join(', ')} changed` : 'unchanged'}`);
  return `${out.join('\n')}\n`;
}

// ------------------------------------------------------------------------------------------------ threads

/**
 * @param {any} s result of ops.show for a thread
 * @returns {string}
 */
export function formatThread(s) {
  const t = s.thread;
  const a = s.anchor;
  const parts = [t.type];
  if (t.severity && t.severity !== 'normal') parts.push(t.severity);
  parts.push(s.statusLabel);
  parts.push(a ? `anchor ${a.state} (v${a.v}${a.lines ? ` ${linesLabel(a.lines)}` : ''})` : 'no anchor');
  if (s.label && s.label !== 'text') parts.push(s.label);
  const out = [`[${t.id}] ${parts.join(' · ')}`];
  if (s.on) out.push(`  on: "${s.on}"`);
  for (const e of s.timeline) {
    const body = String(e.body ?? '').trim() ? `: ${indentBody(e.body, '    ')}` : '';
    if (!body && !(e.kind === 'agent' && e.status)) continue; // nothing to show (e.g. a suggestion without a comment)
    const meta = e.kind === 'agent' ? [e.status, e.hunk].filter(Boolean).join(', ') : e.review ?? '';
    out.push(`  v${e.version} ${e.by}${meta ? ` (${meta})` : ''}${body}`);
  }
  for (const ch of s.changes ?? []) {
    out.push(`  change v${ch.from}->v${ch.to} ${ch.hunk}:  - ${oneLine(ch.before, 100) || '(nothing)'}  + ${oneLine(ch.after, 100) || '(nothing)'}`);
  }
  if (t.decision?.text) out.push(`  decision ${t.decision.id}: ${t.decision.text}`);
  if (t.suggestion) out.push(`  suggestion (${t.suggestion.status}${t.suggestion.appliedIn ? ` in v${t.suggestion.appliedIn}` : ''}): - ${oneLine(t.suggestion.old, 100)}  + ${oneLine(t.suggestion.new, 100)}`);
  return `${out.join('\n')}\n`;
}

/**
 * @param {any} list result of ops.threads
 * @returns {string}
 */
export function formatThreads(list) {
  if (!list.threads.length) return `no threads (${list.filter})\n`;
  return `${list.threads
    .map((/** @type {any} */ t) => {
      const lines =
        t.file !== undefined ? (t.file ? `${t.file}${t.side === 'old' ? ' (old side)' : ''}${t.lines ? `:${linesLabel(t.lines)}` : ''}` : 'GENERAL') : t.lines ? linesLabel(t.lines) : t.target === 'doc' ? 'GENERAL' : '-';
      const state = t.anchorState && t.anchorState !== 'exact' ? ` (${t.anchorState})` : '';
      return `${t.id}  ${t.status}${t.actionable ? '*' : ''}  ${t.type}${t.severity !== 'normal' ? ` ${t.severity}` : ''}  ${lines}${state}  ${t.sectionLabel ? `§${t.sectionLabel}  ` : ''}${oneLine(t.summary, 80)}`;
    })
    .join('\n')}\n`;
}

// ------------------------------------------------------------------------------------------------ edits and misc

/**
 * @param {any} r result of ops.applySuggestions
 * @returns {string}
 */
export function formatApply(r) {
  const out = [];
  for (const a of r.applied) out.push(`${r.dryRun ? 'would apply' : 'applied'} ${a.id} at ${a.file ? `${a.file}:` : ''}${linesLabel(a.lines)} (${a.how}) · ${r.dryRun ? 'dry run' : 'staged (not recorded yet)'}`);
  for (const s of r.skipped ?? []) out.push(`skipped ${s.id}: ${s.reason}`);
  for (const c of r.conflicts) out.push(`conflict ${c.id}: ${c.reason}`);
  if (r.applied.length && !r.dryRun) out.push('re-read the file before any further Edit (apply rewrote it)');
  return `${out.join('\n')}\n`;
}

/**
 * @param {any} r result of ops.taggedEdit / ops.taggedEdits
 * @returns {string}
 */
export function formatEdit(r) {
  const edits = r.edits ?? [r];
  return `${edits.map((/** @type {any} */ e) => `edited ${linesLabel(e.lines)}${e.count > 1 ? ` (${e.count} occurrences)` : ''} for ${e.threads.join(', ')} · tagged (not recorded yet)`).join('\n')}\n`;
}

/**
 * @param {any} r result of ops.revert
 * @returns {string}
 */
export function formatRevert(r) {
  if (r.noop) return `nothing to revert: ${r.reason}\n`;
  return `reverted ${r.hunk ?? r.lock} -> ${linesLabel(r.lines)} of the working copy restored (not recorded yet)\n`;
}

/**
 * @param {any} r result of ops.finalize
 * @returns {string}
 */
export function formatFinal(r) {
  const out = [
    `final: ${r.doc} = v${r.final.version} (approved in ${r.final.review} by ${r.final.by}; ${plural(r.versions, 'version')}, ${plural(r.reviews, 'review')}, ${plural(r.resolved, 'thread')} resolved, ${plural(r.decisions, 'decision')})`,
    `working copy matches v${r.final.version}: ok`,
  ];
  if (r.decisionsPath) out.push(`wrote ${r.decisionsPath}`);
  return `${out.join('\n')}\n`;
}

/**
 * Raw source lines (no numbers, so they can be copied verbatim).
 * @param {any} r result of ops.sourceLines
 * @returns {string}
 */
export function formatSourceLines(r) {
  return r.lines.length ? `${r.lines.join('\n')}\n` : '';
}

/**
 * @param {any} r result of ops.reply
 * @returns {string}
 */
export function formatReply(r) {
  return `replied on ${r.thread.id}${r.status ? ` (${r.status})` : ''} · no version recorded\n`;
}

/**
 * @param {any} r result of ops.ask
 * @returns {string}
 */
export function formatAsk(r) {
  const file = r.thread?.anchors?.[String(r.version)]?.file?.path;
  const at = r.lines ? `${file ? `${file}:` : ''}${linesLabel(r.lines)}` : file ? `${file} (whole file)` : `v${r.version}`;
  return `asked ${r.thread.id} at ${at} · the reviewer will answer in a later packet (ANSWER)\n`;
}
