// Suiko guest, part 85: keyboard forwarding (amendments section 7).
//
// While focus is inside the document iframe, the reviewer's shortcuts (c s q a e j k n p r f h t v d 1-4 [ ] \ ? ...)
// would never reach the UI. The guest forwards `key {key, meta, ctrl, shift, alt}` to the UI when:
//   - the event is trusted (a real keystroke): a script in the reviewed document cannot fake keys, e.g. Shift+B,
//     which opens the reviewer's native screen picker, or `b`, which enters snip mode;
//   - the focus is not in an editable element (input, textarea, select, contenteditable) and not composing (IME),
//     and not in an interactive widget that takes keys itself (any other form control, or an element with an ARIA
//     widget role such as listbox, menu, tablist, tab, slider, grid, tree or combobox: typeahead and arrows are the
//     widget's);
//   - the page did not call preventDefault() — checked after the event finished dispatching, so handlers registered
//     after the guest's are respected too;
//   - the key is a single printable character without Cmd/Ctrl/Alt, Escape, or Enter with Cmd/Ctrl
//     (Cmd+Enter, Cmd+Shift+Enter); auto-repeat is ignored.
// When the page handles keys itself (07-page.js PageKeys: key listeners on window / document / <html> / <body>, or
// on an element the key passes through, or on<key> handlers there), its keys are the page's: a doc's own `r`, `3` or
// `f` must never reload, switch modes or open Submit in Suiko. Then only Escape, Cmd/Ctrl+Enter (with or without
// Shift), the app-level combos below, and c / s / q / a while the document has a text selection (the selection
// actions) reach Suiko; every other single key stays with the page (the tool dock, the palette and the keys typed
// in the UI itself still reach everything). Without such listeners nothing changes. The first single key that stays
// with the page (single-key shortcuts on, no Cmd/Ctrl/Alt, not a space) is reported once per page load as
// `keyKept {key}`, so the UI can tell the reviewer once why b, e, j ... do nothing in this document.
// The UI only maps forwarded keys to non-mutating actions. Keys consumed by pick mode ('[' ']' Esc and the cell
// chooser digits) and snip mode (Esc) are stopped in 60-picker.js / 65-snip.js and never forwarded. Esc first closes
// an open "removed" popover.
// Exception: c / s / q / a while the document has a text capture (50-selection.js) are handled here, under the same
// conditions: the guest posts `action {action, capture, rect}` exactly like the mini-toolbar and dismisses the
// toolbar, and does NOT forward the key, so the UI opens the composer once (from `action`). Without a capture
// (nothing selected, readonly mode, pick mode) the key is forwarded as before (not when the page handles keys).
// Likewise `b` (also 'B' without Shift, i.e. Caps Lock) toggles snip mode in the guest (65-snip.js posts
// toolChanged {tool:'snip'} / {tool:'select'}) and is not forwarded; it is forwarded only when snips are not allowed
// (readonly). Shift+B (snip the screen, a daemon job) is always forwarded as a normal key. Neither of them when the
// page handles keys.
// Both exceptions are single-key shortcuts the reviewer can turn off: after `setPrefs {singleKeys:false}` (or INIT
// with prefs {singleKeys:false}) the guest acts on none of these keys and forwards them like any other key (the UI
// then ignores them). The mini-toolbar, and pick / snip started from the UI (setTool), keep working.
//
// App-level combos — Mod+K (command palette), Mod+, (settings), Mod+/ (keyboard shortcuts), where Mod is Cmd or Ctrl
// on every platform (Ctrl is the macOS fallback for hosts that reserve the Cmd combos) and Alt is not held (so
// AltGr characters typed on Windows are never taken) — are global, so they are forwarded EVEN with focus in an
// editable element of the document, and the guest calls preventDefault() on them so the browser does not act
// (Ctrl+K would focus the address bar). They are matched by the character typed; on layouts whose keys do not type
// Latin characters (Cyrillic, Greek, Hebrew...) by the physical key (KeyK, Comma, Slash), and the Latin character is
// forwarded so the UI recognises the combo. Matching the physical key only for non-ASCII characters keeps e.g.
// Cmd+- on a German keyboard (physical 'Slash') as zoom out. The page still has the first say: the decision is made
// by a one-shot window listener appended while the event is in its capture phase, so it runs after every page
// handler (capture or bubble, on any node including window, whenever registered). If one of them prevented the
// default or stopped propagation, the page keeps the key. Same other rules: trusted, not composing, not before the
// UI is connected; an auto-repeat is default-prevented but not forwarded again.
// The guest adds its own key listeners with listenOwn (07-page.js), so they never count as the page's.

