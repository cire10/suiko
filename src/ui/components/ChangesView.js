// @ts-check
// Changes mode side panel (design 8.6 / 11.3): what changed from the base to the shown version.
// - The change list, grouped by section, with "seen" checkboxes (kept in localStorage per comparison, through
//   actions.js, so the command palette's "Mark all changes seen" ticks them too) and a progress count. Clicking an item (or n / p) scrolls the doc to the hunk. Each item shows the hunk as an inline
//   word diff of its source lines (from GET .../diff/source; old words struck, new words marked, unchanged words
//   as context, long unchanged runs shortened), capped at 6 lines with "Show more". Group titles drop the doc's
//   only H1 (the spec title would otherwise prefix every section).
// - Linked threads and `other` explanations per hunk, plus guard badges of the version.
// - Changed assets (images) as a before / after pair.
// - "Round results": the agent's replies in this range, with Accept / Reopen.

import { html, useEffect, useMemo, useRef, useState } from 'preact-htm';
import { TESTID } from 'protocol';
import { docApi } from '../api.js';
import { focusItem, goToHunk, navChange, readSeen, resolveThread, seenStorageKey, setChangesSeen, startReply } from '../actions.js';
import { Markdown } from '../markdown.js';
import {
  agentName, coalesceWordParts, diffLines, guardBadges, groupHunks, hunkLines, hunkPreview, hunkSourceText, isVerifiable, numericVersion,
  roundResults, singleH1, statusInfo, targetLabel, anchorAt, trimDiffContext, versionMeta,
} from '../model.js';
import { store, useStore } from '../state.js';
import { contentUrl, scrollIntoViewSoft, wordParts } from '../util.js';
import { Chip } from './common.js';

/** Hunks longer than this many display lines are collapsed behind "Show more". */
const HUNK_LINES = 6;
/** ...and so are hunks with more characters than this (one long Markdown paragraph is a single source line). */
const HUNK_CHARS = 480;

/**
 * The source diff of the comparison shown (one request per base / version / head), for the hunks' word diffs.
 * Null while loading or when it cannot be loaded (the items then show the rendered-text preview).
 * @param {any} route
 * @param {number|null} base
 * @param {number|'live'|null} version
 * @param {any} changes waited for, and followed for the live working copy (it changes under the same pair)
 */
function useSourceDiff(route, base, version, changes) {
  const [state, setState] = useState(/** @type {{ key: string, data: any }} */ ({ key: '', data: null }));
  const key = `${route.ws}/${route.doc}|${base}|${version}`;
  useEffect(() => {
    if (base == null || version == null || !changes) return undefined;
    let alive = true;
    docApi(route.ws, route.doc).sourceDiff(base, version)
      .then((data) => { if (alive) setState({ key, data }); })
      .catch(() => { if (alive) setState({ key, data: null }); });
    return () => {
      alive = false;
    };
  }, [key, version === 'live' ? changes : !!changes]);
  return state.key === key ? state.data : null;
}

/**
 * One change: op badge, id and lines, then the hunk as an inline word diff of its source lines (or the rendered
 * preview until the source diff is there).
 * @param {{ h: any, active: boolean, text: { old: string, new: string }|null }} props
 */
function HunkBody({ h, active, text }) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => (text ? diffLines(trimDiffContext(coalesceWordParts(wordParts(text.old, text.new)))) : null), [text?.old, text?.new]);
  const p = lines ? null : hunkPreview(h);
  const chars = lines ? lines.reduce((n, l) => n + l.reduce((m, part) => m + part.text.length, 0), 0) : 0;
  const long = !!lines && (lines.length > HUNK_LINES || chars > HUNK_CHARS);
  const shown = lines && long && !expanded ? lines.slice(0, HUNK_LINES) : lines;
  return html`<button type="button" class="change-main" aria-current=${active ? 'true' : undefined} onClick=${() => goToHunk(h.id)}>
      <span class="change-top">
        <span class=${`op-badge op-${h.op}`}>${h.op === 'add' ? '+ added' : h.op === 'del' ? '− removed' : '~ changed'}</span>
        <span class="small muted">${h.id} · ${hunkLines(h)}</span>
      </span>
      ${shown ? html`<span class=${`hunk-diff ${long && !expanded ? 'is-capped' : ''}`} data-hunk-diff>${shown.map((line) => html`<span class="hd-line">${line.length
        ? line.map((part) => (part.op === 'ins' ? html`<ins>${part.text}</ins>`
          : part.op === 'del' ? html`<del>${part.text}</del>`
            : part.op === 'gap' ? html`<span class="hd-gap" aria-label="unchanged text omitted">${part.text}</span>` : part.text))
        : '\u00a0'}</span>`)}</span>` : null}
      ${p?.del ? html`<span class="change-del">${p.del}</span>` : null}
      ${p?.ins ? html`<span class="change-ins">${p.ins}</span>` : null}
    </button>
    ${long ? html`<button type="button" class="link-btn hunk-more" aria-expanded=${expanded} onClick=${() => setExpanded(!expanded)}>
      ${expanded ? 'Show less' : lines && lines.length > HUNK_LINES ? `Show ${lines.length - HUNK_LINES} more line${lines.length - HUNK_LINES === 1 ? '' : 's'}` : 'Show more'}</button>` : null}`;
}

