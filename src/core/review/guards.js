// @ts-check
// Revision guards (BUILD_AMENDMENTS 4.4, which overrides design 8.4). Content based:
//
// | check                                                                  | default | override                        |
// |------------------------------------------------------------------------|---------|---------------------------------|
// | an active lock's normalised text is no longer intact in the new text  | refuse  | --break-lock L1="reason"        |
// |   ... but the lock was created after the last packet delivered         | warn    |                                 |
// | unlinked, unexplained hunk removing/replacing >= guards.unexplainedWords| refuse  | other entry, undo it, an "at"   |
// |   measured words or >= guards.unexplainedDeletionLines whole old lines |         | link to the thread that asked   |
// |   ... the same amount removed OUTSIDE what the hint / overlap links    |         | for it,                         |
// |   explain (attribution `outside`)                                      | refuse  | guards.unexplainedDeletion      |
// | more than guards.maxRewriteRatio of head's measured text removed or    | refuse  | an "at" link to the thread that |
// |   replaced where no thread asked for it, head of >= 40 lines or >= 300 |         | asked for it, --allow-rewrite   |
// |   measured words (HTML: >= 300 visible words; its line count says      |         |                                 |
// |   nothing about a generated or minified file)                          |         |                                 |
// | the text of an applied suggestion (thread addressed or resolved) is in | refuse  | an "at" link (or tagged edit)   |
// |   head and nowhere in the working copy, and no hunk removing it is     |         | to the thread that asked to     |
// |   explicitly linked or explained by `other` (`reverted`)               |         | change it, an other entry       |
// | actionable thread without a reply entry                                | warn    |                                 |
// | thread marked addressed with no linked hunk and no asset change        | warn    | add "at"                        |
// | decision anchor intersects a hunk not linked to the decision's thread  | warn    |                                 |
// | --force                                                                | overrides every refusal (recorded)        |
//
// What the deletion and rewrite checks measure is what the reviewer reads (shared/visible-text.js, the same measure as
// the pre-write hook): for HTML the visible text, without whitespace (no tags or attributes, so no data: URIs, and no
// script, style or JSON data blob, except the prose-like string literals of a script of up to 256 KB: prose a page
// renders from its own script); for Markdown the source as it always was, less base64 data: URIs and raw
// <script>/<style> blocks. So a rebuilt report whose data blob changed with the sentence a thread asked about is not a
// rewrite, while rewriting more than half of the prose is, unless a thread asked for it: "where no thread asked for
// it" counts unlinked hunks and the part of a hint / overlap linked hunk that its links do not explain (the
// attribution rule): its threads' scopes (anchor plus paragraph-level block or section; a GENERAL thread's scope is
// the whole doc; a tagged edit is all asked for) and, for an explicit `at` link, the lines the `at` names (an `at`
// explains what lands on the lines it names; an overlap link is inferred, so it explains only the scopes). Scopes are
// widened to whole lines only on lines of up to 1,000 characters (attribution WIDEN_MAX_LINE). Trade-off: in a
// one-line (minified) document an explicit `at` can only name the whole line, so it explains the whole hunk; there
// the pre-write hook and the reviewer-facing "large rewrite" badge (rewriteRatio: the raw measure, links ignored)
// remain the backstop. A Markdown hunk that touches no hidden range is measured exactly as before (attribution's
// stats and the word diff's removed characters); every other hunk is measured by a word diff of the visible text of
// its two sides. `rewriteRatio` (the version's stats, the UI's "large rewrite") is the measured share all hunks
// remove; the refusal looks at the share no thread asked for.
//
// `reverted`: a document built from sources (a template, data, a script) that got a suggestion through `suiko apply`
// (which patches the built file) loses it again at the next rebuild. An applied suggestion whose text was in head
// and is nowhere in the working copy is refused unless a hunk that removes it is linked explicitly (`at`, or a tagged
// `apply` / `edit`) or explained by `other`; an inferred overlap link does not count.
//
// Fix lines never lead with `suiko revert`: it restores only the file it is run on, so for a built document the next
// rebuild brings the change back. They say to undo a change where it was made (the sources, then rebuild; `suiko
// revert --hunk` for a file edited directly), or how a thread's `at` or an `other` entry explains it.
//
// A lock is intact when no hunk changes characters inside its range, when its whitespace-normalised source text still
// occurs in the new text at least as often as in the old one (moved or re-wrapped), or when the rendered text of its
// range (markup stripped, whitespace collapsed) equals the rendered text of the mapped range in the new text
// (re-wrapped with continuation markup such as a Markdown blockquote's "> "). Locks marked in `flags.breakLocks` are
// reported as broken (they become inactive when the version is recorded).

