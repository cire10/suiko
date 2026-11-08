// @ts-check
// The UI store: one plain state object, shallow-merged updates, and a Preact hook that re-renders a component
// only when the slice it selects changes (shallow comparison).
//
// Everything the UI shows comes from here: the DocState fetched from the daemon, the selected version / mode /
// base / filter, the focused thread, the composer, the reply box and a "Record as decision…" being written, the
// guest's connection state, dialogs (one at a time: Send, the command palette, Settings, keyboard shortcuts, an
// image, an agent's HTML attachment shown large), toasts, and the reviewer's per-browser preferences (Settings;
// localStorage through readPref / writePref, which tolerate storage being unavailable). Server data is never mutated
// in place: refetches replace it.
//
// Notifications are batched in a microtask, so a burst of `set` calls causes one render pass.

import { useLayoutEffect, useReducer, useRef } from 'preact-htm';

/** @typedef {'read'|'review'|'changes'|'source'|'history'} Mode  read: the latest version, nothing drawn over it */
/** @typedef {'mine'|'agent'|'done'|'all'} Filter  the thread panel: Your turn, the agent's ("Claude"), Done, All */
/** @typedef {'system'|'light'|'dark'} Theme */
/** @typedef {'submit'|'help'|'image'|'palette'|'settings'|'info'|'preview'} Dialog  one at a time: opening one closes the other */
/** @typedef {'general'|'reading'|'sending'|'context'|'about'} SettingsSection */

/**
 * Per-browser preferences (Settings, localStorage through readPref / writePref; the theme is `theme`). A reviewer who
 * never changed one has no key stored, so a new default reaches them.
 * @typedef {object} Prefs
 * @property {'auto'|'always'|'never'} railMode the outline rail: auto (beside the doc at >= 1600 px, a code review's
 *   file tree at >= 1200 px; behind the ≡ button below that unless opened there), always (beside the doc at >= 900
 *   px), never (behind the ≡ button)
 * @property {boolean} panelOpen the thread panel is shown when a doc opens that has threads or drafts (one with
 *   neither opens without it, and the first comment or thread opens it); \\ still toggles it
 * @property {boolean} singleKeys single-character shortcuts (c, j, b, 1, ?, ...) are on, in the UI and in the doc
 * @property {'latest'|'toast'|'changes'} onNewVersion when the agent records a version: 'latest' (default) shows it in
 *   the same mode, at the same place, with a toast ("Updated to v4 · Show changes") when the reviewer was reading the
 *   previous one in Read or Review, else only says so ("v4 is ready · Show"); 'toast' ("Just tell me") never moves
 *   the view: a toast says what arrived ("Claude recorded v4 · 1 changed", Show / Show changes / Show my turn);
 *   'changes' switches to the new version's Changes. Never while a composer, a reply, a dialog, a menu or popover, a
 *   capture tool or a text selection in the doc is open: then only the toast
 * @property {boolean} confirmSendNow Ask before sending: a comment or reply sent at once asks for confirmation first
 * @property {'comment'|'changes_requested'} defaultVerdict the Send dialog's verdict when nothing is blocking
 * @property {'review'|'read'|'auto'} openIn the mode a doc opens in: 'review' (default: the latest version, no change
 *   highlights; the Changes tab counts what is new), Read, or 'auto' (Changes when the agent revised it since the
 *   reviewer's last review or acceptance, else Review); also where turning "Show changes" off goes when the doc was
 *   opened on its changes
 * @property {'now'|'batch'} sendMode Send comments: 'now' (default: a comment or reply goes to the agent at once, as
 *   a one-item review) or 'batch' (it waits as a draft until the reviewer sends the review)
 * @property {'auto'|'now'|'batch'} editMode Doc edits (the `edits` of every review): 'now' (the agent edits the doc
 *   for each review), 'batch' (it answers now and plans the edits; the reviewer applies them together), 'auto'
 *   (default: batched on long docs, model.js isLongDoc)
 */

