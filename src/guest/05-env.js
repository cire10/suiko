// SpecReview guest, part 05: environment, small utilities and the early handshake listener.
//
// This part runs synchronously while the <script> tag is being executed (the daemon inserts the tag right after
// <head>), i.e. before any of the document's own scripts. It:
//   - reads the UI origin allowlist (data-sr-ui) and the target id (data-sr-target) from document.currentScript;
//   - installs the capture-phase window 'message' listener that accepts exactly one {sr:1,type:'connect'} message
//     carrying a MessagePort from window.parent at an allowed origin, then stops its propagation. After that
//     handshake every window message is ignored: all traffic uses the MessagePort (see 20-channel.js);
//   - starts the srid index (SridIndex: srid -> the parser-inserted element, so copies made by page scripts never
//     shadow the stamped original);
//   - defines helpers shared by later parts (guard, debounce, srid lookups, rect serialisation).

const SCRIPT_EL = /** @type {HTMLScriptElement|null} */ (document.currentScript);

/**
 * Parses a whitespace-separated list of origins, keeping only valid http(s) origins (deduplicated, in order).
 * @param {string|undefined|null} list
 * @returns {string[]}
 */
function parseOrigins(list) {
  const out = [];
  for (const item of String(list || '').split(/\s+/)) {
    if (!item) continue;
    try {
      const u = new URL(item);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && !out.includes(u.origin)) out.push(u.origin);
    } catch { /* ignore malformed entries */ }
  }
  return out;
}

const ENV = Object.freeze({
  allowedOrigins: Object.freeze(parseOrigins(SCRIPT_EL && SCRIPT_EL.getAttribute('data-sr-ui'))),
  target: (SCRIPT_EL && SCRIPT_EL.getAttribute('data-sr-target')) || '',
  framed: window.parent !== window,
});

/** Internal errors of the guest itself (never thrown into the page; inspectable via window.__specreviewGuest). */
const guestErrors = [];

/**
 * Wraps a callback so an exception inside the guest never escapes into the page (it would otherwise be counted as
 * a page error and could break the author's handlers).
 * @template {Function} F
 * @param {F} fn
 * @param {string} label
 * @returns {F}
 */
function guard(fn, label) {
  return /** @type {any} */ (function guarded(...args) {
    try {
      return fn.apply(this, args);
    } catch (err) {
      recordGuestError(label, err);
      return undefined;
    }
  });
}

/** @param {string} label @param {unknown} err */
function recordGuestError(label, err) {
  guestErrors.push({ label, message: String((err && /** @type {any} */ (err).stack) || err) });
  if (guestErrors.length > 50) guestErrors.shift();
}

/**
 * Trailing debounce with an optional maximum wait (so a continuously mutating page still gets updates).
 * @param {() => void} fn
 * @param {number} wait
 * @param {number} [maxWait]
 */
function debounce(fn, wait, maxWait) {
  let timer = 0;
  let first = 0;
  const run = () => {
    timer = 0;
    first = 0;
    fn();
  };
  const call = () => {
    const now = Date.now();
    if (!first) first = now;
    if (timer) clearTimeout(timer);
    const remaining = maxWait ? Math.max(0, Math.min(wait, first + maxWait - now)) : wait;
    timer = /** @type {any} */ (setTimeout(run, remaining));
  };
  call.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = 0;
    first = 0;
  };
  return call;
}

/** @param {unknown} n @returns {n is Element} */
function isElement(n) {
  return !!n && /** @type {Node} */ (n).nodeType === 1;
}

/**
 * The numeric data-srid of an element, or null.
 * @param {Element|null|undefined} el
 */
function sridOf(el) {
  if (!el || !el.getAttribute) return null;
  const v = el.getAttribute('data-srid');
  if (v == null || !/^\d+$/.test(v)) return null;
  return Number(v);
}

/**
 * Nearest element (inclusive) carrying data-srid for a node.
 * @param {Node|null|undefined} node
 * @returns {Element|null}
 */
function closestSridEl(node) {
  let el = node && (isElement(node) ? node : node.parentElement);
  while (el) {
    if (sridOf(el) != null) return el;
    el = el.parentElement;
  }
  return null;
}

/**
 * srid -> the element the HTML parser inserted with that srid (the stamped original).
 *
 * A document script can copy stamped elements (a TOC built with `h.cloneNode(true)`, a carousel duplicating its
 * slides), and a copy keeps the data-srid of its original. When the copy comes first in document order,
 * document.querySelector would return it, and highlights, scroll-to and the outline would go to the copy. So, from the
 * moment the guest runs (at the start of <head>, before any of the document's own scripts) until DOMContentLoaded, a
 * MutationObserver records the first element seen with each srid. Records arrive in insertion order and the parser
 * delivers them (microtask checkpoint) before every parser-inserted script runs, so the parser's element is always
 * seen before any copy a script makes of it. Only the added nodes themselves are recorded (never their subtrees):
 * the parser inserts every element on its own, and a subtree inserted by a script is a copy or a re-creation.
 * After DOMContentLoaded the observer is disconnected: lookups use the recorded element while it is still connected
 * and still carries the srid, and otherwise fall back to the first match in document order.
 */