import { countWords, hunkStats, hunkWordOps } from '../diff/index.js';
import { collapseWs, lineIndex, sourceToPlainText } from '../text/index.js';
import { countVisible, hiddenRanges, visibleText } from '../../shared/visible-text.js';
import { linesLabel } from './labels.js';
import { mergeRanges, newLineRange, oldLineRange, scopeRanges } from './attribution.js';

/** A head this long (lines), or with this many measured words, gets the rewrite check. */
const REWRITE_MIN_LINES = 40;
const REWRITE_MIN_WORDS = 300;

/**
 * @typedef {import('./attribution.js').AttributedHunk} AttributedHunk
 * @typedef {import('../../shared/types.js').Config} Config
 * @typedef {'lock' | 'lock-new' | 'lock-broken' | 'deletion' | 'rewrite' | 'reverted' | 'reply' | 'addressed'
 *   | 'decision' | 'unlinked' | 'other' | 'hint'} GuardCode
 * @typedef {object} AppliedSuggestion a suggestion whose text an earlier version applied
 * @property {string} thread
 * @property {string} text suggestion.new
 * @property {number | null} appliedIn the version that applied it
 * @typedef {{ code: GuardCode, message: string, fix?: string, hunk?: string, lock?: string, thread?: string }} GuardIssue
 * @typedef {object} LockCheck
 * @property {string} id
 * @property {string} label e.g. '§7 Rollout plan'
 * @property {string | null} agreedIn review id whose locksAdded lists it
 * @property {string | null} createdAt
 * @property {boolean} intact
 * @property {string[]} hunks ids of hunks changing its text
 * @typedef {object} GuardResult
 * @property {boolean} refused errors exist and --force was not given
 * @property {boolean} forced --force overrode at least one error
 * @property {GuardIssue[]} errors
 * @property {GuardIssue[]} warnings
 * @property {string[]} brokenLocks lock ids broken with --break-lock
 * @property {string[]} intactLocks
 * @property {string[]} unexplained hunk ids linked to nothing and explained by no `other`
 * @property {number} rewriteRatio share of head's measured text that the hunks remove or replace
 * @property {number} unaskedRatio ... of it where no thread asked for a change (what the rewrite check refuses)
 */

/**
 * Whether a lock's text survives a change (see header).
 * @param {object} p
 * @param {import('./workmap.js').PreciseMapper} p.mapper head -> working
 * @param {string} p.headSource
 * @param {string} p.workingSource
 * @param {number} p.start lock range in head
 * @param {number} p.end
 * @param {'markdown' | 'html'} [p.format] enables the rendered-text comparison (default 'markdown')
 * @returns {{ intact: boolean, hunks: string[] }}
 */
export function lockIntegrity({ mapper, headSource, workingSource, start, end, format = 'markdown' }) {
  // The locked text must still stand as it did: with the same kind of neighbours (a line end, markup, a word,
  // punctuation), so `Max retries: 3` does not survive as `Max retries: 30`, nor a locked line or heading as the
  // start of a longer one (`## Notes` -> `## Notes (cache)`, text added right at its edge, which touches no
  // character inside the range).
  const edges = edgesOf(headSource, start, end);
  const mapped = mapper.mapRange(start, end);
  const touching = mapper.hunksTouching(start, end).map((h) => h.id);
  if (!touching.length) {
    if (sameEdges(edges, edgesOf(workingSource, mapped.start, mapped.end))) return { intact: true, hunks: [] };
    const atEdge = mapper.hunks.filter((h) => mapper.changedOld(h).some(([cs, ce]) => cs === end || ce === start)).map((h) => h.id);
    return { intact: atEdge.length === 0, hunks: atEdge };
  }
  const text = collapseWs(headSource.slice(start, end)).trim();
  if (!text) return { intact: true, hunks: touching };
  const before = boundedOccurrences(headSource, text, edges);
  const after = boundedOccurrences(workingSource, text, edges);
  if (after >= before && after > 0) return { intact: true, hunks: touching };
  const oldPlain = plainOf(format, headSource, start, end);
  const intact = oldPlain !== '' && sameEdges(edges, edgesOf(workingSource, mapped.start, mapped.end))
    && oldPlain === plainOf(format, workingSource, mapped.start, mapped.end);
  return { intact, hunks: touching };
}

/** @typedef {'eol' | 'tag' | 'word' | 'other'} Edge what borders a text, past spaces and tabs */

