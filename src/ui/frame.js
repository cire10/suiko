// @ts-check
// The UI side of the guest channel (protocol.js MSG, design 10.5, amendments 7).
//
// Handshake: `attach(iframe, contentOrigin)` installs the window 'message' listener BEFORE the caller sets the
// iframe's src. The listener only accepts a `hello` whose event.source is the iframe's window and whose origin is
// the content origin. Every hello (one per page load) opens a fresh MessageChannel and posts {sr:1,type:'connect'}
// with port2. All later traffic in both directions uses port1. The guest answers with `ready`. `send` drops
// messages until then, and the app sends `init` with the full current state from its `ready` handler.
//
// Guest messages are untrusted input. The app treats them as hints: they can move focus or open a composer, but
// they can never submit, resolve or write anything (amendments 7).

import { MSG } from 'protocol';

/** Sandbox flags for the doc iframe (design 12.2: scripts run, no top navigation). */
export const FRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

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
    /** Number of hellos accepted so far (one per guest page load; DocFrame compares it across iframe loads). */
    this.helloSeq = 0;
    /** @type {(type: string, msg: any) => void} */
    this.onMessage = () => {};
    /** @type {(hello: any) => void} */
    this.onHello = () => {};
    this.onWindowMessage = this.onWindowMessage.bind(this);
    window.addEventListener('message', this.onWindowMessage);
  }

  /**
   * @param {{ onMessage?: (type: string, msg: any) => void, onHello?: (hello: any) => void }} handlers
   */
  setHandlers(handlers) {
    if (handlers.onMessage) this.onMessage = handlers.onMessage;
    if (handlers.onHello) this.onHello = handlers.onHello;
  }

  /**
   * Binds the bridge to a doc iframe. Call before assigning iframe.src.
   * @param {HTMLIFrameElement} iframe
   * @param {string} contentOrigin e.g. 'http://127.0.0.1:4778'
   */
  attach(iframe, contentOrigin) {
    if (this.iframe !== iframe || this.contentOrigin !== contentOrigin) this.closePort();
    this.iframe = iframe;
    this.contentOrigin = contentOrigin;
  }

  /** @param {HTMLIFrameElement} [iframe] only detach when still bound to this iframe */
  detach(iframe) {
    if (iframe && this.iframe !== iframe) return;
    this.closePort();
    this.iframe = null;
    this.contentOrigin = null;
  }

  /** Forgets the current page (call before navigating the iframe). */
  reset() {
    this.closePort();
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
    // A hello means a freshly loaded page: open a new channel for it.
    this.closePort();
    this.helloSeq++;
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (e) => this.onPortMessage(e);
    this.hello = {
      target: String(d.target ?? ''),
      title: String(d.title ?? ''),
      href: String(d.href ?? ''),
      highlightApi: !!d.highlightApi,
    };
    frame.contentWindow.postMessage({ sr: 1, type: MSG.CONNECT }, this.contentOrigin, [channel.port2]);
    this.onHello(this.hello);
  }

  /** @param {MessageEvent} ev */
  onPortMessage(ev) {
    const d = ev.data;
    if (!d || typeof d !== 'object' || d.sr !== 1 || typeof d.type !== 'string') return;
    if (d.type === MSG.READY) this.ready = true;
    try {
      this.onMessage(d.type, d);
    } catch (err) {
      console.error('specreview: guest message handler failed', d.type, err);
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
      console.error('specreview: cannot post to the guest', type, err);
      return false;
    }
  }
}

/** The single bridge of the app (one doc iframe at a time). */
export const guest = new GuestBridge();
