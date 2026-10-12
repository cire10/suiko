// @ts-check
// `suiko snapshot <url>` conversion (cli/html-convert.js): the allowlist sanitizer against a bypass corpus
// (scripts, event handlers, javascript: URLs in their obfuscated forms, forms and formaction, meta refresh, base,
// preload links, SVG and MathML, template, iframes, objects), the Markdown output (no raw HTML node when parsed the
// way the renderer parses it; `$` escaped; structure kept), --as-html output, and fetched Markdown losing its HTML.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { CLOBBER_PREFIX, hasHtmlNode, htmlToMarkdown, safeUrl, sanitizeHtml, stripRawHtmlFromMarkdown } from '../../src/cli/html-convert.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'web');
const HOSTILE = fs.readFileSync(path.join(WEB, 'hostile.html'), 'utf8');
const BASE = 'https://docs.example.com/spec/page.html';

/** Every marker the hostile page tries to execute or load. */
const NEVER = [
  'HEAD_SCRIPT', 'BODY_ONLOAD', 'IMG_ONERROR', 'ENTITY_JS', 'PLAIN_JS', 'CASE_JS', 'SPACE_JS', 'DATA_JS', 'vbscript',
  'CLICK', 'HOVER', 'SVG_SCRIPT', 'SVG_LINK', 'ANIMATE', 'MATH', 'TEMPLATE', 'template text', 'SRCDOC', 'TOGGLE', 'BOX',
  'evil.example', 'javascript:', 'onerror', 'onclick', 'formaction', 'refresh', 'preload', 'style', 'password',
];

/** @param {string} md */
function mdTree(md) {
  return unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml', 'toml']).use(remarkMath).parse(md);
}

/** @param {string} md @returns {string[]} the URLs of links, images and definitions */
function mdUrls(md) {
  /** @type {string[]} */
  const out = [];
  visit(/** @type {any} */ (mdTree(md)), (/** @type {any} */ n) => {
    if (n.type === 'link' || n.type === 'image' || n.type === 'definition') out.push(n.url);
  });
  return out;
}