/**
 * The kinds of neighbours of source[start, end) once its own leading and trailing whitespace is left out.
 * @param {string} source
 * @param {number} start
 * @param {number} end
 * @returns {{ before: Edge, after: Edge }}
 */
function edgesOf(source, start, end) {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(source[s])) s++;
  while (e > s && /\s/.test(source[e - 1])) e--;
  return { before: edgeAt(source, s, -1), after: edgeAt(source, e, 1) };
}

/**
 * The kind of the first character beside `at` in direction `dir`, past spaces and tabs: a line end (or the end of
 * the text), markup (`<` after it, `>` before it: an HTML tag, a Markdown quote marker), a word, or other punctuation.
 * @param {string} source
 * @param {number} at the start of a text (dir -1) or its end (dir 1)
 * @param {-1 | 1} dir
 * @returns {Edge}
 */
function edgeAt(source, at, dir) {
  let i = dir < 0 ? at - 1 : at;
  while (i >= 0 && i < source.length && (source[i] === ' ' || source[i] === '\t')) i += dir;
  if (i < 0 || i >= source.length || source[i] === '\n' || source[i] === '\r') return 'eol';
  if (source[i] === (dir < 0 ? '>' : '<')) return 'tag';
  return /[\p{L}\p{N}_]/u.test(source[i]) ? 'word' : 'other';
}

/** @param {{ before: Edge, after: Edge }} a @param {{ before: Edge, after: Edge }} b */
function sameEdges(a, b) {
  return a.before === b.before && a.after === b.after;
}

/**
 * Occurrences of whitespace-collapsed `text` in `source` (any whitespace between its words) with neighbours of the
 * given kinds.
 * @param {string} source
 * @param {string} text
 * @param {{ before: Edge, after: Edge }} edges
 * @returns {number}
 */
