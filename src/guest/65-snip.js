// SpecReview guest, part 65: snip mode (drag a box over ANY area of the doc -> SnipCapture + PNG crop).
//
// Entered with setTool {tool:'snip'} from the UI, or by pressing `b` in the document (85-keys.js; the guest then
// posts toolChanged {tool:'snip'} and the key is not forwarded). Like pick mode it lays the transparent glass
// (cursor: crosshair) over the viewport, so the page never sees the drag; a hint chip says how to finish or cancel.
// The reviewer drags a box (it follows the page when the wheel scrolls during the drag, and dragging to the top or
// bottom edge scrolls); a box smaller than SNIP.minPx either way is ignored and snip mode stays on. Esc or `b` again
// cancels (toolChanged {tool:'select'}); setTool {tool:'select'|'pick'} leaves it silently.
//
// On release the guest computes the SnipCapture (protocol.js SNIP, frozen shape, keys in this order):
//   { kind: 'snip', srids, startSrid, endSrid, containerSrid, region, text, label }
//   - srids: canonical stamped elements (the parser's originals, see SridIndex) whose tag is in BLOCK_TAGS, whose
//     border box overlaps the box (by at least MIN_OVERLAP px both ways, or their whole width / height when smaller)
//     and that have no such block descendant ("leaf blocks"), in document order. Above SNIP.maxSrids the first
//     maxSrids - 1 and the last one are kept, so startSrid / endSrid (first / last of srids) still bound the area.
//   - containerSrid: the deepest canonical stamped element whose border box contains the whole box (null: none).
//   - region: the box as fractions of containerSrid's border box (Capture.regionOf), or of the document
//     (scrollWidth x scrollHeight) when containerSrid is null. The painter (70-targets.js) uses the same box, so a
//     DomTarget {kind:'element', srid: containerSrid, region} is drawn exactly where the reviewer dragged.
//   - text: the visible rendered text inside the box (TEXT_EXCLUDE walk of the container, or of the document; each
//     character counts when the centre of its Range rect is inside the box), whitespace collapsed, gaps read as one
//     space, zero-width characters dropped, at most SNIP.maxText characters. KaTeX math the box touches reads as its
//     TeX source ($...$, or $$...$$ for display math) from the MathML annotation: the HTML rendering's text is in
//     layout order (a fraction's denominator before its numerator) and full of zero-width struts.
//   - label: e.g. 'area in "2. Request flow" (paragraph + figure)' - the heading inside the box ("over"), else the
//     heading the area sits under ("in"), plus what the box covers: a single block, or the blocks of a single
//     table / figure / diagram, named by Capture.labelFor; else counts ("2 headings + paragraph").
// Then it leaves snip mode (toolChanged {tool:'select'}), keeps the box drawn while the crop renders, and posts
//   action {action:'comment', capture, rect, crop?}
// rect = the box in viewport coordinates when the action is sent. crop = a PNG data URL of exactly the boxed area,
// pixel for pixel what the page shows there minus the overlay: the vendored modern-screenshot library (lazily
// imported from the content origin, next to this script: <guest.js dir>/vendor/modern-screenshot/index.mjs; no DOM
// change) clones the smallest element containing the box that lays out on its own like on the page (renderPlan; at
// worst <html>) into an SVG foreignObject whose viewBox is narrowed to the box, so only the boxed area is rasterised:
// scale = devicePixelRatio, capped so the PNG is at most 1600 px wide and 4096 px high (re-encoded smaller when the
// data URL would exceed what an attachment may hold). Only what can show in the box is cloned: the overlay host, the
// guest's script and <head> are filtered out, and so are the root's blocks above the box (rootCut), in-flow blocks
// below it and the content of blocks away from it (canHollow); <img> sources used only outside it are not fetched.
// So a snip costs about the same at the end of a long document as at its start. The clone's style sandbox iframe lives
// in the overlay's closed shadow root (the author's DOM is never touched) and the empty parts are painted with the
// page background. Any failure (no module, a CSP that blocks data: images, a tainted canvas, more than 6 s) just
// omits `crop`: the snip is never blocked.

