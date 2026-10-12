// @ts-check
// Text formatting owned by the CLI (WP4).
//
// 1. CLI-only outputs: thread lists (`threads`), short summaries (`reply`, `ask`, `reanchor`), and generic
//    rendering helpers.
// 2. FALLBACK_FORMATTERS: plain renderings of the engine's result objects (Packet, ReviseReport, status, log,
//    Changes, Thread). The engine's own formatters in src/core/review/packet.js (WP3) take precedence (see
//    engine.js mergeFormatters); these keep the CLI usable against a partial engine and in tests. They follow
//    the grammar of design 3.6/3.8/9.6 and docs/agent-protocol.md 6.3 closely, but packet.js is authoritative.

import { LIMITS } from '../shared/protocol.js';

/**
 * 'L42-43' / 'L42' from [a, b] (inclusive). '' for null.
 * @param {unknown} range
 * @returns {string}
 */
export function rangeText(range) {
  if (!Array.isArray(range) || range.length === 0 || typeof range[0] !== 'number') return '';
  const [a, b = a] = /** @type {number[]} */ (range);
  return a === b ? `L${a}` : `L${a}-${b}`;
}

/**
 * "1 line" / "3 lines"; an unknown count is "? lines".
 * @param {number | null | undefined} n
 * @returns {string}
 */
export function lineCount(n) {
  return n == null ? '? lines' : `${n} ${n === 1 ? 'line' : 'lines'}`;
}

/**
 * A command-line argument as it must be typed in a POSIX shell: as is when plain, else single-quoted.
 * @param {string} s
 * @returns {string}
 */
