// SpecReview guest, part 87: keeping the reviewed document in its frame.
//
// A link (or a document script) that navigates the doc iframe to another URL strands the review: the new page has no
// guest (or the guest of another document), while the UI still shows the old outline and posts to a dead port. So,
// while framed, the guest keeps the frame on the reviewed document:
//   - Navigation API (`navigate` event): a cancelable push/replace navigation of this frame to another document (a
//     link click, `location.href = ...`, a form submission) that the page did not cancel or intercept itself is
//     cancelled. The decision is taken by a listener re-registered after the page's startup scripts (so after the
//     page's own `navigate` listeners). When the user caused it (a click or transient activation) and it is not a
//     POST, an http(s) destination is opened in a new tab instead.
//   - Link clicks (<a>/<area>, also inside SVG), checked in the window's bubble phase, i.e. after the page's click
//     handlers: when the click was not defaultPrevented, a link with target=_top / _parent (the sandbox blocks it,
//     and the parent is the review UI) or, without the Navigation API, a link that would navigate this frame, is
//     opened in a new tab instead.
// Left alone: same-document navigations (#fragment, history.pushState), reloads and history traversals, navigations to
// the current URL, downloads (<a download>), links that open elsewhere (target=_blank or a named frame), modified
// clicks (Ctrl/Cmd/Shift/Alt and middle clicks: the browser opens a tab or window) and non-fetch schemes
// (javascript:, mailto:, tel:). Navigations started by the parent (the UI switching versions or reloading the frame)
// never fire the page's `navigate` event, so the UI keeps full control of the frame.
// Installed synchronously when the bundle runs, before the document's own scripts (so the guest's listeners come
// first and can defer their decision behind the page's).

