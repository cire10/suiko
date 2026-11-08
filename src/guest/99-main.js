// Suiko guest, part 99: wiring and startup.
//
// On DOMContentLoaded (or immediately when the bundle runs later) the guest mounts the overlay, registers the layout
// and DOM-change hooks in a fixed order, starts listening, opens the channel and posts `hello` to the allowed UI
// origins. After the UI connects, it posts `ready {outline, features, externalsFailed}` and then reacts to UI
// messages (init, setTargets, setChanges, setActiveHunk, focus, scrollTo, setTool, setTheme, reveal, clearSelection,
// dismissToolbar, setHidden, setPrefs). setTool switches between the exclusive tools: 'select', 'pick' (60-picker.js) and 'snip' (65-snip.js).
// setPrefs {singleKeys} (also init.prefs) switches the guest's own single-key shortcuts on or off (85-keys.js).
// After every layout pass it posts `positions` when they changed (scroll-only changes are throttled to 100 ms): the
// targets', the changes' tops and ends (hunks / hunkEnds), and with prefs.scrollSync the tops of the outline's
// headings too, all in document coordinates, plus pointerLow: whether the pointer is within LOW_BAND px of the
// frame's bottom edge (where the UI's tool dock floats; the UI brings a dock it faded back at once). When scrolling
// settles it posts `scroll {topSrid, offset, heading,
// next, docTop, docEnd, y, vh, docH, byUi}`: heading / next are the last stamped heading at or above the reading
// line (8 px below the top of the viewport) and the first one below it, {srid, top} or null, docTop / docEnd the
// document's own edges and y its scrollY. With prefs.scrollSync (a side-by-side comparison, where the UI scrolls the
// other version along) it also posts while scrolling, about every 50 ms. byUi marks a scroll the UI asked for with
// `scrollTo {top}` (following the other version) or `scrollTo {hunk}` (a change step, done by both versions at once),
// so the UI never echoes it back to the other version: only the reader's own scrolling leads.
//
// Modes: 'review' (default) and 'changes' allow captures; 'readonly' (working-copy preview) disables the selection
// toolbar, selection captures, pick mode and snip mode. Annotation painting is identical in all modes.
//
// Room under the dock: once the UI connects (so only in the frame the UI shows, never in a frame the document nests),
// the page gets END_ROOM px of empty room after its content, so its last line can scroll clear of the tool dock the
// UI floats over the bottom of the frame: one adopted stylesheet with an empty ::after box on <body> (on <html> when
// the body is a flex / grid box or has an ::after of its own; none when both have one). Not in the Markdown shell,
// whose bottom padding is that room already. No node is added to the document.
//
// Debugging: window.__suikoGuest (non-enumerable, read-only) exposes inspect(), errors() and a few pure helper
// modules. It never exposes the channel.

