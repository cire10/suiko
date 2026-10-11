// SpecReview guest, part 00: protocol constants.
//
// The guest is a classic script (no ES modules), so it cannot import src/shared/protocol.js. This part is a
// verbatim copy of the subset of constants the guest needs. test/guest/build.test.mjs evaluates this file and
// asserts it is identical to the exports of src/shared/protocol.js, so drift is caught by the test suite.
//
// Every part of the guest is concatenated (in the order of parts.json) into one IIFE; top-level declarations in
// one part are visible to all later parts.

/** Version of the guest wire behaviour (bump when message payloads change shape). */
const GUEST_VERSION = 1;

/** Characters of context captured on each side of a quote. */
const CONTEXT_CHARS = 32;

/** Text-exclusion rule shared with the server text stream (see protocol.js TEXT_EXCLUDE). */
const TEXT_EXCLUDE = Object.freeze({
  tags: ['script', 'style', 'noscript', 'template', 'textarea', 'title'],
  classes: ['katex-mathml'],
  attrs: ['data-sr-ignore'],
  kinds: ['mermaid'],
});

/** Tags treated as "block" (protocol.js BLOCK_TAGS). */
const BLOCK_TAGS = Object.freeze([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'dt', 'dd', 'blockquote', 'pre', 'table', 'thead', 'tbody',
  'tr', 'td', 'th', 'figure', 'figcaption', 'img', 'svg', 'canvas', 'video', 'audio', 'iframe', 'embed', 'object',
  'hr', 'details', 'summary', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'div', 'ul', 'ol',
  'dl', 'form',
]);

/** Elements the pick tool targets as whole elements (protocol.js PICKABLE_TAGS). */
const PICKABLE_TAGS = Object.freeze([
  'img', 'picture', 'svg', 'canvas', 'video', 'audio', 'iframe', 'table', 'tr', 'td', 'th', 'pre', 'figure',
  'details', 'li', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'section', 'article', 'aside', 'div',
]);

/** postMessage / MessagePort message types (protocol.js MSG). */
const MSG = Object.freeze({
  HELLO: 'hello',
  READY: 'ready',
  SELECTION: 'selection',
  ACTION: 'action',
  POSITIONS: 'positions',
  ACTIVATE: 'activate',
  KEY: 'key',
  SCROLL: 'scroll',
  PAGE_ERROR: 'pageError',
  TOOL_CHANGED: 'toolChanged', // {tool}: Esc / a finished pick or snip -> 'select'; 'b' in the doc -> 'snip'
  CONNECT: 'connect',
  INIT: 'init',
  SET_TARGETS: 'setTargets',
  SET_CHANGES: 'setChanges',
  FOCUS: 'focus',
  SCROLL_TO: 'scrollTo',
  SET_TOOL: 'setTool',         // {tool: 'select'|'pick'|'snip'}
  SET_THEME: 'setTheme',
  REVEAL: 'reveal',
  CLEAR_SELECTION: 'clearSelection',
  SET_HIDDEN: 'setHidden',
});

/** Snips: drag a box over any area of the doc (protocol.js SNIP; the SnipCapture shape is documented there). */
const SNIP = Object.freeze({ minPx: 8, maxSrids: 60, maxText: 2000, maxScreenPx: 2000 });