const NavGuard = (() => {
  const XLINK = 'http://www.w3.org/1999/xlink';
  const FETCH_SCHEMES = ['http:', 'https:', 'about:', 'blob:', 'data:', 'file:'];
  const nav = /** @type {any} */ (window).navigation;
  const HAS_NAV_API = !!nav && typeof nav.addEventListener === 'function';
  let blocked = 0;
  /** @type {string[]} URLs handed to window.open instead (most recent last; a popup blocker may still drop them) */
  const opened = [];

  /** The current document's URL without its fragment. */
  function here() {
    return location.href.replace(/#.*$/, '');
  }

  /** Whether navigating this frame to `url` would replace the document with another one. @param {URL} url */
  function leavesDocument(url) {
    if (!FETCH_SCHEMES.includes(url.protocol)) return false;
    return url.href.replace(/#.*$/, '') !== here();
  }

  /** Opens an http(s) URL in a new tab (the reviewer still gets to see the link target). @param {URL} url */
  function openElsewhere(url) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    try {
      window.open(url.href, '_blank', 'noopener');
      opened.push(url.href);
      if (opened.length > 20) opened.shift();
    } catch (err) {
      recordGuestError('nav-open', err);
    }
  }

  /** @type {WeakMap<Event, {url: URL, user: boolean, intercepted: boolean}>} navigations to decide on */
  const pending = new WeakMap();

  /**
   * First `navigate` listener (registered before the document's scripts run): notes the navigations that would leave
   * the document. A page listener may take one over with intercept() (client-side routing): then it stays in this
   * document. To see that, intercept is wrapped on this one event object (an own property; nothing global is patched).
   * @param {any} e NavigateEvent
   */
  function onNavigateFirst(e) {
    if (!e.cancelable || e.hashChange || e.downloadRequest != null) return;
    if (e.navigationType !== 'push' && e.navigationType !== 'replace') return;
    if (!e.destination || e.destination.sameDocument) return;
    /** @type {URL} */
    let url;
    try {
      url = new URL(e.destination.url);
    } catch {
      return;
    }
    if (!leavesDocument(url)) return;
    const state = {
      url,
      user: !!e.userInitiated || !!(navigator.userActivation && navigator.userActivation.isActive),
      intercepted: false,
    };
    pending.set(e, state);
    const native = e.intercept;
    if (typeof native === 'function') {
      try {
        Object.defineProperty(e, 'intercept', {
          configurable: true,
          writable: true,
          value(/** @type {any[]} */ ...args) {
            state.intercepted = true;
            return native.apply(this, args);
          },
        });
      } catch { /* keep the native method */ }
    }
  }

  /**
   * Last `navigate` listener (re-registered after the document's startup scripts, so it runs after their
   * listeners; `navigation` fires its listeners in registration order): cancels what the page did not handle.
   * @param {any} e NavigateEvent
   */
  function onNavigateLast(e) {
    const state = pending.get(e);
    if (!state) return;
    pending.delete(e);
    if (e.defaultPrevented || state.intercepted) return;
    e.preventDefault();
    blocked++;
    if (state.user && !e.formData) openElsewhere(state.url);
  }

  const navigateLast = guard(onNavigateLast, 'navigate-last');

  /** (Re-)registers the last listener behind every `navigate` listener the page has registered so far. */
  function moveLastListener() {
    nav.removeEventListener('navigate', navigateLast);
    nav.addEventListener('navigate', navigateLast);
  }

  /** The link activated by a click, if any. @param {MouseEvent} ev @returns {Element|null} */
  function linkOf(ev) {
    for (const n of ev.composedPath()) {
      if (!isElement(n)) continue;
      const name = n.localName;
      if ((name === 'a' || name === 'area') && (n.hasAttribute('href') || n.hasAttributeNS(XLINK, 'href'))) return n;
    }
    return null;
  }

  /** @param {Element} a @returns {URL|null} */
  function hrefOf(a) {
    const raw = a.hasAttribute('href') ? a.getAttribute('href') : a.getAttributeNS(XLINK, 'href');
    if (raw == null) return null;
    try {
      return new URL(raw.trim(), document.baseURI);
    } catch {
      return null;
    }
  }

  /** The browsing context a link targets, lower-cased ('' = this frame). @param {Element} a */
  function targetOf(a) {
    let t = a.getAttribute('target');
    if (t == null) {
      const base = document.querySelector('base[target]');
      t = base ? base.getAttribute('target') : '';
    }
    t = String(t || '').trim().toLowerCase();
    return t === '_self' ? '' : t;
  }

  /** Capture phase: decide whether this click concerns us, then check again after the page's handlers. @param {MouseEvent} ev */
  function onClick(ev) {
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const a = linkOf(ev);
    if (!a || a.hasAttribute('download')) return;
    const target = targetOf(a);
    const up = target === '_top' || target === '_parent';
    if (!up && !(target === '' && !HAS_NAV_API)) return;
    const url = hrefOf(a);
    if (!url || !leavesDocument(url)) return;
    const late = guard((/** @type {Event} */ e2) => {
      window.removeEventListener('click', late);
      if (e2 !== ev || ev.defaultPrevented) return;
      ev.preventDefault();
      blocked++;
      openElsewhere(url);
    }, 'link-late');
    window.addEventListener('click', late);
    // Propagation stopped by the page: the bubble-phase listener never ran; drop it.
    setTimeout(() => window.removeEventListener('click', late), 0);
  }

  if (ENV.framed) {
    try {
      window.addEventListener('click', guard(onClick, 'link-click'), true);
      if (HAS_NAV_API) {
        nav.addEventListener('navigate', guard(onNavigateFirst, 'navigate-first'));
        nav.addEventListener('navigate', navigateLast);
        const later = () => setTimeout(guard(moveLastListener, 'navigate-reorder'), 0);
        document.addEventListener('DOMContentLoaded', later, { once: true });
        window.addEventListener('load', later, { once: true });
      }
    } catch (err) {
      recordGuestError('nav-guard', err);
    }
  }

  return {
    /** Debug snapshot (window.__specreviewGuest.inspect().navigation). */
    debug() {
      return { active: ENV.framed, navigationApi: HAS_NAV_API, blocked, opened: opened.slice() };
    },
  };
})();
