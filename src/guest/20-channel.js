// Suiko guest, part 20: the message channel to the reviewer UI.
//
// Handshake (amendments section 7 / protocol.js MSG, GUEST_VERSION 2):
//   1. guest -> parent.postMessage({sr:1, type:'hello', nonce, ...}, origin), sent once, synchronously while the
//      bundle runs (99-main.js), so before any script of the page: ENV.parent was taken before the page's scripts ran,
//      and the nonce is the one the UI put on this frame's URL (05-env.js HELLO_NONCE). It goes to each allowed UI
//      origin; postMessage silently drops the copies whose targetOrigin does not match the real parent.
//   2. UI -> iframe.contentWindow.postMessage({sr:1, type:'connect'}, contentOrigin, [port2]), only for the hello with
//      the nonce of the frame's latest load (src/ui/frame.js).
//   3. the early capture listener in 05-env.js takes the port of every valid connect (the newest one is the UI's
//      current channel: the guest moves to it and closes the old one); all traffic uses the MessagePort, and window
//      messages are never read.
//   4. on pagehide (the browser's own event, and not into the back/forward cache) the guest posts `bye` on the port.
// Incoming port messages are queued until Main calls Channel.open() (after the overlay exists), then dispatched to
// handlers registered with Channel.on(type, fn). Outgoing messages before the port exists are dropped: every module
// re-sends its current state when the connection is established.
// The port is only ever touched through the methods 05-env.js took before the page's scripts ran (Ports), handlers
// live in a null-prototype object and every list is walked by index: a page script that replaced a prototype method
// or getter is never handed the port, a message from the UI or a handler.

const Channel = (() => {
  /** @type {MessagePort|null} */
  let port = null;
  let opened = false;
  /** @type {any[]} */
  const inbox = [];
  /** type -> handlers (a null-prototype object: no Map method a page script could replace). @type {Record<string, Array<(msg: any) => void>>} */
  const handlers = Intrinsics.create(null);
  /** @type {Array<() => void>} */
  const connectHooks = [];

  /** @param {any} msg */
  function dispatch(msg) {
    const list = handlers[msg.type];
    if (!list) return;
    for (let i = 0; i < list.length; i++) guard(list[i], 'recv:' + msg.type)(msg);
  }

  function runConnectHooks() {
    for (let i = 0; i < connectHooks.length; i++) guard(connectHooks[i], 'connect')();
  }

  /** @param {MessageEvent} ev */
  function onPortMessage(ev) {
    const d = MessageEvents.data(ev);
    if (!d || typeof d !== 'object' || d.sr !== 1 || typeof d.type !== 'string') return;
    if (!opened) {
      if (inbox.length < 500) inbox[inbox.length] = d;
      return;
    }
    dispatch(d);
  }

  /** The port of a valid connect (05-env.js): the UI's newest channel. @param {MessagePort} p */
  function attach(p) {
    if (p === port) return;
    const old = port;
    port = p;
    if (old) {
      try {
        Ports.onMessage(old, null);
        Ports.close(old);
      } catch (err) {
        recordGuestError('port-close', err);
      }
    }
    Ports.onMessage(p, guard(onPortMessage, 'port'));
    if (opened) runConnectHooks();
  }

  Handshake.listeners[Handshake.listeners.length] = attach;

  /**
   * Posts {sr:1, type, ...payload} on the port. Silently dropped before the handshake. The envelope is built on a
   * null-prototype object, so a setter a page script put on Object.prototype never sees or drops a field of it.
   * @param {string} type
   * @param {Record<string, any>} [payload]
   */
  function send(type, payload) {
    if (!port) return false;
    const msg = Intrinsics.assign(Intrinsics.create(null), payload || {}, { sr: 1, type });
    try {
      Ports.post(port, msg);
      return true;
    } catch (err) {
      recordGuestError('send:' + type, err);
      return false;
    }
  }

  // The page is going away for good: tell the UI, so it stops talking to this port. Not when the page goes into the
  // back/forward cache (it may come back, and the port with it), and never for a pagehide a page script dispatched.
  listenOwn(window, 'pagehide', guard((/** @type {PageTransitionEvent} */ ev) => {
    if (!ev.isTrusted) return;
    const persisted = Intrinsics.persisted ? ReflectApply(Intrinsics.persisted, ev, []) : ev.persisted;
    if (!persisted) send(MSG.BYE);
  }, 'pagehide'), true);

  return {
    get connected() {
      return !!port;
    },
    send,
    /** @param {string} type @param {(msg: any) => void} fn */
    on(type, fn) {
      const list = handlers[type] || (handlers[type] = []);
      list[list.length] = fn;
    },
    /** Registers a hook run once the port is connected and the channel is open. @param {() => void} fn */
    onConnect(fn) {
      connectHooks[connectHooks.length] = fn;
    },
    /** Starts dispatching (flushes messages that arrived before the guest finished starting). */
    open() {
      if (opened) return;
      opened = true;
      if (port) runConnectHooks();
      for (let i = 0; i < inbox.length; i++) dispatch(inbox[i]);
      inbox.length = 0;
    },
    /**
     * Sends the handshake 'hello' (with the nonce of this frame's URL) to every allowed UI origin. Called once, while
     * the bundle runs (99-main.js).
     * @param {Record<string, any>} payload
     */
    hello(payload) {
      if (!ENV.framed) return;
      const msg = Object.assign({ sr: 1, type: MSG.HELLO }, payload, { sr: 1, type: MSG.HELLO, nonce: HELLO_NONCE });
      // When the browser tells us the parent's origin, post only to it (avoids console warnings for the
      // non-matching allowlist entries); a known parent outside the allowlist gets nothing. A masked ancestor
      // origin ("null", e.g. under referrerpolicy=no-referrer) falls back to every allowed origin.
      let targets = ENV.allowedOrigins;
      const ancestors = location.ancestorOrigins;
      const parentOrigin = ancestors && ancestors.length ? ancestors[0] : 'null';
      if (parentOrigin !== 'null') targets = ENV.allowedOrigins.includes(parentOrigin) ? [parentOrigin] : [];
      for (const origin of targets) {
        try {
          ENV.parent.postMessage(msg, origin);
        } catch (err) {
          recordGuestError('hello', err);
        }
      }
    },
  };
})();
