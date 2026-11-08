// @ts-check
// Keyboard map (design 11.8, amendments 7). What each key does is listed in the command registry (commands.js),
// which the keyboard shortcuts overlay and the command palette read; handleKey implements the keys.
//
// Keys come from two places:
//   - keydown in the UI document (ignored while typing in an input / textarea, except Esc, Cmd+Shift+Enter and the
//     app-level combos below; the composer and reply boxes handle their own Cmd+Enter, Cmd+Shift+Enter and Esc);
//   - `key` messages forwarded by the guest while focus is inside the doc iframe.
// App-level combos work everywhere, also while typing (a composer keeps its text): Cmd/Ctrl+K toggles the command
// palette, Cmd/Ctrl+, Settings, Cmd/Ctrl+/ the keyboard shortcuts (also `?`). Ctrl works on macOS too, because some
// hosts (Safari, the Claude desktop app) keep the Cmd combos for themselves. The browser's own action for these
// combos is prevented. Dialogs are exclusive, and Esc closes the one that is open.
// Forwarded keys may only trigger non-mutating actions (navigation, opening a composer, toggling panels). So x / o /
// y / X (resolve, reopen, accept a decline, accept all), Cmd+Enter (send or save the comment) and Cmd+Shift+Enter
// in the composer are honoured only from the UI itself.
// b (snip an area of the doc) and Shift+B (snip the screen) work from both: they only start a capture the reviewer
// completes (dragging a box, or picking an area in the macOS picker) and open a composer; nothing is sent.
// In the composer, Cmd/Ctrl+Enter and Cmd/Ctrl+Shift+Enter follow Settings > Send comments (model.js
// composerKeyAction): right away, Enter sends the comment alone (a one-item review) and Shift saves it as a draft;
// when I click Send, Enter adds it to the review and Shift sends it now. Without a new comment open,
// Cmd/Ctrl+Shift+Enter opens the Send dialog (the whole review); f always does.
// A held key acts once: auto-repeat is ignored here (except j / k / n / p, which step through a list), and the
// composer, the reply box and the Send dialog's summary ignore a repeated Cmd/Ctrl+Enter themselves, so holding it
// can never answer "Ask before sending" or send twice.
// c / s / q / a typed in the doc with a selection are handled by the guest, which posts `action` (like its toolbar)
// instead of forwarding the key; a forwarded key that still races such an action for the same selection is dropped
// by openComposer (same capture and type within DUPLICATE_OPEN_MS), so the composer never opens twice.
// Single-character shortcuts (letters, digits, punctuation, with or without Shift) can be switched off in Settings
// (prefs.singleKeys): they then do nothing, from the UI or the doc (the guest is told too, so it stops acting on
// c / s / q / a / b itself); Esc, the Cmd/Ctrl combos, the buttons and the palette keep working.

import {
  closeDialog, cancelComposer, cancelReply, clearFocus, cycleTheme, navChange, navThread, openDialog, openSubmit,
  acceptAll, acceptDecline, acceptFocused, focusedThread, reopenFocused, selectionAction, setKeyForwarder, setMode, setTool,
  showThreads, snipScreen, startReply, stepVersion, submitComposer, toggleBaseKind, toggleDialog, toggleHidden,
  togglePick, toggleSidebar, toggleSnip,
} from './actions.js';
import { helpGroups, KEYS } from './commands.js';
import { appCombo, composerKeyAction, isComposerDirty, isReplyDirty, keyLabel, modesFor, sendModeOf } from './model.js';
import { store } from './state.js';
import { IS_MAC, isEditable } from './util.js';

export { KEYS };

/**
 * A shortcut as this platform shows it ('mod+shift+enter' -> '⌘⇧↵' on a Mac, 'Ctrl+Shift+Enter' elsewhere;
 * compact: 'Ctrl+⇧+↵', for the small hints inside buttons).
 * @param {string} combo
 * @param {{ compact?: boolean }} [opts]
 */
export const shortcut = (combo, opts) => keyLabel(combo, IS_MAC, opts);

/** The keyboard shortcuts overlay's groups, generated from the command registry. */
export const KEYMAP = Object.freeze(helpGroups());

/**
 * fromBase: forwarded by the older version's frame of Changes side by side.
 * @typedef {{ key: string, meta?: boolean, ctrl?: boolean, shift?: boolean, alt?: boolean, fromBase?: boolean }} KeyInput
 */

/**
 * Runs the action bound to a key. Returns true when the key was handled.
 * @param {KeyInput} k
 * @param {boolean} fromGuest the key was forwarded by the doc iframe
 */
