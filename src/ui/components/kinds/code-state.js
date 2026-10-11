// @ts-check
// Shared state of the code-review components (CodeReviewView, FileTree, CodeSide): the file filter, the line
// selection, the active file, and caches of the code routes (D/files, D/files/diff, D/files/source).
//
// A round's files never change once recorded, so responses are cached by key (each prefixed with 'ws/doc|'):
//   list    'v<N>' | '<from>..<to>'                      D/files
//   diff    '<listKey>|<path>'                           D/files/diff
//   source  'v<N>|<side>|<path>'                         D/files/source
// Thread placement is computed from the DocState, never from these responses, so new threads show at once.
// Everything (caches, selection, filter) is dropped when another doc is opened (syncCodeDoc).

import { useLayoutEffect, useReducer, useRef } from 'preact-htm';
import { docApi } from '../../api.js';
import { errorText } from '../../actions.js';
import { createStore, shallowEqual, store } from '../../state.js';

/**
 * @typedef {{ status: 'loading'|'ok'|'error', data: any, error: string|null }} Entry
 * @typedef {{ docKey: string, filter: string, sel: import('./code-model.js').LineSel|null, activePath: string|null,
 *   lists: Record<string, Entry>, diffs: Record<string, Entry>, sources: Record<string, Entry>,
 *   expanded: Record<string, true>, collapsed: Record<string, true>, showAll: Record<string, true>,
 *   reveal: { path: string, seq: number, hunk?: string|null, line?: { side: string, line: number }|null, id?: string|null }|null }} CodeState
 */

/** @returns {CodeState} */
const initial = () => ({
  docKey: '',
  filter: '',
  sel: null,
  activePath: null,
  lists: {},
  diffs: {},
  sources: {},
  expanded: {},
  collapsed: {},
  showAll: {},
  reveal: null,
});

export const codeStore = createStore(initial());

let revealSeq = 0;

/**
 * Subscribes a component to a slice of the code state (like useStore for the app store).
 * @template T
 * @param {(s: CodeState) => T} selector
 * @returns {T}
 */
export function useCode(selector) {
  const [, force] = useReducer((n) => n + 1, 0);
  const selRef = useRef(selector);
  selRef.current = selector;
  const value = selector(codeStore.get());
  const valRef = useRef(value);
  valRef.current = value;
  useLayoutEffect(() => {
    const check = () => {
      const next = selRef.current(codeStore.get());
      if (!shallowEqual(next, valRef.current)) force(undefined);
    };
    const unsubscribe = codeStore.subscribe(check);
    check();
    return unsubscribe;
  }, []);
  return value;
}

/** The doc of the page, `ws/doc`, or ''. */
function routeKey() {
  const r = /** @type {any} */ (store.get().route);
  return r?.view === 'doc' ? `${r.ws}/${r.doc}` : '';
}

/** Drops everything cached for another doc. Called by each code component on render. */
export function syncCodeDoc() {
  const key = routeKey();
  if (key && codeStore.get().docKey !== key) codeStore.set({ ...initial(), docKey: key });
  return key;
}

function api() {
  const r = /** @type {any} */ (store.get().route);
  return r?.view === 'doc' ? docApi(r.ws, r.doc) : null;
}

/**
 * Loads a cache entry once (a failed one again when `retry`).
 * @param {'lists'|'diffs'|'sources'} bucket @param {string} key @param {(c: ReturnType<typeof docApi>) => Promise<any>} fetcher
 * @param {{ retry?: boolean }} [opts]
 */
function load(bucket, key, fetcher, opts = {}) {
  const docKey = syncCodeDoc();
  const cur = codeStore.get()[bucket][key];
  if (cur && (cur.status !== 'error' || !opts.retry)) return;
  const c = api();
  if (!c) return;
  /** @param {Entry} entry */
  const put = (entry) => {
    if (codeStore.get().docKey !== docKey) return;
    codeStore.set((s) => ({ [bucket]: { ...s[bucket], [key]: entry } }));
  };
  put({ status: 'loading', data: null, error: null });
  fetcher(c).then((data) => put({ status: 'ok', data, error: null }), (err) => put({ status: 'error', data: null, error: errorText(err) }));
}

/** @param {number} v @param {number|null} [base] */
export const listKeyOf = (v, base = null) => `${routeKey()}|${base != null ? `${base}..${v}` : `v${v}`}`;

/**
 * The file list of a round (base null) or the interdiff list of base..v.
 * @param {number} v @param {number|null} base @param {{ retry?: boolean }} [opts]
 */
export function loadList(v, base, opts) {
  load('lists', listKeyOf(v, base), (c) => c.files(base != null ? { from: base, to: v } : { v }), opts);
}

/**
 * One file's display hunks (round v, or the interdiff base..v).
 * @param {number} v @param {number|null} base @param {string} path @param {{ retry?: boolean }} [opts]
 */
export function loadDiff(v, base, path, opts) {
  load('diffs', `${listKeyOf(v, base)}|${path}`, (c) => c.fileDiff(base != null ? { path, from: base, to: v } : { path, v }), opts);
}

/** @param {number} v @param {'new'|'old'} side @param {string} path */
export const sourceKeyOf = (v, side, path) => `${routeKey()}|v${v}|${side}|${path}`;

/** One side of one file (for the unchanged lines between hunks). @param {number} v @param {'new'|'old'} side @param {string} path */
export function loadSource(v, side, path) {
  load('sources', sourceKeyOf(v, side, path), (c) => c.fileSource(path, v, side), { retry: true });
}

/** @param {import('./code-model.js').LineSel|null} sel */
export function setSelection(sel) {
  codeStore.set({ sel });
}

/** @param {string} filter */
export function setFilter(filter) {
  codeStore.set({ filter });
}

/** @param {string|null} path */
export function setActivePath(path) {
  if (codeStore.get().activePath !== path) codeStore.set({ activePath: path });
}

/**
 * Asks the view to bring a file (and optionally a hunk, a line or an inline thread) into view.
 * @param {string} path @param {{ hunk?: string|null, line?: { side: string, line: number }|null, id?: string|null }} [opts]
 */
export function revealFile(path, opts = {}) {
  codeStore.set({ activePath: path, reveal: { path, seq: ++revealSeq, ...opts } });
}

/** @param {string} key diff key + '|' + gap id */
export function expandGap(key) {
  codeStore.set((s) => ({ expanded: { ...s.expanded, [key]: true } }));
}

/** @param {string} path */
export function toggleCollapsed(path) {
  codeStore.set((s) => {
    const next = { ...s.collapsed };
    if (next[path]) delete next[path];
    else next[path] = true;
    return { collapsed: next };
  });
}

/** @param {string} diffKey */
export function showAllRows(diffKey) {
  codeStore.set((s) => ({ showAll: { ...s.showAll, [diffKey]: true } }));
}
