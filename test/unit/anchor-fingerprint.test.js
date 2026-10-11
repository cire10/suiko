// Element identity helpers of the anchoring engine: fingerprints and scoring (fingerprint.js, design 7.4
// "Element anchors"), mermaid node narrowing (mermaid.js, amendments 3.3) and table grids / cell lookup
// (table.js, design 7.4 "Cells"), on both fixture documents.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SPECREVIEW_HOME ??= mkdtempSync(path.join(tmpdir(), 'sr-home-'));

const { renderSourceSync } = await import('../../src/core/render/index.js');
const { lineIndex } = await import('../../src/core/text/index.js');
const {
  elementFingerprint, fingerprintScore, fingerprintOfElement, bestFingerprintMatch, anchorElement, ordinalOf,
  FINGERPRINT_ACCEPT, narrowMermaid, mermaidLabelIn, tableGrid, tableOf, findCell, cellInfoOf,
} = await import('../../src/core/anchor/index.js');
const { selectSrid } = await import('../fixtures/reanchor/harness.js');

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'docs');
const MD = readFileSync(path.join(DOCS, 'kitchen-sink.md'), 'utf8');
const HTML = readFileSync(path.join(DOCS, 'app-spec.html'), 'utf8');
const MD_PATH = 'docs/kitchen-sink.md';
const mdRender = renderSourceSync({ format: 'markdown', source: MD, docPath: MD_PATH });
const htmlRender = renderSourceSync({ format: 'html', source: HTML, docPath: 'docs/app-spec.html' });
const SHA_A = `sha256:${'a'.repeat(64)}`;
const SHA_B = `sha256:${'b'.repeat(64)}`;

test('elementFingerprint: tag, attributes, asset hash, text, section and ordinal', () => {
  const img = selectSrid(mdRender, { tag: 'img' });
  const fp = elementFingerprint(mdRender, img, { docPath: MD_PATH, assets: { 'docs/img/arch.png': SHA_A } });
  assert.deepEqual(fp, {
    tag: 'img', attrs: { src: './img/arch.png', alt: 'System overview' }, assetSha256: 'a'.repeat(64), text: '',
    section: '2 Architecture', ordinal: 0,
  });
  assert.equal(elementFingerprint(mdRender, img)?.assetSha256, null, 'no manifest: hash unknown');
  assert.equal(elementFingerprint(mdRender, img, { docPath: MD_PATH, assets: { 'docs/img/arch.png': 'live' } })?.assetSha256, null);
  assert.equal(elementFingerprint(mdRender, 99999), null);

  const g = selectSrid(htmlRender, { tag: 'g', id: 'node-payments' });
  const gf = elementFingerprint(htmlRender, g);
  assert.equal(gf?.text, 'Payments');
  assert.equal(gf?.section, '2. Request flow');
  assert.equal(gf?.ordinal, 2);
  assert.equal(ordinalOf(htmlRender, g), 2);
});

test('anchorElement / fingerprintOfElement round-trip scores like the live element against itself', () => {
  const td = selectSrid(mdRender, { tag: 'td', text: '30 d' });
  const el = anchorElement(mdRender, td, {});
  assert.equal(el.srid, td);
  assert.equal(el.tag, 'td');
  assert.equal(el.label, '<td>');
  assert.equal(el.text, '30 d');
  const stored = fingerprintOfElement(el, ['Token Service Implementation Spec', '3 Tokens']);
  const live = /** @type {any} */ (elementFingerprint(mdRender, td));
  assert.equal(fingerprintScore(stored, live), fingerprintScore(live, live));
  assert.ok(fingerprintScore(stored, live) >= FINGERPRINT_ACCEPT, 'no identity attributes: identity/attrs count as unknown (0.5)');
  assert.equal(fingerprintOfElement(null).ordinal, -1);
});

