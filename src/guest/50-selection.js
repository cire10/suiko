// Suiko guest, part 50: text selection -> capture + selection mini-toolbar.
//
// On a settled selection change (selectionchange debounced 120 ms, deferred while a pointer button is down) the guest
// computes the FROZEN text capture
//   { kind: 'text', startSrid, endSrid, exact, prefix, suffix }
// where startSrid/endSrid are the nearest [data-srid] ancestors of the (whitespace-trimmed) range ends, `exact` is
// the TEXT_EXCLUDE-aware stream text of the range (block boundaries read as '\n'; leading/trailing whitespace
// trimmed) and prefix/suffix are up to CONTEXT_CHARS of whitespace-collapsed context on each side.
// A selection whose two ends are inside the same math element (.sr-math / [data-sr-kind=math] / .katex) or the
// same mermaid diagram snaps to that element and yields an element capture instead; a selection with only one end
// inside math is widened to include the whole math element.
// It posts `selection {capture|null, rect|null}` (rect = DOMRect JSON of the selection, iframe viewport
// coordinates) whenever the result changes, and shows the [Comment][Suggest][Question][Agreed] toolbar, whose
// buttons post `action {action, capture, rect}`. The toolbar sits above the selection's first line box, left-aligned
// to its start (below the last line box when there is no room above), so it never covers the selected text.
// The c / s / q / a keys pressed in the document while a capture exists do the same as the toolbar buttons
// (keyAction, called by 85-keys.js) instead of being forwarded to the UI as `key` messages.

