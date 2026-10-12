// Suiko guest, part 85: keyboard forwarding (amendments section 7).
//
// While focus is inside the document iframe, the reviewer's shortcuts (c s q a e j k n p r f h t v d 1-4 [ ] \ ? ...)
// would never reach the UI. The guest forwards `key {key, meta, ctrl, shift, alt}` to the UI when:
//   - the event is trusted (a real keystroke): a script in the reviewed document cannot fake keys, e.g. Shift+B,
//     which opens the reviewer's native screen picker, or `b`, which enters snip mode;
//   - the focus is not in an editable element (input, textarea, select, contenteditable) and not composing (IME);
//   - the page did not call preventDefault() — checked after the event finished dispatching, so handlers registered
//     after the guest's are respected too;
//   - the key is a single printable character without Cmd/Ctrl/Alt, Escape, or Enter with Cmd/Ctrl
//     (Cmd+Enter, Cmd+Shift+Enter); auto-repeat is ignored.
// The UI only maps forwarded keys to non-mutating actions. Keys consumed by pick mode ('[' ']' Esc and the cell
// chooser digits) and snip mode (Esc) are stopped in 60-picker.js / 65-snip.js and never forwarded. Esc first closes
// an open "removed" popover.
// Exception: c / s / q / a while the document has a text capture (50-selection.js) are handled here, under the same
// conditions: the guest posts `action {action, capture, rect}` exactly like the mini-toolbar and dismisses the
// toolbar, and does NOT forward the key, so the UI opens the composer once (from `action`). Without a capture
// (nothing selected, readonly mode, pick mode) the key is forwarded as before.
// Likewise `b` (also 'B' without Shift, i.e. Caps Lock) toggles snip mode in the guest (65-snip.js posts
// toolChanged {tool:'snip'} / {tool:'select'}) and is not forwarded; it is forwarded only when snips are not allowed
// (readonly). Shift+B (snip the screen, a daemon job) is always forwarded as a normal key.
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
    window.addEventListener('keydown', finish);
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
    if (isEditable(origin) || isEditable(deepActiveElement())) return;
    const payload = { key: ev.key, meta: ev.metaKey, ctrl: ev.ctrlKey, shift: ev.shiftKey, alt: ev.altKey };
    // Decide after dispatch so that page handlers that run after ours can still claim the key.
    setTimeout(guard(() => {
      if (ev.defaultPrevented) return;
      if (prefs.singleKeys) {
        const action = SELECTION_KEYS[payload.key];
        if (action && SelectionCapture.keyAction(action)) return; // posted `action`; the UI must not see the key too
        if (isSnipKey(payload) && Snip.keyToggle()) return; // posted `toolChanged`; the UI follows it
      }
      Channel.send(MSG.KEY, payload);
    }, 'key-forward'), 0);
  }

  return {
    start() {
      window.addEventListener('keydown', guard(onAppKeyCapture, 'app-keydown'), true);
      window.addEventListener('keydown', guard(onKeyDown, 'keydown'));
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
  };
})();
