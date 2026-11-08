// @ts-check
// The UI side of the guest channel (protocol.js MSG, design 10.5, amendments 7).
//
// Handshake: `attach(iframe, contentOrigin)` binds the bridge (and its window 'message' listener) to the iframe, then
// `load(src)` navigates it to src?sr-nonce=<nonce> (HELLO_NONCE_PARAM) with a fresh 128-bit nonce. The guest runs
// before any script of the page, takes the nonce out of the URL and sends it back in its `hello`. The bridge answers
// only a hello whose event.source is the iframe's window, whose origin is the content origin and whose nonce is the
// one of the frame's latest load, and only once per nonce: it opens a fresh MessageChannel and posts
// {sr:1,type:'connect'} with port2. All later traffic in both directions uses port1. The guest answers with `ready`;
// `send` drops messages until then, and the app sends `init` with the full current state from its `ready` handler.
//
// Why a nonce: the doc's own scripts share the frame with the guest. Without it, any hello from the frame would get a
// port: one a page script posts, or one from a page the frame shows without a guest (a `javascript:` URL, a page next
// to the doc, which the content origin serves as it is, a blob: page, a page the frame loaded by itself); and the
// connect would reach that page's own listeners. A page script cannot know a nonce the guest has not used already.
// The cost: a page the frame loads by itself (the doc reloading itself, a history step inside the frame) cannot
// connect either. Its hello comes without a valid nonce while no page is connected and no load is under way: the
// bridge then asks the app to load the frame again (onStray; at most every STRAY_RELOAD_MS), which brings the
// reviewed version back with a fresh nonce. Pages that never say hello are DocFrame's "navigated away" case.
//
// `bye` (the guest's page is going away) closes the port: the page cannot be reached any more.
//
// Guest messages are untrusted input. The app treats them as hints: they can move focus or open a composer, but
// they can never submit, resolve or write anything (amendments 7).

import { HELLO_NONCE_PARAM, MSG } from 'protocol';

/** Sandbox flags for the doc iframe (design 12.2: scripts run, no top navigation). */
export const FRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

/**
 * Sandbox flags for a snapshot doc (a plan, an agent message, piped text, a fetched web page: not a file the spec
 * author wrote): no forms and no downloads. Popups stay, so a link the reviewer clicks still opens in a new tab (the
 * guest opens it there); the content origin's strict CSP keeps every script but the guest's out.
 */
export const FRAME_SANDBOX_STRICT = 'allow-scripts allow-same-origin allow-modals allow-popups allow-popups-to-escape-sandbox';

/** The sandbox flags of a doc's frames (the newer and, side by side, the older version). @param {any} ds DocState */
export function frameSandbox(ds) {
  return ds?.doc?.kind === 'snapshot' ? FRAME_SANDBOX_STRICT : FRAME_SANDBOX;
}

/** A frame that keeps loading pages without a valid hello is loaded again at most this often (ms). */
export const STRAY_RELOAD_MS = 10_000;

/** A fresh handshake nonce: 128 random bits as 32 lowercase hex digits. */
export function helloNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The URL a doc frame loads: src with the handshake nonce added to its query (the guest takes it out again).
 * @param {string} src @param {string} nonce
 */
export function nonceUrl(src, nonce) {
  const hash = src.indexOf('#');
  const base = hash < 0 ? src : src.slice(0, hash);
  return `${base}${base.includes('?') ? '&' : '?'}${HELLO_NONCE_PARAM}=${nonce}${hash < 0 ? '' : src.slice(hash)}`;
}

export class GuestBridge {
  constructor() {
    /** @type {HTMLIFrameElement|null} */
    this.iframe = null;
    /** @type {string|null} */
    this.contentOrigin = null;
    /** @type {MessagePort|null} */
    this.port = null;
    this.ready = false;
    /** @type {any} */
    this.hello = null;
    /** The nonce of the frame's latest load, until its guest said hello (then null: one hello per load). @type {string|null} */
    this.nonce = null;
    /** The doc URL of the frame's latest load (without the nonce). @type {string|null} */
    this.src = null;
    /** When onStray last ran (ms). */
    this.strayAt = 0;
    /** Number of hellos accepted so far (one per guest page load; DocFrame compares it across iframe loads). */
    this.helloSeq = 0;
    /** @type {(type: string, msg: any) => void} */
    this.onMessage = () => {};
    /** @type {(hello: any) => void} */
    this.onHello = () => {};
    /** The connected page said bye (it is going away). @type {() => void} */
    this.onBye = () => {};
    /** A page said hello without a valid nonce while nothing was connected or loading: load the frame again. @type {() => void} */
    this.onStray = () => {};
    this.onWindowMessage = this.onWindowMessage.bind(this);
    window.addEventListener('message', this.onWindowMessage);
  }