const Keys = (() => {
  /** Keys that act on the current text selection like the mini-toolbar buttons (same map as src/ui/keys.js). */
  const SELECTION_KEYS = /** @type {Record<string, string>} */ (Object.freeze({
    c: 'comment', s: 'suggest', q: 'question', a: 'agree',
  }));

  /** App-level combos by the character typed ('K': Shift or Caps Lock; the UI decides on Shift). */
  const APP_KEYS = Object.freeze(['k', 'K', ',', '/']);
  /** ...and by physical key, only when the character is not ASCII (non-Latin layouts). */
  const APP_CODES = /** @type {Record<string, string>} */ (Object.freeze({ KeyK: 'k', Comma: ',', Slash: '/' }));

  /** Reviewer preferences pushed by the UI (setPrefs / init.prefs). */
  const prefs = { singleKeys: true };

  /** `b` without Shift (Caps Lock reports 'B'): snip the document. @param {{key: string, shift: boolean}} p */
  function isSnipKey(p) {
    return p.key === 'b' || (p.key === 'B' && !p.shift);
  }

  /** ARIA roles of widgets that take keys themselves (typeahead, arrows, Space): keys typed there stay there. */
  const WIDGET_ROLES = new Set([
    'application', 'combobox', 'grid', 'gridcell', 'listbox', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'radio', 'radiogroup', 'scrollbar', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab',
    'tablist', 'textbox', 'tree', 'treegrid', 'treeitem',
  ]);

  /**
   * Whether an element is (inside) an interactive widget that takes keys itself: a form control of any kind, or an
   * element with an ARIA widget role (up to <body>).
   * @param {Element|null} el
   */
  function inWidget(el) {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const tag = n.localName;
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return true;
      const role = n.getAttribute('role');
      if (role && role.split(/\s+/).some((r) => WIDGET_ROLES.has(r))) return true;
    }
    return false;
  }

  /**
   * The keys that still reach the UI when the page handles keys itself: Escape and Cmd/Ctrl+Enter (with or without
   * Shift). The app-level combos go their own way (onAppKeyCapture); c / s / q / a with a selection are actions.
   * @param {{key: string, meta: boolean, ctrl: boolean}} p
   */
  function passesPageKeys(p) {
    return p.key === 'Escape' || (p.key === 'Enter' && (p.meta || p.ctrl));
  }

  /** `keyKept` was posted for this page load. */
  let keptSent = false;

  /**
   * Reports, once per page load, a single-key shortcut that stayed with a page that handles keys itself (the UI says
   * why once). Not with single keys off (Suiko would not act on them anyway), not for combos or the space bar.
   * @param {{key: string, meta: boolean, ctrl: boolean, alt: boolean}} p
   */
  function noteKept(p) {
    if (keptSent || !prefs.singleKeys || p.meta || p.ctrl || p.alt || p.key.length !== 1 || p.key === ' ') return;
    keptSent = true;
    Channel.send(MSG.KEY_KEPT, { key: p.key });
  }

  /** @param {KeyboardEvent} ev */
  function shouldForward(ev) {
    if (!ev.isTrusted || ev.repeat || ev.isComposing) return false;
    const k = ev.key;
    if (k === 'Escape') return true;
    if (k === 'Enter') return ev.metaKey || ev.ctrlKey;
    if (!k || k.length !== 1) return false;
    return !ev.metaKey && !ev.ctrlKey && !ev.altKey;
  }

  /**
   * The key to forward when `ev` is an app-level combo (Mod+K / Mod+, / Mod+/), else ''.
   * @param {KeyboardEvent} ev
   */
  function appKey(ev) {
    if (!(ev.metaKey || ev.ctrlKey) || ev.altKey) return '';
    const k = ev.key || '';
    if (APP_KEYS.includes(k)) return k;
    if (/^[\x20-\x7e]$/.test(k)) return ''; // a Latin character that is not ours: never steal it by physical key
    const c = APP_CODES[ev.code];
    if (!c) return '';
    return c === 'k' && ev.shiftKey ? 'K' : c;
  }

  /** @param {KeyboardEvent} ev @param {string} key */
  function payloadOf(ev, key) {
    return { key, meta: ev.metaKey, ctrl: ev.ctrlKey, shift: ev.shiftKey, alt: ev.altKey };
  }

  /**
   * Capture phase on window: for an app-level combo, appends a one-shot bubble listener to window. Listeners added
   * during dispatch to a target whose bubble phase has not been invoked yet do run (the listener list is copied when
   * that phase starts), and after every listener already registered there, so this listener is the last to see the
   * event. If propagation is stopped first it never runs and the next keydown, or a timer, removes it.
   * @param {KeyboardEvent} ev
   */
  function onAppKeyCapture(ev) {
    if (!ev.isTrusted || ev.isComposing) return;
    const key = appKey(ev);
    if (!key) return;
    const finish = guard((/** @type {Event} */ e) => {
      window.removeEventListener('keydown', finish);
      if (e !== ev || ev.defaultPrevented || !Channel.connected) return; // the page claimed it / nobody to tell
      ev.preventDefault();
      if (!ev.repeat) Channel.send(MSG.KEY, payloadOf(ev, key));
    }, 'app-key');
    listenOwn(window, 'keydown', finish);
    setTimeout(() => window.removeEventListener('keydown', finish), 0);
  }

  /** @param {KeyboardEvent} ev */
  function onKeyDown(ev) {
    if (ev.key === 'Escape' && Overlay.popover.openKey) {
      Overlay.popover.hide();
      Scheduler.requestLayout();
      return;
    }
    if (!shouldForward(ev)) return;
    const path = ev.composedPath();
    const origin = /** @type {Element|null} */ (path.find((n) => isElement(n)) || null);
    const active = deepActiveElement();
    if (isEditable(origin) || isEditable(active) || inWidget(origin) || inWidget(active)) return;
    const payload = { key: ev.key, meta: ev.metaKey, ctrl: ev.ctrlKey, shift: ev.shiftKey, alt: ev.altKey };
    // Decide after dispatch so that page handlers that run after ours can still claim the key.
    setTimeout(guard(() => {
      if (ev.defaultPrevented) return;
      const pageKeys = PageKeys.handled(path);
      if (prefs.singleKeys) {
        const action = SELECTION_KEYS[payload.key];
        if (action && SelectionCapture.keyAction(action)) return; // posted `action`; the UI must not see the key too
        if (!pageKeys && isSnipKey(payload) && Snip.keyToggle()) return; // posted `toolChanged`; the UI follows it
      }
      if (pageKeys && !passesPageKeys(payload)) { // the page's own key
        noteKept(payload);
        return;
      }
      Channel.send(MSG.KEY, payload);
    }, 'key-forward'), 0);
  }

  return {
    start() {
      listenOwn(window, 'keydown', guard(onAppKeyCapture, 'app-keydown'), true);
      listenOwn(window, 'keydown', guard(onKeyDown, 'keydown'));
    },
    /**
     * Applies `setPrefs` / `init.prefs`. Only the fields present (as booleans) change; the rest keep their value.
     * @param {any} p
     */
    setPrefs(p) {
      if (p && typeof p === 'object' && typeof p.singleKeys === 'boolean') prefs.singleKeys = p.singleKeys;
    },
    /** Debug: the current preferences. */
    get prefs() {
      return { singleKeys: prefs.singleKeys };
    },
    /** Debug: whether the page handles keys itself (07-page.js; listeners on window / document / <html> / <body>). */
    get pageKeys() {
      return PageKeys.handled([]);
    },
  };
})();