function boundedOccurrences(source, text, edges) {
  const re = new RegExp(text.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g');
  let n = 0;
  for (const m of source.matchAll(re)) {
    const at = m.index ?? 0;
    if (sameEdges(edges, { before: edgeAt(source, at, -1), after: edgeAt(source, at + m[0].length, 1) })) n++;
  }
  return n;
}

/**
 * Rendered text of a source range, whitespace collapsed (markup and entities removed).
 * @param {'markdown' | 'html'} format
 * @param {string} source
 * @param {number} start
 * @param {number} end
 */
function plainOf(format, source, start, end) {
  if (end <= start) return '';
  const lineStart = start === 0 || source[start - 1] === '\n';
  return collapseWs(sourceToPlainText(format, source.slice(start, end), { lineStart })).trim();
}

/**
 * @param {object} p
 * @param {string} p.docId
 * @param {number} p.headVersion
 * @param {number} p.headLines line count of head
 * @param {string} p.headSource
 * @param {string} p.workingSource
 * @param {AttributedHunk[]} p.hunks
 * @param {'markdown' | 'html'} [p.format] what is measured (see the header; default 'markdown')
 * @param {Record<string, Array<[number, number]> | 'all'>} [p.scopes] the attribution scopes (head ranges a hint or
 *   overlap link to a thread explains); omitted: such a link explains its whole hunk
 * @param {Record<string, string>} [p.sections] hunk id -> section label for messages
 * @param {Config['guards']} p.config
 * @param {LockCheck[]} [p.locks] active locks
 * @param {string | null} [p.lastDeliveredAt] ISO time of the last packet delivered to this agent
 * @param {Record<string, { status: string, reply?: string, at?: string }>} [p.replies]
 * @param {string[]} [p.actionable] actionable thread ids (expected to get a reply)
 * @param {Record<string, string[]>} [p.threadLinks]
 * @param {Record<string, string[]>} [p.assetLinks] thread id -> changed asset paths
 * @param {Record<string, [number, number] | null>} [p.threadLines] working-copy lines per thread (for hints)
 * @param {Array<{ id: string, thread: string, start: number, end: number }>} [p.decisions] head src ranges
 * @param {AppliedSuggestion[]} [p.applied] suggestions applied in an earlier version whose thread is addressed or
 *   resolved (the `reverted` check; needs `mapper`)
 * @param {import('./workmap.js').PreciseMapper} [p.mapper]
 * @param {Array<{ at: string, why: string, reason: string }>} [p.unusedOther]
 * @param {Array<{ thread: string, at: string, reason: string }>} [p.badHints]
 * @param {{ force?: boolean, allowRewrite?: boolean, breakLocks?: Record<string, string> }} [p.flags]
 * @returns {GuardResult}
 */
export function runGuards(p) {
  const cfg = p.config;
  const flags = p.flags ?? {};
  const doc = p.docId;
  /** @type {GuardIssue[]} */
  const errors = [];
  /** @type {GuardIssue[]} */
  const warnings = [];
  /** @type {string[]} */
  const brokenLocks = [];
  /** @type {string[]} */
  const intactLocks = [];
  const byId = new Map(p.hunks.map((h) => [h.id, h]));
  const where = (/** @type {AttributedHunk} */ h) => hunkWhere(h, p.headVersion, p.sections?.[h.id]);

  // 1. locks
  for (const lock of p.locks ?? []) {
    if (lock.intact) {
      intactLocks.push(lock.id);
      continue;
    }
    const first = byId.get(lock.hunks[0]);
    const hunkText = `${lock.hunks.join(', ')}${first ? ` ${newLinesText(first)}` : ''}`;
    const reason = flags.breakLocks?.[lock.id];
    if (reason !== undefined) {
      brokenLocks.push(lock.id);
      warnings.push({ code: 'lock-broken', lock: lock.id, message: `lock ${lock.id} ${lock.label} broken by ${hunkText}: ${reason || '(no reason given)'}` });
      continue;
    }
    const agreed = lock.agreedIn ? `agreed in ${lock.agreedIn}` : 'agreed';
    if (!cfg.enforceLocks) {
      warnings.push({ code: 'lock', lock: lock.id, message: `${hunkText} changes ${lock.id} ${lock.label} (${agreed}; guards.enforceLocks is off)` });
      continue;
    }
    if (!p.lastDeliveredAt || (lock.createdAt && lock.createdAt > p.lastDeliveredAt)) {
      warnings.push({ code: 'lock-new', lock: lock.id, message: `${hunkText} changes ${lock.id} ${lock.label}, agreed after your last packet (not refused; keep it from now on)` });
      continue;
    }
    errors.push({
      code: 'lock',
      lock: lock.id,
      hunk: lock.hunks[0],
      message: `${hunkText} changes ${lock.id} ${lock.label} (${agreed})`,
      fix: `${undoIt(doc, lock.hunks[0])}, or, if the user agreed to change it, --break-lock ${lock.id}="<reason>"`,
    });
  }

  // applied suggestions that the working copy lost (`reverted`: see the header); reported after the rewrite check
  /** @type {GuardIssue[]} */
  const revertedIssues = [];
  for (const s of p.applied ?? []) {
    const issue = revertedSuggestion(p, s, byId);
    if (issue) revertedIssues.push(issue);
  }
  const revertedHunks = new Set(revertedIssues.map((e) => e.hunk));

  // 2. unexplained deletions / unlinked hunks (of the measured text: see the header)
  const m = measure(p);
  /** @type {string[]} */
  const unexplained = [];
  for (const h of p.hunks) {
    if (h.other != null) continue;
    const hm = /** @type {HunkMeasure} */ (m.hunks.get(h.id));
    const otherAt = h.newLines === 0 ? `del:${h.id}` : h.id;
    const explain = `explain it: "other":[{"at":"${otherAt}","why":"..."}]`;
    const lines = linesLabel(newLineRange(h));
    if (h.threads.length) {
      // A link explains its threads' scopes, plus, for an explicit `at`, the lines it names - not everything the
      // hunk removes. An overlap link is only inferred: naming the hunk's lines in "at" makes it explicit.
      const o = hm.outside;
      if (!o || cfg.unexplainedDeletion === 'off') continue;
      if (o.removedWords < cfg.unexplainedWords && o.wholeLinesRemoved < cfg.unexplainedDeletionLines) continue;
      const ts = h.threads.join(', ');
      const one = h.threads.length === 1;
      const issue = h.linkedBy === 'overlap'
        ? {
            code: /** @type {GuardCode} */ ('deletion'),
            hunk: h.id,
            message: `${h.id} ${removalText(o, cfg)} (${where(h)}) outside the text of ${ts} (linked to ${ts} only because it overlaps ${one ? `${ts}'s` : 'their'} text)`,
            fix: `${undoIt(doc, h.id)}, or, if ${h.threads.join(' or ')} asked for the whole change, name its lines ("${lines}") in ${one ? `${ts}'s` : 'that thread\'s'} "at", or ${explain}`,
          }
        : {
            code: /** @type {GuardCode} */ ('deletion'),
            hunk: h.id,
            message: `${h.id} ${removalText(o, cfg)} (${where(h)}) outside the text of ${ts} and the lines named in ${one ? 'its' : 'their'} "at"`,
            fix: `${undoIt(doc, h.id)}, or, if a thread asked for it, add its lines ("${lines}") to that thread's "at", or ${explain}`,
          };
      (cfg.unexplainedDeletion === 'refuse' ? errors : warnings).push(issue);
      continue;
    }
    unexplained.push(h.id);
    const s = hm.stats;
    const big = s.removedWords >= cfg.unexplainedWords || s.wholeLinesRemoved >= cfg.unexplainedDeletionLines;
    if (big && cfg.unexplainedDeletion !== 'off') {
      const issue = {
        code: /** @type {GuardCode} */ ('deletion'),
        hunk: h.id,
        message: `${h.id} ${removalText(s, cfg)} (${where(h)}) linked to no thread`,
        fix: `${undoIt(doc, h.id)}, or, if a thread asked for it, add its lines ("${lines}") to that thread's "at", or ${explain}`,
      };
      (cfg.unexplainedDeletion === 'refuse' ? errors : warnings).push(issue);
    } else if (!revertedHunks.has(h.id)) {
      // (a hunk that undoes an applied suggestion gets the `reverted` error instead, whose fix is the one to follow)
      const link = h.newLines > 0 ? `if a thread asked for it, add "${lines}" to that thread's "at"; else ` : '';
      warnings.push({ code: 'unlinked', hunk: h.id, message: `${h.id} ${newLinesText(h)} is linked to no thread (${link}${explain})` });
    }
  }

  // 3. rewrite ratio: the measured text removed or replaced where no thread asked for a change
  if (m.unaskedRatio > cfg.maxRewriteRatio && m.sized && !flags.allowRewrite) {
    const unasked = p.hunks.filter((h) => (m.hunks.get(h.id)?.unasked ?? 0) > 0).map((h) => h.id);
    const list = unasked.length > 8 ? `${unasked.slice(0, 8).join(', ')} and ${unasked.length - 8} more` : unasked.join(', ');
    errors.push({
      code: 'rewrite',
      message: `rewrites ${pct(m.unaskedRatio)} of the ${p.format === 'html' ? 'visible ' : ''}text of v${p.headVersion} where no thread asked for a change (limit ${pct(cfg.maxRewriteRatio)}): ${list}`,
      fix:
        `undo what no thread asked for where you made it (in the sources, then rebuild, for a document built from them; \`suiko revert ${doc} --hunk hN\` ` +
        'restores a file edited directly), or, if a thread asked for it, add the lines of its hunks to that thread\'s "at" (lines of the new file), ' +
        'or --allow-rewrite (only if the user asked for a rewrite)',
    });
  }

  // 3b. applied suggestions that the working copy lost (computed above)
  errors.push(...revertedIssues);

  // 4. replies
  const replies = p.replies ?? {};
  for (const tid of p.actionable ?? []) {
    if (!replies[tid]) warnings.push({ code: 'reply', thread: tid, message: `${tid} has no reply entry (add "${tid}":{"status":"...","reply":"..."})` });
  }
  for (const [tid, r] of Object.entries(replies)) {
    if (r?.status !== 'addressed') continue;
    if ((p.threadLinks?.[tid] ?? []).length || (p.assetLinks?.[tid] ?? []).length) continue;
    const lines = p.threadLines?.[tid];
    const hint = lines ? `add "at":"${linesLabel(lines)}" if you changed it` : 'add "at":"L<a>-<b>" if you changed it';
    warnings.push({ code: 'addressed', thread: tid, message: `${tid} marked addressed but no hunk is linked to it (${hint})` });
  }

  // 5. decisions
  if (p.mapper) {
    for (const d of p.decisions ?? []) {
      for (const h of p.mapper.hunksTouching(d.start, d.end)) {
        const ah = byId.get(h.id);
        if (ah && !ah.threads.includes(d.thread)) {
          warnings.push({ code: 'decision', hunk: h.id, thread: d.thread, message: `decision ${d.id} (${d.thread}) region modified by ${h.id}, which is not linked to ${d.thread}` });
        }
      }
    }
  }

  // 6. input problems
  for (const o of p.unusedOther ?? []) warnings.push({ code: 'other', message: `other entry at "${o.at}" ${o.reason}` });
  for (const b of p.badHints ?? []) warnings.push({ code: 'hint', thread: b.thread, message: `${b.thread} "at":"${b.at}" ignored: ${b.reason}` });

  // The fixes get run top to bottom, and reverting a hunk renumbers the hunks after it: list the errors bottom-up,
  // and suggest each hunk's revert once (a second `--hunk h1` would revert the hunk that became h1).
  const hunkNo = (/** @type {GuardIssue} */ e) => (e.hunk ? Number(String(e.hunk).replace(/^h/, '')) || 0 : -1);
  errors.sort((a, b) => hunkNo(b) - hunkNo(a));
  /** @type {Set<string>} */
  const reverted = new Set();
  for (const e of errors) {
    const revert = e.hunk ? `\`suiko revert ${doc} --hunk ${e.hunk}\`` : null;
    if (!revert || !e.hunk || !e.fix?.includes(revert)) continue;
    if (reverted.has(e.hunk)) e.fix = e.fix.replace(revert, `the revert of ${e.hunk} above`);
    else reverted.add(e.hunk);
  }

  const forced = Boolean(flags.force) && errors.length > 0;
  return {
    refused: errors.length > 0 && !flags.force,
    forced,
    errors,
    warnings,
    brokenLocks,
    intactLocks,
    unexplained,
    rewriteRatio: m.ratio,
    unaskedRatio: m.unaskedRatio,
  };
}