  /**
   * @param {{ onMessage?: (type: string, msg: any) => void, onHello?: (hello: any) => void, onBye?: () => void,
   *   onStray?: () => void }} handlers
   */
  setHandlers(handlers) {
    if (handlers.onMessage) this.onMessage = handlers.onMessage;
    if (handlers.onHello) this.onHello = handlers.onHello;
    if (handlers.onBye) this.onBye = handlers.onBye;
    if (handlers.onStray) this.onStray = handlers.onStray;
  }

  /**
   * Binds the bridge to a doc iframe. Call before load().
   * @param {HTMLIFrameElement} iframe
   * @param {string} contentOrigin e.g. 'http://127.0.0.1:4778'
   */
  attach(iframe, contentOrigin) {
    if (this.iframe !== iframe || this.contentOrigin !== contentOrigin) {
      this.closePort();
      this.nonce = null;
    }
    this.iframe = iframe;
    this.contentOrigin = contentOrigin;
  }

  /** @param {HTMLIFrameElement} [iframe] only detach when still bound to this iframe */
  detach(iframe) {
    if (iframe && this.iframe !== iframe) return;
    this.closePort();
    this.nonce = null;
    this.iframe = null;
    this.contentOrigin = null;
  }

  /**
   * Navigates the bound iframe to src with a fresh handshake nonce: the only way a page in it gets connected.
   * @param {string} src
   */
  load(src) {
    if (!this.iframe) return;
    this.closePort();
    this.nonce = helloNonce();
    this.src = src;
    this.iframe.src = nonceUrl(src, this.nonce);
  }

  /** Forgets the current page: nothing in the frame is answered until the next load(). */
  reset() {
    this.closePort();
    this.nonce = null;
  }

  get connected() {
    return !!this.port && this.ready;
  }

  closePort() {
    if (this.port) {
      this.port.onmessage = null;
      try {
        this.port.close();
      } catch {
        /* already closed */
      }
    }
    this.port = null;
    this.ready = false;
    this.hello = null;
  }

  /** @param {MessageEvent} ev */
  onWindowMessage(ev) {
    const frame = this.iframe;
    if (!frame || !frame.contentWindow || ev.source !== frame.contentWindow) return;
    if (!this.contentOrigin || ev.origin !== this.contentOrigin) return;
    const d = ev.data;
    if (!d || typeof d !== 'object' || d.sr !== 1 || d.type !== MSG.HELLO) return;
    if (!this.nonce || typeof d.nonce !== 'string' || d.nonce !== this.nonce) {
      this.stray();
      return;
    }
    // The guest of the page this bridge loaded: open a channel for it. Its nonce is used up.
    this.nonce = null;
    this.closePort();
    this.helloSeq++;
    const channel = new MessageChannel();
    const port = channel.port1;
    this.port = port;
    port.onmessage = (e) => {
      if (this.port === port) this.onPortMessage(e);
    };
    this.hello = {
      target: String(d.target ?? ''),
      href: String(d.href ?? ''),
      highlightApi: !!d.highlightApi,
      guestVersion: Number(d.guestVersion) || 0,
    };
    frame.contentWindow.postMessage({ sr: 1, type: MSG.CONNECT }, this.contentOrigin, [channel.port2]);
    this.onHello(this.hello);
  }

  /**
   * A hello without the nonce of a load under way. While a page is connected (a page script posted it) or a load is
   * under way (the old page posted it before the new one replaced it) it is ignored. Otherwise the frame shows a page
   * it loaded by itself: it is loaded again, at most every STRAY_RELOAD_MS (a page that keeps doing it is left to
   * DocFrame's "navigated away" banner in between).
   */
  stray() {
    if (this.port || this.nonce) return;
    const now = Date.now();
    if (now - this.strayAt < STRAY_RELOAD_MS) return;
    this.strayAt = now;
    try {
      this.onStray();
    } catch (err) {
      console.error('suiko: reloading the doc frame failed', err);
    }
  }

  /** @param {MessageEvent} ev */
  onPortMessage(ev) {
    const d = ev.data;
    if (!d || typeof d !== 'object' || d.sr !== 1 || typeof d.type !== 'string') return;
    if (d.type === MSG.BYE) {
      this.closePort();
      try {
        this.onBye();
      } catch (err) {
        console.error('suiko: guest bye handler failed', err);
      }
      return;
    }
    if (d.type === MSG.READY) this.ready = true;
    try {
      this.onMessage(d.type, d);
    } catch (err) {
      console.error('suiko: guest message handler failed', d.type, err);
    }
  }

  /**
   * Posts {sr:1, type, ...payload} to the guest. Returns false when no guest is connected.
   * @param {string} type
   * @param {Record<string, any>} [payload]
   */
  send(type, payload = {}) {
    if (!this.port || !this.ready) return false;
    try {
      this.port.postMessage({ ...payload, sr: 1, type });
      return true;
    } catch (err) {
      console.error('suiko: cannot post to the guest', type, err);
      return false;
    }
  }
}

/** The bridge of the doc iframe: the version shown. */
export const guest = new GuestBridge();

/** The bridge of the second doc iframe of Changes side by side: the older version (read-only). */
export const baseGuest = new GuestBridge();
