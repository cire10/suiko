// Capture -> Anchor resolution (src/core/anchor/create.js; design 7.2, BUILD_AMENDMENTS 3.3), exercised on both
// fixture documents (test/fixtures/docs/kitchen-sink.md and app-spec.html) for every capture kind.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SPECREVIEW_HOME ??= mkdtempSync(path.join(tmpdir(), 'sr-home-'));

const { renderSourceSync } = await import('../../src/core/render/index.js');
const { UsageError } = await import('../../src/core/store/errors.js');
const { createAnchor, anchorFromLines, anchorFromQuote, sectionRange } = await import('../../src/core/anchor/index.js');
const { selectSrid } = await import('../fixtures/reanchor/harness.js');

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'docs');
const MD = readFileSync(path.join(DOCS, 'kitchen-sink.md'), 'utf8');
const HTML = readFileSync(path.join(DOCS, 'app-spec.html'), 'utf8');
const mdRender = renderSourceSync({ format: 'markdown', source: MD, docPath: 'docs/kitchen-sink.md' });
const htmlRender = renderSourceSync({ format: 'html', source: HTML, docPath: 'docs/app-spec.html' });

const ANCHOR_KEYS = ['v', 'kind', 'state', 'mappedBy', 'src', 'quote', 'srid', 'endSrid', 'section', 'generated', 'element',
  'region', 'svg', 'cell', 'code', 'media'];

/** @param {any} capture */
const md = (capture) => createAnchor({ version: 1, capture, source: MD, render: mdRender, format: 'markdown', docPath: 'docs/kitchen-sink.md' });
/** @param {any} capture @param {any} [extra] */
const html = (capture, extra = {}) =>
  createAnchor({ version: 1, capture, source: HTML, render: htmlRender, format: 'html', docPath: 'docs/app-spec.html', ...extra });
/** @param {any} sel */
const mdSrid = (sel) => selectSrid(mdRender, sel);
/** @param {any} sel */
const htmlSrid = (sel) => selectSrid(htmlRender, sel);
/** @param {any} render @param {number|null} srid */
const tagOf = (render, srid) => (srid == null ? null : render.srcmap.nodes[srid].t.toLowerCase());

/** Shape + self-consistency checks every anchor must pass. @param {any} a @param {string} source */
function assertWellFormed(a, source) {
  for (const k of ANCHOR_KEYS) assert.ok(k in a, `anchor has key ${k}`);
  assert.equal(a.state, 'exact');
  assert.equal(a.src.text, source.slice(a.src.start, a.src.end));
  assert.equal(a.src.prefix, source.slice(Math.max(0, a.src.start - 32), a.src.start));
  assert.equal(a.src.suffix, source.slice(a.src.end, a.src.end + 32));
  assert.ok(a.src.startLine >= 1 && a.src.endLine >= a.src.startLine);
  assert.ok(Array.isArray(a.section));
}

test('text capture: exact quote inside its paragraph (textmap)', () => {
  const p = mdSrid({ tag: 'p', text: 'Refresh tokens are rotated' });
  const a = md({ kind: 'text', startSrid: p, endSrid: p, exact: 'rotated on every use', prefix: 'Refresh tokens are ', suffix: ', and the previous token is' });
  assertWellFormed(a, MD);
  assert.equal(a.kind, 'text');
  assert.equal(a.mappedBy, 'textmap');
  assert.equal(a.v, 1);
  assert.equal(a.src.text, 'rotated on every use');
  assert.deepEqual([a.src.startLine, a.src.endLine], [51, 51]);
  assert.deepEqual(a.quote, { exact: 'rotated on every use', prefix: 'Refresh tokens are ', suffix: ', and the previous token is' });
  assert.equal(tagOf(mdRender, a.srid), 'p');
  assert.equal(a.endSrid, null);
  assert.deepEqual(a.section, ['Token Service Implementation Spec', '3 Tokens', '3.2 Token refresh']);
  assert.equal(a.generated, false);
});

test('text capture: a quote across inline markup is narrowed onto the markup-bearing source', () => {
  const p = mdSrid({ tag: 'p', text: 'This spec describes' });
  const a = md({ kind: 'text', startSrid: p, endSrid: p, exact: 'the token service that issues', prefix: 'This spec describes ', suffix: ' and rotates' });
  assertWellFormed(a, MD);
  assert.equal(a.mappedBy, 'narrowed');
  assert.equal(a.src.text, 'the **token service** that issues');
  assert.equal(a.quote?.exact, 'the token service that issues');
});

