// Anchor -> DomTarget (BUILD_AMENDMENTS 3.4, FROZEN shape) and head anchors -> the working copy for the 'live'
// view (src/core/anchor/targets.js).
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SPECREVIEW_HOME ??= mkdtempSync(path.join(tmpdir(), 'sr-home-'));

const { renderSourceSync } = await import('../../src/core/render/index.js');
const { lineHunks, offsetMapper } = await import('../../src/core/diff/index.js');
const { createAnchor, reanchor, toDomTarget, mapAnchorToWorking } = await import('../../src/core/anchor/index.js');
const { selectSrid } = await import('../fixtures/reanchor/harness.js');

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'docs');
const MD = readFileSync(path.join(DOCS, 'kitchen-sink.md'), 'utf8');
const HTML = readFileSync(path.join(DOCS, 'app-spec.html'), 'utf8');
const MD_PATH = 'docs/kitchen-sink.md';
const mdRender = renderSourceSync({ format: 'markdown', source: MD, docPath: MD_PATH });
const htmlRender = renderSourceSync({ format: 'html', source: HTML, docPath: 'docs/app-spec.html' });
const TARGET_KEYS = ['id', 'num', 'kind', 'state', 'srid', 'endSrid', 'quote', 'prefix', 'suffix', 'region', 'svg', 'cell', 'label'];

/** @param {any} capture */
const md = (capture) => createAnchor({ version: 1, capture, source: MD, render: mdRender, format: 'markdown', docPath: MD_PATH });
const refreshP = selectSrid(mdRender, { tag: 'p', text: 'Refresh tokens are rotated' });
const rotated = md({ kind: 'text', startSrid: refreshP, endSrid: refreshP, exact: 'rotated on every use', prefix: 'Refresh tokens are ', suffix: ', and the previous token is' });

test('text target: frozen shape, captured quote and context, optional severity/type', () => {
  const t = toDomTarget(rotated, mdRender, { id: 't1', num: 1, state: 'open', severity: 'major', type: 'comment' });
  assert.deepEqual(Object.keys(t).slice(0, TARGET_KEYS.length), TARGET_KEYS);
  assert.deepEqual(t, {
    id: 't1', num: 1, kind: 'text', state: 'open', srid: refreshP, endSrid: null,
    quote: 'rotated on every use', prefix: 'Refresh tokens are ', suffix: ', and the previous token is',
    region: null, svg: null, cell: null, label: 'text', severity: 'major', type: 'comment',
  });
  const plain = toDomTarget(rotated, mdRender, { id: 'd1', state: 'draft' });
  assert.equal(plain.num, null);
  assert.equal(plain.state, 'draft');
  assert.ok(!('severity' in plain) && !('type' in plain));
});

test('element, cell and section targets carry no quote; region / svg / cell (+scope) are copied', () => {
  const img = md({ kind: 'element', srid: selectSrid(mdRender, { tag: 'img' }), tag: 'img', label: '', region: { x: 0.4, y: 0.1, w: 0.22, h: 0.2 } });
  const ti = toDomTarget(img, mdRender, { id: 't2', num: 2, state: 'open' });
  assert.equal(ti.kind, 'element');
  assert.equal(ti.quote, null);
  assert.deepEqual(ti.region, { x: 0.4, y: 0.1, w: 0.22, h: 0.2 });
  assert.equal(ti.label, '<img alt="System overview"> region x40-62% y10-30%');

  const pre = selectSrid(mdRender, { tag: 'pre', kind: 'mermaid' });
  const node = md({ kind: 'element', srid: pre, tag: 'pre', label: '', svg: { nodeId: 'Gateway', label: 'API Gateway' } });
  const tn = toDomTarget(node, mdRender, { id: 't3', num: 3, state: 'open' });
  assert.equal(tn.srid, pre);
  assert.deepEqual(tn.svg, { nodeId: 'Gateway', label: 'API Gateway' });
  assert.equal(tn.quote, null);

  const table = selectSrid(htmlRender, { tag: 'table' });
  const col = createAnchor({ version: 1, source: HTML, render: htmlRender, format: 'html',
    capture: { kind: 'element', srid: table, tag: 'table', label: '', cell: { row: 1, col: 1, rowKey: 'volume_discount', colHeader: 'Applies to', text: 'carts over 10 items' }, scope: 'column' } });
  const tc = toDomTarget(col, htmlRender, { id: 't4', num: 4, state: 'open' });
  assert.equal(tc.kind, 'cell');
  assert.equal(tc.srid, table);
  assert.deepEqual(tc.cell, { tableSrid: table, row: 1, col: 1, rowKey: 'volume_discount', colHeader: 'Applies to', text: 'carts over 10 items', scope: 'column' });

  const h2 = selectSrid(mdRender, { tag: 'h2', text: '3 Tokens' });
  const sec = toDomTarget(md({ kind: 'section', headingSrid: h2 }), mdRender, { id: 'L1', num: 1, state: 'lock' });
  assert.equal(sec.kind, 'section');
  assert.equal(sec.state, 'lock');
  assert.equal(sec.srid, h2);
  assert.ok(sec.endSrid != null && sec.endSrid !== h2);
  assert.equal(sec.quote, null);

  const doc = toDomTarget(md({ kind: 'doc' }), mdRender, { id: 't9', num: 9, state: 'open' });
  assert.deepEqual([doc.kind, doc.srid, doc.endSrid, doc.quote, doc.label], ['doc', null, null, null, 'GENERAL']);
});

