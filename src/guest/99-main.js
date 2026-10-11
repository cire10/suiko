// SpecReview guest, part 99: wiring and startup.
//
// On DOMContentLoaded (or immediately when the bundle runs later) the guest mounts the overlay, registers the layout
// and DOM-change hooks in a fixed order, starts listening, opens the channel and posts `hello` to the allowed UI
// origins. After the UI connects, it posts `ready {outline, features, externalsFailed}` and then reacts to UI
// messages (init, setTargets, setChanges, focus, scrollTo, setTool, setTheme, reveal, clearSelection, setHidden).
// After every layout pass it posts `positions` when they changed (scroll-only changes are throttled to 100 ms), and
// when scrolling settles it posts `scroll {topSrid, offset}`.
//
// Modes: 'review' (default) and 'changes' allow captures; 'readonly' (working-copy preview) disables the selection
// toolbar, selection captures and pick mode. Annotation painting is identical in all modes.
//
// Debugging: window.__specreviewGuest (non-enumerable, read-only) exposes inspect(), errors() and a few pure helper
// modules. It never exposes the channel.

const Main = (() => {
  const state = { mode: 'review', theme: 'system', hidden: false, started: false };

  function capturesAllowed() {
    return state.mode !== 'readonly';
  }

  /** Stamped headings in document order, one entry per srid (copies made by page scripts, e.g. a TOC, are skipped). */
  function outline() {
    const out = [];
    const seen = new Set();
    for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const srid = sridOf(h);
      if (srid == null || seen.has(srid) || elementBySrid(srid) !== h || TextWalk.isExcluded(h)) continue;
      seen.add(srid);
      out.push({ srid, level: Number(h.localName.charAt(1)), text: TextWalk.textOf(h), id: h.id || null });
    }
    return out;
  }

  function features() {
    return {
      mermaid: !!document.querySelector(Capture.MERMAID_SEL),
      math: !!document.querySelector('.katex, ' + Capture.MATH_SEL),
      code: !!document.querySelector('pre code, [data-sr-kind="code"]'),
    };
  }

  /** @param {any} theme */
  function applyTheme(theme) {
    const t = theme === 'light' || theme === 'dark' ? theme : 'system';
    Overlay.setTheme(t);
    // Markdown shells carry paired <link data-sr-theme="light|dark"> stylesheets; flip them to follow the UI.
    const links = document.querySelectorAll('link[data-sr-theme]');
    for (const link of links) {
      const which = link.getAttribute('data-sr-theme');
      const media = t === 'system' ? `(prefers-color-scheme: ${which})` : which === t ? 'all' : 'not all';
      if (link.getAttribute('media') !== media) link.setAttribute('media', media);
    }
    // ...and the shell's colour scheme (scrollbars, form controls), which shell.css sets to `light dark` on :root
    // (follow the system), plus html[data-sr-theme], which pins the page / overscroll background to the forced
    // theme. An authored HTML doc (no theme links) keeps its own colour scheme and attributes untouched.
    if (links.length) setShellColorScheme(t);
    if (t !== state.theme) {
      state.theme = t;
      try {
        // Consumed by the vendored mermaid bootstrap (src/core/render/static/mermaid-init.js), which re-renders
        // diagrams with the matching mermaid theme. detail: 'light' | 'dark' | 'system'.
        window.dispatchEvent(new CustomEvent('sr-theme', { detail: t }));
      } catch (err) {
        recordGuestError('theme-event', err);
      }
    }
  }

  /**
   * Pins the Markdown shell's root colour scheme and html[data-sr-theme] (background, see shell.css) to a forced
   * theme, or removes both pins for 'system'.
   * @param {'light'|'dark'|'system'} t
   */
  function setShellColorScheme(t) {
    const root = document.documentElement;
    const want = t === 'system' ? '' : t;
    if (want) {
      if (root.getAttribute('data-sr-theme') !== want) root.setAttribute('data-sr-theme', want);
    } else if (root.hasAttribute('data-sr-theme')) {
      root.removeAttribute('data-sr-theme');
    }
    if (root.style.colorScheme === want) return;
    root.style.colorScheme = want;
    if (!want && root.getAttribute('style') === '') root.removeAttribute('style');
  }

  /** @param {any} mode */
  function setMode(mode) {
    state.mode = mode === 'changes' || mode === 'readonly' ? mode : 'review';
    if (!capturesAllowed()) {
      Picker.exit(false);
      SelectionCapture.setEnabled(false);
    } else if (!Picker.active) {
      SelectionCapture.setEnabled(true);
    }
  }

  /** @param {boolean} hidden */
  function setHidden(hidden) {
    state.hidden = !!hidden;
    Overlay.setHidden(state.hidden);
    Targets.setHidden(state.hidden);
    ChangesOverlay.setHidden(state.hidden);
  }

  /** Targets from a message: `targets` plus (tolerated) separate `locks` / `drafts` arrays. @param {any} d */
  function targetsOf(d) {
    const all = [];
    for (const k of ['targets', 'locks', 'drafts']) if (Array.isArray(d[k])) all.push(...d[k]);
    return all;
  }

  // ---- positions / scroll reporting -------------------------------------------------------------------------

  let lastStructural = '';
  let lastScrollY = NaN;
  let lastPosAt = 0;
  let posTimer = 0;

  function sendPositions() {
    posTimer = 0;
    const payload = {
      targets: Targets.positions(),
      hunks: ChangesOverlay.positions(),
      scrollY: Math.round(window.scrollY),
      viewportH: window.innerHeight,
      docH: document.documentElement.scrollHeight,
    };
    lastStructural = JSON.stringify([payload.targets, payload.hunks, payload.viewportH, payload.docH]);
    lastScrollY = payload.scrollY;
    lastPosAt = Date.now();
    Channel.send(MSG.POSITIONS, payload);
  }

  function postPositions() {
    if (!Channel.connected) return;
    const structural = JSON.stringify([Targets.positions(), ChangesOverlay.positions(), window.innerHeight,
      document.documentElement.scrollHeight]);
    if (structural !== lastStructural) {
      if (posTimer) clearTimeout(posTimer);
      sendPositions();
      return;
    }
    if (Math.round(window.scrollY) === lastScrollY || posTimer) return;
    const wait = Math.max(0, 100 - (Date.now() - lastPosAt));
    posTimer = /** @type {any} */ (setTimeout(guard(sendPositions, 'positions'), wait));
  }

  let lastTop = '';
  const reportScroll = debounce(guard(() => {
    if (!Channel.connected) return;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    /** @type {Element|null} */
    let found = null;
    outer: for (const y of [4, 24, 64, 128]) {
      for (const x of [vw / 2, vw / 4, (3 * vw) / 4]) {
        for (const el of document.elementsFromPoint(Math.round(x), y)) {
          if (el === Overlay.host || OWN_NODES.has(el)) continue;
          found = closestSridEl(el);
          if (found) break outer;
          break;
        }
      }
    }
    if (!found) return;
    const payload = { topSrid: sridOf(found), offset: Math.round(found.getBoundingClientRect().top) };
    const key = JSON.stringify(payload);
    if (key === lastTop) return;
    lastTop = key;
    Channel.send(MSG.SCROLL, payload);
  }, 'scroll-report'), 150);

  // ---- channel ------------------------------------------------------------------------------------------------

  function onConnect() {
    lastStructural = '';
    Channel.send(MSG.READY, { outline: outline(), features: features(), externalsFailed: PageErrors.externalsFailed });
    PageErrors.resend();
    SelectionCapture.resend();
    Scheduler.requestLayout();
  }

  Channel.on(MSG.INIT, (d) => {
    setMode(d.mode);
    applyTheme(d.theme);
    setHidden(!!d.hidden);
    Targets.set(targetsOf(d));
    Targets.setActive(d.activeId == null ? null : String(d.activeId));
    ChangesOverlay.set(d.changes || null);
    lastStructural = '';
    Scheduler.requestLayout();
  });
  Channel.on(MSG.SET_TARGETS, (d) => Targets.set(targetsOf(d)));
  Channel.on(MSG.SET_CHANGES, (d) => ChangesOverlay.set(d.changes || null));
  Channel.on(MSG.FOCUS, (d) => {
    if (d.id == null) Targets.setActive(null);
    else Targets.focus(String(d.id));
  });
  Channel.on(MSG.SCROLL_TO, (d) => {
    if (d.hunk != null) ChangesOverlay.scrollTo(String(d.hunk));
    else if (d.id != null) Targets.scrollToId(String(d.id));
    else if (d.srid != null) Targets.scrollToSrid(Number(d.srid), typeof d.offset === 'number' ? d.offset : undefined);
    Scheduler.requestLayout();
  });
  Channel.on(MSG.SET_TOOL, (d) => Picker.setTool(String(d.tool)));
  Channel.on(MSG.SET_THEME, (d) => applyTheme(d.theme));
  Channel.on(MSG.REVEAL, (d) => {
    if (d.id != null) Targets.reveal(String(d.id));
  });
  Channel.on(MSG.CLEAR_SELECTION, () => SelectionCapture.clear());
  Channel.on(MSG.SET_HIDDEN, (d) => setHidden(!!d.hidden));

  /** Closes the "removed content" popover on a click anywhere in the page. @param {PointerEvent} ev */
  function closePopoverOnOutside(ev) {
    if (ev.target === Overlay.host || !Overlay.popover.openKey) return;
    Overlay.popover.hide();
    Scheduler.requestLayout();
  }

  function start() {
    if (state.started) return;
    state.started = true;
    Overlay.mount();
    Overlay.setTheme(state.theme);
    Scheduler.onLayout(Overlay.ensure);
    Scheduler.onLayout(Targets.layout);
    Scheduler.onLayout(ChangesOverlay.layout);
    Scheduler.onLayout(Highlights.layoutFallback);
    Scheduler.onLayout(SelectionCapture.layout);
    Scheduler.onLayout(Picker.layout);
    Scheduler.onLayout(postPositions);
    Scheduler.onDomChange(Targets.reresolve);
    Scheduler.onDomChange(ChangesOverlay.reresolve);
    Scheduler.onDomChange(Picker.refresh);
    Scheduler.onScroll(reportScroll);
    Scheduler.start();
    SelectionCapture.start();
    Keys.start();
    Targets.start();
    document.addEventListener('pointerdown', guard(closePopoverOnOutside, 'popover-outside'), true);
    Channel.onConnect(guard(onConnect, 'onConnect'));
    Channel.open();
    Channel.hello({
      target: ENV.target,
      title: document.title,
      href: location.href,
      highlightApi: Highlights.supported,
      guestVersion: GUEST_VERSION,
    });
  }

  const debugApi = Object.freeze({
    version: GUEST_VERSION,
    target: ENV.target,
    allowedOrigins: ENV.allowedOrigins,
    get connected() {
      return Channel.connected;
    },
    get mode() {
      return state.mode;
    },
    errors: () => guestErrors.slice(),
    inspect: () => Object.assign(Overlay.inspect(), {
      mode: state.mode,
      highlights: Highlights.sizes(),
      highlightApi: Highlights.supported,
      targets: Targets.debug(),
      activeId: Targets.activeId,
      positions: Targets.positions(),
      changes: ChangesOverlay.debug(),
      hunks: ChangesOverlay.positions(),
      picker: Picker.state,
      selection: SelectionCapture.current,
      pageErrors: PageErrors.snapshot(),
      navigation: NavGuard.debug(),
    }),
    /** Recomputes the selection capture immediately and returns it. */
    captureSelection: () => SelectionCapture.flush(),
    modules: Object.freeze({ TextWalk, Capture }),
  });

  try {
    Object.defineProperty(window, '__specreviewGuest', { value: debugApi, enumerable: false, configurable: true, writable: false });
  } catch (err) {
    recordGuestError('debug-global', err);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', guard(start, 'start'), { once: true });
  } else {
    guard(start, 'start')();
  }

  return { capturesAllowed };
})();
