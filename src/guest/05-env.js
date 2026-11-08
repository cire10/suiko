// Suiko guest, part 05: environment, small utilities and the early handshake listener.
//
// This part runs synchronously while the <script> tag is being executed (the daemon inserts the tag before anything
// the author wrote: right after the doctype, html.js), i.e. before any of the document's own scripts. It:
//   - captures the built-ins the channel relies on (Intrinsics) before a page script can replace them;
//   - takes the handshake nonce out of the frame's URL (HELLO_NONCE, sent back in the hello by 20-channel.js);
//   - reads the UI origin allowlist (data-sr-ui) and the target id (data-sr-target) from document.currentScript;
//   - installs the capture-phase window 'message' listener that takes every valid {sr:1,type:'connect'} message (a
//     trusted event carrying a MessagePort from window.parent at an allowed origin) and stops its propagation, so
//     the page's own listeners never see one; the newest connect is the UI's current channel (see 20-channel.js);
//   - starts the srid index (SridIndex: srid -> the parser-inserted element, so copies made by page scripts never
//     shadow the stamped original);
//   - defines helpers shared by later parts (guard, debounce, srid lookups, rect serialisation).
//
// The page's scripts share this realm: they can replace any prototype method or getter, and a replaced one is called
// with the guest's objects (`this`, its arguments). On the channel's path the guest therefore only calls the copies
// taken here, never Function.prototype.apply / call, and loops over its own arrays by index (a replaced
// Array.prototype[Symbol.iterator] would be handed them): no page script can be handed the MessagePort, an event that
// carries it, or a function that would attach the guest to another port.

/**
 * The built-ins the channel uses, as they were when the bundle started (see the header). A missing one (an older
 * browser) falls back to a plain property read or call.
 */
const Intrinsics = (() => {
  /** @param {any} proto @param {string} name @param {'get'|'set'|'value'} kind @returns {any} */
  const take = (proto, name, kind) => {
    try {
      const d = proto ? Object.getOwnPropertyDescriptor(proto, name) : undefined;
      return (d && typeof d[kind] === 'function' && d[kind]) || null;
    } catch {
      return null;
    }
  };
  const ME = typeof MessageEvent === 'function' ? MessageEvent.prototype : null;
  const MP = typeof MessagePort === 'function' ? MessagePort.prototype : null;
  const EV = typeof Event === 'function' ? Event.prototype : null;
  const PT = typeof PageTransitionEvent === 'function' ? PageTransitionEvent.prototype : null;
  return Object.freeze({
    apply: Reflect.apply,
    assign: Object.assign,
    create: Object.create,
    shift: Array.prototype.shift,
    data: take(ME, 'data', 'get'),
    origin: take(ME, 'origin', 'get'),
    source: take(ME, 'source', 'get'),
    ports: take(ME, 'ports', 'get'),
    stopImmediatePropagation: take(EV, 'stopImmediatePropagation', 'value'),
    persisted: take(PT, 'persisted', 'get'),
    postMessage: take(MP, 'postMessage', 'value'),
    close: take(MP, 'close', 'value'),
    setOnMessage: take(MP, 'onmessage', 'set'),
  });
})();

/** Reflect.apply as it was: a call that never goes through Function.prototype.apply / call. */
const ReflectApply = Intrinsics.apply;

/** A MessageEvent's data, origin, source and ports, read with the original getters. */
const MessageEvents = Object.freeze({
  /** @param {MessageEvent} ev @returns {any} */
  data: (ev) => (Intrinsics.data ? ReflectApply(Intrinsics.data, ev, []) : ev.data),
  /** @param {MessageEvent} ev @returns {string} */
  origin: (ev) => (Intrinsics.origin ? ReflectApply(Intrinsics.origin, ev, []) : ev.origin),
  /** @param {MessageEvent} ev @returns {any} */
  source: (ev) => (Intrinsics.source ? ReflectApply(Intrinsics.source, ev, []) : ev.source),
  /** @param {MessageEvent} ev @returns {ReadonlyArray<MessagePort>} */
  ports: (ev) => (Intrinsics.ports ? ReflectApply(Intrinsics.ports, ev, []) : ev.ports),
});

/** MessagePort methods and the onmessage setter, as they were. */
const Ports = Object.freeze({
  /** @param {MessagePort} port @param {any} msg */
  post(port, msg) {
    if (Intrinsics.postMessage) ReflectApply(Intrinsics.postMessage, port, [msg]);
    else port.postMessage(msg);
  },
  /** @param {MessagePort} port @param {((ev: MessageEvent) => void)|null} fn */
  onMessage(port, fn) {
    if (Intrinsics.setOnMessage) ReflectApply(Intrinsics.setOnMessage, port, [fn]);
    else port.onmessage = fn;
  },
  /** @param {MessagePort} port */
  close(port) {
    if (Intrinsics.close) ReflectApply(Intrinsics.close, port, []);
    else port.close();
  },
});

