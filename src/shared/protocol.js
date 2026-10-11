// @ts-check
// Shared constants for every SpecReview component (core, CLI, MCP, daemon, guest, UI).
// This file must stay dependency-free and valid in both Node and the browser (the UI imports it
// through /ui-shared/protocol.js; the guest bundle inlines a copy of the constants it needs).

export const SCHEMA = 1;
export const RENDERER_VERSION = 'r1';
export const APP_NAME = 'specreview';

/** Process exit codes for the CLI. */
export const EXIT = Object.freeze({
  OK: 0,          // success / review delivered (any verdict)
  ERROR: 1,       // generic error or bad usage
  TIMEOUT: 2,     // wait timed out
  REFUSED: 3,     // guard refusal, dirty working copy, CAS conflict, old_string not unique
  NOT_FOUND: 4,   // doc / thread / version not found
  CLOSED: 5,      // review session closed by reviewer or `specreview close`
  SUPERSEDED: 6,  // another `wait` for the same doc+agent replaced this one
});

export const PORTS = Object.freeze({ ui: 4777, content: 4778, max: 4799 });

/** Characters of context captured on each side of a quote (rendered and source). */
export const CONTEXT_CHARS = 32;

/**
 * Text-exclusion rule shared by the server text stream and the guest's DOM text walk.
 * Text under any of these is not part of the "rendered text" used for quotes.
 */
export const TEXT_EXCLUDE = Object.freeze({
  tags: ['script', 'style', 'noscript', 'template', 'textarea', 'title'],
  classes: ['katex-mathml'],
  attrs: ['data-sr-ignore'],
  kinds: ['mermaid'], // elements with data-sr-kind="mermaid" (their text is diagram source, not prose)
});

/** Tags treated as "block" for change bars, outline, and widening. */
export const BLOCK_TAGS = Object.freeze([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'dt', 'dd', 'blockquote', 'pre', 'table', 'thead', 'tbody',
  'tr', 'td', 'th', 'figure', 'figcaption', 'img', 'svg', 'canvas', 'video', 'audio', 'iframe', 'embed', 'object',
  'hr', 'details', 'summary', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'div', 'ul', 'ol',
  'dl', 'form',
]);

/** Elements the pick tool ("e") targets as whole elements. */
export const PICKABLE_TAGS = Object.freeze([
  'img', 'picture', 'svg', 'canvas', 'video', 'audio', 'iframe', 'table', 'tr', 'td', 'th', 'pre', 'figure',
  'details', 'li', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'section', 'article', 'aside', 'div',
]);

/** Id prefixes; ids are sequential per doc (t1, c1, rv1, L1, D1, d1, a1) and versions are v1, v2... */
export const ID_PREFIX = Object.freeze({
  thread: 't', comment: 'c', review: 'rv', lock: 'L', decision: 'D', draft: 'd', attachment: 'a',
});

export const THREAD_TYPES = Object.freeze(['comment', 'question', 'suggestion', 'agent-question']);
export const SEVERITIES = Object.freeze(['blocking', 'normal', 'nit']);
export const THREAD_STATUS = Object.freeze(['open', 'addressed', 'answered', 'declined', 'needs_input', 'resolved']);
export const AGENT_REPLY_STATUS = Object.freeze(['addressed', 'answered', 'declined', 'needs_input']);
export const VERDICTS = Object.freeze(['comment', 'changes_requested', 'approved']);
export const ANCHOR_KINDS = Object.freeze(['text', 'element', 'cell', 'code', 'section', 'source', 'doc', 'snip']);
export const ANCHOR_STATES = Object.freeze(['exact', 'moved', 'edited', 'changed', 'orphaned']);

