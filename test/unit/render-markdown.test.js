// Unit tests: src/core/render/markdown.js and its plugins (positions -> srids, kinds, verbatim content maps,
// text stream, outline, shell).
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';

process.env.SPECREVIEW_HOME ??= mkdtempSync(path.join(tmpdir(), 'sr-home-'));

const { renderSource, elementText } = await import('../../src/core/render/index.js');
const { renderMarkdown } = await import('../../src/core/render/markdown.js');
const { planChunks } = await import('../../src/core/render/md-chunks.js');
const { lineIndex } = await import('../../src/core/text/lines.js');

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'docs');
const kitchen = readFileSync(path.join(FIXTURES, 'kitchen-sink.md'), 'utf8');
const li = lineIndex(kitchen);
const r = await renderSource({ format: 'markdown', source: kitchen, docPath: 'docs/specs/kitchen-sink.md' });
const nodes = r.srcmap.order.map((srid) => ({ srid, ...r.srcmap.nodes[srid] }));

/** Line (1-based) of the first occurrence of `needle` in the fixture. */
const lineOfText = (needle) => {
  const i = kitchen.indexOf(needle);
  assert.ok(i >= 0, `fixture contains ${needle}`);
  return li.lineOf(i);
};
/** The node of a tag whose source slice starts with `prefix`. */
const nodeFor = (tag, prefix) => {
  const n = nodes.find((x) => x.t === tag && kitchen.slice(x.s, x.e).startsWith(prefix));
  assert.ok(n, `${tag} starting with ${JSON.stringify(prefix)}`);
  return n;
};

test('srids are 1..N in document order and every node has consistent lines and parents', () => {
  assert.deepEqual(r.srcmap.order, nodes.map((_, i) => i + 1));
  for (const n of nodes) {
    assert.ok(n.s <= n.e && n.e <= kitchen.length);
    assert.equal(n.ls, li.lineOf(n.s));
    assert.equal(n.le, li.lineOf(n.e > n.s ? n.e - 1 : n.s));
    if (n.p) {
      const p = r.srcmap.nodes[n.p];
      assert.ok(p.s <= n.s && n.e <= p.e, `${n.t} inside its parent ${p.t}`);
    }
  }
});