test('text capture: the prefix/suffix pick the right one of several occurrences', () => {
  const li = mdSrid({ tag: 'li', text: 'Revoke the whole token family' });
  const a = md({ kind: 'text', startSrid: li, endSrid: li, exact: 'token', prefix: 'Revoke the whole ', suffix: ' family on reuse.' });
  assert.equal(a.src.startLine, 18);
  assert.equal(MD.slice(a.src.start - 'Revoke the whole '.length, a.src.end), 'Revoke the whole token');
});

test('text capture without srids searches the whole source', () => {
  const a = md({ kind: 'text', startSrid: null, endSrid: null, exact: 'Ship rotation behind a flag.', prefix: 'Prototype the issuer. ', suffix: '' });
  assertWellFormed(a, MD);
  assert.equal(a.mappedBy, 'textmap');
  assert.deepEqual([a.src.startLine, a.src.endLine], [24, 24]);
  assert.equal(tagOf(mdRender, a.srid), 'li');
});

test('text capture across blocks spans both elements (srid .. endSrid)', () => {
  const first = mdSrid({ tag: 'li', text: 'Prototype the issuer' });
  const last = mdSrid({ tag: 'li', text: 'Ship rotation' });
  const a = md({ kind: 'text', startSrid: first, endSrid: last, exact: 'the issuer.\nShip rotation', prefix: 'Prototype ', suffix: ' behind a flag.' });
  assertWellFormed(a, MD);
  assert.deepEqual([a.src.startLine, a.src.endLine], [23, 24]);
  assert.ok(a.src.text.startsWith('the issuer.') && a.src.text.endsWith('Ship rotation'));
  assert.ok(a.srid != null);
});

test('text capture inside a fenced code block becomes a code anchor (lines within the block, language)', () => {
  const code = mdSrid({ tag: 'code', text: 'family.revoked' });
  const a = md({ kind: 'text', startSrid: code, endSrid: code, exact: 'if (family.revoked) throw new ReuseError(family.id);', prefix: '', suffix: '' });
  assertWellFormed(a, MD);
  assert.equal(a.kind, 'code');
  assert.equal(a.mappedBy, 'textmap');
  assert.deepEqual(a.code, { fromLine: 3, toLine: 3, lang: 'ts' });
  assert.deepEqual([a.src.startLine, a.src.endLine], [61, 61]);
  const multi = md({ kind: 'text', startSrid: code, endSrid: code, exact: 'const family = await store.familyOf(token);\n  if (family.revoked)', prefix: '', suffix: '' });
  assert.equal(multi.kind, 'code');
  assert.deepEqual(multi.code, { fromLine: 2, toLine: 3, lang: 'ts' });
});

test('HTML text capture across <br/>, inline tags and an entity is narrowed', () => {
  const p = htmlSrid({ tag: 'p', text: 'The checkout service turns' });
  const a = html({ kind: 'text', startSrid: p, endSrid: p, exact: 'a paid order.\nIt owns pricing, tax & payment', prefix: 'into ', suffix: ' orchestration.' });
  assertWellFormed(a, HTML);
  assert.equal(a.mappedBy, 'narrowed');
  assert.equal(a.src.text, 'a paid <em>order</em>.<br/>It owns pricing, tax &amp; payment');
  assert.equal(tagOf(htmlRender, a.srid), 'p');
  assert.deepEqual(a.section, ['Checkout Service']);
});

test('script-generated text: a unique occurrence in the script is raw-source, generated, painted in its host', () => {
  const ul = htmlSrid({ tag: 'ul', id: 'generated' });
  const a = html({ kind: 'text', startSrid: ul, endSrid: ul, exact: 'Authorize payment', prefix: 'Validate cart Price & tax ', suffix: '' });
  assertWellFormed(a, HTML);
  assert.equal(a.mappedBy, 'raw-source');
  assert.equal(a.generated, true);
  assert.equal(a.src.text, 'Authorize payment');
  assert.equal(a.src.startLine, 96);
  assert.equal(a.srid, ul, 'the DOM target stays on the element the reviewer selected in');
  assert.equal(a.host?.tag, 'ul');
  assert.equal(a.host?.label, '<ul id="generated">');
  assert.deepEqual(a.section, ['Checkout Service', '1. Overview']);
  assert.equal(a.quote?.exact, 'Authorize payment');
});

