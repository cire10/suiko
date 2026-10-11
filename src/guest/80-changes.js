// SpecReview guest, part 80: the rendered Changes overlay (design 8.6, amendments 4.1/4.5).
//
// Input: a Changes payload { hunks: [{ id, op: 'add'|'del'|'mod', old, new, srids, words: [{srid, quote, prefix,
// suffix}], deleted: {text, html, lines}|null, insertBefore: {srid}|null, threads?: string[], other?: string|{why},
// ... }], assets?: [{ path, srids, ... }] } (or null to clear).
// Draws, for each hunk:
//   - a 3 px bar left of every element in `srids` (green for add, amber for mod / changed assets);
//   - `sr-ins` CSS highlights on the inserted/replaced `words` (searched inside their srid element, else document);
//   - a "⊖ N lines removed" tab before `insertBefore` (pure deletions; end of document when null) and a
//     "⊖ was" tab on modified hunks that removed text (above the element when there is a margin, else after the
//     end of its first line, so it never covers text). For elements in a table cell (and for <tr>s) the tab and
//     badges stay inside that cell: after the first line when they fit, else compact ("⊖" / "⊖ N") in the cell's
//     top-right corner, never over a neighbouring cell's text. A tab toggles a popover (in the closed shadow root) showing
//     `deleted.html` (sanitised: no scripts, frames, forms, styles, event handlers or javascript: URLs) or
//     `deleted.text` as monospace;
//   - badges with the linked thread ids (click -> activate {id}) or an orange 'other' badge whose title is the reason.
// Hunk positions (document coordinates of the first visible bar/tab, null when hidden) are exposed to Main.