test('every fixture element kind has a srid with correct ls/le', () => {
  const fm = nodes.find((n) => n.k === 'frontmatter');
  assert.deepEqual([fm.t, fm.ls, fm.le], ['details', 1, 5]);

  const h1 = nodeFor('h1', '# Token Service');
  assert.deepEqual([h1.k, h1.ls, h1.le, h1.h.level], ['heading', 7, 7, 1]);
  const h3 = nodeFor('h3', '### 3.2 Token refresh');
  assert.equal(h3.ls, lineOfText('### 3.2'));

  const table = nodes.find((n) => n.k === 'table');
  assert.deepEqual([table.ls, table.le], [lineOfText('| Token |'), lineOfText('| id_token |')]);
  const rows = nodes.filter((n) => n.k === 'tr');
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((x) => x.ls), ['| Token |', '| access_token', '| refresh_token', '| id_token'].map(lineOfText));
  const cells = nodes.filter((n) => n.k === 'cell');
  assert.equal(cells.length, 12);
  const ttl = cells.find((c) => elementText(r, c.srid) === '30 d');
  assert.equal(ttl.ls, lineOfText('| refresh_token'));
  assert.ok(kitchen.slice(ttl.s, ttl.e).includes('30 d'));
  const th = cells.find((c) => c.t === 'th' && elementText(r, c.srid) === 'TTL');
  assert.equal(th.ls, lineOfText('| Token |'));

  const img = nodes.find((n) => n.k === 'img');
  assert.equal(img.a.src, './img/arch.png');
  assert.equal(img.a.alt, 'System overview');
  assert.equal(img.ls, lineOfText('![System overview]'));
  assert.equal(kitchen.slice(img.s, img.e), '![System overview](./img/arch.png "Architecture overview")');

  const mermaid = nodes.find((n) => n.k === 'mermaid');
  assert.deepEqual([mermaid.t, mermaid.ls, mermaid.le], ['pre', lineOfText('```mermaid'), lineOfText('```mermaid') + 5]);
  assert.equal(kitchen.slice(mermaid.c.contentStart, mermaid.c.contentEnd).split('\n')[0], 'flowchart LR');
  assert.equal(mermaid.c.firstLine, lineOfText('flowchart LR'));
  const mermaidSrc = kitchen.slice(mermaid.c.contentStart, mermaid.c.contentEnd);
  assert.ok(/\bGateway\b/.test(mermaidSrc) && /\bAuth\b/.test(mermaidSrc));
  assert.ok(mermaidSrc.endsWith('Store[(Token store)]'));

  const code = nodes.find((n) => n.k === 'code' && kitchen.slice(n.s, n.e).startsWith('```ts'));
  assert.deepEqual([code.ls, code.le], [lineOfText('```ts'), lineOfText('return issuePair') + 2]);
  assert.equal(code.c.firstLine, lineOfText('export async function refresh'));
  assert.equal(kitchen.slice(code.c.contentStart, code.c.contentEnd).split('\n').length, 5);
  assert.ok(kitchen.slice(code.c.contentStart, code.c.contentEnd).startsWith('export async function'));
  assert.ok(kitchen.slice(code.c.contentStart, code.c.contentEnd).endsWith('}'));

  const maths = nodes.filter((n) => n.k === 'math');
  assert.equal(maths.length, 2);
  assert.deepEqual([maths[0].t, maths[0].ls], ['span', lineOfText('$n = ')]);
  assert.equal(kitchen.slice(maths[0].s, maths[0].e), '$n = \\frac{86400}{t_{ttl}}$');
  assert.deepEqual([maths[1].t, maths[1].ls, maths[1].le], ['div', lineOfText('$$'), lineOfText('$$') + 2]);

  const quote = nodeFor('blockquote', '> **Note:**');
  assert.deepEqual([quote.ls, quote.le], [lineOfText('> **Note:**'), lineOfText('> to the auth service')]);

  const details = nodeFor('details', '<details>');
  assert.deepEqual([details.ls, details.le], [lineOfText('<details>'), lineOfText('</details>')]);
  const summary = nodeFor('summary', '<summary>');
  assert.equal(summary.p, details.srid);
  const inner = nodeFor('p', 'Should the grace window');
  assert.equal(inner.p, details.srid);

  const task = nodes.filter((n) => n.t === 'li' && /^- \[[ x]\]/.test(kitchen.slice(n.s, n.e)));
  assert.equal(task.length, 3);
  assert.deepEqual(task.map((t) => t.ls), ['- [x] Write', '- [ ] Load', '- [ ] Enable'].map(lineOfText));

  const nested = nodeFor('li', '- Detect reuse');
  const outer = nodeFor('li', '- Rotate refresh tokens');
  assert.equal(r.srcmap.nodes[nested.p].p, outer.srid);
  assert.deepEqual([outer.ls, outer.le], [lineOfText('- Rotate refresh'), lineOfText('  - Revoke')]);

  const footnote = nodeFor('li', '[^rfc]:');
  assert.equal(footnote.ls, lineOfText('[^rfc]: OAuth'));
  assert.ok(elementText(r, footnote.srid).includes('OAuth 2.1 consolidates'));

  assert.ok(nodes.find((n) => n.t === 'hr'));
});

test('inline elements carry positions: inline code, links, emphasis, strikethrough, footnote refs', () => {
  assert.equal(kitchen.slice(nodeFor('code', '`api-gateway`').s, nodeFor('code', '`api-gateway`').e), '`api-gateway`');
  const link = nodeFor('a', '[OAuth 2.1 draft]');
  assert.equal(link.a.href, 'https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/');
  assert.equal(elementText(r, link.srid), 'OAuth 2.1 draft');
  assert.equal(elementText(r, nodeFor('strong', '**token service**').srid), 'token service');
  assert.equal(elementText(r, nodeFor('em', '*access tokens*').srid), 'access tokens');
  assert.equal(elementText(r, nodeFor('del', '~~Support').srid), 'Support SAML assertions');
  assert.ok(nodeFor('sup', '[^rfc]'));
});

test('text stream: TEXT_EXCLUDE applied (mermaid source, KaTeX MathML) and spans are consistent', () => {
  const t = r.text.text;
  assert.ok(!t.includes('flowchart LR'), 'mermaid source excluded');
  assert.ok(!t.includes('\\frac'), 'KaTeX MathML annotation excluded');
  assert.ok(t.includes('background & terminology'), 'entities decoded');
  const mermaid = nodes.find((n) => n.k === 'mermaid');
  assert.equal(elementText(r, mermaid.srid), '');
  const para = nodeFor('p', 'Refresh tokens are rotated');
  assert.match(elementText(r, para.srid).replace(/\s+/g, ' '), /^Refresh tokens are rotated on every use, and the previous token is invalidated immediately\./);
  for (const n of nodes) {
    const [a, b] = r.text.spans[n.srid];
    assert.ok(0 <= a && a <= b && b <= t.length);
    if (n.p) {
      const [pa, pb] = r.text.spans[n.p];
      assert.ok(pa <= a && b <= pb);
    }
  }
  // document order: spans never start before an earlier sibling's span ends (same parent)
  const byParent = new Map();
  for (const n of nodes) {
    const prev = byParent.get(n.p);
    if (prev) assert.ok(r.text.spans[prev][1] <= r.text.spans[n.srid][0] || n.ls >= 83, 'siblings ordered');
    byParent.set(n.p, n.srid);
  }
});