describe('htmlToMarkdown', () => {
  test('the bypass corpus leaves nothing that runs, loads or submits', () => {
    const r = htmlToMarkdown(HOSTILE, { baseUrl: BASE });
    for (const marker of NEVER) assert.equal(r.markdown.includes(marker), false, `"${marker}" in:\n${r.markdown}`);
    assert.equal(hasHtmlNode(r.markdown), false, 'no raw HTML node when the renderer parses it');
    for (const u of mdUrls(r.markdown)) assert.match(u, /^https:\/\/docs\.example\.com\//, u);
    assert.equal(r.title, 'Hostile page');
    assert.equal(r.hadScripts, true);
    assert.ok(r.removed >= 10, `removed ${r.removed}`);
  });

  test('keeps the content: headings, emphasis, absolute links and images, details, escaped text', () => {
    const r = htmlToMarkdown(HOSTILE, { baseUrl: BASE });
    assert.match(r.markdown, /^# Token service$/m);
    assert.match(r.markdown, /Refresh tokens are \*\*rotated\*\* on every use\./);
    assert.match(r.markdown, /!\[Architecture\]\(https:\/\/docs\.example\.com\/spec\/img\/arch\.png\)/);
    assert.match(r.markdown, /\[details\]\(https:\/\/docs\.example\.com\/spec\/details\.html\)/);
    assert.match(r.markdown, /entity link plain js link/, 'refused links keep their text');
    assert.match(r.markdown, /Text inside the form\./);
    assert.match(r.markdown, /\*\*More\*\*\n\nHidden part\./);
    // the page's escaped "<script>" text stays text: escaped in Markdown, never a tag
    assert.match(r.markdown, /\\<script>/);
  });

  test('main content, lists, task lists, code, tables and math-looking text', () => {
    const html = `<html><head><title>T</title></head><body><nav><a href="/">Nav link</a></nav><main>
      <h2>Prices</h2><p>It costs $5 and $10.</p>
      <ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li><li>outer<ul><li>inner</li></ul></li></ul>
      <ol start="3"><li>three</li><li>four</li></ol>
      <pre><code class="language-js">if (a < b) {\n  go();\n}\n</code></pre>
      <table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>a|b</td><td>1</td></tr><tr><td>only</td></tr></tbody></table>
      <blockquote><p>Quoted <q>words</q></p></blockquote>
    </main><footer>Footer text</footer></body></html>`;
    const { markdown } = htmlToMarkdown(html, { baseUrl: 'https://x.example/a/' });
    assert.equal(markdown.includes('Nav link'), false, 'outside <main>');
    assert.equal(markdown.includes('Footer text'), false, 'outside <main>');
    assert.match(markdown, /^## Prices$/m);
    assert.match(markdown, /It costs \\\$5 and \\\$10\./, '$ escaped, so it never renders as math');
    let math = 0;
    visit(/** @type {any} */ (mdTree(markdown)), (/** @type {any} */ n) => {
      if (n.type === 'inlineMath' || n.type === 'math') math++;
    });
    assert.equal(math, 0);
    assert.match(markdown, /^- \[x\] done$/m);
    assert.match(markdown, /^- \[ \] todo$/m);
    assert.match(markdown, /^ {2}- inner$/m);
    assert.match(markdown, /^3\. three\n4\. four$/m);
    assert.match(markdown, /```js\nif \(a < b\) \{\n {2}go\(\);\n\}\n```/);
    assert.match(markdown, /^\| Name +\| Value \|$/m);
    assert.match(markdown, /^\| a\\\|b +\| 1 +\|$/m);
    assert.match(markdown, /^> Quoted “words”$/m);
  });

  test('a page rendered by JavaScript: no text, hadScripts', () => {
    const r = htmlToMarkdown('<html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>', { baseUrl: BASE });
    assert.equal(r.markdown, '');
    assert.equal(r.textChars, 0);
    assert.equal(r.hadScripts, true);
  });
});

describe('sanitizeHtml (--as-html)', () => {
  test('keeps allowed markup, drops every active part, prefixes ids', () => {
    const r = sanitizeHtml(HOSTILE, { baseUrl: BASE });
    for (const marker of NEVER) assert.equal(r.html.includes(marker), false, `"${marker}" in:\n${r.html}`);
    assert.equal(/<(script|style|iframe|object|embed|form|svg|math|template|base|meta http-equiv|link|button|video)\b/i.test(r.html), false, r.html);
    assert.equal(/\son[a-z]+=/i.test(r.html), false, 'no event handler attribute');
    assert.match(r.html, /^<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>Hostile page<\/title>/);
    assert.match(r.html, new RegExp(`<h1 id="${CLOBBER_PREFIX}SR" name="${CLOBBER_PREFIX}guest">Token service</h1>`));
    assert.match(r.html, /<details open><summary>More<\/summary>/);
    assert.match(r.html, /<input type="checkbox" checked disabled>|<input checked type="checkbox" disabled>|<input [^>]*disabled[^>]*>/);
    assert.match(r.html, /<img alt="Architecture" src="https:\/\/docs\.example\.com\/spec\/img\/arch\.png">/);
    assert.match(r.html, /&#x3C;script>window\.ESCAPED/);
  });
});

describe('safeUrl', () => {
  test('resolves against the page, allows http(s) (and mailto for links) only', () => {
    const base = new URL(BASE);
    const href = ['http:', 'https:', 'mailto:'];
    assert.equal(safeUrl('a/b.html', href, base), 'https://docs.example.com/spec/a/b.html');
    assert.equal(safeUrl('//cdn.example.com/x.png', ['http:', 'https:'], base), 'https://cdn.example.com/x.png');
    assert.equal(safeUrl('#frag', href, base), '#frag');
    assert.equal(safeUrl('mailto:a@b.c', href, base), 'mailto:a@b.c');
    for (const bad of ['javascript:alert(1)', 'jav\tascript:alert(1)', 'java\nscript:x', ' JAVASCRIPT:x', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd']) {
      assert.equal(safeUrl(bad, href, base), undefined, JSON.stringify(bad));
    }
  });
});

describe('stripRawHtmlFromMarkdown', () => {
  test('clean Markdown is kept byte for byte', () => {
    const md = '---\ntitle: x\n---\n\n# Clean\n\n* a\n* b\n\n[ok](https://x.example) [rel](./a.md) $x$\n';
    assert.deepEqual(stripRawHtmlFromMarkdown(md), { markdown: md, removed: 0 });
  });

  test('raw HTML, script blocks and javascript: links are removed; an HTML block keeps its text', () => {
    const md = [
      '# Readme',
      '',
      '<div align="center"><b>Centered title</b><script>window.X=1</script></div>',
      '',
      'Text with <b>inline</b> tags, <img src=x onerror=alert(1)> and [a link](javascript:alert(1)).',
      '',
      '![pic](javascript:alert(2)) [ref][r] <scr<b>ipt>alert(3)</script>',
      '',
      '<script>',
      'window.BLOCK = 1',
      '</script>',
      '',
      '[r]: javascript:alert(4)',
      '',
    ].join('\n');
    const r = stripRawHtmlFromMarkdown(md, { baseUrl: 'https://raw.githubusercontent.com/o/r/main/README.md' });
    assert.equal(hasHtmlNode(r.markdown), false, r.markdown);
    for (const marker of ['javascript:', 'onerror', 'window.X', 'window.BLOCK', 'alert(1)', 'alert(2)', 'alert(4)']) assert.equal(r.markdown.includes(marker), false, `${marker} in:\n${r.markdown}`);
    // what is left of "<scr<b>ipt>" is escaped text, never a tag
    assert.equal(/(^|[^\\])<(b|script)>/.test(r.markdown), false, r.markdown);
    assert.match(r.markdown, /\\<script>alert\(3\)/);
    assert.match(r.markdown, /\*\*Centered title\*\*/);
    assert.match(r.markdown, /Text with inline tags, and a link\./);
    assert.ok(r.removed >= 6, `removed ${r.removed}`);
  });
});
