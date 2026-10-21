// Packet presentation of anchors (src/core/anchor/describe.js; design 7.5, BUILD_AMENDMENTS 4.6): working-copy
// lines, full-line src extended until unique, the 8-line shortening, the 1200-char cap, long-line windows,
// data: URI eliding, labels, orphans.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SPECREVIEW_HOME ??= mkdtempSync(path.join(tmpdir(), 'sr-home-'));

const { LIMITS } = await import('../../src/shared/protocol.js');
const { renderSourceSync } = await import('../../src/core/render/index.js');
const { lineHunks, offsetMapper } = await import('../../src/core/diff/index.js');
const { createAnchor, anchorFromLines, reanchor, describeAnchor, anchorLabel, regionLabel, elideDataUris } =
  await import('../../src/core/anchor/index.js');
const { selectSrid } = await import('../fixtures/reanchor/harness.js');

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'docs');
const MD = readFileSync(path.join(DOCS, 'kitchen-sink.md'), 'utf8');
const HTML = readFileSync(path.join(DOCS, 'app-spec.html'), 'utf8');
const MD_PATH = 'docs/kitchen-sink.md';
const mdRender = renderSourceSync({ format: 'markdown', source: MD, docPath: MD_PATH });
const htmlRender = renderSourceSync({ format: 'html', source: HTML, docPath: 'docs/app-spec.html' });

/** @param {any} capture */
const md = (capture) => createAnchor({ version: 1, capture, source: MD, render: mdRender, format: 'markdown', docPath: MD_PATH });
const refreshP = selectSrid(mdRender, { tag: 'p', text: 'Refresh tokens are rotated' });
const rotated = md({ kind: 'text', startSrid: refreshP, endSrid: refreshP, exact: 'rotated on every use', prefix: 'Refresh tokens are ', suffix: ', and the previous token is' });

test('text anchor: full source lines, unique, rendered quote in `on`', () => {
  const d = describeAnchor(rotated, { source: MD });
  assert.deepEqual(d.lines, [51, 51]);
  assert.equal(d.src, 'Refresh tokens are rotated on every use, and the previous token is invalidated');
  assert.equal(d.srcUnique, true);
  assert.equal(d.srcWindow, false);
  assert.equal(d.srcEditable, true);
  assert.equal(d.label, 'text');
  assert.equal(d.on, 'rotated on every use');
  assert.deepEqual(d.section, ['Token Service Implementation Spec', '3 Tokens', '3.2 Token refresh']);
  assert.ok(MD.includes(/** @type {string} */ (d.src)));
});

test('`on` widens a selection cut mid-word to whole words; the anchor keeps the exact quote', () => {
  const cut = md({ kind: 'text', startSrid: refreshP, endSrid: refreshP, exact: 'otated on every u', prefix: 'Refresh tokens are r', suffix: 'se, and the previous token is' });
  assert.equal(cut.quote?.exact, 'otated on every u');
  assert.equal(describeAnchor(cut, { source: MD }).on, 'rotated on every use');
});

test('`on` of a stored snip drops zero-width characters', () => {
  const snip = /** @type {any} */ ({ ...rotated, kind: 'snip', quote: null, snip: { text: 'a\u200b\u2265 b', label: 'x', region: null } });
  assert.equal(describeAnchor(snip, { source: MD }).on, 'a\u2265 b');
});

test('src is extended by whole lines until it is unique in the file', () => {
  const src = '# T\n\n- item\n- item\n- other\n\nx\n';
  const a = anchorFromLines({ version: 1, startLine: 4, endLine: 4, source: src, format: 'markdown' });
  const d = describeAnchor(a, { source: src });
  assert.deepEqual(d.lines, [4, 4], 'lines stay the anchor lines');
  assert.equal(d.src, '- item\n- other');
  assert.equal(d.srcUnique, true);
  assert.equal(src.split(/** @type {string} */ (d.src)).length, 2, 'occurs exactly once');
});

test('more than 8 lines: first 3, "...(N more lines)", last; not an Edit target', () => {
  const sec = md({ kind: 'section', headingSrid: selectSrid(mdRender, { tag: 'h2', text: '3 Tokens' }) });
  const d = describeAnchor(sec, { source: MD });
  assert.deepEqual(d.lines, [41, 64]);
  assert.equal(d.src, '## 3 Tokens\n\n| Token | TTL | Storage |\n...(20 more lines)\n```');
  assert.equal(d.srcUnique, false);
  assert.equal(d.label, '§3 Tokens');
  assert.equal(d.on, null);
});