test('script-generated text not found verbatim falls back to the host element (block)', () => {
  const ul = htmlSrid({ tag: 'ul', id: 'generated' });
  const a = html({ kind: 'text', startSrid: ul, endSrid: ul, exact: 'Validate cart\nPrice & tax', prefix: '', suffix: '' });
  assertWellFormed(a, HTML);
  assert.equal(a.mappedBy, 'block');
  assert.equal(a.generated, true);
  assert.equal(a.src.text, '<ul id="generated" aria-label="Pipeline stages"></ul>');
  assert.equal(a.srid, ul);
  assert.equal(a.quote?.exact, 'Validate cart\nPrice & tax');
});

test('element capture: image with region, fingerprint and asset hash', () => {
  const img = mdSrid({ tag: 'img' });
  const sha = 'ab'.repeat(32);
  const a = createAnchor({
    version: 2, source: MD, render: mdRender, format: 'markdown', docPath: 'docs/kitchen-sink.md',
    assets: { 'docs/img/arch.png': `sha256:${sha}` },
    capture: { kind: 'element', srid: img, tag: 'img', label: 'img', region: { x: 0.4, y: 0.1, w: 0.9, h: 0.2 } },
  });
  assertWellFormed(a, MD);
  assert.equal(a.v, 2);
  assert.equal(a.kind, 'element');
  assert.equal(a.mappedBy, 'element');
  assert.equal(a.quote, null);
  assert.equal(a.src.text, '![System overview](./img/arch.png "Architecture overview")');
  assert.deepEqual([a.src.startLine, a.src.endLine], [29, 29]);
  assert.equal(a.srid, img);
  assert.deepEqual(a.region, { x: 0.4, y: 0.1, w: 0.6, h: 0.2 }, 'region clamped to the element box');
  assert.equal(a.element?.tag, 'img');
  assert.equal(a.element?.srid, img);
  assert.deepEqual(a.element?.attrs, { src: './img/arch.png', alt: 'System overview' });
  assert.equal(a.element?.assetSha256, sha);
  assert.equal(a.element?.label, '<img alt="System overview">');
  assert.equal(a.element?.ordinal, 0);
});

test('element capture: invalid regions are dropped, authored SVG children keep their own range', () => {
  const g = htmlSrid({ tag: 'g', id: 'node-checkout' });
  const a = html({ kind: 'element', srid: g, tag: 'g', label: 'g', region: { x: 'a', y: 0, w: 1, h: 1 } });
  assertWellFormed(a, HTML);
  assert.equal(a.region, null);
  assert.deepEqual([a.src.startLine, a.src.endLine], [39, 42]);
  assert.ok(a.src.text.startsWith('<g id="node-checkout">') && a.src.text.endsWith('</g>'));
  assert.equal(a.element?.label, '<g id="node-checkout">');
  assert.equal(a.element?.ordinal, 1);
});

test('mermaid node capture narrows to the defining fence line (Markdown and HTML)', () => {
  const pre = mdSrid({ tag: 'pre', kind: 'mermaid' });
  const a = md({ kind: 'element', srid: pre, tag: 'pre', label: 'mermaid node "Auth service"', svg: { nodeId: 'Auth', label: 'Auth service' } });
  assertWellFormed(a, MD);
  assert.equal(a.kind, 'element');
  assert.equal(a.generated, true);
  assert.equal(a.src.text, '  Gateway --> Auth[Auth service]');
  assert.deepEqual(a.svg, { nodeId: 'Auth', label: 'Auth service' });
  assert.equal(a.srid, pre);

  const byLabel = md({ kind: 'element', srid: pre, tag: 'pre', label: '', svg: { nodeId: '', label: 'Token store' } });
  assert.equal(byLabel.src.startLine, 35);

  const unknown = md({ kind: 'element', srid: pre, tag: 'pre', label: '', svg: { nodeId: 'Nope', label: 'Nothing' } });
  assert.equal(unknown.src.text, MD.slice(mdRender.srcmap.nodes[pre].s, mdRender.srcmap.nodes[pre].e), 'whole fence when nothing matches');

  const hpre = htmlSrid({ tag: 'pre', kind: 'mermaid' });
  const h = html({ kind: 'element', srid: hpre, tag: 'pre', label: '', svg: { nodeId: 'Gateway', label: 'Gateway' } });
  assert.equal(h.generated, true);
  assert.deepEqual([h.src.startLine, h.src.endLine], [51, 51]);
  assert.equal(h.src.text, '  Gateway->>Checkout: POST /orders');
});

