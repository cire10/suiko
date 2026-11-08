// Suiko guest, part 40: the overlay.
//
// One <sr-overlay data-sr-ignore> element appended to <html> (the only node the guest ever adds to the author's DOM)
// with a CLOSED shadow root. The host is forced to a full-viewport, pointer-events:none box via inline !important
// declarations set through CSSOM, and the shadow root is styled by an adopted constructed stylesheet, so a document
// CSP without 'unsafe-inline' styles cannot unstyle it. It is placed in the top layer with popover="manual" +
// showPopover() (re-shown after the page opens a modal or popover of its own, or goes fullscreen). While the page
// shows a modal <dialog> the host is moved into that dialog (everything outside it is inert) and back to <html> when
// the dialog closes. Without popover support it falls back to position:fixed + max z-index.
//
// Everything is drawn in viewport coordinates and redrawn on each layout frame. Layers (bottom to top):
//   fallback  highlight rects when CSS.highlights is unavailable
//   marks     element outlines, region boxes, mermaid node boxes, lock brackets
//   changes   change bars, outlines of changed figures, the active change's box, badges, "removed" / "added" tabs
//   pins      numbered thread pins in the right margin
//   ui        pick / snip glass, picker hover box + label chip, drag box, pending snip box, hint chip, cell-scope
//             chooser, selection mini-toolbar, popovers, focus pulse
// Each layer is managed through keyed pools (pool(name).begin()/el(key, cls)/end()) so a redraw reuses nodes.
// Colours speak the UI's language (src/ui/styles/tokens.css), light or dark with the UI's theme: its accent (indigo)
// for the pick box, label chip, snip box, hint, focus and the selected thread's ring; thread marks (pins, outlines,
// boxes, brackets) by whose turn the thread is, like the card chips: st-with (with the agent: the accent), st-check
// (answered or changed, to check: ok green), st-declined (the agent did not change it: warn amber), st-answer (a
// question for the reviewer: attn orange), st-planned (will
// change: violet), st-lost (lost its place: grey), st-done, st-lock (agreed: teal), st-draft (not sent yet: soft
// indigo); changes in the diff colours (add / mod / del).
// Pointer events from interactive children are stopped at the shadow root so they do not reach the page's
// bubbling handlers. scratch(node) parks a helper node (the snip rasteriser's style sandbox iframe) inside the
// shadow root, out of the author's DOM and out of every page MutationObserver.

/**
 * Where the selection mini-toolbar anchors (viewport coordinates): `left` = the selection start, `top` = the top of
 * its first line box, `bottom` = the bottom of its last line box.
 * @typedef {{left: number, top: number, bottom: number}} SelectionAnchor
 */

