// @ts-check
// `<name>.decisions.md`, written by `specreview final --decisions` (design 8.9): for every decision and every
// resolved thread, the decision, the quoted context, the resolution (the agent's last reply) and the version and
// hunk that changed it. Pure: renderDecisionsMarkdown returns the text; ops/final.js writes it atomically.

import { compareIds } from '../store/store.js';
import { toWordBounds } from '../text/index.js';
import { sectionPath } from './labels.js';
import { anchorAt, hasContent, originalAnchor } from './threadstate.js';

/**
 * @typedef {import('../../shared/types.js').Doc} Doc
 * @typedef {import('../../shared/types.js').Thread} Thread
 * @typedef {import('../../shared/types.js').Review} Review
 */

/**
 * @param {object} p
 * @param {Doc} p.doc
 * @param {Thread[]} p.threads
 * @param {Review[]} p.reviews
 * @param {number} p.versions number of versions
 * @returns {string}
 */
export function renderDecisionsMarkdown({ doc, threads, reviews, versions }) {
  const final = doc.final;
  const out = [`# Decisions: ${doc.title || doc.id}`, ''];
  out.push(`- Spec: \`${doc.path}\``);
  if (final) {
    const day = String(final.at ?? '').slice(0, 10);
    out.push(`- Final version: v${final.version} (approved in ${final.review} by ${final.by}${day ? ` on ${day}` : ''})`);
  } else {
    out.push(`- Final version: none (head v${doc.head})`);
  }
  out.push(`- History: ${versions} version${versions === 1 ? '' : 's'}, ${reviews.length} review${reviews.length === 1 ? '' : 's'}`);
  out.push('');

  const resolved = threads.filter((t) => t.status === 'resolved').sort((a, b) => compareIds(a.id, b.id));
  const withDecision = resolved
    .filter((t) => t.decision?.text)
    .sort((a, b) => compareIds(/** @type {any} */ (a.decision).id, /** @type {any} */ (b.decision).id));
  const without = resolved.filter((t) => !t.decision?.text);

  out.push('## Decisions', '');
  if (!withDecision.length) out.push('_No decisions were recorded._', '');
  for (const t of withDecision) {
    const d = /** @type {NonNullable<Thread['decision']>} */ (t.decision);
    out.push(`### ${d.id}: ${oneLine(d.text)}`, '');
    out.push(...threadFacts(t, doc));
    out.push('');
  }

  out.push('## Resolved threads', '');
  if (!without.length) out.push('_None without a decision._', '');
  for (const t of without) {
    // the reviewer's request (an agent question has none: its own first comment); an empty one is skipped
    const human = t.comments?.filter((c) => c.by?.kind !== 'agent') ?? [];
    const first = human.length ? human.find(hasBody) : t.comments?.[0];
    const headline = first?.body || (t.suggestion ? `suggests: ${firstLine(t.suggestion.new)}` : t.attachments?.length ? `${t.type} (image only, no text)` : t.type);
    out.push(`### ${t.id}: ${oneLine(headline, 100)}`, '');
    out.push(...threadFacts(t, doc));
    out.push('');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/**
 * Bullet list describing one thread.
 * @param {Thread} t
 * @param {Doc} doc
 * @returns {string[]}
 */
function threadFacts(t, doc) {
  const anchor = anchorAt(t, t.resolvedIn ?? Infinity) ?? originalAnchor(t);
  const section = sectionPath(anchor?.section ?? [], doc.title);
  const out = [`- Thread: ${t.id} (${t.type}${t.severity && t.severity !== 'normal' ? `, ${t.severity}` : ''})${section ? ` · §${section}` : ''}${t.resolvedIn ? ` · resolved in v${t.resolvedIn}` : ''}`];
  // widened to whole words: a selection that starts or ends mid-word ('eploy to staging') reads badly in a quote
  const src = anchor?.src;
  const context = t.decision?.srcText && t.decision.srcText !== src?.text
    ? t.decision.srcText
    : src?.text ? toWordBounds(src.text, src.prefix, src.suffix) : anchor?.quote?.exact ?? '';
  if (context.trim()) {
    out.push('- Context:', '');
    for (const line of clip(context).split('\n')) out.push(`  > ${line}`);
    out.push('');
  }
  // comments without a body (a suggestion submitted without a comment) are left out
  const asked = t.comments?.find((c) => c.by?.kind !== 'agent' && hasBody(c));
  if (asked) out.push(`- Asked (${asked.by?.name ?? 'reviewer'}, v${asked.version}): ${oneLine(asked.body, 300)}`);
  const reply = [...(t.comments ?? [])].reverse().find((c) => c.by?.kind === 'agent' && hasContent(c));
  if (reply) {
    const said = hasBody(reply) ? `: ${oneLine(reply.body, 400)}` : '';
    out.push(`- Resolution (${reply.by?.name ?? 'agent'}, v${reply.version}${reply.status ? `, ${reply.status}` : ''})${said}`);
  }
  if (t.suggestion?.status === 'applied') out.push(...suggestionLines(t.suggestion.new, t.suggestion.appliedIn));
  const changes = (t.changes ?? []).map((c) => `v${c.version} ${c.hunk}`);
  if (changes.length) out.push(`- Changed in: ${changes.join(', ')}`);
  return out;
}

/**
 * '- Suggestion applied in v2: …': a code span for one line, else a fenced block under the bullet that keeps the
 * line breaks. Fences are longer than any backtick run inside, so inline code in the suggestion cannot end them.
 * @param {string} text
 * @param {number | null | undefined} v
 * @returns {string[]}
 */
function suggestionLines(text, v) {
  const s = String(text ?? '').replace(/\r\n/g, '\n').replace(/^\n+|\s+$/g, '');
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
  const head = `- Suggestion applied in v${v}:`;
  if (!s.includes('\n')) {
    const fence = '`'.repeat(longest + 1);
    const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
    return [`${head} ${fence}${pad}${s}${pad}${fence}`];
  }
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [head, '', `  ${fence}text`, ...clip(s).split('\n').map((l) => (l ? `  ${l}` : '')), `  ${fence}`, ''];
}

/**
 * The first non-empty line, with ' …' when more lines follow.
 * @param {string} s
 */
function firstLine(s) {
  const lines = String(s ?? '').split(/\r?\n/).filter((l) => l.trim());
  return lines.length > 1 ? `${lines[0].trim()} …` : (lines[0] ?? '').trim();
}

/**
 * @param {{ body?: string | null } | null | undefined} c
 */
function hasBody(c) {
  return Boolean(String(c?.body ?? '').trim());
}

/**
 * @param {string} s
 * @param {number} [max]
 */
function oneLine(s, max = 160) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * At most 12 lines of quoted context.
 * @param {string} s
 */
function clip(s) {
  const lines = String(s).replace(/\r\n/g, '\n').trimEnd().split('\n');
  return lines.length > 12 ? [...lines.slice(0, 11), `…(${lines.length - 11} more lines)`].join('\n') : lines.join('\n');
}
