// @ts-check
// Left rail: the outline (from the guest's `ready`, else from the targets endpoint) with badges for open threads,
// changed (~) / added (+) sections and locks (none in Read mode), and a section menu per heading (Menu.js: Comment on
// section, Mark agreed, Unlock). Versions are not listed here: they are in the version picker and History.

import { html, useMemo } from 'preact-htm';
import { openComposer, scrollToSrid, setMode, unlock } from '../actions.js';
import { anchorAt, headingBadges, normWs, sectionTail, showsDoc } from '../model.js';
import { useStore } from '../state.js';
import { Icon } from './common.js';
import { MenuItem, Popover } from './Menu.js';

export function Outline() {
  const s = useStore((st) => ({
    ds: st.ds,
    guestOutline: st.guest.outline,
    targetOutline: st.targets?.outline,
    changes: st.changes,
    version: st.version,
    mode: st.mode,
  }));
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
          const capture = { kind: 'section', headingSrid: h.srid };
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
            ${canComment ? html`<${Popover} label=${`Section ${h.text}`} kind="menu" align="end"
              triggerClass="icon-btn icon-btn-xs outline-more" triggerProps=${{ 'aria-label': `Actions for section ${h.text}` }}
              trigger=${html`<${Icon} name="more" size=${14} />`}>
              <${MenuItem} icon="comment" label="Comment on section" onSelect=${() => openComposer({ capture })} />
              ${lock
                ? html`<${MenuItem} icon="lock" label=${`Unlock (${lock.id})`} onSelect=${() => unlock(lock.id)} />`
                : html`<${MenuItem} icon="check" label="Mark agreed" onSelect=${() => openComposer({ capture, action: 'agree' })} />`}
            <//>` : null}
          </li>`;
        })}
      </ul>`}
    </section>
  </div>`;
}
