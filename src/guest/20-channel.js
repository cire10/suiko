// Suiko guest, part 20: the message channel to the reviewer UI.
//
// Handshake (amendments section 7 / protocol.js MSG):
//   1. guest -> parent.postMessage({sr:1, type:'hello', ...}, origin) once for each allowed UI origin (ENV.parent,
//      taken before the page's scripts ran; postMessage silently drops the copies whose targetOrigin does not match
//      the real parent);
//   2. UI -> iframe.contentWindow.postMessage({sr:1, type:'connect'}, contentOrigin, [port2]);
//   3. the early capture listener in 05-env.js takes the port; from then on all traffic uses the MessagePort and
//      window messages are ignored.
// Incoming port messages are queued until Main calls Channel.open() (after the overlay exists), then dispatched to
// handlers registered with Channel.on(type, fn). Outgoing messages before the port exists are dropped: every module
// re-sends its current state when the connection is established.

const Channel = (() => {
  /** @type {MessagePort|null} */
  let port = null;
  let opened = false;
  /** @type {any[]} */
  const inbox = [];
  /** @type {Map<string, Array<(msg: any) => void>>} */
  const handlers = new Map();
  /** @type {Array<() => void>} */
  const connectHooks = [];

  /** @param {any} msg */
  function dispatch(msg) {
    const list = handlers.get(msg.type);
    if (!list) return;
    for (const fn of list) guard(fn, 'recv:' + msg.type)(msg);
  }

  /** @param {MessageEvent} ev */
  function onPortMessage(ev) {
    const d = ev.data;
    if (!d || typeof d !== 'object' || d.sr !== 1 || typeof d.type !== 'string') return;
    if (!opened) {
      if (inbox.length < 500) inbox.push(d);
      return;
    }
    dispatch(d);
  }

  /** @param {MessagePort} p */
  function attach(p) {
    port = p;
    port.onmessage = guard(onPortMessage, 'port');
    port.onmessageerror = null;
    if (opened) for (const fn of connectHooks) guard(fn, 'connect')();
  }

  Handshake.listeners.push(attach);

  return {
    get connected() {
      return !!port;
    },
    /**
     * Posts {sr:1, type, ...payload} on the port. Silently dropped before the handshake.
     * @param {string} type
     * @param {Record<string, any>} [payload]
     */
    send(type, payload) {
      if (!port) return false;
      const msg = Object.assign({ sr: 1, type }, payload || {}, { sr: 1, type });
      try {
        port.postMessage(msg);
        return true;
      } catch (err) {
        recordGuestError('send:' + type, err);
        return false;
      }
    },
    /** @param {string} type @param {(msg: any) => void} fn */
    on(type, fn) {
      const list = handlers.get(type) || [];
      list.push(fn);
      handlers.set(type, list);
    },
    /** Registers a hook run once the port is connected and the channel is open. @param {() => void} fn */
    onConnect(fn) {
      connectHooks.push(fn);
    },
    /** Starts dispatching (flushes messages that arrived before the guest finished starting). */
    open() {
      if (opened) return;
      opened = true;
      if (port) for (const fn of connectHooks) guard(fn, 'connect')();
      while (inbox.length) dispatch(inbox.shift());
    },
    /**
     * Sends the handshake 'hello' to every allowed UI origin.
     * @param {Record<string, any>} payload
     */
    hello(payload) {
      if (!ENV.framed) return;
      const msg = Object.assign({ sr: 1, type: MSG.HELLO }, payload, { sr: 1, type: MSG.HELLO });
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