test('fingerprintScore: tags must match; identity, attributes, content and context weigh in', () => {
  const base = { tag: 'img', attrs: { src: 'a.png', alt: 'Arch' }, assetSha256: 'x', text: '', section: 'S', ordinal: 0 };
  assert.equal(fingerprintScore(base, base), 1);
  assert.equal(fingerprintScore(base, { ...base, tag: 'video' }), 0);
  const altChanged = fingerprintScore(base, { ...base, attrs: { src: 'a.png', alt: 'Architecture' } });
  assert.ok(altChanged >= FINGERPRINT_ACCEPT && altChanged < 1);
  const otherFile = fingerprintScore(base, { ...base, attrs: { src: 'b.png', alt: 'Arch' }, assetSha256: 'y' });
  assert.ok(otherFile < FINGERPRINT_ACCEPT, `a different file is a different image (${otherFile})`);
  const newBytes = fingerprintScore(base, { ...base, assetSha256: 'y' });
  assert.ok(newBytes >= FINGERPRINT_ACCEPT && newBytes < altChanged + 0.2, 'same path, new bytes: still the same element');
  const ids = { tag: 'g', attrs: { id: 'node-a' }, assetSha256: null, text: 'A', section: '', ordinal: 0 };
  assert.ok(fingerprintScore(ids, { ...ids, attrs: { id: 'node-b' } }) < fingerprintScore(ids, { ...ids, text: 'B' }));
});

test('bestFingerprintMatch finds the image after its alt text changed and a sibling was added', () => {
  const img = selectSrid(mdRender, { tag: 'img' });
  const fp = /** @type {any} */ (elementFingerprint(mdRender, img, { docPath: MD_PATH }));
  const md2 = MD.replace('![System overview](./img/arch.png "Architecture overview")', '![Other](./img/other.png)\n\n![Overview](./img/arch.png)');
  const r2 = renderSourceSync({ format: 'markdown', source: md2, docPath: MD_PATH });
  const best = bestFingerprintMatch(r2, fp, { docPath: MD_PATH });
  assert.ok(best && best.score >= FINGERPRINT_ACCEPT);
  assert.equal(r2.srcmap.nodes[best.srid].a?.src, './img/arch.png');
  assert.equal(bestFingerprintMatch(r2, { ...fp, tag: 'video' }), null);
  assert.equal(bestFingerprintMatch(r2, fp, { minScore: 1.01 }), null);
});

test('narrowMermaid: node definition line, label fallback, whole-word ids, null when nothing matches', () => {
  const pre = selectSrid(mdRender, { tag: 'pre', kind: 'mermaid' });
  const c = /** @type {any} */ (mdRender.srcmap.nodes[pre].c);
  const li = lineIndex(MD);
  const line = (/** @type {any} */ r) => (r ? [li.lineOf(r.start), li.lineOf(r.end - 1)] : null);
  assert.deepEqual(line(narrowMermaid(MD, li, c, { nodeId: 'Gateway', label: 'API Gateway' })), [33, 33], 'the defining line, not the edge line');
  assert.deepEqual(line(narrowMermaid(MD, li, c, { nodeId: 'Gateway', label: 'Renamed' })), [33, 33], 'the shape-defining line');
  assert.deepEqual(line(narrowMermaid(MD, li, c, { nodeId: '', label: 'Token store' })), [35, 35]);
  assert.equal(narrowMermaid(MD, li, c, { nodeId: 'Gate', label: '' }), null, 'ids match whole words only');
  assert.equal(narrowMermaid(MD, li, c, { nodeId: '', label: '' }), null);
  const r = /** @type {any} */ (narrowMermaid(MD, li, c, { nodeId: 'Auth', label: 'Auth service' }));
  assert.equal(MD.slice(r.start, r.end), '  Gateway --> Auth[Auth service]');
});

