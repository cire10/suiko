// SpecReview guest, part 70: DomTargets -> DOM (resolution, painting, positions, focus and reveal).
//
// Resolution (amendments 3.4), per target:
//   - kind 'doc': nothing to paint; position {top: 0, height: 0, state: 'ok'}.
//   - element kinds ('element' | 'cell', or any target with region/svg/cell): the [data-srid] element, outlined;
//     a region is drawn as a dashed box at fractions of Capture.regionBase(el); a mermaid node (svg {nodeId,label})
//     is located by data-id, then the id pattern, then label text, and boxed (the whole diagram until it renders).
//   - text kinds: scope = element(srid)..element(endSrid ?? srid); search the whitespace-insensitive quote in the
//     scope's TEXT_EXCLUDE text with prefix/suffix scoring; else in the whole document (proximity hint = scope
//     start); else outline the scope element(s) with state 'block'; else 'missing'.
//   - no quote (section, source, lock ranges): the scope element(s); sections and locks get a bracket.
// Painting: text ranges go to CSS highlights by state (open/addressed/needs_input -> sr-open, resolved ->
// sr-resolved, outdated/orphaned -> sr-outdated, draft -> sr-draft, lock -> sr-lock; the active one also sr-active);
// numbered pins in the right margin (stacked 22 px apart); outlines/regions/brackets in the overlay.
// Positions (posted by Main): {[id]: {top, height, state: 'ok'|'block'|'hidden'|'missing'}} where top/height are in
// DOCUMENT coordinates (viewport top + scrollY) of this iframe; hidden targets report the nearest visible
// ancestor's box; missing targets report top null.
// A target is 'hidden' when checkVisibility() is false. reveal opens ancestor <details> (and hidden="until-found")
// and otherwise clicks the control whose aria-controls / href="#id" points at a hidden ancestor.