/**
 * The handshake nonce on the frame's URL (`?sr-nonce=<32 hex>`, protocol.js HELLO_NONCE_PARAM), or ''. It is taken out
 * of the address right away (history.replaceState), before any script of the page runs: the page sees its URL
 * without it, and only the guest's hello carries it. The UI answers only a hello with the nonce of the frame's latest
 * load, once, so a page that loads without the guest (a `javascript:` URL, a page next to the doc, a page the frame
 * reloaded by itself) can never take the guest's place: it cannot know a nonce the guest has not already used.
 */
const HELLO_NONCE = (() => {
  try {
    const raw = location.search.slice(1);
    if (!raw) return '';
    const parts = raw.split('&');
    const key = HELLO_NONCE_PARAM + '=';
    const rest = parts.filter((p) => !p.startsWith(key));
    if (rest.length === parts.length) return '';
    const value = parts.find((p) => p.startsWith(key)).slice(key.length);
    const href = location.href.replace(/[?#].*$/, '') + (rest.length ? '?' + rest.join('&') : '') + location.hash;
    try {
      history.replaceState(history.state, '', href);
    } catch { /* the nonce stays in the address; it is used up by the hello all the same */ }
    return /^[0-9a-f]{32}$/.test(value) ? value : '';
  } catch {
    return '';
  }
})();

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
  // Taken now, before the document's scripts: window.parent is replaceable, and a top-level `var parent = ...` in the
  // page replaces it for every later reader.
  parent: window.parent,
  framed: window.parent !== window,
});

/** Internal errors of the guest itself (never thrown into the page; inspectable via window.__suikoGuest). */
const guestErrors = [];

/**
 * Wraps a callback so an exception inside the guest never escapes into the page (it would otherwise be counted as
 * a page error and could break the author's handlers). Calls through the original Reflect.apply: a page script that
 * replaced Function.prototype.apply would otherwise be handed every guest callback.
 * @template {Function} F
 * @param {F} fn
 * @param {string} label
 * @returns {F}
 */
function guard(fn, label) {
  return /** @type {any} */ (function guarded(/** @type {any[]} */ ...args) {
    try {
      return ReflectApply(fn, this, args);
    } catch (err) {
      recordGuestError(label, err);
      return undefined;
    }
  });
}

/** @param {string} label @param {unknown} err */
function recordGuestError(label, err) {
  guestErrors[guestErrors.length] = { label, message: String((err && /** @type {any} */ (err).stack) || err) };
  if (guestErrors.length > 50) ReflectApply(Intrinsics.shift, guestErrors, []);
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
 * moment the guest runs (first in the page, before any of the document's own scripts) until DOMContentLoaded, a
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
 * Handshake state: the port of the newest valid 'connect' (the UI's current channel) and the code to run on one.
 * @type {{port: MessagePort|null, origin: string|null, listeners: Array<(port: MessagePort, origin: string) => void>}}
 */
const Handshake = { port: null, origin: null, listeners: [] };

/** Whether an origin is in the UI allowlist (a loop by index: a page script may replace Array.prototype.includes). */
function isAllowedOrigin(/** @type {unknown} */ origin) {
  const list = ENV.allowedOrigins;
  for (let i = 0; i < list.length; i++) if (list[i] === origin) return true;
  return false;
}

// Every valid connect is taken and stopped here, the first window 'message' listener of the page (capture phase, at
// the target: it runs before every listener and onmessage handler the page adds), so a connect never reaches the
// page, even when the UI connects more than once (each connect is the UI's newest channel: the guest moves to it).
// A connect is valid when the browser itself delivered it (isTrusted: an event a page script made and dispatched can
// claim any source, origin and port), from window.parent as it was before the page's scripts ran, at an allowed UI
// origin, with a port.
window.addEventListener('message', guard((/** @type {MessageEvent} */ ev) => {
  if (!ev.isTrusted || !ENV.framed) return;
  const d = MessageEvents.data(ev);
  if (!d || typeof d !== 'object' || d.sr !== 1 || d.type !== MSG.CONNECT) return;
  if (MessageEvents.source(ev) !== ENV.parent) return;
  const origin = MessageEvents.origin(ev);
  if (!isAllowedOrigin(origin)) return;
  const ports = MessageEvents.ports(ev);
  const port = ports && ports[0];
  if (!port) return;
  if (Intrinsics.stopImmediatePropagation) ReflectApply(Intrinsics.stopImmediatePropagation, ev, []);
  else ev.stopImmediatePropagation();
  Handshake.port = port;
  Handshake.origin = origin;
  const fns = Handshake.listeners;
  for (let i = 0; i < fns.length; i++) guard(fns[i], 'handshake')(port, origin);
}, 'message'), true);
