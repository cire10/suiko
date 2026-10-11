// SpecReview guest, part 85: keyboard forwarding (amendments section 7).
//
// While focus is inside the document iframe, the reviewer's shortcuts (c s q a e j k n p r f h t v d 1-4 [ ] \ ? ...)
// would never reach the UI. The guest forwards `key {key, meta, ctrl, shift, alt}` to the UI when:
//   - the focus is not in an editable element (input, textarea, select, contenteditable) and not composing (IME);
//   - the page did not call preventDefault() — checked after the event finished dispatching, so handlers registered
//     after the guest's are respected too;
//   - the key is a single printable character without Cmd/Ctrl/Alt, Escape, or Enter with Cmd/Ctrl
//     (Cmd+Enter, Cmd+Shift+Enter); auto-repeat is ignored.
// The UI only maps forwarded keys to non-mutating actions. Keys consumed by pick mode ('[' ']' Esc and the cell
// chooser digits) are stopped in 60-picker.js and never forwarded. Esc first closes an open "removed" popover.
// Exception: c / s / q / a while the document has a text capture (50-selection.js) are handled here, under the same
// conditions: the guest posts `action {action, capture, rect}` exactly like the mini-toolbar and dismisses the
// toolbar, and does NOT forward the key, so the UI opens the composer once (from `action`). Without a capture
// (nothing selected, readonly mode, pick mode) the key is forwarded as before.

const Keys = (() => {
  /** Keys that act on the current text selection like the mini-toolbar buttons (same map as src/ui/keys.js). */
  const SELECTION_KEYS = /** @type {Record<string, string>} */ (Object.freeze({
    c: 'comment', s: 'suggest', q: 'question', a: 'agree',
  }));

  /** @param {KeyboardEvent} ev */
  function shouldForward(ev) {
    if (ev.repeat || ev.isComposing) return false;
    const k = ev.key;
    if (k === 'Escape') return true;
    if (k === 'Enter') return ev.metaKey || ev.ctrlKey;
    if (!k || k.length !== 1) return false;
    return !ev.metaKey && !ev.ctrlKey && !ev.altKey;
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
      const action = SELECTION_KEYS[payload.key];
      if (action && SelectionCapture.keyAction(action)) return; // posted `action`; the UI must not see the key too
      Channel.send(MSG.KEY, payload);
    }, 'key-forward'), 0);
  }

  return {
    start() {
      window.addEventListener('keydown', guard(onKeyDown, 'keydown'));
    },
  };
})();