const Targets = (() => {
  const STATE_HL = /** @type {Record<string, string>} */ ({
    open: 'sr-open', addressed: 'sr-open', needs_input: 'sr-open', resolved: 'sr-resolved', outdated: 'sr-outdated',
    orphaned: 'sr-outdated', draft: 'sr-draft', lock: 'sr-lock',
  });
  const STATE_COLOR = /** @type {Record<string, string>} */ ({
    open: '#d29922', needs_input: '#e16f24', addressed: '#1f6feb', resolved: '#2da44e', outdated: '#8c959f',
    orphaned: '#8c959f', draft: '#0969da', lock: '#8250df',
  });
  const ACTIVE_COLOR = '#fb8500';
  const PIN_GAP = 22;
  const ELEMENT_KINDS = new Set(['element', 'cell']);

  /**
   * @typedef {{id: string, num: number|null, kind: string, state: string, srid: number|null, endSrid: number|null,
   *   quote: string|null, prefix: string, suffix: string, region: {x:number,y:number,w:number,h:number}|null,
   *   svg: {nodeId: string, label: string}|null, cell: any, label: string}} DomTarget
   * @typedef {{t: DomTarget, status: 'ok'|'block'|'missing'|'doc', range: Range|null, el: Element|null,
   *   endEl: Element|null, mark: Element|null, regionEl: Element|null}} Resolved
   */

  /** @type {DomTarget[]} */
  let list = [];
  /** @type {Map<string, Resolved>} */
  const resolved = new Map();
  /** @type {string|null} */
  let activeId = null;
  let hidden = false;
  /** @type {Record<string, {top: number|null, height: number, state: string}>} */
  let positions = {};

  /** @param {any} v */
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  /** @param {any} v */
  const str = (v) => (typeof v === 'string' ? v : '');

  /** @param {any} r */
  function validRegion(r) {
    if (!r || typeof r !== 'object') return null;
    const v = [r.x, r.y, r.w, r.h].map(Number);
    if (v.some((x) => !Number.isFinite(x))) return null;
    return { x: clamp(v[0], 0, 1), y: clamp(v[1], 0, 1), w: clamp(v[2], 0, 1), h: clamp(v[3], 0, 1) };
  }

  /** @param {any} x @returns {DomTarget|null} */
  function normalizeTarget(x) {
    if (!x || typeof x !== 'object' || x.id == null || x.id === '') return null;
    return {
      id: String(x.id),
      num: num(x.num),
      kind: str(x.kind) || 'text',
      state: str(x.state) || 'open',
      srid: num(x.srid),
      endSrid: num(x.endSrid),
      quote: typeof x.quote === 'string' && x.quote.trim() ? x.quote : null,
      prefix: str(x.prefix),
      suffix: str(x.suffix),
      region: validRegion(x.region),
      svg: x.svg && typeof x.svg === 'object' ? { nodeId: str(x.svg.nodeId), label: str(x.svg.label) } : null,
      cell: x.cell && typeof x.cell === 'object' ? x.cell : null,
      label: str(x.label),
    };
  }

  /** @param {Element} el */
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility(/** @type {any} */ ({ visibilityProperty: true, checkVisibilityCSS: true }));
    }
    return !isEmptyRect(el.getBoundingClientRect());
  }

  /** @param {DOMRect} a @param {DOMRect} b */
  function union(a, b) {
    if (isEmptyRect(a)) return b;
    if (isEmptyRect(b)) return a;
    const l = Math.min(a.left, b.left), t = Math.min(a.top, b.top);
    return new DOMRect(l, t, Math.max(a.right, b.right) - l, Math.max(a.bottom, b.bottom) - t);
  }

  /** @param {DomTarget} t */
  function isElementKind(t) {
    return ELEMENT_KINDS.has(t.kind) || !!(t.region || t.svg || t.cell);
  }

  /** @param {DomTarget} t @returns {Resolved} */
  function resolve(t) {
    /** @type {Resolved} */
    const r = { t, status: 'missing', range: null, el: null, endEl: null, mark: null, regionEl: null };
    if (t.kind === 'doc') {
      r.status = 'doc';
      return r;
    }
    const el = elementBySrid(t.srid);
    const endEl = t.endSrid != null && t.endSrid !== t.srid ? elementBySrid(t.endSrid) : null;
    if (isElementKind(t) && el) {
      r.status = 'ok';
      r.el = el;
      r.mark = el;
      if (t.svg) {
        const node = Capture.findMermaidNode(Capture.mermaidRoot(el) || el, t.svg);
        if (node) r.mark = node;
      }
      if (t.region) r.regionEl = Capture.regionBase(el);
      return r;
    }
    if (t.quote) {
      const opts = { prefix: t.prefix, suffix: t.suffix };
      if (el) {
        const idx = TextWalk.buildIndex(el, endEl || el);
        const m = TextWalk.findQuote(idx, t.quote, opts);
        const range = m && TextWalk.rangeFromRaw(idx, m.start, m.end);
        if (range) return Object.assign(r, { status: 'ok', range });
      }
      const doc = TextWalk.docIndex();
      const hint = el ? TextWalk.pointToRaw(doc, el, 0, false) : null;
      const m = TextWalk.findQuote(doc, t.quote, Object.assign({ hint }, opts));
      const range = m && TextWalk.rangeFromRaw(doc, m.start, m.end);
      if (range) return Object.assign(r, { status: 'ok', range });
      if (el) return Object.assign(r, { status: 'block', el, endEl, mark: el });
      return r;
    }
    if (el) {
      const ranged = t.kind === 'section' || t.state === 'lock' || isElementKind(t);
      return Object.assign(r, { status: ranged ? 'ok' : 'block', el, endEl, mark: el });
    }
    return r;
  }

  function resolveAll() {
    resolved.clear();
    for (const t of list) resolved.set(t.id, resolve(t));
    paint();
  }

  /** Pushes text ranges into the CSS highlights. */
  function paint() {
    /** @type {Map<string, Range[]>} */
    const by = new Map();
    for (const n of Highlights.NAMES) if (n !== 'sr-ins') by.set(n, []);
    if (!hidden) {
      for (const r of resolved.values()) {
        if (!r.range) continue;
        /** @type {Range[]} */ (by.get(STATE_HL[r.t.state] || 'sr-open')).push(r.range);
        if (r.t.id === activeId) /** @type {Range[]} */ (by.get('sr-active')).push(r.range);
      }
    }
    for (const [n, rs] of by) Highlights.set(n, rs);
  }

  /** @param {Element|null} el */
  function visibleAncestorRect(el) {
    for (let a = el && el.parentElement; a; a = a.parentElement) {
      if (isVisible(a)) {
        const rect = a.getBoundingClientRect();
        if (!isEmptyRect(rect)) return rect;
      }
    }
    return null;
  }

  /** @param {Resolved} r */
  function regionRect(r) {
    const base = Capture.contentBox(/** @type {Element} */ (r.regionEl));
    const g = /** @type {NonNullable<DomTarget['region']>} */ (r.t.region);
    return new DOMRect(base.left + g.x * base.width, base.top + g.y * base.height, g.w * base.width, g.h * base.height);
  }

  /**
   * Geometry of a resolved target in viewport coordinates.
   * @param {Resolved} r
   * @returns {{rect: DOMRect|null, visible: boolean, region: DOMRect|null}}
   */
  function measure(r) {
    if (r.range) {
      const host = r.range.startContainer.parentElement;
      const rect = r.range.getBoundingClientRect();
      const visible = !!host && isVisible(host) && !isEmptyRect(rect);
      return { rect: visible ? rect : visibleAncestorRect(host), visible, region: null };
    }
    const el = r.mark || r.el;
    if (!el) return { rect: null, visible: false, region: null };
    let rect = el.getBoundingClientRect();
    if (r.endEl && r.mark === r.el && isVisible(r.endEl)) rect = union(rect, r.endEl.getBoundingClientRect());
    const visible = isVisible(el) && !isEmptyRect(rect);
    if (!visible) return { rect: visibleAncestorRect(el), visible: false, region: null };
    const region = r.regionEl && r.t.region ? regionRect(r) : null;
    return { rect: region || rect, visible, region };
  }

  /** @param {Resolved} r */
  function nodeOf(r) {
    return r.range ? r.range.startContainer.parentElement : r.mark || r.el;
  }

  // ---- layout -------------------------------------------------------------------------------------------------

  function layout() {
    if (!Overlay.ready) return;
    const marks = Overlay.pool('marks');
    const pins = Overlay.pool('pins');
    marks.begin();
    pins.begin();
    /** @type {typeof positions} */
    const pos = {};
    /** @type {Array<{id: string, label: string, top: number, color: string, active: boolean}>} */
    const pinQueue = [];
    const sy = window.scrollY;
    for (const r of resolved.values()) {
      const id = r.t.id;
      if (r.status === 'doc') {
        pos[id] = { top: 0, height: 0, state: 'ok' };
        continue;
      }
      if (r.status === 'missing') {
        pos[id] = { top: null, height: 0, state: 'missing' };
        continue;
      }
      const geo = measure(r);
      const state = !geo.visible ? 'hidden' : r.status === 'block' ? 'block' : 'ok';
      pos[id] = {
        top: geo.rect ? Math.round(geo.rect.top + sy) : null,
        height: geo.rect && geo.visible ? Math.round(geo.rect.height) : 0,
        state,
      };
      if (hidden || !geo.visible || !geo.rect) continue;
      const active = id === activeId;
      const color = active ? ACTIVE_COLOR : STATE_COLOR[r.t.state] || STATE_COLOR.open;
      const isLock = r.t.state === 'lock';
      if (isLock || r.t.kind === 'section') {
        const rect = geo.rect;
        const b = marks.el('bracket:' + id, 'bracket');
        Overlay.place(b, Math.max(1, rect.left - 12), rect.top, null, rect.height);
        b.style.setProperty('--c', color);
        b.title = isLock ? 'Agreed (locked)' + (r.t.label ? ': ' + r.t.label : '') : r.t.label || 'Section comment';
        b.onclick = guard(() => activate(id), 'bracket-click');
      }
      if (!r.range) {
        if (geo.region) {
          const box = marks.el('region:' + id, 'box region');
          Overlay.place(box, geo.region.left, geo.region.top, geo.region.width, geo.region.height);
          box.style.setProperty('--c', color);
        } else if (!isLock && r.t.kind !== 'section') {
          const el = /** @type {Element} */ (r.mark || r.el);
          const rect = el === r.el && r.endEl ? geo.rect : el.getBoundingClientRect();
          const cls = 'box ' + (r.mark && r.mark !== r.el ? 'node' : 'outline') + (r.status === 'block' ? ' block' : '') +
            (active ? ' active' : '');
          const box = marks.el('outline:' + id, cls);
          Overlay.place(box, rect.left - 3, rect.top - 3, rect.width + 6, rect.height + 6);
          box.style.setProperty('--c', color);
        }
      }
      if (!isLock) {
        pinQueue.push({ id, label: r.t.num != null ? String(r.t.num) : '•', top: geo.rect.top, color, active });
      }
    }
    // Pins in the right margin, stacked so they never overlap.
    pinQueue.sort((a, b) => a.top - b.top || (a.id < b.id ? -1 : 1));
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    let prev = -Infinity;
    for (const p of pinQueue) {
      const top = Math.max(p.top, prev + PIN_GAP);
      prev = top;
      if (top < -PIN_GAP || top > vh + PIN_GAP) continue;
      const pin = pins.el('pin:' + p.id, 'pin' + (p.active ? ' active' : ''), 'button');
      pin.textContent = p.label;
      pin.setAttribute('type', 'button');
      pin.setAttribute('aria-label', 'Thread ' + p.label);
      pin.style.setProperty('--c', p.color);
      Overlay.place(pin, vw - 26, top);
      pin.onclick = guard(() => activate(p.id), 'pin-click');
    }
    marks.end();
    pins.end();
    positions = pos;
  }

  // ---- interaction --------------------------------------------------------------------------------------------

  /** @param {string} id */
  function activate(id) {
    setActive(id);
    Channel.send(MSG.ACTIVATE, { id });
  }

  /** @param {string|null} id */
  function setActive(id) {
    const next = id == null ? null : String(id);
    if (next === activeId) return;
    activeId = next;
    paint();
    Scheduler.requestLayout();
  }

  /** The caret position under a viewport point. @param {number} x @param {number} y */
  function caretAt(x, y) {
    const d = /** @type {any} */ (document);
    if (typeof d.caretPositionFromPoint === 'function') {
      const p = d.caretPositionFromPoint(x, y);
      if (p && p.offsetNode) return { node: p.offsetNode, offset: p.offset };
    }
    if (typeof d.caretRangeFromPoint === 'function') {
      const r = d.caretRangeFromPoint(x, y);
      if (r) return { node: r.startContainer, offset: r.startOffset };
    }
    return null;
  }

  /** The id of the smallest painted target under a click, or null. @param {MouseEvent} ev */
  function hitTest(ev) {
    const x = ev.clientX, y = ev.clientY;
    const caret = caretAt(x, y);
    const target = /** @type {Node|null} */ (ev.target);
    /** @type {string|null} */
    let best = null;
    let bestSize = Infinity;
    for (const r of resolved.values()) {
      if (r.status !== 'ok' && r.status !== 'block') continue;
      let size = Infinity;
      if (r.range) {
        if (!caret) continue;
        try {
          if (!r.range.isPointInRange(caret.node, caret.offset)) continue;
        } catch {
          continue;
        }
        const inside = [...r.range.getClientRects()].some((c) => x >= c.left - 1 && x <= c.right + 1 &&
          y >= c.top - 1 && y <= c.bottom + 1);
        if (!inside) continue;
        size = r.range.toString().length;
      } else if (r.mark && target && r.status === 'ok' && r.t.state !== 'lock' && r.t.kind !== 'section') {
        if (!r.mark.contains(target)) continue;
        const geo = measure(r);
        const rect = geo.rect;
        if (!rect || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
        size = 1e6 + rect.width * rect.height;
      } else {
        continue;
      }
      if (size < bestSize) {
        bestSize = size;
        best = r.t.id;
      }
    }
    return best;
  }

  /** @param {MouseEvent} ev */
  function onDocClick(ev) {
    if (hidden || ev.button !== 0 || ev.target === Overlay.host || Picker.active) return;
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed) return;
    const id = hitTest(ev);
    if (id) activate(id);
  }

  /** @param {string} id */
  function controllerFor(id) {
    const esc = CSS.escape(id);
    return document.querySelector(`[aria-controls~="${esc}"]`) || document.querySelector(`a[href="#${esc}"]`);
  }

  /**
   * Makes a node visible: opens ancestor <details> (and hidden="until-found"), else clicks the tab/control of a
   * hidden ancestor with an id. Returns true when something was changed.
   * @param {Element|null} node
   */
  function revealNode(node) {
    let changed = false;
    for (let pass = 0; pass < 4 && node && !isVisible(node); pass++) {
      let progress = false;
      for (let el = /** @type {Element|null} */ (node); el; el = el.parentElement) {
        if (el.localName === 'details' && !(/** @type {HTMLDetailsElement} */ (el).open)) {
          /** @type {HTMLDetailsElement} */ (el).open = true;
          progress = true;
        }
        if (el.getAttribute('hidden') === 'until-found') {
          el.removeAttribute('hidden');
          progress = true;
        }
      }
      if (!progress) {
        for (let el = /** @type {Element|null} */ (node); el && el !== document.body; el = el.parentElement) {
          if (!el.id || isVisible(el)) continue;
          const ctl = controllerFor(el.id);
          if (ctl && ctl !== el && !el.contains(ctl)) {
            /** @type {HTMLElement} */ (ctl).click();
            progress = true;
            break;
          }
        }
      }
      if (!progress) break;
      changed = true;
    }
    return changed;
  }

  /** Scrolls a viewport rect into view (instant; ignores the page's scroll-behavior). @param {DOMRect} rect */
  function scrollRectIntoView(rect, force = false) {
    const vh = window.innerHeight;
    if (!force && rect.top >= 40 && rect.bottom <= vh - 40) return;
    window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - vh / 3), behavior: /** @type {any} */ ('instant') });
  }

  /** @param {string} id */
  function scrollAndPulse(id) {
    const r = resolved.get(id);
    if (!r) return;
    const geo = measure(r);
    if (!geo.rect || !geo.visible) return;
    scrollRectIntoView(geo.rect);
    requestAnimationFrame(guard(() => {
      const g = measure(r);
      if (g.rect && g.visible) Overlay.pulse(g.region || g.rect);
      Scheduler.requestLayout();
    }, 'pulse'));
  }

  /** Runs fn after the page had two frames to react (details toggle, tab scripts). @param {() => void} fn */
  function afterFrames(fn) {
    requestAnimationFrame(() => requestAnimationFrame(guard(fn, 'afterFrames')));
  }

  return {
    /** @param {any[]} targets */
    set(targets) {
      /** @type {Map<string, DomTarget>} */
      const byId = new Map();
      for (const x of Array.isArray(targets) ? targets : []) {
        const t = normalizeTarget(x);
        if (t) byId.set(t.id, t);
      }
      list = [...byId.values()];
      resolveAll();
      Scheduler.requestLayout();
    },
    /** Re-resolves after DOM changes. */
    reresolve() {
      if (list.length) resolveAll();
    },
    layout,
    setActive,
    get activeId() {
      return activeId;
    },
    /** @param {boolean} h */
    setHidden(h) {
      hidden = !!h;
      paint();
      Scheduler.requestLayout();
    },
    /** FOCUS: mark active, reveal when hidden, scroll into view and pulse. @param {string} id */
    focus(id) {
      setActive(id);
      const r = resolved.get(String(id));
      if (!r) return;
      const geo = measure(r);
      if (!geo.visible && revealNode(nodeOf(r))) afterFrames(() => scrollAndPulse(String(id)));
      else scrollAndPulse(String(id));
    },
    /** REVEAL: open details / click tabs hiding the target. @param {string} id */
    reveal(id) {
      const r = resolved.get(String(id));
      if (!r) return false;
      const changed = revealNode(nodeOf(r));
      if (changed) {
        Scheduler.requestDomChange();
        afterFrames(() => Scheduler.requestLayout());
      }
      return changed;
    },
    /** SCROLL_TO {srid, offset?}. @param {number} srid @param {number|undefined} offset */
    scrollToSrid(srid, offset) {
      const el = elementBySrid(srid);
      if (!el) return false;
      const go = () => {
        const rect = el.getBoundingClientRect();
        if (typeof offset === 'number' && Number.isFinite(offset)) {
          window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - offset), behavior: /** @type {any} */ ('instant') });
        } else {
          scrollRectIntoView(rect, true);
        }
      };
      if (!isVisible(el) && revealNode(el)) afterFrames(go);
      else go();
      return true;
    },
    /** SCROLL_TO {id}. @param {string} id */
    scrollToId(id) {
      const r = resolved.get(String(id));
      if (!r) return false;
      const geo = measure(r);
      if (!geo.visible && revealNode(nodeOf(r))) {
        afterFrames(() => {
          const g = measure(r);
          if (g.rect) scrollRectIntoView(g.rect, true);
        });
      } else if (geo.rect) {
        scrollRectIntoView(geo.rect, true);
      }
      return true;
    },
    revealNode,
    isVisible,
    /** Positions computed by the last layout. */
    positions() {
      return positions;
    },
    start() {
      document.addEventListener('click', guard(onDocClick, 'doc-click'), true);
    },
    /** Debug: resolution summary per target. */
    debug() {
      return [...resolved.values()].map((r) => ({
        id: r.t.id, status: r.status, text: r.range ? r.range.toString() : null,
        el: r.el ? r.el.localName : null, mark: r.mark ? r.mark.localName : null, region: !!r.regionEl,
      }));
    },
  };
})();