test('lines and src come from the working copy', () => {
  const inserted = `New intro line.\n${MD}`;
  const moved = describeAnchor(rotated, { source: MD, workingSource: inserted, workingMapper: offsetMapper(MD, inserted) });
  assert.deepEqual(moved.lines, [52, 52]);
  assert.deepEqual(describeAnchor(rotated, { source: MD, workingSource: inserted }), moved, 'the mapper is computed when omitted');
  assert.equal(moved.src, 'Refresh tokens are rotated on every use, and the previous token is invalidated');

  const edited = MD.replace('Refresh tokens are rotated on every use', 'Refresh tokens are rotated whenever used');
  const d = describeAnchor(rotated, { source: MD, workingSource: edited, workingMapper: offsetMapper(MD, edited, lineHunks(MD, edited)) });
  assert.deepEqual(d.lines, [51, 51]);
  assert.equal(d.src, 'Refresh tokens are rotated whenever used, and the previous token is invalidated', 'the edited working line');
  assert.equal(d.on, 'rotated on every use', '`on` is still the reviewer\'s quote');
});

test('text gone from the working copy: no src (the line after it is not it), only where it was', () => {
  const start = MD.indexOf('Refresh tokens are rotated on every use');
  const deleted = MD.slice(0, start) + MD.slice(MD.indexOf('\n\n', start) + 2);
  const d = describeAnchor(rotated, { source: MD, workingSource: deleted, workingMapper: offsetMapper(MD, deleted, lineHunks(MD, deleted)) });
  assert.equal(d.src, null);
  assert.equal(d.gone, true);
  assert.equal(d.srcEditable, false);
  assert.deepEqual(d.lines, [51, 51]);
  assert.equal(d.on, 'rotated on every use', 'the reviewer\'s quote says what was there');
});

test('a line longer than 300 chars is printed as the shortest unique window around the anchor', () => {
  const long = `<p>${'word '.repeat(120)}needle phrase here ${'more '.repeat(100)}</p>`;
  const src = `<!doctype html><html><body>\n<h1>T</h1>\n${long}\n</body></html>\n`;
  const r = renderSourceSync({ format: 'html', source: src, docPath: 'x.html' });
  const p = selectSrid(r, { tag: 'p' });
  const a = createAnchor({ version: 1, source: src, render: r, format: 'html', capture: { kind: 'text', startSrid: p, endSrid: p, exact: 'needle phrase', prefix: 'word word ', suffix: ' here' } });
  const d = describeAnchor(a, { source: src });
  assert.deepEqual(d.lines, [3, 3]);
  assert.equal(d.srcWindow, true);
  assert.equal(d.srcUnique, true);
  assert.ok(d.src && d.src.includes('needle phrase') && d.src.length < 100);
  assert.ok(src.includes(d.src), 'a valid Edit old_string');

  const repeated = `${'x '.repeat(200)}needle ${'x '.repeat(200)}\n`;
  const b = anchorFromLines({ version: 1, startLine: 1, endLine: 1, source: repeated, format: 'markdown' });
  const at = repeated.indexOf('needle');
  const db = describeAnchor({ ...b, src: { ...b.src, start: at, end: at + 1, text: 'n' } }, { source: repeated });
  assert.equal(db.srcWindow, true);
  assert.ok(db.src && repeated.includes(db.src) && db.srcUnique);
});

test('data: URIs are elided and make src non-editable; long src is capped per thread', () => {
  const b64 = 'iVBORw0KGgo'.padEnd(700000, 'A');
  const src = `<!doctype html><html><body>\n<h1>T</h1>\n<img src="data:image/png;base64,${b64}" alt="Inline chart">\n</body></html>\n`;
  const r = renderSourceSync({ format: 'html', source: src, docPath: 'x.html' });
  const a = createAnchor({ version: 1, source: src, render: r, format: 'html', capture: { kind: 'element', srid: selectSrid(r, { tag: 'img' }), tag: 'img', label: '' } });
  const d = describeAnchor(a, { source: src });
  assert.equal(d.src, '<img src="data:image/png;base64,...(513 KB)" alt="Inline chart">');
  assert.equal(d.srcEditable, false);
  assert.equal(d.srcUnique, false);
  assert.equal(d.label, '<img alt="Inline chart">');

  const many = Array.from({ length: 6 }, (_, i) => `line ${i} ${'y'.repeat(280)}`).join('\n');
  const m = anchorFromLines({ version: 1, startLine: 1, endLine: 6, source: many, format: 'markdown' });
  const dm = describeAnchor(m, { source: many });
  assert.ok(dm.src && dm.src.length <= LIMITS.threadSrcChars);
  assert.equal(dm.srcUnique, false);
  assert.ok(dm.src?.endsWith('...(truncated)'));
});

