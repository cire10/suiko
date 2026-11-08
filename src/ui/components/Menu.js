// @ts-check
// Menus and popovers: ONE accessible primitive for the header's More menu (⋯), the turn pill and the problems chip,
// and the outline's section menus. A button (aria-haspopup, aria-expanded, aria-controls) opens a floating panel
// placed under it with position: fixed, so a header with overflow: hidden or a scrolling rail never clips it (it
// flips above the button when there is no room below, and stays inside the window).
// The open state is the component's own, not the global dialog slot (state.js): a menu never closes the Submit
// dialog, the palette or a composer, and opening one of those does not depend on it.
// - kind 'menu': role=menu with role=menuitem items (MenuItem). Enter / Space / ArrowDown on the button open it with
//   the first item focused (ArrowUp: the last); a mouse click opens it with the menu itself focused, so nothing looks
//   chosen until the pointer or an arrow key moves. Up / Down move (wrapping), Home / End jump, a letter moves to the
//   next item starting with it, Enter / Space run the focused item. Hovering an item focuses it, so the pointer and
//   the keys share one highlight. A disabled item stays focusable (aria-disabled) and does nothing. Running an item
//   closes the menu and gives the focus back to the button BEFORE the item's action runs, so a dialog the action
//   opens returns the focus to the button when it closes; a `keepOpen` item (the theme cycle) leaves it open.
// - kind 'dialog': a non-modal popover (role=dialog) of text and buttons. The panel takes the focus; Tab walks its
//   buttons and Tab past either end closes it.
// Both close on Esc (focus back on the button), on Tab out of the menu (focus to the next control), on a click
// outside (an invisible backdrop takes it, also over the doc iframe, whose own clicks never reach this document; that
// click only closes), when the focus leaves them (another window), and on a window resize or a scroll outside them.
// Key presses inside never reach the global key handler (keys.js): only the app-level Cmd/Ctrl combos (palette,
// Settings, keyboard shortcuts) pass through, and close the menu first.

