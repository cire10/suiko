// Suiko guest, part 80: the rendered Changes overlay (design 8.6, amendments 4.1/4.5).
//
// Input: a Changes payload { hunks: [{ id, op: 'add'|'del'|'mod', old, new, srids, words: [{srid, quote, prefix,
// suffix}], deleted: {text, html, lines}|null, insertBefore: {srid}|null, threads?: string[], other?: string|{why},
// ... }], assets?: [{ path, srids, ... }], side?: 'old', layout?: 'split' } (or null to clear).
// Draws, for each hunk:
//   - a change bar in the margin beside every element in `srids` (green for add, amber for mod / changed assets),
//     left of the block, or of the list / table / quote it belongs to, so the bars of a change form one column and
//     never sit on list bullets or cell borders;
//   - a soft outline around changed figures (images, SVG, canvas, video, frames, rendered diagrams) and changed
//     image files (`assets`): a changed picture has no words to highlight;
//   - `sr-ins` CSS highlights on the inserted/replaced `words` (searched inside their srid element, else document);
//   - a "⊖ N lines removed" tab before `insertBefore` (pure deletions; end of document when null) and a
//     "⊖ was" tab on modified hunks that removed text (both above the element when there is a margin, else after
//     the end of its first line, so they never cover text). For elements in a table cell (and for <tr>s) the tab and
//     badges stay inside that cell: after the first line when they fit, else compact ("⊖" / "⊖ N") in the cell's
//     top-right corner, never over a neighbouring cell's text. A tab toggles a popover (in the closed shadow root) showing
//     `deleted.html` (sanitised: no scripts, frames, forms, styles, event handlers or javascript: URLs) or
//     `deleted.text` as monospace;
//   - badges with the linked thread ids (click -> activate {id}), or a quiet "note" badge for the agent's word on a
//     change no thread asked for (`other`; its title says "Also changed: <why>").
// Where a row of tabs and badges has no room above its element or after the end of its first line, it goes in the
// left margin beside the change bars' column ('gutter', compact when that is what fits), so it never covers text; in
// the older version of a side-by-side comparison, a "⊕ N lines added" note with no room there either becomes a small
// green tick at the frame's inner edge (the seam), the count in its tooltip. Only the newer version's own rows (a
// "⊖ was" tab, thread badges) fall back to the element's top-right corner.
// Rows of tabs and badges are drawn where they belong, also when that is above or below the viewport (they scroll
// out of view with their element; they never pile up at the top edge).
// The active change (setActive: the change stepper / n p, the change clicked in the list) is drawn stronger: a
// framed, tinted box around its blocks and wider bars, on both sides of a side-by-side comparison.
// Hunk positions are exposed to Main in DOCUMENT coordinates: `positions()` the top of the change (its first
// visible block, else where it was removed / where the other version's lines go: the top of `insertBefore`, else
// the end of the document), `ends()` its bottom (the last visible block; the same point for an insertion point).
// The UI lines the two versions of a side-by-side comparison up on them. null when hidden.
//
// The older version of a side-by-side comparison gets the same payload with `side: 'old'` and draws each hunk's
// `oldSide` ({srids, words, insertBefore, insertAfter}, placed in that version's render) instead: `sr-del`
// highlights (red, struck through) on the removed / replaced words, a red bar beside every block that lost or
// changed text, and a green "⊕ N lines added" note where an added hunk's lines go in the newer version (before
// `insertBefore`, else at the end). No thread badges, no popovers: the removed text is right there.
// The newer version beside it gets `layout: 'split'`: its pure deletions get a red "⊖ N lines removed" note (not a
// button: the removed lines are in the older version, next to it) and modified hunks no "⊖ was" tab, so each side
// only marks what it has, plus where the other one has something it lacks.