test('cell captures: cell, row and column scopes (Markdown and HTML tables)', () => {
  const td = mdSrid({ tag: 'td', text: '30 d' });
  const cell = { row: 2, col: 1, rowKey: ' refresh_token ', colHeader: 'TTL', text: '30 d' };
  const a = md({ kind: 'element', srid: td, tag: 'td', label: '', cell, scope: 'cell' });
  assertWellFormed(a, MD);
  assert.equal(a.kind, 'cell');
  assert.equal(a.scope, 'cell');
  assert.deepEqual([a.src.startLine, a.src.endLine], [46, 46]);
  assert.equal(tagOf(mdRender, a.cell?.tableSrid ?? null), 'table');
  assert.deepEqual({ ...a.cell, tableSrid: undefined }, { tableSrid: undefined, row: 2, col: 1, rowKey: 'refresh_token', colHeader: 'TTL', text: '30 d' });

  const tr = mdSrid({ tag: 'tr', text: 'refresh_token' });
  const row = md({ kind: 'element', srid: tr, tag: 'tr', label: '', cell, scope: 'row' });
  assert.equal(row.kind, 'cell');
  assert.equal(row.scope, 'row');
  assert.equal(row.src.text, '| refresh_token | 30 d | `token_store` |');

  const table = htmlSrid({ tag: 'table' });
  const col = html({ kind: 'element', srid: table, tag: 'table', label: '', cell: { row: 2, col: 1, rowKey: 'coupon', colHeader: 'Applies to', text: '' }, scope: 'column' });
  assert.equal(col.kind, 'cell');
  assert.equal(col.scope, 'column');
  assert.equal(col.cell?.tableSrid, table);
  assert.deepEqual([col.src.startLine, col.src.endLine], [59, 68]);

  const noScope = md({ kind: 'element', srid: td, tag: 'td', label: '', cell });
  assert.equal(noScope.scope, 'cell', 'a cell without scope defaults to cell');
});

test('section capture: heading to the next heading of the same or higher level', () => {
  const h2 = mdSrid({ tag: 'h2', text: '3 Tokens' });
  const a = md({ kind: 'section', headingSrid: h2 });
  assertWellFormed(a, MD);
  assert.equal(a.kind, 'section');
  assert.equal(a.srid, h2);
  assert.deepEqual([a.src.startLine, a.src.endLine], [41, 64], 'includes the ### subsection, stops before ## 4');
  assert.ok(a.src.text.startsWith('## 3 Tokens') && a.src.text.endsWith('```'));
  assert.equal(a.element?.text, '3 Tokens');
  assert.equal(a.quote, null);

  const h3 = mdSrid({ tag: 'h3', text: '1.1 Milestones' });
  const sub = md({ kind: 'section', headingSrid: h3 });
  assert.deepEqual([sub.src.startLine, sub.src.endLine], [21, 25], 'a ### section ends at the next ##');

  const last = md({ kind: 'section', headingSrid: mdSrid({ tag: 'h2', text: '4 Rollout checklist' }) });
  // RF-5: the trailing footnote definition ([^rfc], referenced from section 1) serves the whole doc
  assert.equal(last.src.endLine, 81, 'the last section runs to EOF (whitespace and trailing definitions trimmed)');
  assert.ok(last.src.text.endsWith('Last revised 2026-10-10.'));

  const hh = htmlSrid({ tag: 'h2', text: '3. Pricing rules' });
  const s = html({ kind: 'section', headingSrid: hh });
  assert.equal(s.src.startLine, 58);
  assert.equal(s.src.endLine, 70, 'a heading inside <section> ends with its container');
  assert.deepEqual(sectionRange(htmlRender, HTML, hh), { start: s.src.start, end: s.src.end });
});

