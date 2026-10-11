// @ts-check
// Keyboard map (design 11.8, amendments 7).
//
// Keys come from two places:
//   - keydown in the UI document (ignored while typing in an input / textarea, except Esc and Cmd+Shift+Enter;
//     the composer and reply boxes handle their own Cmd+Enter, Cmd+Shift+Enter and Esc);
//   - `key` messages forwarded by the guest while focus is inside the doc iframe.
// Forwarded keys may only trigger non-mutating actions (navigation, opening a composer, toggling panels). So x / o /
// y (resolve, reopen, accept a decline), Cmd+Enter (add a draft) and Send now are honoured only from the UI itself.
// b (snip an area of the doc) and Shift+B (snip the screen) work from both: they only start a capture the reviewer
// completes (dragging a box, or picking an area in the macOS picker) and open a composer; nothing is sent.
// Cmd/Ctrl+Shift+Enter is Send now (this comment alone, as a one-item review) while a new comment is open in the
// composer, and Submit review (the whole review) otherwise; f is always Submit review.
// c / s / q / a typed in the doc with a selection are handled by the guest, which posts `action` (like its toolbar)
// instead of forwarding the key; a forwarded key that still races such an action for the same selection is dropped
// by openComposer (same capture and type within DUPLICATE_OPEN_MS), so the composer never opens twice.

import {
  closeDialog, cancelComposer, cancelReply, clearFocus, cycleTheme, navChange, navThread, openComposer, openSubmit,
  resolveThread, setFilter, setKeyForwarder, setMode, setTool, snipScreen, startReply, stepVersion, submitComposer,
  toast, toggleBaseKind, toggleHidden, togglePick, toggleSidebar, toggleSnip, unresolveThread,
} from './actions.js';
import { canSendNow, isComposerDirty, isReplyDirty, keyLabel } from './model.js';
import { store } from './state.js';
import { IS_MAC, isEditable } from './util.js';

/**
 * A shortcut as this platform shows it ('mod+shift+enter' -> '⌘⇧↵' on a Mac, 'Ctrl+Shift+Enter' elsewhere;
 * compact: 'Ctrl+⇧+↵', for the small hints inside buttons).
 * @param {string} combo
 * @param {{ compact?: boolean }} [opts]
 */
export const shortcut = (combo, opts) => keyLabel(combo, IS_MAC, opts);

/** The shortcuts shown on buttons (titles and kbd hints) and in the help; handleKey implements them. */
export const KEYS = Object.freeze({
  snip: 'b',
  snipScreen: 'shift+B',
  pick: 'e',
  add: 'mod+enter',
  sendNow: 'mod+shift+enter',
  submit: 'f',
  cancel: 'esc',
});

/**
 * @typedef {{ keys: string[], label: string, id?: string }} KeyRow  keys: combos for keyLabel (shown one per <kbd>)
 * @typedef {{ group: string, rows: KeyRow[] }} KeyGroup
 */

/** Shown by the help overlay, grouped (keep in sync with handleKey). @type {readonly KeyGroup[]} */
export const KEYMAP = Object.freeze([
  {
    group: 'Comment',
    rows: [
      { keys: ['c', 's', 'q', 'a'], label: 'Comment, suggest, question, or mark agreed on the selected text' },
      { id: 'snip', keys: [KEYS.snip], label: 'Snip an area of the document: drag a box over text, images or diagrams, then comment (Esc cancels)' },
      { id: 'snip-screen', keys: [KEYS.snipScreen], label: 'Snip anywhere on your screen (macOS picker), then comment on the screenshot' },
      { keys: [KEYS.pick], label: 'Pick an image, diagram, table or code block ([ ] parent / child, Shift-drag a region, Esc exits)' },
      { id: 'add', keys: [KEYS.add], label: 'Add the comment to the review (in the composer)' },
      { id: 'send-now', keys: [KEYS.sendNow], label: 'Send now: this comment alone, right away (in the composer)' },
    ],
  },
  {
    group: 'Review',
    rows: [
      { id: 'submit', keys: [KEYS.submit, KEYS.sendNow], label: 'Submit review: everything in it (the second key while no new comment is open)' },
      { keys: ['r'], label: 'Reply to the focused thread' },
      { keys: ['x'], label: 'Resolve / accept the focused thread' },
      { keys: ['o'], label: 'Reopen the focused thread' },
      { keys: ['y'], label: 'Accept a decline' },
      { keys: ['v'], label: 'Verify queue' },
    ],
  },
  {
    group: 'Navigate',
    rows: [
      { keys: ['j', 'k'], label: 'Next / previous thread' },
      { keys: ['n', 'p'], label: 'Next / previous change' },
      { keys: ['1', '2', '3', '4'], label: 'Review / Changes / Source / History' },
      { keys: ['[', ']'], label: 'Previous / next version' },
      { keys: ['d'], label: 'Toggle the base: your last review / previous version' },
    ],
  },
  {
    group: 'View',
    rows: [
      { keys: ['h'], label: 'Hide all annotations (clean read)' },
      { keys: ['\\'], label: 'Toggle the thread panel' },
      { keys: ['t'], label: 'Cycle theme (system, light, dark)' },
      { keys: ['?'], label: 'This help' },
      { keys: [KEYS.cancel], label: 'Close or cancel' },
    ],
  },
]);

