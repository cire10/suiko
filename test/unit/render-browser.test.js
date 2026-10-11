// Browser checks for rendered pages (system Chrome via playwright-core; skipped when Chrome is unavailable):
// - the Markdown shell loads its vendored CSS/KaTeX/mermaid and mermaid-init renders diagrams, shows errors in
//   place and re-renders on the 'sr-theme' event;
// - every srid is present exactly once in the live DOM;
// - the server-side rendered-text stream equals a guest-style DOM text walk with the shared TEXT_EXCLUDE rule,
//   for the whole document and per srid (the contract the guest relies on).
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.SPECREVIEW_HOME ??= mkdtempSync(path.join(tmpdir(), 'sr-home-'));

const { renderSource, finalizeHtml, elementText } = await import('../../src/core/render/index.js');
const { TEXT_EXCLUDE } = await import('../../src/shared/protocol.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FIXTURES = path.join(HERE, '..', 'fixtures', 'docs');
const STATIC = path.join(ROOT, 'src', 'core', 'render', 'static');
const VENDOR = {
  'github-markdown-css/': path.join(ROOT, 'node_modules', 'github-markdown-css'),
  'highlight.js/styles/': path.join(ROOT, 'node_modules', 'highlight.js', 'styles'),
  'katex/': path.join(ROOT, 'node_modules', 'katex', 'dist'),
  'mermaid/': path.join(ROOT, 'node_modules', 'mermaid', 'dist'),
};
const TYPES = { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.html': 'text/html; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };

/** @type {Map<string, string>} served pages */
const pages = new Map();
let server;
let base = '';
let browser = null;
let skipReason = '';

before(async () => {
  server = createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = null;
    if (pages.has(url)) {
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(pages.get(url));
      return;
    }
    if (url.startsWith('/__sr/static/')) file = path.join(STATIC, url.slice('/__sr/static/'.length));
    else if (url.startsWith('/__sr/vendor/')) {
      const rest = url.slice('/__sr/vendor/'.length);
      const prefix = Object.keys(VENDOR).find((p) => rest.startsWith(p));
      if (prefix) file = path.join(VENDOR[prefix], rest.slice(prefix.length));
    } else if (url.startsWith('/docs/')) file = path.join(FIXTURES, url.slice('/docs/'.length));
    if (!file || file.includes('..') || !existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch (err) {
    skipReason = `system Chrome unavailable: ${String(err?.message ?? err).split('\n')[0]}`;
  }
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

/** Guest-style text walk (TEXT_EXCLUDE) of the whole root and of every [data-srid] element. */
async function domTexts(page, rootSelector) {
  return page.evaluate(({ rootSelector, rule }) => {
    const excluded = (el) =>
      rule.tags.includes(el.localName) ||
      rule.classes.some((c) => el.classList.contains(c)) ||
      rule.attrs.some((a) => el.hasAttribute(a)) ||
      rule.kinds.includes(el.getAttribute('data-sr-kind') ?? '');
    const textOf = (node) => {
      let out = '';
      for (const c of node.childNodes) {
        if (c.nodeType === 3) out += c.data;
        else if (c.nodeType === 1 && !excluded(c)) out += textOf(c);
      }
      return out;
    };
    const root = document.querySelector(rootSelector);
    /** @type {Record<string, string[]>} */
    const bySrid = {};
    for (const el of document.querySelectorAll('[data-srid]')) {
      let hidden = false;
      for (let p = el.parentElement; p; p = p.parentElement) if (excluded(p)) hidden = true;
      (bySrid[el.getAttribute('data-srid')] ??= []).push(hidden || excluded(el) ? '' : textOf(el));
    }
    return { all: textOf(root), bySrid };
  }, { rootSelector, rule: TEXT_EXCLUDE });
}

test('Markdown shell in Chrome: vendored assets, mermaid, srids and the text stream match the DOM', async (t) => {
  if (!browser) return t.skip(skipReason);
  const source = readFileSync(path.join(FIXTURES, 'kitchen-sink.md'), 'utf8');
  const render = await renderSource({ format: 'markdown', source, docPath: 'docs/kitchen-sink.md' });
  pages.set('/docs/kitchen-sink.md', finalizeHtml(render, { assetBase: `${base}/__sr` }));
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => r.status() >= 400 && !r.url().endsWith('/favicon.ico') && errors.push(`${r.status()} ${r.url()}`));
  try {
    await page.goto(`${base}/docs/kitchen-sink.md`);
    await page.waitForSelector('pre.mermaid svg', { timeout: 20000 });
    assert.deepEqual(errors, []);
    const layout = await page.evaluate(() => {
      const a = document.querySelector('article.markdown-body');
      const img = document.querySelector('img');
      const cs = getComputedStyle(a);
      return {
        column: a.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        katex: Boolean(document.querySelector('.katex .katex-html')) && getComputedStyle(document.querySelector('.katex-mathml')).position === 'absolute',
        imgLoaded: img.complete && img.naturalWidth > 0,
        mermaidKind: document.querySelector('pre.mermaid').getAttribute('data-sr-kind'),
        mermaidLabels: [...document.querySelectorAll('pre.mermaid svg .nodeLabel')].map((n) => n.textContent.trim()),
      };
    });
    assert.equal(layout.column, 900, 'shell.css applied: 900px content column');
    assert.ok(layout.katex, 'KaTeX css applied');
    assert.ok(layout.imgLoaded, 'relative image resolved');
    assert.equal(layout.mermaidKind, 'mermaid');
    assert.ok(layout.mermaidLabels.includes('API Gateway') && layout.mermaidLabels.includes('Auth service'), JSON.stringify(layout.mermaidLabels));

    const dom = await domTexts(page, 'article.markdown-body');
    assert.equal(dom.all, `\n${render.text.text}\n`, 'whole-document text stream');
    for (const srid of render.srcmap.order) {
      assert.deepEqual(dom.bySrid[srid], [elementText(render, srid)], `srid ${srid} (${render.srcmap.nodes[srid].t})`);
    }
    assert.equal(Object.keys(dom.bySrid).length, render.srcmap.order.length);

    // forcing a theme the way the guest does (flip link[data-sr-theme] media, pin html[data-sr-theme] + the colour
    // scheme, 'sr-theme' event) recolours the whole page, the overscroll background included, and re-renders the
    // diagram
    const bg = await page.evaluate(() => {
      for (const l of document.querySelectorAll('link[data-sr-theme]')) l.media = l.dataset.srTheme === 'dark' ? 'all' : 'not all';
      document.documentElement.setAttribute('data-sr-theme', 'dark');
      document.documentElement.style.colorScheme = 'dark';
      window.dispatchEvent(new CustomEvent('sr-theme', { detail: 'dark' }));
      const a = document.querySelector('article.markdown-body');
      return {
        article: getComputedStyle(a).backgroundColor,
        html: getComputedStyle(document.documentElement).backgroundColor,
        width: a.getBoundingClientRect().width,
        vw: document.documentElement.clientWidth,
      };
    });
    assert.equal(bg.article, 'rgb(13, 17, 23)');
    assert.equal(bg.html, 'rgb(13, 17, 23)', 'html[data-sr-theme] pins the page background');
    assert.equal(bg.width, bg.vw, 'the article background spans the page');
    await page.waitForFunction(() => document.querySelector('pre.mermaid svg') && document.querySelector('pre.mermaid').getAttribute('data-processed') === 'true');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('mermaid-init shows parse errors and the diagram source in place', async (t) => {
  if (!browser) return t.skip(skipReason);
  const source = '# Broken\n\n```mermaid\nflowchart LR\n  A[Start --> \n```\n\n```mermaid\nflowchart LR\n  X --> Y\n```\n';
  const render = await renderSource({ format: 'markdown', source, docPath: 'docs/broken.md' });
  pages.set('/docs/broken.md', finalizeHtml(render, { assetBase: `${base}/__sr` }));
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/docs/broken.md`);
    await page.waitForSelector('.sr-mermaid-error', { timeout: 20000 });
    await page.waitForSelector('pre.mermaid:nth-of-type(2) svg, pre.mermaid svg', { timeout: 20000 });
    const state = await page.evaluate(() => ({
      error: document.querySelector('.sr-mermaid-error pre').textContent,
      svgs: document.querySelectorAll('pre.mermaid svg').length,
      stray: document.querySelectorAll('body > div[id^="dmermaid"]').length,
    }));
    assert.match(state.error, /A\[Start -->/);
    assert.equal(state.svgs, 1);
    assert.equal(state.stray, 0);
  } finally {
    await page.close();
  }
});

test('HTML doc in Chrome: appended mermaid renders, srids present, static text matches the stream', async (t) => {
  if (!browser) return t.skip(skipReason);
  const source = readFileSync(path.join(FIXTURES, 'app-spec.html'), 'utf8');
  const render = await renderSource({ format: 'html', source, docPath: 'docs/app-spec.html' });
  pages.set('/docs/app-spec.html', finalizeHtml(render, { assetBase: `${base}/__sr` }));
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await page.goto(`${base}/docs/app-spec.html`);
    await page.waitForSelector('pre.mermaid svg', { timeout: 20000 });
    assert.deepEqual(errors, []);
    const generated = await page.evaluate(() => document.querySelectorAll('#generated li').length);
    assert.equal(generated, 3, 'the page script ran');
    const dom = await domTexts(page, 'body');
    // elements whose subtree the page script changes (#generated and its ancestors) differ by design
    const changedByScript = new Set();
    for (const srid of render.srcmap.order) {
      const n = render.srcmap.nodes[srid];
      if (n.a?.id === 'generated') for (let s = srid; s; s = render.srcmap.nodes[s].p) changedByScript.add(s);
    }
    for (const srid of render.srcmap.order) {
      if (changedByScript.has(srid)) continue;
      assert.deepEqual(dom.bySrid[srid], [elementText(render, srid)], `srid ${srid} (${render.srcmap.nodes[srid].t})`);
    }
    assert.equal(Object.keys(dom.bySrid).length, render.srcmap.order.length);
  } finally {
    await page.close();
  }
});
