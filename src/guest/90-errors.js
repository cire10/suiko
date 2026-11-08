// Suiko guest, part 90: page error and failed-resource accounting.
//
// Installed synchronously when the bundle runs (before the document's own scripts), so early errors are counted:
//   - uncaught script errors (window 'error' ErrorEvent) and unhandled promise rejections -> count / last;
//   - resource load failures (capture-phase 'error' on img/script/link/video/audio/source/iframe/object/embed):
//     external http(s) URLs (another origin) -> externalsFailed, same-origin URLs -> resourcesFailed;
//   - PerformanceObserver 'resource' entries with responseStatus >= 400 (same-origin only; cross-origin statuses
//     are opaque) -> resourcesFailed;
//   - frames the browser refused to show (the framed page's own frame-ancestors / X-Frame-Options): a same-origin
//     <iframe> / <frame> whose document is not reachable once it loaded (cross-origin frames cannot be told apart)
//     -> resourcesFailed (externalsFailed for another origin, never in practice);
//   - Content-Security-Policy violations (securitypolicyviolation, enforced policies only): a blocked URL ->
//     externalsFailed / resourcesFailed like a failed load, anything else (an inline script or style, eval, a data:
//     image) -> count / last, once per directive and blocked thing. Not counted: what the guest itself causes (its
//     scripts are under /__sr/), and the script rule of the snapshot profile (a fetched web page's scripts never
//     run, by design: the policy with script-src 'self' and form-action 'none' that the content origin sends).
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

  /** Violations already counted (directive + what was blocked + where). @type {Set<string>} */
  const cspSeen = new Set();

  /**
   * A policy of the content origin's snapshot profile (content.js #csp): its script rule blocks a fetched page's
   * scripts on purpose. @param {string} policy
   */
  function isSnapshotProfile(policy) {
    return /(^|;)\s*script-src 'self'\s*(;|$)/.test(policy) && /(^|;)\s*form-action 'none'\s*(;|$)/.test(policy);
  }

  /** @param {SecurityPolicyViolationEvent} ev */
  function onCspViolation(ev) {
    if (ev.disposition && ev.disposition !== 'enforce') return; // report-only
    const directive = String(ev.effectiveDirective || ev.violatedDirective || '');
    const t = ev.target;
    if (t && isElement(t) && OWN_NODES.has(/** @type {Element} */ (t))) return;
    if (/\/__sr\//.test(String(ev.sourceFile || ''))) return; // the guest's own (snip rasteriser, vendored libraries)
    if (/^script-src/.test(directive) && isSnapshotProfile(String(ev.originalPolicy || ''))) return;
    const blocked = String(ev.blockedURI || '');
    if (/^https?:/i.test(blocked)) {
      addFailedUrl(blocked);
      return;
    }
    const key = `${directive}|${blocked}|${ev.sourceFile || ''}:${ev.lineNumber || 0}`;
    if (cspSeen.has(key) || cspSeen.size >= MAX_URLS) return;
    cspSeen.add(key);
    count++;
    const what = blocked === 'inline' ? 'an inline script or style' : blocked === 'eval' ? 'eval()' : blocked || 'a resource';
    last = `Content Security Policy blocked ${what} (${directive})`.slice(0, 500);
    report();
  }

  /**
   * A frame finished loading: when its page is same-origin but its document is not reachable, the browser showed
   * its "refused to connect" page instead (the framed page's frame-ancestors / X-Frame-Options).
   * @param {Event} ev
   */
  function onFrameLoad(ev) {
    const f = /** @type {HTMLIFrameElement} */ (ev.target);
    if (!f || !isElement(f) || (f.localName !== 'iframe' && f.localName !== 'frame') || OWN_NODES.has(f)) return;
    const src = f.getAttribute('src');
    if (!src || f.hasAttribute('srcdoc')) return;
    // a sandbox without allow-same-origin makes even a same-origin page opaque
    if (f.hasAttribute('sandbox') && !/(^|\s)allow-same-origin(\s|$)/i.test(f.getAttribute('sandbox') || '')) return;
    let abs;
    try {
      abs = new URL(src, location.href);
    } catch {
      return;
    }
    if ((abs.protocol !== 'http:' && abs.protocol !== 'https:') || abs.origin !== location.origin) return;
    let reachable = false;
    try {
      reachable = !!f.contentDocument;
    } catch {
      reachable = false;
    }
    if (!reachable) addFailedUrl(abs.href);
  }

  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onRejection);
  window.addEventListener('securitypolicyviolation', guard(onCspViolation, 'csp-violation'), true);
  // `load` of an element does not reach window: listen on the document (capture: frames anywhere in it)
  document.addEventListener('load', guard(onFrameLoad, 'frame-load'), true);
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
