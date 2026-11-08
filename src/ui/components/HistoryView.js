// @ts-check
// History mode (design 8.9): a timeline interleaving versions and reviews, newest first, in plain words.
// - A version row: vN, "latest" / "Final", who recorded it and when, "answers your review" (the review's id in the
//   tooltip), its summary, +/- stats, the threads it changed and guard badges, with View / What changed (the
//   comparison with the version before) / Compare with… (any other version).
// - A review row: what the reviewer did as a sentence ("You sent 2 comments", "You applied 1 planned change", "You
//   approved v3") with a chip for the kind of review ("Feedback", "Needs changes", "Approved vN"), the version it was
//   on, when, and whether the agent has it ("Claude has it · 03:03") or it waits for the agent to connect ("Waiting
//   for Claude"). Review ids (rvN) are only in tooltips.
// - Comments sent one at a time (Send comments: Right away) are one-item reviews; a run of two or more of them with no
//   version between is one row ("5 comments sent · 03:17–03:19") that expands to list them (historyGroups).
// Test hooks: version rows carry TESTID.historyRow and data-version; review rows the class tl-review and
// data-review (the ids they hold, space-separated); a merged row also tl-group, with its toggle aria-expanded.

import { html, useState } from 'preact-htm';
import { TESTID } from 'protocol';
import { compareVersions, focusItem, viewVersion } from '../actions.js';
import { Markdown } from '../markdown.js';
import {
  actorLabel, agentName, agentTitle, formatClock, guardBadges, isAgent, relTime, threadsOfVersion, timeline, versionNumbers,
} from '../model.js';
import { useStore } from '../state.js';
import { Chip } from './common.js';

/** @param {number} n @param {string} one @param {string} [many] */
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a review's chip says it was, and its tone. @param {any} rv @returns {[string, string]} */
function verdictChip(rv) {
  if (rv.verdict === 'approved') return [`Approved v${rv.version}`, 'ok'];
  if (rv.verdict === 'changes_requested') return ['Needs changes', 'warn'];
  if (rv.verdict === 'comment') return ['Feedback', 'muted'];
  return [String(rv.verdict || 'Review'), 'muted'];
}

/** The comments and replies a review (or a run of them) sent: "2 comments and 1 reply", or ''. @param {any[]} rvs */
function itemsSent(rvs) {
  const comments = rvs.reduce((n, rv) => n + (rv.newThreads || []).length, 0);
  const replies = rvs.reduce((n, rv) => n + (rv.replies || []).length, 0);
  return [comments ? plural(comments, 'comment') : '', replies ? plural(replies, 'reply', 'replies') : ''].filter(Boolean).join(' and ');
}

/** The reviewer's part of a review, as a sentence. @param {any} rv */
function sentence(rv) {
  const who = actorLabel(rv.by);
  const what = itemsSent([rv]);
  const applied = (rv.apply || []).length;
  if (applied) return `${who} applied ${plural(applied, 'planned change')}${what ? ` and sent ${what}` : ''}`;
  if (rv.verdict === 'approved') return `${who} approved v${rv.version}${what ? ` and sent ${what}` : ''}`;
  if (what) return `${who} sent ${what}`;
  return rv.verdict === 'changes_requested' ? `${who} asked for changes` : `${who} sent feedback`;
}

/**
 * Whether the agent has a review: "Claude has it · 03:03", or that it waits for the agent to connect.
 * @param {any} rv @param {string} agent the doc's agent, as written in sentences
 * @returns {{ text: string, title: string, delivered: boolean }}
 */
function delivery(rv, agent) {
  const got = Object.entries(rv.deliveredTo || {});
  if (!got.length) return { text: `Waiting for ${agent}`, title: `${agent} gets it when it connects`, delivered: false };
  const [name, at] = got[0];
  return { text: `${agentTitle(name)} has it · ${formatClock(String(at))}`.replace(/ · $/, ''), title: String(at), delivered: true };
}

/**
 * A review the reviewer sent alone, one comment or reply with nothing else (Send comments: Right away): one of a run
 * History shows as one row.
 * @param {any} rv
 */
export function isSingleItemReview(rv) {
  if (!rv || rv.verdict !== 'comment' || rv.instant === false || String(rv.body || '').trim()) return false;
  if ((rv.apply || []).length || (rv.locksAdded || []).length || (rv.resolved || []).length) return false;
  return (rv.newThreads || []).length + (rv.replies || []).length === 1;
}

/**
 * The timeline (model.js timeline, newest first) with every run of two or more one-item reviews that no version
 * separates merged into one entry (newest first inside it too).
 * @param {any} ds
 * @returns {Array<{ kind: 'version', at: string, v: number, meta: any } | { kind: 'review', at: string, review: any }
 *   | { kind: 'group', at: string, reviews: any[] }>}
 */
