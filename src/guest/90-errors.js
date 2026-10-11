// SpecReview guest, part 90: page error and failed-resource accounting.
//
// Installed synchronously when the bundle runs (before the document's own scripts), so early errors are counted:
//   - uncaught script errors (window 'error' ErrorEvent) and unhandled promise rejections -> count / last;
//   - resource load failures (capture-phase 'error' on img/script/link/video/audio/source/iframe/object/embed):
//     external http(s) URLs (another origin) -> externalsFailed, same-origin URLs -> resourcesFailed;
//   - PerformanceObserver 'resource' entries with responseStatus >= 400 (same-origin only; cross-origin statuses
//     are opaque) -> resourcesFailed.
// Changes are reported to the UI as `pageError {count, last, externalsFailed, resourcesFailed}` (debounced 250 ms,
// at most 1 s apart: a document that keeps throwing, e.g. from a setInterval, is still reported while it throws);
// `ready` carries externalsFailed too. The guest's own exceptions never reach these handlers (see guard()).

const PageErrors = (() => {
  let count = 0;
  let last = '';
  /** @type {string[]} */
  const externalsFailed = [];
  /** @type {string[]} */
  const resourcesFailed = [];
  const MAX_URLS = 50;

  const report = debounce(() => {
    Channel.send(MSG.PAGE_ERROR, snapshot());
  }, 250, 1000);

  function snapshot() {
    return { count, last, externalsFailed: externalsFailed.slice(), resourcesFailed: resourcesFailed.slice() };
  }

  /** @param {string} url */
  function addFailedUrl(url) {
    if (!url) return;
    let abs;
    try {
      abs = new URL(url, location.href);
    } catch {
      return;
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
    const list = abs.origin === location.origin ? resourcesFailed : externalsFailed;
    if (list.includes(abs.href) || list.length >= MAX_URLS) return;
    list.push(abs.href);
    report();
  }

  /** @param {Event} ev */
  function onError(ev) {
    const t = ev.target;
    if (t && t !== window && isElement(t)) {
      if (OWN_NODES.has(/** @type {Element} */ (t))) return;
      const el = /** @type {any} */ (t);
      addFailedUrl(el.currentSrc || el.src || el.href || el.data || '');
      return;
    }
    const e = /** @type {ErrorEvent} */ (ev);
    count++;
    last = String(e.message || (e.error && e.error.message) || 'Script error').slice(0, 500);
    report();
  }

  /** @param {PromiseRejectionEvent} ev */
  function onRejection(ev) {
    count++;
    const r = /** @type {any} */ (ev.reason);
    last = ('Unhandled rejection: ' + String((r && r.message) || r)).slice(0, 500);
    report();
  }

  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onRejection);
  try {
    if (typeof PerformanceObserver === 'function' &&
        (PerformanceObserver.supportedEntryTypes || []).includes('resource')) {
      new PerformanceObserver(guard((/** @type {PerformanceObserverEntryList} */ list) => {
        for (const e of /** @type {any[]} */ (list.getEntries())) {
          if (typeof e.responseStatus === 'number' && e.responseStatus >= 400) addFailedUrl(e.name);
        }
      }, 'perf')).observe({ type: 'resource', buffered: true });
    }
  } catch (err) {
    recordGuestError('perf-observer', err);
  }

  return {
    snapshot,
    get externalsFailed() {
      return externalsFailed.slice();
    },
    get count() {
      return count;
    },
    /** Re-sends the current state (after the handshake) when anything was recorded. */
    resend() {
      if (count || externalsFailed.length || resourcesFailed.length) Channel.send(MSG.PAGE_ERROR, snapshot());
    },
  };
})();
