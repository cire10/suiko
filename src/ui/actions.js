// @ts-check
// The UI controller: every user intent and every server / guest event goes through a function here. Components
// read the store and call these functions; nothing else talks to the API, the event stream or the guest.
//
// Rules this module enforces:
// - Guest messages never mutate server state (amendments 7). `action` only opens a composer, and `activate` / `key`
//   only move focus or toggle UI. Every API mutation starts from a click or key press in the UI.
// - The UI never switches versions or reloads the doc while a composer, a reply or the Send dialog is open
//   (design 11.7). A newer version then only raises a banner, and Approve is refused until the reviewer has looked
//   at the newest version. Settings > When Claude records a new version: "Show the new version" (onNewVersion
//   'latest', the default) moves the view to a new head only from Read or Review while nothing is open (no dialog,
//   menu, popover, capture tool or text selection in the doc either), keeps the reader's place, and says "Updated to
//   vN · Show changes", otherwise "vN is ready · Show"; "Just tell me" ('toast') never moves it: a toast says what
//   arrived ("Claude recorded vN · 1 changed"); "Show what changed" ('changes') shows the new version's changes on the
//   same conditions (in any mode), else the same toast. The reviewer's own record from this page (Record as my
//   revision, Re-snapshot) is not announced: its toast says it and the view shows it, whatever the setting.
// - Sending follows Settings > Send comments: right away (sendMode 'now', the default: a comment, a reply, a draft's
//   Send or Use in doc goes out as a one-item review at once) or as drafts until the reviewer sends the review
//   ('batch'). Every review carries `edits` (Settings > Doc edits, model.js reviewEdits: batched on long docs by
//   default). Apply planned changes is a review with `apply` and `draftIds: []`, so pending drafts stay drafts.
//   One-item sends (Send, a reply's Send, a draft's Send, Use in doc, Apply) are `instant`: they do not move "since
//   your last review" (the Send dialog and Approve do, and so does the reviewer finishing a round: finishRound).
// - One copy of a comment, always: a composer or reply box stays bound to the draft it edits or created (a Send whose
//   review request failed keeps the box open with the error; its retry saves and sends that same draft, and never
//   turns a missing draft into a new one), the bound draft's card says "Being edited" and has no Send of its own,
//   anything that sends the draft closes the box, Cancel deletes a draft the box created, and a held key never sends
//   twice (auto-repeat is ignored).
// - Typed input is never dropped silently: replacing or closing a composer / reply that holds input is refused or
//   offers Undo, and Esc pressed inside the doc never discards it.
// - Requests that finish after the user moved on (another doc / version) are dropped.
// - Snips: `b` snips an area of the doc (the guest draws the box and posts `action` with a SnipCapture and its crop,
//   which opens the composer like any capture); Shift+B asks the daemon to run the macOS region picker and attaches
//   the screenshot to a composer. Neither sends anything: the comment goes out on Send / Save as draft.
// - Dialogs are exclusive (openDialog): the command palette, Settings, the keyboard shortcuts, Send, Document info,
//   the image viewer and an agent's HTML attachment shown large replace each other; what was typed in the Send dialog
//   lives in the store and survives that. Menus and popovers (components/Menu.js) are not dialogs: they keep their
//   own state.
// - The thread panel's filter follows model.js defaultFilter (Your turn, else the agent's, else All) until the
//   reviewer picks one for the doc (setFilter pins it).
// - Preferences (setPref) apply at once and are remembered per browser; single-letter shortcuts are mirrored to the
//   guest (setPrefs, and init.prefs), so it stops acting on c / s / q / a / b itself when they are off.
// - A doc opens with the thread panel only when it has threads or drafts (or opens on its changes); the first thread
//   or draft that arrives, or Changes, opens it then (panelAuto).
// - Toasts: an identical toast replaces the one on screen instead of stacking; "Sent to Claude." says "Saved for
//   Claude. It gets it when it connects." while the agent is not connected.

