// Suiko mermaid bootstrap (design 6.2). Classic script, loaded after the vendored mermaid.min.js at the end
// of <body> (Markdown shells, and HTML docs that contain .mermaid elements but do not load mermaid themselves).
// - initialize({ startOnLoad: false, securityLevel: 'strict', theme }) with theme from prefers-color-scheme;
// - renders every pre.mermaid / div.mermaid one by one; a diagram that fails to parse shows its error and source
//   in place instead of mermaid's error graphic;
// - marks diagrams with data-sr-kind="mermaid" (their source text is excluded from the rendered-text stream);
// - re-renders on colour-scheme changes and on window 'sr-theme' CustomEvents ({ detail: 'light'|'dark'|'system' }).
(function () {
  'use strict';
  var mermaid = window.mermaid;
  if (!mermaid || window.__srMermaidInit) return;
  window.__srMermaidInit = true;

  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var forced = null; // 'light' | 'dark' | null (follow the system)
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

  function sourceOf(el) {
    if (!sources.has(el)) sources.set(el, el.textContent || '');
    return sources.get(el);
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
