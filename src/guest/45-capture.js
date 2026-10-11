// SpecReview guest, part 45: element captures, labels, table cells, mermaid nodes, regions and crops.
//
// Builds the FROZEN capture shapes (amendments 3.3):
//   { kind: 'element', srid, tag, label, region?: {x,y,w,h}, svg?: {nodeId, label},
//     cell?: {row, col, rowKey, colHeader, text}, scope?: 'cell'|'row'|'column'|'table' }
// Conventions chosen here (documented for WP3/WP7):
//   - `srid`/`tag` describe the nearest element carrying data-srid (inclusive) of the visual target; `label` names
//     the visual target itself (e.g. a mermaid node inside the stamped <pre class="mermaid">). srid is null when
//     no stamped ancestor exists (script-generated content outside any stamped element).
//   - `cell.row`/`cell.col` are 0-based indices in the table's rowspan/colspan-expanded grid, counting every row of
//     the table (thead rows included) in table.rows order. rowKey = text of the row's first grid cell; colHeader =
//     text of the header row's cell in that column (header row = last <thead> row, else row 0).
//   - region x/y/w/h are fractions (0..1, 4 decimals) of the content box of regionBase(sridEl): the stamped
//     element itself when it is media (img/svg/canvas/video/iframe/object/embed), else its single media
//     descendant, else the stamped element. The painter (70-targets.js) uses the same rule.

