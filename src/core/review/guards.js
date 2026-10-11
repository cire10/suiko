// @ts-check
// Revision guards (BUILD_AMENDMENTS 4.4, which overrides design 8.4). Content based:
//
// | check                                                                  | default | override                        |
// |------------------------------------------------------------------------|---------|---------------------------------|
// | an active lock's normalised text is no longer intact in the new text  | refuse  | --break-lock L1="reason"        |
// |   ... but the lock was created after the last packet delivered         | warn    |                                 |
// | unlinked, unexplained hunk removing/replacing >= guards.unexplainedWords| refuse  | other entry, revert --hunk,     |
// |   words or >= guards.unexplainedDeletionLines whole old lines          |         | guards.unexplainedDeletion      |
// |   ... the same amount removed OUTSIDE the scopes of the threads a hint |         |                                 |
// |   or overlap link names (attribution `outside`)                        | refuse  | (same)                          |
// | rewriteRatio > guards.maxRewriteRatio and head has >= 40 lines         | refuse  | --allow-rewrite                 |
// | actionable thread without a reply entry                                | warn    |                                 |
// | thread marked addressed with no linked hunk and no asset change        | warn    | add "at"                        |
// | decision anchor intersects a hunk not linked to the decision's thread  | warn    |                                 |
// | --force                                                                | overrides every refusal (recorded)        |
//
// A lock is intact when no hunk changes characters inside its range, when its whitespace-normalised source text still
// occurs in the new text at least as often as in the old one (moved or re-wrapped), or when the rendered text of its
// range (markup stripped, whitespace collapsed) equals the rendered text of the mapped range in the new text
// (re-wrapped with continuation markup such as a Markdown blockquote's "> "). Locks marked in `flags.breakLocks` are
// reported as broken (they become inactive when the version is recorded).

import { rewriteRatio } from '../diff/index.js';
import { collapseWs, sourceToPlainText } from '../text/index.js';
import { findOccurrences } from './apply.js';
import { linesLabel } from './labels.js';
import { newLineRange, oldLineRange } from './attribution.js';

/**
 * @typedef {import('./attribution.js').AttributedHunk} AttributedHunk
 * @typedef {import('../../shared/types.js').Config} Config
 * @typedef {'lock' | 'lock-new' | 'lock-broken' | 'deletion' | 'rewrite' | 'reply' | 'addressed' | 'decision'
 *   | 'unlinked' | 'other' | 'hint'} GuardCode
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
 * @property {number} rewriteRatio
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
  const touching = mapper.hunksTouching(start, end).map((h) => h.id);
  if (!touching.length) return { intact: true, hunks: [] };
  const text = collapseWs(headSource.slice(start, end)).trim();
  if (!text) return { intact: true, hunks: touching };
  const before = findOccurrences(collapseWs(headSource), text).length;
  const after = findOccurrences(collapseWs(workingSource), text, before).length;
  if (after >= before && after > 0) return { intact: true, hunks: touching };
  const mapped = mapper.mapRange(start, end);
  const oldPlain = plainOf(format, headSource, start, end);
  const intact = oldPlain !== '' && oldPlain === plainOf(format, workingSource, mapped.start, mapped.end);
  return { intact, hunks: touching };
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
      fix: `specreview revert ${doc} --hunk ${lock.hunks[0]}   or   --break-lock ${lock.id}="<reason>"`,
    });
  }

  // 2. unexplained deletions / unlinked hunks
  /** @type {string[]} */
  const unexplained = [];
  for (const h of p.hunks) {
    if (h.other != null) continue;
    if (h.threads.length) {
      // An inferred (overlap) or line-hint link explains the thread's own lines, not everything the hunk removes.
      const o = h.outside;
      if (!o || cfg.unexplainedDeletion === 'off') continue;
      if (o.removedWords < cfg.unexplainedWords && o.wholeLinesRemoved < cfg.unexplainedDeletionLines) continue;
      const otherAt = h.newLines === 0 ? `del:${h.id}` : h.id;
      const what =
        o.wholeLinesRemoved >= cfg.unexplainedDeletionLines
          ? `removes ${o.wholeLinesRemoved} line${o.wholeLinesRemoved === 1 ? '' : 's'}`
          : `removes or replaces ${o.removedWords} words`;
      const issue = {
        code: /** @type {GuardCode} */ ('deletion'),
        hunk: h.id,
        message: `${h.id} ${what} (${where(h)}) outside the text of ${h.threads.join(', ')} it is linked to (${h.linkedBy})`,
        fix: `specreview revert ${doc} --hunk ${h.id}   or   add "other":[{"at":"${otherAt}","why":"..."}]`,
      };
      (cfg.unexplainedDeletion === 'refuse' ? errors : warnings).push(issue);
      continue;
    }
    unexplained.push(h.id);
    const big = h.stats.removedWords >= cfg.unexplainedWords || h.stats.wholeLinesRemoved >= cfg.unexplainedDeletionLines;
    const otherAt = h.newLines === 0 ? `del:${h.id}` : h.id;
    if (big && cfg.unexplainedDeletion !== 'off') {
      const what =
        h.stats.wholeLinesRemoved >= cfg.unexplainedDeletionLines
          ? `removes ${h.stats.wholeLinesRemoved} line${h.stats.wholeLinesRemoved === 1 ? '' : 's'}`
          : `removes or replaces ${h.stats.removedWords} words`;
      const issue = {
        code: /** @type {GuardCode} */ ('deletion'),
        hunk: h.id,
        message: `${h.id} ${what} (${where(h)}) linked to no thread`,
        fix: `specreview revert ${doc} --hunk ${h.id}   or   add "other":[{"at":"${otherAt}","why":"..."}]`,
      };
      (cfg.unexplainedDeletion === 'refuse' ? errors : warnings).push(issue);
    } else {
      warnings.push({ code: 'unlinked', hunk: h.id, message: `${h.id} ${newLinesText(h)} is linked to no thread (explain it: "other":[{"at":"${otherAt}","why":"..."}])` });
    }
  }

  // 3. rewrite ratio
  const ratio = rewriteRatio(p.headSource, p.workingSource, p.hunks);
  if (ratio > cfg.maxRewriteRatio && p.headLines >= 40 && !flags.allowRewrite) {
    errors.push({
      code: 'rewrite',
      message: `rewrites ${pct(ratio)} of v${p.headVersion} (limit ${pct(cfg.maxRewriteRatio)})`,
      fix: `make targeted edits (undo with specreview revert ${doc} --hunk hN)   or   --allow-rewrite (only if the user asked for a rewrite)`,
    });
  }

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

  const forced = Boolean(flags.force) && errors.length > 0;
  return { refused: errors.length > 0 && !flags.force, forced, errors, warnings, brokenLocks, intactLocks, unexplained, rewriteRatio: ratio };
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