import { MSG, SSE } from 'protocol';
import { api, docApi, onConnection, onReconnect, token } from './api.js';
import { followScroll, pairHeadings, swapAnchors, syncAnchors } from './compare-sync.js';
import { baseGuest, guest } from './frame.js';
import {
  acceptableThreads, agentName, agentPrompt, agentTitle, anchorAt, anchorColumn, applicablePlanned, applyErrorText,
  backupHasInput, baseTag, declinedToVerify, defaultBase, defaultFilter, draftVersion, isComposerDirty, hasMode,
  isReplyDirty, kindCaps, normalizeFilter, numericVersion, openingMode, panelItems, plainMode, presenceInfo,
  replyDraftsFor, reviewEdits, revisionsToAccept, roundResults, showsDoc, staleApproveText, suggestionMode,
  sendModeOf, threadAttachmentName, turnReason, USE_REPLY_BODY, versionNumbers,
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
/**
 * Where the reader was in the doc frame (its last `scroll` report): the element at the top and the heading text, and
 * the reading place another version can find (readingPlace).
 * @type {{ version: number|'live'|null, srid: number, offset: number, heading: string|null, place?: ReadingPlace }|null}
 */
let lastScroll = null;
/** @type {(NonNullable<typeof lastScroll> & { precise?: boolean })|null} */
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
 * A new version to show in Changes once a refresh brought it in (Settings: "Show what changed"), with its
 * announcement (VersionNote).
 * @type {(VersionNote & { until: number })|null}
 */
let autoChanges = null;
/**
 * onNewVersion 'latest' (Settings): a version announced by the event stream, until the refresh that brings it in is
 * done (flushLatest), and the last move of the view to a new head that refreshNow made for it.
 * @type {{ v: number, until: number }|null}
 */
let latestAnnounced = null;
/** @type {{ from: number, to: number }|null} */
let lastFollow = null;
/**
 * The reviewer's own versions made from this page (Record as my revision, a code review's Re-snapshot, Apply now of a
 * suggestion; ownRecord): the requests in flight per doc client, and the versions they made on the doc shown. Their
 * version.created events announce nothing (announceVersion): the request's own toast says it, and ownRecord shows it.
 * @type {Map<object, number>}
 */
const ownRecords = new Map();
/** @type {Set<number>} */
const ownVersions = new Set();
/** The next version the doc frame loads keeps the reader's place precisely (restoreScroll), not just the heading. */
let restoreAt = false;
/** The doc list request in flight (loadDocList). */
/** @type {Promise<void>|null} */
let docListLoading = null;
/** The mode the reviewer left for Changes (Read or Review), where turning "Show changes" off goes back to. */
/** @type {'read'|'review'|null} */
let changesReturn = null;

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
    route: { view: 'home' }, ds: null, composer: null, reply: null, decision: null, dialog: null, submitForm: null, busyThreads: [], targets: null,
    changes: null,
  });
  document.title = 'Suiko';
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
  changesReturn = null;
  set({
    route: { view: 'doc', ws, doc },
    ds: null,
    loadError: null,
    version: null,
    followHead: true,
    mode: 'review',
    base: null,
    baseKind: 'last',
    filter: 'all',
    filterPinned: false,
    focusedId: null,
    activeHunk: null,
    targets: null,
    changes: null,
    changesError: null,
    composer: null,
    reply: null,
    decision: null,
    tool: 'select',
    drawer: false,
    sidebar: get().prefs.panelOpen,
    panelAuto: false,
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
  latestAnnounced = null;
  lastFollow = null;
  ownVersions.clear();
  restoreAt = false;
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
  // Settings > Reading > Open documents in: the latest version in Review by default (no change highlights; the
  // Changes tab counts what is new); 'auto' opens on "since my last review" when the agent has revised since.
  const mode = openingMode(ds, get().prefs.openIn);
  // The thread panel (Settings: open by default) only when there is something in it: a doc without threads or drafts
  // keeps its whole width (a rich report keeps its desktop layout) until the first comment or thread (panelAuto).
  // Opening on its changes keeps it: the Changes list lives there.
  const panel = get().prefs.panelOpen;
  const empty = !hasThreadsOrDrafts(ds) && mode !== 'changes';
  set({
    ds, version: head, mode, base: defaultBase(ds, head, 'last'), baseKind: 'last', filter: defaultFilter(ds, head),
    sidebar: panel && !empty, panelAuto: panel && empty,
  });
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
    if (!(/** @type {any} */ (err).offline)) console.warn('suiko: refresh failed', err);
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
    // Settings > When Claude records a new version: 'latest' moves to it only while the reviewer reads the previous
    // head in Read or Review and is in the middle of nothing (followsLatest), keeping the place they read at. "Just
    // tell me" ('toast') never moves the view: the toast and the banner say a new version is there. 'changes' moves
    // to it only to show its changes, once this refresh brought it in (flushAutoChanges).
    if (onHead && s.prefs.onNewVersion === 'latest' && followsLatest(s)) {
      patch.version = head;
      patch.base = defaultBase(ds, head, s.baseKind === 'custom' ? 'last' : s.baseKind);
      patch.newHead = null;
      versionChanged = true;
      lastFollow = { from: prevHead, to: head };
      restoreAt = true;
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
  deselectHiddenResolved();
  flushLatest();
  await Promise.all([loadTargets(), loadChanges()]);
  flushAutoChanges();
}

/** Whether a menu or popover (components/Menu.js, their own state) is open: a new version then never moves the view. */
function menuOpen() {
  return typeof document !== 'undefined' && !!document.querySelector('.popover');
}

/**
 * onNewVersion 'latest': whether the view may move to a new head on its own. Only from Read or Review (Changes,
 * Source and History are about versions the reviewer picked), and never while they are in the middle of something
 * (mayMoveView).
 * @param {UiState} s
 */
function followsLatest(s) {
  return (s.mode === 'read' || s.mode === 'review') && mayMoveView(s);
}

/**
 * Whether a new version may move the view on its own ('latest' and 'changes'): never while the reviewer is in the
 * middle of something: a composer or reply (holdsView), a dialog, a menu or popover, the record form, pick / snip, a
 * screen snip, or a text selection in the doc or lines selected in Source (the first step of a comment).
 * @param {UiState} s
 */
function mayMoveView(s) {
  return canAutoSwitch(s) && !menuOpen() && !s.guest.selection && !s.sourceSel;
}

/**
 * onNewVersion 'latest': once the version announced is in (see announceVersion), one toast says what happened: the
 * view moved to it ("Updated to v4", with Show changes from the version the reviewer was reading), or it did not
 * ("v4 is ready", with Show). A version that never arrives is announced as ready after a while.
 */
function flushLatest() {
  const p = latestAnnounced;
  if (!p) return;
  const s = get();
  if (!versionNumbers(s.ds).includes(p.v)) {
    if (Date.now() > p.until) {
      latestAnnounced = null;
      readyToast(p.v);
    }
    return;
  }
  latestAnnounced = null;
  const moved = lastFollow && lastFollow.to >= p.v && s.version === lastFollow.to ? lastFollow : null;
  lastFollow = null;
  if (moved) {
    toast(`Updated to v${moved.to}`, {
      tone: 'info',
      timeout: 10000,
      actions: [{ label: 'Show changes', run: () => compareVersions(moved.from, moved.to) }],
    });
  } else {
    readyToast(p.v);
  }
}

/** "vN is ready · Show": a new version the view did not move to. @param {number} v */
function readyToast(v) {
  toast(`v${v} is ready`, { tone: 'info', timeout: 15000, actions: [{ label: 'Show', run: () => showNewVersion(v) }] });
}

/**
 * The "Show" of "vN is ready": the new version in the mode the reviewer is in (its changes in Changes; History
 * shows it in Review). Refused, with the usual toast, while a comment or reply is open.
 * @param {number} v
 */
export function showNewVersion(v) {
  const s = get();
  if (!s.ds) return;
  set({ unseenVersion: null });
  updateTitle();
  if (s.mode === 'changes') {
    reviewChanges(v);
    return;
  }
  if (s.mode === 'history') {
    viewVersion(v);
    return;
  }
  if (switchVersion(v)) set({ followHead: v === Number(get().ds?.doc?.head), newHead: null });
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
 * onNewVersion 'changes': shows the announced version in Changes once the refresh that brings it in is done (see
 * announceVersion). When the reviewer started something meanwhile (a comment, a dialog, a menu, a selection), or the
 * version never arrives, the "Just tell me" toast says it instead.
 */
function flushAutoChanges() {
  const p = autoChanges;
  if (!p) return;
  const s = get();
  if (!versionNumbers(s.ds).includes(p.v)) {
    if (Date.now() > p.until) {
      autoChanges = null;
      versionToast(p);
    }
    return;
  }
  autoChanges = null;
  if (!mayMoveView(s)) {
    versionToast(p);
    return;
  }
  reviewChanges(p.v);
  toast(`${p.text}. Showing what changed.`, {
    tone: 'info',
    timeout: 8000,
    actions: p.forYou ? [{ label: 'Show my turn', run: () => showMyTurnOn(p.v) }] : [],
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
 * `suiko snip` (from a terminal or a macOS Shortcut) added a screenshot draft: a toast says so, with [Edit] to
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

/**
 * A new version as the "Just tell me" note says it: "Claude recorded v3 · 1 changed, 1 needs your answer" (`text`);
 * `forYou`: some of its replies wait for the reviewer (changed, or a question), so the note offers Show my turn.
 * @typedef {{ v: number, text: string, forYou: boolean }} VersionNote
 */

/**
 * The note of a `version.created` event (VersionNote): who recorded it (the agent's name; "You" for the reviewer's
 * own revision) and what its replies did.
 * @param {any} data {v, author: 'agent:claude' | 'human:Eric', counts?: {addressed, needs_input | needsInput}}
 * @returns {VersionNote}
 */
function versionNote(data) {
  const v = Number(data?.v);
  const counts = data?.counts || {};
  const n = (/** @type {string} */ k) => Number(counts[k]) || 0;
  const changed = n('addressed');
  const needs = n('needs_input') || n('needsInput');
  const tally = [];
  if (changed) tally.push(`${changed} changed`);
  if (needs) tally.push(`${needs} ${needs === 1 ? 'needs' : 'need'} your answer`);
  const { kind, name } = versionAuthor(data);
  const who = kind === 'human' ? 'You' : agentTitle(name || agentName(get().ds));
  return { v, text: `${who} recorded v${v}${tally.length ? ` · ${tally.join(', ')}` : ''}`, forYou: changed + needs > 0 };
}

/**
 * Who recorded the version of a `version.created` event: `author` is 'agent:claude' / 'human:Eric' or {kind, name}.
 * @param {any} data
 * @returns {{ kind: string, name: string }}
 */
function versionAuthor(data) {
  const author = typeof data?.author === 'string' ? data.author
    : data?.author?.kind ? `${data.author.kind}:${data.author.name ?? ''}` : '';
  const colon = author.indexOf(':');
  return { kind: colon > 0 ? author.slice(0, colon) : '', name: colon > 0 ? author.slice(colon + 1) : author };
}

/** Toast + tab-title badge for a new version (design 11.7). @param {any} data */
function announceVersion(data) {
  const v = Number(data?.v);
  if (!Number.isFinite(v)) return;
  // The reviewer's own version from this page (ownVersions; or one still in flight on this doc, whose event can come
  // before its answer): its toast says it and ownRecord shows it, whatever the setting below says (it is about the
  // agent's versions).
  if (ownVersions.has(v) || ((client && ownRecords.get(client)) && versionAuthor(data).kind === 'human')) return;
  set({ unseenVersion: v });
  updateTitle();
  const pref = get().prefs.onNewVersion;
  if (pref === 'latest') {
    // The refresh that follows this event brings the version in, and moves the view to it when it may (refreshNow).
    latestAnnounced = { v, until: Date.now() + 10000 };
    flushLatest();
    return;
  }
  const note = versionNote(data);
  if (pref === 'changes' && mayMoveView(get())) {
    // Settings: "Show what changed". The refresh that follows this event brings the version in.
    autoChanges = { ...note, until: Date.now() + 10000 };
    return;
  }
  // "Just tell me" (or nothing may move now): the view stays where it is
  versionToast(note);
}

/**
 * The "Just tell me" note of a new version the view did not move to: "Claude recorded v3 · 1 changed" with Show
 * changes and Show my turn when some of it waits for the reviewer, else Show and Show changes.
 * @param {VersionNote} note
 */
function versionToast({ v, text, forYou }) {
  toast(text, {
    tone: 'info',
    timeout: 15000,
    actions: forYou
      ? [{ label: 'Show changes', run: () => reviewChanges(v) }, { label: 'Show my turn', run: () => showMyTurnOn(v) }]
      : [{ label: 'Show', run: () => showNewVersion(v) }, { label: 'Show changes', run: () => reviewChanges(v) }],
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

/** The "Show my turn" of the 'toast' and 'changes' version notes: version v in Review, the panel on Your turn. @param {number} v */
export function showMyTurnOn(v) {
  const s = get();
  if (s.version !== v && s.ds && !switchVersion(v)) return;
  set({ filter: 'mine', filterPinned: true, unseenVersion: null, sidePane: 'threads', drawer: get().narrow ? true : get().drawer, sidebar: true });
  deselectHiddenResolved();
  if (get().mode !== 'review') setMode('review');
  updateTitle();
}

export function updateTitle() {
  const s = get();
  const title = s.ds?.doc?.title || s.ds?.doc?.id || 'Suiko';
  document.title = `${s.unseenVersion != null ? `(v${s.unseenVersion}) ` : ''}${title} · Suiko`;
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
    if (!(/** @type {any} */ (err).offline)) console.warn('suiko: cannot load targets', err);
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
  guest.send(MSG.SET_CHANGES, { changes: mainChanges(get()) });
  pushBaseChanges();
}

/** Nothing is drawn over the doc: the reviewer hid the annotations (h), or Read mode. @param {UiState} s */
export function annotationsHidden(s) {
  return s.hidden || s.mode === 'read';
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
    changes: mainChanges(s),
    activeId: s.focusedId,
    activeHunk: s.activeHunk,
    hidden: annotationsHidden(s),
    prefs: { singleKeys: s.prefs.singleKeys, scrollSync: splitShown(s) },
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
  pendingRestore = lastScroll ? { ...lastScroll, precise: restoreAt } : null;
  restoreAt = false;
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

// ============================================================================================ side by side
//
// Changes side by side is "compare focus": the older version in a second, read-only frame beside the newer one
// (ComparePane), the compare bar over both (CompareBar), and the doc area to itself: entering it hides the outline
// rail and the thread panel (the reviewer can still open them while comparing; a comment being written keeps the
// panel), leaving it puts back what it hid. Whatever starts or ends it (the Inline / Side by side switch, the palette,
// the Changes tab with the layout remembered, Done, another mode, a narrow window, another doc) goes through
// splitShown, and one store subscriber (below) applies the focus on the way in and restores it on the way out, so
// every path behaves the same. The newer version's frame never moves in the DOM (it is never reloaded).
// Scroll sync: the frame the reader scrolls leads and the other one follows it (compare-sync.js lines the versions up
// on matched headings and on both ends of every change, from both guests' positions). Scrolls the UI itself asks for
// (a follow, a change step) come back marked byUi and are never echoed. The change stepper (goToHunk: n / p, the
// bar's arrows, a change in the list) puts the change a third down both frames, level, and marks it on both sides.

/**
 * The outline of the older version's frame (from its guest's `ready`): headings to line the two versions up.
 * @type {Array<{ srid: number, level: number, text: string }>}
 */
let baseOutline = [];
/** The older version's frame was lined up with the newer one since it loaded. */
let baseLinedUp = false;
/** The frame the pointer is over (setSyncLeader): when both frames report a scroll of their own at once, it leads. */
/** @type {'main'|'base'} */
let pointerSide = 'main';
/** The reader's last own scroll (not one the UI asked for): in which frame, when. */
let lastOwnScroll = { side: /** @type {'main'|'base'} */ ('main'), at: 0 };
/**
 * pairHeadings of the two outlines, kept while they are the same arrays.
 * @type {{ main: any[]|null, base: any[]|null, pairs: Array<[number, number]> }}
 */
let headingPairs = { main: null, base: null, pairs: [] };

/**
 * Whether Changes shows the older version beside the newer one: the layout is 'split', the window is wide, there is
 * an older version to show, and the doc kind has a rendered frame.
 * @param {UiState} s
 */
export function splitShown(s) {
  return s.mode === 'changes' && s.compareLayout === 'split' && !s.narrow && s.base != null && s.version != null
    && !!s.ds && kindCaps(s.ds).frame;
}

/** URL of the older version's frame of Changes side by side, or null when it is not shown. @param {UiState} s */
export function baseFrameUrl(s) {
  if (!splitShown(s) || !s.ds?.contentBase) return null;
  return docUrl(s.ds.contentBase, /** @type {number} */ (s.base), s.ds.doc.path);
}

/**
 * Inline (the changes drawn over the newer version) or side by side (the older version beside it): enterCompare /
 * exitCompare. The only entry other components use.
 * @param {'inline'|'split'} layout
 */
export function setCompareLayout(layout) {
  if (layout === 'split') enterCompare();
  else exitCompare();
}

/** @param {'inline'|'split'} layout */
function rememberLayout(layout) {
  if (get().compareLayout === layout) return;
  set({ compareLayout: layout });
  writePref('compareLayout', layout);
}

/**
 * Side by side (compare focus, see above), from any mode: it is a Changes layout, so it switches to Changes.
 * Remembered per browser: Changes opens side by side until the reviewer chooses Inline or Done. Below the wide
 * breakpoint the changes stay inline (and say so).
 */
export function enterCompare() {
  rememberLayout('split');
  if (get().mode !== 'changes') setMode('changes');
  if (get().narrow) toast('Side by side needs a wider window; the changes are shown inline.', { timeout: 3500 });
}

/**
 * Leaves side by side. Inline (the switch, the palette): the changes drawn over the newer version, still in Changes.
 * Done (the compare bar): back to the mode the reviewer was in before side by side (Changes, inline, when it was
 * Changes).
 * @param {{ done?: boolean }} [opts]
 */
export function exitCompare({ done = false } = {}) {
  const from = get().compareFocus?.from ?? null;
  rememberLayout('inline');
  if (done && from && from !== 'changes' && get().mode === 'changes') setMode(from);
}

/**
 * Entering compare focus: remembers the thread panel and the outline rail, and hides both (a comment or reply being
 * written keeps the panel).
 * @param {UiState} s @param {import('./state.js').Mode} from the mode before side by side
 */
function beginCompareFocus(s, from) {
  set({
    compareFocus: { from, sidebar: s.sidebar, railOpen: s.railOpen },
    sidebar: s.composer || s.reply ? s.sidebar : false,
    railOpen: false,
  });
  baseLinedUp = false;
  lastOwnScroll = { side: 'main', at: 0 };
}

/**
 * Leaving compare focus: the panel and the rail as they were, unless the reviewer opened them meanwhile (kept open).
 * Another doc opening (no DocState yet) keeps its own defaults.
 * @param {UiState} s
 */
function endCompareFocus(s) {
  const f = s.compareFocus;
  if (!f) return;
  if (!s.ds) {
    set({ compareFocus: null, railOpen: s.railOpen === false ? f.railOpen : s.railOpen });
    return;
  }
  set({
    compareFocus: null,
    sidebar: f.sidebar || s.sidebar,
    railOpen: s.railOpen === false ? f.railOpen : s.railOpen,
  });
}

/** The reviewer is pointing at one of the two frames: it leads when both scroll at once. @param {'main'|'base'} side */
export function setSyncLeader(side) {
  pointerSide = side;
}

/** Called by the older version's frame right before it navigates. */
export function baseFrameNavigating() {
  baseGuest.reset();
  baseOutline = [];
  baseLinedUp = false;
  set({ baseConnected: false, basePositions: null });
}

/**
 * The changes the newer version's frame draws: none outside Changes; side by side, marked as such (it then draws
 * deletions as notes and no "was" tabs: the older version beside it shows what was removed).
 * @param {UiState} s
 */
function mainChanges(s) {
  if (s.mode !== 'changes' || !s.changes) return null;
  return splitShown(s) ? { ...s.changes, layout: 'split' } : s.changes;
}

/**
 * The changes placed in the older version (Changes.hunks[].oldSide), for its frame; null while the changes loaded
 * are not the ones from the version that frame shows (the base was just changed).
 * @param {UiState} s
 */
function baseChanges(s) {
  return splitShown(s) && s.changes && Number(s.changes.from) === s.base ? { ...s.changes, side: 'old' } : null;
}

function pushBaseChanges() {
  baseGuest.send(MSG.SET_CHANGES, { changes: baseChanges(get()) });
}

function sendBaseInit() {
  const s = get();
  baseGuest.send(MSG.INIT, {
    mode: 'readonly',
    theme: s.theme,
    targets: [],
    locks: [],
    drafts: [],
    changes: baseChanges(s),
    activeId: null,
    activeHunk: s.activeHunk,
    hidden: annotationsHidden(s),
    prefs: { singleKeys: s.prefs.singleKeys, scrollSync: true },
  });
}

/** The active change, drawn stronger in the doc (and in the older version beside it). */
function pushActiveHunk() {
  const id = get().activeHunk;
  guest.send(MSG.SET_ACTIVE_HUNK, { id });
  baseGuest.send(MSG.SET_ACTIVE_HUNK, { id });
}

/** The anchors lining the two versions up (compare-sync.js), from what both guests reported last. @param {UiState} s */
function compareAnchors(s) {
  if (headingPairs.main !== s.guest.outline || headingPairs.base !== baseOutline) {
    headingPairs = { main: s.guest.outline, base: baseOutline, pairs: pairHeadings(s.guest.outline, baseOutline) };
  }
  return syncAnchors(s.guest.positions, s.basePositions, headingPairs.pairs);
}

/**
 * Lines the other frame up with the one the reader scrolls (see the section header). Ignores scrolls the UI asked for
 * (byUi), and, when both frames report a scroll of their own within a moment (momentum in one, the reader in the
 * other), the one the pointer is not over.
 * @param {'main'|'base'} from
 * @param {any} d SCROLL {y, vh, docH, byUi, ...}
 * @param {boolean} [force] line up whatever (the older version just loaded)
 * @returns {boolean} whether the other frame was told where to go
 */
function syncScroll(from, d, force = false) {
  const s = get();
  if (!splitShown(s) || !d || (d.byUi && !force)) return false;
  const now = Date.now();
  if (!force && from !== lastOwnScroll.side && now - lastOwnScroll.at < 250 && from !== pointerSide) return false;
  const lead = { y: Number(d.y), vh: Number(d.vh), docH: Number(d.docH) };
  const other = from === 'main' ? s.basePositions : s.guest.positions;
  if (!other || !s.guest.positions || !s.basePositions) return false;
  if (![lead.y, lead.vh, lead.docH].every(Number.isFinite)) return false;
  if (!force) lastOwnScroll = { side: from, at: now };
  const anchors = compareAnchors(s);
  const top = followScroll(from === 'main' ? anchors : swapAnchors(anchors), lead,
    { vh: Number(other.viewportH) || lead.vh, docH: Number(other.docH) || lead.docH });
  (from === 'main' ? baseGuest : guest).send(MSG.SCROLL_TO, { top });
  return true;
}

/**
 * Puts a freshly loaded older version where the newer one is, once: as soon as both versions reported their
 * positions (the newer one at its top needs nothing). Later scrolls are the reader's (syncScroll).
 */
function lineUpBase() {
  const s = get();
  const main = s.guest.positions;
  if (baseLinedUp || !splitShown(s) || !main || !s.basePositions) return;
  baseLinedUp = true;
  if (Number(main.scrollY) > 0) {
    syncScroll('main', { y: Number(main.scrollY), vh: Number(main.viewportH), docH: Number(main.docH) }, true);
  }
}

baseGuest.setHandlers({
  onMessage: (type, d) => {
    switch (type) {
      case MSG.READY:
        baseOutline = Array.isArray(d.outline) ? d.outline.filter((/** @type {any} */ h) => h && Number.isFinite(h.srid))
          .map((/** @type {any} */ h) => ({ srid: h.srid, level: Number(h.level) || 1, text: String(h.text ?? '') })) : [];
        set({ baseConnected: true, basePositions: null });
        sendBaseInit();
        return;
      case MSG.POSITIONS:
        set({ basePositions: d });
        lineUpBase();
        return;
      case MSG.SCROLL:
        syncScroll('base', d);
        return;
      case MSG.KEY:
        // marked: a comment key here must not act on the selection the newer frame may still hold
        keyForwarder?.({ ...d, fromBase: true }, true);
        return;
      default:
      // read-only: no selection, captures or targets; page errors are the newer version's to report
    }
  },
});

/**
 * Whether the reviewer is comparing side by side, as they chose it: Changes with the layout 'split'. splitShown can be
 * false meanwhile (a window narrowed below the wide breakpoint for a moment, a newer version picked that has no older
 * one to show): compare focus is kept through that, so its `from` (where Done goes back to) and what it hid stay.
 * @param {UiState} s
 */
function comparing(s) {
  return s.mode === 'changes' && s.compareLayout === 'split' && !!s.ds;
}

/**
 * Keeps what side by side changes elsewhere in step with splitShown, whatever changed it (see the section header):
 * compare focus on the way in (the first time side by side shows) and out (when the reviewer leaves Changes or side by
 * side, not when it only stops showing for a moment: comparing), the newer version's scroll reports (live while side
 * by side) and how it draws the changes; and the active change in both frames.
 */
let prevMode = store.get().mode;
let prevSplit = false;
/** @type {string|null} */
let shownActiveHunk = null;
store.subscribe(() => {
  const s = get();
  const split = splitShown(s);
  if (split && !s.compareFocus) beginCompareFocus(s, prevMode);
  else if (s.compareFocus && !comparing(s)) endCompareFocus(s);
  if (split !== prevSplit) {
    prevSplit = split;
    guest.send(MSG.SET_PREFS, { scrollSync: split });
    pushChanges();
  }
  if (s.activeHunk !== shownActiveHunk) {
    shownActiveHunk = s.activeHunk;
    pushActiveHunk();
  }
  prevMode = s.mode;
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
      lineUpBase();
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
      lastScroll = { version: get().version, srid, offset: Number(d.offset) || 0, heading, place: readingPlace(d, outline) };
      syncScroll('main', d);
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
    case MSG.KEY_KEPT:
      explainKeptKeys();
      return;
    default:
  }
}

/** Docs whose "this document keeps its own keys" note was shown (once per doc while the UI is open). */
const keptKeysExplained = new Set();

/**
 * The document handles keys itself, so a single-letter shortcut pressed in it stayed with it (guest `keyKept`, 85-keys.js):
 * say so once per doc, with what still works.
 */
function explainKeptKeys() {
  const id = get().ds?.doc?.id;
  if (!id || keptKeysExplained.has(id)) return;
  keptKeysExplained.add(id);
  toast('This document has its own keyboard shortcuts, so single-letter keys pressed in it stay with it. Use the tools at the bottom of the document, or select text and press c.', { timeout: 9000 });
}

/**
 * After a reload / version switch: back to the same element, else the same heading (design 11.7). When the view moved
 * to a new version on its own (onNewVersion 'latest'), the reader keeps their place: the same point between the same
 * two headings, else the same point of the whole document (readingPlace).
 * @param {any[]} outline
 */
function restoreScroll(outline) {
  const r = pendingRestore;
  pendingRestore = null;
  if (!r) return;
  if (r.version === get().version) {
    guest.send(MSG.SCROLL_TO, { srid: r.srid, offset: r.offset });
    return;
  }
  const at = r.precise ? placeIn(r.place, outline) : null;
  if (at) {
    guest.send(MSG.SCROLL_TO, { sync: at });
    return;
  }
  const h = r.heading ? outline.find((x) => x.text === r.heading) : null;
  guest.send(MSG.SCROLL_TO, h ? { srid: h.srid } : { srid: r.srid });
}

/** The guest's reading line, this far below the top of the frame (99-main.js READING_LINE). */
const READING_LINE = 8;

/**
 * @typedef {{ a: { text: string, n: number }|null, b: { text: string, n: number }|null, f: number, docF: number|null }} ReadingPlace
 *   a / b: the headings around the reading line (text, and which occurrence of that text; null: the top / the end of
 *   the document); f: how far from a to b the reading line is (0..1); docF: how far down the whole document
 */

/**
 * Where the reader is (from the guest's `scroll` report), in terms another version of the doc can find.
 * @param {any} d SCROLL {heading, next, docTop, docEnd, y, docH}
 * @param {any[]} outline
 * @returns {ReadingPlace}
 */
function readingPlace(d, outline) {
  /** @param {any} h @returns {{ text: string, n: number }|null} */
  const key = (h) => {
    const i = h && Number.isFinite(Number(h.srid)) ? outline.findIndex((x) => x.srid === Number(h.srid)) : -1;
    if (i < 0) return null;
    return { text: outline[i].text, n: outline.slice(0, i).filter((x) => x.text === outline[i].text).length };
  };
  const aTop = d.heading ? Number(d.heading.top) : Number(d.docTop);
  const bTop = d.next ? Number(d.next.top) : Number(d.docEnd);
  const f = Number.isFinite(aTop) && Number.isFinite(bTop) && bTop > aTop ? Math.max(0, Math.min(1, (READING_LINE - aTop) / (bTop - aTop))) : 0;
  const docH = Number(d.docH);
  const docF = docH > 0 && Number.isFinite(Number(d.y)) ? Math.max(0, Math.min(1, (Number(d.y) + READING_LINE) / docH)) : null;
  return { a: d.heading ? key(d.heading) : null, b: d.next ? key(d.next) : null, f, docF };
}

/**
 * The scroll (guest SCROLL_TO {sync}) that puts a reading place into another version's outline: between the same
 * headings when they are there, else at the same fraction of the whole document. Null without a place.
 * @param {ReadingPlace|undefined} p
 * @param {any[]} outline
 * @returns {{ a: number|null, b: number|null, f: number }|null}
 */
function placeIn(p, outline) {
  if (!p) return null;
  /** @param {{ text: string, n: number }|null} k */
  const find = (k) => {
    if (!k) return -1;
    let n = 0;
    for (let i = 0; i < outline.length; i++) {
      if (outline[i].text !== k.text) continue;
      if (n === k.n) return i;
      n++;
    }
    return -1;
  };
  const whole = p.docF == null ? null : { a: null, b: null, f: p.docF };
  const bi = find(p.b);
  if (!p.a) return p.b && bi < 0 ? whole : { a: null, b: bi >= 0 ? outline[bi].srid : null, f: p.f };
  const ai = find(p.a);
  if (ai < 0) return whole;
  const b = !p.b ? null : bi > ai ? outline[bi].srid : outline[ai + 1]?.srid ?? null;
  return { a: outline[ai].srid, b, f: p.f };
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
    toast(`${lock.id}: marked agreed${lock.note && lock.note !== 'Agreed' ? ` (${lock.note})` : ''}. ${agentLabel()} cannot change it.`, {
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
 * The threads whose card holds input (the reply box, a "Record as decision…" being typed): the panel lists them
 * whatever its filter, so the input never disappears with its card (model.js panelItems `keep`).
 * @param {UiState} s
 * @returns {string[]}
 */
export function keptThreads(s) {
  return /** @type {string[]} */ ([s.reply?.threadId, s.decision?.threadId].filter(Boolean));
}

/**
 * Focuses a thread or draft card (and the doc anchor unless the click came from the doc).
 * @param {string} id
 * @param {{ fromDoc?: boolean }} [opts]
 */
export function focusItem(id, opts = {}) {
  // Read mode shows no threads: focusing one is reviewing it
  if (get().mode === 'read') setMode('review');
  const s = get();
  const visible = panelItems(s.ds, s.filter, s.version, keptThreads(s)).some((x) => x.id === id);
  set({
    focusedId: id,
    // a card the filter does not list: All, and the reviewer's choice from now on (the default would hide it again)
    filter: visible ? s.filter : 'all',
    filterPinned: visible ? s.filterPinned : true,
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
  draftToast = toast(`${id} was written on v${dv} and is not shown on ${s.version === 'live' ? 'the working copy' : `v${s.version}`}. It is carried forward to the latest version when you send it.`, {
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
 * The doc draws a resolved thread only while it is selected, so that selection ends with its card: once accepting it
 * or choosing another filter takes it out of the panel, nothing of it stays over the doc.
 */
function deselectHiddenResolved() {
  const s = get();
  if (!kindCaps(s.ds).frame) return;
  const t = (s.ds?.threads || []).find((/** @type {any} */ x) => x.id === s.focusedId);
  if (t?.status !== 'resolved') return;
  const listed = panelItems(s.ds, s.filter, s.version, keptThreads(s)).some((x) => x.id === t.id);
  if (!listed) clearFocus();
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
  const items = panelItems(s.ds, s.filter, s.version, keptThreads(s));
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
  if (get().mode !== 'changes') return;
  guest.send(MSG.SCROLL_TO, { hunk: id });
  // side by side: the older version goes to the same change (its removed text), at the same height; each frame goes
  // there itself, and neither follows the other for it (both scrolls come back marked byUi)
  if (splitShown(get())) baseGuest.send(MSG.SCROLL_TO, { hunk: id });
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

/**
 * Switches the mode. Read shows the latest version (the live working copy stays when that is what is shown), so
 * entering it switches to the head first; it is refused, like any version switch, while a comment is open on an
 * older version.
 * @param {Mode} mode
 */
export function setMode(mode) {
  if (!hasMode(get().ds, mode) || get().mode === mode) return;
  if (mode === 'read') {
    const cur = get();
    const head = Number(cur.ds.doc.head);
    if (cur.version !== 'live' && cur.version !== head && !switchVersion(head)) return;
  }
  const s = get();
  if (mode === 'changes' && (s.mode === 'read' || s.mode === 'review')) changesReturn = s.mode;
  let base = s.base;
  if (base == null) base = defaultBase(s.ds, s.version, s.baseKind === 'custom' ? 'last' : s.baseKind);
  if (s.tool !== 'select') guest.send(MSG.SET_TOOL, { tool: 'select' });
  set({
    mode, base, tool: 'select', sidePane: mode === 'changes' ? 'changes' : s.sidePane,
    unseenVersion: mode === 'changes' || mode === 'read' ? null : s.unseenVersion,
  });
  updateTitle();
  sendInit();
  if (base !== s.base || (!s.changes && base != null)) loadChanges();
}

/**
 * Show changes / Hide changes (the palette; Accept all hides them): Changes (what changed, marked in the doc), or back
 * to the mode the reviewer came from (Read or Review; their Default view when the doc opened on its changes). In the
 * top bar the Changes tab is this switch.
 * @param {boolean} [on] default: the opposite of what is shown
 */
export function showChanges(on = get().mode !== 'changes') {
  const s = get();
  if (!s.ds) return;
  if (on) setMode('changes');
  else if (s.mode === 'changes') setMode(changesReturn ?? plainMode(s.ds, s.prefs.openIn));
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
  const tag = kind === 'last' ? baseTag(s.ds, base) : null;
  const what = tag === 'accepted' ? 'the revisions you accepted' : tag === 'review' ? 'your last review' : 'previous version';
  toast(base == null ? 'No earlier version to compare with.' : `Comparing with v${base} (${what}).`, { timeout: 2500 });
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
  // The selection stays highlighted in the doc; its toolbar would only repeat the composer's choices over that text.
  guest.send(MSG.DISMISS_TOOLBAR);
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
 * new draft instead of an error the editor could never get past. Not for the draft a failed Send created
 * (`recreate` false): that one went out or was deleted by another path, and a second copy must never be made behind
 * the reviewer's back (DraftGoneError says so instead).
 * @param {NonNullable<typeof client>} c
 * @param {string|null} id
 * @param {any} item
 * @param {{ recreate?: boolean }} [opts]
 */
async function saveDraftItem(c, id, item, { recreate = true } = {}) {
  if (!id) return c.createDraft(item);
  try {
    return await c.patchDraft(id, item);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    if (!recreate) throw new DraftGoneError(id);
    return c.createDraft(item);
  }
}

/** The draft a failed Send created is gone (it was sent or deleted elsewhere): nothing was saved or sent again. */
class DraftGoneError extends Error {
  /** @param {string} id */
  constructor(id) {
    super(`Draft ${id} was already sent or deleted, so nothing was sent again. Send once more to send this text as a new comment.`);
    this.draftId = id;
  }
}

/** The version on screen, which a review is about. */
function reviewedVersion() {
  const s = get();
  return numericVersion(s.ds, s.version);
}

/** The `edits` of a review the UI sends (Settings > Doc edits; model.js reviewEdits). */
function currentEdits() {
  const s = get();
  return reviewEdits(s.ds, s.prefs);
}

/** The agent's name as a sentence starts with it ("Claude"). */
function agentLabel() {
  return agentTitle(agentName(get().ds));
}

/**
 * Sends drafts of the pending review to the agent at once, alone: a review with verdict comment (Send, Send now, a
 * draft card's Send, a reply's Send, Use in doc). It carries the review's `edits`, and `instant`: a one-item send
 * does not move "since your last review" (the doc's changes stay new until the reviewer sends a review from the Send
 * dialog, approves, accepts them, or finishes the round).
 * @param {NonNullable<typeof client>} c
 * @param {string[]} draftIds
 */
function sendNow(c, draftIds) {
  return c.submitReview({ verdict: 'comment', body: '', draftIds, reviewedVersion: reviewedVersion(), edits: currentEdits(), instant: true });
}

/**
 * The toast once something went to the agent: "Sent to Claude." while it is connected, else "Saved for Claude. It
 * gets it when it connects." (the feedback waits for its next `suiko wait`). Read before the request: a listening
 * agent stops listening once it gets the feedback.
 * @param {string} [suffix] after the name: ' (rv3)', ': needs changes (rv3)'
 * @param {boolean} [connected] whether the agent was connected when it was sent (default: now)
 */
function sentText(suffix = '', connected = presenceInfo(get().ds).kind !== 'none') {
  const name = agentLabel();
  return connected ? `Sent to ${name}${suffix}.` : `Saved for ${name}${suffix}. It gets it when it connects.`;
}

/**
 * Save as draft / Add to review (a draft of the pending review), or Send / Send now (`sendNow`: the draft, then a
 * one-item review with verdict comment and the review's `edits`). Which button is primary follows Settings > Send
 * comments (Composer.js). With "Ask before sending", a send first shows a confirmation in the composer
 * (confirmSend); confirming it, or pressing the send key again while it shows, sends.
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
  /** The draft holding this comment, once saved (a failed Send keeps the composer bound to it). */
  let saved = '';
  try {
    let cropPath = comp.cropPath;
    if (comp.crop && !cropPath) {
      const r = await c.attachment(comp.crop);
      cropPath = r?.path ? String(r.path) : null;
      updateComposer({ cropPath });
    }
    const item = composerItem(comp, cropPath);
    // A Send whose review request failed already created its draft: a retry saves and sends that one, and never
    // makes a second copy when it is gone.
    const existing = comp.draftId || comp.createdDraftId || null;
    const draft = await saveDraftItem(c, existing, item, { recreate: !!comp.draftId || !comp.createdDraftId });
    const draftId = String(draft?.id ?? existing ?? '');
    saved = draftId;
    if (!comp.draftId && draftId && get().composer?.key === comp.key) updateComposer({ createdDraftId: draftId });
    if (opts.sendNow && draftId) {
      const said = sentText();
      await sendNow(c, [draftId]);
      toast(said, { tone: 'ok' });
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
      // Read mode shows no drafts: say where it went
      if (get().mode === 'read' && !comp.draftId) {
        toast(`Saved as a draft (${draft.id}). It goes to ${agentLabel()} when you send.`, { tone: 'ok', timeout: 4000 });
      }
    }
    await refreshNow();
  } catch (err) {
    if (get().composer?.key !== comp.key) return;
    if (err instanceof DraftGoneError) {
      // its draft went out (or was deleted) another way: the composer keeps the text, bound to nothing now
      updateComposer({ busy: false, createdDraftId: null, error: err.message });
      await refreshNow();
      return;
    }
    const kept = saved && !comp.draftId ? ` It is kept as draft ${saved}: ${opts.sendNow ? 'Send tries again' : 'try again'}.` : '';
    updateComposer({
      busy: false,
      error: /** @type {any} */ (err).offline ? `Connection lost. Your comment is kept here${saved && !comp.draftId ? ` (draft ${saved})` : ''}; try again once reconnected.`
        : `${opts.sendNow ? 'Not sent' : 'Not saved'}: ${errorText(err).replace(/\.$/, '')}.${kept}`,
    });
    // the draft it created is in the list now ("Being edited", without its own Send)
    if (saved) await refreshNow();
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
    toast(`Marked agreed${lock?.id ? ` (${lock.id})` : ''}. ${agentLabel()} will be refused if it changes this.`, { tone: 'ok' });
    await refreshNow();
  } catch (err) {
    updateComposer({ busy: false, error: errorText(err) });
  }
}

/**
 * Cancel (Esc): closes the composer; one that held input (isComposerDirty) can be restored from the toast. A composer
 * whose Send failed created a draft (createdDraftId): Cancel deletes that draft too (else the comment would still go
 * out with the next Send), and the toast says what happened to it.
 */
export function cancelComposer() {
  const comp = get().composer;
  if (!comp) return;
  if (comp.busy) return;
  autosaveDraftSoon.flush();
  set({ composer: null });
  guest.send(MSG.CLEAR_SELECTION);
  clearBackup();
  const created = !comp.draftId && comp.createdDraftId ? comp.createdDraftId : null;
  if (!created && !(isComposerDirty(comp) && !comp.draftId)) return;
  lastCancelled = { ...comp, error: null };
  /** Undo: the composer again, bound to its draft when that draft is still there. @param {string|null} keep */
  const reopen = (keep) => ({
    label: 'Undo',
    run: () => {
      if (!lastCancelled || get().composer) return;
      set({
        composer: { ...lastCancelled, createdDraftId: keep, key: ++composerSeq, busy: false, confirmSend: false },
        drawer: get().narrow ? true : get().drawer, sidebar: true,
      });
      lastCancelled = null;
      saveBackupSoon();
    },
  });
  if (!created) {
    toast('Comment discarded.', { actions: [reopen(null)] });
    return;
  }
  discardCreatedDraft(created, 'Comment', reopen);
}

/**
 * Cancel on a composer or reply box whose Send failed: deletes the draft that Send created, then says what happened
 * ("Comment discarded, and its draft d3 deleted.", or that the draft was already gone, or could not be deleted and
 * still goes out with the next Send).
 * @param {string} id
 * @param {'Comment'|'Reply'} what
 * @param {(keep: string|null) => { label: string, run: () => void }} undo the Undo action, which reopens the box with its
 *   text, bound to the draft when it is still there (`keep`)
 */
async function discardCreatedDraft(id, what, undo) {
  const c = client;
  if (!c) return;
  const before = get().ds;
  set((s) => (s.ds ? { ds: { ...s.ds, drafts: { ...s.ds.drafts, items: (s.ds.drafts?.items || []).filter((/** @type {any} */ x) => x.id !== id) } } } : null));
  try {
    await c.deleteDraft(id);
    toast(`${what} discarded, and its draft ${id} deleted.`, { actions: [undo(null)] });
  } catch (err) {
    if (isNotFound(err)) {
      toast(`${what} discarded. Its draft ${id} was already sent or deleted.`, { actions: [undo(null)] });
    } else {
      if (before && client === c) set({ ds: before });
      toast(`${what} closed, but its draft ${id} could not be deleted (${errorText(err)}): it goes out with your next Send unless you delete it.`,
        { tone: 'warn', actions: [undo(id)] });
    }
  }
  if (client === c) await refreshNow();
}

/**
 * Opens a draft for editing (thread drafts in the composer, a reply draft in its thread's reply box: that draft, also
 * when the thread has several).
 * @param {string} id
 */
export function editDraft(id) {
  const s = get();
  const d = (s.ds?.drafts?.items || []).find((/** @type {any} */ x) => x.id === id);
  if (!d) return;
  if (d.kind === 'reply') {
    startReply(d.thread, { draftId: d.id });
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
  } else if (r?.createdDraftId === id) {
    set({ reply: { ...r, createdDraftId: null } });
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
    if (!(/** @type {any} */ (err).offline)) console.warn('suiko: draft autosave failed', err);
  }
}, 800);

// ---- localStorage backup of the unsent composer (design 11.4) --------------------------------------------------

function backupKey() {
  const r = get().route;
  return r.view === 'doc' ? `suiko.composer.${r.ws}/${r.doc}` : null;
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
 * Opens the reply box of a thread (there is one at a time), on a reply draft of it (`draftId`: that one, e.g. the
 * Edit of its pending reply; else the thread's first reply draft, if any). Refused while another reply box (another
 * thread, or another draft of this one) holds unsaved text; on the same thread and draft the open box is kept as it is.
 * `body` prefills a new reply ("About chart.png: " from an attachment's viewer), or an open box that is still empty.
 * @param {string} threadId
 * @param {{ reopen?: boolean, draftId?: string, body?: string }} [opts]
 */
export function startReply(threadId, opts = {}) {
  const s = get();
  const cur = s.reply;
  const drafts = replyDraftsFor(s.ds?.drafts, threadId);
  const wanted = opts.draftId ? drafts.find((/** @type {any} */ d) => d.id === opts.draftId) || null : null;
  const shown = { focusedId: threadId, drawer: s.narrow ? true : s.drawer, sidebar: true };
  if (cur && cur.threadId === threadId && (!wanted || cur.draftId === wanted.id || cur.createdDraftId === wanted.id)) {
    const prefill = opts.body && !cur.body.trim() ? opts.body : null;
    set({
      reply: (opts.reopen && !cur.reopen) || prefill ? { ...cur, reopen: cur.reopen || !!opts.reopen, body: prefill ?? cur.body } : cur,
      ...shown,
    });
    return;
  }
  if (cur && (cur.busy || isReplyDirty(cur, s.ds?.drafts))) {
    toast(cur.threadId === threadId ? 'Finish or cancel the reply you are writing first.' : `Finish or cancel the open reply on ${cur.threadId} first.`, { tone: 'warn' });
    focusItem(cur.threadId);
    return;
  }
  const existing = wanted || drafts[0] || null;
  set({
    reply: {
      threadId,
      body: existing?.body || opts.body || '',
      reopen: !!opts.reopen || !!existing?.reopen,
      draftId: existing?.id || null,
      busy: false,
      // "Use in doc" files of the reply draft being edited: kept when it is saved again
      use: Array.isArray(existing?.use) ? existing.use.map(String) : [],
      createdDraftId: null,
      confirmSend: false,
      error: null,
    },
    ...shown,
  });
}

/** @param {string} body */
export function setReplyBody(body) {
  set((s) => (s.reply ? { reply: { ...s.reply, body } } : null));
}

/**
 * Cancel (Esc in the reply box): closes it; unsaved text can be restored from the toast. A box whose Send failed
 * created a reply draft (createdDraftId): Cancel deletes it too, and the toast says what happened to it.
 */
export function cancelReply() {
  const s = get();
  const r = s.reply;
  if (!r || r.busy) return;
  set({ reply: null });
  const created = !r.draftId && r.createdDraftId ? r.createdDraftId : null;
  if (!created && !isReplyDirty(r, s.ds?.drafts)) return;
  lastCancelledReply = { ...r, error: null };
  /** Undo: the box again, bound to its draft when that draft is still there. @param {string|null} keep */
  const reopen = (keep) => ({
    label: 'Undo',
    run: () => {
      const back = lastCancelledReply;
      if (!back || get().reply) return;
      lastCancelledReply = null;
      set({ reply: { ...back, createdDraftId: keep, busy: false, confirmSend: false }, focusedId: back.threadId, drawer: get().narrow ? true : get().drawer, sidebar: true });
    },
  });
  if (created) discardCreatedDraft(created, 'Reply', reopen);
  else toast('Reply discarded.', { actions: [reopen(null)] });
}

/**
 * The reply box's buttons: the reply (optionally reopening the thread) becomes a draft of the pending review, and
 * with `send` it goes to the agent at once, alone (Send with Send comments: Right away; Send now otherwise). With "Ask
 * before sending", a send first asks in the reply box (confirmSend). A send whose review request failed keeps the box
 * open with the error, bound to the draft it created (createdDraftId): a retry sends that one, never a copy.
 * @param {{ send?: boolean, confirmed?: boolean }} [opts]
 */
export async function submitReply(opts = {}) {
  const c = client;
  const r = get().reply;
  if (!c || !r || r.busy) return;
  const body = r.body.trim();
  if (!body) return;
  if (opts.send && !opts.confirmed && !r.confirmSend && get().prefs.confirmSendNow) {
    set({ reply: { ...r, confirmSend: true } });
    return;
  }
  set({ reply: { ...r, busy: true, confirmSend: false, error: null } });
  /** @param {(r: import('./state.js').Reply) => Partial<import('./state.js').Reply>} fn changes the box when it is still this one */
  const patchBox = (fn) => set((s) => (s.reply?.threadId === r.threadId ? { reply: { ...s.reply, ...fn(s.reply) } } : null));
  let saved = '';
  try {
    const item = { kind: 'reply', thread: r.threadId, body, reopen: r.reopen, ...(r.use?.length ? { use: r.use } : {}) };
    const existing = r.draftId || r.createdDraftId || null;
    const draft = await saveDraftItem(c, existing, item, { recreate: !!r.draftId || !r.createdDraftId });
    const draftId = String(draft?.id ?? existing ?? '');
    saved = draftId;
    if (opts.send && draftId) {
      if (!r.draftId) patchBox(() => ({ createdDraftId: draftId }));
      const said = sentText();
      await sendNow(c, [draftId]);
      toast(said, { tone: 'ok' });
    }
    set((s) => ({
      reply: null,
      ...(!opts.send && s.ds && draft?.id ? { ds: { ...s.ds, drafts: { ...(s.ds.drafts || {}), items: upsert(s.ds.drafts?.items || [], draft) } } } : {}),
    }));
    await refreshNow();
    // an answer to the round's last question (or a "Not yet") can finish it
    if (opts.send) await finishRound(c);
  } catch (err) {
    if (err instanceof DraftGoneError) {
      patchBox(() => ({ busy: false, createdDraftId: null, error: err.message.replace('as a new comment', 'as a new reply') }));
      await refreshNow();
      return;
    }
    const kept = saved && !r.draftId && opts.send ? ' It is kept as a reply draft: Send tries again.' : '';
    patchBox(() => ({
      busy: false,
      error: /** @type {any} */ (err).offline ? 'Connection lost. Your reply is kept here; try again once reconnected.'
        : `${opts.send ? 'Not sent' : 'Not saved'}: ${errorText(err).replace(/\.$/, '')}.${kept}`,
    }));
    if (saved) await refreshNow();
  }
}

/**
 * A draft's "Send" (a new-thread draft card, a pending reply): that draft alone goes to the agent now, as a one-item
 * review. An edit of it in progress (the composer, the reply box) is saved first, so what goes out is what is on
 * screen, and that editor closes: the draft is sent.
 * @param {string} id
 */
export async function sendDraft(id) {
  const c = client;
  if (!c || !get().ds) return;
  await threadAction(id, async () => {
    const said = sentText();
    try {
      const unsaved = await saveBoundEdits(c);
      if (unsaved) {
        toast(unsaved, { tone: 'warn' });
        return;
      }
      await sendNow(c, [id]);
    } catch (err) {
      toast(`Could not send ${id}: ${errorText(err)}`, { tone: 'danger' });
      await refreshNow();
      return;
    }
    closeEditorsOf([id]);
    toast(said, { tone: 'ok' });
    await refreshNow();
    await finishRound(c);
  });
}

/**
 * The draft a composer or reply box is bound to: the draft it edits, or the one its failed Send created.
 * @param {{ draftId?: string|null, createdDraftId?: string|null }|null|undefined} box
 * @returns {string|null}
 */
export function boundDraft(box) {
  return box?.draftId || box?.createdDraftId || null;
}

/**
 * Closes the composer and the reply box bound to any of these drafts (they were just sent: what they hold went out,
 * their edits were saved first).
 * @param {string[]} ids
 */
function closeEditorsOf(ids) {
  const s = get();
  const comp = boundDraft(s.composer);
  const reply = boundDraft(s.reply);
  /** @type {Partial<UiState>} */
  const patch = {};
  if (comp && ids.includes(comp)) {
    autosaveDraftSoon.cancel();
    clearBackup();
    patch.composer = null;
  }
  if (reply && ids.includes(reply)) patch.reply = null;
  if (Object.keys(patch).length) set(patch);
}

/**
 * "Use in doc" on an agent's attachment (a picture or an HTML preview on its reply): a reply on that thread asking
 * the agent to put the file into the doc (`use`: ['attachments/a7.html'], body "Put this in the doc."). With Send
 * comments: Right away it goes to the agent at once (the server reopens a resolved thread for it); else it joins the
 * thread's reply draft (its `use` gets the file: one reply per thread, which its Edit opens), or becomes one.
 * @param {string} threadId
 * @param {string} path the attachment's path ('attachments/a7.html')
 */
export async function useAttachment(threadId, path) {
  const c = client;
  const s = get();
  if (!c || !s.ds) return;
  if (s.version === 'live') {
    toast('The working copy is a read-only preview. Switch to a recorded version to reply.', { tone: 'warn' });
    return;
  }
  const now = sendModeOf(s) !== 'batch';
  const name = threadAttachmentName((s.ds.threads || []).find((/** @type {any} */ t) => t.id === threadId), path);
  const connected = presenceInfo(s.ds).kind !== 'none';
  // batch: the reply draft the open reply box edits on this thread, else the thread's first one
  const open = s.reply?.threadId === threadId ? boundDraft(s.reply) : null;
  const drafts = replyDraftsFor(s.ds.drafts, threadId);
  const joined = now ? null : drafts.find((/** @type {any} */ d) => d.id === open) || drafts[0] || null;
  await threadAction(threadId, async () => {
    try {
      if (joined) {
        const use = [...new Set([...(Array.isArray(joined.use) ? joined.use.map(String) : []), path])];
        await c.patchDraft(String(joined.id), { use });
        // a reply box editing that draft keeps the file when it saves the reply again
        set((st) => (st.reply?.threadId === threadId && boundDraft(st.reply) === String(joined.id) ? { reply: { ...st.reply, use } } : null));
      } else {
        const draft = await c.createDraft({ kind: 'reply', thread: threadId, body: USE_REPLY_BODY, reopen: false, use: [path] });
        if (now && draft?.id) await sendNow(c, [String(draft.id)]);
      }
    } catch (err) {
      toast(`Could not ask for ${name}: ${errorText(err)}`, { tone: 'danger' });
      await refreshNow();
      return;
    }
    toast(!now ? `Added to your review: ${agentLabel()} puts ${name} in the document once you send it.`
      : connected ? `Asked ${agentLabel()} to put ${name} in the document.`
        : `Saved for ${agentLabel()}: put ${name} in the document. It gets it when it connects.`, { tone: 'ok' });
    await refreshNow();
  });
}

/**
 * Apply planned changes (batched edits): the agent makes the changes it planned on these threads, in one pass that
 * records one version. A review {verdict: 'comment', body: '', draftIds: [], apply: ids, edits: 'now', instant: true}:
 * draftIds [] keeps the pending drafts out of it. Every entry point (the panel's Apply N, a card's "Apply this now",
 * the turn pill, the Approve dialog, the palette) applies from model.js applicablePlanned, so they never differ. A
 * thread that is no longer planned (409) refreshes the state and says why.
 * @param {string[]} [ids] default: every planned thread (applicablePlanned); ids that are not planned are left out
 * @returns {Promise<boolean>} false when there was nothing to apply
 */
export async function applyPlanned(ids) {
  const c = client;
  const s = get();
  if (!c || !s.ds) return false;
  if (s.version === 'live') {
    toast('The working copy is a read-only preview. Switch to a recorded version to apply planned changes.', { tone: 'warn' });
    return false;
  }
  const planned = applicablePlanned(s.ds).map((/** @type {any} */ t) => String(t.id));
  const list = (ids?.length ? planned.filter((id) => ids.includes(id)) : planned).filter((id) => !s.busyThreads.includes(id));
  if (!list.length) {
    toast(`Nothing to apply: ${agentLabel()} has no planned changes.`, { timeout: 3000 });
    return false;
  }
  const connected = presenceInfo(s.ds).kind !== 'none';
  set((st) => ({ busyThreads: [...st.busyThreads, ...list] }));
  try {
    await c.submitReview({ verdict: 'comment', body: '', draftIds: [], apply: list, edits: 'now', reviewedVersion: reviewedVersion(), instant: true });
  } catch (err) {
    if (/** @type {any} */ (err)?.status === 409) {
      await refreshNow();
      toast(errorText(err), { tone: 'warn', timeout: 8000 });
    } else {
      toast(`Could not apply the planned changes: ${errorText(err)}`, { tone: 'danger' });
    }
    return true;
  } finally {
    set((st) => ({ busyThreads: st.busyThreads.filter((x) => !list.includes(x)) }));
  }
  const n = list.length;
  const what = `${n} planned change${n === 1 ? '' : 's'}`;
  toast(connected ? `Sent ${what} to ${agentLabel()}.` : `Saved ${what} for ${agentLabel()}. It gets ${n === 1 ? 'it' : 'them'} when it connects.`, { tone: 'ok' });
  await refreshNow();
  return true;
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

/**
 * Accept / Resolve (immediate, design C18), with a decision recorded on it ("Record as decision…": its input closes
 * once the thread is done). Done on the last thing the round asked the reviewer to look at finishes the round
 * (finishRound).
 * @param {string} id @param {string} [decision]
 */
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
    set((s) => (s.decision?.threadId === id ? { decision: null } : null));
    toast(`${id} is done${decision && decision.trim() ? ' and recorded as a decision' : ''}.`, { tone: 'ok', timeout: 3000 });
    await refreshNow();
    await finishRound(c);
  });
}

/**
 * "Record as decision…" on a thread card: opens its input (one at a time, kept in the store: a card that leaves the
 * filter shown stays listed while it is open, and a code review's inline card opens it on the panel's card, also when
 * that card is already focused). Focuses the card.
 * @param {string} id
 */
export function startDecision(id) {
  const cur = get().decision;
  if (cur && cur.threadId !== id && cur.text.trim()) {
    toast(`Finish or cancel the decision you are writing on ${cur.threadId} first.`, { tone: 'warn' });
    focusItem(cur.threadId);
    return;
  }
  if (cur?.threadId !== id) set({ decision: { threadId: id, text: '' } });
  focusItem(id);
}

/** What is typed in the open "Record as decision…" input. @param {string} text */
export function setDecisionText(text) {
  set((s) => (s.decision ? { decision: { ...s.decision, text } } : null));
}

/** Cancel (or Esc) in the "Record as decision…" input. */
export function cancelDecision() {
  set({ decision: null });
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

/**
 * Accept all (Your turn's bar, Shift+X, the palette): marks done every thread the agent changed or answered that
 * waits for the reviewer's check, in one request, then offers Undo. Threads the agent did not change (declined) are
 * left for the reviewer to decide one by one. Returns false when there was nothing to accept.
 */
export async function acceptAll() {
  const c = client;
  const s = get();
  if (!c || !s.ds) return false;
  if (s.version === 'live') {
    toast('The working copy is a read-only preview. Switch to a recorded version to accept threads.', { tone: 'warn' });
    return false;
  }
  const { ids, leftOut } = bulkAcceptable(s);
  if (!ids.length) {
    toast(leftOut ? `Nothing else to accept.${leftOut}` : declinedToVerify(s.ds).length
      ? `Nothing to accept in one go: ${agentLabel()} didn't change the threads left. Decide on each one.`
      : `Nothing to accept: nothing ${agentLabel()} changed or answered waits for your check.`, { timeout: 4000 });
    return false;
  }
  set((st) => ({ busyThreads: [...st.busyThreads, ...ids] }));
  /** @type {any} */
  let r;
  try {
    r = await c.resolveMany(ids);
  } catch (err) {
    toast(`Could not accept the threads: ${errorText(err)}`, { tone: 'danger' });
    return true;
  } finally {
    set((st) => ({ busyThreads: st.busyThreads.filter((x) => !ids.includes(x)) }));
  }
  if (client !== c) return true;
  const done = Array.isArray(r?.resolved) ? r.resolved.map(String) : ids;
  toast(`Accepted ${done.length} thread${done.length === 1 ? '' : 's'} (${listIds(done)}).${undecided(get().ds)}${leftOut}`, {
    tone: 'ok',
    timeout: 12000,
    actions: done.length ? [{ label: 'Undo', run: () => undoAcceptAll(c, done) }] : [],
  });
  await refreshNow();
  await finishRound(c);
  return true;
}

/**
 * "Since your last review" while comments are sent right away: one-item sends are `instant` and never move it, so the
 * reviewer finishing a round does. Once nothing of the latest version's round waits for them any more (they accepted,
 * answered or replied to the last of the threads the agent changed or answered since their last review) and that
 * version's changes are still new to them, its revisions are accepted (acceptedVersion, what the Changes panel's
 * Accept all does, resolving nothing else): the Changes tab stops counting them. The toast has Undo. With Send
 * comments: When I click Send, the next review from the Send dialog moves it instead.
 * @param {NonNullable<typeof client>} c the doc the round is on
 */
async function finishRound(c) {
  const s = get();
  if (client !== c || !s.ds || sendModeOf(s) === 'batch') return;
  const todo = revisionsToAccept(s.ds);
  if (!todo || s.version !== todo.version) return;
  const round = roundResults(s.ds, todo.since ?? todo.version - 1, todo.version).map((x) => x.thread);
  const ctx = { drafts: s.ds.drafts, version: s.version };
  if (!round.length || round.some((/** @type {any} */ t) => turnReason(t, ctx) != null)) return;
  /** @type {any} */
  let r;
  try {
    r = await c.acceptRevisions(todo.version, []);
  } catch {
    return; // still new: the Changes panel's Accept all can do it
  }
  if (client !== c) return;
  const v = Number(r?.accepted) || todo.version;
  toast(`You went through everything v${v} answered: its changes no longer count as new.`, {
    timeout: 8000,
    actions: [{ label: 'Undo', run: () => undoAcceptRevisions(c, { version: v, previous: r?.previous ?? null, threads: [], seenKey: null, seen: [] }) }],
  });
  await refreshNow();
}

/**
 * " 1 thread Claude didn't change is still yours to decide." after an Accept all ('' when there is none).
 * @param {any} ds
 */
function undecided(ds) {
  const n = declinedToVerify(ds).length;
  return n ? ` ${n} thread${n === 1 ? '' : 's'} ${agentTitle(agentName(ds))} didn't change ${n === 1 ? 'is' : 'are'} still yours to decide.` : '';
}

/**
 * The threads Accept all (and Accept all revisions) resolve: the ones the agent changed or answered that wait for the
 * reviewer's check, but not one being worked on, nor the one whose reply box holds text (resolving it would take the
 * card, and the text, out of the list). `leftOut` says so for the toast ('' when nothing was left out).
 * @param {ReturnType<typeof get>} s
 * @returns {{ ids: string[], leftOut: string }}
 */
function bulkAcceptable(s) {
  const replying = s.reply && String(s.reply.body ?? '').trim() ? String(s.reply.threadId) : null;
  const all = acceptableThreads(s.ds).map((/** @type {any} */ t) => String(t.id)).filter((id) => !s.busyThreads.includes(id));
  const ids = all.filter((id) => id !== replying);
  return { ids, leftOut: ids.length < all.length ? ` ${replying} was left out: you are replying to it.` : '' };
}

/**
 * The Undo of Accept all: those threads go back to the agent's last status (Addressed, Answered).
 * @param {NonNullable<typeof client>} c the doc the threads were accepted on
 * @param {string[]} ids
 */
async function undoAcceptAll(c, ids) {
  if (client !== c) return;
  try {
    await c.unresolveMany(ids);
  } catch (err) {
    toast(`Could not undo: ${errorText(err)}`, { tone: 'danger' });
    return;
  }
  toast(`${ids.length} thread${ids.length === 1 ? ' is' : 's are'} back in Your turn.`, { timeout: 3000 });
  await refreshNow();
}

/**
 * Accept all revisions: accepts the newest version's revisions (the doc stops opening on them, and Changes compares
 * later versions with it) and marks done the threads the agent changed or answered that wait for the reviewer's
 * check, in one request; marks the changes shown as seen and leaves Changes for the doc without change marks. Threads
 * the agent did not change stay in Your turn, like with Accept all. The toast has Undo.
 * @returns {Promise<boolean>} false when there was nothing to accept
 */
export async function acceptRevisions() {
  const c = client;
  const s = get();
  if (!c || !s.ds) return false;
  if (s.version === 'live') {
    toast('The working copy is a read-only preview. Switch to the latest version to accept its revisions.', { tone: 'warn' });
    return false;
  }
  const todo = revisionsToAccept(s.ds);
  if (!todo) {
    toast('Nothing new to accept: you reviewed or accepted the latest version already.', { timeout: 4000 });
    return false;
  }
  if (s.version !== todo.version) {
    toast(`Switch to v${todo.version} (latest) to accept its revisions.`, { timeout: 4000 });
    return false;
  }
  const { ids, leftOut } = bulkAcceptable(s);
  // the changes shown, when they end at the accepted version (seen marks are kept per comparison)
  const seenKey = seenStorageKey(s);
  const before = readSeen(seenKey);
  const newlySeen = (s.changes?.hunks || []).map((/** @type {any} */ h) => String(h.id)).filter((id) => !before.has(id));
  set((st) => ({ busyThreads: [...st.busyThreads, ...ids] }));
  /** @type {any} */
  let r;
  try {
    r = await c.acceptRevisions(todo.version, ids);
  } catch (err) {
    toast(`Could not accept the revisions: ${errorText(err)}`, { tone: 'danger' });
    return true;
  } finally {
    set((st) => ({ busyThreads: st.busyThreads.filter((x) => !ids.includes(x)) }));
  }
  if (client !== c) return true;
  writeSeen(seenKey, newlySeen, true);
  if (get().mode === 'changes') showChanges(false);
  const done = Array.isArray(r?.resolved) ? r.resolved.map(String) : ids;
  const threads = done.length ? ` and ${done.length} thread${done.length === 1 ? '' : 's'} (${listIds(done)})` : '';
  toast(`Accepted the revisions of v${todo.version}${threads}.${undecided(get().ds)}${leftOut}`, {
    tone: 'ok',
    timeout: 12000,
    actions: [{
      label: 'Undo',
      run: () => undoAcceptRevisions(c, { version: Number(r?.accepted) || todo.version, previous: r?.previous ?? null, threads: done, seenKey, seen: newlySeen }),
    }],
  });
  await refreshNow();
  return true;
}

/**
 * The Undo of Accept all revisions: the version's revisions are new again (the accepted version goes back to what it
 * was), and the threads go back to Your turn.
 * @param {NonNullable<typeof client>} c the doc they were accepted on
 * @param {{ version: number, previous: number|null, threads: string[], seenKey: string|null, seen: string[] }} a
 */
async function undoAcceptRevisions(c, a) {
  if (client !== c) return;
  try {
    await c.unacceptRevisions(a.version, a.previous, a.threads);
  } catch (err) {
    toast(`Could not undo: ${errorText(err)}`, { tone: 'danger' });
    return;
  }
  writeSeen(a.seenKey, a.seen, false);
  const n = a.threads.length;
  toast(`The revisions of v${a.version} are to review again${n ? `; ${n} thread${n === 1 ? ' is' : 's are'} back in Your turn` : ''}.`, { timeout: 3000 });
  await refreshNow();
}

/** "t1, t2, t5", or "t1, t2, t3 and 4 more" for a long list. @param {string[]} ids */
function listIds(ids) {
  return ids.length <= 5 ? ids.join(', ') : `${ids.slice(0, 3).join(', ')} and ${ids.length - 3} more`;
}

/** Reviewer "Apply now" for a suggestion. @param {string} id */
export async function applySuggestion(id) {
  const c = client;
  if (!c) return;
  await threadAction(id, async () => {
    try {
      // the reviewer's own version: one toast, then shown (ownRecord)
      await ownRecord(c, () => c.apply(id), (v) => `Suggestion applied${v ? ` as v${v}` : ''}.`);
    } catch (err) {
      if (client !== c) return;
      toast(applyErrorText(id, err), { tone: 'danger' });
      await refreshNow();
    }
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
    toast(frame ? 'Select the new text in the document first (or pick an element with e), then click Move here.'
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
  set({ dialog: null, lightbox: null, preview: null });
}

/**
 * Shows an image (an attachment thumbnail, a crop) full size; Esc, the backdrop or Close shut it.
 * @param {string} src
 * @param {string} [alt]
 */
export function openLightbox(src, alt = 'Screenshot') {
  if (!src || get().dialog === 'submit') return;
  set({ dialog: 'image', lightbox: { src, alt }, preview: null });
}

/**
 * "Open large" on an agent's HTML attachment: the same sandboxed preview in an overlay (dialog 'preview'); Esc, the
 * backdrop or Close shut it and the focus returns to the button.
 * @param {{ src: string, name: string, threadId: string, path: string }} p
 */
export function openPreview(p) {
  if (!p?.src || get().dialog === 'submit') return;
  set({ dialog: 'preview', preview: p, lightbox: null });
}

/**
 * What the reviewer typed / picked in the Submit dialog. It lives in the store, so closing the dialog (Esc, a click
 * on the backdrop, Cancel) loses nothing; a successful submit clears it. markFinal stays null (the dialog's default:
 * ticked only when approving is the obvious next step, model.js approveReady) until the reviewer ticks or unticks it.
 * @param {Partial<NonNullable<UiState['submitForm']>>} patch
 */
export function updateSubmitForm(patch) {
  set((s) => ({ submitForm: { body: '', verdict: null, markFinal: null, resolveAddressed: true, ...s.submitForm, ...patch } }));
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
  const compDraft = boundDraft(comp);
  if (compDraft) {
    if (comp.busy) return `Draft ${compDraft} is still being saved. Try again in a moment.`;
    const problem = composerProblem(comp);
    if (problem) return `You are editing draft ${compDraft}: ${problem} Or cancel the edit.`;
    if (comp.draftId) {
      const draft = await saveDraftItem(c, comp.draftId, composerItem(comp));
      if (draft?.id && draft.id !== comp.draftId) set((s) => (s.composer?.key === comp.key ? { composer: { ...s.composer, draftId: String(draft.id) } } : null));
    } else {
      // the draft a failed Send created: its text as the composer has it now, never a copy (gone: no longer bound)
      await saveDraftItem(c, compDraft, composerItem(comp), { recreate: false }).catch((err) => {
        if (!(err instanceof DraftGoneError)) throw err;
        set((st) => (st.composer?.key === comp.key ? { composer: { ...st.composer, createdDraftId: null } } : null));
      });
    }
  }
  const s = get();
  const r = s.reply;
  const replyDraft = boundDraft(r);
  if (r && replyDraft) {
    if (r.busy) return `The reply on ${r.threadId} is still being saved. Try again in a moment.`;
    if (!r.body.trim()) return `The reply you are editing on ${r.threadId} is empty: write it, or delete that draft.`;
    const item = { kind: 'reply', thread: r.threadId, body: r.body.trim(), reopen: r.reopen, ...(r.use?.length ? { use: r.use } : {}) };
    if (r.draftId && isReplyDirty(r, s.ds?.drafts)) {
      const draft = await saveDraftItem(c, r.draftId, item);
      if (draft?.id && draft.id !== r.draftId) set((st) => (st.reply === r ? { reply: { ...r, draftId: String(draft.id) } } : null));
    } else if (!r.draftId) {
      await saveDraftItem(c, replyDraft, item, { recreate: false }).catch((err) => {
        if (!(err instanceof DraftGoneError)) throw err;
        set((st) => (st.reply?.threadId === r.threadId ? { reply: { ...st.reply, createdDraftId: null } } : null));
      });
    }
  }
  return null;
}

/**
 * Sends the pending review (the Send dialog): every draft, plus a summary and a verdict (Send feedback / Needs
 * changes / Approve vN).
 * - Edits in progress on drafts are saved first, so the review carries the text on screen.
 * - It is about the version on screen (sent as `reviewedVersion`). Approve is refused when a newer version exists:
 *   the daemon marks its head final, which the reviewer has not seen.
 * - It carries `edits` (Settings > Doc edits, model.js reviewEdits); an approval asks for none ('now').
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
    const body = { verdict: p.verdict, body: p.body.trim(), reviewedVersion: reviewed, edits: p.verdict === 'approved' ? 'now' : currentEdits() };
    if (p.verdict === 'approved') {
      body.markFinal = !!p.markFinal;
      body.resolveAddressed = !!p.resolveAddressed;
    }
    const connected = presenceInfo(get().ds).kind !== 'none';
    /** @param {string} suffix */
    const said = (suffix) => sentText(suffix, connected);
    const review = await c.submitReview(body);
    // Every draft went out: editors bound to one are done (their edits were saved above).
    autosaveDraftSoon.cancel();
    if (boundDraft(get().composer)) clearBackup();
    set((s) => ({
      dialog: null,
      submitForm: null,
      composer: boundDraft(s.composer) ? null : s.composer,
      reply: boundDraft(s.reply) ? null : s.reply,
    }));
    const id = review?.id ? ` (${review.id})` : '';
    toast(p.verdict === 'approved' ? `Approved${id}.` : said(p.verdict === 'changes_requested' ? `: needs changes${id}` : id), { tone: 'ok' });
    await refreshNow();
    return null;
  } catch (err) {
    return errorText(err);
  }
}

/**
 * A version of the reviewer's own, made from this page by `send` (Record as my revision, Re-snapshot, Apply now):
 * while the request is in flight, its version.created event (which may come first) announces nothing, and the version
 * it made joins ownVersions so a later event does not either (announceVersion). One toast says it (`said(v)`). The
 * view then shows the new version, whatever "When Claude records a new version" says (that setting is about the
 * agent's versions), but only forward (a newer version shown meanwhile stays) and never over what holds the view (a
 * comment, a reply, the Send dialog: the banner offers it then). Like any request, its answer is dropped once the
 * reviewer has moved to another doc.
 * @param {NonNullable<typeof client>} c the doc client it was made on
 * @param {() => Promise<any>} send the request; resolves to the manifest of the version ({ v })
 * @param {(v: number) => string} said the toast for version v (0 when the answer has none)
 * @returns {Promise<void>} rejects with what `send` rejects with
 */
async function ownRecord(c, send, said) {
  ownRecords.set(c, (ownRecords.get(c) || 0) + 1);
  try {
    const m = await send();
    if (client !== c) return;
    const v = Number(m?.v) || 0;
    if (v) ownVersions.add(v);
    toast(said(v), { tone: 'ok' });
    await refreshNow();
    if (client !== c || !v) return;
    if (lastFollow?.to === v) lastFollow = null;
    const s = get();
    const behind = s.version === 'live' || (typeof s.version === 'number' && s.version < v);
    if (behind && !holdsView(s) && versionNumbers(s.ds).includes(v)) switchVersion(v);
  } finally {
    const n = (ownRecords.get(c) || 1) - 1;
    if (n > 0) ownRecords.set(c, n);
    else ownRecords.delete(c);
  }
}

/** "Record as my revision" for the unrecorded working copy, and a code review's Re-snapshot (ownRecord). @param {string} summary */
export async function recordWorkingCopy(summary) {
  const c = client;
  if (!c) return;
  try {
    await ownRecord(c, () => c.record(summary.trim() || 'Reviewer edit'), (v) => `Recorded${v ? ` as v${v}` : ''}.`);
  } catch (err) {
    if (client === c) toast(`Could not record: ${errorText(err)}`, { tone: 'danger' });
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
  baseGuest.send(MSG.SET_THEME, { theme });
}

export function cycleTheme() {
  const order = /** @type {const} */ (['system', 'light', 'dark']);
  const next = order[(order.indexOf(get().theme) + 1) % order.length];
  applyTheme(next);
  toast(`Theme: ${next}`, { timeout: 1500 });
}

export function toggleHidden() {
  if (!kindCaps(get().ds).hide) return;
  if (get().mode === 'read') {
    toast('Read mode shows no annotations. Switch to Review (1) to see them.', { timeout: 3000 });
    return;
  }
  const hidden = !get().hidden;
  set({ hidden });
  guest.send(MSG.SET_HIDDEN, { hidden });
  baseGuest.send(MSG.SET_HIDDEN, { hidden });
}

/**
 * Select (text), pick (e: an element) or snip (b: a box over any area). Pick and snip need the rendered doc of a
 * recorded version (Read / Review / Changes) and a connected guest.
 * @param {'select'|'pick'|'snip'} tool
 */
export function setTool(tool) {
  const s = get();
  const caps = kindCaps(s.ds);
  if ((tool === 'pick' && !caps.pick) || (tool === 'snip' && !caps.snip)) {
    toast('Pick and snip work on rendered documents; click a line number to comment.', { timeout: 2500 });
    return;
  }
  if (tool !== 'select' && (s.version === 'live' || !showsDoc(s.mode))) {
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
 * switches to Review first (Read keeps its clean view). A `b` forwarded from the doc while already snipping is ignored (the guest handles its
 * own keys while it snips); a `b` in the UI then cancels the snip.
 * @param {{ fromGuest?: boolean }} [opts]
 */
export function toggleSnip(opts = {}) {
  const s = get();
  if (s.tool === 'snip') {
    if (!opts.fromGuest) setTool('select');
    return;
  }
  if (s.version !== 'live' && !showsDoc(s.mode)) setMode('review');
  setTool('snip');
}

/** What a screen snip is about: the selected text in the doc, the selected lines in Source mode, else the whole doc. @param {UiState} s */
function screenSnipCapture(s) {
  if (!kindCaps(s.ds).frame) return kindSelection?.() || { kind: 'doc' };
  if (s.mode === 'source' && s.sourceSel) return { kind: 'source', startLine: s.sourceSel.from, endLine: s.sourceSel.to };
  if (showsDoc(s.mode) && s.guest.selection) return s.guest.selection;
  return { kind: 'doc' };
}

const SNIP_SCREEN_UNSUPPORTED = 'Snipping the screen needs macOS (Suiko runs the system screenshot picker on your Mac). Press b (without Shift) to snip an area of the document instead.';

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
      toast(`Screen snip failed: ${e?.offline ? 'the connection to Suiko was lost' : errorText(err)}`, { tone: 'danger' });
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
 * setting (prefs.panelOpen; a doc without threads or drafts opens without it). In Read mode, which has no thread
 * panel, it switches to Review with the panel open. The reviewer's toggle ends panelAuto.
 */
export function toggleSidebar() {
  const s = get();
  if (s.mode === 'read') {
    // Read mode has no thread panel: show the threads in Review
    setMode('review');
    if (get().mode !== 'review') return;
    if (s.narrow) set({ drawer: true, nav: false });
    else set({ sidebar: true, panelAuto: false });
    return;
  }
  if (s.narrow) set({ drawer: !s.drawer, nav: false });
  else set({ sidebar: !s.sidebar, panelAuto: false });
}

/** Whether a doc has anything for the thread panel to list: threads, or drafts of the pending review. @param {any} ds */
function hasThreadsOrDrafts(ds) {
  return !!((ds?.threads || []).length || (ds?.drafts?.items || []).length);
}

/**
 * A doc that opened without the thread panel only because it had nothing in it (panelAuto): the first thread or draft
 * that arrives (a comment saved, the agent asking something) opens it, as it would have been open, and so does
 * Changes (the side panel holds its list of changes).
 */
store.subscribe(() => {
  const s = get();
  // (side by side keeps the panel hidden: it opens once the reviewer is back)
  if (!s.panelAuto || s.compareFocus) return;
  if (s.sidebar) set({ panelAuto: false });
  else if (s.ds && (hasThreadsOrDrafts(s.ds) || s.mode === 'changes')) set({ sidebar: true, panelAuto: false });
});

/**
 * The side panel's width (components/PanelResizer.js): a CSS variable on the root element, which beats the layouts'
 * own values of it. null goes back to those.
 * @param {number|null} width px
 * @param {{ save?: boolean }} [opts] save: false while dragging; the width is remembered in this browser when it ends
 */
export function setPanelWidth(width, { save = true } = {}) {
  const root = document.documentElement.style;
  if (width == null) root.removeProperty('--rail-right');
  else root.setProperty('--rail-right', `${width}px`);
  set({ panelWidth: width });
  if (save) writePref('panelWidth', width == null ? '' : String(width));
}

/**
 * Whether the window has room for the rail beside the doc and the thread panel with the Auto setting: from 1600 px
 * (`roomy`: a rendered doc keeps about 1050 px at 1440 px with the thread panel open). A code review's file tree is
 * its main way around, so there it is beside the diffs from 1200 px.
 * @param {UiState} s
 */
function railRoom(s) {
  return s.roomy || (!s.medium && !!s.ds && !kindCaps(s.ds).frame);
}

/**
 * Whether the outline rail is shown beside the doc (900 px and up; below, it is a drawer): the page's own choice
 * (railOpen), else the Outline rail setting: auto shows it when there is room for it (railRoom: from 1600 px) and,
 * below that, when the reviewer opened it there (remembered); always / never.
 * @param {UiState} s
 */
export function railShown(s) {
  if (s.narrow) return false;
  if (s.railOpen != null) return s.railOpen;
  if (s.prefs.railMode === 'always') return true;
  if (s.prefs.railMode === 'never') return false;
  return railRoom(s) ? true : s.rail;
}

/** Whether the top bar shows the ≡ button that opens / closes the outline (drawer or rail). @param {UiState} s */
export function railToggleShown(s) {
  return s.narrow || !railRoom(s) || s.prefs.railMode !== 'auto' || s.railOpen != null;
}

/**
 * The ≡ button (and the palette's "Toggle the outline rail"): the outline drawer below 900 px; from 900 px the
 * outline rail. With the Auto setting where the rail is collapsed by default so the doc keeps its width (below
 * 1600 px), the choice is remembered; otherwise it holds for this page.
 */
export function toggleNav() {
  const s = get();
  if (s.narrow) {
    set({ nav: !s.nav, drawer: false });
    return;
  }
  if (s.prefs.railMode === 'auto' && !railRoom(s) && s.railOpen == null) {
    set({ rail: !s.rail });
    writePref('rail', s.rail ? '0' : '1');
    return;
  }
  set({ railOpen: !railShown(s) });
}

/**
 * The thread panel's filter (an earlier key is mapped: model.js normalizeFilter). Picked by the reviewer (a click on
 * a filter, a command, Show my turn), it stays for this doc; until then the panel follows the default filter.
 * @param {string} filter
 * @param {{ pin?: boolean }} [opts]
 */
export function setFilter(filter, { pin = true } = {}) {
  const s = get();
  set({ filter: normalizeFilter(filter, s.ds, s.version), filterPinned: pin || s.filterPinned });
  deselectHiddenResolved();
}

/**
 * The thread panel follows its default filter (model.js defaultFilter: Your turn when something waits for the
 * reviewer, else the agent's, else All) while the reviewer has not picked one for this doc. Recomputed when the
 * DocState or the version shown changes, not on every store update.
 */
let filterBasis = { ds: /** @type {any} */ (null), version: /** @type {any} */ (null), pinned: false };
store.subscribe(() => {
  const s = get();
  if (!s.ds || s.filterPinned) {
    filterBasis = { ds: null, version: null, pinned: s.filterPinned };
    return;
  }
  if (filterBasis.ds === s.ds && filterBasis.version === s.version && !filterBasis.pinned) return;
  filterBasis = { ds: s.ds, version: s.version, pinned: false };
  const want = defaultFilter(s.ds, s.version);
  if (want !== s.filter) {
    set({ filter: want });
    deselectHiddenResolved();
  }
});

/** @param {'unified'|'split'} layout */
export function setSourceLayout(layout) {
  set({ sourceLayout: layout });
  writePref('sourceLayout', layout);
}

// ============================================================================================ dialogs & preferences

/**
 * Opens a dialog. Dialogs are exclusive, so this closes the one that is open (the Send dialog keeps what was
 * typed in it: submitForm). 'info': the doc's details (More menu > Document info). Settings opens on General, or on
 * the section asked for.
 * @param {'palette'|'settings'|'help'|'info'} name
 * @param {{ section?: import('./state.js').SettingsSection }} [opts]
 */
export function openDialog(name, opts = {}) {
  set({ dialog: name, lightbox: null, preview: null, ...(name === 'settings' ? { settingsSection: opts.section || 'general' } : {}) });
  if (name === 'settings') loadAbout();
  if (name === 'palette' || name === 'settings') loadDocList();
}

/** The section Settings shows (its sidebar). @param {import('./state.js').SettingsSection} section */
export function setSettingsSection(section) {
  set({ settingsSection: section });
}

/** Cmd/Ctrl+K, Cmd/Ctrl+, and Cmd/Ctrl+/ open their dialog, or close it when it is the one open. @param {'palette'|'settings'|'help'} name */
export function toggleDialog(name) {
  if (get().dialog === name) closeDialog();
  else openDialog(name);
}

const PREF_KEYS = /** @type {const} */ ({
  railMode: 'railMode', panelOpen: 'sidebar', singleKeys: 'singleKeys', onNewVersion: 'onNewVersion',
  confirmSendNow: 'confirmSendNow', defaultVerdict: 'defaultVerdict', openIn: 'openIn', sendMode: 'sendMode',
  editMode: 'editMode',
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
  if (name === 'singleKeys') {
    guest.send(MSG.SET_PREFS, { singleKeys: !!value });
    baseGuest.send(MSG.SET_PREFS, { singleKeys: !!value });
  }
  if (name === 'railMode') set({ railOpen: null });
  if (name === 'panelOpen' && !s.narrow) set({ sidebar: !!value, panelAuto: false });
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

/**
 * c / s / q / a: comment, suggest, ask or mark agreed on the selection (doc text, or Source lines for c).
 * @param {'c'|'s'|'q'|'a'} key
 * @param {{ fromBase?: boolean }} [opts] fromBase: pressed in the older version of Changes side by side
 */
export function selectionAction(key, opts = {}) {
  const s = get();
  const action = /** @type {Record<string, string>} */ ({ c: 'comment', s: 'suggest', q: 'question', a: 'agree' })[key];
  const caps = kindCaps(s.ds);
  if (key === 'a' && !caps.locks) return false;
  if (opts.fromBase) {
    // the older version is read-only, and what the newer frame still has selected is not what is being pointed at
    toast('The older version is read-only: select text in the newer version to comment on it.', { timeout: 3500 });
    return true;
  }
  if (!caps.frame) {
    // a kind view without the doc frame (a code review): its own selection (the selected lines)
    if (s.mode === 'history') return false;
    const capture = kindSelection?.() || null;
    if (capture) openComposer({ capture, action });
    else toast('Click a line number (shift-click for a range), then press c.', { timeout: 3000 });
    return true;
  }
  if (s.mode === 'source') {
    if (s.sourceSel && key === 'c') {
      openComposer({ capture: { kind: 'source', startLine: s.sourceSel.from, endLine: s.sourceSel.to }, action });
    } else if (key === 'c') {
      toast('Click a line number (shift-click for a range), then press c.', { timeout: 3000 });
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
 * Shows the thread list with a filter (Your turn, palette filters, the problems chip's lost threads): the thread
 * panel (or drawer), on its Threads tab in Changes mode. The filter stays the reviewer's choice for this doc.
 * @param {string} filter a filter key (an earlier one is mapped: model.js normalizeFilter)
 * @param {{ review?: boolean }} [opts] review: switch to Review mode first
 */
export function showThreads(filter, opts = {}) {
  if (opts.review && get().mode !== 'review') setMode('review');
  setFilter(filter);
  const s = get();
  set({ sidePane: 'threads', drawer: s.narrow ? true : s.drawer, sidebar: true });
}

/**
 * The turn pill's "Show my turn" (and the palette's): the thread panel on Your turn, what waits for the reviewer
 * (model.js myTurn and the filter count the same threads). Read mode has no thread panel: it switches to Review.
 */
export function showMyTurn() {
  const s = get();
  if (!s.ds) return;
  showThreads('mine', { review: s.mode === 'read' });
}

/** "Send feedback… / Send as Needs changes… / Approve this version…": the Send dialog on that verdict. @param {'comment'|'changes_requested'|'approved'} verdict */
export function submitWithVerdict(verdict) {
  if (!get().ds) return;
  updateSubmitForm({ verdict });
  openSubmit();
}

/** localStorage key of the "seen" marks of the comparison shown (base -> version), or null off a doc. @param {UiState} s */
export function seenStorageKey(s) {
  const r = s.route;
  return r.view === 'doc' ? `suiko.seen.${r.ws}/${r.doc}.${s.base}-${s.version}` : null;
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
  writeSeen(seenStorageKey(get()), ids, on);
}

/**
 * Marks changes of a comparison (its seenStorageKey) as seen, or not.
 * @param {string|null} key
 * @param {string[]} ids
 * @param {boolean} on
 */
function writeSeen(key, ids, on) {
  if (!key || !ids.length) return;
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

/** Ends the review session (like `suiko close`): a waiting agent stops waiting. */
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

/** Copies the review URL of the open doc, with the access token like `suiko open` prints it. */
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
 * Shows a toast (at most five at once). One with the same text as a toast on screen replaces it (three comments sent
 * in a row show one "Sent to Claude.", not three stacked over the panel).
 * @param {string} text
 * @param {{ tone?: string, timeout?: number, actions?: Array<{ label: string, run: () => void }> }} [opts]
 */
export function toast(text, opts = {}) {
  const id = ++toastSeq;
  const item = { id, text, tone: opts.tone || 'info', actions: opts.actions || [] };
  set((s) => ({ toasts: [...s.toasts.filter((t) => t.text !== text).slice(-4), item] }));
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
