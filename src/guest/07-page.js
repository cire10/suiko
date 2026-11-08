// Suiko guest, part 07: the document's own behaviour, observed (and in one case adjusted) before its scripts run.
//
// Like part 05, this part runs synchronously while the guest <script> tag executes, so before any script of the
// document. It:
//   - notes which key listeners the document installs (PageKeys). EventTarget.prototype.addEventListener is wrapped
//     (the call itself is passed through unchanged): a keydown / keyup / keypress listener added to window,
//     document, <html> or <body> means the page handles keys itself (a keyboard-driven report, an app, a slide deck);
//     one added to any other element marks that element. The `on<key>` handler properties of those nodes count
//     too; they are read when a key is pressed. 85-keys.js then forwards far fewer keys to the reviewer UI, so the
//     doc's own shortcuts never drive Suiko. The guest registers its own key listeners with listenOwn(), which uses
//     the browser's original method and is never counted;
//   - makes IntersectionObserver work inside the frame (see patchIntersectionObserver).

/** The browser's own addEventListener (the guest's own listeners go through it: listenOwn). */
const NATIVE_ADD_LISTENER = typeof EventTarget === 'function' ? EventTarget.prototype.addEventListener : null;

/**
 * Adds one of the guest's own event listeners with the browser's original method, so PageKeys never counts it.
 * @param {EventTarget} target @param {string} type @param {EventListener|((ev: any) => void)} fn
 * @param {boolean|AddEventListenerOptions} [options]
 */
function listenOwn(target, type, fn, options) {
  if (NATIVE_ADD_LISTENER) NATIVE_ADD_LISTENER.call(target, type, /** @type {EventListener} */ (fn), options);
  else target.addEventListener(type, /** @type {EventListener} */ (fn), options);
}

const PageKeys = (() => {
  const KEY_TYPES = new Set(['keydown', 'keyup', 'keypress']);
  const HANDLER_PROPS = ['onkeydown', 'onkeyup', 'onkeypress'];
  /** A key listener on window / document / <html> / <body> was added by the page. */
  let onRoot = false;
  /** Other elements the page added key listeners to. @type {WeakSet<object>} */
  const elements = new WeakSet();

  /** @param {any} t */
  function isRoot(t) {
    return t === window || t === document || t === document.documentElement || (!!document.body && t === document.body);
  }

  if (NATIVE_ADD_LISTENER) {
    const native = NATIVE_ADD_LISTENER;
    /**
     * @this {any}
     * @param {string} type @param {any} listener @param {any} [options]
     */
    const addEventListener = function addEventListener(type, listener, options) {
      try {
        if (listener && KEY_TYPES.has(type)) {
          // a bare addEventListener(...) call runs on the global object
          const target = this == null ? window : this;
          if (isRoot(target)) onRoot = true;
          else if (target && typeof target === 'object' && isElement(target)) elements.add(target);
        }
      } catch (err) {
        recordGuestError('page-keys', err);
      }
      return native.call(this, type, listener, options);
    };
    try {
      Object.defineProperty(EventTarget.prototype, 'addEventListener', {
        value: addEventListener, writable: true, enumerable: true, configurable: true,
      });
    } catch (err) {
      recordGuestError('page-keys-wrap', err);
    }
  }

  /** @param {any} node */
  function hasHandlerProp(node) {
    if (!node) return false;
    for (const p of HANDLER_PROPS) if (typeof node[p] === 'function') return true;
    return false;
  }

  return {
    /**
     * Whether the page handles keys around this key press: key listeners (or on<key> handlers) on window,
     * document, <html> or <body>, or on an element the key passes through (its composed path).
     * @param {EventTarget[]} [path] the event's composedPath()
     */
    handled(path) {
      if (onRoot) return true;
      if (hasHandlerProp(window) || hasHandlerProp(document) || hasHandlerProp(document.documentElement) ||
          hasHandlerProp(document.body)) return true;
      for (const n of path || []) {
        if (n === window || n === document || OWN_NODES.has(/** @type {any} */ (n))) continue;
        if (elements.has(n) || (isElement(n) && hasHandlerProp(n))) return true;
      }
      return false;
    },
    /** Debug: whether a root listener was seen. */
    get onRoot() {
      return onRoot;
    },
  };
})();

/**
 * IntersectionObserver inside the frame. Without a `root`, an observer measures against the TOP-level viewport, and
 * because the doc (content origin) is a cross-origin frame of the reviewer UI, the browser then ignores `rootMargin`
 * and reports `rootBounds` null: a scrollspy built on rootMargin ("-50% 0 -50% 0") highlights the section after the
 * one being read. The doc's viewport is its own document's, so an observer created without a root (or root null)
 * gets `root: document` (same viewport, rootMargin honoured). Only when framed; the constructor, subclasses,
 * instanceof and every other option keep working (the options object is the prototype of the one passed on).
 */
(function patchIntersectionObserver() {
  const Native = window.IntersectionObserver;
  if (!ENV.framed || typeof Native !== 'function' || typeof Reflect !== 'object') return;
  try {
    /**
     * @this {any}
     * @param {IntersectionObserverCallback} callback @param {IntersectionObserverInit} [options]
     */
    const Shim = function IntersectionObserver(callback, options) {
      // called without new: the native constructor throws the same TypeError
      if (!new.target) return /** @type {any} */ (Native)(callback, options);
      const o = /** @type {any} */ (options);
      const bare = o == null || ((typeof o === 'object' || typeof o === 'function') && o.root == null);
      const opts = bare ? Object.create(o == null ? null : o, { root: { value: document, enumerable: true } }) : o;
      return Reflect.construct(Native, [callback, opts], new.target);
    };
    Shim.prototype = Native.prototype;
    Object.setPrototypeOf(Shim, Native);
    Object.defineProperty(window, 'IntersectionObserver', { value: Shim, writable: true, enumerable: false, configurable: true });
  } catch (err) {
    recordGuestError('intersection-observer', err);
  }
})();