const ChangesOverlay = (() => {
  /**
   * @typedef {{id: string, kind: 'hunk'|'asset', op: 'add'|'del'|'mod', side: 'new'|'old', els: Element[],
   *   before: Element|null, deleted: {text?: string, html?: string|null, lines?: number}|null, oldLines: number,
   *   newLines: number, threads: string[], other: string|null, title: string}} Mark
   */
  /** @type {any} */
  let changes = null;
  /** @type {Mark[]} */
  let marks = [];
  /** @type {Range[]} */
  let insRanges = [];
  /** @type {Range[]} removed / replaced words, in the older version of a side-by-side comparison */
  let delRanges = [];
  let hidden = false;
  /** The newer version of a side-by-side comparison (layout 'split'): no "was" tabs, deletions as notes. */
  let splitNew = false;
  /** The active change (setActive), or null. @type {string|null} */
  let activeId = null;
  /** @type {Record<string, number|null>} */
  let positions = {};
  /** @type {Record<string, number|null>} */
  let ends = {};
  /** @type {Map<string, DOMRect>} last tab rect per mark id (for popover placement) */
  const tabRects = new Map();

  /** Elements drawn as figures: a changed picture gets an outline. */
  const FIGURE_TAGS = new Set(['img', 'picture', 'svg', 'canvas', 'video', 'iframe', 'object', 'embed', 'figure']);
  /** Containers whose left edge is the change bar's column (lists, tables, quotes, definition lists). */
  const BAR_CONTAINERS = new Set(['li', 'ul', 'ol', 'dl', 'dt', 'dd', 'td', 'th', 'tr', 'thead', 'tbody', 'tfoot',
    'table', 'caption', 'blockquote', 'figcaption', 'summary', 'details']);

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
    delRanges = [];
    if (changes) {
      const oldSide = changes.side === 'old';
      for (const h of changes.hunks) {
        if (!h || typeof h !== 'object' || h.id == null) continue;
        const op = h.op === 'add' || h.op === 'del' ? h.op : 'mod';
        if (oldSide) {
          const o = h.oldSide && typeof h.oldSide === 'object' ? h.oldSide : null;
          if (!o) continue;
          for (const w of Array.isArray(o.words) ? o.words : []) {
            const r = wordRange(w);
            if (r) delRanges.push(r);
          }
          marks.push({
            id: String(h.id),
            kind: 'hunk',
            op,
            side: 'old',
            els: elementsFor(o.srids),
            before: op === 'add' && o.insertBefore && o.insertBefore.srid != null ? elementBySrid(o.insertBefore.srid) : null,
            deleted: null,
            oldLines: 0,
            newLines: h.new && Number.isFinite(Number(h.new.lines)) ? Number(h.new.lines) : 0,
            threads: [],
            other: null,
            title: `${h.id}: ${op === 'add' ? 'added in the newer version' : op === 'del' ? 'removed' : 'changed'}`,
          });
          continue;
        }
        for (const w of Array.isArray(h.words) ? h.words : []) {
          const r = wordRange(w);
          if (r) insRanges.push(r);
        }
        const other = typeof h.other === 'string' ? h.other : h.other && typeof h.other.why === 'string' ? h.other.why : null;
        marks.push({
          id: String(h.id),
          kind: 'hunk',
          op,
          side: 'new',
          els: elementsFor(h.srids),
          before: h.insertBefore && h.insertBefore.srid != null ? elementBySrid(h.insertBefore.srid) : null,
          deleted: h.deleted && typeof h.deleted === 'object' ? h.deleted : null,
          oldLines: h.old && Number.isFinite(Number(h.old.lines)) ? Number(h.old.lines) : 0,
          newLines: 0,
          threads: Array.isArray(h.threads) ? h.threads.map(String) : [],
          other,
          title: `${h.id}: ${op === 'add' ? 'added' : op === 'del' ? 'removed' : 'changed'}` +
            (Array.isArray(h.section) && h.section.length ? ' in ' + h.section[h.section.length - 1] : ''),
        });
      }
      for (const a of Array.isArray(changes.assets) ? changes.assets : []) {
        if (!a || typeof a !== 'object') continue;
        const els = elementsFor(oldSide ? a.oldSrids : a.srids);
        if (!els.length) continue;
        marks.push({ id: 'asset:' + String(a.path || ''), kind: 'asset', op: 'mod', side: oldSide ? 'old' : 'new', els,
          before: null, deleted: null, oldLines: 0, newLines: 0, threads: [], other: null,
          title: 'Image changed: ' + String(a.path || '') });
      }
    }
    paintWords();
  }

  function paintWords() {
    Highlights.set('sr-ins', hidden ? [] : insRanges);
    Highlights.set('sr-del', hidden ? [] : delRanges);
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
   *   'gutter'            in the left margin: right-aligned to x (just left of the change bars' column) from y, one
   *                       row growing to the left, in `room` px (compact when only that fits);
   *   'cell'              compact, inside the table cell / row (or the changed element itself, when nothing else
   *                       fits) `box`: right-aligned to x (the box's right edge, inset) from y (its top edge, inset)
   *                       and growing to the left, wrapping inside the box.
   * @typedef {{where: 'above'|'inline'|'gutter'|'cell', x: number, y: number, box?: DOMRect, room?: number}} RowAnchor
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

  /** The end of the document, in viewport coordinates. */
  function docEndY() {
    return document.documentElement.scrollHeight - window.scrollY;
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
    return { where: 'above', x: r.left + 8, y: Math.min(r.bottom, docEndY()) - 22 };
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
   * of the line above (list items, consecutive paragraphs). When that line has no room left inside the element's own
   * box (a full first line, a narrow column), the row goes into the left margin beside the change bars ('gutter';
   * layout() decides whether it fits there).
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
    if (cell) return cellCorner(cell);
    // No room above or after the first line (a narrow column, a full line): in the left margin, just left of the
    // change bars' column (a bar is 3 px wide at barX), never over the text.
    const x = barX(el, first) - 3;
    return { where: 'gutter', x, y: first.top + 1, room: Math.max(0, x - 2) };
  }

  /** The element's own top-right corner, compact: the last resort of a row with no room anywhere else. @param {DOMRect} first */
  function ownCorner(first) {
    return /** @type {RowAnchor} */ ({ where: 'cell', x: first.right - 2, y: first.top + 1, box: first });
  }

  /** Total width of a row of marks as laid out (GAP apart). @param {HTMLElement[]} row */
  function rowWidth(row) {
    return row.reduce((w, e) => w + (e.offsetWidth || 24) + GAP, -GAP);
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

  /**
   * The x of a change bar: 8 px left of the block, or of the outermost list / table / quote it is part of, so the
   * bars of one change line up in the margin instead of sitting on list bullets or cell borders.
   * @param {Element} el @param {DOMRect} r its client rect
   */
  function barX(el, r) {
    let left = r.left;
    for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (!BAR_CONTAINERS.has(n.localName)) break;
      const b = n.getBoundingClientRect();
      if (!isEmptyRect(b)) left = Math.min(left, b.left);
    }
    return Math.max(1, left - 8);
  }

  /** A picture rather than text: a changed one gets an outline (it has no words to highlight). @param {Element} el */
  function isFigure(el) {
    if (FIGURE_TAGS.has(el.localName) || el.matches(Capture.MERMAID_SEL)) return true;
    // a block holding just one picture (a paragraph with an image, a figure wrapper)
    const kids = el.children;
    return kids.length === 1 && FIGURE_TAGS.has(kids[0].localName) && !normWs(el.textContent || '');
  }

  /** The smallest rect holding both. @param {DOMRect} a @param {DOMRect} b */
  function unionRect(a, b) {
    const left = Math.min(a.left, b.left);
    const top = Math.min(a.top, b.top);
    return new DOMRect(left, top, Math.max(a.right, b.right) - left, Math.max(a.bottom, b.bottom) - top);
  }

  /** The colour class of a mark's bars and boxes. @param {Mark} m */
  function tone(m) {
    return m.side === 'old' ? 'del' : m.op === 'add' ? 'add' : 'mod';
  }

  function layout() {
    if (!Overlay.ready) return;
    const pool = Overlay.pool('changes');
    pool.begin();
    /** @type {Record<string, number|null>} */
    const pos = {};
    /** @type {Record<string, number|null>} */
    const end = {};
    const sy = window.scrollY;
    const openKey = Overlay.popover.openKey;
    let popoverAnchored = false;
    for (const m of marks) {
      const active = m.id === activeId;
      const cls = tone(m);
      /** @type {DOMRect|null} */
      let first = null;
      /** @type {Element|null} */
      let firstEl = null;
      /** @type {DOMRect|null} the union of the visible blocks */
      let span = null;
      for (const el of m.els) {
        if (!Targets.isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        if (isEmptyRect(r)) continue;
        if (!first) {
          first = r;
          firstEl = el;
        }
        span = span ? unionRect(span, r) : r;
        if (hidden) continue;
        const bar = pool.el(`bar:${m.id}:${sridOf(el)}`, `bar ${cls}${active ? ' active' : ''}`);
        Overlay.place(bar, barX(el, r) - (active ? 1 : 0), r.top, null, r.height);
        if (m.kind === 'asset' || isFigure(el)) {
          const fig = pool.el(`fig:${m.id}:${sridOf(el)}`, `box chg-fig ${cls}`);
          Overlay.place(fig, r.left - 3, r.top - 3, r.width + 6, r.height + 6);
        }
      }

      // Where the change is when it has no block on this side: where its lines were removed (the newer version) or
      // where the newer version's lines go (the older one).
      const old = m.side === 'old';
      const del = m.kind === 'hunk' && (old ? m.op === 'add' : m.op === 'del');
      /** @type {number|null} */
      let pointY = null;
      if (!first && del) {
        if (m.before) {
          const r = Targets.isVisible(m.before) ? m.before.getBoundingClientRect() : null;
          if (r && !isEmptyRect(r)) pointY = r.top;
        } else {
          pointY = docEndY();
        }
      }
      if (m.kind === 'hunk') {
        pos[m.id] = first ? Math.round(first.top + sy) : pointY != null ? Math.round(pointY + sy) : null;
        end[m.id] = span ? Math.round(span.bottom + sy) : pos[m.id];
      }
      if (hidden) continue;

      if (active && span) {
        const box = pool.el(`active:${m.id}`, `box chg-active ${cls}`);
        Overlay.place(box, span.left - 6, span.top - 4, span.width + 12, span.height + 8);
      }

      // The tab: before the next element for a pure deletion, on the changed element's row for a modification; on
      // the older side of a side-by-side comparison, where an added hunk's lines go. Beside the older version (split)
      // the newer one marks a deletion with a note and has no "was" tab.
      /** @type {RowAnchor|null} */
      let anchor = del && (old ? m.newLines > 0 : !!m.deleted || m.oldLines > 0) ? deletionAnchor(m) : null;
      const withTab = del ? !!anchor : !old && !splitNew && m.kind === 'hunk' && hasRemovedText(m) && !!first;
      if (!first && !anchor) continue;

      // Build the row (tab, then badges with the linked thread ids / the 'other' reason) and measure it.
      /** @type {HTMLElement[]} */
      const row = [];
      const lines = old ? m.newLines : m.deleted && Number(m.deleted.lines) ? Number(m.deleted.lines) : m.oldLines;
      const removed = `${lines} line${lines === 1 ? '' : 's'} removed`;
      /** @type {HTMLElement|null} */
      let tabEl = null;
      if (withTab && (old || splitNew)) {
        // informational: the other version beside this one shows the lines (added: green; removed: red, struck)
        tabEl = pool.el('tab:' + m.id, `tab ${old ? 'add' : 'note'}${active ? ' active' : ''}`);
        tabEl.textContent = old ? `⊕ ${lines} line${lines === 1 ? '' : 's'} added` : `⊖ ${removed}`;
        tabEl.title = old ? `${m.id}: ${lines} line${lines === 1 ? '' : 's'} added here in the newer version`
          : `${m.id}: ${removed} here (shown in the older version)`;
        tabEl.setAttribute('role', 'note');
        tabEl.setAttribute('aria-label', tabEl.title);
        tabEl.removeAttribute('tabindex');
        tabEl.onclick = null;
        tabEl.onkeydown = null;
        row.push(tabEl);
      } else if (withTab) {
        tabEl = pool.el('tab:' + m.id, 'tab' + (openKey === m.id ? ' open' : '') + (active ? ' active' : ''));
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
      if (m.other) badges.push({ key: 'other', text: 'note', cls: 'badge other', title: 'Also changed: ' + m.other, id: '' });
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
      if (!row.length) continue; // nothing but bars (no tab => `first` is set)
      /** @type {DOMRect|null} the element the row belongs to (for the last-resort corner) */
      let own = first;
      if (!anchor) {
        anchor = rowAnchor(/** @type {Element} */ (firstEl), /** @type {DOMRect} */ (first), Math.max(0, rowWidth(row)));
      } else if (del && m.before && anchor.where === 'above') {
        // Above the next element only where there is room (a margin); else after the end of its first line, so the
        // tab never covers the line before it (consecutive list items, paragraphs without spacing).
        own = m.before.getBoundingClientRect();
        anchor = rowAnchor(m.before, own, Math.max(0, rowWidth(row)));
      }

      if (anchor.where === 'gutter') {
        // In the left margin: as it is when it fits, else compact; failing both, the older version's "lines added"
        // note becomes a tick at the seam and anything else goes to the element's own corner.
        const room = anchor.room ?? 0;
        let fits = rowWidth(row) <= room;
        if (!fits) {
          if (tabEl) tabEl.textContent = old ? `⊕ ${lines}` : del ? `⊖ ${lines}` : '⊖';
          for (const e of row) e.classList.add('compact');
          fits = rowWidth(row) <= room;
        }
        if (fits) {
          let x = anchor.x;
          for (const e of [...row].reverse()) {
            const w = e.offsetWidth || 24;
            x -= w;
            Overlay.place(e, x, e === tabEl ? anchor.y : anchor.y + 1);
            x -= GAP;
          }
        } else if (old && tabEl && row.length === 1) {
          const vw = document.documentElement.clientWidth || window.innerWidth;
          tabEl.className = `tick${active ? ' active' : ''}`;
          tabEl.textContent = '';
          Overlay.place(tabEl, vw - 8, anchor.y);
        } else {
          anchor = ownCorner(own || /** @type {DOMRect} */ (first));
        }
      }

      if (anchor.where === 'cell') {
        // Compact, inside the cell: right-aligned from its top-right corner, growing left, wrapping downwards while
        // the next row still fits in the cell (else squeezed against its left edge).
        if (tabEl) tabEl.textContent = old ? `⊕ ${lines}` : del ? `⊖ ${lines}` : '⊖';
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
      } else if (anchor.where !== 'gutter') {
        // where the row belongs, also above or below the viewport: it scrolls away with its element
        const y0 = anchor.y;
        let x = tabEl ? Math.max(2, anchor.x) : anchor.where === 'above' ? Math.max(1, anchor.x - 8) : anchor.x;
        for (const e of row) {
          Overlay.place(e, x, e === tabEl ? y0 : y0 + 1.5);
          x += (e.offsetWidth || 24) + (e === tabEl ? GAP + 1 : GAP);
        }
      }

      if (tabEl) {
        const tab = tabEl.getBoundingClientRect();
        tabRects.set(m.id, tab);
        if (openKey === m.id) {
          Overlay.popover.move(tab);
          popoverAnchored = true;
        }
      }
    }
    if (openKey && !popoverAnchored && marks.some((m) => m.id === openKey)) Overlay.popover.hide();
    pool.end();
    positions = pos;
    ends = end;
  }

  return {
    /** @param {any} ch Changes payload or null */
    set(ch) {
      changes = ch && typeof ch === 'object' && Array.isArray(ch.hunks) ? ch : null;
      splitNew = !!changes && changes.side !== 'old' && changes.layout === 'split';
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
      paintWords();
      Scheduler.requestLayout();
    },
    /** The active change (SET_ACTIVE_HUNK, init.activeHunk), drawn stronger; null: none. @param {string|null} id */
    setActive(id) {
      const next = id == null ? null : String(id);
      if (next === activeId) return;
      activeId = next;
      Scheduler.requestLayout();
    },
    get activeId() {
      return activeId;
    },
    positions() {
      return positions;
    },
    /** The bottom of each change (document coordinates; see the header). */
    ends() {
      return ends;
    },
    /** Scrolls a hunk into view, a third down the viewport (SCROLL_TO {hunk}). @param {string} id */
    scrollTo(id) {
      const m = marks.find((x) => x.id === String(id));
      if (!m) return false;
      const el = m.els[0] || m.before;
      if (!el) {
        // removed at the end of the document (or, beside it, added at the end of the newer version)
        const atEnd = m.side === 'old' ? m.op === 'add' : m.op === 'del';
        const top = document.documentElement.scrollHeight;
        if (atEnd) window.scrollTo({ top, behavior: /** @type {any} */ ('instant') });
        return atEnd;
      }
      return Targets.scrollToSrid(/** @type {number} */ (sridOf(el)), Math.round(window.innerHeight / 3));
    },
    /** Debug summary. */
    debug() {
      return marks.map((m) => ({ id: m.id, op: m.op, side: m.side, els: m.els.length, before: !!m.before, threads: m.threads, other: m.other }));
    },
  };
})();