const Overlay = (() => {
  const SUPPORTS_POPOVER = typeof HTMLElement.prototype.showPopover === 'function';
  const LAYERS = ['fallback', 'marks', 'changes', 'pins', 'ui'];

  /**
   * Inline declarations of the host, all set !important through CSSOM (style.setProperty). Neither the host's
   * style nor the shadow root's stylesheet may use a style attribute or a <style> element: a document with its own
   * Content-Security-Policy (style-src / default-src without 'unsafe-inline') blocks both, and the host would fall
   * back to the UA popover style, an opaque box in the middle of the page that swallows clicks. CSP does not
   * restrict CSSOM, and the shadow root's rules go in a constructed (adopted) stylesheet for the same reason.
   * `all` comes first so the declarations after it win.
   */
  const HOST_DECLS = [
    ['all', 'initial'], ['position', 'fixed'], ['inset', '0'], ['width', 'auto'], ['height', 'auto'],
    ['max-width', 'none'], ['max-height', 'none'], ['margin', '0'], ['padding', '0'], ['border', '0'],
    ['outline', '0'], ['background', 'transparent'], ['overflow', 'hidden'], ['pointer-events', 'none'],
    ['z-index', '2147483647'], ['display', 'block'], ['visibility', 'visible'], ['opacity', '1'],
    ['transform', 'none'], ['filter', 'none'], ['contain', 'strict'], ['user-select', 'none'],
  ];

  const CSS_TEXT = `
:host { all: initial; }
.frame {
  position: absolute; inset: 0; overflow: hidden; pointer-events: none;
  font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, sans-serif; color: var(--fg);
  -webkit-font-smoothing: antialiased;
  --bg: #ffffff; --fg: #18181b; --muted: #5b5b66; --border: rgba(24, 24, 27, 0.14);
  --hover: rgba(24, 24, 27, 0.06); --shadow: 0 0 0 1px rgba(16, 16, 20, 0.05), 0 8px 24px -6px rgba(16, 16, 20, 0.2);
  --accent: #4f46e5; --accent-fg: #ffffff; --pin-fg: #ffffff;
  --st-with: #4f46e5; --st-check: #1a7f37; --st-declined: #9a6700; --st-answer: #bc4c00; --st-planned: #8250df;
  --st-lost: #6b6b75; --st-done: #6b6b75; --st-lock: #1b7c83; --st-draft: #6366f1; --draft-bg: #e0e7ff; --draft-fg: #4338ca;
  --add: #1a7f37; --mod: #bf8700; --del: #d1242f;
  --del-bg: #fff5f5; --add-bg: #f0fff4;
}
.frame[data-theme="dark"] {
  --bg: #1a1a1f; --fg: #ededf0; --muted: #a1a1aa; --border: rgba(237, 237, 240, 0.16);
  --hover: rgba(237, 237, 240, 0.08); --shadow: 0 0 0 1px #2e2e36, 0 10px 28px -6px rgba(0, 0, 0, 0.6);
  --accent: #818cf8; --accent-fg: #0f0f12; --pin-fg: #0f0f12;
  --st-with: #818cf8; --st-check: #3fb950; --st-declined: #d29922; --st-answer: #db6d28; --st-planned: #ab7df8;
  --st-lost: #8a8a95; --st-done: #8a8a95; --st-lock: #39c5cf; --st-draft: #a5b4fc; --draft-bg: #2b2a52; --draft-fg: #c7d2fe;
  --add: #3fb950; --mod: #d29922; --del: #f85149;
  --del-bg: #2d1517; --add-bg: #12261e;
}
@media (prefers-color-scheme: dark) {
  .frame:not([data-theme="light"]) {
    --bg: #1a1a1f; --fg: #ededf0; --muted: #a1a1aa; --border: rgba(237, 237, 240, 0.16);
    --hover: rgba(237, 237, 240, 0.08); --shadow: 0 0 0 1px #2e2e36, 0 10px 28px -6px rgba(0, 0, 0, 0.6);
    --accent: #818cf8; --accent-fg: #0f0f12; --pin-fg: #0f0f12;
    --st-with: #818cf8; --st-check: #3fb950; --st-declined: #d29922; --st-answer: #db6d28; --st-planned: #ab7df8;
    --st-lost: #8a8a95; --st-done: #8a8a95; --st-lock: #39c5cf; --st-draft: #a5b4fc; --draft-bg: #2b2a52; --draft-fg: #c7d2fe;
    --add: #3fb950; --mod: #d29922; --del: #f85149;
    --del-bg: #2d1517; --add-bg: #12261e;
  }
}
.st-with { --c: var(--st-with); }
.st-check { --c: var(--st-check); }
.st-declined { --c: var(--st-declined); }
.st-answer { --c: var(--st-answer); }
.st-planned { --c: var(--st-planned); }
.st-lost { --c: var(--st-lost); }
.st-done { --c: var(--st-done); }
.st-lock { --c: var(--st-lock); }
.st-draft { --c: var(--st-draft); }
.layer { position: absolute; inset: 0; pointer-events: none; }
.frame.annotations-hidden .layer-fallback, .frame.annotations-hidden .layer-marks,
.frame.annotations-hidden .layer-changes, .frame.annotations-hidden .layer-pins { display: none; }
.hl, .box, .bar, .bracket { position: absolute; box-sizing: border-box; pointer-events: none; }
.box.outline { border: 2px solid var(--c, var(--st-with)); border-radius: 4px; }
.box.outline.block { border-style: dotted; }
.box.outline.active, .box.node.active, .box.region.active {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent); }
.box.outline.active { border-width: 3px; }
.box.region { border: 2px dashed var(--c, var(--st-with)); background: color-mix(in srgb, var(--c, var(--st-with)) 8%, transparent);
  border-radius: 3px; }
.box.node { border: 2px solid var(--c, var(--st-with)); border-radius: 6px; }
.bracket { border: 2px solid var(--c, var(--st-lock)); border-right: 0; border-radius: 3px 0 0 3px; width: 7px;
  pointer-events: auto; cursor: pointer; }
.pin { position: absolute; box-sizing: border-box; min-width: 20px; height: 20px; padding: 0 5px;
  border-radius: 10px 10px 10px 3px; background: var(--c, var(--st-with)); color: var(--pin-fg); font-weight: 600;
  font-size: 11px; line-height: 20px; text-align: center; cursor: pointer; pointer-events: auto;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25); border: 0; font-variant-numeric: tabular-nums; }
.pin.st-draft { background: var(--draft-bg); color: var(--draft-fg); line-height: 18px;
  border: 1px dashed var(--st-draft); box-shadow: none; }
.pin.active { transform: scale(1.18); box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent); }
.pin:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.bar { width: 3px; border-radius: 2px; }
.bar.add { background: var(--add); }
.bar.mod { background: var(--mod); }
.bar.del { background: var(--del); }
.bar.active { width: 5px; border-radius: 3px; }
.box.chg-fig { border: 2px solid; border-radius: 6px; }
.box.chg-fig.add { border-color: color-mix(in srgb, var(--add) 60%, transparent);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--add) 14%, transparent); }
.box.chg-fig.mod { border-color: color-mix(in srgb, var(--mod) 70%, transparent);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--mod) 16%, transparent); }
.box.chg-fig.del { border-color: color-mix(in srgb, var(--del) 55%, transparent);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--del) 12%, transparent); }
.box.chg-active { border: 2px solid; border-radius: 7px; }
.box.chg-active.add { border-color: color-mix(in srgb, var(--add) 85%, transparent);
  background: color-mix(in srgb, var(--add) 6%, transparent); }
.box.chg-active.mod { border-color: color-mix(in srgb, var(--mod) 85%, transparent);
  background: color-mix(in srgb, var(--mod) 7%, transparent); }
.box.chg-active.del { border-color: color-mix(in srgb, var(--del) 80%, transparent);
  background: color-mix(in srgb, var(--del) 5%, transparent); }
.badge { position: absolute; box-sizing: border-box; height: 15px; padding: 0 5px; border-radius: 8px;
  font-size: 10px; line-height: 15px; font-weight: 600; color: var(--accent-fg); background: var(--accent);
  pointer-events: auto; cursor: pointer; white-space: nowrap; }
.badge.other { color: var(--muted); background: var(--bg); box-shadow: inset 0 0 0 1px var(--border); cursor: help;
  font-weight: 500; }
.tab { position: absolute; box-sizing: border-box; height: 18px; padding: 0 7px; border-radius: 9px;
  font-size: 11px; line-height: 16px; color: var(--del); background: var(--del-bg);
  border: 1px solid var(--del); pointer-events: auto; cursor: pointer; white-space: nowrap; }
.tab.open { background: var(--del); color: #fff; }
.tab.add { color: var(--add); background: var(--add-bg); border-color: var(--add); cursor: default; }
.tab.note { cursor: default; }
.tab.gutter { cursor: help; }
.tab.active { font-weight: 600; box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px currentColor; }
.tab.compact, .badge.compact { height: 13px; padding: 0 4px; border-radius: 7px; line-height: 11px; }
.tab.compact { font-size: 10px; }
.badge.compact { font-size: 9px; line-height: 13px; }
.tick { position: absolute; box-sizing: border-box; width: 6px; height: 14px; border-radius: 3px;
  background: var(--add); pointer-events: auto; cursor: help; }
.tick.active { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--add); }
.glass { position: absolute; inset: 0; pointer-events: auto; cursor: crosshair; background: transparent; }
.pickbox { position: absolute; box-sizing: border-box; border: 2px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, transparent); border-radius: 3px; pointer-events: none; }
.chip { position: absolute; box-sizing: border-box; max-width: min(70vw, 520px); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; padding: 1px 7px; border-radius: 4px; font-size: 11px;
  line-height: 16px; color: var(--accent-fg); background: var(--accent); pointer-events: none; }
.dragbox { position: absolute; box-sizing: border-box; border: 2px dashed var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent); pointer-events: none; }
.dragbox.pending { border-style: solid; background: color-mix(in srgb, var(--accent) 6%, transparent);
  animation: sr-snip 0.7s ease-in-out infinite alternate; }
@keyframes sr-snip { from { opacity: 1; } to { opacity: 0.45; } }
.hint { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); box-sizing: border-box;
  max-width: calc(100vw - 16px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 11px;
  border-radius: 12px; font-size: 12px; line-height: 18px; color: var(--accent-fg);
  background: color-mix(in srgb, var(--accent) 95%, transparent); box-shadow: var(--shadow); pointer-events: none; }
.scratch { position: absolute; left: 0; top: 0; width: 0; height: 0; border: 0; visibility: hidden;
  pointer-events: none; }
.menu { position: absolute; display: flex; gap: 2px; padding: 3px; border-radius: 8px; background: var(--bg);
  border: 1px solid var(--border); box-shadow: var(--shadow); pointer-events: auto; }
.menu button { all: unset; box-sizing: border-box; padding: 4px 9px; border-radius: 6px; cursor: pointer;
  color: var(--fg); font-size: 12px; line-height: 18px; white-space: nowrap; }
.menu button:hover { background: var(--hover); }
.menu button kbd { font: inherit; color: var(--muted); margin-left: 4px; }
.pop { position: absolute; box-sizing: border-box; width: min(560px, calc(100vw - 16px)); max-height: 50vh;
  overflow: auto; padding: 8px 10px; border-radius: 8px; background: var(--bg); color: var(--fg);
  border: 1px solid var(--border); border-left: 3px solid var(--del); box-shadow: var(--shadow);
  pointer-events: auto; user-select: text; }
.pop .pop-head { font-size: 11px; color: var(--muted); margin-bottom: 6px; }
.pop pre { margin: 0; white-space: pre-wrap; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
.pop .del-html { font-size: 13px; line-height: 1.5; }
.pop .del-html img { max-width: 100%; }
.pulse { position: absolute; box-sizing: border-box; border: 3px solid var(--accent); border-radius: 6px;
  pointer-events: none; animation: sr-pulse 1.2s ease-out forwards; }
@keyframes sr-pulse { 0% { opacity: 1; transform: scale(1.03); } 100% { opacity: 0; transform: scale(1); } }
@media (prefers-reduced-motion: reduce) { .pulse { animation-duration: 0.01s; } .dragbox.pending { animation: none; } }
`;

  /** @type {HTMLElement|null} */
  let host = null;
  /** @type {ShadowRoot|null} */
  let root = null;
  /** @type {HTMLElement|null} */
  let frame = null;
  /** @type {Record<string, HTMLElement>} */
  const layers = {};
  /** @type {Map<string, ReturnType<typeof makePool>>} */
  const pools = new Map();
  let hidden = false;

  /** @param {string} cls @param {string} [tag] */
  function make(cls, tag = 'div') {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    return el;
  }

  /** @param {HTMLElement} layer */
  function makePool(layer) {
    /** @type {Map<string, HTMLElement>} */
    const items = new Map();
    /** @type {Set<string>} */
    let seen = new Set();
    return {
      items,
      begin() {
        seen = new Set();
      },
      /** @param {string} key @param {string} cls @param {string} [tag] */
      el(key, cls, tag = 'div') {
        let e = items.get(key);
        if (!e || e.localName !== tag) {
          if (e) e.remove();
          e = make(cls, tag);
          e.dataset.key = key;
          layer.appendChild(e);
          items.set(key, e);
        }
        if (e.className !== cls) e.className = cls;
        seen.add(key);
        return e;
      },
      end() {
        for (const [k, e] of items) {
          if (!seen.has(k)) {
            e.remove();
            items.delete(k);
          }
        }
      },
      clear() {
        for (const e of items.values()) e.remove();
        items.clear();
      },
    };
  }

  /** Places an element at viewport coordinates. @param {HTMLElement} el */
  function place(el, x, y, w, h) {
    const s = el.style;
    s.left = Math.round(x * 10) / 10 + 'px';
    s.top = Math.round(y * 10) / 10 + 'px';
    if (w != null) s.width = Math.max(0, Math.round(w * 10) / 10) + 'px';
    if (h != null) s.height = Math.max(0, Math.round(h * 10) / 10) + 'px';
  }

  function show() {
    if (!host || !SUPPORTS_POPOVER) return;
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch (err) {
      recordGuestError('showPopover', err);
    }
  }

  /** @param {HTMLElement} el */
  function applyHostStyle(el) {
    for (const [name, value] of HOST_DECLS) el.style.setProperty(name, value, 'important');
  }

  /** Styles the shadow root through a constructed stylesheet (a <style> element only where that is unsupported). */
  function adoptStyles(/** @type {ShadowRoot} */ r) {
    try {
      if (Array.isArray(r.adoptedStyleSheets) && typeof CSSStyleSheet === 'function') {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS_TEXT);
        r.adoptedStyleSheets = [sheet];
        return;
      }
    } catch (err) {
      recordGuestError('overlay-sheet', err);
    }
    const style = document.createElement('style');
    style.textContent = CSS_TEXT;
    r.appendChild(style);
  }

  /** Whether the overlay's own styles took effect (the host must never take clicks away from the page). */
  function styled() {
    if (!host || !frame) return false;
    return getComputedStyle(host).pointerEvents === 'none' && getComputedStyle(frame).position === 'absolute';
  }

  // ---- modal dialogs ----------------------------------------------------------------------------------------
  // While the page shows a modal <dialog>, everything outside that dialog's subtree is inert: the host (a child of
  // <html>) would still be drawn on top, but every click on the toolbar, a pin or a tab would go through it to the
  // page. So while a modal is open the host is the last child of the topmost modal dialog (it stays in the top layer,
  // so it is drawn and positioned exactly as before) and goes back to <html> when the dialog closes. Side effect
  // while the modal is open: the dialog has one more element child (e.g. `dialog > :last-child` rules no longer
  // match its last child); the host's own mutations are ignored by the guest (OWN_NODES) and its text by TextWalk.

  const dialogs = document.getElementsByTagName('dialog');
  /** @type {Element[]} modal dialogs in the order they were opened (from toggle events) */
  let modalOrder = [];

  /** @param {Element} d */
  function isModal(d) {
    try {
      return d.matches(':modal');
    } catch {
      return false; // :modal unsupported
    }
  }

  /** The modal dialog that is not inert (the most recently opened one), or null. */
  function blockingModal() {
    if (!dialogs.length) {
      modalOrder = [];
      return null;
    }
    /** @type {Element[]} */
    const open = [];
    for (const d of dialogs) if (isModal(d)) open.push(d);
    modalOrder = modalOrder.filter((d) => open.includes(d));
    if (!open.length) return null;
    return modalOrder.length ? modalOrder[modalOrder.length - 1] : open[open.length - 1];
  }

  /** Where the host belongs right now. */
  function hostParent() {
    return blockingModal() || document.documentElement;
  }

  /**
   * Re-shows the overlay on top when the page puts something else in the top layer, and follows modal dialogs.
   * @param {Event} ev
   */
  function onTopLayerChange(ev) {
    if (!host || ev.target === host) return;
    const t = /** @type {Element} */ (ev.target);
    const isDialog = isElement(t) && t.localName === 'dialog';
    const opened = ev.type === 'fullscreenchange' || (ev.type === 'toggle' && /** @type {any} */ (ev).newState === 'open');
    if (isDialog) {
      modalOrder = modalOrder.filter((d) => d !== t);
      if (opened && isModal(t)) modalOrder.push(t);
    } else if (!opened) {
      return;
    }
    setTimeout(guard(() => ensure(opened), 'reshow'), 0);
  }

  function mount() {
    if (host) return;
    host = document.createElement('sr-overlay');
    host.setAttribute('data-sr-ignore', '');
    applyHostStyle(host);
    if (SUPPORTS_POPOVER) host.setAttribute('popover', 'manual');
    OWN_NODES.add(host);
    root = host.attachShadow({ mode: 'closed' });
    adoptStyles(root);
    frame = make('frame');
    for (const name of LAYERS) {
      const layer = make('layer layer-' + name);
      layers[name] = layer;
      frame.appendChild(layer);
    }
    root.appendChild(frame);
    // Keep our pointer traffic away from the page's bubbling listeners.
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu',
      'touchstart', 'touchend', 'wheel']) {
      root.addEventListener(type, (ev) => ev.stopPropagation(), { passive: type === 'wheel' || type.startsWith('touch') });
    }
    hostParent().appendChild(host);
    show();
    if (!styled()) recordGuestError('overlay-style', new Error('overlay styles did not apply'));
    window.addEventListener('toggle', guard(onTopLayerChange, 'toggle'), true);
    window.addEventListener('close', guard(onTopLayerChange, 'dialog-close'), true);
    document.addEventListener('fullscreenchange', guard(onTopLayerChange, 'fullscreen'), true);
  }

  /**
   * Re-attaches the host if the page removed it, moves it into / out of a modal dialog, and makes sure it is in
   * the top layer (`raise`: re-show it even when it is, to put it above something the page just showed).
   */
  function ensure(raise = false) {
    if (!host) return;
    const parent = hostParent();
    if (!host.isConnected || host.parentNode !== parent) {
      parent.appendChild(host);
      show();
    } else if (raise === true || (SUPPORTS_POPOVER && !host.matches(':popover-open'))) {
      show();
    }
  }

  // ---- single widgets in the 'ui' layer ---------------------------------------------------------------------

  /** @type {Record<string, HTMLElement|null>} */
  const widgets = {
    glass: null, pickbox: null, chip: null, dragbox: null, snipbox: null, hint: null, chooser: null, toolbar: null,
    pop: null,
  };

  /** @param {string} name @param {string} cls @param {string} [tag] */
  function widget(name, cls, tag) {
    let el = widgets[name];
    if (!el) {
      el = make(cls, tag);
      el.dataset.widget = name;
      if (name === 'glass') layers.ui.insertBefore(el, layers.ui.firstChild);
      else layers.ui.appendChild(el);
      widgets[name] = el;
    }
    el.className = cls;
    return el;
  }

  /** @param {string} name */
  function removeWidget(name) {
    const el = widgets[name];
    if (el) el.remove();
    widgets[name] = null;
  }

  /**
   * A horizontal button menu. Buttons keep the page selection (pointerdown is prevented).
   * @param {string} name
   * @param {Array<{id: string, label: string, key?: string}>} items
   * @param {(id: string) => void} onChoose
   */
  function menu(name, items, onChoose) {
    const el = widget(name, 'menu');
    el.setAttribute('role', 'toolbar');
    el.textContent = '';
    for (const it of items) {
      const b = make('', 'button');
      b.setAttribute('type', 'button');
      b.dataset.action = it.id;
      b.textContent = it.label;
      if (it.key) {
        const k = make('', 'kbd');
        k.textContent = it.key;
        b.appendChild(k);
      }
      b.addEventListener('pointerdown', (ev) => ev.preventDefault());
      b.addEventListener('mousedown', (ev) => ev.preventDefault());
      b.addEventListener('click', guard((/** @type {MouseEvent} */ ev) => {
        ev.preventDefault();
        onChoose(it.id);
      }, 'menu-click'));
      el.appendChild(b);
    }
    return el;
  }

  /** Positions a floating widget above (or below) an anchor rect, clamped into the viewport. */
  function placeFloating(/** @type {HTMLElement} */ el, /** @type {DOMRect|{left:number,top:number,right:number,bottom:number}} */ anchor, alignRight = true) {
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth || 200;
    const h = el.offsetHeight || 28;
    let x = alignRight ? anchor.right - w : anchor.left;
    x = clamp(x, 4, Math.max(4, vw - w - 4));
    let y = anchor.top - h - 6;
    if (y < 4) y = Math.min(anchor.bottom + 6, vh - h - 4);
    place(el, x, y);
  }

  /**
   * Positions the selection mini-toolbar: above the selection's first line box, left-aligned to the selection start
   * (clamped into the viewport); when there is no room above, below its last line box. It therefore never covers
   * selected text of a multi-line selection.
   * @param {HTMLElement} el @param {SelectionAnchor} anchor
   */
  function placeToolbar(el, anchor) {
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth || 200;
    const h = el.offsetHeight || 28;
    const x = clamp(anchor.left, 4, Math.max(4, vw - w - 4));
    let y = anchor.top - h - 6;
    if (y < 4) y = Math.min(anchor.bottom + 6, vh - h - 4);
    place(el, x, y);
  }

  const api = {
    get ready() {
      return !!host;
    },
    get host() {
      return host;
    },
    mount,
    ensure,
    place,
    /** @param {string} name */
    pool(name) {
      let p = pools.get(name);
      if (!p) {
        p = makePool(layers[name]);
        pools.set(name, p);
      }
      return p;
    },
    /** @param {'light'|'dark'|'system'|string} theme */
    setTheme(theme) {
      if (!frame) return;
      // Kept inside the shadow root: the host never changes after insertion, so page MutationObservers on
      // <html> see exactly one mutation from the guest (the host being appended).
      frame.setAttribute('data-theme', theme === 'light' || theme === 'dark' ? theme : 'system');
    },
    /** @param {boolean} h */
    setHidden(h) {
      hidden = !!h;
      if (frame) frame.classList.toggle('annotations-hidden', hidden);
    },
    get hidden() {
      return hidden;
    },

    // selection mini-toolbar
    toolbar: {
      /**
       * @param {SelectionAnchor} anchor first-line top / start left / last-line bottom of the selection
       * @param {(action: string) => void} onAction
       */
      show(anchor, onAction) {
        const el = menu('toolbar', [
          { id: 'comment', label: 'Comment', key: 'c' },
          { id: 'suggest', label: 'Suggest', key: 's' },
          { id: 'question', label: 'Question', key: 'q' },
          { id: 'agree', label: 'Agreed', key: 'a' },
        ], onAction);
        el.setAttribute('aria-label', 'Comment on selection');
        placeToolbar(el, anchor);
      },
      /** @param {SelectionAnchor} anchor */
      move(anchor) {
        if (widgets.toolbar) placeToolbar(widgets.toolbar, anchor);
      },
      hide() {
        removeWidget('toolbar');
      },
      get visible() {
        return !!widgets.toolbar;
      },
    },

    // pick and snip modes
    glass: {
      /**
       * @param {{move: (e: PointerEvent) => void, down: (e: PointerEvent) => void, up: (e: PointerEvent) => void,
       *          leave: () => void, cancel?: (e: PointerEvent) => void}} h
       */
      on(h) {
        const el = widget('glass', 'glass');
        el.onpointermove = guard(h.move, 'glass-move');
        el.onpointerdown = guard(h.down, 'glass-down');
        el.onpointerup = guard(h.up, 'glass-up');
        el.onpointerleave = guard(h.leave, 'glass-leave');
        el.onpointercancel = h.cancel ? guard(h.cancel, 'glass-cancel') : null;
        el.oncontextmenu = (ev) => ev.preventDefault();
        return el;
      },
      off() {
        removeWidget('glass');
      },
      get el() {
        return widgets.glass;
      },
    },
    pickBox: {
      /** @param {DOMRect} rect @param {string} label */
      show(rect, label) {
        const box = widget('pickbox', 'pickbox');
        place(box, rect.left - 2, rect.top - 2, rect.width + 4, rect.height + 4);
        const chip = widget('chip', 'chip');
        chip.textContent = label;
        const y = rect.top - 20 >= 2 ? rect.top - 20 : rect.bottom + 4;
        const vw = document.documentElement.clientWidth || window.innerWidth;
        place(chip, clamp(rect.left - 2, 2, Math.max(2, vw - (chip.offsetWidth || 120) - 2)), y);
      },
      hide() {
        removeWidget('pickbox');
        removeWidget('chip');
      },
      get label() {
        return widgets.chip ? widgets.chip.textContent : null;
      },
    },
    dragBox: {
      /** @param {{left:number, top:number, width:number, height:number}} r */
      show(r) {
        place(widget('dragbox', 'dragbox'), r.left, r.top, r.width, r.height);
      },
      hide() {
        removeWidget('dragbox');
      },
    },
    /** The box of a finished snip while its crop is being rendered (never part of the crop: see 65-snip.js). */
    snipBox: {
      /** @param {{left:number, top:number, width:number, height:number}} r */
      show(r) {
        place(widget('snipbox', 'dragbox pending'), r.left, r.top, r.width, r.height);
      },
      hide() {
        removeWidget('snipbox');
      },
    },
    /** A one-line hint centred at the top of the viewport (e.g. how to finish or cancel snip mode). */
    hint: {
      /** @param {string} text */
      show(text) {
        const el = widget('hint', 'hint');
        if (el.textContent !== text) el.textContent = text;
        el.setAttribute('role', 'status');
      },
      hide() {
        removeWidget('hint');
      },
    },
    /**
     * Parks a helper node inside the closed shadow root (hidden, zero-sized): it lives in this document but outside
     * the author's DOM, so no page MutationObserver (nor the guest's own) sees it come and go. The caller removes it.
     * @template {HTMLElement} T
     * @param {T} node
     * @returns {T}
     */
    scratch(node) {
      if (!frame) throw new Error('overlay not mounted');
      node.classList.add('scratch');
      frame.appendChild(node);
      return node;
    },
    chooser: {
      /**
       * @param {DOMRect} anchor
       * @param {Array<{id: string, label: string, key?: string}>} items
       * @param {(id: string) => void} onChoose
       */
      show(anchor, items, onChoose) {
        const el = menu('chooser', items, onChoose);
        el.setAttribute('aria-label', 'Comment scope');
        placeFloating(el, anchor, false);
      },
      hide() {
        removeWidget('chooser');
      },
      get visible() {
        return !!widgets.chooser;
      },
    },
    popover: {
      /** @param {DOMRect} anchor @param {Node} content @param {string} key */
      show(anchor, content, key) {
        const el = widget('pop', 'pop');
        el.dataset.for = key;
        el.textContent = '';
        el.appendChild(content);
        const vh = window.innerHeight;
        const vw = document.documentElement.clientWidth || window.innerWidth;
        const w = el.offsetWidth || 400;
        const h = el.offsetHeight || 120;
        let y = anchor.bottom + 4;
        if (y + h > vh - 4) y = Math.max(4, anchor.top - h - 4);
        place(el, clamp(anchor.left, 4, Math.max(4, vw - w - 4)), y);
      },
      /** @param {DOMRect} anchor */
      move(anchor) {
        const el = widgets.pop;
        if (!el) return;
        const vh = window.innerHeight;
        const h = el.offsetHeight || 120;
        let y = anchor.bottom + 4;
        if (y + h > vh - 4) y = Math.max(4, anchor.top - h - 4);
        const vw = document.documentElement.clientWidth || window.innerWidth;
        place(el, clamp(anchor.left, 4, Math.max(4, vw - (el.offsetWidth || 400) - 4)), y);
      },
      hide() {
        removeWidget('pop');
      },
      get openKey() {
        return widgets.pop ? widgets.pop.dataset.for || null : null;
      },
    },
    /** A short attention ring around a rect. @param {DOMRect} rect */
    pulse(rect) {
      if (!layers.ui) return;
      const el = make('pulse');
      place(el, rect.left - 4, rect.top - 4, rect.width + 8, rect.height + 8);
      layers.ui.appendChild(el);
      setTimeout(() => el.remove(), 1400);
    },
    /** Debug snapshot of what is drawn (used by tests through window.__suikoGuest.inspect()). */
    inspect() {
      /** @param {Element} e */
      const r = (e) => rectJSON(e.getBoundingClientRect());
      /** @type {Record<string, any[]>} */
      const out = {};
      for (const [name, p] of pools) {
        out[name] = [...p.items.entries()].map(([key, e]) => {
          const cs = getComputedStyle(e);
          return {
            key, cls: e.className, text: e.textContent || '', title: e.getAttribute('title') || '', rect: r(e),
            // the drawn colours (the UI's palette, by theme): fill and border
            bg: cs.backgroundColor, border: cs.borderTopColor,
          };
        });
      }
      /** @param {HTMLElement|null} m */
      const menuInfo = (m) => m && {
        rect: r(m),
        buttons: [...m.querySelectorAll('button')].map((b) => ({ action: b.dataset.action, rect: r(b) })),
      };
      return {
        mounted: !!host && host.isConnected,
        parent: host && host.parentElement ? host.parentElement.localName : null,
        styled: styled(),
        topLayer: SUPPORTS_POPOVER && !!host && host.matches(':popover-open'),
        theme: frame && frame.getAttribute('data-theme'),
        hidden,
        layers: out,
        toolbar: menuInfo(widgets.toolbar),
        chooser: menuInfo(widgets.chooser),
        pickBox: widgets.pickbox && { rect: r(widgets.pickbox), label: widgets.chip ? widgets.chip.textContent : '',
          border: getComputedStyle(widgets.pickbox).borderTopColor,
          chipBg: widgets.chip ? getComputedStyle(widgets.chip).backgroundColor : null },
        glass: !!widgets.glass,
        dragBox: widgets.dragbox && r(widgets.dragbox),
        snipBox: widgets.snipbox && r(widgets.snipbox),
        hint: widgets.hint ? widgets.hint.textContent : null,
        popover: widgets.pop && { for: widgets.pop.dataset.for, text: widgets.pop.textContent,
          html: widgets.pop.innerHTML, rect: r(widgets.pop) },
      };
    },
  };
  return api;
})();