test('source and doc captures', () => {
  const a = md({ kind: 'source', startLine: 51, endLine: 52 });
  assertWellFormed(a, MD);
  assert.equal(a.kind, 'source');
  assert.equal(a.mappedBy, 'lines');
  assert.ok(a.src.text.startsWith('Refresh tokens are rotated') && a.src.text.endsWith('{t_{ttl}}$.'));
  assert.ok(a.quote?.exact.startsWith('Refresh tokens are rotated on every use'));
  assert.equal(tagOf(mdRender, a.srid), 'p');

  const d = md({ kind: 'doc' });
  assertWellFormed(d, MD);
  assert.equal(d.kind, 'doc');
  assert.equal(d.mappedBy, 'block');
  assert.deepEqual([d.src.start, d.src.end], [0, 0]);
  assert.equal(d.srid, null);
  assert.deepEqual(d.section, []);
});

test('anchorFromLines clamps and orders lines, works without a render', () => {
  const a = anchorFromLines({ version: 3, startLine: 25, endLine: 23, source: MD, format: 'markdown' });
  assert.deepEqual([a.src.startLine, a.src.endLine], [23, 25]);
  assert.equal(a.srid, null);
  assert.equal(a.v, 3);
  assert.equal(a.src.text, '1. Prototype the issuer.\n2. Ship rotation behind a flag.\n3. Remove the legacy session store.');
  const clamped = anchorFromLines({ version: 1, startLine: 500, source: MD, render: mdRender, format: 'markdown' });
  assert.equal(clamped.src.startLine, 83, 'clamped to the last line (a final newline opens no line)');
  assert.throws(() => anchorFromLines({ version: 1, startLine: /** @type {any} */ ('x'), source: MD }), UsageError);
});

test('anchorFromQuote: rendered or source text, uniqueness, not found', () => {
  const a = anchorFromQuote({ version: 1, quote: 'the token service that issues', source: MD, render: mdRender, format: 'markdown' });
  assert.ok(a);
  assert.equal(a.mappedBy, 'narrowed');
  assert.equal(a.src.text, 'the **token service** that issues');
  const raw = anchorFromQuote({ version: 1, quote: 'Ship rotation behind a flag.', source: MD, render: mdRender, format: 'markdown' });
  assert.equal(raw?.src.startLine, 24);
  assert.equal(anchorFromQuote({ version: 1, quote: 'not in the document at all', source: MD, render: mdRender }), null);
  assert.equal(anchorFromQuote({ version: 1, quote: '   ', source: MD, render: mdRender }), null);
  assert.equal(anchorFromQuote({ version: 1, quote: 'token', source: MD, render: mdRender, requireUnique: true }), null);
  const code = anchorFromQuote({ version: 1, quote: 'return issuePair(family);', source: MD, render: mdRender, format: 'markdown' });
  assert.equal(code?.kind, 'code');
  assert.deepEqual(code?.code, { fromLine: 4, toLine: 4, lang: 'ts' });
});

test('invalid captures throw UsageError', () => {
  assert.throws(() => md(null), UsageError);
  assert.throws(() => md({ kind: 'bogus' }), UsageError);
  assert.throws(() => md({ kind: 'text', startSrid: null, endSrid: null, exact: '  ', prefix: '', suffix: '' }), UsageError);
  assert.throws(() => md({ kind: 'element', srid: 99999, tag: 'img', label: '' }), UsageError);
  assert.throws(() => md({ kind: 'section', headingSrid: mdSrid({ tag: 'img' }) }), UsageError);
  assert.throws(() => createAnchor({ version: -1, capture: { kind: 'doc' }, source: MD, render: mdRender }), UsageError);
  assert.throws(() => createAnchor({ version: 1, capture: { kind: 'doc' }, source: /** @type {any} */ (null), render: mdRender }), UsageError);
});

test('createAnchor is deterministic', () => {
  const p = htmlSrid({ tag: 'p', text: 'Requests arrive' });
  const cap = { kind: 'text', startSrid: p, endSrid: p, exact: 'three stages', prefix: 'processed in ', suffix: '.' };
  assert.deepEqual(html(cap), html(cap));
  assert.equal(JSON.stringify(html(cap)), JSON.stringify(html(cap)));
});
