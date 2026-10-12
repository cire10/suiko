// Suiko guest, part 10: the rendered-text model (TextWalk).
//
// Builds a text stream for a DOM scope that follows the shared TEXT_EXCLUDE rule (same rule as the server's text
// stream): text under script/style/noscript/template/textarea/title, class katex-mathml, [data-sr-ignore],
// [data-sr-kind=mermaid] (and unmarked pre.mermaid / div.mermaid, as the server does) and <head> is skipped.
// The stream is the concatenation of text node data in document order, plus one virtual '\n' at a block boundary
// (or <br>) when neither side already has whitespace there, so that a selection across two paragraphs reads
// "foo\nbar" rather than "foobar".
//
// Offsets ("raw offsets") are UTF-16 indices into that stream. The module converts between DOM boundary points and
// raw offsets, offers a whitespace-normalised view (runs collapsed to one space, trimmed) and a squeezed view (all
// whitespace removed) for whitespace-insensitive quote search, and scores candidate matches by prefix/suffix
// similarity (and optional proximity), mirroring the server's scoring formula.

const TextWalk = (() => {
  const EXCL_TAGS = new Set(TEXT_EXCLUDE.tags.concat(['head']));
  const BLOCKS = new Set(BLOCK_TAGS);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * @typedef {{node: Text|null, start: number, end: number}} Seg   node null = virtual separator
   * @typedef {{text: string, map: Int32Array}} View                 map[i] = raw offset of view char i
   * @typedef {{raw: string, segs: Seg[], real: number[], nodeIdx: Map<Text, number>, norm?: View, squeezed?: View}} TextIndex
   */

  /** Whether an element itself starts an excluded subtree. @param {Element} el */
  function isExcludedEl(el) {
    if (EXCL_TAGS.has(el.localName)) return true;
    for (const a of TEXT_EXCLUDE.attrs) if (el.hasAttribute(a)) return true;
    const cl = el.classList;
    if (cl) for (const c of TEXT_EXCLUDE.classes) if (cl.contains(c)) return true;
    const kind = el.getAttribute('data-sr-kind');
    if (kind) return TEXT_EXCLUDE.kinds.includes(kind);
    // Same rule as the server (render/html.js): an unmarked pre.mermaid / div.mermaid is a mermaid diagram.
    return (el.localName === 'pre' || el.localName === 'div') && !!cl && cl.contains('mermaid') &&
      TEXT_EXCLUDE.kinds.includes('mermaid');
  }

  /** Whether a node is (inside) excluded content. @param {Node|null} node */
  function isExcluded(node) {
    for (let el = node && (isElement(node) ? node : node.parentElement); el; el = el.parentElement) {
      if (isExcludedEl(el)) return true;
    }
    return false;
  }

  /** @param {Element} el */
  function isBlockEl(el) {
    return BLOCKS.has(el.localName) || (el.namespaceURI === SVG_NS && el.localName === 'text');
  }

  /** @param {Node} root */
  function makeWalker(root) {
    return document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
        const el = /** @type {Element} */ (n);
        if (isExcludedEl(el)) return NodeFilter.FILTER_REJECT;
        return el.localName === 'br' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
  }

  /** @param {number} c */
  function isWsCode(c) {
    return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
  }

  /**
   * Builds the text index of a scope.
   * - buildIndex(null): the whole document body;
   * - buildIndex(el): el's subtree;
   * - buildIndex(first, last): from the start of `first` to the end of `last` (inclusive, document order).
   * @param {Element|null} first
   * @param {Element|null} [last]
   * @returns {TextIndex}
   */
  function buildIndex(first, last) {
    const root = first || document.body || document.documentElement;
    /** @type {TextIndex} */
    const index = { raw: '', segs: [], real: [], nodeIdx: new Map() };
    if (!root || isExcluded(root)) return index;
    let lastEl = null;
    if (first && last && last !== first && !first.contains(last) &&
        (first.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      lastEl = last;
    }
    /** @type {string[]} */
    const parts = [];
    /** @type {Map<Element, Element|null>} */
    const blockCache = new Map();
    const nearestBlock = (/** @type {Node} */ n) => {
      const start = n.parentElement;
      if (!start) return null;
      if (blockCache.has(start)) return /** @type {Element|null} */ (blockCache.get(start));
      let el = start;
      while (el && !isBlockEl(el)) el = el.parentElement;
      blockCache.set(start, el);
      return el;
    };
    let len = 0;
    let lastCode = 32;
    let pendingSep = false;
    /** @type {Element|null|undefined} */
    let prevBlock;

    const walker = makeWalker(lastEl ? /** @type {Node} */ (commonAncestor(root, lastEl)) : root);
    walker.currentNode = root;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (lastEl && n !== lastEl && !lastEl.contains(n) &&
          (lastEl.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
      if (n.nodeType !== 3) { // <br>
        pendingSep = true;
        continue;
      }
      const t = /** @type {Text} */ (n);
      const data = t.data;
      if (!data) continue;
      const blk = nearestBlock(t);
      if (prevBlock !== undefined && blk !== prevBlock) pendingSep = true;
      if (pendingSep && len > 0 && !isWsCode(lastCode) && !isWsCode(data.charCodeAt(0))) {
        index.segs.push({ node: null, start: len, end: len + 1 });
        parts.push('\n');
        len += 1;
      }
      pendingSep = false;
      index.nodeIdx.set(t, index.segs.length);
      index.real.push(index.segs.length);
      index.segs.push({ node: t, start: len, end: len + data.length });
      parts.push(data);
      len += data.length;
      lastCode = data.charCodeAt(data.length - 1);
      prevBlock = blk;
    }
    index.raw = parts.join('');
    return index;
  }

  /** @param {Node} a @param {Node} b */
  function commonAncestor(a, b) {
    const r = document.createRange();
    r.setStartBefore(a);
    r.setEndAfter(b);
    return r.commonAncestorContainer;
  }

  /**
   * Converts a DOM boundary point to a raw offset of the index (clamped into the stream).
   * @param {TextIndex} index
   * @param {Node} container
   * @param {number} offset
   * @param {boolean} isEnd  end points do not swallow a virtual separator in front of the next text
   * @returns {number|null}
   */
  function pointToRaw(index, container, offset, isEnd) {
    if (container.nodeType === 3) {
      const i = index.nodeIdx.get(/** @type {Text} */ (container));
      if (i != null) {
        const s = index.segs[i];
        return s.start + clamp(offset, 0, s.end - s.start);
      }
    }
    const probe = document.createRange();
    try {
      probe.setStart(container, offset);
    } catch {
      return null;
    }
    const real = index.real;
    let lo = 0;
    let hi = real.length;
    try {
      while (lo < hi) { // first real segment whose node starts at/after the point
        const mid = (lo + hi) >> 1;
        const node = /** @type {Text} */ (index.segs[real[mid]].node);
        if (probe.comparePoint(node, 0) >= 0) hi = mid;
        else lo = mid + 1;
      }
    } catch {
      return null;
    }
    if (lo >= real.length) return index.raw.length;
    const segIdx = real[lo];
    const prev = index.segs[segIdx - 1];
    if (isEnd && prev && !prev.node) return prev.start;
    return index.segs[segIdx].start;
  }

  /**
   * Converts a raw offset back to a DOM boundary point.
   * @param {TextIndex} index
   * @param {number} off
   * @param {boolean} isEnd
   * @returns {{node: Text, offset: number}|null}
   */
  function rawToPoint(index, off, isEnd) {
    const segs = index.segs;
    if (!index.real.length) return null;
    if (!isEnd) {
      let lo = 0, hi = segs.length; // first seg with end > off
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (segs[mid].end > off) hi = mid; else lo = mid + 1;
      }
      let i = lo;
      while (i < segs.length && !segs[i].node) i++;
      if (i >= segs.length) {
        const last = segs[index.real[index.real.length - 1]];
        return { node: /** @type {Text} */ (last.node), offset: last.end - last.start };
      }
      const s = segs[i];
      return { node: /** @type {Text} */ (s.node), offset: Math.max(0, off - s.start) };
    }
    let lo = 0, hi = segs.length; // last seg with start < off  => first seg with start >= off, minus one
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].start >= off) hi = mid; else lo = mid + 1;
    }
    let i = lo - 1;
    while (i >= 0 && !segs[i].node) i--;
    if (i < 0) {
      const first = segs[index.real[0]];
      return { node: /** @type {Text} */ (first.node), offset: 0 };
    }
    const s = segs[i];
    return { node: /** @type {Text} */ (s.node), offset: Math.min(s.end - s.start, off - s.start) };
  }

  /**
   * A live Range for raw offsets [start, end) of the index, or null.
   * @param {TextIndex} index @param {number} start @param {number} end
   */
  function rangeFromRaw(index, start, end) {
    const a = rawToPoint(index, start, false);
    const b = rawToPoint(index, end, true);
    if (!a || !b) return null;
    const r = document.createRange();
    try {
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
    } catch {
      return null;
    }
    return r;
  }

  /** @param {TextIndex} index @param {Range} range @returns {{start:number,end:number}|null} */
  function rangeToRaw(index, range) {
    const start = pointToRaw(index, range.startContainer, range.startOffset, false);
    const end = pointToRaw(index, range.endContainer, range.endOffset, true);
    if (start == null || end == null) return null;
    return { start, end: Math.max(start, end) };
  }

  /** Whitespace-normalised view (runs -> ' ', trimmed). @param {TextIndex} index @returns {View} */
  function normView(index) {
    if (index.norm) return index.norm;
    const raw = index.raw;
    const map = new Int32Array(raw.length);
    const out = [];
    let n = 0;
    let inWs = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (isWsCode(c)) {
        if (!inWs && n > 0) { out.push(' '); map[n++] = i; }
        inWs = true;
      } else {
        out.push(raw[i]);
        map[n++] = i;
        inWs = false;
      }
    }
    if (n > 0 && out[n - 1] === ' ') { out.pop(); n--; }
    index.norm = { text: out.join(''), map: map.subarray(0, n) };
    return index.norm;
  }

  /** View with all whitespace removed. @param {TextIndex} index @returns {View} */
  function squeezedView(index) {
    if (index.squeezed) return index.squeezed;
    const raw = index.raw;
    const map = new Int32Array(raw.length);
    const out = [];
    let n = 0;
    for (let i = 0; i < raw.length; i++) {
      if (isWsCode(raw.charCodeAt(i))) continue;
      out.push(raw[i]);
      map[n++] = i;
    }
    index.squeezed = { text: out.join(''), map: map.subarray(0, n) };
    return index.squeezed;
  }

  /** @param {string} s */
  function squeeze(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) if (!isWsCode(s.charCodeAt(i))) out += s[i];
    return out;
  }

  /** Levenshtein distance (two-row DP). @param {string} a @param {string} b */
  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    let cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= b.length; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[b.length];
  }

  /** 1 - levenshtein/maxLen, in [0,1]; both empty -> 1, one empty -> 0. @param {string} a @param {string} b */
  function similarity(a, b) {
    if (!a.length && !b.length) return 1;
    if (!a.length || !b.length) return 0;
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  }

  /** @param {string} hay @param {string} needle @param {number} max */
  function occurrences(hay, needle, max) {
    const out = [];
    if (!needle) return out;
    for (let i = hay.indexOf(needle); i !== -1 && out.length < max; i = hay.indexOf(needle, i + 1)) out.push(i);
    return out;
  }

  /**
   * Finds the best occurrence of `quote` (whitespace-insensitive) in the index.
   * Order: whitespace-normalised exact search, then whitespace-free search. Candidates are scored with
   * (50 + 20*prefixSim + 20*suffixSim + 2*proximity) / 92; ties go to the earliest occurrence.
   * @param {TextIndex} index
   * @param {string|null|undefined} quote
   * @param {{prefix?: string, suffix?: string, hint?: number|null}} [opts]
   * @returns {{start: number, end: number, score: number}|null}  raw offsets
   */
  function findQuote(index, quote, opts = {}) {
    const q = normWs(quote || '');
    if (!q || !index.raw) return null;
    let view = normView(index);
    let needle = q;
    let hits = occurrences(view.text, needle, 2000);
    if (!hits.length) {
      view = squeezedView(index);
      needle = squeeze(q);
      hits = occurrences(view.text, needle, 2000);
    }
    if (!hits.length) return null;
    const pre = squeeze(opts.prefix || '').slice(-CONTEXT_CHARS);
    const suf = squeeze(opts.suffix || '').slice(0, CONTEXT_CHARS);
    const hint = typeof opts.hint === 'number' ? opts.hint : null;
    const total = Math.max(1, index.raw.length);
    let best = null;
    for (const i of hits) {
      const start = view.map[i];
      const end = view.map[i + needle.length - 1] + 1;
      let s = 50;
      if (pre) {
        const before = squeeze(index.raw.slice(Math.max(0, start - pre.length * 4 - 16), start)).slice(-pre.length);
        s += 20 * similarity(before, pre);
      }
      if (suf) {
        const after = squeeze(index.raw.slice(end, end + suf.length * 4 + 16)).slice(0, suf.length);
        s += 20 * similarity(after, suf);
      }
      if (hint != null) s += 2 * Math.max(0, 1 - Math.abs(start - hint) / total);
      const score = s / 92;
      if (!best || score > best.score + 1e-9) best = { start, end, score };
    }
    return best;
  }

  /**
   * Context around [start, end): whitespace collapsed, at most CONTEXT_CHARS on each side.
   * @param {TextIndex} index @param {number} start @param {number} end
   */
  function contextAround(index, start, end) {
    const span = CONTEXT_CHARS * 8;
    const before = index.raw.slice(Math.max(0, start - span), start).replace(/\s+/g, ' ');
    const after = index.raw.slice(end, end + span).replace(/\s+/g, ' ');
    return {
      prefix: before.slice(-CONTEXT_CHARS).replace(/^\s+/, ''),
      suffix: after.slice(0, CONTEXT_CHARS).replace(/\s+$/, ''),
    };
  }

  /** Normalised rendered text of an element (TEXT_EXCLUDE applied). @param {Element|null} el */
  function textOf(el) {
    return el ? normWs(buildIndex(el).raw) : '';
  }

  // Whole-document index cache, invalidated by the scheduler's MutationObserver (and by flushing it on read).
  /** @type {TextIndex|null} */
  let docCache = null;
  /** @type {() => void} */
  let beforeRead = () => {};

  return {
    isExcluded,
    isExcludedEl,
    isWsCode,
    buildIndex,
    pointToRaw,
    rawToPoint,
    rangeFromRaw,
    rangeToRaw,
    normView,
    squeezedView,
    findQuote,
    similarity,
    contextAround,
    textOf,
    /** The cached whole-document index (rebuilt after any DOM mutation). */
    docIndex() {
      beforeRead();
      if (!docCache) docCache = buildIndex(null);
      return docCache;
    },
    invalidate() {
      docCache = null;
    },
    /** @param {() => void} fn  called before reading the cache (lets the scheduler flush pending mutations) */
    setBeforeRead(fn) {
      beforeRead = fn;
    },
  };
})();
