// @ts-check
// Live updates from GET /api/events (design 10.3).
//
// - One EventSource per open view: the doc view subscribes with ?ws=&doc=, the home page without a filter.
// - Every named event in SSE (protocol.js) is forwarded as `onEvent(name, data, id)`. Payloads are hints. The app
//   refetches DocState for everything except presence, working.changed and ping.
// - Last-Event-ID: while the browser's own EventSource retry is running it sends the header itself. When the
//   stream has to be recreated (the browser gave up, or the daemon came back after an outage), the last seen id is
//   passed as `?lastEventId=`. `onOpen` fires on every (re)connection, and the app refetches then, so a server that
//   ignores the parameter still converges.
// - Errors: a quick health probe decides whether the daemon is gone; if so, the API client's reconnect loop runs
//   and the stream is recreated once it succeeds.

import { SSE } from 'protocol';
import { checkConnection, eventsUrl, onReconnect } from './api.js';

export class EventStream {
  /**
   * @param {{ ws?: string, doc?: string, onEvent: (name: string, data: any, id: string|null) => void,
   *   onOpen?: () => void }} opts
   */
  constructor(opts) {
    this.opts = opts;
    /** @type {EventSource|null} */
    this.es = null;
    /** @type {string|null} */
    this.lastId = null;
    this.stopped = true;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.retryTimer = null;
    this.offReconnect = onReconnect(() => {
      if (!this.stopped) this.restart();
    });
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.es?.close();
    this.es = null;
    this.offReconnect();
  }

  restart() {
    this.es?.close();
    this.es = null;
    this.connect();
  }

  connect() {
    if (this.stopped || this.es) return;
    const { ws, doc } = this.opts;
    let es;
    try {
      es = new EventSource(eventsUrl({ ws, doc, lastEventId: this.lastId }));
    } catch (err) {
      console.error('suiko: cannot open the event stream', err);
      this.scheduleRetry();
      return;
    }
    this.es = es;
    for (const name of Object.values(SSE)) {
      es.addEventListener(name, (ev) => this.dispatch(name, /** @type {MessageEvent} */ (ev)));
    }
    es.onmessage = (ev) => this.dispatch('message', ev);
    es.onopen = () => this.opts.onOpen?.();
    es.onerror = () => {
      if (this.es !== es) return;
      if (es.readyState === EventSource.CLOSED) {
        this.es = null;
        this.scheduleRetry();
      }
      checkConnection();
    };
  }

  scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, 3000);
  }

  /** @param {string} name @param {MessageEvent} ev */
  dispatch(name, ev) {
    if (ev.lastEventId) this.lastId = ev.lastEventId;
    /** @type {any} */
    let data = {};
    if (ev.data) {
      try {
        data = JSON.parse(ev.data);
      } catch {
        data = { raw: String(ev.data) };
      }
    }
    try {
      this.opts.onEvent(name, data, ev.lastEventId || null);
    } catch (err) {
      console.error('suiko: event handler failed', name, err);
    }
  }
}