const SelectionCapture = (() => {
  let enabled = true;
  let pointerDown = false;
  /** @type {{capture: any, rect: any, range: Range, anchor: Range}|null} range: the (snapped) selection; anchor: what
   * the toolbar is placed against (the whitespace-trimmed text range, or the selection for element captures) */
  let current = null;
  let lastSent = 'null';
  /** Capture key whose toolbar was used/dismissed; the toolbar stays hidden until the selection changes. */
  let dismissedKey = '';

  /** @param {Node} node */
  function snapRoot(node) {
    const el = isElement(node) ? node : node.parentElement;
    if (!el) return null;
    return el.closest(Capture.MATH_SEL) || el.closest('.katex') || Capture.mermaidRoot(el);
  }

  /** Whether the range lies in the document body (not in head, not in the overlay). @param {Range} r */
  function inBody(r) {
    const body = document.body;
    return !!body && body.contains(r.startContainer) && body.contains(r.endContainer);
  }

  /** Computes the capture for the current selection, or null. */
  function compute() {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    if (isEditable(deepActiveElement())) return null;
    const range = sel.getRangeAt(0);
    if (!inBody(range)) return null;

    const s0 = snapRoot(range.startContainer);
    const s1 = snapRoot(range.endContainer);
    if (s0 && s0 === s1) {
      return { capture: Capture.elementCapture(s0), rect: rectJSON(s0.getBoundingClientRect()), range, anchor: range };
    }
    const r = range.cloneRange();
    if (s0) r.setStartBefore(s0);
    if (s1) r.setEndAfter(s1);

    const index = TextWalk.docIndex();
    const raw = TextWalk.rangeToRaw(index, r);
    if (!raw) return null;
    let { start, end } = raw;
    while (start < end && TextWalk.isWsCode(index.raw.charCodeAt(start))) start++;
    while (end > start && TextWalk.isWsCode(index.raw.charCodeAt(end - 1))) end--;
    if (start >= end) return null;
    const trimmed = TextWalk.rangeFromRaw(index, start, end);
    if (!trimmed) return null;
    const { prefix, suffix } = TextWalk.contextAround(index, start, end);
    const capture = {
      kind: 'text',
      startSrid: sridOf(closestSridEl(trimmed.startContainer)),
      endSrid: sridOf(closestSridEl(trimmed.endContainer)),
      exact: index.raw.slice(start, end),
      prefix,
      suffix,
    };
    return { capture, rect: rectJSON(r.getBoundingClientRect()), range: r, anchor: trimmed };
  }

  /**
   * What the toolbar anchors to: the start of the selection (left of its first box, in document order), the top of
   * its first line box and the bottom of its last one. Top / bottom are the extremes over all boxes, so a toolbar
   * placed above `top` or below `bottom` never covers selected text (also in flex / multi-column layouts).
   * @param {Range} range
   * @returns {SelectionAnchor}
   */
  function anchorOf(range) {
    const rects = [...range.getClientRects()].filter((x) => x.width > 0 && x.height > 0);
    if (!rects.length) {
      const b = range.getBoundingClientRect();
      return { left: b.left, top: b.top, bottom: b.bottom };
    }
    let top = rects[0].top;
    let bottom = rects[0].bottom;
    for (const r of rects) {
      if (r.top < top) top = r.top;
      if (r.bottom > bottom) bottom = r.bottom;
    }
    return { left: rects[0].left, top, bottom };
  }

  function publish() {
    const payload = current ? { capture: current.capture, rect: current.rect } : { capture: null, rect: null };
    const key = JSON.stringify(payload.capture);
    if (key === lastSent) return;
    lastSent = key;
    Channel.send(MSG.SELECTION, payload);
  }

  /** Posts `action` for the current capture and dismisses the toolbar for it. @param {string} action */
  function onToolbar(action) {
    if (!current) return;
    current.rect = rectJSON(current.range.getBoundingClientRect()) || current.rect;
    Channel.send(MSG.ACTION, { action, capture: current.capture, rect: current.rect });
    dismissedKey = JSON.stringify(current.capture);
    Overlay.toolbar.hide();
  }

  function update() {
    if (pointerDown) return;
    current = enabled ? compute() : null;
    const key = current ? JSON.stringify(current.capture) : '';
    if (key !== dismissedKey) dismissedKey = '';
    if (current && !dismissedKey) Overlay.toolbar.show(anchorOf(current.anchor), guard(onToolbar, 'toolbar'));
    else Overlay.toolbar.hide();
    publish();
  }

  const scheduleUpdate = debounce(guard(update, 'selection'), 120);

  return {
    start() {
      document.addEventListener('selectionchange', guard(() => scheduleUpdate(), 'selectionchange'));
      window.addEventListener('pointerdown', guard((/** @type {PointerEvent} */ ev) => {
        if (ev.button === 0 && ev.target !== Overlay.host) pointerDown = true;
      }, 'sel-down'), true);
      const up = guard(() => {
        if (!pointerDown) return;
        pointerDown = false;
        scheduleUpdate();
      }, 'sel-up');
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', up, true);
      window.addEventListener('keyup', guard(() => scheduleUpdate(), 'sel-key'), true);
    },
    /** Enables/disables captures (disabled in readonly mode and while picking). @param {boolean} on */
    setEnabled(on) {
      enabled = !!on;
      if (!enabled) {
        current = null;
        Overlay.toolbar.hide();
        publish();
      } else {
        scheduleUpdate();
      }
    },
    /** Removes the page selection and hides the toolbar. */
    clear() {
      const sel = document.getSelection();
      if (sel) sel.removeAllRanges();
      current = null;
      Overlay.toolbar.hide();
      publish();
    },
    /**
     * A c / s / q / a key pressed in the document: when there is a capture (recomputed now, so a selection that
     * was just extended with the keyboard is not stale), posts `action` exactly like the toolbar button and hides
     * the toolbar for that capture. Returns false when there is nothing to act on (the key is then forwarded).
     * @param {string} action
     */
    keyAction(action) {
      if (!enabled) return false;
      if (!pointerDown) {
        scheduleUpdate.cancel();
        update();
      }
      if (!current) return false;
      onToolbar(action);
      return true;
    },
    /** Re-anchors the toolbar after scroll/resize. */
    layout() {
      if (current && Overlay.toolbar.visible) {
        if (!current.range.startContainer.isConnected) {
          current = null;
          Overlay.toolbar.hide();
          publish();
          return;
        }
        Overlay.toolbar.move(anchorOf(current.anchor));
      }
    },
    /** Re-sends the current state (after a (re)connect). */
    resend() {
      if (!current) return;
      lastSent = '\u0000';
      publish();
    },
    /** The current capture (debug). */
    get current() {
      return current ? { capture: current.capture, rect: current.rect } : null;
    },
    /** Forces an immediate recompute (debug/tests). */
    flush() {
      scheduleUpdate.cancel();
      pointerDown = false;
      update();
      return current ? current.capture : null;
    },
  };
})();