const SridIndex = (() => {
  /** @type {Map<number, Element>} */
  const first = new Map();
  /** @type {MutationObserver|null} */
  let mo = null;

  /** @param {Node} node */
  function note(node) {
    if (!isElement(node)) return;
    const n = sridOf(node);
    if (n != null && !first.has(n)) first.set(n, node);
  }

  /** @param {MutationRecord[]} records */
  function onRecords(records) {
    for (const rec of records) for (const node of rec.addedNodes) note(node);
  }

  function stop() {
    if (!mo) return;
    onRecords(mo.takeRecords());
    mo.disconnect();
    mo = null;
    // Anything the observer could not have seen (it should not happen) is taken in document order.
    for (const el of document.querySelectorAll('[data-srid]')) note(el);
  }

  try {
    for (const el of document.querySelectorAll('[data-srid]')) note(el);
    if (document.readyState === 'loading' && typeof MutationObserver === 'function') {
      mo = new MutationObserver(guard(onRecords, 'srid-index'));
      mo.observe(document, { childList: true, subtree: true });
      document.addEventListener('DOMContentLoaded', guard(stop, 'srid-index-stop'), { once: true, capture: true });
    }
  } catch (err) {
    recordGuestError('srid-index', err);
  }

  return {
    /** @param {number} n @returns {Element|null} */
    get(n) {
      if (mo) onRecords(mo.takeRecords());
      const known = first.get(n);
      if (known && known.isConnected && sridOf(known) === n) return known;
      const el = document.querySelector('[data-srid="' + n + '"]');
      if (el) first.set(n, el);
      else first.delete(n);
      return el;
    },
  };
})();

/**
 * The element stamped with a srid: the parser's original even when a script copied it (see SridIndex).
 * @param {number|null|undefined} srid
 * @returns {Element|null}
 */
function elementBySrid(srid) {
  if (srid == null || !Number.isFinite(Number(srid))) return null;
  return SridIndex.get(Number(srid));
}

/** Collapses whitespace runs to one space and trims. @param {string} s */
function normWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** @param {string} s @param {number} n */
function clip(s, n) {
  const t = normWs(s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** @param {number} x */
function round4(x) {
  return Math.round(x * 10000) / 10000;
}

/** @param {number} x @param {number} lo @param {number} hi */
function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * A DOMRect as a plain JSON object (viewport coordinates of this document), rounded to 0.1 px.
 * @param {DOMRect|{x:number,y:number,width:number,height:number}|null} r
 */
function rectJSON(r) {
  if (!r) return null;
  const q = (/** @type {number} */ v) => Math.round(v * 10) / 10;
  const x = q(r.x), y = q(r.y), width = q(r.width), height = q(r.height);
  return { x, y, width, height, top: y, left: x, right: q(r.x + r.width), bottom: q(r.y + r.height) };
}

/** True when a DOMRect has no area and sits at the origin (the element is not rendered). */
function isEmptyRect(/** @type {DOMRect} */ r) {
  return !r || (r.width === 0 && r.height === 0 && r.x === 0 && r.y === 0);
}

/** @param {Element|null} el */
function isEditable(el) {
  if (!el) return false;
  const tag = el.localName;
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = (/** @type {HTMLInputElement} */ (el).type || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'].includes(type);
  }
  return !!(/** @type {HTMLElement} */ (el).isContentEditable);
}

/** The deepest active element, looking through open shadow roots (nested frames are not entered). */
function deepActiveElement() {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/**
 * Handshake state. The first valid 'connect' message wins; later window messages are ignored entirely.
 * @type {{port: MessagePort|null, origin: string|null, listeners: Array<(port: MessagePort, origin: string) => void>}}
 */
const Handshake = { port: null, origin: null, listeners: [] };

window.addEventListener('message', guard((/** @type {MessageEvent} */ ev) => {
  if (Handshake.port) return; // after the handshake: window messages are never trusted
  const d = ev.data;
  if (!d || typeof d !== 'object' || d.sr !== 1 || d.type !== MSG.CONNECT) return;
  if (!ENV.framed || ev.source !== window.parent) return;
  if (!ENV.allowedOrigins.includes(ev.origin)) return;
  const port = ev.ports && ev.ports[0];
  if (!port) return;
  ev.stopImmediatePropagation();
  Handshake.port = port;
  Handshake.origin = ev.origin;
  for (const fn of Handshake.listeners) guard(fn, 'handshake')(port, ev.origin);
}, 'message'), true);
