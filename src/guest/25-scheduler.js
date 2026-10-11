// SpecReview guest, part 25: layout scheduling and DOM observation.
//
// Two kinds of work:
//   - "layout" (cheap, rAF-throttled): measure resolved targets / change marks and redraw the overlay, then post
//     positions. Triggered by scroll (capture phase), resize, ResizeObserver, document.fonts.ready and load.
//   - "dom change" (expensive, debounced 100 ms with a 1 s max wait): re-resolve targets and change marks after the
//     document mutated (mermaid rendering, tabs, lazy content). Triggered by a MutationObserver on <html>.
// The whole-document text index is invalidated synchronously on every mutation that can change the text stream
// (child lists, character data, and the class / data-sr-ignore / data-sr-kind attributes), and pending mutation
// records are flushed before the index is read, so captures never use stale node offsets.
// Mutations of the guest's own overlay host are ignored, which prevents feedback loops.

/** Nodes owned by the guest (the overlay host); mutations on them are not document changes. */
const OWN_NODES = new WeakSet();

const Scheduler = (() => {
  /** @type {Array<() => void>} */
  const layoutFns = [];
  /** @type {Array<() => void>} */
  const domFns = [];
  /** @type {Array<() => void>} */
  const scrollFns = [];
  let rafId = 0;
  let started = false;
  /** @type {MutationObserver|null} */
  let mo = null;

  function runLayout() {
    rafId = 0;
    for (const fn of layoutFns) guard(fn, 'layout')();
  }

  function requestLayout() {
    if (!rafId) rafId = requestAnimationFrame(runLayout);
  }

  const domChanged = debounce(() => {
    for (const fn of domFns) guard(fn, 'domChange')();
    requestLayout();
  }, 100, 1000);

  /** @param {MutationRecord} rec */
  function isOwn(rec) {
    if (OWN_NODES.has(rec.target)) return true;
    if (rec.type !== 'childList') return false;
    const nodes = [...rec.addedNodes, ...rec.removedNodes];
    return nodes.length > 0 && nodes.every((n) => OWN_NODES.has(n));
  }

  /** Attributes whose change can alter the text stream (exclusion rule); others only affect layout. */
  const TEXT_ATTRS = new Set(['class', 'data-sr-ignore', 'data-sr-kind']);

  /** @param {MutationRecord[]} records */
  function onRecords(records) {
    let relevant = false;
    let textChanged = false;
    let ownRemoved = false;
    for (const rec of records) {
      if (isOwn(rec)) {
        if (rec.removedNodes.length) ownRemoved = true;
        continue;
      }
      relevant = true;
      if (rec.type !== 'attributes' || TEXT_ATTRS.has(/** @type {string} */ (rec.attributeName))) textChanged = true;
    }
    if (textChanged) TextWalk.invalidate();
    if (relevant) domChanged();
    if (ownRemoved) requestLayout(); // the page removed the overlay: re-attach on the next frame
  }

  function onScroll() {
    requestLayout();
    for (const fn of scrollFns) guard(fn, 'scroll')();
  }

  return {
    requestLayout,
    /** Schedules a re-resolve as if the DOM changed (debounced). */
    requestDomChange: domChanged,
    /** @param {() => void} fn */
    onLayout(fn) {
      layoutFns.push(fn);
    },
    /** @param {() => void} fn */
    onDomChange(fn) {
      domFns.push(fn);
    },
    /** @param {() => void} fn */
    onScroll(fn) {
      scrollFns.push(fn);
    },
    start() {
      if (started) return;
      started = true;
      mo = new MutationObserver(guard(onRecords, 'mutations'));
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      TextWalk.setBeforeRead(() => {
        if (!mo) return;
        const pending = mo.takeRecords();
        if (pending.length) onRecords(pending);
      });
      window.addEventListener('scroll', guard(onScroll, 'scroll'), { capture: true, passive: true });
      window.addEventListener('resize', guard(requestLayout, 'resize'), { passive: true });
      window.addEventListener('load', guard(() => {
        requestLayout();
        domChanged();
      }, 'load'));
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(guard(requestLayout, 'resizeObserver'));
        ro.observe(document.documentElement);
        if (document.body) ro.observe(document.body);
      }
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(guard(requestLayout, 'fonts'), () => {});
      }
      requestLayout();
    },
  };
})();
