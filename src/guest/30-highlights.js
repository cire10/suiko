// Suiko guest, part 30: text highlights.
//
// Uses the CSS Custom Highlight API: one Highlight per name registered in CSS.highlights, styled by ::highlight()
// rules in ONE constructed stylesheet appended to document.adoptedStyleSheets (re-checked on every update, in case
// page scripts replace the list). Threads are tinted by whose turn they are, in the hues of their card chips (the
// UI's colour language, 70-targets.js): sr-open with the agent (the UI's indigo accent), sr-check answered or changed
// for the reviewer to check (green), sr-declined the agent did not change it (amber), sr-answer a question for the
// reviewer (orange), sr-planned a change the agent
// will make (violet), sr-draft not sent yet (soft indigo, dotted underline), sr-lock agreed (teal), sr-outdated lost
// its place (grey, wavy underline), sr-resolved done (grey; drawn only while selected), sr-active the selected one
// (an indigo underline on top). sr-ins / sr-del are the Changes overlay's inserted / removed words. The tints are
// translucent, so they read on a light or a dark page whatever the UI's theme.
// No DOM node is added for highlights, and the rules only match the sr-* highlight names, so nothing leaks into the
// page's own styling.
// Fallback when CSS.highlights is missing: the overlay draws Range.getClientRects() boxes (layoutFallback()).

const Highlights = (() => {
  /** Names in ascending paint priority. */
  const NAMES = ['sr-outdated', 'sr-resolved', 'sr-lock', 'sr-planned', 'sr-open', 'sr-check', 'sr-declined', 'sr-answer',
    'sr-draft',
    'sr-ins', 'sr-del', 'sr-active'];
  /** The names painted by the Changes overlay (inserted text; removed text, shown in the older version); the rest are threads'. */
  const CHANGE_NAMES = ['sr-ins', 'sr-del'];

  /** Background colours (also used by the fallback rect painter). */
  const COLORS = {
    'sr-open': 'rgba(99, 102, 241, 0.2)',
    'sr-check': 'rgba(26, 127, 55, 0.17)',
    'sr-declined': 'rgba(191, 135, 0, 0.22)',
    'sr-answer': 'rgba(219, 109, 40, 0.24)',
    'sr-planned': 'rgba(130, 80, 223, 0.18)',
    'sr-resolved': 'rgba(120, 120, 132, 0.16)',
    'sr-active': 'rgba(79, 70, 229, 0.14)',
    'sr-draft': 'rgba(129, 140, 248, 0.24)',
    'sr-ins': 'rgba(46, 160, 67, 0.30)',
    'sr-del': 'rgba(207, 34, 46, 0.22)',
    'sr-lock': 'rgba(27, 124, 131, 0.14)',
    'sr-outdated': 'rgba(120, 120, 132, 0.22)',
  };

  const DECORATION = {
    'sr-active': 'underline 2px rgba(79, 70, 229, 0.9)',
    'sr-draft': 'underline dotted 1.5px rgba(99, 102, 241, 0.85)',
    'sr-ins': 'underline 1px rgba(26, 127, 55, 0.9)',
    'sr-del': 'line-through 1.5px rgba(207, 34, 46, 0.95)',
    'sr-outdated': 'underline wavy 1px rgba(110, 110, 120, 0.85)',
  };

  const supported = typeof CSS !== 'undefined' && !!(/** @type {any} */ (CSS).highlights) &&
    typeof (/** @type {any} */ (window).Highlight) === 'function';

  /** @type {CSSStyleSheet|null} */
  let sheet = null;
  /** @type {Map<string, any>} name -> Highlight */
  const objects = new Map();
  /** @type {Map<string, Range[]>} name -> ranges (source of truth for both modes) */
  const ranges = new Map();

  function cssText() {
    return NAMES.map((n) => {
      const deco = /** @type {Record<string,string>} */ (DECORATION)[n];
      return `::highlight(${n}){background-color:${/** @type {Record<string,string>} */ (COLORS)[n]};` +
        (deco ? `text-decoration:${deco};` : '') + '}';
    }).join('\n');
  }

  function ensureSheet() {
    if (!supported) return;
    try {
      if (!sheet) {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(cssText());
      }
      const list = document.adoptedStyleSheets;
      if (!list.includes(sheet)) document.adoptedStyleSheets = [...list, sheet];
    } catch (err) {
      recordGuestError('highlight-sheet', err);
    }
  }

  /** @param {string} name */
  function highlightObject(name) {
    let h = objects.get(name);
    if (!h) {
      h = new (/** @type {any} */ (window).Highlight)();
      h.priority = NAMES.indexOf(name);
      objects.set(name, h);
    }
    const registry = /** @type {any} */ (CSS).highlights;
    if (registry.get(name) !== h) registry.set(name, h);
    return h;
  }

  /**
   * Replaces the ranges of one highlight.
   * @param {string} name
   * @param {Range[]} list
   */
  function set(name, list) {
    const clean = list.filter((r) => r && !r.collapsed);
    ranges.set(name, clean);
    if (!supported) {
      Scheduler.requestLayout();
      return;
    }
    ensureSheet();
    const h = highlightObject(name);
    h.clear();
    for (const r of clean) h.add(r);
  }

  /** Draws fallback rectangles (only when the Highlight API is missing). */
  function layoutFallback() {
    if (supported || !Overlay.ready) return;
    const pool = Overlay.pool('fallback');
    pool.begin();
    let k = 0;
    for (const name of NAMES) {
      for (const r of ranges.get(name) || []) {
        for (const rect of r.getClientRects()) {
          if (rect.width < 0.5 || rect.height < 0.5) continue;
          const el = pool.el('f' + k++, 'hl');
          Overlay.place(el, rect.left, rect.top, rect.width, rect.height);
          el.style.background = /** @type {Record<string,string>} */ (COLORS)[name];
        }
      }
    }
    pool.end();
  }

  return {
    supported,
    NAMES,
    CHANGE_NAMES,
    set,
    layoutFallback,
    /** @param {string[]} names */
    clear(names = NAMES) {
      for (const n of names) set(n, []);
    },
    /** @returns {Record<string, number>} number of ranges per highlight name */
    sizes() {
      /** @type {Record<string, number>} */
      const out = {};
      for (const n of NAMES) out[n] = (ranges.get(n) || []).length;
      return out;
    },
  };
})();
