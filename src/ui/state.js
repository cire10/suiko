// @ts-check
// The UI store: one plain state object, shallow-merged updates, and a Preact hook that re-renders a component
// only when the slice it selects changes (shallow comparison).
//
// Everything the UI shows comes from here: the DocState fetched from the daemon, the selected version / mode /
// base / filter, the focused thread, the composer and reply drafts being edited, the guest's connection state,
// dialogs (one at a time: Submit, the command palette, Settings, keyboard shortcuts, an image), toasts, and the
// reviewer's per-browser preferences (Settings; localStorage through readPref / writePref, which tolerate storage
// being unavailable). Server data is never mutated in place: refetches replace it.
//
// Notifications are batched in a microtask, so a burst of `set` calls causes one render pass.

import { useLayoutEffect, useReducer, useRef } from 'preact-htm';

/** @typedef {'read'|'review'|'changes'|'source'|'history'} Mode  read: the latest version, nothing drawn over it */
/** @typedef {'open'|'needs'|'verify'|'drafts'|'resolved'|'outdated'|'all'} Filter */
/** @typedef {'system'|'light'|'dark'} Theme */
/** @typedef {'submit'|'help'|'image'|'palette'|'settings'} Dialog  one at a time: opening one closes the other */

/**
 * Per-browser preferences (Settings, localStorage through readPref / writePref; the theme is `theme`).
 * @typedef {object} Prefs
 * @property {'auto'|'always'|'never'} railMode the outline rail: auto (beside the doc at >= 1200 px, behind the menu
 *   button at 900-1199 px unless opened there), always (beside the doc at >= 900 px), never (behind the menu button)
 * @property {boolean} panelOpen the thread panel is shown when a doc opens (\\ still toggles it)
 * @property {boolean} singleKeys single-character shortcuts (c, j, b, 1, ?, ...) are on, in the UI and in the doc
 * @property {'toast'|'changes'} onNewVersion when the agent records a version: a toast, or switch to Changes
 *   (never while a composer, a reply, a dialog or a capture tool is open)
 * @property {boolean} confirmSendNow Send now asks for confirmation first
 * @property {'comment'|'changes_requested'} defaultVerdict the Submit dialog's verdict when nothing is blocking
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
 * @property {string|null} [createdDraftId] draft this composer already created (a Send now whose review request
 *   failed): a retry saves and sends that draft instead of creating another
 * @property {boolean} busy
 * @property {string|null} error
 * @property {boolean} [confirmSend] "Ask before Send now" is showing its confirmation
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
 * @property {Filter} filter
 * @property {string|null} focusedId thread or draft id
 * @property {string|null} activeHunk
 * @property {{ threads: any[], locks: any[], drafts: any[], outline: any[] } | null} targets
 * @property {any|null} changes Changes for base -> version
 * @property {string|null} changesError
 * @property {Composer|null} composer
 * @property {{ threadId: string, body: string, reopen: boolean, draftId: string|null, busy: boolean } | null} reply
 * @property {Theme} theme
 * @property {boolean} hidden annotations hidden (clean read)
 * @property {'select'|'pick'|'snip'} tool select text / pick an element (e) / snip an area of the doc (b)
 * @property {{ running: boolean, supported: boolean }} screenSnip the macOS region picker run by the daemon (B):
 *   running while it waits for the reviewer; supported turns false once the daemon answered 501 (not macOS)
 * @property {boolean} narrow viewport below 900 px
 * @property {boolean} medium viewport 900-1199 px: the outline / history rail is collapsed unless `rail`
 * @property {boolean} rail medium layout with railMode 'auto': the outline / history rail is shown (the user's
 *   choice, remembered)
 * @property {boolean|null} railOpen the outline rail shown / hidden for this page by the menu button or the
 *   palette, over what railMode (and `rail`) say; null: follow them
 * @property {boolean} drawer thread drawer open (narrow) / thread panel visible (wide)
 * @property {boolean} sidebar wide layout: right panel shown
 * @property {boolean} nav narrow: outline drawer open
 * @property {Prefs} prefs
 * @property {Dialog|null} dialog
 * @property {{ src: string, alt: string }|null} lightbox the image shown full size (dialog 'image')
 * @property {{ body: string, verdict: string|null, markFinal: boolean, resolveAddressed: boolean }|null} submitForm
 *   what the reviewer entered in the Submit dialog; kept when the dialog closes, cleared by a successful submit
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
 * @property {boolean} baseConnected side by side: the older version's frame has its guest
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
    onNewVersion: readPref('onNewVersion', ['toast', 'changes'], 'toast'),
    confirmSendNow: readPref('confirmSendNow', ['1', '0'], '0') === '1',
    defaultVerdict: readPref('defaultVerdict', ['comment', 'changes_requested'], 'comment'),
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
    filter: 'open',
    focusedId: null,
    activeHunk: null,
    targets: null,
    changes: null,
    changesError: null,
    composer: null,
    reply: null,
    theme: readPref('theme', ['system', 'light', 'dark'], 'system'),
    hidden: false,
    tool: 'select',
    screenSnip: { running: false, supported: true },
    narrow: false,
    medium: false,
    rail: readPref('rail', ['1', '0'], '0') === '1',
    railOpen: null,
    drawer: false,
    sidebar: prefs.panelOpen,
    nav: false,
    prefs,
    dialog: null,
    lightbox: null,
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
    baseConnected: false,
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