/** Server-sent event names (UI origin, GET /api/events). Payloads are hints; clients refetch DocState. */
export const SSE = Object.freeze({
  VERSION_CREATED: 'version.created',
  REVIEW_SUBMITTED: 'review.submitted',
  REVIEW_DELIVERED: 'review.delivered',
  REVIEW_ACKED: 'review.acked',
  THREAD_UPDATED: 'thread.updated',
  LOCK_CHANGED: 'lock.changed',
  DRAFTS_CHANGED: 'drafts.changed',
  DOC_APPROVED: 'doc.approved',
  DOC_OPENED: 'doc.opened',
  SESSION_CLOSED: 'session.closed',
  WORKING_CHANGED: 'working.changed',
  PRESENCE: 'presence',
  RESET: 'reset',
  PING: 'ping',
});

/**
 * postMessage / MessagePort protocol between the UI (parent, UI origin) and the guest (inside the doc iframe,
 * content origin). Envelope: { sr: 1, type, ...payload }.
 * Handshake: guest -> window.parent.postMessage({sr:1,type:'hello',...}, uiOrigin) for each allowed UI origin.
 * UI -> iframe.contentWindow.postMessage({sr:1,type:'connect'}, contentOrigin, [port2]).
 * The guest's capture-phase window 'message' listener (installed before any page script) takes the port and calls
 * stopImmediatePropagation(). All further traffic in both directions uses the MessagePort only.
 */
export const MSG = Object.freeze({
  // guest -> UI
  HELLO: 'hello',             // {target, title, href, highlightApi}
  READY: 'ready',             // {outline:[{srid,level,text,line?,id}], features:{mermaid,math,code}, externalsFailed:[url]}
  SELECTION: 'selection',     // {capture|null, rect|null}
  ACTION: 'action',           // {action:'comment'|'suggest'|'question'|'agree', capture, rect, crop?: dataUrl}
  POSITIONS: 'positions',     // {targets:{[id]:{top,height,state:'ok'|'block'|'hidden'|'missing'}}, hunks:{[id]:top}, scrollY, viewportH, docH}
  ACTIVATE: 'activate',       // {id}  (user clicked a highlight / pin / change bar)
  KEY: 'key',                 // {key, meta, ctrl, shift, alt}  (only non-editable focus, not defaultPrevented;
                              // Mod+K / Mod+, / Mod+/ are also forwarded from editable focus and default-prevented)
  SCROLL: 'scroll',           // {topSrid}
  PAGE_ERROR: 'pageError',    // {count, last}
  TOOL_CHANGED: 'toolChanged',// {tool}  (guest changed tool itself: Esc / a finished pick or snip -> 'select'; 'b' in the doc -> 'snip')
  // UI -> guest
  CONNECT: 'connect',         // carries the MessagePort (window message, not port)
  INIT: 'init',               // {mode:'review'|'changes'|'readonly', theme, targets:DomTarget[], changes:Changes|null, activeId, hidden, prefs?}
  SET_TARGETS: 'setTargets',  // {targets:DomTarget[]}
  SET_CHANGES: 'setChanges',  // {changes:Changes|null}
  FOCUS: 'focus',             // {id}   highlight as active + scroll into view + pulse
  SCROLL_TO: 'scrollTo',      // {srid?|id?|hunk?}
  SET_TOOL: 'setTool',        // {tool:'select'|'pick'|'snip'}  (snip: drag a box over ANY area of the doc, see SNIP below)
  SET_THEME: 'setTheme',      // {theme:'light'|'dark'|'system'}
  REVEAL: 'reveal',           // {id}   open <details>/tabs hiding the target
  CLEAR_SELECTION: 'clearSelection',
  SET_HIDDEN: 'setHidden',    // {hidden:boolean}  hide all annotations (clean read)
  SET_PREFS: 'setPrefs',      // {singleKeys:boolean}  false: the guest neither acts on nor captures single-letter keys
                              // (c s q a b ...); it forwards them like any other key. Also accepted inside INIT as prefs.
});

