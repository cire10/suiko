// @ts-check
// The UI controller: every user intent and every server / guest event goes through a function here. Components
// read the store and call these functions; nothing else talks to the API, the event stream or the guest.
//
// Rules this module enforces:
// - Guest messages never mutate server state (amendments 7). `action` only opens a composer, and `activate` / `key`
//   only move focus or toggle UI. Every API mutation starts from a click or key press in the UI.
// - The UI never switches versions or reloads the doc while a composer, a reply or the Submit dialog is open
//   (design 11.7). A newer version then only raises a banner, and Approve is refused until the reviewer has looked
//   at the newest version.
// - Typed input is never dropped silently: replacing or closing a composer / reply that holds input is refused or
//   offers Undo, and Esc pressed inside the doc never discards it.
// - Requests that finish after the user moved on (another doc / version) are dropped.
// - Snips: `b` snips an area of the doc (the guest draws the box and posts `action` with a SnipCapture and its crop,
//   which opens the composer like any capture); Shift+B asks the daemon to run the macOS region picker and attaches
//   the screenshot to a composer. Neither sends anything: the comment goes out on Add to review / Send now.
// - Dialogs are exclusive (openDialog): the command palette, Settings, the keyboard shortcuts, Submit review and the
//   image viewer replace each other; what was typed in the Submit dialog lives in the store and survives that.
// - Preferences (setPref) apply at once and are remembered per browser; single-letter shortcuts are mirrored to the
//   guest (setPrefs, and init.prefs), so it stops acting on c / s / q / a / b itself when they are off.

import { MSG, SSE } from 'protocol';
import { api, docApi, onConnection, onReconnect, token } from './api.js';
import { guest } from './frame.js';
import {
  agentPrompt, anchorAt, anchorColumn, applyErrorText, backupHasInput, defaultBase, draftVersion, isComposerDirty,
  hasMode, isReplyDirty, kindCaps, numericVersion, panelItems, replyDraftsFor, staleApproveText, suggestionMode, versionNumbers,
} from './model.js';
import { EventStream } from './sse.js';
import { store, writePref } from './state.js';
import { copyText, debounce, docUrl, originOf } from './util.js';

/** @typedef {import('./state.js').UiState} UiState */
/** @typedef {import('./state.js').Mode} Mode */

/** @type {ReturnType<typeof docApi>|null} */
let client = null;
/** @type {((id: string | null) => void) | null} a kind view's focus handler (registerKindFocus) */
let kindFocus = null;
/** @type {(() => any) | null} a kind view's current selection as a capture (registerKindSelection) */
let kindSelection = null;
/** @type {EventStream|null} */
let stream = null;
let composerSeq = 0;
let toastSeq = 0;
/** @type {{ version: number|'live'|null, srid: number, offset: number, heading: string|null }|null} */
let lastScroll = null;
/** @type {typeof lastScroll} */
let pendingRestore = null;
/** @type {((k: any, fromGuest: boolean) => void)|null} */
let keyForwarder = null;
/** @type {any} */
let lastCancelled = null;
/** @type {any} */
let lastCancelledReply = null;
/** A thread / draft to focus in the doc once the guest shows the version it is on ("View on vN"). */
/** @type {{ id: string, version: number }|null} */
let pendingFocus = null;
/** The "draft written on vN" toast on screen (one at a time). */
let draftToast = 0;
/** The version the doc iframe was last navigated to (its guest shows that version once connected). */
/** @type {number|'live'|null} */
let frameVersion = null;
/** The composer opened last: its key, when, and what for (see DUPLICATE_OPEN_MS). */
let lastOpen = { key: 0, at: 0, sig: '' };
/**
 * A new version to show in Changes once a refresh brought it in (Settings: "Switch to Changes automatically"), with
 * the text of its announcement.
 * @type {{ v: number, text: string, until: number }|null}
 */
let autoChanges = null;
/** The doc list request in flight (loadDocList). */
/** @type {Promise<void>|null} */
let docListLoading = null;

/**
 * A second request to open the same composer (same capture and type) within this window is a duplicate: the guest
 * posts `action` for c / s / q / a typed with a selection in the doc, and a guest that also forwards the key (or a
 * toolbar click racing a key) must not open the composer twice (which would reset what the user started).
 */
export const DUPLICATE_OPEN_MS = 300;

const guestInitial = () => ({
  connected: false,
  outline: [],
  features: {},
  externalsFailed: [],
  pageErrors: { count: 0, last: null, resourcesFailed: [] },
  positions: null,
  selection: null,
  title: '',
  lost: false,
});

/** @param {Partial<UiState> | ((s: UiState) => Partial<UiState> | null | undefined)} p */
const set = (p) => store.set(p);
const get = () => store.get();

// ============================================================================================ routing

/** @param {string} pathname */
export function parseRoute(pathname) {
  const m = /^\/d\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (m) {
    try {
      return /** @type {const} */ ({ view: 'doc', ws: decodeURIComponent(m[1]), doc: decodeURIComponent(m[2]) });
    } catch {
      return /** @type {const} */ ({ view: 'home' });
    }
  }
  return /** @type {const} */ ({ view: 'home' });
}

/** Client-side navigation (the daemon serves index.html for / and /d/:ws/:doc). @param {string} path */
export function navigate(path) {
  if (location.pathname + location.search !== path) history.pushState({}, '', path);
  applyRoute();
}

export function applyRoute() {
  const r = parseRoute(location.pathname);
  if (r.view === 'doc') openDoc(r.ws, r.doc);
  else openHome();
}

/** @param {string} ws @param {string} doc */
export function docPath(ws, doc) {
  return `/d/${encodeURIComponent(ws)}/${encodeURIComponent(doc)}`;
}

// ============================================================================================ home

export async function openHome() {
  stopStream();
  client = null;
  guest.detach();
  pendingFocus = null;
  set({
    route: { view: 'home' }, ds: null, composer: null, reply: null, dialog: null, submitForm: null, busyThreads: [], targets: null, changes: null,
  });
  document.title = 'SpecReview';
  updateFavicon(false);
  stream = new EventStream({
    onEvent: (name) => {
      if (name !== SSE.PING) reloadHomeSoon();
    },
    onOpen: () => reloadHomeSoon(),
  });
  stream.start();
  await loadHome();
}

export async function loadHome() {
  try {
    const docs = await api.docs();
    if (get().route.view !== 'home') return;
    set({ home: { docs: Array.isArray(docs) ? docs : [], error: null } });
  } catch (err) {
    set((s) => ({ home: { docs: s.home.docs, error: errorText(err) } }));
  }
}

const reloadHomeSoon = debounce(() => {
  if (get().route.view === 'home') loadHome();
}, 300);

// ============================================================================================ doc lifecycle

/** @param {string} ws @param {string} doc */
export async function openDoc(ws, doc) {
  const cur = get().route;
  if (cur.view === 'doc' && cur.ws === ws && cur.doc === doc && get().ds) return;
  stopStream();
  guest.reset();
  const c = docApi(ws, doc);
  client = c;
  lastScroll = null;
  pendingRestore = null;
  pendingFocus = null;
  set({
    route: { view: 'doc', ws, doc },
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
    tool: 'select',
    drawer: false,
    sidebar: get().prefs.panelOpen,
    nav: false,
    dialog: null,
    submitForm: null,
    busyThreads: [],
    newHead: null,
    unseenVersion: null,
    sourceSel: null,
    sidePane: 'changes',
    recording: false,
    guest: guestInitial(),
  });
  autoChanges = null;
  /** @type {any} */
  let ds;
  try {
    ds = await c.state();
  } catch (err) {
    if (client === c) set({ loadError: errorText(err) });
    return;
  }
  if (client !== c) return;
  const head = Number(ds?.doc?.head) || 1;
  const last = Number(ds?.doc?.lastReviewedVersion);
  // "Since my last review" is the entry point when the agent has revised since (design 8.8).
  const mode = last >= 1 && head > last ? 'changes' : 'review';
  set({ ds, version: head, mode, base: defaultBase(ds, head, 'last'), baseKind: 'last' });
  updateTitle();
  stream = new EventStream({ ws, doc, onEvent: onDocEvent, onOpen: () => refresh() });
  stream.start();
  await Promise.all([loadTargets(), loadChanges()]);
  offerComposerBackup();
}

function stopStream() {
  stream?.stop();
  stream = null;
}

/** Refetches DocState (debounced) and everything that depends on it. */
export const refresh = debounce(() => {
  refreshNow();
}, 120);

export async function refreshNow() {
  const c = client;
  if (!c) return;
  /** @type {any} */
  let ds;
  try {
    ds = await c.state();
  } catch (err) {
    if (!(/** @type {any} */ (err).offline)) console.warn('specreview: refresh failed', err);
    return;
  }
  if (client !== c) return;
  const s = get();
  const prevHead = Number(s.ds?.doc?.head) || 0;
  const head = Number(ds?.doc?.head) || 1;
  /** @type {Partial<UiState>} */
  const patch = { ds };
  let versionChanged = false;
  if (head > prevHead && prevHead > 0) {
    const onHead = s.version === prevHead && s.followHead;
    if (onHead && !holdsView(s)) {
      patch.version = head;
      patch.base = defaultBase(ds, head, s.baseKind === 'custom' ? 'last' : s.baseKind);
      patch.newHead = null;
      versionChanged = true;
    } else if (s.version !== 'live') {
      patch.newHead = head;
    }
  }
  if (s.version === 'live' && !ds?.working?.dirty) {
    // The working copy was recorded (or reverted): the live preview is the head again.
    patch.version = head;
    patch.base = defaultBase(ds, head, 'last');
    versionChanged = true;
  }
  if (versionChanged) {
    patch.targets = null;
    patch.tool = 'select';
    patch.sourceSel = null;
  }
  set(patch);
  updateTitle();
  await Promise.all([loadTargets(), loadChanges()]);
  flushAutoChanges();
}

/**
 * True while something on screen refers to the shown version, so a new version must not replace it: a composer, a
 * reply, or the Submit dialog (whose Approve marks the version the reviewer is looking at).
 * @param {UiState} s
 */
function holdsView(s) {
  return !!(s.composer || s.reply || s.dialog === 'submit');
}

/**
 * Whether the UI may switch to Changes on its own for a new version (Settings): never while the reviewer is in the
 * middle of something: a composer, a reply, any dialog (the palette included), the record form, or pick / snip.
 * @param {UiState} s
 */
function canAutoSwitch(s) {
  return !!s.ds && !holdsView(s) && !s.dialog && !s.recording && s.tool === 'select' && !s.screenSnip.running;
}

/**
 * Shows the announced version in Changes once the refresh that brings it in is done (see announceVersion). When the
 * reviewer started something meanwhile (a comment, a dialog), or the version never arrives, the usual toast says it
 * instead.
 */
