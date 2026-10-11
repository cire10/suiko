// SpecReview guest, part 60: pick mode (element, cell, mermaid node and region captures).
//
// setTool {tool:'pick'} lays a transparent "glass" (cursor: crosshair) over the viewport inside the overlay, so the
// page never receives the pick clicks. Under the pointer the guest finds the page element with
// document.elementsFromPoint (skipping the overlay host) and computes a chain of smart targets from the deepest
// candidate outwards:
//   - inside a mermaid diagram: the node group (g.node / g[data-id]) then the diagram element;
//   - inline SVG: <text>, <g> (groups containing text), <svg>;
//   - PICKABLE_TAGS (img, table cells, pre, p, li, headings, ...) and math elements.
// The hover box + label chip shows the current target; '[' / ']' move to the parent / child in the chain, Esc exits.
// Click: a table cell opens the [Cell][Row][Column][Table] chooser; a mermaid node yields an element capture with
// svg {nodeId, label} on the stamped diagram element; anything else yields an element capture.
// Shift-drag over an img/svg/canvas/video/iframe draws a region; the capture carries region {x,y,w,h} (fractions of
// the content box of Capture.regionBase) and the action carries a PNG crop when the source is not tainted.
// Every completed pick posts `action {action:'comment', capture, rect, crop?}`, exits pick mode and posts
// `toolChanged {tool:'select'}`.