/** data-testid values the UI must render (used by e2e tests). */
export const TESTID = Object.freeze({
  docFrame: 'doc-frame',
  threadPanel: 'thread-panel',
  threadCard: 'thread-card',           // plus data-thread-id="t1"
  composer: 'composer',
  composerTextarea: 'composer-textarea',
  composerAdd: 'composer-add',         // "Add to review"
  composerSendNow: 'composer-send-now',
  composerSuggestion: 'composer-suggestion',
  submitReviewOpen: 'submit-review-open',
  submitReviewDialog: 'submit-review-dialog',
  submitVerdict: 'submit-verdict',     // radio group; inputs have value=comment|changes_requested|approved
  submitConfirm: 'submit-confirm',
  modeTab: 'mode-tab',                 // plus data-mode="review|changes|source|history"
  versionPicker: 'version-picker',
  presence: 'presence',
  verifyAccept: 'verify-accept',
  verifyReopen: 'verify-reopen',
  replyTextarea: 'reply-textarea',
  replyAdd: 'reply-add',
  toast: 'toast',
  pickTool: 'pick-tool',
  snipTool: 'snip-tool',               // snip an area of the doc (key b)
  snipScreen: 'snip-screen',           // snip anywhere on screen via macOS screencapture (key B)
  composerAttachment: 'composer-attachment', // thumbnail of an attached screenshot in the composer
  commandPalette: 'command-palette',           // Cmd/Ctrl+K dialog
  commandPaletteInput: 'command-palette-input',
  commandPaletteOpen: 'command-palette-open',  // top-bar button
  commandItem: 'command-item',                 // plus data-command-id
  settingsDialog: 'settings-dialog',           // Cmd/Ctrl+, dialog
  settingsOpen: 'settings-open',               // top-bar gear button
  helpOverlay: 'help-overlay',                 // Cmd/Ctrl+/ or ? dialog
  helpOpen: 'help-open',
  changeItem: 'change-item',           // plus data-hunk-id
  historyRow: 'history-row',           // plus data-version
  docList: 'doc-list',
});

export const LIMITS = Object.freeze({
  packetChars: 10000,
  threadSrcChars: 1200,
  maxAttachmentBytes: 5 * 1024 * 1024,
  maxServeBytes: 200 * 1024 * 1024,
  // `specreview snapshot <url>` (design 6.2): body cap (after decompression), total time, redirect hops, and the
  // text length under which a page that had scripts gets the "rendered by JavaScript" note
  urlMaxBytes: 10 * 1024 * 1024,
  urlTimeoutMs: 30000,
  urlMaxRedirects: 10,
  urlLowTextChars: 200,
});

/**
 * Snips (hotkey `b` in the review UI or the doc): the reviewer drags a box over ANY area of the rendered doc (text,
 * images, diagrams, mixed). The guest sends MSG.ACTION {action:'comment', capture: SnipCapture, rect, crop?} where crop
 * is a PNG data URL of exactly the boxed area (rasterised in the doc with the vendored modern-screenshot library;
 * omitted when rasterising fails or is blocked).
 *
 * SnipCapture = { kind: 'snip',
 *   srids: number[],          // stamped LEAF block elements (see BLOCK_TAGS) that intersect the box, document order, max SNIP.maxSrids
 *   startSrid, endSrid,       // first / last of srids (null when the box covers no stamped block)
 *   containerSrid,            // deepest stamped element whose box contains the whole snip box (null -> none)
 *   region: {x,y,w,h},        // the box as fractions of containerSrid's border box (or of the document when containerSrid is null)
 *   text: string,             // visible text inside the box, whitespace-collapsed, max SNIP.maxText chars
 *   label: string }           // short human label, e.g. 'area over "2. Request flow" (figure + 2 paragraphs)'
 *
 * Screen snips (hotkey `B`, the UI's snip-screen button, or `specreview snip` from a terminal / macOS Shortcut) use the
 * macOS `screencapture -i` region picker on the reviewer's machine; the PNG becomes a composer/draft attachment on a
 * general (kind 'doc') comment, or on the current selection when there is one.
 */
export const SNIP = Object.freeze({ minPx: 8, maxSrids: 60, maxText: 2000, maxScreenPx: 2000 });