test('elideDataUris keeps the media type and parameters and reports the size', () => {
  assert.deepEqual(elideDataUris(`url(data:image/svg+xml;utf8,${'x'.repeat(100)})`), { text: 'url(data:image/svg+xml;utf8,...(100 B))', elided: true });
  assert.deepEqual(elideDataUris(`src="data:image/gif;base64,${'A'.repeat(4096)}"`), { text: 'src="data:image/gif;base64,...(3 KB)"', elided: true });
  assert.deepEqual(elideDataUris('data:text/plain,short'), { text: 'data:text/plain,short', elided: false });
});

test('element anchors: region label, absolute asset path, absolute crops', () => {
  const img = md({ kind: 'element', srid: selectSrid(mdRender, { tag: 'img' }), tag: 'img', label: '', region: { x: 0.4, y: 0.1, w: 0.22, h: 0.2 } });
  const d = describeAnchor(img, {
    source: MD, docPath: MD_PATH, absAssetPath: (rel) => `/ws/${rel}`,
    attachments: ['attachments/a1.png'], absAttachmentPath: (rel) => `/ws/.specreview/docs/d/${rel}`,
  });
  assert.equal(d.label, '<img alt="System overview"> region x40-62% y10-30%');
  assert.deepEqual(d.lines, [29, 29]);
  assert.equal(d.src, '![System overview](./img/arch.png "Architecture overview")');
  assert.equal(d.asset, '/ws/docs/img/arch.png');
  assert.deepEqual(d.crops, ['/ws/.specreview/docs/d/attachments/a1.png']);
});

test('orphaned anchors have no lines/src but say where they were last found; doc anchors are GENERAL', () => {
  const v2 = MD.replace('Refresh tokens are rotated on every use, and the previous token is invalidated\n', '');
  const orphan = reanchor({ anchor: rotated, fromSource: MD, toSource: v2, toRender: renderSourceSync({ format: 'markdown', source: v2, docPath: MD_PATH }), version: 2 });
  assert.equal(orphan.state, 'orphaned');
  const d = describeAnchor(orphan, { source: v2 });
  assert.equal(d.lines, null);
  assert.equal(d.src, null);
  assert.equal(d.on, 'rotated on every use');
  assert.deepEqual(d.lastKnown, { v: 1, lines: [51, 51], section: ['Token Service Implementation Spec', '3 Tokens', '3.2 Token refresh'], text: 'rotated on every use' });

  const doc = describeAnchor(md({ kind: 'doc' }), { source: MD });
  assert.equal(doc.label, 'GENERAL');
  assert.equal(doc.lines, null);
  assert.equal(doc.src, null);
});

test('anchorLabel for every kind', () => {
  const code = selectSrid(mdRender, { tag: 'code', text: 'family.revoked' });
  assert.equal(anchorLabel(md({ kind: 'text', startSrid: code, endSrid: code, exact: 'return issuePair(family);', prefix: '', suffix: '' })), 'code block (ts) line 4');
  const pre = selectSrid(mdRender, { tag: 'pre', kind: 'mermaid' });
  assert.equal(anchorLabel(md({ kind: 'element', srid: pre, tag: 'pre', label: '', svg: { nodeId: 'Gateway', label: 'API Gateway' } })), 'mermaid node "API Gateway"');
  const cell = { row: 2, col: 1, rowKey: 'refresh_token', colHeader: 'TTL', text: '30 d' };
  const td = selectSrid(mdRender, { tag: 'td', text: '30 d' });
  assert.equal(anchorLabel(md({ kind: 'element', srid: td, tag: 'td', label: '', cell, scope: 'cell' })), 'table cell row "refresh_token" x col "TTL" = "30 d"');
  const tr = selectSrid(mdRender, { tag: 'tr', text: 'refresh_token' });
  assert.equal(anchorLabel(md({ kind: 'element', srid: tr, tag: 'tr', label: '', cell, scope: 'row' })), 'table row "refresh_token"');
  assert.equal(anchorLabel(md({ kind: 'source', startLine: 1, endLine: 2 })), 'source lines');
  const ul = selectSrid(htmlRender, { tag: 'ul', id: 'generated' });
  const gen = createAnchor({ version: 1, source: HTML, render: htmlRender, format: 'html', capture: { kind: 'text', startSrid: ul, endSrid: ul, exact: 'Authorize payment', prefix: '', suffix: '' } });
  assert.equal(anchorLabel(gen), 'script-rendered text inside <ul id="generated">');
  assert.equal(regionLabel({ x: 0, y: 0.5, w: 1, h: 0.25 }), 'region x0-100% y50-75%');
});