export function shellArg(s) {
  return /^[A-Za-z0-9_.\/@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Whether a comment has a non-blank body (a suggestion may be submitted without a comment).
 * @param {any} c
 * @returns {boolean}
 */
export function hasBody(c) {
  return typeof c?.body === 'string' && c.body.trim() !== '';
}

/**
 * '§3 Tokens > 3.2 Token refresh' from ['3 Tokens', '3.2 Token refresh'].
 * @param {unknown} section
 * @returns {string}
 */
export function sectionText(section) {
  if (!Array.isArray(section) || section.length === 0) return '';
  return `§${section.join(' > ')}`;
}

/**
 * One-line excerpt (whitespace collapsed, ellipsis past `max`).
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
export function excerpt(text, max = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Indents every line after the first (for multi-line comment bodies).
 * @param {string} text
 * @param {string} pad
 * @returns {string}
 */
function hangIndent(text, pad) {
  return String(text ?? '').replace(/\r?\n/g, `\n${pad}`);
}

/**
 * Name of an actor ({kind,name} or a string).
 * @param {unknown} actor
 * @returns {string}
 */
export function actorName(actor) {
  if (!actor) return '?';
  if (typeof actor === 'string') return actor;
  const a = /** @type {{ name?: string }} */ (actor);
  return a.name ?? '?';
}

/**
 * Head-version anchor of a stored Thread or Lock (the anchor keyed by `head`, else the newest one).
 * @param {any} item
 * @param {number | undefined} head
 * @returns {any}
 */
export function headAnchor(item, head) {
  const anchors = item?.anchors;
  if (!anchors || typeof anchors !== 'object') return null;
  if (head !== undefined && anchors[String(head)]) return anchors[String(head)];
  const keys = Object.keys(anchors)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
  return keys.length ? anchors[String(keys[0])] : null;
}

/**
 * Inclusive line range of an anchor ([startLine, endLine]) or null.
 * @param {any} anchor
 * @returns {[number, number] | null}
 */
export function anchorLines(anchor) {
  const src = anchor?.src;
  if (!src || typeof src.startLine !== 'number') return null;
  return [src.startLine, typeof src.endLine === 'number' ? src.endLine : src.startLine];
}

/**
 * True when a stored thread counts as "outdated" at head (its anchor text changed or was lost).
 * @param {any} thread
 * @param {number | undefined} head
 * @returns {boolean}
 */
export function isOutdated(thread, head) {
  const state = headAnchor(thread, head)?.state;
  return state === 'changed' || state === 'orphaned';
}

/**
 * `threads` listing: one line per thread.
 *   t1  open         blocking  comment     L42-43  §3 Tokens > 3.2 Token refresh  Eric: Rotation on every use…
 * @param {any[]} threads stored Thread objects (or PacketThread-like objects with `lines`)
 * @param {{ head?: number, doc?: string, filter?: string, hidden?: number }} [opts]
 * @returns {string}
 */
export function formatThreadList(threads, opts = {}) {
  if (!threads.length) {
    const what = opts.filter && opts.filter !== 'all' ? `${opts.filter} ` : '';
    return `no ${what}threads${opts.doc ? ` on ${opts.doc}` : ''}${opts.hidden ? ` (${opts.hidden} resolved; --status all)` : ''}`;
  }
  const rows = threads.map((t) => {
    const anchor = headAnchor(t, opts.head);
    const lines = rangeText(t.lines ?? anchorLines(anchor));
    const section = sectionText(t.section ?? anchor?.section);
    const state = anchor?.state && anchor.state !== 'exact' && anchor.state !== 'moved' ? ` (${anchor.state})` : '';
    const last = Array.isArray(t.comments) ? t.comments.filter(hasBody).pop() ?? null : null;
    const lastText = last ? `${actorName(last.by)}: ${excerpt(last.body, 60)}` : '';
    return [
      t.id,
      String(t.status ?? ''),
      t.severity && t.severity !== 'normal' ? t.severity : '',
      String(t.type ?? ''),
      `${lines || '-'}${state}`,
      section,
      lastText,
    ];
  });
  const widths = [0, 1, 2, 3, 4].map((i) => Math.max(...rows.map((r) => r[i].length)));
  const out = rows.map((r) =>
    r
      .map((cell, i) => (i < 5 ? cell.padEnd(widths[i]) : cell))
      .join('  ')
      .replace(/\s+$/, ''),
  );
  if (opts.hidden) out.push(`(${opts.hidden} resolved not shown; --status all)`);
  return out.join('\n');
}

/**
 * Renders any JSON-like value as indented `key: value` text (used when no specific formatter fits).
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {string}
 */
export function genericText(value, depth = 0) {
  const pad = '  '.repeat(depth);
  if (value === null || value === undefined) return `${pad}-`;
  if (typeof value !== 'object') return `${pad}${String(value)}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}(none)`;
    return value
      .map((v) => (v !== null && typeof v === 'object' ? `${pad}-\n${genericText(v, depth + 1)}` : `${pad}- ${String(v)}`))
      .join('\n');
  }
  const lines = [];
  for (const [k, v] of Object.entries(value)) {
    if (v !== null && typeof v === 'object' && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)) {
      lines.push(`${pad}${k}:`);
      lines.push(genericText(v, depth + 1));
    } else if (Array.isArray(v)) {
      lines.push(`${pad}${k}: (none)`);
    } else {
      lines.push(`${pad}${k}: ${v === null || v === undefined ? '-' : typeof v === 'object' ? '{}' : String(v)}`);
    }
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------ show <doc> <tid>

/**
 * The working-copy source lines of a `show <doc> <tid>` result (ops.show: { thread, anchor, workingLines, label,
 * src, srcUnique, attachments, ... }), printed the way packet items print them (design 9.3, amendments 4.6):
 *   working copy: L53                 only when unrecorded edits moved the anchor away from its head lines
 *   src> <exact source lines>         usable as an Edit old_string
 *   (src> is shortened or not unique; Read around L53 before editing)
 *   crop: /abs/attachments/a1.png  (Read it to see the region)      (a region crop; see attachmentText)
 *   image: /abs/attachments/a2.png  (Read it to see what the reviewer snipped)
 * Overflow lines of a capped packet and the skill send the agent to `show` for a thread, so it must carry the same
 * src>/crop facts as a packet item. Orphaned and doc-level threads have no src (nothing is printed for them).
 * @param {any} s
 * @param {{ src?: boolean, attachments?: boolean }} [want] which parts to produce (default: both)
 * @returns {string[]}
 */
export function threadSourceLines(s, want = {}) {
  /** @type {string[]} */
  const out = [];
  const working = rangeOf(s?.workingLines);
  if (want.src !== false && typeof s?.src === 'string' && s.src) {
    const head = rangeOf(s.anchor?.lines);
    if (working && (!head || head[0] !== working[0] || head[1] !== working[1])) out.push(`  working copy: ${rangeText(working)}`);
    for (const line of s.src.split('\n')) out.push(`  src> ${line}`);
    if (s.srcEditable === false) out.push('  (data: URIs elided above; Read the file for the exact text)');
    else if (!s.srcUnique && working) out.push(`  (src> is shortened or not unique; Read around ${rangeText(working)} before editing)`);
  }
  if (want.attachments !== false) {
    const kind = s?.attachmentKind ?? (String(s?.label ?? '').includes('region') ? 'region' : 'image');
    for (const a of Array.isArray(s?.attachments) ? s.attachments : []) {
      if (typeof a === 'string' && a) out.push(attachmentText(a, kind));
    }
  }
  return out;
}

/**
 * One attachment line, worded like the engine's packet (src/core/review/packet.js attachmentLine; repeated here
 * because the CLI formats without loading the engine): 'region' -> crop:, 'snip' / 'image' -> image:, each with
 * the Read hint.
 * @param {string} absPath
 * @param {string | null | undefined} kind 'region' | 'snip' | 'image'
 * @returns {string}
 */
export function attachmentText(absPath, kind) {
  if (kind === 'region') return `  crop: ${absPath}  (Read it to see the region)`;
  if (kind === 'snip') return `  image: ${absPath}  (Read it to see what the reviewer snipped)`;
  return `  image: ${absPath}  (Read it to see the image the reviewer attached)`;
}

/**
 * Adds the src>/crop lines of a show result to the thread text (after the `on:` line, else after the header). A
 * part the formatter already printed (a line starting with `  src> ` / `  crop: ` / `  image: `) is not repeated.
 * @param {string} text formatted thread (engine formatThread or the fallback)
 * @param {any} s the show result it was formatted from
 * @returns {string}
 */
export function withThreadSource(text, s) {
  if (!s || typeof s !== 'object' || !s.thread || typeof s.thread !== 'object') return text;
  const lines = text.split('\n');
  const has = (/** @type {RegExp} */ re) => lines.some((l) => re.test(l));
  const extra = threadSourceLines(s, { src: !has(/^ {2}src> /), attachments: !has(/^ {2}(?:crop|image): /) });
  if (!extra.length) return text;
  const on = lines.findIndex((l) => /^ {2}on: /.test(l));
  lines.splice(on >= 0 ? on + 1 : Math.min(1, lines.length), 0, ...extra);
  return lines.join('\n');
}

/**
 * [a, b] of positive integers, else null.
 * @param {unknown} range
 * @returns {[number, number] | null}
 */
function rangeOf(range) {
  if (!Array.isArray(range) || !Number.isSafeInteger(range[0])) return null;
  const a = /** @type {number} */ (range[0]);
  const b = Number.isSafeInteger(range[1]) ? /** @type {number} */ (range[1]) : a;
  return a >= 1 && b >= a ? [a, b] : null;
}

// ------------------------------------------------------------------------------------------------ fallbacks

const VERDICT_TEXT = /** @type {Record<string, string>} */ ({
  comment: 'COMMENT',
  changes_requested: 'CHANGES REQUESTED',
  approved: 'APPROVED',
});

const WHY_LABEL = /** @type {Record<string, string>} */ ({ reopened: 'REOPENED', reply: 'REPLY', answer: 'ANSWER' });

const PROTOCOL_LINES = [
  'PROTOCOL: targeted edits only; src> lines are exact Edit old_string; edit bottom-up. Suggestions: `suiko apply`.',
  '  Questions: answer in the reply; edit only if the answer belongs in the spec. Unsure: status needs_input.',
];

/**
 * Feedback packet text (design 3.6 / 9.3). Fallback for packet.js formatPacket.
 * @param {any} p Packet
 * @returns {string}
 */
function formatPacket(p) {
  const reviews = Array.isArray(p?.reviews) ? p.reviews : [];
  const last = reviews[reviews.length - 1];
  const verdict = VERDICT_TEXT[p?.verdict ?? last?.verdict] ?? 'NO REVIEW';
  const headParts = [`SPECREVIEW FEEDBACK · ${p.doc}${p.path ? ` (${p.path})` : ''}`];
  if (reviews.length) {
    const ids = reviews.map((/** @type {any} */ r) => r.id).join(', ');
    headParts.push(`review${reviews.length > 1 ? 's' : ''} ${ids} on v${last.version}`);
  }
  headParts.push(verdict);
  if (p.final?.version) headParts.push(`FINAL = v${p.final.version}`);
  const out = [headParts.join(' · ')];
  if (p.pathFromCwd && p.pathFromCwd !== p.path) out.push(`File: ${p.pathFromCwd} (from your working directory)`);
  out.push(
    p.working === 'dirty'
      ? `Line numbers = current file on disk (working copy differs from v${p.head}: lines mapped).`
      : `Line numbers = current file on disk (identical to v${p.head}).`,
  );
  for (const r of reviews) if (r.body) out.push(`Reviewer summary${reviews.length > 1 ? ` (${r.id})` : ''}: ${hangIndent(r.body, '  ')}`);
  const threads = Array.isArray(p.threads) ? p.threads : [];
  const counts = p.counts ?? {};
  const actionable = counts.actionable ?? threads.length;
  const kinds = summarizeKinds(threads);
  const resolved = counts.resolved ? `   (${counts.resolved} resolved this round)` : '';
  out.push(`${actionable} thread${actionable === 1 ? '' : 's'} need${actionable === 1 ? 's' : ''} action${kinds ? `: ${kinds}` : ''}${resolved}`);

  let used = out.join('\n').length;
  /** @type {string[]} */
  const overflow = [];
  for (const t of threads) {
    const block = formatPacketThread(p, t);
    if (used + block.length + 2 > LIMITS.packetChars && overflow.length === 0 && out.length > 4) {
      overflow.push(`[${t.id}] ${packetThreadHeader(p, t)} · suiko show ${p.doc} ${t.id}`);
      continue;
    }
    if (overflow.length) {
      overflow.push(`[${t.id}] ${packetThreadHeader(p, t)} · suiko show ${p.doc} ${t.id}`);
      continue;
    }
    out.push('', block);
    used += block.length + 2;
  }
  if (overflow.length) {
    out.push('', `(${overflow.length} more thread${overflow.length === 1 ? '' : 's'}; the packet is capped at ${LIMITS.packetChars} characters)`);
    out.push(...overflow);
  }
  out.push('');
  const locks = Array.isArray(p.locks) ? p.locks : [];
  out.push(
    `LOCKED (agreed - do not modify): ${
      locks.length
        ? locks
            .map((/** @type {any} */ l) => [l.id, sectionText(l.section), l.lines ? `(${rangeText(l.lines)})` : ''].filter(Boolean).join(' '))
            .join(' · ')
        : '(none)'
    }`,
  );
  const decisions = Array.isArray(p.decisions) ? p.decisions : [];
  out.push(
    `DECISIONS to keep true: ${
      decisions.length
        ? decisions.map((/** @type {any} */ d) => `${d.id}${d.thread ? ` (${d.thread})` : ''} ${d.text}`).join(' · ')
        : '(none yet)'
    }`,
  );
  if (Array.isArray(p.drafts)) {
    out.push(
      p.drafts.length
        ? `DRAFTS (not submitted - do not act on them; ask the reviewer to click Submit review): ${p.drafts.length}`
        : 'DRAFTS: none',
    );
    for (const d of p.drafts) {
      out.push(`  [${d.id}] ${d.kind === 'reply' ? `reply on ${d.thread}` : d.type ?? 'comment'}: ${excerpt(d.body, 100)}`);
    }
  }
  if (p.replyOnly) out.push('APPROVED with a final version: reply to each thread; do not edit the spec.');
  else if (threads.length) out.push(...PROTOCOL_LINES);
  if (p.next) out.push(`NEXT: ${p.next}`);
  return out.join('\n');
}

/**
 * @param {any[]} threads
 * @returns {string}
 */
function summarizeKinds(threads) {
  /** @type {Record<string, number>} */
  const n = {};
  for (const t of threads) {
    if (t.severity === 'blocking') n.blocking = (n.blocking ?? 0) + 1;
    const kind = t.type === 'agent-question' ? 'answer to your question' : t.type;
    n[kind] = (n[kind] ?? 0) + 1;
  }
  return Object.entries(n)
    .map(([k, v]) => `${v} ${k}`)
    .join(' · ');
}

/**
 * @param {any} p
 * @param {any} t
 * @returns {string}
 */
function packetThreadHeader(p, t) {
  const parts = [];
  if (WHY_LABEL[t.why]) parts.push(WHY_LABEL[t.why]);
  if (t.severity && t.severity !== 'normal') parts.push(t.severity);
  parts.push(t.type);
  const lines = rangeText(t.lines);
  if (lines) parts.push(lines);
  const section = sectionText(t.section);
  if (section) parts.push(section);
  if (t.target && t.target !== 'text' && t.label) parts.push(t.label);
  if (t.type === 'suggestion' && t.suggestion && t.suggestion.status !== 'applied') {
    parts.push(`apply verbatim: ${t.apply ?? `suiko apply ${p.doc} ${t.id}`}`);
  }
  return parts.join(' · ');
}

/**
 * @param {any} p
 * @param {any} t
 * @returns {string}
 */
function formatPacketThread(p, t) {
  const out = [`[${t.id}] ${packetThreadHeader(p, t)}`];
  if (t.anchorState === 'changed') out.push('  (outdated: text changed)');
  if (t.anchorState === 'orphaned') out.push(`  (orphaned: reanchor with suiko reanchor ${p.doc} ${t.id} --lines A-B)`);
  if (t.on && (!t.target || t.target === 'text')) out.push(`  on: "${excerpt(t.on, 120)}"`);
  if (t.type === 'suggestion' && t.suggestion) {
    for (const line of String(t.suggestion.old ?? '').split('\n')) out.push(`  - ${line}`);
    for (const line of String(t.suggestion.new ?? '').split('\n')) out.push(`  + ${line}`);
  } else if (typeof t.src === 'string' && t.src) {
    for (const line of t.src.split('\n')) out.push(`  src> ${line}`);
  }
  const kind = t.attachmentKind ?? (String(t.label ?? '').includes('region') ? 'region' : 'image');
  for (const a of Array.isArray(t.attachments) ? t.attachments : []) out.push(attachmentText(a, kind));
  for (const c of Array.isArray(t.comments) ? t.comments : []) {
    if (hasBody(c)) out.push(`  ${actorName(c.by)}: ${hangIndent(c.body, '    ')}`); // empty comments are left out
  }
  return out.join('\n');
}

/**
 * ReviseReport text (design 3.8). Fallback for packet.js formatReviseReport.
 * @param {any} r
 * @returns {string}
 */
function formatReviseReport(r) {
  const out = [];
  const hunks = Array.isArray(r?.hunks) ? r.hunks : [];
  const errors = r?.guards?.errors ?? [];
  const warnings = r?.guards?.warnings ?? [];
  if (r?.refused) {
    out.push('suiko: REFUSED - nothing recorded (exit 3)');
    for (const e of errors) out.push(`  ERR ${typeof e === 'string' ? e : e.message ?? JSON.stringify(e)}`);
    for (const w of warnings) out.push(`  WARN ${typeof w === 'string' ? w : w.message ?? JSON.stringify(w)}`);
    out.push('working copy left untouched. Preview with --dry-run.');
    return out.join('\n');
  }
  const added = r?.stats?.added;
  const removed = r?.stats?.removed;
  const stats = added !== undefined ? `+${added} -${removed} lines, ${hunks.length} hunk${hunks.length === 1 ? '' : 's'}` : `${hunks.length} hunk${hunks.length === 1 ? '' : 's'}`;
  if (r?.dryRun) out.push(`suiko: dry run - would record v${r.version ?? '?'} (${stats}); nothing recorded`);
  else if (r?.version) out.push(`suiko: recorded v${r.version}${r.doc ? ` for ${r.doc}` : ''} (${stats})${r.respondsTo ? ` · responds to ${r.respondsTo}` : ''}`);
  else out.push('suiko: nothing to record (working copy equals head)');
  for (const h of hunks) {
    const target = h.other ? `other: ${h.other}` : h.threads?.length ? `${h.threads.join(' ')}${h.linkedBy ? `  (${h.linkedBy})` : ''}` : 'unlinked';
    out.push(`  ${h.id} ${rangeText(h.newRange ?? h.oldRange) || '-'}  ${sectionText(h.section)}  -> ${target}`);
  }
  for (const rep of Array.isArray(r?.replies) ? r.replies : []) {
    const linked = hunks.some((/** @type {any} */ h) => h.threads?.includes(rep.thread));
    if (!linked) out.push(`  ${rep.thread} ${rep.status} (reply only)`);
  }
  out.push(`guards: ${errors.length || warnings.length ? '' : 'ok'}${[...errors.map((/** @type {any} */ e) => `ERR ${e}`), ...warnings.map((/** @type {any} */ w) => `WARN ${w}`)].join(' · ')}`);
  const a = r?.anchors;
  if (a) out.push(`anchors: ${a.exact ?? 0} exact, ${a.moved ?? 0} moved, ${a.edited ?? 0} edited, ${a.changed ?? 0} changed, ${a.orphaned ?? 0} orphaned`);
  if (r?.version && !r?.dryRun) out.push(`reviewer notified${r.notified ? '' : ' (no UI open)'}. next: suiko wait ${r.doc ?? '<doc>'} (background)`);
  return out.join('\n');
}

/**
 * `status` text (design 9.6). Fallback for packet.js formatStatus.
 * @param {any} s
 * @returns {string}
 */
function formatStatus(s) {
  const docs = Array.isArray(s) ? s : Array.isArray(s?.docs) ? s.docs : s ? [s] : [];
  if (!docs.length) return 'no tracked docs';
  return docs
    .map((/** @type {any} */ d) => {
      const doc = d.doc && typeof d.doc === 'object' ? d.doc : d;
      const lines = [`${doc.id ?? d.id}  ${doc.path ?? ''}  head v${doc.head ?? '?'}  ${doc.state ?? ''}`.trimEnd()];
      if (d.pathFromCwd && d.pathFromCwd !== (doc.path ?? d.path)) lines.push(`  file: ${d.pathFromCwd} (from your working directory)`);
      if (d.threads && typeof d.threads === 'object' && !Array.isArray(d.threads)) {
        lines.push(`  threads: ${Object.entries(d.threads).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
      }
      if (d.undelivered !== undefined) lines.push(`  undelivered reviews: ${Array.isArray(d.undelivered) ? d.undelivered.join(', ') || 'none' : d.undelivered}`);
      if (Array.isArray(d.listening ?? d.waiters)) {
        const w = d.listening ?? d.waiters;
        lines.push(`  listening: ${w.length ? w.map((/** @type {any} */ x) => `${x.agent} (pid ${x.pid})`).join(', ') : 'nobody'}`);
      }
      if (d.working) lines.push(`  working copy: ${typeof d.working === 'string' ? d.working : d.working.dirty ? 'dirty' : 'clean'}`);
      return lines.join('\n');
    })
    .join('\n');
}

/**
 * `log` text (design 9.6). Fallback for packet.js formatLog.
 * @param {any} l
 * @returns {string}
 */
function formatLog(l) {
  const entries = Array.isArray(l) ? l : Array.isArray(l?.entries) ? l.entries : Array.isArray(l?.versions) ? l.versions : null;
  if (!entries) return genericText(l);
  return entries
    .map((/** @type {any} */ e) =>
      e.v !== undefined
        ? `v${e.v}  ${actorName(e.author)}  ${e.createdAt ?? ''}  ${e.summary ?? ''}`.trimEnd()
        : `    ${e.id ?? ''}  ${actorName(e.by)}  ${e.submittedAt ?? e.at ?? ''}  ${String(e.verdict ?? '').toUpperCase()}`.trimEnd(),
    )
    .join('\n');
}

/**
 * `diff --stat` text (design 9.6). Fallback for packet.js formatDiffStat.
 * @param {any} c Changes
 * @returns {string}
 */
function formatDiffStat(c) {
  const hunks = Array.isArray(c?.hunks) ? c.hunks : [];
  const from = c?.from !== undefined ? (c.from === 'live' ? 'live' : `v${c.from}`) : '?';
  const to = c?.to !== undefined ? (c.to === 'live' ? 'live' : `v${c.to}`) : '?';
  const out = [`${from}..${to}  +${c?.stats?.added ?? 0} -${c?.stats?.removed ?? 0}  ${hunks.length} hunk${hunks.length === 1 ? '' : 's'}`];
  for (const h of hunks) {
    const start = h.new?.start ?? h.newStart;
    const count = h.new?.lines ?? h.newLines ?? 0;
    const lines = count > 0 ? rangeText([start, start + count - 1]) : `L${start} (deleted)`;
    const link = h.other ? `other: ${h.other}` : h.threads?.length ? `${h.threads.join(' ')}${h.linkedBy ? ` (${h.linkedBy})` : ''}` : '';
    out.push(`  ${h.id} ${lines}  ${sectionText(h.section)}  ${link}`.trimEnd());
  }
  for (const a of Array.isArray(c?.assets) ? c.assets : []) out.push(`  asset changed: ${a.path}`);
  return out.join('\n');
}

/**
 * Thread text for `show <doc> <tid>` (design 9.6). Fallback for packet.js formatThread.
 * @param {any} s a Thread, or a show result { thread, head?, ... }
 * @returns {string}
 */
function formatThread(s) {
  const t = s?.thread && typeof s.thread === 'object' ? { head: s.head, ...s.thread } : s;
  if (!t || typeof t !== 'object' || !t.id) return genericText(s);
  const head = typeof t.head === 'number' ? t.head : undefined;
  const anchor = headAnchor(t, head);
  const out = [
    `[${t.id}] ${t.type} · ${String(t.status ?? '').toUpperCase()}${anchor ? ` · anchor ${anchor.state ?? 'exact'} (${rangeText(anchorLines(anchor))})` : ''}`,
  ];
  for (const c of Array.isArray(t.comments) ? t.comments : []) {
    if (!hasBody(c) && !c?.status) continue; // nothing to show (e.g. a suggestion without a comment)
    const meta = [c.version !== undefined ? `v${c.version}` : '', actorName(c.by)];
    const extra = [c.status, c.review].filter(Boolean).join(', ');
    out.push(`  ${meta.filter(Boolean).join(' ')}${extra ? ` (${extra})` : ''}${hasBody(c) ? `: ${hangIndent(c.body, '    ')}` : ''}`);
  }
  if (t.decision) out.push(`  decision ${t.decision.id}: ${t.decision.text}`);
  return out.join('\n');
}

/** Fallback formatters (packet.js wins when it exports the same names). */
export const FALLBACK_FORMATTERS = Object.freeze({
  formatPacket,
  formatReviseReport,
  formatStatus,
  formatLog,
  formatDiffStat,
  formatThread,
});