function flushAutoChanges() {
  const p = autoChanges;
  if (!p) return;
  const s = get();
  if (!versionNumbers(s.ds).includes(p.v)) {
    if (Date.now() > p.until) {
      autoChanges = null;
      versionToast(p.v, p.text);
    }
    return;
  }
  autoChanges = null;
  if (!canAutoSwitch(s)) {
    versionToast(p.v, p.text);
    return;
  }
  reviewChanges(p.v);
  toast(`${p.text}. Showing what changed.`, {
    tone: 'info',
    timeout: 8000,
    actions: [{ label: 'Verify', run: () => openVerify(p.v) }],
  });
}

/** @param {string} name @param {any} data */
function onDocEvent(name, data) {
  switch (name) {
    case SSE.PING:
      return;
    case SSE.PRESENCE:
      if (Array.isArray(data?.waiters)) {
        set((s) => (s.ds ? { ds: { ...s.ds, waiters: data.waiters } } : null));
      } else {
        refresh();
      }
      return;
    case SSE.WORKING_CHANGED:
      set((s) => (s.ds ? {
        ds: { ...s.ds, working: {
          ...s.ds.working, dirty: !!data?.dirty, missing: !!data?.missing, sha256: data?.sha256 ?? s.ds.working?.sha256,
          // code reviews: the reviewed files changed since the round (the code poller's working.changed)
          ...(Array.isArray(data?.changedFiles) ? { changedFiles: data.changedFiles } : {}),
        } },
        // Nothing left to record: the "Record as my revision" form closes with the banner.
        recording: data?.dirty && !data?.missing ? s.recording : false,
      } : null));
      if (get().version === 'live') {
        if (data?.dirty) reloadFrame();
        else refresh();
      }
      return;
    case SSE.VERSION_CREATED:
      announceVersion(data);
      refresh();
      return;
    case SSE.SESSION_CLOSED:
      toast('The review session was closed.', { tone: 'muted' });
      refresh();
      return;
    case SSE.DOC_APPROVED:
      toast(`Approved${data?.v ? ` at v${data.v}` : ''}.`, { tone: 'ok' });
      refresh();
      return;
    case SSE.DRAFTS_CHANGED:
      if (data?.source === 'snip') announceSnipDraft(data);
      else refresh();
      return;
    default:
      refresh();
  }
}

/**
 * `specreview snip` (from a terminal or a macOS Shortcut) added a screenshot draft: a toast says so, with [Edit] to
 * focus the draft card and write about it. When the draft is already gone (`snip --send` submitted it), the toast
 * only says it arrived.
 * @param {any} data {source: 'snip', draft: 'dN'}
 */
async function announceSnipDraft(data) {
  const id = typeof data?.draft === 'string' && /^d\d+$/.test(data.draft) ? data.draft : null;
  await refreshNow();
  const there = !!id && (get().ds?.drafts?.items || []).some((/** @type {any} */ d) => d.id === id);
  toast('Screenshot added from your Mac', {
    tone: 'info',
    timeout: there ? 15000 : 6000,
    actions: there && id ? [{ label: 'Edit', run: () => editSnipDraft(id) }] : [],
  });
}

/** The [Edit] of a "Screenshot added" toast: focuses the draft card and opens the draft in the composer. @param {string} id */
function editSnipDraft(id) {
  if (!(get().ds?.drafts?.items || []).some((/** @type {any} */ d) => d.id === id)) {
    toast(`${id} is no longer a draft (it was sent or deleted).`, { tone: 'muted', timeout: 3000 });
    return;
  }
  focusItem(id);
  if (!get().composer) editDraft(id);
}

/** Toast + tab-title badge for a new version (design 11.7). @param {any} data */
function announceVersion(data) {
  const v = Number(data?.v);
  if (!Number.isFinite(v)) return;
  const counts = data?.counts || {};
  const n = (/** @type {string} */ k) => Number(counts[k]) || 0;
  const tally = [];
  if (n('addressed')) tally.push(`${n('addressed')} addressed`);
  if (n('needs_input') || n('needsInput')) tally.push(`${n('needs_input') || n('needsInput')} needs you`);
  const answers = data?.respondsTo || data?.review;
  const tail = [answers ? `answers ${answers}` : '', tally.length ? (answers ? `(${tally.join(', ')})` : tally.join(', ')) : '']
    .filter(Boolean).join(' ');
  const author = typeof data?.author === 'string' ? data.author.replace(/^\w+:/, '') : data?.author?.name;
  set({ unseenVersion: v });
  updateTitle();
  const text = `v${v} ready${author ? ` from ${author}` : ''}${tail ? ` - ${tail}` : ''}`;
  if (get().prefs.onNewVersion === 'changes' && canAutoSwitch(get())) {
    // Settings: "Switch to Changes automatically". The refresh that follows this event brings the version in.
    autoChanges = { v, text, until: Date.now() + 10000 };
    return;
  }
  versionToast(v, text);
}

/** The "vN ready" toast, with Review changes / Verify. @param {number} v @param {string} text */
function versionToast(v, text) {
  toast(text, {
    tone: 'info',
    timeout: 15000,
    actions: [
      { label: 'Review changes', run: () => reviewChanges(v) },
      { label: 'Verify', run: () => openVerify(v) },
    ],
  });
}

/** Clears the "(vN)" tab badge once the user interacts with the page. */
export function markSeen() {
  if (get().unseenVersion == null || document.visibilityState !== 'visible') return;
  set({ unseenVersion: null });
  updateTitle();
}

/** @param {number} v */
export function reviewChanges(v) {
  const s = get();
  if (!s.ds) return;
  set({ unseenVersion: null });
  if (s.version !== v && !switchVersion(v)) return;
  setMode('changes');
  updateTitle();
}

/** @param {number} v */
export function openVerify(v) {
  const s = get();
  if (s.version !== v && s.ds && !switchVersion(v)) return;
  set({ filter: 'verify', unseenVersion: null, sidePane: 'threads', drawer: get().narrow ? true : get().drawer, sidebar: true });
  if (get().mode !== 'review') setMode('review');
  updateTitle();
}

export function updateTitle() {
  const s = get();
  const title = s.ds?.doc?.title || s.ds?.doc?.id || 'SpecReview';
  document.title = `${s.unseenVersion != null ? `(v${s.unseenVersion}) ` : ''}${title} · SpecReview`;
  updateFavicon(s.unseenVersion != null);
}