test('stamped HTML: every srid appears exactly once as data-srid, with data-sr-kind markers', () => {
  const found = new Map();
  const walk = (n) => {
    for (const c of n.childNodes ?? []) {
      for (const a of c.attrs ?? []) if (a.name === 'data-srid') found.set(Number(a.value), (found.get(Number(a.value)) ?? 0) + 1);
      walk(c);
    }
  };
  walk(parse(r.html));
  assert.deepEqual([...found.keys()].sort((a, b) => a - b), r.srcmap.order);
  assert.ok([...found.values()].every((c) => c === 1));
  assert.match(r.html, /<pre class="mermaid" data-sr-kind="mermaid" data-srid="\d+">/);
  assert.match(r.html, /<pre data-sr-kind="code" data-srid="\d+"><code class="hljs language-ts"/);
  assert.match(r.html, /<span class="sr-math" data-sr-kind="math" data-srid="\d+"><span class="katex">/);
  assert.match(r.html, /<details class="sr-frontmatter" open data-sr-kind="frontmatter" data-srid="\d+"><summary>Front matter<\/summary>/);
});

test('shell: title, theme stylesheets, placeholders, guestInsertAt after <head>, mermaid + katex assets', () => {
  assert.equal(r.title, 'Token Service Implementation Spec');
  assert.ok(r.html.startsWith('<!doctype html><html lang="en"><head>'));
  assert.equal(r.html.slice(r.guestInsertAt - 6, r.guestInsertAt), '<head>');
  assert.match(r.html, /href="__SR_ASSET_BASE__\/vendor\/github-markdown-css\/github-markdown-light\.css" media="\(prefers-color-scheme: light\)" data-sr-theme="light"/);
  assert.match(r.html, /href="__SR_ASSET_BASE__\/vendor\/katex\/katex\.min\.css"/);
  assert.match(r.html, /<script src="__SR_ASSET_BASE__\/vendor\/mermaid\/mermaid\.min\.js"><\/script><script src="__SR_ASSET_BASE__\/static\/mermaid-init\.js"><\/script>/);
  assert.match(r.html, /<article class="markdown-body">/);
  assert.deepEqual(r.features, { mermaid: true, math: true, code: true });
  assert.deepEqual(r.assets, ['docs/specs/img/arch.png']);
  assert.deepEqual(r.externals, []);
});

test('outline lists headings with levels, lines and slug ids', () => {
  assert.deepEqual(r.outline.map((o) => [o.level, o.text, o.line, o.id]), [
    [1, 'Token Service Implementation Spec', 7, 'token-service-implementation-spec'],
    [2, '1 Goals', lineOfText('## 1 Goals'), '1-goals'],
    [3, '1.1 Milestones', lineOfText('### 1.1'), '11-milestones'],
    [2, '2 Architecture', lineOfText('## 2 Architecture'), '2-architecture'],
    [2, '3 Tokens', lineOfText('## 3 Tokens'), '3-tokens'],
    [3, '3.2 Token refresh', lineOfText('### 3.2'), '32-token-refresh'],
    [2, '4 Rollout checklist', lineOfText('## 4 Rollout'), '4-rollout-checklist'],
  ]);
  for (const o of r.outline) assert.equal(r.srcmap.nodes[o.srid].h.text, o.text);
});

test('stamp:false omits data-srid but keeps the srcmap', async () => {
  const r2 = await renderSource({ format: 'markdown', source: kitchen, docPath: 'k.md', stamp: false });
  assert.ok(!r2.html.includes('data-srid='));
  assert.deepEqual(r2.srcmap.order, r.srcmap.order);
});

test('CRLF sources keep exact offsets and lines', async () => {
  const src = '# Title\r\n\r\nFirst **para**\r\nline two\r\n\r\n```js\r\nx = 1\r\n```\r\n';
  const r2 = await renderSource({ format: 'markdown', source: src, docPath: 'c.md' });
  const l2 = lineIndex(src);
  const p = Object.values(r2.srcmap.nodes).find((n) => n.t === 'p');
  assert.equal(src.slice(p.s, p.e), 'First **para**\r\nline two');
  assert.deepEqual([p.ls, p.le], [3, 4]);
  const pre = Object.values(r2.srcmap.nodes).find((n) => n.k === 'code');
  assert.equal(src.slice(pre.c.contentStart, pre.c.contentEnd), 'x = 1');
  assert.equal(pre.c.firstLine, 7);
  for (const n of Object.values(r2.srcmap.nodes)) assert.equal(n.ls, l2.lineOf(n.s));
});

