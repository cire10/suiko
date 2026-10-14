// Suiko guest, part 99: wiring and startup.
//
// On DOMContentLoaded (or immediately when the bundle runs later) the guest mounts the overlay, registers the layout
// and DOM-change hooks in a fixed order, starts listening, opens the channel and posts `hello` to the allowed UI
// origins. After the UI connects, it posts `ready {outline, features, externalsFailed}` and then reacts to UI
// messages (init, setTargets, setChanges, focus, scrollTo, setTool, setTheme, reveal, clearSelection, setHidden,
// setPrefs). setTool switches between the exclusive tools: 'select', 'pick' (60-picker.js) and 'snip' (65-snip.js).
// setPrefs {singleKeys} (also init.prefs) switches the guest's own single-key shortcuts on or off (85-keys.js).
// After every layout pass it posts `positions` when they changed (scroll-only changes are throttled to 100 ms), and
// when scrolling settles it posts `scroll {topSrid, offset, heading, next, docTop, docEnd}`: heading / next are the
// last stamped heading at or above the reading line (8 px below the top of the viewport) and the first one below it,
// {srid, top} or null, and docTop / docEnd the document's own edges, so the UI can put another version at the same
// point between the same two headings (`scrollTo {sync: {a, b, f}}`). With prefs.scrollSync (a side-by-side
// comparison, where the UI scrolls the other version along) it also posts while scrolling, about every 50 ms.
//
// Modes: 'review' (default) and 'changes' allow captures; 'readonly' (working-copy preview) disables the selection
// toolbar, selection captures, pick mode and snip mode. Annotation painting is identical in all modes.
//
// Debugging: window.__suikoGuest (non-enumerable, read-only) exposes inspect(), errors() and a few pure helper
// modules. It never exposes the channel.

const Main = (() => {
  const state = { mode: 'review', theme: 'system', hidden: false, started: false, scrollSync: false };

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
      Snip.exit(false);
      SelectionCapture.setEnabled(false);
    } else if (!Picker.active && !Snip.active) {
      SelectionCapture.setEnabled(true);
    }
  }

  /**
   * SET_TOOL: one tool at a time. Leaving a tool this way is silent (the UI asked for it: no toolChanged).
   * @param {string} tool
   */
  function setTool(tool) {
    if (tool === 'snip') {
      Snip.enter(); // leaves pick mode itself; refused in readonly mode
    } else if (tool === 'pick') {
      Snip.exit(false);
      Picker.setTool('pick');
    } else {
      Picker.exit(false);
      Snip.exit(false);
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

  /** Where the reader is: this far below the top of the viewport. */
  const READING_LINE = 8;

  /**
   * The stamped headings around the reading line, with their viewport tops: the last one at or above it and the
   * first one below it (null past either end). They let the UI line another version up.
   * @returns {{heading: {srid: number, top: number}|null, next: {srid: number, top: number}|null}}
   */
  function headingsAround() {
    /** @type {{srid: number, top: number}|null} */
    let heading = null;
    for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const srid = sridOf(h);
      if (srid == null || elementBySrid(srid) !== h || TextWalk.isExcluded(h)) continue;
      const r = h.getBoundingClientRect();
      if (isEmptyRect(r)) continue;
      const at = { srid, top: Math.round(r.top) };
      if (r.top > READING_LINE) return { heading, next: at };
      heading = at;
    }
    return { heading, next: null };
  }

  /**
   * SCROLL_TO {sync: {a, b, f}}: scrolls so that the point a fraction f of the way from heading a to heading b sits on
   * the reading line (a null: the top of the document; b null: its end). The other version of a side-by-side
   * comparison reported f between the same two headings.
   * @param {any} s
   */
  function syncTo(s) {
    const sy = window.scrollY;
    /** @param {unknown} srid @param {number} fallback */
    const topOf = (srid, fallback) => {
      const el = srid == null ? null : elementBySrid(Number(srid));
      const r = el ? el.getBoundingClientRect() : null;
      return r && !isEmptyRect(r) ? r.top : fallback;
    };
    const a = topOf(s.a, -sy);
    const b = topOf(s.b, document.documentElement.scrollHeight - sy);
    const f = Math.max(0, Math.min(1, Number(s.f) || 0));
    const y = a + f * Math.max(0, b - a);
    window.scrollTo({ top: Math.max(0, sy + y - READING_LINE), behavior: /** @type {any} */ ('instant') });
  }

  let lastTop = '';
  function scrollReport() {
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
    const sy = window.scrollY;
    const payload = {
      topSrid: sridOf(found),
      offset: Math.round(found.getBoundingClientRect().top),
      ...headingsAround(),
      docTop: Math.round(-sy) || 0, // no -0 at the top
      docEnd: Math.round(document.documentElement.scrollHeight - sy),
    };
    const key = JSON.stringify(payload);
    if (key === lastTop) return;
    lastTop = key;
    Channel.send(MSG.SCROLL, payload);
  }
  const reportScroll = debounce(guard(scrollReport, 'scroll-report'), 150);
  const reportScrollLive = debounce(guard(scrollReport, 'scroll-report'), 30, 50);

  function onScroll() {
    if (state.scrollSync) reportScrollLive();
    else reportScroll();
  }

  /** prefs (INIT, SET_PREFS): scrollSync is the guest's own; the rest are the keyboard's. @param {any} prefs */
  function setPrefs(prefs) {
    if (!prefs || typeof prefs !== 'object') return;
    if ('scrollSync' in prefs) state.scrollSync = !!prefs.scrollSync;
    Keys.setPrefs(prefs);
  }

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
    if (d.prefs) setPrefs(d.prefs); // absent: keep the current preferences
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
    else if (d.sync && typeof d.sync === 'object') syncTo(d.sync);
    else if (d.id != null) Targets.scrollToId(String(d.id));
    else if (d.srid != null) Targets.scrollToSrid(Number(d.srid), typeof d.offset === 'number' ? d.offset : undefined);
    Scheduler.requestLayout();
  });
  Channel.on(MSG.SET_TOOL, (d) => setTool(String(d.tool)));
  Channel.on(MSG.SET_THEME, (d) => applyTheme(d.theme));
  Channel.on(MSG.REVEAL, (d) => {
    if (d.id != null) Targets.reveal(String(d.id));
  });
  Channel.on(MSG.CLEAR_SELECTION, () => SelectionCapture.clear());
  Channel.on(MSG.SET_HIDDEN, (d) => setHidden(!!d.hidden));
  Channel.on(MSG.SET_PREFS, (d) => setPrefs(d));

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
    Scheduler.onLayout(Snip.layout);
    Scheduler.onLayout(postPositions);
    Scheduler.onDomChange(Targets.reresolve);
    Scheduler.onDomChange(ChangesOverlay.reresolve);
    Scheduler.onDomChange(Picker.refresh);
    Scheduler.onScroll(onScroll);
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
      snip: Snip.state,
      selection: SelectionCapture.current,
      pageErrors: PageErrors.snapshot(),
      navigation: NavGuard.debug(),
      prefs: Keys.prefs,
    }),
    /** Recomputes the selection capture immediately and returns it. */
    captureSelection: () => SelectionCapture.flush(),
    modules: Object.freeze({ TextWalk, Capture }),
  });

  try {
    Object.defineProperty(window, '__suikoGuest', { value: debugApi, enumerable: false, configurable: true, writable: false });
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
