// @ts-check
// The UI store: one plain state object, shallow-merged updates, and a Preact hook that re-renders a component
// only when the slice it selects changes (shallow comparison).
//
// Everything the UI shows comes from here: the DocState fetched from the daemon, the selected version / mode /
// base / filter, the focused thread, the composer and reply drafts being edited, the guest's connection state,
// dialogs and toasts. Server data is never mutated in place: refetches replace it.
//
// Notifications are batched in a microtask, so a burst of `set` calls causes one render pass.

import { useLayoutEffect, useReducer, useRef } from 'preact-htm';

/** @typedef {'review'|'changes'|'source'|'history'} Mode */
/** @typedef {'open'|'needs'|'verify'|'drafts'|'resolved'|'outdated'|'all'} Filter */
/** @typedef {'system'|'light'|'dark'} Theme */

/**
 * @typedef {object} Composer
 * @property {number} key unique per opened composer
 * @property {any} capture guest capture (amendments 3.3 shapes)
 * @property {number|null} version version the capture was made on
 * @property {'comment'|'question'|'suggestion'|'agree'} type
 * @property {'blocking'|'normal'|'nit'} severity
 * @property {string} body
 * @property {string|null} crop PNG data URL from the guest (region / element crops)
 * @property {string|null} [cropPath] attachment path of the uploaded crop
 * @property {Array<{ path: string, preview: string }>} attachments uploaded images (preview = data URL)
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
 * @property {'select'|'pick'} tool
 * @property {boolean} narrow viewport below 900 px
 * @property {boolean} medium viewport 900-1199 px: the outline / history rail is collapsed unless `rail`
 * @property {boolean} rail medium layout: the outline / history rail is shown (the user's choice, remembered)
 * @property {boolean} drawer thread drawer open (narrow) / thread panel visible (wide)
 * @property {boolean} sidebar wide layout: right panel shown
 * @property {boolean} nav narrow: outline drawer open
 * @property {'submit'|'help'|null} dialog
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
 * @property {'changes'|'threads'} sidePane which list the side panel shows in Changes mode
 * @property {number} frameNonce bump to reload the doc iframe
 */

/** @returns {UiState} */
export function initialState() {
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
    narrow: false,
    medium: false,
    rail: readPref('rail', ['1', '0'], '0') === '1',
    drawer: false,
    sidebar: readPref('sidebar', ['1', '0'], '1') === '1',
    nav: false,
    dialog: null,
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
    sidePane: 'changes',
    frameNonce: 0,
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
    const v = /** @type {T} */ (localStorage.getItem(`specreview.${name}`));
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/** @param {string} name @param {string} value */
export function writePref(name, value) {
  try {
    localStorage.setItem(`specreview.${name}`, value);
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
        console.error('specreview: store subscriber failed', err);
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