const Capture = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MEDIA_SEL = 'img, svg, canvas, video, iframe, object, embed';
  const MEDIA = new Set(['img', 'svg', 'canvas', 'video', 'iframe', 'object', 'embed']);
  const MERMAID_SEL = 'pre.mermaid, div.mermaid, [data-sr-kind="mermaid"]';
  const MATH_SEL = '.sr-math, [data-sr-kind="math"]';
  const LABEL_TEXT = 48;

  /** @param {string} s */
  const q = (s) => '"' + clip(s, LABEL_TEXT) + '"';

  /** The outermost <svg> containing (or being) el. @param {Element} el */
  function outerSvg(el) {
    let s = /** @type {any} */ (el.localName === 'svg' ? el : /** @type {any} */ (el).ownerSVGElement);
    while (s && s.ownerSVGElement) s = s.ownerSVGElement;
    return /** @type {SVGSVGElement|null} */ (s);
  }

  /** @param {Element} el */
  function isMedia(el) {
    return MEDIA.has(el.localName) && (el.localName !== 'svg' || !(/** @type {any} */ (el).ownerSVGElement));
  }

  /** The element a region is measured against (see header). @param {Element} sridEl */
  function regionBase(sridEl) {
    if (MEDIA.has(sridEl.localName)) return sridEl.localName === 'svg' ? outerSvg(sridEl) || sridEl : sridEl;
    const list = [...sridEl.querySelectorAll(MEDIA_SEL)].filter(isMedia);
    return list.length === 1 ? list[0] : sridEl;
  }

  /** The content box (border and padding removed) of an element in viewport coordinates. @param {Element} el */
  function contentBox(el) {
    const r = el.getBoundingClientRect();
    const isCssBox = el instanceof HTMLElement || (el.namespaceURI === SVG_NS && el.localName === 'svg' &&
      !(/** @type {any} */ (el).ownerSVGElement));
    if (!isCssBox) return r;
    const cs = getComputedStyle(el);
    const n = (/** @type {string} */ v) => parseFloat(v) || 0;
    const l = n(cs.borderLeftWidth) + n(cs.paddingLeft);
    const t = n(cs.borderTopWidth) + n(cs.paddingTop);
    const rr = n(cs.borderRightWidth) + n(cs.paddingRight);
    const b = n(cs.borderBottomWidth) + n(cs.paddingBottom);
    return new DOMRect(r.left + l, r.top + t, Math.max(0, r.width - l - rr), Math.max(0, r.height - t - b));
  }

  // ---- mermaid ------------------------------------------------------------------------------------------------

  /** @param {Element|null} el */
  function mermaidRoot(el) {
    return el ? el.closest(MERMAID_SEL) : null;
  }

  /** @param {Element} g */
  function isMermaidNodeGroup(g) {
    if (g.localName !== 'g') return false;
    const cls = g.getAttribute('class') || '';
    if (/\bedge|\bedgeLabel|\bedgePath|\bedgePaths|\bedgeLabels|\bnodes\b|\bclusters\b|\broot\b/.test(cls)) return false;
    return /(^|\s)(node|cluster|actor)(\s|$)/.test(cls) || g.hasAttribute('data-id');
  }

  /** The mermaid node group containing a hit element, or null. @param {Element} hit @param {Element} root */
  function mermaidNodeOf(hit, root) {
    for (let el = /** @type {Element|null} */ (hit); el && el !== root; el = el.parentElement) {
      if (isMermaidNodeGroup(el)) return el;
    }
    return null;
  }

  /** @param {Element} g */
  function mermaidNodeInfo(g) {
    let nodeId = g.getAttribute('data-id') || '';
    if (!nodeId) {
      const id = g.id || '';
      const m = /(?:^|-)(?:flowchart|state|classId|entity|node)-(.+?)-\d+$/.exec(id) || /^[a-z]+-(.+)-\d+$/.exec(id);
      nodeId = m ? m[1] : id;
    }
    return { nodeId, label: clip(g.textContent || '', 200) };
  }

  /**
   * Finds a mermaid node: by data-id, then by the id pattern, then by label text.
   * @param {Element} root @param {{nodeId?: string, label?: string}} svg
   */
  function findMermaidNode(root, svg) {
    const groups = [...root.querySelectorAll('g')].filter(isMermaidNodeGroup);
    if (svg.nodeId) {
      const byData = groups.find((g) => g.getAttribute('data-id') === svg.nodeId);
      if (byData) return byData;
      const byId = groups.find((g) => mermaidNodeInfo(g).nodeId === svg.nodeId);
      if (byId) return byId;
    }
    const label = normWs(svg.label || '');
    if (label) {
      const byLabel = groups.find((g) => normWs(g.textContent || '') === label);
      if (byLabel) return byLabel;
    }
    return null;
  }

  // ---- tables -------------------------------------------------------------------------------------------------

  /** Rowspan/colspan-aware grid of a table. @param {HTMLTableElement} table */
  function tableGrid(table) {
    const rows = [...table.rows];
    /** @type {Array<Array<HTMLTableCellElement|undefined>>} */
    const grid = rows.map(() => []);
    /** @type {Map<Element, {row: number, col: number}>} */
    const pos = new Map();
    rows.forEach((tr, r) => {
      let c = 0;
      for (const cell of [...tr.cells]) {
        while (grid[r][c]) c++;
        const rs = cell.rowSpan > 0 ? Math.min(cell.rowSpan, rows.length - r) : rows.length - r;
        const cs = Math.max(1, Math.min(cell.colSpan || 1, 1000));
        for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) grid[r + i][c + j] = cell;
        pos.set(cell, { row: r, col: c });
        c += cs;
      }
    });
    let headerRow = 0;
    if (table.tHead && table.tHead.rows.length) {
      headerRow = rows.indexOf(table.tHead.rows[table.tHead.rows.length - 1]);
      if (headerRow < 0) headerRow = 0;
    }
    return { rows, grid, pos, headerRow };
  }

  /** @param {Element} cell */
  function cellInfo(cell) {
    const table = /** @type {HTMLTableElement|null} */ (cell.closest('table'));
    if (!table) return null;
    const { grid, pos, headerRow } = tableGrid(table);
    const p = pos.get(cell);
    if (!p) return null;
    const first = grid[p.row] && grid[p.row][0];
    const head = grid[headerRow] && grid[headerRow][p.col];
    return {
      row: p.row,
      col: p.col,
      rowKey: first ? clip(TextWalk.textOf(first), 200) : '',
      colHeader: head ? clip(TextWalk.textOf(head), 200) : '',
      text: clip(TextWalk.textOf(cell), 200),
    };
  }

  // ---- labels -------------------------------------------------------------------------------------------------

  /** @param {string} src */
  function basename(src) {
    try {
      const u = new URL(src, location.href);
      if (u.protocol === 'data:') return 'data URI';
      const parts = u.pathname.split('/');
      return decodeURIComponent(parts[parts.length - 1] || u.hostname);
    } catch {
      return String(src).slice(0, 40);
    }
  }

  /**
   * A short human label for a visual target, e.g. img "System overview", td refresh_token / TTL, h2 "Rollout".
   * @param {Element} el
   */
  function labelFor(el) {
    const tag = el.localName;
    if (tag === 'img') {
      const alt = el.getAttribute('alt');
      return 'img ' + (alt ? q(alt) : basename(el.getAttribute('src') || ''));
    }
    if (tag === 'td' || tag === 'th') {
      const info = cellInfo(el);
      if (info) return `${tag} ${clip(info.rowKey, 32) || '(row ' + info.row + ')'} / ${clip(info.colHeader, 32) || '(col ' + info.col + ')'}`;
    }
    const mer = mermaidRoot(el);
    if (mer) {
      const node = el === mer ? null : mermaidNodeOf(el, mer);
      if (node) return 'mermaid node ' + q(mermaidNodeInfo(node).label || mermaidNodeInfo(node).nodeId);
      return 'mermaid diagram';
    }
    if (el.matches(MATH_SEL) || el.classList.contains('katex')) return 'math ' + q(TextWalk.textOf(el) || el.textContent || '');
    if (el.namespaceURI === SVG_NS) {
      const text = normWs(el.textContent || '');
      return 'svg' + (tag === 'svg' ? '' : ' ' + tag) + (text ? ' ' + q(text) : '');
    }
    if (tag === 'canvas' || tag === 'video' || tag === 'audio' || tag === 'iframe') {
      const src = el.getAttribute('src') || el.getAttribute('aria-label') || el.id || '';
      return tag + (src ? ' ' + q(tag === 'canvas' ? src : basename(src)) : '');
    }
    if (tag === 'pre') {
      const kind = el.getAttribute('data-sr-kind');
      const first = (TextWalk.buildIndex(el).raw.split('\n').find((l) => l.trim()) || '');
      return (kind === 'code' ? 'code block ' : 'pre ') + q(first);
    }
    if (tag === 'table') {
      const cap = /** @type {HTMLTableElement} */ (el).caption;
      return 'table' + (cap ? ' ' + q(cap.textContent || '') : '');
    }
    const text = TextWalk.textOf(el);
    return tag + (text ? ' ' + q(text) : '');
  }

  // ---- captures -----------------------------------------------------------------------------------------------

  /**
   * Builds an element capture for a visual target.
   * @param {Element} target  the visual target (img, td, mermaid node group, svg g, p, ...)
   * @param {{region?: {x:number,y:number,w:number,h:number}, svg?: {nodeId:string,label:string},
   *          cell?: object|null, scope?: string, sridEl?: Element|null, label?: string}} [extra]
   */
  function elementCapture(target, extra = {}) {
    const sridEl = extra.sridEl || closestSridEl(target);
    /** @type {Record<string, any>} */
    const cap = {
      kind: 'element',
      srid: sridOf(sridEl),
      tag: (sridEl || target).localName,
      label: extra.label || labelFor(target),
    };
    if (extra.region) cap.region = extra.region;
    if (extra.svg) cap.svg = extra.svg;
    if (extra.cell) cap.cell = extra.cell;
    if (extra.scope) cap.scope = extra.scope;
    return cap;
  }

  /**
   * Capture for a table cell at a given scope.
   * @param {Element} cell @param {'cell'|'row'|'column'|'table'} scope
   */
  function cellCapture(cell, scope) {
    const info = cellInfo(cell);
    const tr = cell.closest('tr');
    const table = cell.closest('table');
    if (scope === 'row' && tr) {
      return elementCapture(tr, { sridEl: closestSridEl(tr), cell: info, scope,
        label: 'table row ' + q(info ? info.rowKey : TextWalk.textOf(tr)) });
    }
    if (scope === 'column' && table) {
      return elementCapture(table, { sridEl: closestSridEl(table), cell: info, scope,
        label: 'table column ' + q(info ? info.colHeader : '') });
    }
    if (scope === 'table' && table) {
      return elementCapture(table, { sridEl: closestSridEl(table), scope, label: labelFor(table) });
    }
    return elementCapture(cell, { cell: info, scope: 'cell' });
  }

  /**
   * Capture for a mermaid node group.
   * @param {Element} node @param {Element} root
   */
  function mermaidCapture(node, root) {
    const info = mermaidNodeInfo(node);
    return elementCapture(node, { sridEl: closestSridEl(root), svg: info,
      label: 'mermaid node ' + q(info.label || info.nodeId) });
  }

  // ---- crops --------------------------------------------------------------------------------------------------

  const MAX_CROP = 1024;

  /** @param {CanvasImageSource} src @param {number} sx @param {number} sy @param {number} sw @param {number} sh @param {number} maxScale */
  function drawCrop(src, sx, sy, sw, sh, maxScale) {
    if (sw < 1 || sh < 1) return null;
    const scale = Math.min(maxScale, MAX_CROP / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    try {
      return canvas.toDataURL('image/png'); // throws SecurityError on a tainted canvas
    } catch {
      return null;
    }
  }

  /**
   * Crops a region (fractions of the content box) of a media element to a PNG data URL (<= 1024 px).
   * Tainted sources, iframes and failures resolve to null silently.
   * @param {Element} el @param {{x:number,y:number,w:number,h:number}} f
   * @returns {Promise<string|null>}
   */
  async function cropRegion(el, f) {
    const tag = el.localName;
    if (tag === 'img') {
      const img = /** @type {HTMLImageElement} */ (el);
      if (!img.complete || !img.naturalWidth) return null;
      const W = img.naturalWidth, H = img.naturalHeight;
      return drawCrop(img, f.x * W, f.y * H, f.w * W, f.h * H, 1);
    }
    if (tag === 'canvas') {
      const c = /** @type {HTMLCanvasElement} */ (el);
      return drawCrop(c, f.x * c.width, f.y * c.height, f.w * c.width, f.h * c.height, 1);
    }
    if (tag === 'video') {
      const v = /** @type {HTMLVideoElement} */ (el);
      if (!v.videoWidth) return null;
      return drawCrop(v, f.x * v.videoWidth, f.y * v.videoHeight, f.w * v.videoWidth, f.h * v.videoHeight, 1);
    }
    if (tag === 'svg') {
      const box = contentBox(el);
      if (box.width < 1 || box.height < 1) return null;
      const clone = /** @type {Element} */ (el.cloneNode(true));
      clone.setAttribute('xmlns', SVG_NS);
      clone.setAttribute('width', String(box.width));
      clone.setAttribute('height', String(box.height));
      const xml = new XMLSerializer().serializeToString(clone);
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      await img.decode();
      return drawCrop(img, f.x * box.width, f.y * box.height, f.w * box.width, f.h * box.height, 2);
    }
    return null;
  }

  /** cropRegion with a 2 s timeout and no rejection. @param {Element} el @param {{x:number,y:number,w:number,h:number}} f */
  function safeCrop(el, f) {
    return Promise.race([
      cropRegion(el, f).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
  }

  return {
    MEDIA_SEL,
    MERMAID_SEL,
    MATH_SEL,
    outerSvg,
    isMedia,
    regionBase,
    contentBox,
    mermaidRoot,
    mermaidNodeOf,
    mermaidNodeInfo,
    findMermaidNode,
    tableGrid,
    cellInfo,
    labelFor,
    elementCapture,
    cellCapture,
    mermaidCapture,
    cropRegion: safeCrop,
  };
})();