/**
 * @typedef {object} Composer
 * @property {number} key unique per opened composer
 * @property {any} capture guest capture (amendments 3.3 shapes)
 * @property {number|null} version version the capture was made on
 * @property {'comment'|'question'|'suggestion'|'agree'} type
 * @property {'blocking'|'normal'|'nit'} severity
 * @property {string} body
 * @property {string|null} crop PNG data URL from the guest (region / element crops, doc snips)
 * @property {string|null} [cropPath] attachment path of the uploaded crop
 * @property {Array<{ path: string, preview: string }>} attachments uploaded images (preview = data URL, '' when
 *   only the stored path is known: the thumbnail then comes from DocState.attachmentBase)
 * @property {any|null} anchor resolved anchor (POST /anchors/resolve)
 * @property {any|null} preview {label, lines, section, src}
 * @property {boolean} resolving
 * @property {string|null} resolveError
 * @property {boolean} widened
 * @property {{ mode: 'text'|'source', old: string, new: string, startLine: number, endLine: number,
 *   start: number, end: number, loading?: boolean } | null} suggestion
 * @property {{ mode: string, old: string, new: string }|null} [pendingSuggestion] suggested text restored from a
 *   backup, applied once the suggestion editor has loaded the same old text
 * @property {string} note lock note (type 'agree')
 * @property {string|null} draftId set when editing an existing draft
 * @property {string|null} [createdDraftId] draft this composer already created (a Send whose review request failed):
 *   the composer stays bound to it (actions.js boundDraft), so a retry saves and sends that draft instead of creating
 *   another, its card shows "Being edited" without its own Send, sending it any other way closes the composer, and
 *   Cancel deletes it
 * @property {boolean} busy
 * @property {string|null} error
 * @property {boolean} [confirmSend] "Ask before sending" is showing its confirmation
 */

/**
 * The reply box of a thread (one at a time). draftId: the reply draft it edits (its pending-reply row is hidden
 * meanwhile); use: attachments of the thread the agent is asked to put into the doc ("Use in doc"), kept through the
 * reply's draft; createdDraftId: the draft a Send whose review request failed created (the box stays bound to it,
 * like draftId: a retry sends that one); confirmSend: "Ask before sending" is showing its question; error: why the
 * last Send or save failed.
 * @typedef {{ threadId: string, body: string, reopen: boolean, draftId: string|null, busy: boolean, use?: string[],
 *   createdDraftId?: string|null, confirmSend?: boolean, error?: string|null }} Reply
 */

/**
 * The "Record as decision…" input of a thread card (one at a time): the thread and what was typed. In the store, so
 * a card that leaves the filter shown keeps it (panelItems `keep`), and a code review's inline card can open it on the
 * panel's card.
 * @typedef {{ threadId: string, text: string }} Decision
 */