const Snip = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const BLOCKS = new Set(BLOCK_TAGS);
  /** A block counts as covered when the box overlaps it by this much both ways (or its whole width / height). */
  const MIN_OVERLAP = 3;
  const CROP_TIMEOUT_MS = 6000;
  /** Timeout for loading media and fetching assets inside the rasteriser. */
  const MEDIA_TIMEOUT_MS = 3000;
  const MAX_CROP_W = 1600;
  const MAX_CROP_H = 4096;
  /** Longest crop data URL (~4.9 MB of PNG): attachments are capped at LIMITS.maxAttachmentBytes (5 MB). */
  const MAX_CROP_CHARS = 6500000;
  /** Upper bound of per-character Range probes for text the box cuts through. */
  const MAX_CHAR_PROBES = 40000;
  /** Zero-width characters (KaTeX struts, joiners, BOM) left out of the snip text. */
  const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);
  const EDGE_PX = 28;
  const MAX_AUTOSCROLL = 24;
  const VENDOR_PATH = 'vendor/modern-screenshot/index.mjs';
  const HINT = 'Drag a box over the area to snip \u00b7 Esc cancels';
  const CAPTURING = 'Capturing snip\u2026';
  /** Displays whose children are laid out in normal block flow (later siblings never move earlier ones). */
  const FLOW_DISPLAYS = new Set(['block', 'flow-root', 'list-item']);
  /** Outer displays of in-flow block-level boxes. */
  const BLOCK_DISPLAYS = new Set(['block', 'flow-root', 'list-item', 'table', 'flex', 'grid']);
  /** Displays whose box keeps the width / height the clone copies from the page when its content is left out. */
  const SIZED_DISPLAYS = new Set(['block', 'flow-root', 'list-item', 'flex', 'grid']);
  /** Stands in for images used only outside the box (never fetched nor embedded). */
  const BLANK_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  /** XML-illegal characters stripped before the SVG is loaded as an image (as modern-screenshot does). */
  const CONTROL_CHARS = /[\u0000-\u0008\v\f\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/gu;

  /** Unit nouns of the label: [singular, plural]. */
  const NOUNS = /** @type {Record<string, [string, string]>} */ ({
    heading: ['heading', 'headings'], paragraph: ['paragraph', 'paragraphs'], item: ['list item', 'list items'],
    table: ['table', 'tables'], figure: ['figure', 'figures'], image: ['image', 'images'],
    diagram: ['diagram', 'diagrams'], code: ['code block', 'code blocks'], quote: ['quote', 'quotes'],
    media: ['media element', 'media elements'], term: ['definition', 'definitions'], details: ['details', 'details'],
    rule: ['rule', 'rules'], block: ['block', 'blocks'],
  });

  /**
   * @typedef {{left: number, top: number, right: number, bottom: number, width: number, height: number}} Box
   * @typedef {{ok: boolean, ms: number, error: string|null, root: string|null, cut: number, width: number,
   *   height: number}} CropInfo
   */

  let active = false;
  /** Drag start in DOCUMENT coordinates; the pointer's last VIEWPORT position. */
  /** @type {{x0: number, y0: number, x: number, y: number, pointerId: number}|null} */
  let drag = null;
  let scrollRaf = 0;
  /** The finished box (document coordinates) whose crop is still rendering. */
  /** @type {{doc: DOMRect, token: number}|null} */
  let pending = null;
  let pendingSeq = 0;
  /** @type {CropInfo|null} */
  let lastCrop = null;
  /** Milliseconds the last SnipCapture took to compute (debug). */
  let lastCaptureMs = 0;
  /** @type {Promise<any>|null} */
  let lib = null;

  // ---- geometry -----------------------------------------------------------------------------------------------

  /** The scrollable size of the document. */
  function docSize() {
    const se = document.scrollingElement || document.documentElement;
    return { width: Math.max(se.scrollWidth, se.clientWidth), height: Math.max(se.scrollHeight, se.clientHeight) };
  }

  /** A document-coordinate rect in viewport coordinates (now). @param {DOMRect} doc */
  function toViewport(doc) {
    return new DOMRect(doc.left - window.scrollX, doc.top - window.scrollY, doc.width, doc.height);
  }

  /** The current drag rectangle in document coordinates, clamped into the document. */
  function dragDocRect() {
    const d = /** @type {NonNullable<typeof drag>} */ (drag);
    const size = docSize();
    const x1 = d.x + window.scrollX;
    const y1 = d.y + window.scrollY;
    const l = clamp(Math.min(d.x0, x1), 0, size.width);
    const r = clamp(Math.max(d.x0, x1), 0, size.width);
    const t = clamp(Math.min(d.y0, y1), 0, size.height);
    const b = clamp(Math.max(d.y0, y1), 0, size.height);
    return new DOMRect(l, t, r - l, b - t);
  }

  /** Whether a block's border box is covered by the box (see header). @param {DOMRect} r @param {Box} box */
  function covers(r, box) {
    const w = Math.min(r.right, box.right) - Math.max(r.left, box.left);
    const h = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
    return w > 0 && h > 0 && w >= Math.min(MIN_OVERLAP, r.width) && h >= Math.min(MIN_OVERLAP, r.height);
  }

  /** Whether r contains the whole box (half a pixel of tolerance). @param {DOMRect} r @param {Box} box */
  function encloses(r, box) {
    return r.left <= box.left + 0.5 && r.top <= box.top + 0.5 && r.right >= box.right - 0.5 &&
      r.bottom >= box.bottom - 0.5;
  }

  /** @param {Element} el */
  function depthOf(el) {
    let d = 0;
    for (let e = /** @type {Element|null} */ (el); e; e = e.parentElement) d++;
    return d;
  }

  // ---- the capture --------------------------------------------------------------------------------------------

  /**
   * The SnipCapture of a viewport box, plus the container element (for the crop).
   * @param {Box} box
   */
  function buildCapture(box) {
    /** @type {Element[]} */
    const blocks = [];
    /** @type {Element|null} */
    let container = null;
    let depth = -1;
    let area = Infinity;
    for (const el of document.querySelectorAll('[data-srid]')) {
      const srid = sridOf(el);
      if (srid == null || elementBySrid(srid) !== el) continue; // a script-made copy: its srid is the original's
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (BLOCKS.has(el.localName) && covers(r, box)) blocks.push(el);
      if (encloses(r, box)) {
        const d = depthOf(el);
        const a = r.width * r.height;
        if (d > depth || (d === depth && a < area)) {
          container = el;
          depth = d;
          area = a;
        }
      }
    }
    // Document order: the block descendants of an element follow it contiguously, so a block is a leaf exactly when
    // the next covered block is not inside it.
    let leaves = blocks.filter((el, i) => !(i + 1 < blocks.length && el.contains(blocks[i + 1])));
    if (leaves.length > SNIP.maxSrids) leaves = leaves.slice(0, SNIP.maxSrids - 1).concat(leaves[leaves.length - 1]);
    const srids = /** @type {number[]} */ (leaves.map(sridOf));
    let base;
    if (container) {
      base = Capture.regionBox(container);
    } else {
      const size = docSize();
      base = new DOMRect(-window.scrollX, -window.scrollY, size.width, size.height);
    }
    const capture = {
      kind: 'snip',
      srids,
      startSrid: srids.length ? srids[0] : null,
      endSrid: srids.length ? srids[srids.length - 1] : null,
      containerSrid: sridOf(container),
      region: Capture.regionOf(box, base),
      text: textIn(box, container),
      label: labelOf(box, leaves),
    };
    return { capture, container };
  }

  /**
   * Visible rendered text inside the box (see header).
   * @param {Box} box
   * @param {Element|null} scope  the container (its subtree holds everything inside the box), else the document
   */
  function textIn(box, scope) {
    const index = scope ? TextWalk.buildIndex(scope) : TextWalk.docIndex();
    /** @type {string[]} */
    const out = [];
    let len = 0;
    let gap = false;
    let probes = 0;
    const range = document.createRange();
    /** @type {Map<Element, boolean>} */
    const shown = new Map();
    /** @type {Set<Element>} KaTeX elements already read as TeX */
    const tex = new Set();
    /** @param {Text} t */
    const visible = (t) => {
      const p = t.parentElement;
      if (!p) return false;
      let v = shown.get(p);
      if (v === undefined) {
        v = typeof p.checkVisibility === 'function' ? p.checkVisibility(/** @type {any} */ ({ visibilityProperty: true })) : true;
        shown.set(p, v);
      }
      return v;
    };
    /** @param {string} s */
    const push = (s) => {
      if (gap && len) {
        out.push(' ');
        len++;
      }
      gap = false;
      out.push(s);
      len += s.length;
    };
    for (const seg of index.segs) {
      if (len > SNIP.maxText) break;
      if (!seg.node) {
        gap = true;
        continue;
      }
      const node = seg.node;
      const data = node.data;
      if (!data || !visible(node)) {
        gap = true;
        continue;
      }
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
      if (!rects.some((r) => r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom)) {
        gap = true;
        continue;
      }
      const math = node.parentElement?.closest('.katex');
      const source = math ? texOf(math) : '';
      if (math && source) {
        if (!tex.has(math)) {
          tex.add(math);
          gap = true;
          push(math.closest('.katex-display') ? `$$${source}$$` : `$${source}$`);
          gap = true;
        }
        continue;
      }
      const whole = rects.every((r) => r.left >= box.left - 0.5 && r.right <= box.right + 0.5 &&
        r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5);
      for (let i = 0; i < data.length && len <= SNIP.maxText; i++) {
        const c = data.charCodeAt(i);
        if (TextWalk.isWsCode(c)) {
          gap = true;
          continue;
        }
        if (ZERO_WIDTH.has(c)) continue;
        const n = c >= 0xd800 && c <= 0xdbff && i + 1 < data.length ? 2 : 1;
        let hit = whole;
        if (!whole && probes++ < MAX_CHAR_PROBES) {
          range.setStart(node, i);
          range.setEnd(node, i + n);
          const r = range.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          hit = (r.width > 0 || r.height > 0) && cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom;
        }
        if (hit) push(data.slice(i, i + n));
        else gap = true;
        i += n - 1;
      }
    }
    range.detach();
    return clip(out.join(''), SNIP.maxText);
  }

  /**
   * The TeX source of a rendered KaTeX element (its MathML annotation), whitespace collapsed; '' when it has none.
   * @param {Element} math  a .katex element
   */
  function texOf(math) {
    const a = math.querySelector('annotation[encoding="application/x-tex"]');
    return (a?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  /** What a leaf block counts as in the label: [noun key, unit element]. @param {Element} leaf */
  function unitOf(leaf) {
    const table = leaf.closest('table');
    if (table) return /** @type {[string, Element]} */ (['table', table]);
    const mer = Capture.mermaidRoot(leaf);
    if (mer) return /** @type {[string, Element]} */ (['diagram', mer]);
    const fig = leaf.closest('figure');
    if (fig) return /** @type {[string, Element]} */ (['figure', fig]);
    const tag = leaf.localName;
    /** @type {string} */
    let key = 'block';
    let el = leaf;
    if (/^h[1-6]$/.test(tag)) key = 'heading';
    else if (tag === 'p') key = 'paragraph';
    else if (tag === 'li') key = 'item';
    else if (tag === 'pre') key = 'code';
    else if (tag === 'blockquote') key = 'quote';
    else if (tag === 'img') key = 'image';
    else if (tag === 'svg' || tag === 'canvas') key = 'diagram';
    else if (['video', 'audio', 'iframe', 'embed', 'object'].includes(tag)) key = 'media';
    else if (tag === 'dt' || tag === 'dd') key = 'term';
    else if (tag === 'hr') key = 'rule';
    else if (tag === 'details' || tag === 'summary') {
      key = 'details';
      el = leaf.closest('details') || leaf;
    }
    return /** @type {[string, Element]} */ ([key, el]);
  }

  /** @param {Element} el */
  function isHeading(el) {
    return /^h[1-6]$/.test(el.localName);
  }

  /** The last heading at or before a node in document order (excluded content and the overlay skipped). @param {Node} node */
  function headingBefore(node) {
    /** @type {Element|null} */
    let found = null;
    for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      if (h !== node && !(h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
      if (!TextWalk.isExcluded(h) && TextWalk.textOf(h)) found = h;
    }
    return found;
  }

  /** The topmost page element at a viewport point (the overlay is skipped). @param {number} x @param {number} y */
  function elementAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === Overlay.host || OWN_NODES.has(el)) continue;
      return el;
    }
    return null;
  }

  /**
   * The capture label (see header).
   * @param {Box} box @param {Element[]} leaves
   */
  function labelOf(box, leaves) {
    /** @type {Map<string, Set<Element>>} */
    const units = new Map();
    for (const leaf of leaves) {
      const [key, el] = unitOf(leaf);
      let set = units.get(key);
      if (!set) units.set(key, (set = new Set()));
      set.add(el);
    }
    let what = '';
    const all = [...units.values()].flatMap((set) => [...set]);
    if (leaves.length === 1) {
      what = Capture.labelFor(leaves[0]); // one block: name it (the img, not the figure around it)
    } else if (all.length === 1) {
      what = Capture.labelFor(all[0]); // several blocks of one unit (cells of a table, img + caption of a figure)
    } else if (all.length > 1) {
      const parts = [...units].map(([key, set]) => (set.size === 1 ? NOUNS[key][0] : `${set.size} ${NOUNS[key][1]}`));
      what = parts.length > 4 ? parts.slice(0, 4).join(' + ') + ' + more' : parts.join(' + ');
    }
    const inside = leaves.find(isHeading);
    const ref = leaves[0] || elementAt(box.left + box.width / 2, box.top + box.height / 2);
    const heading = inside || (ref ? headingBefore(ref) : null);
    const title = heading ? clip(TextWalk.textOf(heading), 48) : '';
    let label = title ? `area ${inside ? 'over' : 'in'} "${title}"` : 'area';
    if (what) label += ` (${what})`;
    else if (!title) label = 'area of the page';
    return clip(label, 200);
  }

  // ---- the crop -----------------------------------------------------------------------------------------------

  /** The vendored modern-screenshot module (imported once, on first use; a failed import is retried next time). */
  function loadLib() {
    if (!lib) {
      const src = SCRIPT_EL && SCRIPT_EL.src;
      if (!src) return Promise.reject(new Error('the guest script URL is unknown'));
      lib = import(new URL(VENDOR_PATH, src).href).then((m) => {
        if (!m || typeof m.createContext !== 'function' || typeof m.domToForeignObjectSvg !== 'function') {
          throw new Error('unexpected screenshot module');
        }
        return m;
      });
      lib.catch(() => {
        lib = null;
      });
    }
    return lib;
  }

  /**
   * What the crop renders. The root: the deepest element (stamped or not: e.g. a Markdown doc's <article>) whose border
   * box contains the box, at or below the container (else <html>), climbing out of elements that cannot be laid out
   * on their own: inline, display: contents, table internals, ruby, MathML, SVG altogether (for an <svg> root
   * modern-screenshot hands back the live element instead of a clone), and elements that would not lay out like on
   * the page once cut from their ancestors: a child margin collapsing through their top (unless rootCut takes that
   * child away), a positioned descendant placed against an element outside them. Plus the root's cut (rootCut).
   * @param {Element|null} container @param {DOMRect} doc the box in document coordinates
   * @returns {{root: Element, cut: ReturnType<typeof rootCut>}}
   */
  function renderPlan(container, doc) {
    const docEl = document.documentElement;
    const box = toViewport(doc);
    const start = container || docEl;
    let el = start;
    for (let e = elementAt(box.left + box.width / 2, box.top + box.height / 2); e && e !== start; e = e.parentElement) {
      if (start.contains(e) && encloses(e.getBoundingClientRect(), box)) {
        el = e;
        break;
      }
    }
    while (el && el !== docEl) {
      if (el.namespaceURI === SVG_NS) {
        el = /** @type {Element} */ ((Capture.outerSvg(el) || el).parentElement);
        continue;
      }
      if (!(el instanceof HTMLElement)) {
        el = /** @type {Element} */ (el.parentElement);
        continue;
      }
      const d = getComputedStyle(el).display;
      const laidOutAlone = Capture.isMedia(el) || !(d === 'inline' || d === 'contents' || d === 'none' ||
        d.startsWith('table-') || d.startsWith('ruby'));
      if (laidOutAlone) {
        const cut = rootCut(el, doc);
        if ((cut || topSealed(el)) && positionedInside(el)) return { root: el, cut };
      }
      el = /** @type {Element} */ (el.parentElement);
    }
    return { root: docEl, cut: null };
  }

  /**
   * The lowest viewport y an element paints at: its border box plus what overflows below it (glyphs taller than the
   * line height, overhanging children) unless it clips.
   * @param {Element} el @param {CSSStyleDeclaration} s
   */
  function inkBottom(el, s) {
    const r = el.getBoundingClientRect();
    return r.bottom + (s.overflowY === 'visible' ? Math.max(0, el.scrollHeight - el.clientHeight) : 0);
  }

  /** Whether computed styles describe an in-flow block-level box. @param {CSSStyleDeclaration} s */
  function inFlowBlock(s) {
    return BLOCK_DISPLAYS.has(s.display) && s.float === 'none' && (s.position === 'static' || s.position === 'relative');
  }

  /**
   * The first in-flow child box of an element when it is a block (its top margin may collapse with the element's),
   * else null (inline content comes first, or there is no child box). Out-of-flow children are skipped.
   * @param {Element} el
   */
  function firstFlowChild(el) {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === Node.TEXT_NODE) {
        if (/^[ \t\n\r\f]*$/.test(/** @type {Text} */ (n).data)) continue;
        return null;
      }
      if (!isElement(n)) continue;
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.float !== 'none' || s.position === 'absolute' || s.position === 'fixed') continue;
      return BLOCK_DISPLAYS.has(s.display) ? n : null;
    }
    return null;
  }

  /** Whether no margin can collapse through the top of a box with these styles (a BFC, a top border or padding). */
  function sealsTop(/** @type {CSSStyleDeclaration} */ s) {
    return (s.display !== 'block' && s.display !== 'list-item') || s.overflowX !== 'visible' ||
      s.overflowY !== 'visible' || s.float !== 'none' || s.position === 'absolute' || s.position === 'fixed' ||
      (parseFloat(s.borderTopWidth) || 0) > 0 || (parseFloat(s.paddingTop) || 0) > 0 ||
      /\b(layout|paint|strict|content)\b/.test(s.contain) || s.columnCount !== 'auto' || s.columnWidth !== 'auto';
  }

  /**
   * The top margin of an element as laid out: its own collapsed with those of its first-child chain (largest positive
   * plus most negative), as long as nothing seals the chain.
   * @param {Element} el
   */
  function collapsedTopMargin(el) {
    let pos = 0;
    let neg = 0;
    for (let e = /** @type {Element|null} */ (el); e;) {
      const s = getComputedStyle(e);
      const m = parseFloat(s.marginTop) || 0;
      if (m > pos) pos = m;
      if (m < neg) neg = m;
      if (sealsTop(s)) break;
      e = firstFlowChild(e);
    }
    return pos + neg;
  }

  /** Whether no child margin collapses through an element's top (its children sit where its box says). @param {Element} el */
  function topSealed(el) {
    if (sealsTop(getComputedStyle(el))) return true;
    const c = firstFlowChild(el);
    return !c || collapsedTopMargin(c) === 0;
  }

  /**
   * Whether every positioned descendant of an element is placed against it or an element inside it (the root clone
   * is made their containing block, see rasterise()), so that it lays out like on the page when rendered alone.
   * @param {Element} el
   */
  function positionedInside(el) {
    for (const e of el.querySelectorAll('*')) {
      const p = getComputedStyle(e).position;
      if (p === 'static' || p === 'relative' || p === 'sticky') continue;
      if (p === 'fixed') return false;
      const cb = /** @type {HTMLElement} */ (e).offsetParent;
      if (cb ? cb !== el && !el.contains(cb) : e.getClientRects().length > 0) return false;
    }
    return true;
  }

  /**
   * The children of a block-container root that lie entirely above the box are left out of the clone; the root clone
   * becomes a flow-root (no margin collapses through its top) whose padding-top puts the first child kept exactly
   * where it is on the page. Null when that cannot be done exactly (inline content in the way, floats or positioned
   * boxes, a shifted first child, multi-column or vertical text...).
   * @param {Element} root @param {DOMRect} doc the box in document coordinates
   * @returns {{cut: Set<Node>, style: Record<string, string>}|null}
   */
  function rootCut(root, doc) {
    if (!(root instanceof HTMLElement) || root === document.documentElement) return null;
    const cs = getComputedStyle(root);
    if ((cs.display !== 'block' && cs.display !== 'flow-root') || cs.writingMode !== 'horizontal-tb' ||
        cs.columnCount !== 'auto' || cs.columnWidth !== 'auto') return null;
    const top = doc.top - window.scrollY;
    /** @type {Set<Node>} */
    const cut = new Set();
    /** @type {Element|null} */
    let first = null;
    for (let n = root.firstChild; n && !first; n = n.nextSibling) {
      if (n.nodeType === Node.COMMENT_NODE) continue;
      if (n.nodeType === Node.TEXT_NODE) {
        if (!/^[ \t\n\r\f]*$/.test(/** @type {Text} */ (n).data)) return null; // inline content: line boxes
        cut.add(n);
        continue;
      }
      if (!isElement(n)) return null;
      const s = getComputedStyle(n);
      if (s.display === 'none') {
        cut.add(n);
        continue;
      }
      if (!inFlowBlock(s)) return null;
      if (inkBottom(n, s) > top - 1) first = n;
      else cut.add(n);
    }
    if (!first || ![...cut].some(isElement)) return null;
    const fs = getComputedStyle(first);
    if (fs.position !== 'static' || fs.transform !== 'none' || fs.translate !== 'none' || fs.scale !== 'none' ||
        fs.rotate !== 'none') return null;
    const pad = first.getBoundingClientRect().top - root.getBoundingClientRect().top -
      (parseFloat(cs.borderTopWidth) || 0) - collapsedTopMargin(first);
    if (!(pad >= 0)) return null;
    return { cut, style: { display: 'flow-root', paddingTop: pad + 'px' } };
  }

  /**
   * Whether an element away from the box can be cloned without its content ("hollow"): the clone copies its used
   * width / height, so its box keeps its size, and none of it shows in the crop. Only when nothing it paints reaches
   * the box (its overflow included; no positioned descendant placed against an element outside it) and no child
   * margin collapses through its top (else the element itself would move).
   * @param {Element} el @param {DOMRect} doc the box in document coordinates
   */
  function canHollow(el, doc) {
    if (!(el instanceof HTMLElement) || !el.firstChild) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    if (!SIZED_DISPLAYS.has(s.display)) return false;
    // The box plus what overflows it (glyphs taller than the line, a wide table...) must stay clear of the snip.
    const x = r.left + window.scrollX;
    const y = r.top + window.scrollY;
    const right = x + r.width + (s.overflowX === 'visible' ? Math.max(0, el.scrollWidth - el.clientWidth) : 0);
    const bottom = window.scrollY + inkBottom(el, s);
    if (right > doc.left - 2 && x < doc.right + 2 && bottom > doc.top - 2 && y < doc.bottom + 2) return false;
    return topSealed(el) && positionedInside(el);
  }

  /** @param {string} c a computed colour */
  function alphaOf(c) {
    if (!c || c === 'transparent') return 0;
    const m = /^rgba?\(([^)]*)\)$/.exec(c);
    if (!m) return 1;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    return parts.length >= 4 ? parseFloat(parts[3]) : 1;
  }

  /** The background the element is painted on (first non-transparent one up the tree, else the canvas colour). */
  function backgroundOf(/** @type {Element} */ el) {
    for (let e = /** @type {Element|null} */ (el); e; e = e.parentElement) {
      const c = getComputedStyle(e).backgroundColor;
      if (alphaOf(c) > 0) return c;
    }
    const scheme = getComputedStyle(document.documentElement).colorScheme || '';
    const dark = /\bdark\b/.test(scheme) && (!/\blight\b/.test(scheme) || matchMedia('(prefers-color-scheme: dark)').matches);
    return dark ? '#121212' : '#ffffff';
  }

  /**
   * The clone filter: drops the overlay, the guest's script and <head>; the root's children above the box (rootCut);
   * in-flow blocks entirely below the box (they cannot move anything above them); and the content of hollow
   * elements (canHollow). Nothing it drops changes what the box shows.
   * @param {Element} root @param {DOMRect} doc the box in document coordinates @param {Set<Node>} cut
   */
  function cloneFilter(root, doc, cut) {
    /** @type {Map<Element, boolean>} */
    const flow = new Map();
    /** @type {Map<Element, boolean>} */
    const hollow = new Map();
    return (/** @type {Node} */ node) => {
      if (cut.has(node)) return false;
      const parent = node.parentElement;
      if (parent && parent !== root) {
        let h = hollow.get(parent);
        if (h === undefined) {
          h = canHollow(parent, doc);
          hollow.set(parent, h);
        }
        if (h) return false;
      }
      if (!isElement(node)) return true;
      if (node === Overlay.host || OWN_NODES.has(node) || node === SCRIPT_EL || node.localName === 'head') return false;
      if (!parent || !(node instanceof HTMLElement)) return true;
      let f = flow.get(parent);
      if (f === undefined) {
        f = FLOW_DISPLAYS.has(getComputedStyle(parent).display);
        flow.set(parent, f);
      }
      if (!f) return true;
      const r = node.getBoundingClientRect();
      if (r.top + window.scrollY < doc.bottom + 1) return true;
      const cs = getComputedStyle(node);
      return !((cs.position === 'static' || cs.position === 'relative') && cs.float === 'none');
    };
  }

  /**
   * Image URLs the crop does not need: <img> sources used only outside the box (a blank stand-in is embedded instead
   * of fetching them). CSS images are always fetched.
   * @param {DOMRect} doc the box in document coordinates
   */
  function unneededImages(doc) {
    /** @type {Set<string>} */
    const inside = new Set();
    /** @type {Set<string>} */
    const outside = new Set();
    for (const img of document.images) {
      const url = img.currentSrc || img.src;
      if (!url || url.startsWith('data:')) continue;
      const r = img.getBoundingClientRect();
      const x = r.left + window.scrollX;
      const y = r.top + window.scrollY;
      const touches = r.width > 0 && r.height > 0 && x + r.width > doc.left && x < doc.right && y + r.height > doc.top &&
        y < doc.bottom;
      (touches ? inside : outside).add(url);
    }
    for (const url of inside) outside.delete(url);
    return outside;
  }

  /** A hidden srcdoc iframe in the overlay's shadow root, for modern-screenshot's default-style probes. */
  function makeSandbox() {
    return new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve(frame);
      };
      frame.addEventListener('load', finish, { once: true });
      frame.srcdoc = '<!DOCTYPE html><meta charset="UTF-8"><title></title><body>';
      Overlay.scratch(frame);
      setTimeout(finish, 1000);
    });
  }

  /** Loads an SVG element as an image (rejects when it cannot be decoded, e.g. a CSP without data: images). */
  function svgImage(/** @type {Element} */ svg) {
    const xml = new XMLSerializer().serializeToString(svg).replace(CONTROL_CHARS, '');
    const img = new Image();
    img.decoding = 'sync';
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
    return img.decode().then(() => img);
  }

  /** @param {number} ms */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Draws the boxed image on a canvas and encodes it (re-encoded smaller once when the data URL is too long).
   * @param {HTMLImageElement} img @param {number} bw @param {number} bh @param {number} scale @param {string} bg
   * @param {boolean} settleImages  redraw a few times (WebKit / Gecko decode embedded images lazily)
   * @param {CropInfo} info
   */
  async function encode(img, bw, bh, scale, bg, settleImages, info) {
    let s = scale;
    for (let attempt = 0; attempt < 2; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bw * s));
      canvas.height = Math.max(1, Math.round(bh * s));
      const g = canvas.getContext('2d');
      if (!g) throw new Error('no 2d context');
      const draw = () => {
        g.fillStyle = bg;
        g.fillRect(0, 0, canvas.width, canvas.height);
        g.drawImage(img, 0, 0, canvas.width, canvas.height);
      };
      draw();
      if (settleImages && attempt === 0) {
        for (let i = 0; i < 2; i++) {
          await sleep(80);
          draw();
        }
      }
      const url = canvas.toDataURL('image/png'); // throws SecurityError on a tainted canvas
      info.width = canvas.width;
      info.height = canvas.height;
      if (url.length <= MAX_CROP_CHARS) return url;
      s *= Math.sqrt(MAX_CROP_CHARS / url.length) * 0.9;
    }
    throw new Error('crop too large');
  }

  /**
   * Rasterises exactly the boxed area (see header).
   * @param {DOMRect} doc the box in document coordinates
   * @param {Element|null} container
   * @param {CropInfo} info
   */
  async function rasterise(doc, container, info) {
    const m = await loadLib();
    const { root, cut: plan } = renderPlan(container, doc);
    const skip = unneededImages(doc);
    info.root = root.localName;
    info.cut = plan ? [...plan.cut].filter(isElement).length : 0;
    const rr = root.getBoundingClientRect();
    const ox = doc.left - (rr.left + window.scrollX);
    const oy = doc.top - (rr.top + window.scrollY);
    const bw = doc.width;
    const bh = doc.height;
    const scale = Math.min(window.devicePixelRatio || 1, MAX_CROP_W / bw, MAX_CROP_H / bh);
    const bg = backgroundOf(root);
    const sandbox = /** @type {HTMLIFrameElement} */ (await makeSandbox());
    let ctx = null;
    try {
      const scroller = document.scrollingElement || document.documentElement;
      ctx = await m.createContext(root, {
        backgroundColor: bg,
        // The library drops the root's own margins (the UA default, e.g. 1em on <pre>, <p> or <figure>, would come
        // back inside the foreignObject), forces its width / height to the border-box size (which a padded
        // content-box root would grow by, re-wrapping its text) and makes it static: pin margins and sizing, and keep
        // it the containing block of its positioned descendants (positionedInside) without any offset of its own.
        style: Object.assign({ margin: '0', boxSizing: 'border-box', position: 'relative', inset: 'auto' },
          plan ? plan.style : null),
        filter: cloneFilter(root, doc, plan ? plan.cut : new Set()),
        fetchFn: (/** @type {string} */ url) => Promise.resolve(skip.has(url) ? BLANK_IMAGE : false),
        sandbox, // used instead of an iframe appended to the author's <body>
        timeout: MEDIA_TIMEOUT_MS,
        // Scrolled boxes inside the clone show what is on screen; never for the page scroller itself (the box
        // offsets already account for the page scroll).
        features: { restoreScrollPosition: !root.contains(scroller) },
      });
      const W = ctx.width;
      const H = ctx.height;
      const svg = await m.domToForeignObjectSvg(ctx);
      // Only ever edit the library's own copy (never a node of the page).
      if (svg.isConnected || svg === root) throw new Error('the screenshot library returned a live node');
      const settleImages = ctx.drawImageCount > 0; // counted by the library for Safari / Firefox only
      // Narrow the viewport to the box: only the boxed area is rasterised, at `scale`.
      svg.setAttribute('width', String(bw * scale));
      svg.setAttribute('height', String(bh * scale));
      svg.setAttribute('viewBox', `${ox} ${oy} ${bw} ${bh}`);
      const fo = [...svg.children].find((c) => c.localName === 'foreignObject');
      if (!fo) throw new Error('no foreignObject');
      fo.setAttribute('width', String(W));
      fo.setAttribute('height', String(H));
      const img = await svgImage(svg);
      return await encode(img, bw, bh, scale, bg, settleImages, info);
    } finally {
      if (ctx) {
        try {
          m.destroyContext(ctx);
        } catch { /* ignore */ }
      }
      sandbox.remove();
    }
  }

  /**
   * The crop of a box, or null (never rejects; gives up after CROP_TIMEOUT_MS). Outcome kept for debugging.
   * @param {DOMRect} doc @param {Element|null} container
   * @returns {Promise<string|null>}
   */
  function cropOf(doc, container) {
    const t0 = performance.now();
    /** @type {CropInfo} */
    const info = { ok: false, ms: 0, error: null, root: null, cut: 0, width: 0, height: 0 };
    let settled = false;
    /** @param {string|null} url @param {string|null} error */
    const settle = (url, error) => {
      if (settled) return null;
      settled = true;
      info.ok = !!url;
      info.error = error;
      info.ms = Math.round(performance.now() - t0);
      lastCrop = info;
      return url;
    };
    const work = rasterise(doc, container, info).then(
      (url) => settle(url, null),
      (err) => settle(null, String((err && err.message) || err)),
    );
    const timeout = sleep(CROP_TIMEOUT_MS).then(() => settle(null, 'timeout'));
    return Promise.race([work, timeout]);
  }

  // ---- the mode -----------------------------------------------------------------------------------------------

  function showHint() {
    if (active) Overlay.hint.show(HINT);
    else if (pending) Overlay.hint.show(CAPTURING);
    else Overlay.hint.hide();
  }

  function draw() {
    if (drag) Overlay.dragBox.show(toViewport(dragDocRect()));
    else Overlay.dragBox.hide();
    if (pending) Overlay.snipBox.show(toViewport(pending.doc));
    else Overlay.snipBox.hide();
  }

  /** Scrolls while the pointer is held near (or beyond) the top / bottom edge during a drag. */
  function autoScroll() {
    scrollRaf = 0;
    if (!drag) return;
    const vh = window.innerHeight;
    let v = 0;
    if (drag.y < EDGE_PX) v = -Math.min(MAX_AUTOSCROLL, (EDGE_PX - drag.y) / 2 + 2);
    else if (drag.y > vh - EDGE_PX) v = Math.min(MAX_AUTOSCROLL, (drag.y - (vh - EDGE_PX)) / 2 + 2);
    if (!v) return;
    const before = window.scrollY;
    window.scrollBy({ top: v, behavior: /** @type {any} */ ('instant') });
    if (window.scrollY === before) return; // at the end of the document
    draw();
    scrollRaf = requestAnimationFrame(guard(autoScroll, 'snip-autoscroll'));
  }

  /** @param {PointerEvent} ev */
  function onDown(ev) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    try {
      window.focus(); // keep Esc flowing to this document
    } catch { /* ignore */ }
    drag = { x0: ev.clientX + window.scrollX, y0: ev.clientY + window.scrollY, x: ev.clientX, y: ev.clientY,
      pointerId: ev.pointerId };
    const glass = Overlay.glass.el;
    if (glass) {
      try {
        glass.setPointerCapture(ev.pointerId);
      } catch { /* ignore */ }
    }
    draw();
  }

  /** @param {PointerEvent} ev */
  function onMove(ev) {
    if (!drag) return;
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    draw();
    if (!scrollRaf) scrollRaf = requestAnimationFrame(guard(autoScroll, 'snip-autoscroll'));
  }

  /** @param {PointerEvent} ev */
  function onUp(ev) {
    if (ev.button !== 0 || !drag) return;
    ev.preventDefault();
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    const doc = dragDocRect();
    drag = null;
    draw();
    if (doc.width < SNIP.minPx || doc.height < SNIP.minPx) return; // a click or a tiny drag: keep snipping
    finish(doc);
  }

  function onCancel() {
    drag = null;
    draw();
  }

  /** Builds the capture, leaves snip mode and posts the action once the crop is ready. @param {DOMRect} doc */
  function finish(doc) {
    const t0 = performance.now();
    const { capture, container } = buildCapture(toViewport(doc));
    lastCaptureMs = Math.round(performance.now() - t0);
    exit(true);
    const token = ++pendingSeq;
    pending = { doc, token };
    draw();
    // The hint only when the crop takes a noticeable time (no flash for the usual fast ones).
    setTimeout(guard(() => {
      if (pending && pending.token === token) showHint();
    }, 'snip-hint'), 400);
    cropOf(doc, container).then(guard((/** @type {string|null} */ crop) => {
      if (pending && pending.token === token) {
        pending = null;
        draw();
        showHint();
      }
      /** @type {Record<string, any>} */
      const msg = { action: 'comment', capture, rect: rectJSON(toViewport(doc)) };
      if (crop) msg.crop = crop;
      Channel.send(MSG.ACTION, msg);
    }, 'snip-send'));
  }

  /** Enters snip mode (false when captures are not allowed, e.g. readonly). */
  function enter() {
    if (!Main.capturesAllowed()) return false;
    Picker.exit(false);
    if (active) return true;
    active = true;
    drag = null;
    SelectionCapture.setEnabled(false);
    Overlay.toolbar.hide();
    Overlay.glass.on({ move: onMove, down: onDown, up: onUp, leave: () => {}, cancel: onCancel });
    showHint();
    draw();
    loadLib().catch(() => {}); // warm up: the module is usually loaded by the time the box is drawn
    try {
      window.focus();
    } catch { /* ignore */ }
    return true;
  }

  /** @param {boolean} notify  post toolChanged {tool:'select'} to the UI */
  function exit(notify) {
    if (!active) return;
    active = false;
    if (drag) {
      const glass = Overlay.glass.el;
      try {
        if (glass) glass.releasePointerCapture(drag.pointerId);
      } catch { /* ignore */ }
    }
    drag = null;
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    scrollRaf = 0;
    Overlay.glass.off();
    draw();
    showHint();
    if (!Picker.active) SelectionCapture.setEnabled(Main.capturesAllowed());
    if (notify) Channel.send(MSG.TOOL_CHANGED, { tool: 'select' });
  }

  /** Esc cancels snip mode (consumed: never forwarded, never seen by the page's later handlers). */
  window.addEventListener('keydown', guard((/** @type {KeyboardEvent} */ ev) => {
    if (!active || ev.defaultPrevented || ev.isComposing) return;
    if (ev.key !== 'Escape' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    exit(true);
  }, 'snip-key'), true);

  return {
    get active() {
      return active;
    },
    enter,
    exit,
    /**
     * `b` pressed in the document (85-keys.js): enters snip mode and posts toolChanged {tool:'snip'}, or cancels
     * it when it is on. False when snips are not allowed (the key is then forwarded to the UI).
     */
    keyToggle() {
      if (active) {
        exit(true);
        return true;
      }
      if (!enter()) return false;
      Channel.send(MSG.TOOL_CHANGED, { tool: 'snip' });
      return true;
    },
    /** Redraws the drag / pending boxes after scroll and resize. */
    layout() {
      if (drag || pending) draw();
    },
    /** Debug: mode state and the outcome of the last crop. */
    get state() {
      return { active, dragging: !!drag, pending: !!pending, lastCaptureMs, lastCrop };
    },
  };
})();
