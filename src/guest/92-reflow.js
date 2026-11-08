// Suiko guest, part 92: charts follow the frame when it gets narrower.
//
// The reviewer UI resizes the doc's frame without reloading it: side by side halves it, the panel can be dragged
// wider. A responsive doc re-flows by itself, except a chart drawn on a <canvas> by a library that sizes the canvas
// to its container (Chart.js and the like follow a ResizeObserver on the container): a container sized by its content
// (a grid column `1fr`, a flex item) cannot shrink below the canvas it holds, so the chart keeps its old, wider size
// and sticks out of the narrower frame (a fresh load at that width lays it out right). When the viewport gets
// narrower, every canvas that now sticks out of it gets `max-width: 100%` for a moment: its container can shrink,
// the library redraws the chart at the new width, and the canvas's own inline max-width is put back afterwards. Only
// canvases that overflow are touched, only after a narrowing, and nothing else of the page is.

const Reflow = (() => {
  /** How long the canvases keep max-width: 100% (the library resizes on its next frames). */
  const HOLD_MS = 400;
  let lastWidth = 0;
  /** @type {Array<{el: HTMLCanvasElement, value: string, priority: string}>} */
  let held = [];
  let timer = 0;

  function release() {
    timer = 0;
    for (const h of held) {
      if (h.value) h.el.style.setProperty('max-width', h.value, h.priority);
      else h.el.style.removeProperty('max-width');
      if (h.el.getAttribute('style') === '') h.el.removeAttribute('style');
    }
    held = [];
  }

  /** Lets the canvases that stick out of a viewport `width` px wide shrink with their containers. @param {number} width */
  function fit(width) {
    for (const el of document.querySelectorAll('canvas')) {
      if (held.some((h) => h.el === el)) continue;
      const r = el.getBoundingClientRect();
      if (isEmptyRect(r) || r.right <= width + 0.5) continue;
      const c = /** @type {HTMLCanvasElement} */ (el);
      held.push({ el: c, value: c.style.getPropertyValue('max-width'), priority: c.style.getPropertyPriority('max-width') });
      c.style.setProperty('max-width', '100%', 'important');
    }
    if (held.length) {
      if (timer) clearTimeout(timer);
      timer = /** @type {any} */ (setTimeout(guard(release, 'reflow-release'), HOLD_MS));
    }
  }

  function onResize() {
    const width = document.documentElement.clientWidth;
    const narrower = lastWidth > 0 && width < lastWidth - 1;
    lastWidth = width;
    if (narrower) fit(width);
  }

  return {
    start() {
      lastWidth = document.documentElement.clientWidth;
      listenOwn(window, 'resize', guard(onResize, 'reflow'), { passive: true });
    },
    /** Debug: canvases held right now. */
    get holding() {
      return held.length;
    },
  };
})();