/**
 * @typedef {object} UiState
 * @property {{ view: 'home' } | { view: 'doc', ws: string, doc: string }} route
 * @property {'ok'|'reconnecting'|'unauthorized'} conn
 * @property {{ docs: any[]|null, error: string|null }} home
 * @property {any|null} ds DocState
 * @property {string|null} loadError
 * @property {number|'live'|null} version selected version
 * @property {boolean} followHead switch to a new head automatically
 * @property {Mode} mode
 * @property {number|null} base Changes / Source diff base version
 * @property {'last'|'prev'|'custom'} baseKind
 * @property {Filter} filter the thread panel's filter
 * @property {boolean} filterPinned the reviewer picked the filter for this doc (a click, a command, Show my turn);
 *   until then the panel follows model.js defaultFilter (Your turn when something waits for them, else the agent's,
 *   else All)
 * @property {string|null} focusedId thread or draft id
 * @property {string|null} activeHunk
 * @property {{ threads: any[], locks: any[], drafts: any[], outline: any[] } | null} targets
 * @property {any|null} changes Changes for base -> version
 * @property {string|null} changesError
 * @property {Composer|null} composer
 * @property {Reply|null} reply
 * @property {Decision|null} decision the "Record as decision…" input open on a thread card
 * @property {Theme} theme
 * @property {boolean} hidden annotations hidden (clean read)
 * @property {'select'|'pick'|'snip'} tool select text / pick an element (e) / snip an area of the doc (b)
 * @property {{ running: boolean, supported: boolean }} screenSnip the macOS region picker run by the daemon (B):
 *   running while it waits for the reviewer; supported turns false once the daemon answered 501 (not macOS)
 * @property {boolean} narrow viewport below 900 px
 * @property {boolean} medium viewport 900-1199 px: the narrower side panel, the header's short labels
 * @property {boolean} roomy viewport 1600 px and up: room for the outline rail beside the doc and the thread panel
 * @property {boolean} rail below 1600 px with railMode 'auto': the outline rail is shown (the user's choice,
 *   remembered)
 * @property {boolean|null} railOpen the outline rail shown / hidden for this page by the ≡ button or the
 *   palette, over what railMode (and `rail`) say; null: follow them
 * @property {boolean} drawer thread drawer open (narrow) / thread panel visible (wide)
 * @property {boolean} sidebar wide layout: right panel shown
 * @property {boolean} panelAuto the doc opened without the thread panel only because it had no threads or drafts
 *   (Settings has it open by default): the first thread or draft that arrives opens it, and so does Changes (its list
 *   is in the side panel); the reviewer toggling the panel ends that
 * @property {number|null} panelWidth wide layout: the right panel's width the reviewer dragged it to (px, remembered);
 *   null: the layout's width
 * @property {boolean} nav narrow: outline drawer open
 * @property {Prefs} prefs
 * @property {Dialog|null} dialog
 * @property {SettingsSection} settingsSection the section Settings shows (it opens on General unless asked otherwise)
 * @property {{ src: string, alt: string }|null} lightbox the image shown full size (dialog 'image')
 * @property {{ src: string, name: string, threadId: string, path: string }|null} preview an agent's HTML attachment
 *   shown large (dialog 'preview'), in the same sandboxed frame as its card
 * @property {{ body: string, verdict: string|null, markFinal: boolean|null, resolveAddressed: boolean }|null} submitForm
 *   what the reviewer entered in the Submit dialog; kept when the dialog closes, cleared by a successful submit
 *   (markFinal null: the dialog's default, model.js approveReady)
 * @property {string[]} busyThreads threads with an action request in flight (Apply / Accept / Resolve / Reopen / Move)
 * @property {Array<{ id: number, text: string, tone: string, actions: Array<{ label: string, run: () => void }> }>} toasts
 * @property {{ connected: boolean, outline: any[], features: any, externalsFailed: string[],
 *   pageErrors: { count: number, last: string|null, resourcesFailed: string[] }, positions: any|null,
 *   selection: any|null, title: string, lost: boolean }} guest  lost: the doc iframe loaded a page without a
 *   guest (the doc navigated away, e.g. a link in a browser without the Navigation API)
 * @property {number|null} newHead a version that arrived while the user could not be switched
 * @property {number|null} unseenVersion version announced in the tab title until the user looks at it
 * @property {{ from: number, to: number }|null} sourceSel selected lines in Source mode
 * @property {'unified'|'split'} sourceLayout
 * @property {boolean} sourceDiff show the diff against the base in Source mode
 * @property {'inline'|'split'} compareLayout Changes mode: the changes drawn over the newer version (inline), or the
 *   older version beside it (split: side by side, scrolled together; wide layouts only). Remembered per browser
 * @property {{ from: Mode, sidebar: boolean, railOpen: boolean|null }|null} compareFocus while side by side is shown
 *   (actions.js splitShown): the doc area is the two versions' (the thread panel and the outline rail are hidden on
 *   the way in, the reviewer can reopen them); `from` is the mode before it (where Done goes back to), `sidebar` /
 *   `railOpen` what to put back on the way out
 * @property {boolean} baseConnected side by side: the older version's frame has its guest
 * @property {any|null} basePositions side by side: the older version's last `positions` (the tops and ends of its
 *   changes and headings, its scroll offset): the scroll sync lines the versions up on them, the links between the
 *   frames are drawn from them
 * @property {'changes'|'threads'} sidePane which list the side panel shows in Changes mode
 * @property {number} frameNonce bump to reload the doc iframe
 * @property {boolean} recording the working-copy banner shows its "Record as my revision" form
 * @property {number} seenRev bumped when the "seen" marks of the shown comparison change (kept in localStorage)
 * @property {{ version: string|null, uiPort: string, contentPort: string }|null} about Settings > About: the
 *   daemon's version (GET /api/health), loaded when Settings opens
 */

/** @returns {Prefs} */
export function readPrefs() {
  return {
    railMode: readPref('railMode', ['auto', 'always', 'never'], 'auto'),
    // The same key the panel's open / closed state was remembered under before it became a setting.
    panelOpen: readPref('sidebar', ['1', '0'], '1') === '1',
    singleKeys: readPref('singleKeys', ['1', '0'], '1') === '1',
    onNewVersion: readPref('onNewVersion', ['latest', 'toast', 'changes'], 'latest'),
    confirmSendNow: readPref('confirmSendNow', ['1', '0'], '0') === '1',
    defaultVerdict: readPref('defaultVerdict', ['comment', 'changes_requested'], 'comment'),
    openIn: readPref('openIn', ['review', 'read', 'auto'], 'review'),
    sendMode: readPref('sendMode', ['now', 'batch'], 'now'),
    editMode: readPref('editMode', ['auto', 'now', 'batch'], 'auto'),
  };
}