export function historyGroups(ds) {
  /** @type {any[]} */
  const out = [];
  /** @type {any[]} */
  let run = [];
  const flush = () => {
    if (run.length > 1) out.push({ kind: 'group', at: run[0].submittedAt, reviews: run });
    else if (run.length === 1) out.push({ kind: 'review', at: run[0].submittedAt, review: run[0] });
    run = [];
  };
  for (const it of timeline(ds)) {
    if (it.kind === 'review' && isSingleItemReview(it.review)) {
      run.push(it.review);
      continue;
    }
    flush();
    out.push(it);
  }
  flush();
  return out;
}

export function HistoryView() {
  const ds = useStore((s) => s.ds);
  const version = useStore((s) => s.version);
  const [compareFrom, setCompareFrom] = useState(/** @type {number|null} */ (null));
  const [open, setOpen] = useState(/** @type {Set<string>} */ (new Set()));
  if (!ds) return null;
  const items = historyGroups(ds);
  const all = versionNumbers(ds);
  const head = Number(ds.doc.head);
  const finalV = ds.doc.final?.version;
  const agent = agentTitle(agentName(ds));
  const nReviews = (ds.reviews || []).length;

  /** @param {string} key */
  const toggle = (key) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  return html`<div class="history-view">
    <h2 class="view-title">History <span class="small muted">${plural(all.length, 'version')}, ${plural(nReviews, 'review')}</span></h2>
    <ol class="timeline">
      ${items.map((it) => {
        if (it.kind === 'version') {
          const m = it.meta;
          const v = it.v;
          const threads = threadsOfVersion(ds, v);
          const badges = guardBadges(m);
          const answered = m.respondsTo ? (ds.reviews || []).find((/** @type {any} */ r) => r.id === m.respondsTo) : null;
          return html`<li class=${`tl-item tl-version ${version === v ? 'current' : ''}`} data-testid=${TESTID.historyRow} data-version=${String(v)} key=${`v${v}`}>
            <div class="tl-marker" aria-hidden="true"></div>
            <div class="tl-body">
              <div class="tl-head">
                <strong class="tl-id">v${v}</strong>
                ${v === head ? html`<${Chip} tone="accent">latest<//>` : null}
                ${finalV === v ? html`<${Chip} tone="ok">Final<//>` : null}
                <span>${isAgent(m.author) ? agentTitle(actorLabel(m.author)) : actorLabel(m.author)}</span>
                <time class="small muted" datetime=${m.createdAt} title=${m.createdAt}>${relTime(m.createdAt)} ${formatClock(m.createdAt)}</time>
                ${m.respondsTo ? html`<span class="small muted" title=${m.respondsTo}>answers your ${answered ? `review of ${formatClock(answered.submittedAt)}` : 'review'}</span>` : null}
              </div>
              ${m.summary ? html`<p class="tl-summary">${m.summary}</p>` : null}
              <div class="tl-meta">
                ${m.stats ? html`<span class="small"><span class="ins-text">+${m.stats.added ?? 0}</span> <span class="del-text">−${m.stats.removed ?? 0}</span></span>` : null}
                ${threads.map((t) => html`<button type="button" class="chip tone-accent chip-btn" key=${t} title=${`Show ${t} on v${v}`}
                  onClick=${() => { viewVersion(v); focusItem(t); }}>${t}</button>`)}
                ${badges.map((b) => html`<${Chip} tone=${b.tone} key=${b.key}>${b.label}<//>`)}
              </div>
              <div class="tl-actions">
                <button type="button" class="btn btn-sm" onClick=${() => viewVersion(v)}>View</button>
                <button type="button" class="btn btn-sm" disabled=${v <= all[0]} title=${v <= all[0] ? 'The first version' : `What changed from v${all[all.indexOf(v) - 1]} to v${v}`}
                  onClick=${() => compareVersions(all[all.indexOf(v) - 1], v)}>What changed</button>
                ${compareFrom === v ? html`<span class="compare-with">
                  <label class="sr-only" for=${`cmp-${v}`}>Compare v${v} with</label>
                  <select id=${`cmp-${v}`} class="select" onChange=${(/** @type {any} */ e) => {
                    const other = Number(e.currentTarget.value);
                    if (!other) return;
                    setCompareFrom(null);
                    compareVersions(Math.min(other, v), Math.max(other, v));
                  }}>
                    <option value="">Compare with…</option>
                    ${all.filter((x) => x !== v).map((x) => html`<option value=${String(x)}>v${x}</option>`)}
                  </select>
                  <button type="button" class="btn btn-sm" onClick=${() => setCompareFrom(null)}>Cancel</button>
                </span>` : html`<button type="button" class="btn btn-sm" disabled=${all.length < 2} onClick=${() => setCompareFrom(v)}>Compare with…</button>`}
              </div>
            </div>
          </li>`;
        }
        if (it.kind === 'group') return html`<${ReviewRun} key=${`g${it.reviews[0].id}`} reviews=${it.reviews} agent=${agent}
          open=${open.has(it.reviews[0].id)} onToggle=${() => toggle(it.reviews[0].id)} />`;
        const rv = it.review;
        const [label, tone] = verdictChip(rv);
        const d = delivery(rv, agent);
        const locks = (rv.locksAdded || []).length;
        return html`<li class="tl-item tl-review" key=${rv.id} data-review=${rv.id}>
          <div class="tl-marker" aria-hidden="true"></div>
          <div class="tl-body">
            <div class="tl-head" title=${rv.id}>
              <strong class="tl-what">${sentence(rv)}</strong>
              <${Chip} tone=${tone}>${label}<//>
              <span class="small muted">on v${rv.version}</span>
              <time class="small muted" datetime=${rv.submittedAt} title=${rv.submittedAt}>${relTime(rv.submittedAt)} ${formatClock(rv.submittedAt)}</time>
            </div>
            ${rv.body ? html`<${Markdown} text=${rv.body} class="tl-summary" />` : null}
            <div class="tl-meta small muted">
              ${locks ? html`<span title=${(rv.locksAdded || []).join(', ')}>${plural(locks, 'part')} marked agreed</span>` : null}
              <span class=${d.delivered ? '' : 'tl-waiting'} title=${d.title}>${d.text}</span>
            </div>
          </div>
        </li>`;
      })}
    </ol>
  </div>`;
}