const Main = (() => {
  const state = { mode: 'review', theme: 'system', hidden: false, started: false, scrollSync: false };

  function capturesAllowed() {
    return state.mode !== 'readonly';
  }

  /**
   * Stamped headings in document order, one entry per srid (copies made by page scripts, e.g. a TOC, are skipped),
   * that are rendered: a heading the page hides (display: none, `hidden`, an inactive tab panel, a closed <details>)
   * is not in the outline the reviewer navigates by.
   */
  function outline() {
    const out = [];
    const seen = new Set();
    for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const srid = sridOf(h);
      if (srid == null || seen.has(srid) || elementBySrid(srid) !== h || TextWalk.isExcluded(h)) continue;
      if (!Targets.isVisible(h)) continue;
      seen.add(srid);
      out.push({ srid, level: Number(h.localName.charAt(1)), text: TextWalk.textOf(h), id: h.id || null });
    }
    return out;
  }

  /** The srids of the outline sent with `ready` (the headings the UI lines two versions up on). @type {number[]} */
  let outlineSrids = [];

  /** Document tops of the outline's headings that are rendered now ({srid: top}), for the side-by-side sync. */
  function headingTops() {
    /** @type {Record<string, number>} */
    const out = {};
    const sy = window.scrollY;
    for (const srid of outlineSrids) {
      const el = elementBySrid(srid);
      const r = el ? el.getBoundingClientRect() : null;
      if (r && !isEmptyRect(r)) out[srid] = Math.round(r.top + sy);
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

  /** What positions carry besides the scroll offset (a change of it is sent at once). */
  function structuralKey() {
    return JSON.stringify([Targets.positions(), ChangesOverlay.positions(), ChangesOverlay.ends(),
      state.scrollSync ? headingTops() : null, window.innerHeight, document.documentElement.scrollHeight, pointerLow]);
  }

  function sendPositions() {
    posTimer = 0;
    /** @type {Record<string, any>} */
    const payload = {
      targets: Targets.positions(),
      hunks: ChangesOverlay.positions(),
      hunkEnds: ChangesOverlay.ends(),
      scrollY: Math.round(window.scrollY),
      viewportH: window.innerHeight,
      docH: document.documentElement.scrollHeight,
      pointerLow,
    };
    if (state.scrollSync) payload.headings = headingTops();
    lastStructural = structuralKey();
    lastScrollY = payload.scrollY;
    lastPosAt = Date.now();
    Channel.send(MSG.POSITIONS, payload);
  }

  function postPositions() {
    if (!Channel.connected) return;
    const structural = structuralKey();
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

  // ---- scrolls the UI asked for (byUi) ----------------------------------------------------------------------
  /** Where the last scroll the UI asked for (scrollTo {top} / {hunk}) left the page, and when. */
  let uiScroll = { y: NaN, at: 0 };

  /** Notes the current scroll offset as one the UI asked for (now, and again once a reveal had its frames). */
  function markUiScroll() {
    uiScroll = { y: Math.round(window.scrollY), at: Date.now() };
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (Date.now() - uiScroll.at < 200) uiScroll = { y: Math.round(window.scrollY), at: Date.now() };
    }));
  }

  /** Whether the page is still where the UI's last scrollTo {top} / {hunk} put it (a few seconds at most). */
  function scrolledByUi() {
    return Math.abs(Math.round(window.scrollY) - uiScroll.y) <= 1 && Date.now() - uiScroll.at < 3000;
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
    const docH = document.documentElement.scrollHeight;
    const payload = {
      topSrid: sridOf(found),
      offset: Math.round(found.getBoundingClientRect().top),
      ...headingsAround(),
      docTop: Math.round(-sy) || 0, // no -0 at the top
      docEnd: Math.round(docH - sy),
      y: Math.round(sy),
      vh: window.innerHeight,
      docH,
      byUi: scrolledByUi(),
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
    if ('scrollSync' in prefs && state.scrollSync !== !!prefs.scrollSync) {
      state.scrollSync = !!prefs.scrollSync;
      Scheduler.requestLayout(); // positions gain (or lose) the heading tops
    }
    Keys.setPrefs(prefs);
  }

  // ---- the UI's tool dock: room under it, and the pointer near it ------------------------------------------------

  /** Empty room after the content (px): the dock is 36 px high, 18 px above the frame's bottom edge. */
  const END_ROOM = 72;
  /** The pointer this close to the bottom edge (px) is near the dock. */
  const LOW_BAND = 120;
  /** @type {CSSStyleSheet|null} */
  let endRoomSheet = null;
  /** @type {'body'|'html'|null} where the room went */
  let endRoomOn = null;
  let pointerLow = false;

  /** Whether an element already has an ::after box of the page's own. @param {Element} el */
  function hasOwnAfter(el) {
    const c = getComputedStyle(el, '::after').content;
    return !!c && c !== 'none' && c !== 'normal';
  }

  /** Adds the room under the dock (see the header); once per page. */
  function addEndRoom() {
    if (endRoomSheet || !document.body || typeof CSSStyleSheet !== 'function' || !Array.isArray(document.adoptedStyleSheets)) return;
    // the Markdown shell: its article's bottom padding leaves the room already
    if (document.querySelector('link[data-sr-theme]') && document.querySelector('body > article.markdown-body')) return;
    const flow = /^(block|flow-root|list-item)$/.test(getComputedStyle(document.body).display);
    /** @type {'body'|'html'|null} */
    const on = flow && !hasOwnAfter(document.body) ? 'body' : !hasOwnAfter(document.documentElement) ? 'html' : null;
    if (!on) return;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`${on}::after{content:"";display:block;clear:both;height:${END_ROOM}px;pointer-events:none}`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    endRoomSheet = sheet;
    endRoomOn = on;
    Scheduler.requestLayout();
  }

  /** Puts the room back if a page script replaced the adopted stylesheets (a layout hook). */
  function keepEndRoom() {
    if (endRoomSheet && !document.adoptedStyleSheets.includes(endRoomSheet)) {
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, endRoomSheet];
    }
  }

  /** @param {boolean} low */
  function setPointerLow(low) {
    if (low === pointerLow) return;
    pointerLow = low;
    Scheduler.requestLayout(); // positions carry it
  }

  // ---- channel ------------------------------------------------------------------------------------------------

  function onConnect() {
    guard(addEndRoom, 'end-room')();
    lastStructural = '';
    const headings = outline();
    outlineSrids = headings.map((h) => h.srid);
    Channel.send(MSG.READY, { outline: headings, features: features(), externalsFailed: PageErrors.externalsFailed });
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
    ChangesOverlay.setActive(d.activeHunk == null ? null : String(d.activeHunk));
    lastStructural = '';
    Scheduler.requestLayout();
  });
  Channel.on(MSG.SET_TARGETS, (d) => Targets.set(targetsOf(d)));
  Channel.on(MSG.SET_CHANGES, (d) => ChangesOverlay.set(d.changes || null));
  Channel.on(MSG.SET_ACTIVE_HUNK, (d) => ChangesOverlay.setActive(d.id == null ? null : String(d.id)));
  Channel.on(MSG.FOCUS, (d) => {
    if (d.id == null) Targets.setActive(null);
    else Targets.focus(String(d.id));
  });
  Channel.on(MSG.SCROLL_TO, (d) => {
    if (d.hunk != null) {
      ChangesOverlay.scrollTo(String(d.hunk));
      markUiScroll();
    } else if (typeof d.top === 'number' && Number.isFinite(d.top)) {
      window.scrollTo({ top: Math.max(0, d.top), behavior: /** @type {any} */ ('instant') });
      markUiScroll();
    } else if (d.sync && typeof d.sync === 'object') syncTo(d.sync);
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
  Channel.on(MSG.DISMISS_TOOLBAR, () => SelectionCapture.dismiss());
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
    Scheduler.onLayout(keepEndRoom);
    Scheduler.onLayout(postPositions);
    Scheduler.onDomChange(Targets.reresolve);
    Scheduler.onDomChange(ChangesOverlay.reresolve);
    Scheduler.onDomChange(Picker.refresh);
    Scheduler.onScroll(onScroll);
    Scheduler.start();
    SelectionCapture.start();
    Keys.start();
    Targets.start();
    Reflow.start();
    document.addEventListener('pointerdown', guard(closePopoverOnOutside, 'popover-outside'), true);
    listenOwn(document, 'pointermove', guard((/** @type {PointerEvent} */ ev) => setPointerLow(ev.clientY >= window.innerHeight - LOW_BAND), 'pointer-low'),
      { capture: true, passive: true });
    // the pointer left the frame (onto the UI, the dock itself included)
    listenOwn(document, 'mouseout', guard((/** @type {MouseEvent} */ ev) => {
      if (!ev.relatedTarget) setPointerLow(false);
    }, 'pointer-out'), { capture: true, passive: true });
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
      hunkEnds: ChangesOverlay.ends(),
      activeHunk: ChangesOverlay.activeId,
      pageKeys: Keys.pageKeys,
      endRoom: endRoomOn ? { on: endRoomOn, px: END_ROOM } : null,
      pointerLow,
      reflowing: Reflow.holding,
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