test('mermaidLabelIn reads node shapes and participant aliases', () => {
  assert.equal(mermaidLabelIn('  A[Hello world] --> B', 'A'), 'Hello world');
  assert.equal(mermaidLabelIn('  Auth --> Store[(Token store)]', 'Store'), 'Token store');
  assert.equal(mermaidLabelIn('  D{Decide?}', 'D'), 'Decide?');
  assert.equal(mermaidLabelIn('  E(("Circle"))', 'E'), 'Circle');
  assert.equal(mermaidLabelIn('participant G as Gateway', 'G'), 'Gateway');
  assert.equal(mermaidLabelIn('A --> B', 'A'), null);
  assert.equal(mermaidLabelIn('A[x]', ''), null);
});

test('tableGrid / cellInfoOf: rows and header keys (Markdown and HTML)', () => {
  const table = selectSrid(mdRender, { tag: 'table' });
  const grid = tableGrid(mdRender, table);
  assert.equal(grid.rows.length, 4);
  assert.equal(grid.headerRow, 0);
  assert.ok(grid.rows.every((r) => r.cells.length === 3));
  const td = selectSrid(mdRender, { tag: 'td', text: '30 d' });
  assert.equal(tableOf(mdRender, td), table);
  assert.deepEqual(cellInfoOf(mdRender, td), { tableSrid: table, row: 2, col: 1, rowKey: 'refresh_token', colHeader: 'TTL', text: '30 d' });

  const htable = selectSrid(htmlRender, { tag: 'table' });
  assert.equal(tableGrid(htmlRender, htable).rows.length, 4, 'thead rows included');
  const cell = selectSrid(htmlRender, { tag: 'td', text: 'members only' });
  assert.deepEqual(cellInfoOf(htmlRender, cell), { tableSrid: htable, row: 3, col: 1, rowKey: 'loyalty', colHeader: 'Applies to', text: 'members only' });
  assert.equal(cellInfoOf(htmlRender, selectSrid(htmlRender, { tag: 'h1' })), null);
  assert.deepEqual(tableGrid(htmlRender, 99999).rows, []);
});

test('findCell: keys first (exact, fuzzy), index fallbacks only when allowed, optional coordinates', () => {
  const table = selectSrid(mdRender, { tag: 'table' });
  const exact = findCell(mdRender, table, { row: 0, col: 0, rowKey: 'id_token', colHeader: 'Storage' });
  assert.deepEqual(exact && [exact.row, exact.col, exact.text, exact.rowBy, exact.colBy], [3, 2, 'none', 'key', 'key']);
  const fuzzy = findCell(mdRender, table, { row: 9, col: 9, rowKey: 'refresh_tokn', colHeader: 'TTL' });
  assert.deepEqual(fuzzy && [fuzzy.row, fuzzy.col, fuzzy.rowKey, fuzzy.rowBy], [2, 1, 'refresh_token', 'fuzzy']);
  assert.equal(findCell(mdRender, table, { row: 1, col: 1, rowKey: 'nothing like it', colHeader: 'TTL' }, { allowIndex: false }), null);
  const byIndex = findCell(mdRender, table, { row: 1, col: 1, rowKey: 'nothing like it', colHeader: 'TTL' });
  assert.deepEqual(byIndex && [byIndex.row, byIndex.rowBy], [1, 'index']);
  assert.equal(findCell(mdRender, table, { row: 1, col: 1, rowKey: 'refresh_tokn', colHeader: 'TTL' }, { fuzzy: false, allowIndex: false }), null);
  const emptyKey = findCell(mdRender, table, { row: 1, col: 1, rowKey: '', colHeader: 'TTL' }, { allowIndex: 'empty' });
  assert.equal(emptyKey?.rowBy, 'index');
  const column = findCell(mdRender, table, { row: 42, col: 1, rowKey: 'gone', colHeader: 'TTL' }, { allowIndex: false, rowOptional: true });
  assert.deepEqual(column && [column.row, column.col, column.colBy], [3, 1, 'key'], 'row clamped for a column anchor');
});
