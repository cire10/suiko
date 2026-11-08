// Suiko mermaid bootstrap (design 6.2). Classic script, loaded after the vendored mermaid.min.js at the end
// of <body> (Markdown shells, and HTML docs that contain .mermaid elements but do not load mermaid themselves).
// - initialize({ startOnLoad: false, securityLevel: 'strict', theme }) with theme from prefers-color-scheme;
// - renders every pre.mermaid / div.mermaid one by one; a diagram that fails to parse shows its error and source
//   in place instead of mermaid's error graphic;
// - never touches a diagram it did not render itself: one that already holds an <svg> or carries data-processed
//   when first seen (the document's own mermaid rendered it, or is rendering it right now), and one whose source is
//   empty (a mermaid that is rendering clears the element first) are left exactly as they are, and are looked at
//   again only on a later pass (still unclaimed, with a source by then);
// - marks the diagrams it renders with data-sr-kind="mermaid" (their source text is excluded from the rendered-text
//   stream);
// - re-renders its own diagrams on colour-scheme changes and on window 'sr-theme' CustomEvents
//   ({ detail: 'light'|'dark'|'system' }).
(function () {
  'use strict';
  var mermaid = window.mermaid;
  if (!mermaid || window.__srMermaidInit) return;
  window.__srMermaidInit = true;

  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var forced = null; // 'light' | 'dark' | null (follow the system)
  // element -> its diagram source (a diagram this script renders), or null (one it must never touch)
  var sources = new WeakMap();
  var running = Promise.resolve();

  function isDark() {
    if (forced) return forced === 'dark';
    var attr = document.documentElement.getAttribute('data-sr-theme');
    if (attr === 'dark' || attr === 'light') return attr === 'dark';
    return Boolean(media && media.matches);
  }

  function nodes() {
    return Array.prototype.slice.call(document.querySelectorAll('pre.mermaid, div.mermaid'));
  }

  /**
   * The source of a diagram this script renders, or null for one it must leave alone: already rendered (an <svg>
   * inside, or data-processed) when first seen, or empty for now (not claimed: a later pass looks again).
   */
  function sourceOf(el) {
    if (sources.has(el)) return sources.get(el);
    if (el.hasAttribute('data-processed') || el.querySelector('svg')) {
      sources.set(el, null);
      return null;
    }
    var src = el.textContent || '';
    if (!src.trim()) return null;
    sources.set(el, src);
    return src;
  }

  function showError(el, src, err) {
    var box = document.createElement('div');
    box.className = 'sr-mermaid-error';
    var msg = (err && (err.message || err.str)) || String(err || 'Unknown error');
    var title = document.createElement('strong');
    title.textContent = 'Mermaid diagram error: ';
    box.appendChild(title);
    box.appendChild(document.createTextNode(msg));
    var pre = document.createElement('pre');
    pre.textContent = src;
    box.appendChild(pre);
    el.textContent = '';
    el.appendChild(box);
    el.setAttribute('data-processed', 'error');
  }

  function cleanupStray() {
    // mermaid may leave its temporary render container (<div id="dmermaid-N">) in <body> when rendering fails
    var stray = document.querySelectorAll('body > div[id^="dmermaid"]');
    for (var k = 0; k < stray.length; k++) stray[k].parentNode.removeChild(stray[k]);
  }

  function renderAll() {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDark() ? 'dark' : 'default' });
    var list = nodes();
    var chain = Promise.resolve();
    list.forEach(function (el) {
      var src = sourceOf(el);
      if (src == null) return;
      if (!el.hasAttribute('data-sr-kind')) el.setAttribute('data-sr-kind', 'mermaid');
      chain = chain.then(function () {
        el.removeAttribute('data-processed');
        el.textContent = src;
        return Promise.resolve()
          .then(function () { return mermaid.parse(src); })
          .then(function () { return mermaid.run({ nodes: [el] }); })
          .catch(function (err) {
            cleanupStray();
            showError(el, src, err);
          });
      });
    });
    return chain;
  }

  function schedule() {
    running = running.then(renderAll, renderAll);
    return running;
  }

  window.addEventListener('sr-theme', function (ev) {
    var t = ev && ev.detail;
    forced = t === 'light' || t === 'dark' ? t : null;
    schedule();
  });
  if (media) {
    var onChange = function () { if (!forced) schedule(); };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule);
  else schedule();
})();