const Picker = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PICKABLE = new Set(PICKABLE_TAGS);
  const MIN_DRAG = 4;

  let active = false;
  /** @type {Array<{el: Element, kind: 'element'|'mermaid-node', root?: Element}>} */
  let chain = [];
  let level = 0;
  /** @type {Element|null} */
  let hit = null;
  /** @type {{media: Element, sridEl: Element|null, base: Element, x0: number, y0: number, x1: number, y1: number, pointerId: number}|null} */
  let drag = null;
  /** @type {{x: number, y: number}|null} */
  let downAt = null;
  let lastMove = { x: -1, y: -1 };
  let moveRaf = 0;
  /** @type {Element|null} cell whose scope chooser is open */
  let pendingCell = null;

  /** The topmost page element at a viewport point (the overlay host is skipped). @param {number} x @param {number} y */
  function elementAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === Overlay.host || OWN_NODES.has(el)) continue;
      if (el === document.documentElement) return null;
      return el;
    }
    return null;
  }

  /** @param {Element} el */
  function isCandidate(el) {
    if (el.namespaceURI === SVG_NS) {
      const t = el.localName;
      if (t === 'svg') return true;
      if (t === 'text') return true;
      if (t === 'g') return !!el.querySelector('text');
      return false;
    }
    return PICKABLE.has(el.localName) || el.matches(Capture.MATH_SEL);
  }

  /** @param {Element} start */
  function chainFor(start) {
    /** @type {typeof chain} */
    const out = [];
    let el = /** @type {Element|null} */ (start);
    const mer = Capture.mermaidRoot(start);
    if (mer) {
      const node = Capture.mermaidNodeOf(start, mer);
      if (node) out.push({ el: node, kind: 'mermaid-node', root: mer });
      out.push({ el: mer, kind: 'element' });
      el = mer.parentElement;
    }
    for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (isCandidate(el)) out.push({ el, kind: 'element' });
    }
    return out;
  }

  /** Default level: an SVG <text> directly inside a picked <g> starts at the group. */
  function defaultLevel() {
    if (chain.length > 1 && chain[0].el.localName === 'text' && chain[0].el.namespaceURI === SVG_NS &&
        chain[1].el.localName === 'g') return 1;
    return 0;
  }

  function currentTarget() {
    return chain[level] || null;
  }

  function labelOf(/** @type {typeof chain[number]} */ t) {
    if (t.kind === 'mermaid-node' && t.root) return Capture.mermaidCapture(t.el, t.root).label;
    return Capture.labelFor(t.el);
  }

  function drawHover() {
    const t = currentTarget();
    if (!active || !t || drag) {
      Overlay.pickBox.hide();
      return;
    }
    const r = t.el.getBoundingClientRect();
    if (isEmptyRect(r)) {
      Overlay.pickBox.hide();
      return;
    }
    Overlay.pickBox.show(r, labelOf(t));
  }

  /** @param {number} x @param {number} y */
  function hoverAt(x, y) {
    const el = elementAt(x, y);
    if (el !== hit) {
      hit = el;
      chain = el ? chainFor(el) : [];
      level = defaultLevel();
    }
    drawHover();
  }

  /** @param {PointerEvent} ev */
  function onMove(ev) {
    lastMove = { x: ev.clientX, y: ev.clientY };
    if (drag) {
      drag.x1 = ev.clientX;
      drag.y1 = ev.clientY;
      const r = dragRect();
      if (r) Overlay.dragBox.show(r);
      return;
    }
    if (!moveRaf) {
      moveRaf = requestAnimationFrame(guard(() => {
        moveRaf = 0;
        if (active) hoverAt(lastMove.x, lastMove.y);
      }, 'pick-move'));
    }
  }

  /** The drag rectangle clipped to the media element's content box (viewport coordinates). */
  function dragRect() {
    if (!drag) return null;
    const box = Capture.contentBox(drag.media);
    const l = clamp(Math.min(drag.x0, drag.x1), box.left, box.right);
    const r = clamp(Math.max(drag.x0, drag.x1), box.left, box.right);
    const t = clamp(Math.min(drag.y0, drag.y1), box.top, box.bottom);
    const b = clamp(Math.max(drag.y0, drag.y1), box.top, box.bottom);
    return new DOMRect(l, t, r - l, b - t);
  }

  /** @param {PointerEvent} ev */
  function onDown(ev) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    try {
      window.focus(); // keep '[', ']' and Esc flowing to this document while picking
    } catch { /* ignore */ }
    Overlay.chooser.hide();
    downAt = { x: ev.clientX, y: ev.clientY };
    if (!ev.shiftKey) return;
    const el = elementAt(ev.clientX, ev.clientY);
    const media = el && el.closest(Capture.MEDIA_SEL);
    if (!media) return;
    const m = media.localName === 'svg' ? Capture.outerSvg(media) || media : media;
    const sridEl = closestSridEl(m);
    drag = { media: m, sridEl, base: sridEl ? Capture.regionBase(sridEl) : m, x0: ev.clientX, y0: ev.clientY,
      x1: ev.clientX, y1: ev.clientY, pointerId: ev.pointerId };
    const glass = Overlay.glass.el;
    if (glass) {
      try {
        glass.setPointerCapture(ev.pointerId);
      } catch { /* ignore */ }
    }
    Overlay.pickBox.hide();
  }

  /** @param {PointerEvent} ev */
  function onUp(ev) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    if (drag) {
      drag.x1 = ev.clientX;
      drag.y1 = ev.clientY;
      const r = dragRect();
      const d = drag;
      drag = null;
      Overlay.dragBox.hide();
      if (r && r.width >= MIN_DRAG && r.height >= MIN_DRAG) {
        finishRegion(d, r);
        return;
      }
    }
    if (!downAt) return;
    downAt = null;
    hoverAt(ev.clientX, ev.clientY);
    const t = currentTarget();
    if (t) choose(t);
  }

  /**
   * @param {NonNullable<typeof drag>} d
   * @param {DOMRect} r  viewport rect of the drawn region
   */
  function finishRegion(d, r) {
    const base = Capture.contentBox(d.base);
    if (base.width < 1 || base.height < 1) return;
    const region = {
      x: round4(clamp((r.left - base.left) / base.width, 0, 1)),
      y: round4(clamp((r.top - base.top) / base.height, 0, 1)),
      w: round4(clamp(r.width / base.width, 0, 1)),
      h: round4(clamp(r.height / base.height, 0, 1)),
    };
    const capture = Capture.elementCapture(d.media, { sridEl: d.sridEl, region });
    capture.label += ` region x${Math.round(region.x * 100)}-${Math.round((region.x + region.w) * 100)}%` +
      ` y${Math.round(region.y * 100)}-${Math.round((region.y + region.h) * 100)}%`;
    const rect = rectJSON(r);
    // Crop from the dragged media element (fractions relative to that element's own content box).
    const mbox = Capture.contentBox(d.media);
    const mf = {
      x: clamp((r.left - mbox.left) / Math.max(1, mbox.width), 0, 1),
      y: clamp((r.top - mbox.top) / Math.max(1, mbox.height), 0, 1),
      w: clamp(r.width / Math.max(1, mbox.width), 0, 1),
      h: clamp(r.height / Math.max(1, mbox.height), 0, 1),
    };
    exit(true);
    Capture.cropRegion(d.media, mf).then(guard((/** @type {string|null} */ crop) => {
      /** @type {Record<string, any>} */
      const msg = { action: 'comment', capture, rect };
      if (crop) msg.crop = crop;
      Channel.send(MSG.ACTION, msg);
    }, 'crop'));
  }

  /** @param {typeof chain[number]} t */
  function choose(t) {
    const rect = rectJSON(t.el.getBoundingClientRect());
    if (t.kind === 'mermaid-node' && t.root) {
      emit(Capture.mermaidCapture(t.el, t.root), rect);
      return;
    }
    const tag = t.el.localName;
    if ((tag === 'td' || tag === 'th') && t.el.closest('table')) {
      const cell = t.el;
      Overlay.chooser.show(t.el.getBoundingClientRect(), [
        { id: 'cell', label: 'Cell', key: '1' },
        { id: 'row', label: 'Row', key: '2' },
        { id: 'column', label: 'Column', key: '3' },
        { id: 'table', label: 'Table', key: '4' },
      ], guard((/** @type {string} */ scope) => {
        Overlay.chooser.hide();
        const cap = Capture.cellCapture(cell, /** @type {any} */ (scope));
        const anchor = scope === 'row' ? cell.closest('tr') : scope === 'cell' ? cell : cell.closest('table');
        emit(cap, rectJSON((anchor || cell).getBoundingClientRect()));
      }, 'chooser'));
      pendingCell = cell;
      return;
    }
    emit(Capture.elementCapture(t.el), rect);
  }

  /** @param {Record<string, any>} capture @param {any} rect */
  function emit(capture, rect) {
    pendingCell = null;
    Channel.send(MSG.ACTION, { action: 'comment', capture, rect });
    exit(true);
  }

  /** @param {KeyboardEvent} ev */
  function onKey(ev) {
    if (!active || ev.defaultPrevented || ev.isComposing) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    let handled = true;
    if (ev.key === 'Escape') {
      if (Overlay.chooser.visible) {
        Overlay.chooser.hide();
        pendingCell = null;
      } else {
        exit(true);
      }
    } else if (ev.key === '[') {
      if (level < chain.length - 1) level++;
      drawHover();
    } else if (ev.key === ']') {
      if (level > 0) level--;
      drawHover();
    } else if (pendingCell && ['1', '2', '3', '4', 'Enter'].includes(ev.key)) {
      const scope = { 1: 'cell', 2: 'row', 3: 'column', 4: 'table', Enter: 'cell' }[ev.key];
      const cell = pendingCell;
      Overlay.chooser.hide();
      const anchor = scope === 'row' ? cell.closest('tr') : scope === 'cell' ? cell : cell.closest('table');
      emit(Capture.cellCapture(cell, /** @type {any} */ (scope)), rectJSON((anchor || cell).getBoundingClientRect()));
    } else {
      handled = false;
    }
    if (handled) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }
  }

  function enter() {
    if (active) return;
    active = true;
    hit = null;
    chain = [];
    level = 0;
    SelectionCapture.setEnabled(false);
    Overlay.toolbar.hide();
    Overlay.glass.on({
      move: onMove,
      down: onDown,
      up: onUp,
      leave: () => {
        if (!drag) {
          hit = null;
          chain = [];
          Overlay.pickBox.hide();
        }
      },
    });
    try {
      window.focus();
    } catch { /* ignore */ }
  }

  /** @param {boolean} notify  post toolChanged {tool:'select'} to the UI */
  function exit(notify) {
    if (!active) return;
    active = false;
    drag = null;
    downAt = null;
    pendingCell = null;
    Overlay.glass.off();
    Overlay.pickBox.hide();
    Overlay.dragBox.hide();
    Overlay.chooser.hide();
    SelectionCapture.setEnabled(Main.capturesAllowed());
    if (notify) Channel.send(MSG.TOOL_CHANGED, { tool: 'select' });
  }

  window.addEventListener('keydown', guard(onKey, 'pick-key'), true);

  return {
    get active() {
      return active;
    },
    /** @param {string} tool */
    setTool(tool) {
      if (tool === 'pick' && Main.capturesAllowed()) enter();
      else exit(false);
    },
    exit,
    /** Redraw the hover box after scroll/resize. */
    layout() {
      if (active && !drag) drawHover();
    },
    /** The DOM changed: recompute the chain under the pointer. */
    refresh() {
      if (active && lastMove.x >= 0) {
        hit = null;
        hoverAt(lastMove.x, lastMove.y);
      }
    },
    /** Debug: current hover chain labels and level. */
    get state() {
      return { active, level, chain: chain.map((c) => labelOf(c)) };
    },
  };
})();