test('display state: changed -> outdated (unless resolved / draft / lock), orphaned -> orphaned with no srid', () => {
  const v2 = MD.replace('rotated on every use', 'rotated on each use');
  const r2 = renderSourceSync({ format: 'markdown', source: v2, docPath: MD_PATH });
  const changed = reanchor({ anchor: rotated, fromSource: MD, toSource: v2, toRender: r2, version: 2 });
  assert.equal(changed.state, 'changed');
  const t = toDomTarget(changed, r2, { id: 't1', num: 1, state: 'open' });
  assert.equal(t.state, 'outdated');
  assert.equal(t.quote, 'rotated on each use', 'the rendered text of the new slice');
  assert.equal(toDomTarget(changed, r2, { id: 't1', num: 1, state: 'resolved' }).state, 'resolved');
  assert.equal(toDomTarget(changed, r2, { id: 'L1', num: 1, state: 'lock' }).state, 'lock');

  const v3 = MD.replace('Refresh tokens are rotated on every use, and the previous token is invalidated\n', '');
  const r3 = renderSourceSync({ format: 'markdown', source: v3, docPath: MD_PATH });
  const orphan = reanchor({ anchor: rotated, fromSource: MD, toSource: v3, toRender: r3, version: 2 });
  const o = toDomTarget(orphan, r3, { id: 't1', num: 1, state: 'addressed' });
  assert.deepEqual([o.state, o.srid, o.endSrid, o.quote, o.prefix, o.suffix], ['orphaned', null, null, null, '', '']);
  assert.equal(toDomTarget(orphan, r3, { id: 'd1', num: null, state: 'draft' }).state, 'draft');
});

test('srids missing from the render are dropped (endSrid promoted when srid is gone)', () => {
  const fake = { ...rotated, srid: 99999, endSrid: refreshP };
  const t = toDomTarget(fake, mdRender, { id: 't1', num: 1, state: 'open' });
  assert.equal(t.srid, refreshP);
  assert.equal(t.endSrid, null);
  const none = toDomTarget({ ...rotated, srid: 99999, endSrid: null }, mdRender, { id: 't1', num: 1 });
  assert.equal(none.srid, null);
  assert.equal(none.state, 'open', 'state defaults to open');
});

test('mapAnchorToWorking: identical copy, lines inserted above (state kept), edits in the working copy', () => {
  assert.deepEqual(mapAnchorToWorking(rotated, MD, MD), rotated);
  const edited = { ...rotated, state: /** @type {const} */ ('edited') };

  const above = `Draft note.\n\n${MD}`;
  const liveRender = renderSourceSync({ format: 'markdown', source: above, docPath: MD_PATH });
  const hunks = lineHunks(MD, above);
  const m = mapAnchorToWorking(edited, MD, above, hunks, offsetMapper(MD, above, hunks), { render: liveRender, format: 'markdown' });
  assert.equal(m.state, 'edited', 'intact text keeps the recorded state');
  assert.equal(m.v, rotated.v, 'still the head version');
  assert.deepEqual([m.src.startLine, m.src.endLine], [53, 53]);
  assert.equal(m.src.text, 'rotated on every use');
  assert.equal(liveRender.srcmap.nodes[/** @type {number} */ (m.srid)].t, 'p', 'srids of the live render');

  const changed = MD.replace('rotated on every use', 'rotated on each use');
  const c = mapAnchorToWorking(edited, MD, changed, null, null, { render: renderSourceSync({ format: 'markdown', source: changed, docPath: MD_PATH }) });
  assert.equal(c.state, 'changed');
  assert.equal(c.src.text, 'rotated on each use');

  const doc = md({ kind: 'doc' });
  assert.deepEqual(mapAnchorToWorking(doc, MD, changed), doc);
});