const MODES = /** @type {const} */ (['review', 'changes', 'source', 'history']);

/** @typedef {{ key: string, meta?: boolean, ctrl?: boolean, shift?: boolean, alt?: boolean }} KeyInput */

/**
 * Runs the action bound to a key. Returns true when the key was handled.
 * @param {KeyInput} k
 * @param {boolean} fromGuest the key was forwarded by the doc iframe
 */
export function handleKey(k, fromGuest) {
  const s = store.get();
  const key = String(k.key || '');
  const mod = !!(k.meta || k.ctrl);

  if (s.dialog === 'help') {
    if (key === 'Escape' || key === '?') {
      closeDialog();
      return true;
    }
    return false;
  }
  if (s.dialog === 'submit' || s.dialog === 'image') {
    if (key === 'Escape') {
      closeDialog();
      return true;
    }
    return false;
  }
  if (mod && key === 'Enter') {
    if (k.shift) {
      // Send now while a new comment is open (from the UI only: it submits); otherwise the whole review.
      if (!fromGuest && canSendNow(s.composer)) submitComposer({ sendNow: true });
      else openSubmit();
      return true;
    }
    if (fromGuest || !s.composer) return false;
    submitComposer();
    return true;
  }
  if (mod || k.alt) return false;
  if (key === 'Escape') return escape(fromGuest);
  if (key === '?') {
    store.set({ dialog: 'help' });
    return true;
  }
  if (s.route.view !== 'doc' || !s.ds) return false;

  switch (key) {
    case 'c':
    case 's':
    case 'q':
    case 'a':
      return selectionAction(key);
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
    case 'v':
      if (s.mode !== 'review') setMode('review');
      setFilter('verify');
      store.set({ sidePane: 'threads', drawer: s.narrow ? true : s.drawer, sidebar: true });
      return true;
    case 'f':
      openSubmit();
      return true;
    case '1':
    case '2':
    case '3':
    case '4':
      setMode(MODES[Number(key) - 1]);
      return true;
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
    case 't':
      cycleTheme();
      return true;
    default:
      return false;
  }
}

/** c / s / q / a on the current selection (doc selection, or selected lines in Source mode). @param {string} key */
function selectionAction(key) {
  const s = store.get();
  const action = /** @type {Record<string, string>} */ ({ c: 'comment', s: 'suggest', q: 'question', a: 'agree' })[key];
  if (s.mode === 'source') {
    if (s.sourceSel && key === 'c') {
      openComposer({ capture: { kind: 'source', startLine: s.sourceSel.from, endLine: s.sourceSel.to }, action });
    } else if (key === 'c') {
      toast('Click a line number (shift-click for a range), then press C.', { timeout: 3000 });
    }
    return true;
  }
  if (s.mode === 'history') return false;
  const capture = s.guest.selection;
  if (!capture) {
    toast('Select text in the document first, press b to snip any area of it, or e to pick an image, diagram, table or code block.', { timeout: 3500 });
    return true;
  }
  openComposer({ capture, action });
  return true;
}

function focusedThread() {
  const s = store.get();
  return (s.ds?.threads || []).find((/** @type {any} */ t) => t.id === s.focusedId) || null;
}

function acceptFocused() {
  const t = focusedThread();
  if (!t || t.status === 'resolved') return false;
  resolveThread(t.id);
  return true;
}

function reopenFocused() {
  const t = focusedThread();
  if (!t) return false;
  if (t.status === 'resolved') unresolveThread(t.id);
  else startReply(t.id, { reopen: true });
  return true;
}

function acceptDecline() {
  const t = focusedThread();
  if (!t || t.status !== 'declined') return false;
  resolveThread(t.id);
  return true;
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

/** @param {KeyboardEvent} ev */
function onKeyDown(ev) {
  if (ev.defaultPrevented || ev.isComposing) return;
  if (ev.repeat && !['j', 'k', 'n', 'p'].includes(ev.key)) return;
  const k = { key: ev.key, meta: ev.metaKey, ctrl: ev.ctrlKey, shift: ev.shiftKey, alt: ev.altKey };
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
    handleKey({ key: d.key, meta: !!d.meta, ctrl: !!d.ctrl, shift: !!d.shift, alt: !!d.alt }, true);
  });
  document.addEventListener('keydown', onKeyDown);
}