/**
 * The undo part of a fix line (see the header): where to undo a change, not just `suiko revert`.
 * @param {string} doc
 * @param {string} hunk
 * @returns {string}
 */
function undoIt(doc, hunk) {
  return `undo it where you made it (in the sources, then rebuild, for a document built from them; \`suiko revert ${doc} --hunk ${hunk}\` restores a file edited directly)`;
}

/** Occurrences of an applied suggestion's text in head looked at by the `reverted` check. */
const MAX_SUGGESTION_HITS = 50;

/**
 * The `reverted` refusal of one applied suggestion (see the header), or null: its text (whitespace aside: line
 * endings, a re-wrap) is in head and nowhere in the working copy, and no hunk that removes it is linked explicitly
 * (`at`, a tagged edit) or explained by `other`.
 * @param {Parameters<typeof runGuards>[0]} p
 * @param {AppliedSuggestion} s
 * @param {Map<string, AttributedHunk>} byId
 * @returns {GuardIssue | null}
 */
function revertedSuggestion(p, s, byId) {
  const flat = collapseWs(String(s.text ?? '')).trim();
  if (!p.mapper || !flat) return null;
  const re = new RegExp(flat.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g');
  if (re.test(p.workingSource ?? '')) return null;
  re.lastIndex = 0;
  /** @type {AttributedHunk[]} */
  const removing = [];
  let hits = 0;
  for (const m of (p.headSource ?? '').matchAll(re)) {
    if (++hits > MAX_SUGGESTION_HITS) break;
    const at = m.index ?? 0;
    for (const mh of p.mapper.hunksTouching(at, at + m[0].length)) {
      const h = byId.get(mh.id);
      if (h && !removing.includes(h)) removing.push(h);
    }
  }
  if (!removing.length || removing.some((h) => h.linkedBy === 'hint' || h.linkedBy === 'tagged' || h.other != null)) return null;
  const h = removing.sort((a, b) => a.oldStartOff - b.oldStartOff)[0];
  const quote = flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
  return {
    code: 'reverted',
    hunk: h.id,
    thread: s.thread,
    message: `${h.id} removes ${s.thread}'s applied suggestion "${quote}"${s.appliedIn != null ? ` (applied in v${s.appliedIn})` : ''}`,
    fix:
      'a rebuild from sources brings back the old text: put the suggestion into the sources and rebuild. ' +
      `If a thread asked to change it again, add its lines ("${linesLabel(newLineRange(h))}") to that thread's "at"`,
  };
}

/**
 * '... removes 4 lines' / '... removes or replaces 22 words'.
 * @param {{ removedWords: number, wholeLinesRemoved: number }} s
 * @param {Config['guards']} cfg
 */
function removalText(s, cfg) {
  return s.wholeLinesRemoved >= cfg.unexplainedDeletionLines
    ? `removes ${s.wholeLinesRemoved} line${s.wholeLinesRemoved === 1 ? '' : 's'}`
    : `removes or replaces ${s.removedWords} words`;
}

// ------------------------------------------------------------------------------------------------ measuring

/**
 * @typedef {{ removedWords: number, wholeLinesRemoved: number }} Removal
 * @typedef {object} HunkMeasure what a hunk removes of the measured text (see the header)
 * @property {number} removed measured characters it removes or replaces
 * @property {number} unasked ... of them where no thread asked for a change
 * @property {Removal} stats its removal (the deletion check of an unlinked hunk)
 * @property {Removal | null} outside its removal beyond its threads' scopes (hint / overlap links; null: none)
 * @typedef {object} Measure
 * @property {Map<string, HunkMeasure>} hunks
 * @property {number} ratio
 * @property {number} unaskedRatio
 * @property {boolean} sized whether head is large enough for the rewrite check
 */

/**
 * Measures every hunk against what the reviewer reads (see the header).
 * @param {Parameters<typeof runGuards>[0]} p
 * @returns {Measure}
 */
function measure(p) {
  const format = p.format === 'html' ? 'html' : 'markdown';
  const html = format === 'html';
  const head = p.headSource ?? '';
  const work = p.workingSource ?? '';
  const hidden = hiddenRanges(format, head);
  const hiddenWork = hiddenRanges(format, work);
  const li = lineIndex(head);
  const total = countVisible(head, hidden, 0, head.length, html);
  const words = hidden.length ? countWords(visibleText(head, hidden).text) : countWords(head);
  const sized = (!html && p.headLines >= REWRITE_MIN_LINES) || words >= REWRITE_MIN_WORDS;
  /** @param {Array<[number, number]>} ranges */
  const count = (ranges) => ranges.reduce((n, [s, e]) => n + countVisible(head, hidden, s, e, html), 0);

  /** @type {Map<string, HunkMeasure>} */
  const out = new Map();
  let removedAll = 0;
  let unaskedAll = 0;
  for (const h of p.hunks) {
    const explained = explainedRanges(p, h, li, head);
    /** @type {HunkMeasure} */
    let hm;
    if (!html && !touchesAny(hidden, h.oldStartOff, h.oldEndOff) && !touchesAny(hiddenWork, h.newStartOff, h.newEndOff)) {
      // nothing hidden in this Markdown hunk: measured exactly as it always was
      const changed = (p.mapper ? p.mapper.changedOld(h) : hunkStats(head, work, h).changedOldRanges).filter(([s, e]) => e > s);
      const removed = changed.reduce((n, [s, e]) => n + e - s, 0);
      const unasked = explained === null ? removed : Array.isArray(explained) ? subtractAll(changed, explained).reduce((n, [s, e]) => n + e - s, 0) : 0;
      hm = { removed, unasked, stats: h.stats, outside: h.outside };
    } else {
      const removedRanges = visibleRemoval(head, work, hidden, hiddenWork, h);
      const removed = count(removedRanges);
      const rest = Array.isArray(explained) ? subtractAll(removedRanges, explained) : [];
      const unasked = explained === null ? removed : count(rest);
      const stats = removalOf(head, hidden, li, h, removedRanges, []);
      /** @type {Removal | null} */
      let outside = null;
      if (Array.isArray(explained)) {
        const o = removalOf(head, hidden, li, h, rest, explained);
        if (o.removedWords || o.wholeLinesRemoved) outside = o;
      } else if (explained === undefined) {
        outside = h.outside;
      }
      hm = { removed, unasked, stats, outside };
    }
    out.set(h.id, hm);
    removedAll += hm.removed;
    unaskedAll += hm.unasked;
  }
  const denom = Math.max(1, total);
  return { hunks: out, ratio: removedAll / denom, unaskedRatio: unaskedAll / denom, sized };
}

/**
 * The head ranges a hunk's thread links explain, as attribution computes `outside`: its threads' scopes (widened to
 * whole lines where the lines are short) and, for a hint link, what lands on the lines the `at` names
 * (`atExplained`); null for an unlinked hunk (nothing asked for), 'all' for a tagged edit or a GENERAL thread,
 * undefined when a hint / overlap link has no scopes to go by (no `p.scopes`: the link explains the whole hunk,
 * attribution's `outside` stands).
 * @param {Parameters<typeof runGuards>[0]} p
 * @param {AttributedHunk} h
 * @param {ReturnType<typeof lineIndex>} li
 * @param {string} head
 * @returns {Array<[number, number]> | 'all' | null | undefined}
 */
function explainedRanges(p, h, li, head) {
  if (!h.threads.length) return null;
  if (h.linkedBy === 'tagged' || h.oldLines === 0) return 'all';
  if (!p.scopes) return undefined;
  const sc = h.threads.map((t) => p.scopes?.[t] ?? []);
  if (sc.includes('all')) return 'all';
  return mergeRanges([...scopeRanges(li, head, /** @type {Array<[number, number]>} */ (sc.flat())), ...(h.atExplained ?? [])]);
}

/**
 * Head ranges of the visible text a hunk removes or replaces: a word diff of the visible text of its two sides,
 * mapped back to head offsets (hidden text never counts, however much of it changed).
 * @param {string} head
 * @param {string} work
 * @param {Array<[number, number]>} hidden
 * @param {Array<[number, number]>} hiddenWork
 * @param {AttributedHunk} h
 * @returns {Array<[number, number]>}
 */
function visibleRemoval(head, work, hidden, hiddenWork, h) {
  const ov = visibleText(head, hidden, h.oldStartOff, h.oldEndOff);
  const nv = visibleText(work, hiddenWork, h.newStartOff, h.newEndOff);
  /** @type {Array<[number, number]>} */
  const out = [];
  for (const op of hunkWordOps(ov.text, nv.text)) {
    if (op.op !== 'del') continue;
    for (let i = op.aStart; i < op.aEnd; i++) {
      const off = ov.map[i];
      if (off < 0) continue;
      const last = out[out.length - 1];
      if (last && last[1] === off) last[1] = off + 1;
      else out.push([off, off + 1]);
    }
  }
  return out;
}

/**
 * Words and whole old lines a hunk removes, counting only the `removed` ranges (visible text) and leaving out the old
 * lines that lie wholly inside `explained` (as attribution's removalStats). A line is wholly removed when it has
 * visible text and all of it (whitespace aside) is removed.
 * @param {string} head
 * @param {Array<[number, number]>} hidden
 * @param {ReturnType<typeof lineIndex>} li
 * @param {AttributedHunk} h
 * @param {Array<[number, number]>} removed sorted, disjoint
 * @param {Array<[number, number]>} explained
 * @returns {Removal}
 */
function removalOf(head, hidden, li, h, removed, explained) {
  const removedWords = removed.reduce((n, [s, e]) => n + countWords(head.slice(s, e)), 0);
  let wholeLinesRemoved = 0;
  let k = 0;
  for (let l = h.oldStart; l < h.oldStart + h.oldLines; l++) {
    const ls = li.startOf(l);
    const le = li.endOf(l);
    while (k < removed.length && removed[k][1] <= ls) k++;
    if (explained.some(([es, ee]) => es <= ls && le <= ee)) continue;
    const visible = countVisible(head, hidden, ls, le, true);
    if (!visible) continue;
    let gone = 0;
    for (let j = k; j < removed.length && removed[j][0] < le; j++) gone += countVisible(head, hidden, Math.max(removed[j][0], ls), Math.min(removed[j][1], le), true);
    if (gone >= visible) wholeLinesRemoved++;
  }
  return { removedWords, wholeLinesRemoved };
}

/**
 * Whether [s, e) intersects one of the sorted, disjoint ranges.
 * @param {Array<[number, number]>} ranges
 * @param {number} s
 * @param {number} e
 */
function touchesAny(ranges, s, e) {
  return ranges.some(([a, b]) => a < e && s < b);
}

/**
 * Ranges minus a set of ranges.
 * @param {Array<[number, number]>} ranges
 * @param {Array<[number, number]>} cut
 * @returns {Array<[number, number]>}
 */
function subtractAll(ranges, cut) {
  /** @type {Array<[number, number]>} */
  let out = ranges.map(([s, e]) => [s, e]);
  for (const [cs, ce] of cut) {
    /** @type {Array<[number, number]>} */
    const next = [];
    for (const [s, e] of out) {
      if (ce <= s || cs >= e) next.push([s, e]);
      else {
        if (cs > s) next.push([s, cs]);
        if (ce < e) next.push([ce, e]);
      }
    }
    out = next;
  }
  return out;
}

/**
 * 'v1 L201-214, §8 Open questions' (old lines of the hunk in the head version).
 * @param {AttributedHunk} h
 * @param {number} headVersion
 * @param {string} [section]
 */
function hunkWhere(h, headVersion, section) {
  const lines = h.oldLines > 0 ? linesLabel(oldLineRange(h)) : `before L${h.oldStart}`;
  return `v${headVersion} ${lines}${section ? `, §${section}` : ''}`;
}

/**
 * 'L171-174' (new lines) or 'del v-lines' for pure deletions.
 * @param {AttributedHunk} h
 */
export function newLinesText(h) {
  return h.newLines > 0 ? linesLabel(newLineRange(h)) : `(deleted old ${linesLabel(oldLineRange(h))})`;
}

/** @param {number} r */
function pct(r) {
  return `${Math.round(r * 100)}%`;
}

/**
 * Flattens issues for a version manifest (`guards.errors` / `guards.warnings` are string arrays there).
 * @param {GuardIssue[]} issues
 * @returns {string[]}
 */
export function issueStrings(issues) {
  return issues.map((i) => `${i.code}: ${i.message}`);
}
