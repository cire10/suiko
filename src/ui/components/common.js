// @ts-check
// Small shared building blocks: inline SVG icons (no icon font, no external requests), chips, a word-diff view and
// an accessible modal (focus moved in on open, Tab kept inside, focus restored on close, Esc / backdrop close).

import { html, useEffect, useRef } from 'preact-htm';
import { wordParts } from '../util.js';

const ICONS = /** @type {Record<string, string>} */ ({
  menu: 'M3 6h18M3 12h18M3 18h18',
  close: 'M6 6l12 12M18 6L6 18',
  pick: 'M12 2v4M12 18v4M2 12h4M18 12h4M12 8a4 4 0 100 8 4 4 0 000-8z',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10.6 10.6 0 0112 5c6.5 0 10 7 10 7a17.6 17.6 0 01-3.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.8 9.8 0 005.4-1.6M9.9 9.9a3 3 0 004.2 4.2',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6L4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 7a5 5 0 100 10 5 5 0 000-10z',
  moon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z',
  system: 'M3 5h18v11H3zM8 20h8M12 16v4',
  help: 'M12 22a10 10 0 100-20 10 10 0 000 20zM9.1 9a3 3 0 015.8 1c0 2-3 3-3 3M12 17h.01',
  threads: 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 018 0v4',
  check: 'M5 12l5 5L20 7',
  chevron: 'M9 6l6 6-6 6',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15 9h.01',
  comment: 'M4 5h16v11H8l-4 4z',
  external: 'M14 4h6v6M20 4L10 14M18 14v6H4V6h6',
  scissors: 'M9 6a3 3 0 11-6 0 3 3 0 016 0zM9 18a3 3 0 11-6 0 3 3 0 016 0zM20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12',
  screen: 'M3 4h18v12H3zM8 20h8M12 16v4M7 8V7h2M17 8V7h-2M7 12v1h2M17 12v1h-2',
});

/**
 * @param {{ name: string, size?: number, label?: string }} props
 */
export function Icon({ name, size = 16, label }) {
  const d = ICONS[name] || ICONS.comment;
  return html`<svg class="icon" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden=${label ? undefined : 'true'}
    role=${label ? 'img' : undefined} aria-label=${label}><path d=${d} /></svg>`;
}

/**
 * A status / type chip. Tone picks the colour, and the text always carries the meaning (never colour alone).
 * @param {{ tone?: string, children?: any, title?: string, class?: string }} props
 */
export function Chip({ tone = 'muted', children, title, class: cls = '' }) {
  return html`<span class=${`chip tone-${tone} ${cls}`.trim()} title=${title}>${children}</span>`;
}

/**
 * Inline word diff (old struck through, new underlined).
 * @param {{ before?: string, after?: string, parts?: Array<{ op: string, text: string }>, class?: string }} props
 */
export function WordDiff({ before = '', after = '', parts, class: cls = '' }) {
  const list = parts || wordParts(before, after);
  return html`<div class=${`worddiff ${cls}`.trim()}>${list.map((p) => (p.op === 'ins'
    ? html`<ins>${p.text}</ins>`
    : p.op === 'del' ? html`<del>${p.text}</del>` : html`<span>${p.text}</span>`))}</div>`;
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog.
 * @param {{ title: string, onClose: () => void, testid?: string, wide?: boolean, children?: any, initialFocus?: string,
 *   class?: string }} props
 */
export function Modal({ title, onClose, testid, wide = false, children, initialFocus, class: cls = '' }) {
  const ref = useRef(/** @type {HTMLDivElement|null} */ (null));
  useEffect(() => {
    const prev = /** @type {HTMLElement|null} */ (document.activeElement);
    const root = ref.current;
    const first = root && /** @type {HTMLElement|null} */ (
      (initialFocus && root.querySelector(initialFocus)) || root.querySelector(FOCUSABLE));
    first?.focus();
    return () => {
      if (prev && document.contains(prev)) prev.focus();
    };
  }, []);
  /** @param {KeyboardEvent} ev */
  const onKeyDown = (ev) => {
    if (ev.key !== 'Tab' || !ref.current) return;
    const items = /** @type {HTMLElement[]} */ ([...ref.current.querySelectorAll(FOCUSABLE)]).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  };
  return html`<div class="modal-backdrop" onMouseDown=${(/** @type {MouseEvent} */ e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref=${ref} class=${`modal ${wide ? 'modal-wide' : ''} ${cls}`.trim()} role="dialog" aria-modal="true" aria-label=${title}
      data-testid=${testid} onKeyDown=${onKeyDown}>
      <header class="modal-head">
        <h2>${title}</h2>
        <button type="button" class="icon-btn" aria-label="Close" onClick=${onClose}><${Icon} name="close" /></button>
      </header>
      <div class="modal-body">${children}</div>
    </div>
  </div>`;
}

/** @param {{ label?: string }} props */
export function Spinner({ label = 'Loading' }) {
  return html`<span class="spinner" role="status" aria-label=${label}></span>`;
}
