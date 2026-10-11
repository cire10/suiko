// @ts-check
// History mode (design 8.9): a timeline interleaving versions and reviews, newest first. Version rows show the
// author, time, summary, the review they answer, linked threads, +/- stats and guard badges, with View /
// Diff vs previous / Compare with... actions. Review rows show the verdict, summary and delivery.

import { html, useState } from 'preact-htm';
import { TESTID } from 'protocol';
import { compareVersions, focusItem, viewVersion } from '../actions.js';
import { Markdown } from '../markdown.js';
import { actorLabel, formatClock, guardBadges, relTime, threadsOfVersion, timeline, versionNumbers } from '../model.js';
import { useStore } from '../state.js';
import { Chip } from './common.js';

const VERDICT = /** @type {Record<string, [string, string]>} */ ({
  comment: ['Comment', 'info'],
  changes_requested: ['Changes requested', 'warn'],
  approved: ['Approved', 'ok'],
});

export function HistoryView() {
  const ds = useStore((s) => s.ds);
  const version = useStore((s) => s.version);
  const [compareFrom, setCompareFrom] = useState(/** @type {number|null} */ (null));
  if (!ds) return null;
  const items = timeline(ds);
  const all = versionNumbers(ds);
  const head = Number(ds.doc.head);
  const finalV = ds.doc.final?.version;

  return html`<div class="history-view">
    <h2 class="view-title">History <span class="small muted">${all.length} version${all.length === 1 ? '' : 's'}, ${(ds.reviews || []).length} review${(ds.reviews || []).length === 1 ? '' : 's'}</span></h2>
    <ol class="timeline">
      ${items.map((it) => {
        if (it.kind === 'version') {
          const m = it.meta;
          const v = it.v;
          const threads = threadsOfVersion(ds, v);
          const badges = guardBadges(m);
          return html`<li class=${`tl-item tl-version ${version === v ? 'current' : ''}`} data-testid=${TESTID.historyRow} data-version=${String(v)} key=${`v${v}`}>
            <div class="tl-marker" aria-hidden="true"></div>
            <div class="tl-body">
              <div class="tl-head">
                <strong class="tl-id">v${v}</strong>
                ${v === head ? html`<${Chip} tone="accent">latest<//>` : null}
                ${finalV === v ? html`<${Chip} tone="ok">FINAL<//>` : null}
                <span>${actorLabel(m.author)}</span>
                <time class="small muted" datetime=${m.createdAt} title=${m.createdAt}>${relTime(m.createdAt)} ${formatClock(m.createdAt)}</time>
                ${m.respondsTo ? html`<span class="small muted">answers ${m.respondsTo}</span>` : null}
              </div>
              ${m.summary ? html`<p class="tl-summary">${m.summary}</p>` : null}
              <div class="tl-meta">
                ${m.stats ? html`<span class="small"><span class="ins-text">+${m.stats.added ?? 0}</span> <span class="del-text">−${m.stats.removed ?? 0}</span></span>` : null}
                ${threads.map((t) => html`<button type="button" class="chip tone-accent chip-btn" key=${t} onClick=${() => { viewVersion(v); focusItem(t); }}>${t}</button>`)}
                ${badges.map((b) => html`<${Chip} tone=${b.tone} key=${b.key}>${b.label}<//>`)}
              </div>
              <div class="tl-actions">
                <button type="button" class="btn btn-sm" onClick=${() => viewVersion(v)}>View</button>
                <button type="button" class="btn btn-sm" disabled=${v <= all[0]} onClick=${() => compareVersions(all[all.indexOf(v) - 1], v)}>Diff vs previous</button>
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
                </span>` : html`<button type="button" class="btn btn-sm" disabled=${all.length < 2} onClick=${() => setCompareFrom(v)}>Compare with...</button>`}
              </div>
            </div>
          </li>`;
        }
        const rv = it.review;
        const [vLabel, vTone] = VERDICT[rv.verdict] || [rv.verdict, 'muted'];
        const delivered = Object.entries(rv.deliveredTo || {});
        return html`<li class="tl-item tl-review" key=${rv.id}>
          <div class="tl-marker" aria-hidden="true"></div>
          <div class="tl-body">
            <div class="tl-head">
              <strong class="tl-id">${rv.id}</strong>
              <${Chip} tone=${vTone}>${vLabel}<//>
              <span>${actorLabel(rv.by)} on v${rv.version}</span>
              <time class="small muted" datetime=${rv.submittedAt} title=${rv.submittedAt}>${relTime(rv.submittedAt)} ${formatClock(rv.submittedAt)}</time>
            </div>
            ${rv.body ? html`<${Markdown} text=${rv.body} class="tl-summary" />` : null}
            <div class="tl-meta small muted">
              ${(rv.newThreads || []).length ? html`<span>${rv.newThreads.length} new thread${rv.newThreads.length === 1 ? '' : 's'}</span>` : null}
              ${(rv.replies || []).length ? html`<span>${rv.replies.length} repl${rv.replies.length === 1 ? 'y' : 'ies'}</span>` : null}
              ${(rv.locksAdded || []).length ? html`<span>locks ${rv.locksAdded.join(', ')}</span>` : null}
              ${delivered.length ? delivered.map(([agent, at]) => html`<span key=${agent}>delivered to ${agent} ${formatClock(String(at))}</span>`)
                : html`<span>not delivered yet</span>`}
            </div>
          </div>
        </li>`;
      })}
    </ol>
  </div>`;
}