/** @returns {UiState} */
export function initialState() {
  const prefs = readPrefs();
  return {
    route: { view: 'home' },
    conn: 'ok',
    home: { docs: null, error: null },
    ds: null,
    loadError: null,
    version: null,
    followHead: true,
    mode: 'review',
    base: null,
    baseKind: 'last',
    filter: 'mine',
    filterPinned: false,
    focusedId: null,
    activeHunk: null,
    targets: null,
    changes: null,
    changesError: null,
    composer: null,
    reply: null,
    decision: null,
    theme: readPref('theme', ['system', 'light', 'dark'], 'system'),
    hidden: false,
    tool: 'select',
    screenSnip: { running: false, supported: true },
    narrow: false,
    medium: false,
    roomy: false,
    rail: readPref('rail', ['1', '0'], '0') === '1',
    railOpen: null,
    drawer: false,
    sidebar: prefs.panelOpen,
    panelAuto: false,
    panelWidth: readPanelWidth(),
    nav: false,
    prefs,
    dialog: null,
    settingsSection: 'general',
    lightbox: null,
    preview: null,
    submitForm: null,
    busyThreads: [],
    toasts: [],
    guest: {
      connected: false,
      outline: [],
      features: {},
      externalsFailed: [],
      pageErrors: { count: 0, last: null, resourcesFailed: [] },
      positions: null,
      selection: null,
      title: '',
      lost: false,
    },
    newHead: null,
    unseenVersion: null,
    sourceSel: null,
    sourceLayout: readPref('sourceLayout', ['unified', 'split'], 'unified'),
    sourceDiff: true,
    compareLayout: readPref('compareLayout', ['inline', 'split'], 'inline'),
    compareFocus: null,
    baseConnected: false,
    basePositions: null,
    sidePane: 'changes',
    frameNonce: 0,
    recording: false,
    seenRev: 0,
    about: null,
  };
}

/**
 * A localStorage-backed preference (per viewer convenience only; storage may be unavailable).
 * @template {string} T
 * @param {string} name
 * @param {T[]} allowed
 * @param {T} fallback
 * @returns {T}
 */
export function readPref(name, allowed, fallback) {
  try {
    const v = /** @type {T} */ (localStorage.getItem(`suiko.${name}`));
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/** The remembered width of the right panel (setPanelWidth), or null. @returns {number|null} */
function readPanelWidth() {
  try {
    const n = Number(localStorage.getItem('suiko.panelWidth'));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** @param {string} name @param {string} value */
export function writePref(name, value) {
  try {
    localStorage.setItem(`suiko.${name}`, value);
  } catch {
    /* storage unavailable: the preference lasts for this page only */
  }
}

/**
 * @template S
 * @param {S} initial
 */
export function createStore(initial) {
  let state = initial;
  /** @type {Set<() => void>} */
  const subs = new Set();
  let queued = false;

  function flush() {
    queued = false;
    for (const fn of [...subs]) {
      try {
        fn();
      } catch (err) {
        console.error('suiko: store subscriber failed', err);
      }
    }
  }

  return {
    /** @returns {S} */
    get: () => state,
    /**
     * Shallow-merges a patch (or the patch returned by `fn(state)`) into the state.
     * @param {Partial<S> | ((s: S) => Partial<S> | null | undefined)} patch
     */
    set(patch) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      if (!p) return;
      let changed = false;
      for (const k of Object.keys(p)) {
        if (!Object.is(/** @type {any} */ (state)[k], /** @type {any} */ (p)[k])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...p };
      if (!queued) {
        queued = true;
        queueMicrotask(flush);
      }
    },
    /** @param {() => void} fn @returns {() => void} */
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export const store = createStore(initialState());

/**
 * Shallow equality for selector results: identical values, or arrays / plain objects whose entries are identical.
 * @param {any} a
 * @param {any} b
 */
export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

/**
 * Subscribes a component to a slice of the store.
 * @template T
 * @param {(s: UiState) => T} selector
 * @returns {T}
 */
export function useStore(selector) {
  const [, force] = useReducer((n) => n + 1, 0);
  const selRef = useRef(selector);
  selRef.current = selector;
  const value = selector(store.get());
  const valRef = useRef(value);
  valRef.current = value;
  // Subscribe in a layout effect and re-check right away: an update that lands between this render and the
  // subscription (e.g. a fast API response for a component that just mounted) would otherwise be lost.
  useLayoutEffect(() => {
    const check = () => {
      const next = selRef.current(store.get());
      if (!shallowEqual(next, valRef.current)) force(undefined);
    };
    const unsubscribe = store.subscribe(check);
    check();
    return unsubscribe;
  }, []);
  return value;
}
