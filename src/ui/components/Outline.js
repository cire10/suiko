// @ts-check
// Left rail: the outline (from the guest's `ready`, else from the targets endpoint) with badges for open threads,
// changed (~) / added (+) sections and locks (none in Read mode), plus a section menu (Comment on section, Mark
// agreed, Unlock), then a compact version history.

import { html, useMemo, useState } from 'preact-htm';
import { openComposer, scrollToSrid, setMode, switchVersion, unlock } from '../actions.js';
import { actorLabel, anchorAt, headingBadges, normWs, relTime, sectionTail, showsDoc, versionNumbers } from '../model.js';
import { useStore } from '../state.js';

export function Outline() {
  const s = useStore((st) => ({
    ds: st.ds,
    guestOutline: st.guest.outline,
    targetOutline: st.targets?.outline,
    changes: st.changes,
    version: st.version,
    mode: st.mode,
  }));
  const [menuFor, setMenuFor] = useState(/** @type {number|null} */ (null));
  const outline = s.guestOutline?.length ? s.guestOutline : (s.targetOutline || []);
  const badges = useMemo(() => headingBadges(outline, s.ds, s.changes, s.version), [outline, s.ds, s.changes, s.version]);
  const minLevel = outline.reduce((m, h) => Math.min(m, Number(h.level) || 1), 6);
  const canComment = s.version !== 'live';
  // Read mode: a plain table of contents, without thread, change or lock badges
  const reading = s.mode === 'read';

  /** @param {any} h */
  const lockOf = (h) => (s.ds?.locks || []).find((/** @type {any} */ l) => l.active !== false
    && normWs(sectionTail(anchorAt(l, s.version)?.section)) === normWs(h.text));

  return html`<div class="rail-inner">
    <section class="outline" aria-label="Outline">
      <h2 class="rail-title">Outline</h2>
      ${outline.length === 0 ? html`<p class="muted small">No headings.</p>` : html`<ul class="outline-list">
        ${outline.map((h) => {
          const b = badges.get(h.srid);
          const lock = lockOf(h);
          return html`<li class="outline-item" style=${{ '--depth': Math.max(0, (Number(h.level) || 1) - minLevel) }} key=${h.srid}>
            <button type="button" class="outline-link" onClick=${() => { if (!showsDoc(s.mode)) setMode('review'); scrollToSrid(h.srid); }}
              title=${h.text}>
              <span class="outline-text">${h.text}</span>
              ${reading ? null : html`
                ${b?.added ? html`<span class="badge tone-ok" title="Added in this comparison">+</span>` : null}
                ${b?.changed ? html`<span class="badge tone-warn" title="Changed in this comparison">~</span>` : null}
                ${b?.open ? html`<span class="badge tone-accent" title=${`${b.open} open thread(s)`}>${b.open}</span>` : null}
                ${b?.locked || lock ? html`<span class="badge tone-lock" title="Agreed (locked)">L</span>` : null}`}
            </button>
            ${canComment ? html`<button type="button" class="icon-btn icon-btn-xs outline-more" aria-haspopup="menu"
              aria-expanded=${menuFor === h.srid} aria-label=${`Actions for section ${h.text}`}
              onClick=${() => setMenuFor(menuFor === h.srid ? null : h.srid)}>⋯</button>` : null}
            ${menuFor === h.srid ? html`<div class="menu" role="menu" onKeyDown=${(/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') { e.stopPropagation(); setMenuFor(null); } }}>
              <button type="button" role="menuitem" onClick=${() => { setMenuFor(null); openComposer({ capture: { kind: 'section', headingSrid: h.srid } }); }}>Comment on section</button>
              ${lock
                ? html`<button type="button" role="menuitem" onClick=${() => { setMenuFor(null); unlock(lock.id); }}>Unlock (${lock.id})</button>`
                : html`<button type="button" role="menuitem" onClick=${() => { setMenuFor(null); openComposer({ capture: { kind: 'section', headingSrid: h.srid }, action: 'agree' }); }}>Mark agreed</button>`}
            </div>` : null}
          </li>`;
        })}
      </ul>`}
    </section>
    <${MiniHistory} ds=${s.ds} version=${s.version} />
  </div>`;
}

/** @param {{ ds: any, version: number|'live'|null }} props */
function MiniHistory({ ds, version }) {
  if (!ds) return null;
  const vs = versionNumbers(ds).slice().reverse().slice(0, 12);
  return html`<section class="mini-history" aria-label="Versions">
    <h2 class="rail-title">History</h2>
    <ul>
      ${vs.map((v) => {
        const meta = (ds.versions || []).find((/** @type {any} */ x) => Number(x.v) === v);
        const current = version === v;
        return html`<li key=${v}>
          <button type="button" class=${`mini-version ${current ? 'active' : ''}`} aria-current=${current ? 'true' : undefined}
            onClick=${() => switchVersion(v)} title=${meta?.summary || ''}>
            <strong>v${v}</strong>
            <span class="mini-author">${actorLabel(meta?.author)}</span>
            ${ds.doc.final?.version === v ? html`<span class="badge tone-ok">FINAL</span>` : null}
            <span class="mini-time">${relTime(meta?.createdAt)}</span>
          </button>
        </li>`;
      })}
    </ul>
    <button type="button" class="link-btn" onClick=${() => setMode('history')}>Full history</button>
  </section>`;
}