const ChangesOverlay = (() => {
  /**
   * @typedef {{id: string, kind: 'hunk'|'asset', op: 'add'|'del'|'mod', els: Element[], before: Element|null,
   *   deleted: {text?: string, html?: string|null, lines?: number}|null, oldLines: number, threads: string[],
   *   other: string|null, title: string}} Mark
   */
  /** @type {any} */
  let changes = null;
  /** @type {Mark[]} */
  let marks = [];
  /** @type {Range[]} */
  let insRanges = [];
  let hidden = false;
  /** @type {Record<string, number|null>} */
  let positions = {};
  /** @type {Map<string, DOMRect>} last tab rect per mark id (for popover placement) */
  const tabRects = new Map();

  /** @param {any[]} srids */
  function elementsFor(srids) {
    /** @type {Element[]} */
    const out = [];
    for (const s of Array.isArray(srids) ? srids : []) {
      const el = elementBySrid(s);
      if (el && !out.includes(el)) out.push(el);
    }
    return out;
  }

  /** @param {any} w */
  function wordRange(w) {
    if (!w || typeof w.quote !== 'string' || !w.quote.trim()) return null;
    const opts = { prefix: typeof w.prefix === 'string' ? w.prefix : '', suffix: typeof w.suffix === 'string' ? w.suffix : '' };
    const el = elementBySrid(w.srid);
    if (el) {
      const idx = TextWalk.buildIndex(el);
      const m = TextWalk.findQuote(idx, w.quote, opts);
      if (m) return TextWalk.rangeFromRaw(idx, m.start, m.end);
    }
    const doc = TextWalk.docIndex();
    const m = TextWalk.findQuote(doc, w.quote, opts);
    return m ? TextWalk.rangeFromRaw(doc, m.start, m.end) : null;
  }

  function resolve() {
    marks = [];
    insRanges = [];
    if (changes) {
      for (const h of changes.hunks) {
        if (!h || typeof h !== 'object' || h.id == null) continue;
        const op = h.op === 'add' || h.op === 'del' ? h.op : 'mod';
        for (const w of Array.isArray(h.words) ? h.words : []) {
          const r = wordRange(w);
          if (r) insRanges.push(r);
        }
        const other = typeof h.other === 'string' ? h.other : h.other && typeof h.other.why === 'string' ? h.other.why : null;
        marks.push({
          id: String(h.id),
          kind: 'hunk',
          op,
          els: elementsFor(h.srids),
          before: h.insertBefore && h.insertBefore.srid != null ? elementBySrid(h.insertBefore.srid) : null,
          deleted: h.deleted && typeof h.deleted === 'object' ? h.deleted : null,
          oldLines: h.old && Number.isFinite(Number(h.old.lines)) ? Number(h.old.lines) : 0,
          threads: Array.isArray(h.threads) ? h.threads.map(String) : [],
          other,
          title: `${h.id}: ${op === 'add' ? 'added' : op === 'del' ? 'removed' : 'changed'}` +
            (Array.isArray(h.section) && h.section.length ? ' in ' + h.section[h.section.length - 1] : ''),
        });
      }
      for (const a of Array.isArray(changes.assets) ? changes.assets : []) {
        if (!a || typeof a !== 'object') continue;
        const els = elementsFor(a.srids);
        if (!els.length) continue;
        marks.push({ id: 'asset:' + String(a.path || ''), kind: 'asset', op: 'mod', els, before: null, deleted: null,
          oldLines: 0, threads: [], other: null, title: 'Image changed: ' + String(a.path || '') });
      }
    }
    Highlights.set('sr-ins', hidden ? [] : insRanges);
  }

  /** Removes anything active from deleted HTML before it is shown in the overlay. @param {string} html */
  function sanitize(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html);
    const BAD = 'script, iframe, frame, frameset, object, embed, link, meta, base, style, form, input, button, ' +
      'textarea, select, noscript, template, portal';
    tpl.content.querySelectorAll(BAD).forEach((n) => n.remove());
    for (const el of tpl.content.querySelectorAll('*')) {
      for (const a of [...el.attributes]) {
        const n = a.name.toLowerCase();
        const urlAttr = n === 'href' || n === 'src' || n === 'xlink:href' || n === 'action' || n === 'formaction' ||
          n === 'poster' || n === 'srcset';
        if (n.startsWith('on') || n === 'style' || n === 'srcdoc' || n === 'data-srid' || n === 'id' ||
            (urlAttr && /^\s*(javascript|vbscript|data:text\/html)/i.test(a.value))) {
          el.removeAttribute(a.name);
        }
      }
      if (el.localName === 'a') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
    return document.importNode(tpl.content, true);
  }

  /** @param {Mark} m */
  function popoverContent(m) {
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'pop-head';
    const lines = m.deleted && Number(m.deleted.lines) ? Number(m.deleted.lines) : m.oldLines;
    head.textContent = `Removed in ${m.id}` + (lines ? ` (${lines} line${lines === 1 ? '' : 's'})` : '');
    wrap.appendChild(head);
    const d = m.deleted || {};
    if (typeof d.html === 'string' && d.html.trim()) {
      const box = document.createElement('div');
      box.className = 'del-html';
      box.appendChild(sanitize(d.html));
      wrap.appendChild(box);
    } else {
      const pre = document.createElement('pre');
      pre.textContent = typeof d.text === 'string' ? d.text : '';
      wrap.appendChild(pre);
    }
    return wrap;
  }

  /** @param {Mark} m */
  function toggle(m) {
    if (Overlay.popover.openKey === m.id) {
      Overlay.popover.hide();
    } else {
      const rect = tabRects.get(m.id);
      if (rect) Overlay.popover.show(rect, popoverContent(m), m.id);
    }
    Scheduler.requestLayout();
  }

  /**
   * Where a row of change marks (the tab, then the badges) goes, in viewport coordinates:
   *   'above' / 'inline'  the row starts at (x, y) and grows to the right (tab 18 px high, badges centred on it);
   *   'cell'              compact, inside the table cell / row `box`: right-aligned to x (the box's right edge, inset)
   *                       from y (its top edge, inset) and growing to the left, wrapping inside the box.
   * @typedef {{where: 'above'|'inline'|'cell', x: number, y: number, box?: DOMRect}} RowAnchor
   */

  /** Gap between the tab and the badges of a row. */
  const GAP = 3;
  /** Row pitch when the (13 px high) marks of a compact cell row wrap. */
  const CELL_ROW = 15;

  /**
   * The table cell an element is (in), or the row itself for a <tr>; marks of such elements stay inside that box so
   * they never cover a neighbouring cell's text.
   * @param {Element} el
   * @returns {Element|null}
   */
  function cellOf(el) {
    return el.localName === 'tr' ? el : el.closest('td, th');
  }

  /** @param {Element} cell @returns {RowAnchor} */
  function cellCorner(cell) {
    const box = cell.getBoundingClientRect();
    return { where: 'cell', x: box.right - 2, y: box.top + 1, box };
  }

  /** The anchor for the tab of a pure deletion. @param {Mark} m @returns {RowAnchor|null} */
  function deletionAnchor(m) {
    if (m.before) {
      if (!Targets.isVisible(m.before)) return null;
      const r = m.before.getBoundingClientRect();
      if (isEmptyRect(r)) return null;
      const cell = cellOf(m.before);
      // in a table: above the element only while that stays inside its own cell, else the cell's top-right corner
      if (cell && (m.before === cell || r.top - 20 < cell.getBoundingClientRect().top)) return cellCorner(cell);
      return { where: 'above', x: r.left, y: r.top - 20 };
    }
    const body = document.body;
    if (!body) return null;
    const r = body.getBoundingClientRect();
    const docBottom = document.documentElement.scrollHeight - window.scrollY;
    return { where: 'above', x: r.left + 8, y: Math.min(r.bottom, docBottom) - 22 };
  }

  /**
   * The end of an element's first text line, or null.
   * @param {Element} el
   * @returns {{right: number, top: number, height: number}|null}
   */
  function firstLineEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    const line = rects[0];
    let right = line.right;
    for (const r of rects) if (r.top < line.bottom - 1 && r.bottom > line.top + 1) right = Math.max(right, r.right);
    return { right, top: line.top, height: line.height };
  }

  /**
   * Where the row of a changed element's tab / badges goes: just above the element when the space there is free
   * (a margin of at least 18 px), else right after the end of its first text line, so the row does not cover text
   * of the line above (list items, consecutive paragraphs). Falls back to "above" when that line has no room left
   * inside the element's own box (a full first line).
   * Inside a table cell, "above" is used only while it stays inside the cell (a later paragraph of the cell), and
   * the fallback is the cell's top-right corner ('cell', compact) instead: never over a neighbouring cell's text.
   * @param {Element} el first visible changed element @param {DOMRect} first its client rect
   * @param {number} width the width the row needs (tab + badges)
   * @returns {RowAnchor}
   */
  function rowAnchor(el, first, width) {
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const prevBottom = previousBottom(el);
    const aboveFree = prevBottom == null || first.top - prevBottom >= 18;
    /** @type {RowAnchor} */
    const above = { where: 'above', x: first.left, y: first.top - 20 };
    const cell = cellOf(el);
    const box = cell ? cell.getBoundingClientRect() : null;
    if (aboveFree && (!cell || !box || (el !== cell && first.top - 20 >= box.top))) return above;
    const line = firstLineEnd(el);
    // only inside the element's own box (the cell's, for an element in a table) and the viewport
    const limit = Math.min(vw, box ? box.right - 2 : first.right);
    if (line && line.right + 6 + width <= limit) {
      return { where: 'inline', x: line.right + 6, y: line.top + Math.max(0, (line.height - 16) / 2) };
    }
    return cell ? cellCorner(cell) : above;
  }

  /**
   * Bottom of the nearest visible element above `el` (previous siblings, walking up the ancestors), or null.
   * @param {Element} el
   * @returns {number|null}
   */
  function previousBottom(el) {
    for (let n = /** @type {Element|null} */ (el); n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      for (let p = n.previousElementSibling; p; p = p.previousElementSibling) {
        if (!Targets.isVisible(p)) continue;
        const r = p.getBoundingClientRect();
        if (!isEmptyRect(r)) return r.bottom;
      }
    }
    return null;
  }

  /** @param {Mark} m */
  function hasRemovedText(m) {
    const d = m.deleted;
    return !!d && ((typeof d.text === 'string' && d.text.trim() !== '') || (typeof d.html === 'string' && d.html.trim() !== ''));
  }

  function layout() {
    if (!Overlay.ready) return;
    const pool = Overlay.pool('changes');
    pool.begin();
    /** @type {Record<string, number|null>} */
    const pos = {};
    const sy = window.scrollY;
    const openKey = Overlay.popover.openKey;
    let popoverAnchored = false;
    for (const m of marks) {
      /** @type {DOMRect|null} */
      let first = null;
      /** @type {Element|null} */
      let firstEl = null;
      for (const el of m.els) {
        if (!Targets.isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        if (isEmptyRect(r)) continue;
        if (!first) {
          first = r;
          firstEl = el;
        }
        if (hidden) continue;
        const bar = pool.el(`bar:${m.id}:${sridOf(el)}`, 'bar ' + (m.op === 'add' ? 'add' : 'mod'));
        Overlay.place(bar, Math.max(1, r.left - 8), r.top, null, r.height);
      }

      // The tab: before the next element for a pure deletion, on the changed element's row for a modification.
      const del = m.kind === 'hunk' && m.op === 'del';
      /** @type {RowAnchor|null} */
      let anchor = del && (!!m.deleted || m.oldLines > 0) ? deletionAnchor(m) : null;
      const withTab = del ? !!anchor : m.kind === 'hunk' && hasRemovedText(m) && !!first;
      if (!first && !anchor) {
        if (m.kind === 'hunk') pos[m.id] = null;
        continue;
      }
      if (hidden) {
        if (m.kind === 'hunk') pos[m.id] = Math.round((first ? first.top : Math.max(2, /** @type {RowAnchor} */ (anchor).y)) + sy);
        continue;
      }

      // Build the row (tab, then badges with the linked thread ids / the 'other' reason) and measure it.
      /** @type {HTMLElement[]} */
      const row = [];
      const lines = m.deleted && Number(m.deleted.lines) ? Number(m.deleted.lines) : m.oldLines;
      const removed = `${lines} line${lines === 1 ? '' : 's'} removed`;
      /** @type {HTMLElement|null} */
      let tabEl = null;
      if (withTab) {
        tabEl = pool.el('tab:' + m.id, 'tab' + (openKey === m.id ? ' open' : ''));
        tabEl.textContent = del ? `⊖ ${removed}` : '⊖ was';
        tabEl.title = del ? `${removed}: show the removed content` : 'Show the replaced text';
        tabEl.setAttribute('aria-label', tabEl.title);
        tabEl.setAttribute('role', 'button');
        tabEl.setAttribute('tabindex', '0');
        tabEl.onclick = guard(() => toggle(m), 'tab-click');
        tabEl.onkeydown = guard((/** @type {KeyboardEvent} */ ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            toggle(m);
          }
        }, 'tab-key');
        row.push(tabEl);
      }
      const badges = m.threads.map((t) => ({ key: 't:' + t, text: t, cls: 'badge', title: 'Linked to ' + t, id: t }));
      if (m.other) badges.push({ key: 'other', text: 'other', cls: 'badge other', title: m.other, id: '' });
      for (const b of badges) {
        const el = pool.el(`badge:${m.id}:${b.key}`, b.cls);
        el.textContent = b.text;
        el.title = b.title;
        el.onclick = b.id ? guard(() => {
          Targets.setActive(b.id);
          Channel.send(MSG.ACTIVATE, { id: b.id });
        }, 'badge-click') : null;
        row.push(el);
      }
      if (!row.length) { // nothing but bars (no tab => `first` is set)
        if (m.kind === 'hunk') pos[m.id] = Math.round(/** @type {DOMRect} */ (first).top + sy);
        continue;
      }
      if (!anchor) {
        const width = row.reduce((w, e) => w + (e.offsetWidth || 24) + GAP, -GAP);
        anchor = rowAnchor(/** @type {Element} */ (firstEl), /** @type {DOMRect} */ (first), Math.max(0, width));
      }

      if (anchor.where === 'cell') {
        // Compact, inside the cell: right-aligned from its top-right corner, growing left, wrapping downwards while
        // the next row still fits in the cell (else squeezed against its left edge).
        if (tabEl) tabEl.textContent = del ? `⊖ ${lines}` : '⊖';
        for (const e of row) e.classList.add('compact');
        const box = /** @type {DOMRect} */ (anchor.box);
        let x = anchor.x;
        let y = anchor.y;
        let inRow = 0;
        for (const e of row) {
          const w = e.offsetWidth || 24;
          if (inRow && x - w < box.left + 2 && y + CELL_ROW + (e.offsetHeight || 13) <= box.bottom) {
            x = anchor.x;
            y += CELL_ROW;
            inRow = 0;
          }
          Overlay.place(e, Math.max(box.left + 2, x - w), y);
          x -= w + GAP;
          inRow++;
        }
      } else {
        const y0 = Math.max(2, anchor.y);
        let x = tabEl ? Math.max(2, anchor.x) : anchor.where === 'above' ? Math.max(1, anchor.x - 8) : anchor.x;
        for (const e of row) {
          Overlay.place(e, x, e === tabEl ? y0 : y0 + 1.5);
          x += (e.offsetWidth || 24) + (e === tabEl ? GAP + 1 : GAP);
        }
      }

      /** @type {DOMRect|null} */
      let tab = null;
      if (tabEl) {
        tab = tabEl.getBoundingClientRect();
        tabRects.set(m.id, tab);
        if (openKey === m.id) {
          Overlay.popover.move(tab);
          popoverAnchored = true;
        }
      }
      if (m.kind === 'hunk') pos[m.id] = Math.round((first ? first.top : tab ? tab.top : Math.max(2, anchor.y)) + sy);
    }
    if (openKey && !popoverAnchored && marks.some((m) => m.id === openKey)) Overlay.popover.hide();
    pool.end();
    positions = pos;
  }

  return {
    /** @param {any} ch Changes payload or null */
    set(ch) {
      changes = ch && typeof ch === 'object' && Array.isArray(ch.hunks) ? ch : null;
      Overlay.popover.hide();
      tabRects.clear();
      resolve();
      Scheduler.requestLayout();
    },
    reresolve() {
      if (changes) resolve();
    },
    layout,
    /** @param {boolean} h */
    setHidden(h) {
      hidden = !!h;
      if (hidden) Overlay.popover.hide();
      Highlights.set('sr-ins', hidden ? [] : insRanges);
      Scheduler.requestLayout();
    },
    positions() {
      return positions;
    },
    /** Scrolls a hunk into view (SCROLL_TO {hunk}). @param {string} id */
    scrollTo(id) {
      const m = marks.find((x) => x.id === String(id));
      if (!m) return false;
      const el = m.els[0] || m.before;
      if (!el) {
        if (m.op === 'del') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: /** @type {any} */ ('instant') });
        return m.op === 'del';
      }
      return Targets.scrollToSrid(/** @type {number} */ (sridOf(el)), Math.round(window.innerHeight / 3));
    },
    /** Debug summary. */
    debug() {
      return marks.map((m) => ({ id: m.id, op: m.op, els: m.els.length, before: !!m.before, threads: m.threads, other: m.other }));
    },
  };
})();