/** @param {boolean} dot */
function updateFavicon(dot) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="3" y="3" width="22" height="26" rx="4" fill="#2f6fed"/>`
    + `<path d="M8 11h12M8 16h12M8 21h8" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>`
    + (dot ? '<circle cx="25" cy="8" r="6" fill="#e5534b" stroke="#fff" stroke-width="2"/>' : '') + '</svg>';
  /** @type {HTMLLinkElement|null} */
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.append(link);
  }
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// ============================================================================================ targets & changes

/** Targets of the selected version, then pushed to the guest. */
export async function loadTargets() {
  const c = client;
  const s = get();
  if (!c || !s.ds || s.version == null) return;
  const version = s.version;
  try {
    const t = await c.targets(version);
    if (client !== c || get().version !== version) return;
    set({
      targets: {
        threads: Array.isArray(t?.threads) ? t.threads : [],
        locks: Array.isArray(t?.locks) ? t.locks : [],
        drafts: Array.isArray(t?.drafts) ? t.drafts : [],
        outline: Array.isArray(t?.outline) ? t.outline : [],
      },
    });
    pushTargets();
    flushPendingFocus();
  } catch (err) {
    if (!(/** @type {any} */ (err).offline)) console.warn('specreview: cannot load targets', err);
  }
}

function pushTargets() {
  const t = get().targets;
  if (!t) return;
  guest.send(MSG.SET_TARGETS, { targets: t.threads, locks: t.locks, drafts: t.drafts });
}

/** @param {UiState} s @param {string} id */
function isPainted(s, id) {
  const t = s.targets;
  return !!t && [t.threads, t.drafts, t.locks].some((list) => list.some((/** @type {any} */ x) => x.id === id));
}

/** Focuses the item of a "View on vN" once the guest shows that version and has its targets. */
function flushPendingFocus() {
  const p = pendingFocus;
  const s = get();
  if (!p || s.version !== p.version || frameVersion !== p.version || !s.guest.connected || !s.targets) return;
  pendingFocus = null;
  if (isPainted(s, p.id)) guest.send(MSG.FOCUS, { id: p.id });
}

/** Changes base -> selected version (used by Changes mode, outline badges and Source diff). */
export async function loadChanges() {
  const c = client;
  const s = get();
  if (!c || !s.ds || s.version == null) return;
  const { base, version } = s;
  if (base == null) {
    set({ changes: null, changesError: null });
    pushChanges();
    return;
  }
  try {
    const changes = await c.diff(base, version);
    const now = get();
    if (client !== c || now.version !== version || now.base !== base) return;
    set({ changes, changesError: null });
  } catch (err) {
    if (client !== c) return;
    set({ changes: null, changesError: errorText(err) });
  }
  pushChanges();
}

function pushChanges() {
  const s = get();
  guest.send(MSG.SET_CHANGES, { changes: s.mode === 'changes' ? s.changes : null });
}

/** @param {UiState} s */
function guestMode(s) {
  if (s.version === 'live') return 'readonly';
  return s.mode === 'changes' ? 'changes' : 'review';
}

function sendInit() {
  const s = get();
  const t = s.targets;
  guest.send(MSG.INIT, {
    mode: guestMode(s),
    theme: s.theme,
    targets: t?.threads || [],
    locks: t?.locks || [],
    drafts: t?.drafts || [],
    changes: s.mode === 'changes' ? s.changes : null,
    activeId: s.focusedId,
    hidden: s.hidden,
    prefs: { singleKeys: s.prefs.singleKeys },
  });
}

// ============================================================================================ the doc frame

/** URL of the doc iframe for the current selection (null until DocState is loaded). @param {UiState} s */
export function frameUrl(s) {
  if (!s.ds || s.version == null || !s.ds.contentBase) return null;
  return docUrl(s.ds.contentBase, s.version, s.ds.doc.path);
}

/** @param {UiState} s */
export function contentOrigin(s) {
  return s.ds?.contentBase ? originOf(s.ds.contentBase) : '';
}

/** Called by DocFrame right before it navigates the iframe. */
export function frameNavigating() {
  pendingRestore = lastScroll;
  frameVersion = get().version;
  set({ guest: guestInitial(), tool: 'select' });
}

export function reloadFrame() {
  set((s) => ({ frameNonce: s.frameNonce + 1 }));
}

/**
 * Called by DocFrame when the iframe loaded a page whose guest never said hello: the doc navigated away (the guest
 * cancels navigations where the Navigation API exists; elsewhere a link or a script can still leave). The old
 * channel is dead, so the doc is shown as disconnected and a banner offers the way back (reloadFrame).
 */
export function frameLost() {
  guest.reset();
  set((s) => ({ guest: { ...guestInitial(), title: s.guest.title, lost: true }, tool: 'select' }));
}

guest.setHandlers({
  // A hello is a page with its guest (also a late one after frameLost): the doc is back.
  onHello: (hello) => set((s) => ({ guest: { ...s.guest, connected: false, title: hello.title, lost: false } })),
  onMessage: onGuestMessage,
});

/** @param {string} type @param {any} d */
function onGuestMessage(type, d) {
  switch (type) {
    case MSG.READY: {
      const outline = Array.isArray(d.outline) ? d.outline.filter((/** @type {any} */ h) => h && Number.isFinite(h.srid))
        .map((/** @type {any} */ h) => ({ srid: h.srid, level: Number(h.level) || 1, text: String(h.text ?? ''), id: h.id ?? null })) : [];
      set((s) => ({
        guest: {
          ...s.guest,
          connected: true,
          outline,
          features: d.features && typeof d.features === 'object' ? d.features : {},
          externalsFailed: Array.isArray(d.externalsFailed) ? d.externalsFailed.map(String) : [],
        },
      }));
      sendInit();
      restoreScroll(outline);
      flushPendingFocus();
      return;
    }
    case MSG.SELECTION:
      set((s) => ({ guest: { ...s.guest, selection: d.capture && typeof d.capture === 'object' ? d.capture : null } }));
      return;
    case MSG.ACTION:
      if (d.capture && typeof d.capture === 'object') {
        openComposer({ capture: d.capture, action: String(d.action || 'comment'), crop: typeof d.crop === 'string' && d.crop.startsWith('data:image/') ? d.crop : null });
      }
      return;
    case MSG.POSITIONS:
      set((s) => ({ guest: { ...s.guest, positions: d } }));
      return;
    case MSG.ACTIVATE:
      if (d.id != null) activate(String(d.id));
      return;
    case MSG.KEY:
      keyForwarder?.(d, true);
      return;
    case MSG.SCROLL: {
      const srid = Number(d.topSrid);
      if (!Number.isFinite(srid)) return;
      const outline = get().guest.outline;
      let heading = null;
      for (const h of outline) if (h.srid <= srid) heading = h.text;
      lastScroll = { version: get().version, srid, offset: Number(d.offset) || 0, heading };
      return;
    }
    case MSG.PAGE_ERROR:
      set((s) => ({
        guest: {
          ...s.guest,
          pageErrors: {
            count: Number(d.count) || 0,
            last: d.last == null ? null : String(d.last),
            resourcesFailed: Array.isArray(d.resourcesFailed) ? d.resourcesFailed.map(String) : [],
          },
          externalsFailed: Array.isArray(d.externalsFailed) ? d.externalsFailed.map(String) : s.guest.externalsFailed,
        },
      }));
      return;
    case MSG.TOOL_CHANGED:
      // The guest left pick / snip mode itself (Esc, a finished pick or snip), or entered snip mode (b in the doc).
      set({ tool: d.tool === 'pick' || d.tool === 'snip' ? d.tool : 'select' });
      return;
    default:
  }
}

/** After a reload / version switch: back to the same element, else the same heading (design 11.7). @param {any[]} outline */
function restoreScroll(outline) {
  const r = pendingRestore;
  pendingRestore = null;
  if (!r) return;
  if (r.version === get().version) {
    guest.send(MSG.SCROLL_TO, { srid: r.srid, offset: r.offset });
    return;
  }
  const h = r.heading ? outline.find((x) => x.text === r.heading) : null;
  guest.send(MSG.SCROLL_TO, h ? { srid: h.srid } : { srid: r.srid });
}

/** @param {(k: any, fromGuest: boolean) => void} fn */
export function setKeyForwarder(fn) {
  keyForwarder = fn;
}

/** A highlight / pin / bar in the doc was clicked. @param {string} id */
export function activate(id) {
  const s = get();
  if (!s.ds) return;
  const isThread = (s.ds.threads || []).some((/** @type {any} */ t) => t.id === id);
  const isDraft = (s.ds.drafts?.items || []).some((/** @type {any} */ d) => d.id === id);
  if (isThread || isDraft) {
    focusItem(id, { fromDoc: true });
    return;
  }
  const lock = (s.ds.locks || []).find((/** @type {any} */ l) => l.id === id);
  if (lock) {
    toast(`${lock.id}: marked agreed${lock.note && lock.note !== 'Agreed' ? ` (${lock.note})` : ''}. The agent cannot change it.`, {
      actions: lock.active === false ? [{ label: 'Relock', run: () => relock(lock.id) }] : [{ label: 'Unlock', run: () => unlock(lock.id) }],
    });
    return;
  }
  if ((s.changes?.hunks || []).some((/** @type {any} */ h) => h.id === id)) {
    set({ activeHunk: id, sidePane: 'changes', drawer: s.narrow ? true : s.drawer });
  }
}

// ============================================================================================ focus & navigation

/**
 * Focuses a thread or draft card (and the doc anchor unless the click came from the doc).
 * @param {string} id
 * @param {{ fromDoc?: boolean }} [opts]
 */
export function focusItem(id, opts = {}) {
  const s = get();
  const visible = panelItems(s.ds, s.filter, s.version).some((x) => x.id === id);
  set({
    focusedId: id,
    filter: visible ? s.filter : 'all',
    drawer: s.narrow ? true : s.drawer,
    sidebar: true,
    sidePane: s.mode === 'changes' ? 'threads' : s.sidePane,
  });
  if (opts.fromDoc || !(s.mode === 'review' || s.mode === 'changes')) return;
  // a kind view without the doc frame (a code review) scrolls to the thread itself
  if (!kindCaps(s.ds).frame) {
    kindFocus?.(id);
    return;
  }
  guest.send(MSG.FOCUS, { id });
  // A draft made on another version is painted on this one only when the server could carry it forward (its text
  // is still there; never onto an older version): otherwise say so, and offer its own version, instead of a click
  // that does nothing.
  const d = (s.ds?.drafts?.items || []).find((/** @type {any} */ x) => x.id === id && x.kind === 'thread');
  const dv = d ? draftVersion(d) : null;
  if (!d || dv == null || d.anchor?.kind === 'doc' || !s.targets || isPainted(s, id) || dv === s.version) return;
  if (draftToast) dismissToast(draftToast);
  draftToast = toast(`${id} was written on v${dv} and is not shown on ${s.version === 'live' ? 'the working copy' : `v${s.version}`}. It is carried forward to the latest version when you submit.`, {
    actions: [{
      label: `View on v${dv}`,
      run: () => {
        if (!switchVersion(dv)) return;
        if (get().mode !== 'review' && get().mode !== 'changes') setMode('review');
        pendingFocus = { id, version: dv };
        set({ focusedId: id });
        flushPendingFocus();
      },
    }],
  });
}

export function clearFocus() {
  set({ focusedId: null });
  if (!kindCaps(get().ds).frame) kindFocus?.(null);
  else guest.send(MSG.FOCUS, { id: null });
}

/**
 * A kind view without the doc frame (a code review: kindCaps(ds).frame is false) registers how it shows a focused
 * thread or draft (scroll to its file and lines, highlight it; null clears). focusItem / clearFocus call it instead of
 * messaging the guest. Returns the unregister function (call it on unmount).
 * @param {(id: string | null) => void} fn
 * @returns {() => void}
 */
export function registerKindFocus(fn) {
  kindFocus = fn;
  return () => {
    if (kindFocus === fn) kindFocus = null;
  };
}

/**
 * A kind view without the doc frame registers a getter for its current selection as a capture (a code review: the
 * selected lines, `{ kind: 'line', file, side, startLine, endLine }`, or null), used by c / s / q and the screen
 * snip in place of the guest's text selection. Returns the unregister function.
 * @param {() => any} fn
 * @returns {() => void}
 */
export function registerKindSelection(fn) {
  kindSelection = fn;
  return () => {
    if (kindSelection === fn) kindSelection = null;
  };
}

/** j / k. @param {1|-1} dir */
export function navThread(dir) {
  const s = get();
  const items = panelItems(s.ds, s.filter, s.version);
  if (!items.length) return;
  const i = items.findIndex((x) => x.id === s.focusedId);
  const next = i < 0 ? (dir > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, i + dir));
  focusItem(items[next].id);
}

/** n / p. @param {1|-1} dir */
export function navChange(dir) {
  const s = get();
  const hunks = s.changes?.hunks || [];
  if (!hunks.length) return;
  const i = hunks.findIndex((/** @type {any} */ h) => h.id === s.activeHunk);
  const next = i < 0 ? (dir > 0 ? 0 : hunks.length - 1) : Math.max(0, Math.min(hunks.length - 1, i + dir));
  goToHunk(hunks[next].id);
}

/** @param {string} id */
export function goToHunk(id) {
  set({ activeHunk: id });
  if (get().mode === 'changes') guest.send(MSG.SCROLL_TO, { hunk: id });
}

/** @param {number} srid */
export function scrollToSrid(srid) {
  guest.send(MSG.SCROLL_TO, { srid });
  if (get().narrow) set({ nav: false });
}

/** @param {string} id */
export function revealTarget(id) {
  guest.send(MSG.REVEAL, { id });
  guest.send(MSG.FOCUS, { id });
}

// ============================================================================================ modes, versions, base

/** @param {Mode} mode */
export function setMode(mode) {
  const s = get();
  if (!hasMode(s.ds, mode)) return;
  if (s.mode === mode) return;
  let base = s.base;
  if (base == null) base = defaultBase(s.ds, s.version, s.baseKind === 'custom' ? 'last' : s.baseKind);
  if (s.tool !== 'select') guest.send(MSG.SET_TOOL, { tool: 'select' });
  set({ mode, base, tool: 'select', sidePane: mode === 'changes' ? 'changes' : s.sidePane, unseenVersion: mode === 'changes' ? null : s.unseenVersion });
  updateTitle();
  sendInit();
  if (base !== s.base || (!s.changes && base != null)) loadChanges();
}

/**
 * Selects a version (number or 'live'). Refused while a composer or reply is open.
 * @param {number|'live'} v
 * @returns {boolean}
 */
export function switchVersion(v) {
  const s = get();
  if (!s.ds || s.version === v) return true;
  if (s.composer || s.reply) {
    toast('Finish or cancel the open comment before switching versions.', { tone: 'warn' });
    return false;
  }
  const head = Number(s.ds.doc.head);
  const kind = s.baseKind === 'custom' ? 'last' : s.baseKind;
  set({
    // The Submit dialog is about the version on screen: it never stays open over another one (what was typed in it
    // is kept in submitForm).
    dialog: s.dialog === 'submit' ? null : s.dialog,
    version: v,
    followHead: v === head,
    base: defaultBase(s.ds, v, kind),
    baseKind: kind,
    targets: null,
    changes: null,
    newHead: null,
    tool: 'select',
    sourceSel: null,
    activeHunk: null,
  });
  loadTargets();
  loadChanges();
  return true;
}

/** [ / ]. @param {1|-1} dir */
export function stepVersion(dir) {
  const s = get();
  const vs = versionNumbers(s.ds);
  if (!vs.length) return;
  const cur = s.version === 'live' ? vs[vs.length - 1] + 1 : Number(s.version);
  const next = dir > 0 ? vs.find((v) => v > cur) : [...vs].reverse().find((v) => v < cur);
  if (next != null) switchVersion(next);
}

/** @param {number|null} base */
export function setBase(base) {
  set({ base, baseKind: 'custom' });
  loadChanges();
}

/** d: toggles the base between "your last review" and "previous version". */
export function toggleBaseKind() {
  const s = get();
  if (!s.ds) return;
  const kind = s.baseKind === 'prev' ? 'last' : 'prev';
  const base = defaultBase(s.ds, s.version, kind);
  set({ baseKind: kind, base });
  toast(base == null ? 'No earlier version to compare with.' : `Comparing with v${base} (${kind === 'last' ? 'your last review' : 'previous version'}).`, { timeout: 2500 });
  loadChanges();
}

/** History "Compare" / "Diff vs previous": Changes mode with that pair. @param {number} from @param {number} to */
export function compareVersions(from, to) {
  if (!switchVersion(to)) return;
  set({ base: from, baseKind: 'custom' });
  loadChanges();
  setMode('changes');
}

/** History "View": that version in Review mode. @param {number} v */
export function viewVersion(v) {
  if (!switchVersion(v)) return;
  setMode('review');
}

// ============================================================================================ composer

/**
 * Opens the composer for a capture (from the guest toolbar / picker / snip, a key, the outline, Source mode, a screen
 * snip, ...). Refused while the open composer holds input (a comment, an edited suggestion, attachments, a lock note).
 * @param {{ capture: any, action?: string, crop?: string|null, body?: string, type?: string, severity?: string,
 *   attachments?: Array<{ path: string, preview: string }>, restore?: any }} p attachments: already stored images
 *   (a screen snip); restore: a stored backup to reopen (offerComposerBackup)
 */
export function openComposer({ capture, action = 'comment', crop = null, body = '', type, severity, attachments = [], restore }) {
  const s = get();
  if (!s.ds || !capture) return;
  if (s.version === 'live') {
    toast('The working copy is a read-only preview. Record it or switch to a recorded version to comment.', { tone: 'warn' });
    return;
  }
  if (s.composer && (isComposerDirty(s.composer) || s.composer.busy)) {
    toast('Finish or cancel the open comment first.', { tone: 'warn' });
    return;
  }
  const t = type || ({ suggest: 'suggestion', question: 'question', agree: 'agree' })[action] || 'comment';
  const sig = `${t}|${JSON.stringify(capture)}`;
  if (s.composer && s.composer.key === lastOpen.key && lastOpen.sig === sig && Date.now() - lastOpen.at < DUPLICATE_OPEN_MS) return;
  const backup = restore || (!body ? readBackup(capture) : null);
  const restored = Array.isArray(backup?.attachments)
    ? backup.attachments.filter((/** @type {any} */ p) => typeof p === 'string').map((/** @type {string} */ p) => ({ path: p, preview: '' }))
    : [];
  const composer = {
    key: ++composerSeq,
    capture,
    version: numericVersion(s.ds, s.version),
    type: /** @type {any} */ (backup?.type || t),
    severity: /** @type {any} */ (backup?.severity || severity || 'normal'),
    body: backup?.body || body,
    crop,
    cropPath: null,
    attachments: [...restored, ...attachments.filter((a) => !restored.some((r) => r.path === a.path))],
    anchor: null,
    preview: null,
    resolving: true,
    resolveError: null,
    widened: false,
    suggestion: null,
    pendingSuggestion: backup?.suggestion && typeof backup.suggestion.new === 'string' ? backup.suggestion : null,
    note: typeof backup?.note === 'string' ? backup.note : '',
    draftId: null,
    createdDraftId: null,
    busy: false,
    error: null,
  };
  lastOpen = { key: composer.key, at: Date.now(), sig };
  if (s.tool !== 'select') guest.send(MSG.SET_TOOL, { tool: 'select' });
  set({ composer, tool: 'select', drawer: s.narrow ? true : s.drawer, sidebar: true });
  if (attachments.length) saveBackupSoon();
  resolveComposerAnchor(false);
}

/** @param {Partial<import('./state.js').Composer> & Record<string, any>} patch */
export function updateComposer(patch) {
  set((s) => (s.composer ? { composer: { ...s.composer, ...patch } } : null));
  if (['body', 'type', 'severity', 'suggestion', 'attachments', 'note'].some((k) => k in patch)) {
    saveBackupSoon();
    if (get().composer?.draftId && 'body' in patch) autosaveDraftSoon();
  }
}

/** Resolves (or widens) the composer's anchor: POST /anchors/resolve. @param {boolean} widen */
export async function resolveComposerAnchor(widen) {
  const c = client;
  const comp = get().composer;
  if (!c || !comp || !comp.capture) return;
  updateComposer({ resolving: true, resolveError: null });
  try {
    const r = await c.resolveAnchor({ version: comp.version, capture: comp.capture, ...(widen ? { widen: true } : {}) });
    if (get().composer?.key !== comp.key) return;
    updateComposer({ anchor: r?.anchor ?? null, preview: r?.preview ?? null, resolving: false, widened: widen, suggestion: null });
    if (get().composer?.type === 'suggestion') initSuggestion();
  } catch (err) {
    if (get().composer?.key !== comp.key) return;
    updateComposer({ resolving: false, resolveError: errorText(err) });
  }
}

/** @param {'comment'|'question'|'suggestion'|'agree'} type */
export function setComposerType(type) {
  const comp = get().composer;
  if (!comp) return;
  updateComposer({ type });
  if (type === 'suggestion' && !comp.suggestion && comp.anchor) initSuggestion();
}

/** Prefills the suggestion editor (text mode = the exact slice, source mode = the anchor's whole lines). */
async function initSuggestion() {
  const c = client;
  const comp = get().composer;
  const a = comp?.anchor;
  if (!c || !comp || !a || !a.src) return;
  // a code review's line anchor: whole lines of the file's new side ('lines', from D/files/source)
  const mode = a.file ? 'lines' : suggestionMode(a);
  // Suggested text restored from a backup applies when it replaces the same old text in the same mode.
  /** @param {string} old */
  const restored = (old) => {
    const p = comp.pendingSuggestion;
    return p && p.mode === mode && p.old === old ? String(p.new) : old;
  };
  if (mode === 'text') {
    updateComposer({
      suggestion: { mode, old: a.src.text, new: restored(a.src.text), startLine: a.src.startLine, endLine: a.src.endLine, start: a.src.start, end: a.src.end },
      pendingSuggestion: null,
    });
    return;
  }
  if (a.file) {
    if (a.kind === 'doc' || a.file.side !== 'new') {
      updateComposer({ suggestion: null, error: 'Suggestions replace lines of the new side: select lines on the right-hand side, or write a comment.' });
      return;
    }
    const { startLine, endLine } = a.src;
    updateComposer({ suggestion: { mode, old: '', new: '', startLine, endLine, start: 0, end: 0, loading: true } });
    try {
      const r = await c.fileSource(a.file.path, comp.version, 'new');
      if (get().composer?.key !== comp.key) return;
      const old = String(r?.text ?? '').split('\n').slice(startLine - 1, endLine).join('\n');
      updateComposer({ suggestion: { mode, old, new: restored(old), startLine, endLine, start: 0, end: 0 }, pendingSuggestion: null });
    } catch (err) {
      if (get().composer?.key !== comp.key) return;
      updateComposer({ suggestion: null, error: `Cannot load the source lines: ${errorText(err)}` });
    }
    return;
  }
  updateComposer({
    suggestion: { mode, old: '', new: '', startLine: a.src.startLine, endLine: a.src.endLine, start: a.src.start, end: a.src.end, loading: true },
  });
  try {
    const r = await c.source(comp.version, a.src.startLine, a.src.endLine);
    if (get().composer?.key !== comp.key) return;
    const lines = Array.isArray(r?.lines) ? r.lines.map(String) : [];
    const startLine = Number(r?.startLine) || a.src.startLine;
    const old = lines.join('\n');
    const start = a.src.start - anchorColumn(a, lines[0] || '');
    updateComposer({
      suggestion: { mode, old, new: restored(old), startLine, endLine: startLine + Math.max(0, lines.length - 1), start, end: start + old.length },
      pendingSuggestion: null,
    });
  } catch (err) {
    if (get().composer?.key !== comp.key) return;
    updateComposer({ suggestion: null, error: `Cannot load the source lines: ${errorText(err)}` });
  }
}

/** @param {string} text */
export function setSuggestionText(text) {
  const comp = get().composer;
  if (!comp?.suggestion) return;
  updateComposer({ suggestion: { ...comp.suggestion, new: text } });
}

/** Adds a pasted image as an attachment. @param {string} dataUrl */
export async function attachImage(dataUrl) {
  const c = client;
  const comp = get().composer;
  if (!c || !comp) return;
  try {
    const r = await c.attachment(dataUrl);
    const now = get().composer;
    if (!now || now.key !== comp.key || !r?.path) return;
    updateComposer({ attachments: [...now.attachments, { path: String(r.path), preview: dataUrl }] });
  } catch (err) {
    toast(`Image not attached: ${errorText(err)}`, { tone: 'danger' });
  }
}

/** @param {string} path */
export function removeAttachment(path) {
  const comp = get().composer;
  if (comp) updateComposer({ attachments: comp.attachments.filter((a) => a.path !== path) });
}

/**
 * Why a comment / question / suggestion composer cannot be saved yet, or null.
 * @param {any} comp
 */
function composerProblem(comp) {
  if (!comp.anchor) return comp.resolving ? 'Still locating the anchor…' : 'The anchor could not be resolved. Try "General comment" instead.';
  const body = comp.body.trim();
  const sug = comp.type === 'suggestion' ? comp.suggestion : null;
  if (comp.type === 'suggestion' && (!sug || sug.loading)) return 'The suggestion editor is not ready yet.';
  if (sug && sug.new === sug.old && !body) return 'Edit the suggested text (or add a comment) first.';
  // A screenshot (a snip's crop, an attached image) speaks for itself: the text is optional then.
  if (!sug && !body && !comp.crop && !comp.attachments.length) return 'Write a comment first.';
  return null;
}

/**
 * The thread DraftItem a composer saves.
 * @param {any} comp
 * @param {string|null} [cropPath]
 */
function composerItem(comp, cropPath = comp.cropPath) {
  const sug = comp.type === 'suggestion' ? comp.suggestion : null;
  return {
    kind: 'thread',
    type: comp.type,
    severity: comp.severity,
    anchor: comp.anchor,
    body: comp.body.trim(),
    suggestion: sug ? {
      mode: sug.mode, old: sug.old, new: sug.new, version: comp.version,
      start: sug.start, end: sug.end, startLine: sug.startLine, endLine: sug.endLine,
    } : null,
    attachments: [...(cropPath ? [cropPath] : []), ...comp.attachments.map((/** @type {any} */ a) => a.path)],
    version: comp.version,
  };
}

/** @param {unknown} err */
const isNotFound = (err) => /** @type {any} */ (err)?.status === 404;

/** The composer whose submit waits for its anchor (0 = none), and how long a submit waits for it. */
let settlingKey = 0;
const ANCHOR_WAIT_MS = 5000;

/**
 * The composer once its anchor is resolved (or after ANCHOR_WAIT_MS, still resolving); null when it was closed or
 * replaced meanwhile.
 * @param {number} key
 */
async function anchorSettled(key) {
  const until = Date.now() + ANCHOR_WAIT_MS;
  for (;;) {
    const now = /** @type {any} */ (get().composer);
    if (!now || now.key !== key) return null;
    if (!now.resolving || Date.now() >= until) return now;
    await new Promise((ok) => setTimeout(ok, 40));
  }
}

/**
 * Saves an item into an existing draft; when that draft is gone (submitted or deleted elsewhere) the item becomes a
 * new draft instead of an error the editor could never get past.
 * @param {NonNullable<typeof client>} c
 * @param {string|null} id
 * @param {any} item
 */
async function saveDraftItem(c, id, item) {
  if (!id) return c.createDraft(item);
  try {
    return await c.patchDraft(id, item);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    return c.createDraft(item);
  }
}

/** The version on screen, which a review is about. */
function reviewedVersion() {
  const s = get();
  return numericVersion(s.ds, s.version);
}

/**
 * Add to review (draft) or Send now (draft + one-item review with verdict comment). With "Ask before Send now"
 * (Settings), a Send now first shows a confirmation in the composer (confirmSend); confirming it, or pressing Send
 * now again while it shows, sends.
 * @param {{ sendNow?: boolean, confirmed?: boolean }} [opts]
 */
export async function submitComposer(opts = {}) {
  const c = client;
  let comp = /** @type {any} */ (get().composer);
  if (!c || !comp || comp.busy) return;
  if (comp.resolving) {
    // A key pressed right after the composer opened (a snip sent at once): finish locating the anchor first. A
    // second press meanwhile is the same request.
    if (settlingKey === comp.key) return;
    settlingKey = comp.key;
    try {
      comp = await anchorSettled(comp.key);
    } finally {
      settlingKey = 0;
    }
    if (!comp || comp.busy || client !== c) return;
  }
  if (comp.type === 'agree') {
    await markAgreed();
    return;
  }
  const problem = composerProblem(comp);
  if (problem) {
    updateComposer({ error: problem, confirmSend: false });
    return;
  }
  if (opts.sendNow && !opts.confirmed && !comp.confirmSend && get().prefs.confirmSendNow) {
    updateComposer({ confirmSend: true, error: null });
    return;
  }
  updateComposer({ busy: true, error: null, confirmSend: false });
  try {
    let cropPath = comp.cropPath;
    if (comp.crop && !cropPath) {
      const r = await c.attachment(comp.crop);
      cropPath = r?.path ? String(r.path) : null;
      updateComposer({ cropPath });
    }
    const item = composerItem(comp, cropPath);
    // A Send now whose review request failed already created its draft: a retry saves and sends that one.
    const existing = comp.draftId || comp.createdDraftId || null;
    const draft = await saveDraftItem(c, existing, item);
    const draftId = String(draft?.id ?? existing ?? '');
    if (!comp.draftId && draftId && get().composer?.key === comp.key) updateComposer({ createdDraftId: draftId });
    if (opts.sendNow && draftId) {
      await c.submitReview({ verdict: 'comment', body: '', draftIds: [draftId], reviewedVersion: reviewedVersion() });
      toast('Sent to the agent.', { tone: 'ok' });
    }
    clearBackup();
    autosaveDraftSoon.cancel();
    if (get().composer?.key === comp.key) set({ composer: null });
    guest.send(MSG.CLEAR_SELECTION);
    if (!opts.sendNow && draft && draft.id) {
      set((s) => (s.ds ? {
        ds: { ...s.ds, drafts: { ...(s.ds.drafts || {}), items: upsert(s.ds.drafts?.items || [], draft) } },
        focusedId: draft.id,
      } : null));
    }
    await refreshNow();
  } catch (err) {
    if (get().composer?.key !== comp.key) return;
    updateComposer({
      busy: false,
      error: /** @type {any} */ (err).offline ? 'Connection lost. Your comment is kept here; try again once reconnected.' : errorText(err),
    });
  }
}

/** "Mark agreed" from the composer (type 'agree'): creates a lock right away. */
async function markAgreed() {
  const c = client;
  const comp = get().composer;
  if (!c || !comp) return;
  updateComposer({ busy: true, error: null });
  try {
    const lock = await c.createLock({ version: /** @type {number} */ (comp.version), capture: comp.capture, ...(comp.note.trim() ? { note: comp.note.trim() } : {}) });
    set({ composer: null });
    clearBackup();
    guest.send(MSG.CLEAR_SELECTION);
    toast(`Marked agreed${lock?.id ? ` (${lock.id})` : ''}. The agent will be refused if it changes this.`, { tone: 'ok' });
    await refreshNow();
  } catch (err) {
    updateComposer({ busy: false, error: errorText(err) });
  }
}

/** Cancel (Esc): closes the composer; one that held input (isComposerDirty) can be restored from the toast. */
export function cancelComposer() {
  const comp = get().composer;
  if (!comp) return;
  if (comp.busy) return;
  autosaveDraftSoon.flush();
  set({ composer: null });
  guest.send(MSG.CLEAR_SELECTION);
  if (isComposerDirty(comp) && !comp.draftId) {
    lastCancelled = comp;
    toast('Comment discarded.', {
      actions: [{
        label: 'Undo',
        run: () => {
          if (!lastCancelled || get().composer) return;
          set({ composer: { ...lastCancelled, key: ++composerSeq, busy: false, confirmSend: false }, drawer: get().narrow ? true : get().drawer });
          lastCancelled = null;
          saveBackupSoon();
        },
      }],
    });
  }
  clearBackup();
}

/** Opens a draft for editing (thread drafts in the composer, reply drafts in their reply box). @param {string} id */
export function editDraft(id) {
  const s = get();
  const d = (s.ds?.drafts?.items || []).find((/** @type {any} */ x) => x.id === id);
  if (!d) return;
  if (d.kind === 'reply') {
    startReply(d.thread, { reopen: !!d.reopen });
    return;
  }
  if (d.kind !== 'thread') return;
  if (s.composer) {
    toast('Finish or cancel the open comment first.', { tone: 'warn' });
    return;
  }
  set({
    composer: {
      key: ++composerSeq,
      capture: null,
      version: Number(d.version ?? d.anchor?.v ?? numericVersion(s.ds, s.version)),
      type: d.type === 'question' || d.type === 'suggestion' ? d.type : 'comment',
      severity: d.severity || 'normal',
      body: String(d.body || ''),
      crop: null,
      attachments: (d.attachments || []).map((/** @type {string} */ p) => ({ path: p, preview: '' })),
      anchor: d.anchor || null,
      preview: null,
      resolving: false,
      resolveError: null,
      widened: false,
      suggestion: d.suggestion ? { ...d.suggestion } : null,
      note: '',
      draftId: d.id,
      busy: false,
      error: null,
    },
    drawer: s.narrow ? true : s.drawer,
    sidebar: true,
    focusedId: d.id,
  });
}

/** @param {string} id */
export async function deleteDraft(id) {
  const c = client;
  if (!c) return;
  const before = get().ds;
  const gone = (before?.drafts?.items || []).find((/** @type {any} */ x) => x.id === id);
  set((s) => (s.ds ? { ds: { ...s.ds, drafts: { ...s.ds.drafts, items: (s.ds.drafts?.items || []).filter((/** @type {any} */ x) => x.id !== id) } } } : null));
  const comp = get().composer;
  if (comp?.draftId === id) {
    autosaveDraftSoon.cancel();
    set({ composer: null });
  } else if (comp?.createdDraftId === id) {
    updateComposer({ createdDraftId: null });
  }
  // A reply box editing this draft: closed when it holds nothing beyond the deleted draft, else kept as a new reply
  // (so "Add reply" creates a draft instead of saving into the deleted one).
  const r = get().reply;
  if (r?.draftId === id) {
    const edited = r.body.trim() && r.body !== String(gone?.body ?? '');
    set({ reply: edited ? { ...r, draftId: null } : null });
  }
  try {
    await c.deleteDraft(id);
  } catch (err) {
    if (before && client === c) set({ ds: before });
    toast(`Could not delete the draft: ${errorText(err)}`, { tone: 'danger' });
  }
  await refreshNow();
}

const autosaveDraftSoon = debounce(async () => {
  const c = client;
  const comp = get().composer;
  if (!c || !comp?.draftId || comp.busy) return;
  try {
    await c.patchDraft(comp.draftId, { body: comp.body, type: comp.type, severity: comp.severity });
  } catch (err) {
    if (isNotFound(err)) {
      // The draft is gone (submitted or deleted elsewhere): the composer keeps the text as a new comment.
      set((s) => (s.composer?.key === comp.key ? { composer: { ...s.composer, draftId: null } } : null));
      saveBackupSoon();
      return;
    }
    if (!(/** @type {any} */ (err).offline)) console.warn('specreview: draft autosave failed', err);
  }
}, 800);

// ---- localStorage backup of the unsent composer (design 11.4) --------------------------------------------------

function backupKey() {
  const r = get().route;
  return r.view === 'doc' ? `specreview.composer.${r.ws}/${r.doc}` : null;
}

const saveBackupSoon = debounce(() => {
  const key = backupKey();
  const comp = get().composer;
  if (!key || !comp || comp.draftId || !comp.capture) return;
  try {
    if (!isComposerDirty(comp)) {
      // Emptied: forget this composer's backup, but not one of another capture that was not restored yet.
      const prev = JSON.parse(localStorage.getItem(key) || 'null');
      if (prev && JSON.stringify(prev.capture) === JSON.stringify(comp.capture)) localStorage.removeItem(key);
      return;
    }
    const s = comp.suggestion && !comp.suggestion.loading ? comp.suggestion : comp.pendingSuggestion;
    localStorage.setItem(key, JSON.stringify({
      capture: comp.capture,
      body: comp.body,
      type: comp.type,
      severity: comp.severity,
      note: comp.note,
      attachments: comp.attachments.map((a) => a.path),
      suggestion: s ? { mode: s.mode, old: s.old, new: s.new } : null,
      at: Date.now(),
    }));
  } catch {
    /* storage unavailable */
  }
}, 400);

function clearBackup() {
  saveBackupSoon.cancel();
  const key = backupKey();
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** The stored backup when it belongs to the same capture. @param {any} capture */
function readBackup(capture) {
  const key = backupKey();
  if (!key) return null;
  try {
    const b = JSON.parse(localStorage.getItem(key) || 'null');
    if (backupHasInput(b) && JSON.stringify(b.capture) === JSON.stringify(capture)) return b;
  } catch {
    /* ignore */
  }
  return null;
}

function offerComposerBackup() {
  const key = backupKey();
  if (!key) return;
  /** @type {any} */
  let b = null;
  try {
    b = JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    b = null;
  }
  if (!backupHasInput(b) || !b.capture || Date.now() - Number(b.at || 0) > 7 * 86400e3) return;
  toast('You have an unsent comment from earlier.', {
    timeout: 20000,
    actions: [
      { label: 'Restore', run: () => openComposer({ capture: b.capture, type: b.type, severity: b.severity, restore: b }) },
      { label: 'Discard', run: () => clearBackup() },
    ],
  });
}

// ============================================================================================ replies & thread actions

/**
 * Opens the reply box of a thread (there is one at a time). Refused while another thread's reply box holds unsaved
 * text; on the same thread the open box is kept as it is.
 * @param {string} threadId
 * @param {{ reopen?: boolean }} [opts]
 */
export function startReply(threadId, opts = {}) {
  const s = get();
  const cur = s.reply;
  if (cur && cur.threadId === threadId) {
    set({
      reply: opts.reopen && !cur.reopen ? { ...cur, reopen: true } : cur,
      focusedId: threadId,
      drawer: s.narrow ? true : s.drawer,
      sidebar: true,
    });
    return;
  }
  if (cur && (cur.busy || isReplyDirty(cur, s.ds?.drafts))) {
    toast(`Finish or cancel the open reply on ${cur.threadId} first.`, { tone: 'warn' });
    focusItem(cur.threadId);
    return;
  }
  const existing = replyDraftsFor(s.ds?.drafts, threadId)[0];
  set({
    reply: {
      threadId,
      body: existing?.body || '',
      reopen: !!opts.reopen || !!existing?.reopen,
      draftId: existing?.id || null,
      busy: false,
    },
    focusedId: threadId,
    drawer: s.narrow ? true : s.drawer,
    sidebar: true,
  });
}

/** @param {string} body */
export function setReplyBody(body) {
  set((s) => (s.reply ? { reply: { ...s.reply, body } } : null));
}

/** Cancel (Esc in the reply box): closes it; unsaved text can be restored from the toast. */
export function cancelReply() {
  const s = get();
  const r = s.reply;
  if (!r || r.busy) return;
  set({ reply: null });
  if (!isReplyDirty(r, s.ds?.drafts)) return;
  lastCancelledReply = r;
  toast('Reply discarded.', {
    actions: [{
      label: 'Undo',
      run: () => {
        const back = lastCancelledReply;
        if (!back || get().reply) return;
        lastCancelledReply = null;
        set({ reply: { ...back, busy: false }, focusedId: back.threadId, drawer: get().narrow ? true : get().drawer, sidebar: true });
      },
    }],
  });
}

/** Adds the reply (optionally reopening) to the pending review as a draft. */
export async function submitReply() {
  const c = client;
  const r = get().reply;
  if (!c || !r || r.busy) return;
  const body = r.body.trim();
  if (!body) return;
  set({ reply: { ...r, busy: true } });
  try {
    const item = { kind: 'reply', thread: r.threadId, body, reopen: r.reopen };
    const draft = await saveDraftItem(c, r.draftId, item);
    set((s) => ({
      reply: null,
      ...(s.ds && draft?.id ? { ds: { ...s.ds, drafts: { ...(s.ds.drafts || {}), items: upsert(s.ds.drafts?.items || [], draft) } } } : {}),
    }));
    await refreshNow();
  } catch (err) {
    set((s) => (s.reply ? { reply: { ...s.reply, busy: false } } : null));
    toast(`Reply not saved: ${errorText(err)}`, { tone: 'danger' });
  }
}

/**
 * Runs one action request on a thread unless one is already in flight for it (a double click or a repeated key
 * would otherwise send it twice). busyThreads drives the cards' disabled buttons until the refreshed state is shown.
 * @param {string} id
 * @param {() => Promise<void>} fn
 */
async function threadAction(id, fn) {
  if (get().busyThreads.includes(id)) return;
  set((s) => ({ busyThreads: [...s.busyThreads, id] }));
  try {
    await fn();
  } finally {
    set((s) => ({ busyThreads: s.busyThreads.filter((x) => x !== id) }));
  }
}

/** Accept / Resolve (immediate, design C18). @param {string} id @param {string} [decision] */
export async function resolveThread(id, decision) {
  const c = client;
  if (!c) return;
  await threadAction(id, async () => {
    try {
      await c.resolve(id, decision && decision.trim() ? { decision: decision.trim() } : {});
    } catch (err) {
      toast(`Could not resolve ${id}: ${errorText(err)}`, { tone: 'danger' });
      return;
    }
    toast(`${id} resolved${decision && decision.trim() ? ' and recorded as a decision' : ''}.`, { tone: 'ok', timeout: 3000 });
    await refreshNow();
  });
}

/** @param {string} id */
export async function unresolveThread(id) {
  const c = client;
  if (!c) return;
  await threadAction(id, async () => {
    try {
      await c.unresolve(id);
    } catch (err) {
      toast(`Could not reopen ${id}: ${errorText(err)}`, { tone: 'danger' });
      return;
    }
    await refreshNow();
  });
}

/** Reviewer "Apply now" for a suggestion. @param {string} id */
export async function applySuggestion(id) {
  const c = client;
  if (!c) return;
  await threadAction(id, async () => {
    /** @type {any} */
    let m;
    try {
      m = await c.apply(id);
    } catch (err) {
      toast(applyErrorText(id, err), { tone: 'danger' });
      await refreshNow();
      return;
    }
    toast(`Suggestion applied${m?.v ? ` as v${m.v}` : ''}.`, { tone: 'ok' });
    await refreshNow();
  });
}

/** Move here: re-anchor to the current selection in the doc (or a doc-level anchor). @param {string} id @param {any} [capture] */
export async function moveThread(id, capture) {
  const c = client;
  const s = get();
  if (!c || !s.ds) return;
  // a kind view without the doc frame (a code review) gives its own selection (the selected lines)
  const frame = kindCaps(s.ds).frame;
  const cap = capture || (frame ? s.guest.selection : kindSelection?.() || null);
  if (!cap) {
    toast(frame ? 'Select the new text in the document first (or pick an element with E), then click Move here.'
      : 'Select the new lines first (click a line number, shift-click to extend), then click Move here.', { tone: 'warn' });
    return;
  }
  await threadAction(id, async () => {
    try {
      await c.move(id, { version: numericVersion(s.ds, s.version), capture: cap });
    } catch (err) {
      toast(`Could not move ${id}: ${errorText(err)}`, { tone: 'danger' });
      return;
    }
    guest.send(MSG.CLEAR_SELECTION);
    toast(`${id} moved.`, { tone: 'ok', timeout: 3000 });
    await refreshNow();
  });
}

/** @param {string} id */
export async function unlock(id) {
  const c = client;
  if (!c) return;
  try {
    await c.deleteLock(id);
    toast(`${id} unlocked.`, { timeout: 3000 });
    await refreshNow();
  } catch (err) {
    toast(`Could not unlock ${id}: ${errorText(err)}`, { tone: 'danger' });
  }
}

/** @param {string} id */
export async function relock(id) {
  const c = client;
  if (!c) return;
  try {
    await c.relock(id);
    toast(`${id} locked again.`, { timeout: 3000 });
    await refreshNow();
  } catch (err) {
    toast(`Could not relock ${id}: ${errorText(err)}`, { tone: 'danger' });
  }
}

// ============================================================================================ submit, record

export function openSubmit() {
  const s = get();
  if (!s.ds) return;
  set({ dialog: 'submit' });
}

export function closeDialog() {
  set({ dialog: null, lightbox: null });
}

/**
 * Shows an image (an attachment thumbnail, a crop) full size; Esc, the backdrop or Close shut it.
 * @param {string} src
 * @param {string} [alt]
 */
export function openLightbox(src, alt = 'Screenshot') {
  if (!src || get().dialog === 'submit') return;
  set({ dialog: 'image', lightbox: { src, alt } });
}

/**
 * What the reviewer typed / picked in the Submit dialog. It lives in the store, so closing the dialog (Esc, a click
 * on the backdrop, Cancel) loses nothing; a successful submit clears it.
 * @param {Partial<NonNullable<UiState['submitForm']>>} patch
 */
export function updateSubmitForm(patch) {
  set((s) => ({ submitForm: { body: '', verdict: null, markFinal: true, resolveAddressed: true, ...s.submitForm, ...patch } }));
}

/**
 * Saves edits in progress on drafts of the pending review (the composer editing a thread draft, a reply box editing
 * a reply draft), so the review sends what is on screen. Returns why that is not possible, or null.
 * @param {NonNullable<typeof client>} c
 * @returns {Promise<string|null>}
 */
async function saveBoundEdits(c) {
  autosaveDraftSoon.cancel();
  const comp = /** @type {any} */ (get().composer);
  if (comp?.draftId) {
    if (comp.busy) return `Draft ${comp.draftId} is still being saved. Try again in a moment.`;
    const problem = composerProblem(comp);
    if (problem) return `You are editing draft ${comp.draftId}: ${problem} Or cancel the edit.`;
    const draft = await saveDraftItem(c, comp.draftId, composerItem(comp));
    if (draft?.id && draft.id !== comp.draftId) set((s) => (s.composer?.key === comp.key ? { composer: { ...s.composer, draftId: String(draft.id) } } : null));
  }
  const s = get();
  const r = s.reply;
  if (r?.draftId) {
    if (r.busy) return `The reply on ${r.threadId} is still being saved. Try again in a moment.`;
    if (!r.body.trim()) return `The reply you are editing on ${r.threadId} is empty: write it, or delete that draft.`;
    if (isReplyDirty(r, s.ds?.drafts)) {
      const draft = await saveDraftItem(c, r.draftId, { kind: 'reply', thread: r.threadId, body: r.body.trim(), reopen: r.reopen });
      if (draft?.id && draft.id !== r.draftId) set((st) => (st.reply === r ? { reply: { ...r, draftId: String(draft.id) } } : null));
    }
  }
  return null;
}

/**
 * Submits the pending review: every draft, plus a summary and a verdict.
 * - Edits in progress on drafts are saved first, so the review carries the text on screen.
 * - It is about the version on screen (sent as `reviewedVersion`). Approve is refused when a newer version exists:
 *   the daemon marks its head final, which the reviewer has not seen.
 * @param {{ verdict: string, body: string, markFinal?: boolean, resolveAddressed?: boolean }} p
 * @returns {Promise<string|null>} error message, or null on success
 */
export async function submitReview(p) {
  const c = client;
  if (!c) return 'Not connected';
  const reviewed = reviewedVersion();
  try {
    const unsaved = await saveBoundEdits(c);
    if (unsaved) return unsaved;
    if (p.verdict === 'approved') {
      // Close the gap between the last event the UI has seen and the request.
      const fresh = await c.state();
      if (client !== c) return 'The document was closed.';
      const stale = staleApproveText(fresh, reviewed);
      if (stale) {
        await refreshNow();
        return stale;
      }
    }
    /** @type {any} */
    const body = { verdict: p.verdict, body: p.body.trim(), reviewedVersion: reviewed };
    if (p.verdict === 'approved') {
      body.markFinal = !!p.markFinal;
      body.resolveAddressed = !!p.resolveAddressed;
    }
    const review = await c.submitReview(body);
    // Every draft went out: editors bound to one are done (their edits were saved above).
    autosaveDraftSoon.cancel();
    set((s) => ({
      dialog: null,
      submitForm: null,
      composer: s.composer?.draftId ? null : s.composer,
      reply: s.reply?.draftId ? null : s.reply,
    }));
    const label = p.verdict === 'approved' ? 'Approved' : p.verdict === 'changes_requested' ? 'Changes requested' : 'Review submitted';
    toast(`${label}${review?.id ? ` (${review.id})` : ''}.`, { tone: 'ok' });
    await refreshNow();
    return null;
  } catch (err) {
    return errorText(err);
  }
}

/** "Record as my revision" for the unrecorded working copy. @param {string} summary */
export async function recordWorkingCopy(summary) {
  const c = client;
  if (!c) return;
  try {
    const m = await c.record(summary.trim() || 'Reviewer edit');
    toast(`Recorded${m?.v ? ` as v${m.v}` : ''}.`, { tone: 'ok' });
    await refreshNow();
  } catch (err) {
    toast(`Could not record: ${errorText(err)}`, { tone: 'danger' });
  }
}

/** Switches to the newest version announced by the banner. */
export function goToNewHead() {
  const s = get();
  if (!s.ds) return;
  if (switchVersion(Number(s.ds.doc.head))) set({ newHead: null, followHead: true });
}

// ============================================================================================ view toggles

/** @param {import('./state.js').Theme} theme */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  set({ theme });
  writePref('theme', theme);
  guest.send(MSG.SET_THEME, { theme });
}

export function cycleTheme() {
  const order = /** @type {const} */ (['system', 'light', 'dark']);
  const next = order[(order.indexOf(get().theme) + 1) % order.length];
  applyTheme(next);
  toast(`Theme: ${next}`, { timeout: 1500 });
}

export function toggleHidden() {
  if (!kindCaps(get().ds).hide) return;
  const hidden = !get().hidden;
  set({ hidden });
  guest.send(MSG.SET_HIDDEN, { hidden });
}

/**
 * Select (text), pick (e: an element) or snip (b: a box over any area). Pick and snip need the rendered doc of a
 * recorded version (Review / Changes) and a connected guest.
 * @param {'select'|'pick'|'snip'} tool
 */
export function setTool(tool) {
  const s = get();
  const caps = kindCaps(s.ds);
  if ((tool === 'pick' && !caps.pick) || (tool === 'snip' && !caps.snip)) {
    toast('Pick and snip work on rendered documents; click a line number to comment.', { timeout: 2500 });
    return;
  }
  if (tool !== 'select' && (s.version === 'live' || !(s.mode === 'review' || s.mode === 'changes'))) {
    if (s.version === 'live') toast('The working copy preview is read-only.', { tone: 'warn' });
    return;
  }
  if (tool !== 'select' && !guest.connected) {
    toast('The document is still loading.', { timeout: 2000 });
    return;
  }
  set({ tool });
  guest.send(MSG.SET_TOOL, { tool });
}

export function togglePick() {
  setTool(get().tool === 'pick' ? 'select' : 'pick');
}

/**
 * b / the scissors button: snip an area of the doc. The guest shows a crosshair; dragging a box opens the composer
 * with a crop of the box, Esc cancels, and the tool goes back to select after one snip. In Source / History mode it
 * switches to Review first. A `b` forwarded from the doc while already snipping is ignored (the guest handles its
 * own keys while it snips); a `b` in the UI then cancels the snip.
 * @param {{ fromGuest?: boolean }} [opts]
 */
export function toggleSnip(opts = {}) {
  const s = get();
  if (s.tool === 'snip') {
    if (!opts.fromGuest) setTool('select');
    return;
  }
  if (s.version !== 'live' && s.mode !== 'review' && s.mode !== 'changes') setMode('review');
  setTool('snip');
}

/** What a screen snip is about: the selected text in the doc, the selected lines in Source mode, else the whole doc. @param {UiState} s */
function screenSnipCapture(s) {
  if (!kindCaps(s.ds).frame) return kindSelection?.() || { kind: 'doc' };
  if (s.mode === 'source' && s.sourceSel) return { kind: 'source', startLine: s.sourceSel.from, endLine: s.sourceSel.to };
  if ((s.mode === 'review' || s.mode === 'changes') && s.guest.selection) return s.guest.selection;
  return { kind: 'doc' };
}

const SNIP_SCREEN_UNSUPPORTED = 'Snipping the screen needs macOS (SpecReview runs the system screenshot picker on your Mac). Press b (without Shift) to snip an area of the document instead.';

/**
 * Shift+B / the screen button: the daemon runs the macOS region picker (`screencapture -i`, like Cmd+Shift+4) on the
 * reviewer's Mac and stores the PNG. A floating hint says so while it waits. The screenshot is attached to the open composer
 * when there is one, else to a new composer on the current selection (doc text, or lines in Source mode), else to a
 * general comment. Esc in the picker cancels quietly; a 501 hides the screen button (not macOS).
 */
export async function snipScreen() {
  const c = client;
  const s = get();
  if (!c || !s.ds) return;
  if (s.screenSnip.running) {
    toast('A screen snip is already waiting: drag a box anywhere on your screen, or press Esc to cancel it.', { timeout: 3500 });
    return;
  }
  if (!s.screenSnip.supported) {
    toast(SNIP_SCREEN_UNSUPPORTED, { tone: 'warn' });
    return;
  }
  if (s.version === 'live') {
    toast('The working copy is a read-only preview. Record it or switch to a recorded version to comment.', { tone: 'warn' });
    return;
  }
  if (s.composer && (s.composer.type === 'agree' || s.composer.busy)) {
    toast('Finish or cancel the open comment first.', { tone: 'warn' });
    return;
  }
  // Taken now: the picker can take a while, and the selection may change meanwhile.
  const capture = screenSnipCapture(s);
  if (s.tool !== 'select') setTool('select');
  set((st) => ({ screenSnip: { ...st.screenSnip, running: true } }));
  /** @type {any} */
  let r;
  try {
    r = await c.snipScreen();
  } catch (err) {
    const e = /** @type {any} */ (err);
    const code = e?.body?.code;
    if (e?.status === 501 || code === 'unsupported') {
      set((st) => ({ screenSnip: { ...st.screenSnip, supported: false } }));
      toast(SNIP_SCREEN_UNSUPPORTED, { tone: 'warn', timeout: 8000 });
    } else if (e?.status === 409 || code === 'busy') {
      toast('A screen snip is already running on your Mac. Finish it there (or press Esc) first.', { tone: 'warn' });
    } else {
      toast(`Screen snip failed: ${e?.offline ? 'the connection to SpecReview was lost' : errorText(err)}`, { tone: 'danger' });
    }
    return;
  } finally {
    set((st) => ({ screenSnip: { ...st.screenSnip, running: false } }));
  }
  if (client !== c) return; // another doc meanwhile
  if (r?.cancelled) {
    toast('Screen snip cancelled.', { tone: 'muted', timeout: 2500 });
    return;
  }
  if (!r?.path) {
    toast('Screen snip failed: the daemon returned no screenshot.', { tone: 'danger' });
    return;
  }
  const att = { path: String(r.path), preview: typeof r.dataUrl === 'string' && r.dataUrl.startsWith('data:image/') ? r.dataUrl : '' };
  const open = get().composer;
  if (open && open.type !== 'agree' && !open.busy) {
    updateComposer({ attachments: [...open.attachments, att] });
    set({ drawer: get().narrow ? true : get().drawer, sidebar: true });
    toast('Screenshot attached to the open comment.', { tone: 'ok', timeout: 2500 });
    return;
  }
  openComposer({ capture, attachments: [att] });
  if (!get().composer) toast('The screenshot was saved but no comment could be opened for it.', { tone: 'warn' });
}

/**
 * \ : the thread drawer (narrow) or the side panel (wide), for this page; whether it is open when a doc opens is a
 * setting (prefs.panelOpen).
 */
export function toggleSidebar() {
  const s = get();
  if (s.narrow) set({ drawer: !s.drawer, nav: false });
  else set({ sidebar: !s.sidebar });
}

/**
 * Whether the outline / history rail is shown beside the doc (900 px and up; below, it is a drawer): the page's own
 * choice (railOpen), else the Outline rail setting: auto shows it at 1200 px and up and, between 900 and 1199 px,
 * when the reviewer opened it there (remembered); always / never.
 * @param {UiState} s
 */
export function railShown(s) {
  if (s.narrow) return false;
  if (s.railOpen != null) return s.railOpen;
  if (s.prefs.railMode === 'always') return true;
  if (s.prefs.railMode === 'never') return false;
  return s.medium ? s.rail : true;
}

/** Whether the top bar shows the menu button that opens / closes the outline (drawer or rail). @param {UiState} s */
export function railToggleShown(s) {
  return s.narrow || s.medium || s.prefs.railMode !== 'auto' || s.railOpen != null;
}

/**
 * The menu button (and the palette's "Toggle outline rail"): the outline drawer below 900 px; from 900 px the
 * outline / history rail. With the Auto setting between 900 and 1199 px, where it is collapsed by default so the doc
 * keeps its width, the choice is remembered; otherwise it holds for this page.
 */
export function toggleNav() {
  const s = get();
  if (s.narrow) {
    set({ nav: !s.nav, drawer: false });
    return;
  }
  if (s.prefs.railMode === 'auto' && s.medium && s.railOpen == null) {
    set({ rail: !s.rail });
    writePref('rail', s.rail ? '0' : '1');
    return;
  }
  set({ railOpen: !railShown(s) });
}

/** @param {string} filter */
export function setFilter(filter) {
  set({ filter: /** @type {any} */ (filter) });
}

/** @param {'unified'|'split'} layout */
export function setSourceLayout(layout) {
  set({ sourceLayout: layout });
  writePref('sourceLayout', layout);
}

// ============================================================================================ dialogs & preferences

/**
 * Opens a dialog. Dialogs are exclusive, so this closes the one that is open (the Submit dialog keeps what was
 * typed in it: submitForm).
 * @param {'palette'|'settings'|'help'} name
 */
export function openDialog(name) {
  set({ dialog: name, lightbox: null });
  if (name === 'settings') loadAbout();
  if (name === 'palette' || name === 'settings') loadDocList();
}

/** Cmd/Ctrl+K, Cmd/Ctrl+, and Cmd/Ctrl+/ open their dialog, or close it when it is the one open. @param {'palette'|'settings'|'help'} name */
export function toggleDialog(name) {
  if (get().dialog === name) closeDialog();
  else openDialog(name);
}

const PREF_KEYS = /** @type {const} */ ({
  railMode: 'railMode', panelOpen: 'sidebar', singleKeys: 'singleKeys', onNewVersion: 'onNewVersion',
  confirmSendNow: 'confirmSendNow', defaultVerdict: 'defaultVerdict',
});

/**
 * Changes a preference (Settings): applied at once and remembered in this browser.
 * @template {keyof import('./state.js').Prefs} K
 * @param {K} name
 * @param {import('./state.js').Prefs[K]} value
 */
export function setPref(name, value) {
  const s = get();
  if (s.prefs[name] === value) return;
  set({ prefs: { ...s.prefs, [name]: value } });
  writePref(PREF_KEYS[name], typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  if (name === 'singleKeys') guest.send(MSG.SET_PREFS, { singleKeys: !!value });
  if (name === 'railMode') set({ railOpen: null });
  if (name === 'panelOpen' && !s.narrow) set({ sidebar: !!value });
}

/** Single-letter shortcuts on / off (the palette command; Settings has the same switch). */
export function toggleSingleKeys() {
  const on = !get().prefs.singleKeys;
  setPref('singleKeys', on);
  toast(on ? 'Single-letter shortcuts are on.' : 'Single-letter shortcuts are off. Every action is still in the command palette and on the buttons.', { timeout: 4000 });
}

/** Settings > About: the daemon's version (GET /api/health) and the ports in use. */
export async function loadAbout() {
  const contentPort = (() => {
    const base = get().ds?.contentBase;
    try {
      return base ? new URL(base).port : '';
    } catch {
      return '';
    }
  })();
  const uiPort = location.port;
  set((s) => ({ about: { version: s.about?.version ?? null, uiPort, contentPort } }));
  try {
    const h = await api.health();
    set((s) => ({ about: { ...(s.about || { uiPort, contentPort }), version: h?.version ? String(h.version) : null } }));
  } catch {
    /* the version stays unknown */
  }
}

/** Every tracked doc (GET /api/docs) for "Open another document" and the workspace root; one request at a time. */
export function loadDocList() {
  if (docListLoading) return docListLoading;
  docListLoading = (async () => {
    try {
      const docs = await api.docs();
      set({ home: { docs: Array.isArray(docs) ? docs : [], error: null } });
    } catch (err) {
      set((s) => ({ home: { docs: s.home.docs, error: errorText(err) } }));
    } finally {
      docListLoading = null;
    }
  })();
  return docListLoading;
}

/** The open doc's workspace root (from the doc list), or null while unknown. @param {UiState} s */
export function workspaceRoot(s) {
  const r = s.route;
  if (r.view !== 'doc') return null;
  const d = (s.home.docs || []).find((/** @type {any} */ x) => x.ws === r.ws && x.id === r.doc);
  return d?.root ? String(d.root) : null;
}

/** Absolute path of the spec when the workspace root is known, else its workspace-relative path. @param {UiState} s */
export function specPath(s) {
  const rel = String(s.ds?.doc?.path || '');
  const root = workspaceRoot(s);
  if (!root || !rel || /^([a-z]:)?[\\/]/i.test(rel)) return rel;
  return `${root.replace(/[\\/]+$/, '')}/${rel}`;
}

// ============================================================================================ palette commands

/** The thread the keyboard / palette actions apply to (the focused card), or null. */
export function focusedThread() {
  const s = get();
  return (s.ds?.threads || []).find((/** @type {any} */ t) => t.id === s.focusedId) || null;
}

/** x: resolve / accept the focused thread. Returns false when there is nothing to resolve. */
export function acceptFocused() {
  const t = focusedThread();
  if (!t || t.status === 'resolved') return false;
  resolveThread(t.id);
  return true;
}

/** o: reopen the focused thread (a resolved one directly, another with a reopening reply). */
export function reopenFocused() {
  const t = focusedThread();
  if (!t) return false;
  if (t.status === 'resolved') unresolveThread(t.id);
  else startReply(t.id, { reopen: true });
  return true;
}

/** y: accept the agent's decline of the focused thread. */
export function acceptDecline() {
  const t = focusedThread();
  if (!t || t.status !== 'declined') return false;
  resolveThread(t.id);
  return true;
}

/** c / s / q / a: comment, suggest, ask or mark agreed on the selection (doc text, or Source lines for c). @param {'c'|'s'|'q'|'a'} key */
export function selectionAction(key) {
  const s = get();
  const action = /** @type {Record<string, string>} */ ({ c: 'comment', s: 'suggest', q: 'question', a: 'agree' })[key];
  const caps = kindCaps(s.ds);
  if (key === 'a' && !caps.locks) return false;
  if (!caps.frame) {
    // a kind view without the doc frame (a code review): its own selection (the selected lines)
    if (s.mode === 'history') return false;
    const capture = kindSelection?.() || null;
    if (capture) openComposer({ capture, action });
    else toast('Click a line number (shift-click for a range), then press C.', { timeout: 3000 });
    return true;
  }
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

/**
 * Shows the thread list with a filter (Verify queue, palette filters, the status bar's Orphans): the thread panel
 * (or drawer), on its Threads tab in Changes mode.
 * @param {string} filter
 * @param {{ review?: boolean }} [opts] review: switch to Review mode first
 */
export function showThreads(filter, opts = {}) {
  if (opts.review && get().mode !== 'review') setMode('review');
  setFilter(filter);
  const s = get();
  set({ sidePane: 'threads', drawer: s.narrow ? true : s.drawer, sidebar: true });
}

/** "Submit review as ...": the Submit dialog with that verdict chosen. @param {'comment'|'changes_requested'|'approved'} verdict */
export function submitWithVerdict(verdict) {
  if (!get().ds) return;
  updateSubmitForm({ verdict });
  openSubmit();
}

/** localStorage key of the "seen" marks of the comparison shown (base -> version), or null off a doc. @param {UiState} s */
export function seenStorageKey(s) {
  const r = s.route;
  return r.view === 'doc' ? `specreview.seen.${r.ws}/${r.doc}.${s.base}-${s.version}` : null;
}

/** The hunk ids marked seen in a comparison. @param {string|null} key @returns {Set<string>} */
export function readSeen(key) {
  if (!key) return new Set();
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(v) ? v.map(String) : []);
  } catch {
    return new Set();
  }
}

/**
 * Marks changes of the comparison shown as seen (or not); kept per comparison in localStorage.
 * @param {string[]} ids
 * @param {boolean} on
 */
export function setChangesSeen(ids, on) {
  const key = seenStorageKey(get());
  if (!key) return;
  const seen = readSeen(key);
  for (const id of ids) {
    if (on) seen.add(id);
    else seen.delete(id);
  }
  try {
    localStorage.setItem(key, JSON.stringify([...seen]));
  } catch {
    /* storage unavailable: the marks last for this page only */
  }
  set((s) => ({ seenRev: s.seenRev + 1 }));
}

/** "Mark all changes seen" for the comparison shown. */
export function markAllChangesSeen() {
  const hunks = get().changes?.hunks || [];
  setChangesSeen(hunks.map((/** @type {any} */ h) => String(h.id)), true);
  toast(`${hunks.length} change${hunks.length === 1 ? '' : 's'} marked seen.`, { tone: 'ok', timeout: 2500 });
}

/** Opens the working-copy banner's "Record as my revision" form (it asks for a summary first). */
export function startRecording() {
  const s = get();
  if (!s.ds?.working?.dirty || s.ds.working.missing) return;
  set({ recording: true });
}

/** Closes the "Record as my revision" form. */
export function stopRecording() {
  set({ recording: false });
}

/** Ends the review session (like `specreview close`): a waiting agent stops waiting. */
export async function closeSession() {
  const c = client;
  if (!c) return;
  try {
    await c.close();
  } catch (err) {
    toast(`Could not close the session: ${errorText(err)}`, { tone: 'danger' });
    return;
  }
  await refreshNow();
}

/** Copies the review URL of the open doc, with the access token like `specreview open` prints it. */
export async function copyReviewLink() {
  const r = get().route;
  if (r.view !== 'doc') return;
  const t = token();
  const url = `${location.origin}${docPath(r.ws, r.doc)}${t ? `?k=${encodeURIComponent(t)}` : ''}`;
  toast(await copyText(url)
    ? 'Review link copied. It carries your access token and works on this machine only.'
    : 'Copy failed.', { timeout: 4000 });
}

/** Copies the "tell the agent" prompt (the one the Submit dialog offers when no agent is listening). */
export async function copyAgentPrompt() {
  const ds = get().ds;
  if (!ds) return;
  toast(await copyText(agentPrompt(ds)) ? 'Prompt copied. Paste it into your agent\'s chat.' : 'Copy failed; select the text instead.', { timeout: 3000 });
}

/** Copies the spec's path (absolute once the workspace root is known). */
export async function copySpecPath() {
  if (!get().ds) return;
  if (!workspaceRoot(get())) await loadDocList();
  const path = specPath(get());
  toast(await copyText(path) ? `Copied ${path}` : 'Copy failed.', { timeout: 3000 });
}

// ============================================================================================ toasts

/**
 * @param {string} text
 * @param {{ tone?: string, timeout?: number, actions?: Array<{ label: string, run: () => void }> }} [opts]
 */
export function toast(text, opts = {}) {
  const id = ++toastSeq;
  const item = { id, text, tone: opts.tone || 'info', actions: opts.actions || [] };
  set((s) => ({ toasts: [...s.toasts.slice(-4), item] }));
  const timeout = opts.timeout ?? (item.actions.length ? 10000 : 5000);
  if (timeout > 0) setTimeout(() => dismissToast(id), timeout);
  return id;
}

/** @param {number} id */
export function dismissToast(id) {
  set((s) => (s.toasts.some((t) => t.id === id) ? { toasts: s.toasts.filter((t) => t.id !== id) } : null));
}

// ============================================================================================ misc

/** @param {unknown} err */
export function errorText(err) {
  const e = /** @type {any} */ (err);
  return String(e?.message || e || 'Unknown error');
}

/**
 * @param {any[]} items
 * @param {any} item
 */
function upsert(items, item) {
  const i = items.findIndex((x) => x.id === item.id);
  if (i < 0) return [...items, item];
  const out = items.slice();
  out[i] = item;
  return out;
}

/** Current anchor of a thread at the selected version (for components). @param {any} thread */
export function currentAnchor(thread) {
  return anchorAt(thread, get().version);
}

onConnection((conn) => set({ conn }));
onReconnect(() => {
  const r = get().route;
  if (r.view === 'doc') refreshNow();
  else loadHome();
});
