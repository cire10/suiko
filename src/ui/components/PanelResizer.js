// @ts-check
// The handle on the side panel's left edge (a window splitter): drag it to make the panel wider or narrower, arrow
// keys move it too, a double-click goes back to the layout's width. The width is remembered in this browser
// (setPanelWidth); the doc always keeps its minimum (panelWidthRange here, --doc-min in the CSS when the window shrinks).
// Only the handle re-renders during a drag, since the width is a CSS variable on the root element. Pointer capture
// keeps the drag going over the doc iframe, which would otherwise take the pointer; class is-resizing-panel also
// turns off the iframes' pointer events and text selection until it ends. A drag leaves the focus where it is, so the
// reviewer goes on typing in the comment box they just made room for.

import { html, useLayoutEffect, useRef } from 'preact-htm';
import { setPanelWidth } from '../actions.js';
import { panelWidthRange } from '../model.js';
import { store, useStore } from '../state.js';

const KEY_STEP = 32;
const RESIZING = 'is-resizing-panel';

/** @param {number} n @param {{ min: number, max: number }} range */
const clamp = (n, { min, max }) => Math.round(Math.min(max, Math.max(min, n)));

export function PanelResizer() {
  useStore((s) => s.panelWidth);
  const ref = useRef(/** @type {HTMLDivElement|null} */ (null));
  const drag = useRef(/** @type {{ x: number, width: number, range: { min: number, max: number } }|null} */ (null));

  const panel = () => /** @type {HTMLElement} */ (ref.current?.parentElement);
  const range = () => {
    const main = /** @type {HTMLElement} */ (panel().parentElement);
    return panelWidthRange(main.clientWidth - (/** @type {HTMLElement|null} */ (main.querySelector('.rail-left'))?.offsetWidth ?? 0));
  };

  // What the separator says to assistive technology: the panel's measured width, after any change of the layout
  // (the doc view re-renders this then; a default width is the layout's).
  useLayoutEffect(() => {
    const { min, max } = range();
    ref.current?.setAttribute('aria-valuemin', String(min));
    ref.current?.setAttribute('aria-valuemax', String(max));
    ref.current?.setAttribute('aria-valuenow', String(Math.round(panel().getBoundingClientRect().width)));
  });

  /** @param {PointerEvent} e */
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    /** @type {HTMLElement} */ (e.currentTarget).setPointerCapture(e.pointerId);
    document.documentElement.classList.add(RESIZING);
    drag.current = { x: e.clientX, width: panel().getBoundingClientRect().width, range: range() };
  };
  /** @param {PointerEvent} e */
  const onPointerMove = (e) => {
    const d = drag.current;
    if (d) setPanelWidth(clamp(d.width + d.x - e.clientX, d.range), { save: false });
  };
  const onPointerEnd = () => {
    if (!drag.current) return;
    drag.current = null;
    document.documentElement.classList.remove(RESIZING);
    setPanelWidth(store.get().panelWidth);
  };
  /** @param {KeyboardEvent} e */
  const onKeyDown = (e) => {
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    const step = e.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP;
    setPanelWidth(clamp(panel().getBoundingClientRect().width + step, range()));
  };

  return html`<div ref=${ref} class="panel-resizer" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="sr-side"
    aria-label="Resize the review panel" title="Drag to resize. Double-click for the default width."
    onMouseDown=${(/** @type {MouseEvent} */ e) => e.preventDefault()}
    onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerEnd} onPointerCancel=${onPointerEnd}
    onDblClick=${() => setPanelWidth(null)} onKeyDown=${onKeyDown}></div>`;
}