/**
 * A run of one-item reviews as one row: "5 comments sent · 03:17–03:19" and whether the agent has them; expanded,
 * one line per review: its thread (a click shows it), comment or reply, when, and whether the agent has it.
 * @param {{ reviews: any[], agent: string, open: boolean, onToggle: () => void }} props reviews newest first
 */
function ReviewRun({ reviews, agent, open, onToggle }) {
  const first = reviews[reviews.length - 1];
  const last = reviews[0];
  const got = reviews.filter((rv) => Object.keys(rv.deliveredTo || {}).length).length;
  const status = got === reviews.length ? delivery(last, agent).text
    : got === 0 ? `Waiting for ${agent}` : `${agent} has ${got} · ${reviews.length - got} waiting`;
  const versions = [...new Set(reviews.map((rv) => rv.version))].sort((a, b) => a - b);
  const from = formatClock(first.submittedAt);
  const to = formatClock(last.submittedAt);
  const ids = reviews.map((rv) => rv.id);
  return html`<li class="tl-item tl-review tl-group" data-review=${ids.join(' ')}>
    <div class="tl-marker" aria-hidden="true"></div>
    <div class="tl-body">
      <div class="tl-head" title=${[...ids].reverse().join(', ')}>
        <strong class="tl-what">${itemsSent(reviews)} sent</strong>
        <${Chip} tone="muted">Feedback<//>
        <span class="small muted">on ${versions.map((v) => `v${v}`).join(', ')}</span>
        <time class="small muted" datetime=${first.submittedAt} title=${`${first.submittedAt} – ${last.submittedAt}`}>${relTime(last.submittedAt)} ${from === to ? from : `${from}–${to}`}</time>
      </div>
      <div class="tl-meta small muted">
        <span class=${got === reviews.length ? '' : 'tl-waiting'}>${status}</span>
        <button type="button" class="link-btn tl-expand" aria-expanded=${open ? 'true' : 'false'} onClick=${onToggle}>${open ? 'Hide each' : 'Show each'}</button>
      </div>
      ${open ? html`<ul class="tl-run">${reviews.map((rv) => {
        const d = delivery(rv, agent);
        const tid = (rv.newThreads || [])[0] || (rv.replies || [])[0]?.thread || null;
        return html`<li key=${rv.id} title=${rv.id} data-review=${rv.id}>
          ${tid ? html`<button type="button" class="chip tone-accent chip-btn" title=${`Show ${tid} on v${rv.version}`}
            onClick=${() => { viewVersion(rv.version); focusItem(tid); }}>${tid}</button>` : null}
          <span>${(rv.newThreads || []).length ? 'comment' : 'reply'}</span>
          <time class="muted" datetime=${rv.submittedAt}>${formatClock(rv.submittedAt)}</time>
          <span class=${d.delivered ? 'muted' : 'tl-waiting'}>${d.text}</span>
        </li>`;
      })}</ul>` : null}
    </div>
  </li>`;
}