export function handleKey(k, fromGuest) {
  const s = store.get();
  const key = String(k.key || '');
  const mod = !!(k.meta || k.ctrl);

  const app = appCombo(k);
  if (app) {
    toggleDialog(app);
    return true;
  }
  if (s.dialog) {
    if (key === 'Escape') {
      closeDialog();
      return true;
    }
    if (s.dialog === 'help' && key === '?' && !mod && !k.alt && s.prefs.singleKeys) {
      closeDialog();
      return true;
    }
    return false;
  }
  if (mod && key === 'Enter') {
    // The composer's keys (from the UI only: they save or send); otherwise Shift is the whole review's Send dialog.
    const act = s.composer ? composerKeyAction(s.composer, !!k.shift, sendModeOf(s)) : k.shift ? 'review' : null;
    if (k.shift && (fromGuest || act === 'review')) {
      openSubmit();
      return true;
    }
    if (fromGuest || !act || act === 'review') return false;
    submitComposer(act === 'send' ? { sendNow: true } : {});
    return true;
  }
  if (mod || k.alt) return false;
  if (key === 'Escape') return escape(fromGuest);
  // Every other key handled below is a single character: off with the Settings switch.
  if (!s.prefs.singleKeys && key.length === 1) return false;
  if (key === '?') {
    openDialog('help');
    return true;
  }
  if (key === 't') {
    // Also on the doc list.
    cycleTheme();
    return true;
  }
  if (s.route.view !== 'doc' || !s.ds) return false;

  switch (key) {
    case 'c':
    case 's':
    case 'q':
    case 'a':
      return selectionAction(key, { fromBase: !!k.fromBase });
    case 'e':
      togglePick();
      return true;
    case 'b':
    case 'B':
      // Shift+B snips the screen; b (also with Caps Lock, which reports 'B' without Shift) snips the doc.
      if (k.shift) snipScreen();
      else toggleSnip({ fromGuest });
      return true;
    case 'j':
      navThread(1);
      return true;
    case 'k':
      navThread(-1);
      return true;
    case 'n':
      navChange(1);
      return true;
    case 'p':
      navChange(-1);
      return true;
    case 'r':
      if (focusedThread()) startReply(/** @type {string} */ (s.focusedId));
      return true;
    case 'x':
      return !fromGuest && acceptFocused();
    case 'o':
      return !fromGuest && reopenFocused();
    case 'y':
      return !fromGuest && acceptDecline();
    case 'X':
      // Shift+X: accept all (from the UI only, like x); 'X' without Shift is Caps Lock: x
      if (fromGuest) return false;
      if (k.shift) acceptAll();
      else acceptFocused();
      return true;
    case 'v':
      // what waits for the reviewer (formerly the Verify queue)
      showThreads('mine', { review: true });
      return true;
    case 'f':
      openSubmit();
      return true;
    case '0':
    case '1':
    case '2':
    case '3':
    case '4': {
      // the doc's own modes (model.js modesFor): a code review has no Read (0) and no Source (3)
      const m = modesFor(s.ds).find((x) => x.n === Number(key));
      if (m) setMode(m.key);
      return true;
    }
    case '[':
      if (s.tool !== 'select') return false;
      stepVersion(-1);
      return true;
    case ']':
      if (s.tool !== 'select') return false;
      stepVersion(1);
      return true;
    case 'd':
      toggleBaseKind();
      return true;
    case 'h':
      toggleHidden();
      return true;
    case '\\':
      toggleSidebar();
      return true;
    default:
      return false;
  }
}

/**
 * Esc: closes the innermost thing that is open: pick / snip mode first (the crosshair is what the reviewer is
 * using), then a composer or reply. Esc pressed inside the doc (forwarded by the guest) is usually meant for the doc
 * itself (clearing a selection, closing the page's own popup or dialog), so it never discards a composer or reply
 * that holds input (Esc in the UI does, with Undo).
 * @param {boolean} fromGuest
 */
function escape(fromGuest) {
  const s = store.get();
  if (s.tool !== 'select') {
    setTool('select');
    return true;
  }
  if (s.composer || s.reply) {
    const keep = fromGuest && (s.composer
      ? isComposerDirty(s.composer) || s.composer.busy
      : isReplyDirty(s.reply, s.ds?.drafts) || !!s.reply?.busy);
    if (!keep) {
      if (s.composer) cancelComposer();
      else cancelReply();
    }
    // Kept: closing the drawer (narrow) would hide the input the reviewer is writing.
    return true;
  }
  if (s.narrow && (s.drawer || s.nav)) {
    store.set({ drawer: false, nav: false });
    return true;
  }
  if (s.sourceSel) {
    store.set({ sourceSel: null });
    return true;
  }
  if (s.focusedId) {
    clearFocus();
    return true;
  }
  return false;
}

/** The Latin character of the physical keys of the app-level combos (keyboard layouts without Latin letters). */
const APP_CODES = /** @type {Record<string, string>} */ ({ KeyK: 'k', Comma: ',', Slash: '/' });

/** @param {KeyboardEvent} ev @returns {KeyInput} */
function keyInput(ev) {
  let key = ev.key;
  // Cmd+K on a Cyrillic / Greek / Hebrew layout types a non-Latin character: match the app combos by physical key
  // then (never for a Latin character, so Cmd+- on a German keyboard, physically 'Slash', stays zoom out).
  if ((ev.metaKey || ev.ctrlKey) && key && key.length === 1 && !/^[\x20-\x7e]$/.test(key) && APP_CODES[ev.code]) {
    key = APP_CODES[ev.code];
  }
  return { key, meta: ev.metaKey, ctrl: ev.ctrlKey, shift: ev.shiftKey, alt: ev.altKey };
}

/** @param {KeyboardEvent} ev */
function onKeyDown(ev) {
  if (ev.defaultPrevented || ev.isComposing) return;
  const k = keyInput(ev);
  if (appCombo(k)) {
    // Global, also while typing in a field; an auto-repeat only keeps the browser from acting.
    ev.preventDefault();
    if (!ev.repeat) handleKey(k, false);
    return;
  }
  if (ev.repeat && !['j', 'k', 'n', 'p'].includes(ev.key)) return;
  if (isEditable(ev.target)) {
    const submitCombo = (k.meta || k.ctrl) && k.shift && k.key === 'Enter';
    if (k.key !== 'Escape' && !submitCombo) return;
    if (k.key === 'Escape' && !store.get().dialog) {
      /** @type {HTMLElement} */ (ev.target).blur();
      return;
    }
  }
  if (handleKey(k, false)) ev.preventDefault();
}

export function installKeys() {
  setKeyForwarder((d) => {
    if (!d || typeof d.key !== 'string') return;
    handleKey({ key: d.key, meta: !!d.meta, ctrl: !!d.ctrl, shift: !!d.shift, alt: !!d.alt, fromBase: !!d.fromBase }, true);
  });
  document.addEventListener('keydown', onKeyDown);
}