import { createContext, html, useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact-htm';
import { appCombo } from '../model.js';
import { Icon } from './common.js';

/** What MenuItem needs from the menu it is in. */
const PopoverContext = createContext(/** @type {{ close: (refocus?: boolean) => void }|null} */ (null));

let seq = 0;
const ITEMS = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';
const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** Space between the button and the panel, and the panel and the window edges (px). */
const GAP = 6;
const MARGIN = 8;

/**
 * Places the panel under (or, without room, above) its button, aligned to the button's start or end edge and kept
 * inside the window.
 * @param {HTMLElement} panel @param {HTMLElement} button @param {'start'|'end'} align
 */
function place(panel, button, align) {
  const r = button.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  panel.style.maxWidth = `${Math.max(160, vw - 2 * MARGIN)}px`;
  panel.style.maxHeight = `${Math.max(120, vh - 2 * MARGIN)}px`;
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  const left = Math.max(MARGIN, Math.min(align === 'end' ? r.right - w : r.left, vw - MARGIN - w));
  let top = r.bottom + GAP;
  if (top + h > vh - MARGIN && r.top - GAP - h >= MARGIN) top = r.top - GAP - h;
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(Math.max(MARGIN, top))}px`;
}

/** @param {Element|null} el */
const focusEl = (el) => /** @type {HTMLElement|null} */ (el)?.focus({ preventScroll: true });

/**
 * A button and the menu / popover it opens.
 * @param {{
 *   label: string,
 *   kind?: 'menu'|'dialog',
 *   align?: 'start'|'end',
 *   trigger: any,
 *   triggerClass?: string,
 *   triggerProps?: Record<string, any>,
 *   panelClass?: string,
 *   children: any,
 * }} props label: the panel's accessible name; trigger: the button's content; triggerProps: its other attributes
 *   (data-testid, aria-label, title, ...); children: the panel's content, or a function of `close`
 */
export function Popover({ label, kind = 'menu', align = 'end', trigger, triggerClass = '', triggerProps = {}, panelClass = '', children }) {
  const [open, setOpen] = useState(false);
  const [id] = useState(() => `sr-pop-${++seq}`);
  const button = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const panel = useRef(/** @type {HTMLDivElement|null} */ (null));
  /** Where the focus goes when the panel opens. */
  const focusOnOpen = useRef(/** @type {'first'|'last'|'panel'} */ ('panel'));

  /** @param {boolean} [refocus] give the focus back to the button */
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) focusEl(button.current);
  };

  // Placement after every render while open (a label that changes width keeps the panel aligned), and the focus once
  // when it opens.
  useLayoutEffect(() => {
    if (open && panel.current && button.current) place(panel.current, button.current, align);
  });
  useLayoutEffect(() => {
    const p = panel.current;
    if (!open || !p) return;
    const items = kind === 'menu' ? [...p.querySelectorAll(ITEMS)] : [];
    const target = focusOnOpen.current === 'first' ? items[0] : focusOnOpen.current === 'last' ? items[items.length - 1] : null;
    focusEl(target || p);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    /** @param {Event} e */
    const onScroll = (e) => {
      if (!(e.target instanceof Node) || !panel.current?.contains(e.target)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  /** @param {MouseEvent} e */
  const onButtonClick = (e) => {
    if (open) {
      close(true);
      return;
    }
    // A click from the keyboard (Enter / Space) has detail 0: the first item then takes the focus.
    focusOnOpen.current = kind === 'menu' && e.detail === 0 ? 'first' : 'panel';
    setOpen(true);
  };

  /** @param {KeyboardEvent} e */
  const onButtonKey = (e) => {
    if (kind !== 'menu' || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.altKey || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    focusOnOpen.current = e.key === 'ArrowUp' ? 'last' : 'first';
    if (!open) {
      setOpen(true);
      return;
    }
    const items = [...(panel.current?.querySelectorAll(ITEMS) || [])];
    focusEl(e.key === 'ArrowUp' ? items[items.length - 1] : items[0]);
  };

  /**
   * Tab out of the panel: closes it and moves on from the button (Shift+Tab: to the button itself).
   * @param {boolean} back
   */
  const tabOut = (back) => {
    const b = button.current;
    setOpen(false);
    if (!b) return;
    if (back) {
      focusEl(b);
      return;
    }
    const all = /** @type {HTMLElement[]} */ ([...document.querySelectorAll(FOCUSABLE)])
      .filter((el) => !panel.current?.contains(el) && el.getClientRects().length > 0);
    focusEl(all[all.indexOf(b) + 1] || b);
  };

  /** @param {KeyboardEvent} e */
  const onPanelKey = (e) => {
    if (appCombo({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey })) {
      // the palette / Settings / shortcuts: handled by keys.js, which opens the dialog
      setOpen(false);
      return;
    }
    e.stopPropagation();
    const p = panel.current;
    if (!p) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key === 'Tab') {
      if (kind === 'menu') {
        e.preventDefault();
        tabOut(e.shiftKey);
        return;
      }
      const stops = /** @type {HTMLElement[]} */ ([...p.querySelectorAll(FOCUSABLE)]).filter((el) => el.getClientRects().length > 0);
      const active = document.activeElement;
      if (!stops.length || (e.shiftKey && (active === p || active === stops[0])) || (!e.shiftKey && active === stops[stops.length - 1])) {
        e.preventDefault();
        tabOut(e.shiftKey);
      } else if (!e.shiftKey && active === p) {
        e.preventDefault();
        focusEl(stops[0]);
      }
      return;
    }
    if (kind !== 'menu') return;
    const items = /** @type {HTMLElement[]} */ ([...p.querySelectorAll(ITEMS)]);
    if (!items.length) return;
    const i = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    /** @type {HTMLElement|undefined} */
    let next;
    if (e.key === 'ArrowDown') next = items[(i + 1) % items.length];
    else if (e.key === 'ArrowUp') next = items[(i - 1 + items.length) % items.length];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // type-ahead: the next item whose label starts with the letter
      const ch = e.key.toLowerCase();
      const order = [...items.slice(i + 1), ...items.slice(0, i + 1)];
      next = order.find((el) => (el.dataset.label || el.textContent || '').trim().toLowerCase().startsWith(ch));
    }
    if (next) {
      e.preventDefault();
      focusEl(next);
    }
  };

  /** @param {FocusEvent} e */
  const onFocusOut = (e) => {
    const to = /** @type {Node|null} */ (e.relatedTarget);
    if (to && (panel.current?.contains(to) || button.current === to)) return;
    // Focus left for something else: another control, the doc iframe (no relatedTarget), another window.
    setOpen(false);
  };

  const api = { close };
  return html`<button type="button" ref=${button} class=${triggerClass} aria-haspopup=${kind === 'menu' ? 'menu' : 'dialog'}
      aria-expanded=${open ? 'true' : 'false'} aria-controls=${open ? id : undefined} onClick=${onButtonClick} onKeyDown=${onButtonKey}
      ...${triggerProps}>${trigger}</button>
    ${open ? html`<${PopoverContext.Provider} value=${api}>
      <div class="popover-backdrop" aria-hidden="true" onPointerDown=${() => setOpen(false)}></div>
      <div ref=${panel} id=${id} class=${`popover ${kind === 'menu' ? 'menu-panel' : 'popover-panel'} ${panelClass}`.trim()}
        role=${kind} aria-label=${label} aria-orientation=${kind === 'menu' ? 'vertical' : undefined} tabindex="-1"
        onKeyDown=${onPanelKey} onFocusOut=${onFocusOut}>
        ${typeof children === 'function' ? children(close) : children}
      </div>
    <//>` : null}`;
}

/** The close function of the menu / popover a component is rendered in (null outside one). */
export function usePopover() {
  return useContext(PopoverContext);
}

/**
 * One item of a menu: an icon (or the room for one), the label, and its shortcut at the right.
 * @param {{ label: any, icon?: string, keys?: string, hint?: string, onSelect?: () => void, disabled?: boolean,
 *   keepOpen?: boolean, class?: string, [attr: string]: any }} props keys: the shortcut as shown (shortcut());
 *   hint: why it is disabled, or what it does (the tooltip); other props become attributes (data-*, aria-label, ...)
 */
export function MenuItem({ label, icon, keys, hint, onSelect, disabled = false, keepOpen = false, class: cls = '', ...rest }) {
  const menu = useContext(PopoverContext);
  const run = () => {
    if (disabled) return;
    if (!keepOpen) menu?.close(true);
    onSelect?.();
  };
  return html`<button type="button" role="menuitem" tabindex="-1" class=${`menu-item ${cls}`.trim()}
    aria-disabled=${disabled ? 'true' : undefined} title=${hint} data-label=${typeof label === 'string' ? label : undefined}
    onClick=${run}
    onPointerMove=${(/** @type {PointerEvent} */ e) => {
      if (document.activeElement !== e.currentTarget) focusEl(/** @type {Element} */ (e.currentTarget));
    }}
    ...${rest}>
    <span class="menu-icon" aria-hidden="true">${icon ? html`<${Icon} name=${icon} />` : null}</span>
    <span class="menu-label">${label}</span>
    ${keys ? html`<kbd class="menu-key" aria-hidden="true">${keys}</kbd>` : null}
  </button>`;
}

/** A hairline between groups of items. */
export function MenuSeparator() {
  return html`<div role="separator" class="menu-sep"></div>`;
}