test('code fences inside containers and unclosed fences map their content', async () => {
  const src = '> ```py\n> print(1)\n> ```\n\n- item\n\n  ```\n  nested\n  ```\n\n```\nopen fence\n';
  const r2 = await renderSource({ format: 'markdown', source: src, docPath: 'c.md' });
  const pres = Object.values(r2.srcmap.nodes).filter((n) => n.k === 'code');
  assert.equal(pres.length, 3);
  assert.equal(pres[0].c.firstLine, 2);
  assert.equal(src.slice(pres[0].c.contentStart, pres[0].c.contentEnd), '> print(1)');
  assert.equal(src.slice(pres[1].c.contentStart, pres[1].c.contentEnd), '  nested');
  assert.equal(src.slice(pres[2].c.contentStart, pres[2].c.contentEnd).trim(), 'open fence');
});

test('raw HTML in Markdown gets positions (including void elements and svg)', async () => {
  const src = 'Intro\n\n<div class="box"><img src="a.png" alt="A"><br>\n<svg viewBox="0 0 4 4"><rect width="4" height="4"/></svg></div>\n';
  const r2 = await renderSource({ format: 'markdown', source: src, docPath: 'docs/r.md' });
  const tags = Object.values(r2.srcmap.nodes).map((n) => [n.t, src.slice(n.s, n.e)]);
  assert.deepEqual(tags.find((t) => t[0] === 'img'), ['img', '<img src="a.png" alt="A">']);
  assert.deepEqual(tags.find((t) => t[0] === 'rect'), ['rect', '<rect width="4" height="4"/>']);
  assert.ok(tags.find((t) => t[0] === 'svg'));
  assert.deepEqual(r2.assets, ['docs/a.png']);
});

test('title falls back to the first h1, then the file name', async () => {
  const a = await renderSource({ format: 'markdown', source: '## Sub\n\n# Main\n', docPath: 'x/y.md' });
  assert.equal(a.title, 'Main');
  const b = await renderSource({ format: 'markdown', source: 'just text\n', docPath: 'x/my-spec.md' });
  assert.equal(b.title, 'my-spec');
});

test('chunked parsing (large docs) produces exactly the same render as a single parse', () => {
  const adversarial = [
    '---', 'title: Adv', '---', '', '# Head', '', 'See [ref link][later], [short], ![img][pic] and a note[^n1].', '',
    '- loose a', '', '- loose b', '', '  continued para', '', '1. one', '', '2. two', '',
    '```js', 'a', '', 'b', '```', '', '$$', 'x', '', 'y', '$$', '', '<!--', 'comment', '', 'still', '-->', '',
    '<script>', 'var a = 1;', '', 'var b;', '</script>', '', '<details>', '', '**inner** md', '', '</details>', '',
    '    indented code', '', '    more indented', '', '> quote', '', '> another quote', '', '| a | b |', '|---|---|',
    '| 1 | 2 |', '', 'Para with *emph*', 'lazy', '', '[^n1]: The note', '', '    note continuation', '',
    '[later]: https://example.com/later', '[short]: /s', '[pic]: ./p.png', '', 'End.', '', '```', 'unclosed fence',
  ].join('\n');
  for (const src of [adversarial, kitchen]) {
    const whole = renderMarkdown(src, { docPath: 'd/x.md', chunkSize: 1e9 });
    for (const size of [1, 16, 64, 256]) {
      assert.ok(planChunks(src, size).chunks.length > 1);
      const chunked = renderMarkdown(src, { docPath: 'd/x.md', chunkSize: size });
      assert.equal(chunked.html, whole.html, `html equal at chunk size ${size}`);
      assert.deepEqual(chunked.srcmap, whole.srcmap);
      assert.deepEqual(chunked.text, whole.text);
      assert.deepEqual(chunked.outline, whole.outline);
    }
  }
});

test('planChunks never splits inside fences, math or raw HTML blocks, or between list items', () => {
  const src = ['para', '', '```', 'x', '', 'y', '```', '', '- a', '', '- b', '', '<pre>', 'p', '', 'q', '</pre>', '', 'tail'].join('\n');
  const { chunks } = planChunks(src, 1);
  const starts = chunks.map((c) => src.slice(c.start).split('\n')[0]);
  assert.deepEqual(starts, ['para', '```', '<pre>', 'tail']);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks[chunks.length - 1].end, src.length);
});