export function ChangesView() {
  const s = useStore((st) => ({
    ds: st.ds,
    changes: st.changes,
    error: st.changesError,
    base: st.base,
    version: st.version,
    activeHunk: st.activeHunk,
    route: st.route,
    outline: st.guest.outline.length ? st.guest.outline : st.targets?.outline,
    seenKey: seenStorageKey(st),
    seenRev: st.seenRev,
  }));
  const r = /** @type {any} */ (s.route);
  const seen = useMemo(() => readSeen(s.seenKey), [s.seenKey, s.seenRev]);
  const h1 = singleH1(s.outline);
  const groups = useMemo(() => groupHunks(s.changes, { h1 }), [s.changes, h1]);
  const sourceDiff = useSourceDiff(r, s.base, s.version, s.changes);
  const listRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  useEffect(() => {
    if (!s.activeHunk || !listRef.current) return;
    scrollIntoViewSoft(listRef.current.querySelector(`[data-hunk-id="${CSS.escape(s.activeHunk)}"]`));
  }, [s.activeHunk]);

  if (!s.ds) return null;
  const ds = s.ds;
  const v = numericVersion(ds, s.version);
  if (s.base == null) {
    return html`<section class="changes-view" aria-label="Changes"><div class="empty">
      <p><strong>This is the first version.</strong></p>
      <p>After the agent revises, you'll see exactly what changed.</p>
    </div></section>`;
  }
  const hunks = s.changes?.hunks || [];
  const total = hunks.length;
  const done = hunks.filter((/** @type {any} */ h) => seen.has(h.id)).length;
  const meta = s.version === 'live' ? null : versionMeta(ds, v);
  const badges = guardBadges(meta);
  const results = roundResults(ds, s.base, v);
  const agent = agentName(ds);
  const last = Number(ds.doc.lastReviewedVersion);

  /** @param {string} id @param {boolean} on */
  const toggleSeen = (id, on) => setChangesSeen([id], on);

  return html`<section class="changes-view" aria-label="Changes">
    <div class="changes-head">
      <div class="changes-title">
        <strong>v${s.base} → ${s.version === 'live' ? 'working copy' : `v${v}`}</strong>
        ${s.base === last ? html`<span class="small muted">since your last review</span>` : null}
      </div>
      ${s.changes ? html`<div class="changes-stats small">
        <span class="ins-text">+${s.changes.stats?.added ?? 0}</span> <span class="del-text">−${s.changes.stats?.removed ?? 0}</span>
        <span class="muted">· ${total} change${total === 1 ? '' : 's'}</span>
        <span class="progress" aria-label=${`${done} of ${total} reviewed`}>${done}/${total} reviewed</span>
      </div>` : null}
      ${badges.length ? html`<div class="guard-badges">${badges.map((b) => html`<${Chip} tone=${b.tone} key=${b.key}>${b.label}<//>`)}</div>` : null}
      ${meta?.summary ? html`<p class="small version-summary">${meta.summary}</p>` : null}
      <div class="row">
        <button type="button" class="btn btn-sm" onClick=${() => navChange(-1)} disabled=${!total} title="Previous change (p)">Prev</button>
        <button type="button" class="btn btn-sm" onClick=${() => navChange(1)} disabled=${!total} title="Next change (n)">Next</button>
      </div>
    </div>
    ${s.error ? html`<p class="error small" role="alert">Cannot load the changes: ${s.error}</p>` : null}
    ${!s.changes && !s.error ? html`<p class="small muted">Loading changes…</p>` : null}
    ${s.changes && total === 0 && !(s.changes.assets || []).length ? html`<div class="empty"><p>No changes between v${s.base} and ${s.version === 'live' ? 'the working copy' : `v${v}`}.</p></div>` : null}
    <div class="change-groups" ref=${listRef}>
      ${groups.map((g) => html`<section class="change-group" key=${g.key}>
        <h3 class="group-title">${g.title}</h3>
        <ul class="change-list">
          ${g.hunks.map((/** @type {any} */ h) => {
            const active = s.activeHunk === h.id;
            return html`<li data-testid=${TESTID.changeItem} data-hunk-id=${h.id} class=${`change-item op-${h.op} ${active ? 'active' : ''} ${seen.has(h.id) ? 'seen' : ''}`}
              key=${h.id}>
              <input type="checkbox" class="seen-box" checked=${seen.has(h.id)} aria-label=${`Mark ${h.id} as seen`}
                onChange=${(/** @type {any} */ e) => toggleSeen(h.id, e.currentTarget.checked)} />
              <${HunkBody} h=${h} active=${active} text=${sourceDiff ? hunkSourceText(sourceDiff, h.id) : null} />
              <span class="change-links">
                ${(h.threads || []).map((/** @type {string} */ t) => html`<button type="button" class="chip tone-accent chip-btn" key=${t}
                  onClick=${() => { store.set({ sidePane: 'threads' }); focusItem(t); }}>${t}</button>`)}
                ${h.other ? html`<${Chip} tone="attn" title=${h.other}>other: ${h.other}<//>` : null}
                ${!(h.threads || []).length && !h.other && h.linkedBy === null ? html`<${Chip} tone="muted" title="Not linked to a thread">unlinked<//>` : null}
              </span>
            </li>`;
          })}
        </ul>
      </section>`)}
    </div>
    ${(s.changes?.assets || []).length ? html`<section class="change-group" aria-label="Changed assets">
      <h3 class="group-title">Changed assets</h3>
      ${s.changes.assets.map((/** @type {any} */ a) => {
        const before = contentUrl(ds.contentBase, a.fromUrl);
        const after = contentUrl(ds.contentBase, a.toUrl);
        return html`<div class="asset-change" data-asset=${a.path} key=${a.path}>
          <p class="small mono">${a.path}
            ${(a.threads || []).map((/** @type {string} */ t) => html` <button type="button" class="chip tone-accent chip-btn" key=${t}
              onClick=${() => { store.set({ sidePane: 'threads' }); focusItem(t); }}>${t}</button>`)}</p>
          <div class="img-pair">
            <figure>${before ? html`<img src=${before} alt=${`Before: ${a.path}`} loading="lazy" referrerpolicy="no-referrer" />` : html`<span class="muted small">(none)</span>`}<figcaption>Before (v${s.base})</figcaption></figure>
            <figure>${after ? html`<img src=${after} alt=${`After: ${a.path}`} loading="lazy" referrerpolicy="no-referrer" />` : html`<span class="muted small">(removed)</span>`}<figcaption>After (${s.version === 'live' ? 'working copy' : `v${v}`})</figcaption></figure>
          </div>
        </div>`;
      })}
    </section>` : null}
    ${results.length ? html`<section class="round-results" aria-label="Round results">
      <h3 class="group-title">Round results</h3>
      ${results.map(({ thread: t, comment: c }) => {
        const st = statusInfo(t, agent);
        const verifiable = isVerifiable(t, ds.drafts);
        return html`<div class="result" key=${t.id} data-thread-id=${t.id}>
          <div class="result-head">
            <button type="button" class="link-btn tid" onClick=${() => { store.set({ sidePane: 'threads' }); focusItem(t.id); }}>${t.id}</button>
            <${Chip} tone=${st.tone}>${st.label}<//>
            <span class="small muted">${targetLabel(anchorAt(t, s.version))}</span>
          </div>
          <${Markdown} text=${c.body} class="comment-body" />
          ${verifiable ? html`<div class="card-actions">
            <button type="button" class="btn btn-sm btn-ok" data-testid=${TESTID.verifyAccept} onClick=${() => resolveThread(t.id)}>Accept</button>
            <button type="button" class="btn btn-sm" data-testid=${TESTID.verifyReopen} onClick=${() => { store.set({ sidePane: 'threads' }); startReply(t.id, { reopen: true }); }}>Reopen</button>
          </div>` : t.status === 'needs_input' && s.version !== 'live' ? html`<div class="card-actions">
            <button type="button" class="btn btn-sm btn-primary" onClick=${() => { store.set({ sidePane: 'threads' }); startReply(t.id); }}>Answer ${agent}</button>
          </div>` : null}
        </div>`;
      })}
    </section>` : null}
  </section>`;
}
