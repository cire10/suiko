// @ts-check
// Snip anchors (key `b`: a box over any area of the doc; SnipCapture in src/shared/protocol.js, src/core/anchor/
// snip.js): creation (whole lines of the covered blocks, container + region, container-only, nothing stamped ->
// GENERAL, invalid srids), labels / describe / DomTargets, and re-anchoring (an edit above, edits inside, a lost
// container, an orphan, the live working copy, no render). Pure: no store, no ports.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SPECREVIEW_HOME ??= mkdtempSync(path.join(tmpdir(), 'sr-home-'));

const { renderSourceSync } = await import('../../src/core/render/index.js');
const { lineHunks, offsetMapper } = await import('../../src/core/diff/index.js');
const anchors = await import('../../src/core/anchor/index.js');
const { SNIP } = await import('../../src/shared/protocol.js');
const { selectSrid } = await import('../fixtures/reanchor/harness.js');

const { createAnchor, reanchor, toDomTarget, describeAnchor, anchorLabel, mapAnchorToWorking, attachmentKindOf } = anchors;

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'docs');
const MD = readFileSync(path.join(DOCS, 'kitchen-sink.md'), 'utf8');
const HTML = readFileSync(path.join(DOCS, 'app-spec.html'), 'utf8');

/** @param {'markdown' | 'html'} format @param {string} source */
function render(format, source) {
  return renderSourceSync({ format, source, docPath: format === 'html' ? 'docs/app-spec.html' : 'docs/kitchen-sink.md' });
}

/**
 * Anchor on v1 + re-anchor to `next` (one step, like the engine).
 * @param {'markdown' | 'html'} format @param {string} from @param {string} to @param {any} anchor
 * @param {{ link?: any }} [o]
 */
function step(format, from, to, anchor, o = {}) {
  const hunks = lineHunks(from, to);
  const toRender = render(format, to);
  const a = reanchor({
    anchor, originalAnchor: anchor, fromSource: from, toSource: to, hunks, mapper: offsetMapper(from, to, hunks), toRender, format,
    link: o.link ?? null, version: anchor.v + 1, docPath: format === 'html' ? 'docs/app-spec.html' : 'docs/kitchen-sink.md',
  });
  return { a, toRender };
}

/** @param {string} source @param {string} find @param {string} replace */
function edit(source, find, replace) {
  assert.equal(source.split(find).length, 2, `edit: ${find} must occur once`);
  return source.replace(find, replace);
}

const md = render('markdown', MD);
const IMG = selectSrid(md, { tag: 'img' });
const MERMAID = selectSrid(md, { tag: 'pre', kind: 'mermaid' });
const NOTE = selectSrid(md, { tag: 'p', text: 'the gateway never stores tokens' });
const MULTI = { kind: 'snip', srids: [IMG, MERMAID, NOTE], startSrid: IMG, endSrid: NOTE, containerSrid: null, region: { x: 0, y: 0.1, w: 1, h: 0.8 },
  text: 'System overview   Note: the gateway\nnever stores tokens', label: 'area over "2 Architecture" (image + diagram + note)' };
const IN_DIAGRAM = { kind: 'snip', srids: [MERMAID], startSrid: MERMAID, endSrid: MERMAID, containerSrid: MERMAID, region: { x: 0.25, y: 0.1, w: 0.5, h: 0.6 },
  text: 'API Gateway', label: 'area over the diagram' };

describe('creating snip anchors', () => {
  test('a box over an image, a diagram and a note: whole source lines of the covered blocks', () => {
    const a = /** @type {any} */ (createAnchor({ version: 1, capture: MULTI, source: MD, render: md, format: 'markdown' }));
    assert.equal(a.kind, 'snip');
    assert.equal(a.state, 'exact');
    assert.equal(a.mappedBy, 'element');
    assert.deepEqual([a.src.startLine, a.src.endLine], [29, 39]);
    assert.ok(a.src.text.startsWith('![System overview]') && a.src.text.endsWith('to the auth service for validation.'));
    assert.equal(a.quote, null);
    assert.equal(a.region, null, 'no container: the box is not drawn');
    assert.equal(a.srid, IMG);
    assert.equal(a.endSrid, NOTE);
    assert.deepEqual(a.section, ['Token Service Implementation Spec', '2 Architecture']);
    assert.deepEqual(a.snip, {
      label: 'area over "2 Architecture" (image + diagram + note)',
      covers: 'image + diagram + quote',
      text: 'System overview Note: the gateway never stores tokens',
      region: { x: 0, y: 0.1, w: 1, h: 0.8 },
      container: null,
    });
    assert.equal(anchorLabel(a), 'snip (image + diagram + quote)');
  });

  test('a box inside one element: the container and the region (painted as an element target)', () => {
    const a = /** @type {any} */ (createAnchor({ version: 1, capture: IN_DIAGRAM, source: MD, render: md, format: 'markdown' }));
    assert.deepEqual([a.src.startLine, a.src.endLine], [31, 36]);
    assert.deepEqual(a.region, { x: 0.25, y: 0.1, w: 0.5, h: 0.6 });
    const n = md.srcmap.nodes[MERMAID];
    assert.deepEqual(a.snip.container, { srid: MERMAID, tag: 'pre', s: n.s, e: n.e, label: 'mermaid diagram' });
    const dt = toDomTarget(a, md, { id: 'd1', num: 1, state: 'draft' });
    assert.deepEqual(
      { kind: dt.kind, srid: dt.srid, endSrid: dt.endSrid, region: dt.region, quote: dt.quote, label: dt.label, state: dt.state },
      { kind: 'element', srid: MERMAID, endSrid: null, region: { x: 0.25, y: 0.1, w: 0.5, h: 0.6 }, quote: null, label: 'snip (diagram)', state: 'draft' },
    );
  });

  test('without a container the covered blocks are outlined (source target, no quote)', () => {
    const a = createAnchor({ version: 1, capture: MULTI, source: MD, render: md, format: 'markdown' });
    const dt = toDomTarget(a, md, { id: 't1', num: 1, state: 'open' });
    assert.deepEqual({ kind: dt.kind, srid: dt.srid, endSrid: dt.endSrid, quote: dt.quote, region: dt.region }, { kind: 'source', srid: IMG, endSrid: NOTE, quote: null, region: null });
  });

  test('a box over no stamped block but inside an element: that element\'s lines (mappedBy block)', () => {
    const a = /** @type {any} */ (createAnchor({ version: 1, capture: { kind: 'snip', srids: [], containerSrid: IMG, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, text: '', label: '' }, source: MD, render: md, format: 'markdown' }));
    assert.equal(a.kind, 'snip');
    assert.equal(a.mappedBy, 'block');
    assert.deepEqual([a.src.startLine, a.src.endLine], [29, 29]);
    assert.equal(a.snip.covers, 'image');
    assert.equal(a.snip.container.tag, 'img');
  });

  test('a box over nothing stamped: a GENERAL anchor that keeps the snip (label GENERAL, attachments are a snip)', () => {
    const a = /** @type {any} */ (createAnchor({ version: 1, capture: { kind: 'snip', srids: [], containerSrid: null, region: { x: 0, y: 0, w: 1, h: 0.1 }, text: 'Footnotes', label: 'area' }, source: MD, render: md, format: 'markdown' }));
    assert.equal(a.kind, 'doc');
    assert.equal(a.snip.text, 'Footnotes');
    assert.equal(anchorLabel(a), 'GENERAL');
    assert.equal(toDomTarget(a, md, { id: 'd1' }).kind, 'doc');
    assert.equal(attachmentKindOf(a), 'snip');
    const d = describeAnchor(a, { source: MD, attachments: ['attachments/a1.png'], absAttachmentPath: (r) => `/abs/${r}` });
    assert.equal(d.lines, null);
    assert.deepEqual(d.crops, ['/abs/attachments/a1.png']);
    assert.equal(d.cropKind, 'snip');
    assert.equal(d.on, 'Footnotes');
  });

  test('invalid / unknown srids are ignored, text is capped, the region is clamped', () => {
    const a = /** @type {any} */ (createAnchor({
      version: 1,
      capture: { kind: 'snip', srids: ['x', 99999, null, MERMAID, MERMAID], startSrid: 'nope', endSrid: 99999, containerSrid: 424242,
        region: { x: -1, y: 0.5, w: 4, h: 'a' }, text: 'w '.repeat(SNIP.maxText), label: 'L'.repeat(500) },
      source: MD, render: md, format: 'markdown',
    }));
    assert.deepEqual([a.src.startLine, a.src.endLine], [31, 36]);
    assert.equal(a.snip.container, null);
    assert.equal(a.snip.region, null, 'a region with a non-numeric side is dropped');
    assert.ok(a.snip.text.length <= SNIP.maxText);
    assert.ok(a.snip.label.length <= 160);
  });
});

describe('describing snips', () => {
  test('lines, exact src> lines, label, on (visible text), cropKind snip', () => {
    const a = createAnchor({ version: 1, capture: MULTI, source: MD, render: md, format: 'markdown' });
    const d = describeAnchor(a, { source: MD, attachments: ['attachments/a3.png'], absAttachmentPath: (r) => `/ws/.specreview/docs/kitchen-sink/${r}` });
    assert.deepEqual(d.lines, [29, 39]);
    assert.equal(d.label, 'snip (image + diagram + quote)');
    assert.equal(d.on, 'System overview Note: the gateway never stores tokens');
    assert.deepEqual(d.crops, ['/ws/.specreview/docs/kitchen-sink/attachments/a3.png']);
    assert.equal(d.cropKind, 'snip');
    // 11 lines: shortened like any long range (first 3, a marker, the last line)
    assert.match(String(d.src), /^!\[System overview\]\(\.\/img\/arch\.png "Architecture overview"\)\n\n```mermaid\n\.\.\.\(7 more lines\)\n> to the auth service for validation\.$/);
    const small = describeAnchor(createAnchor({ version: 1, capture: IN_DIAGRAM, source: MD, render: md, format: 'markdown' }), { source: MD });
    assert.equal(small.src, MD.split('\n').slice(30, 36).join('\n'), 'src> is the exact covered lines');
    assert.equal(small.srcUnique, true);
  });

  test('attachment kinds: region crops, snips, everything else', () => {
    assert.equal(attachmentKindOf(createAnchor({ version: 1, capture: { kind: 'element', srid: IMG, tag: 'img', label: 'img', region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }, source: MD, render: md, format: 'markdown' })), 'region');
    assert.equal(attachmentKindOf(createAnchor({ version: 1, capture: { kind: 'element', srid: IMG, tag: 'img', label: 'img' }, source: MD, render: md, format: 'markdown' })), 'image');
    assert.equal(attachmentKindOf(createAnchor({ version: 1, capture: { kind: 'doc' }, source: MD, render: md, format: 'markdown' })), 'image');
    assert.equal(attachmentKindOf(createAnchor({ version: 1, capture: IN_DIAGRAM, source: MD, render: md, format: 'markdown' })), 'snip');
    assert.equal(attachmentKindOf(null), 'image');
  });
});

describe('re-anchoring snips', () => {
  test('an edit above: moved by the inserted lines, container re-resolved, still boxed', () => {
    const a = createAnchor({ version: 1, capture: IN_DIAGRAM, source: MD, render: md, format: 'markdown' });
    const next = edit(MD, '# Token Service Implementation Spec\n', '# Token Service Implementation Spec\n\nInserted.\n\nAnother line.\n');
    const { a: b, toRender } = step('markdown', MD, next, a);
    const bb = /** @type {any} */ (b);
    assert.equal(b.state, 'moved');
    assert.equal(b.kind, 'snip');
    assert.deepEqual([b.src.startLine, b.src.endLine], [35, 40]);
    assert.equal(b.src.text, a.src.text);
    assert.equal(b.quote, null);
    assert.equal(toRender.srcmap.nodes[bb.snip.container.srid].k, 'mermaid');
    assert.equal(bb.snip.container.s, toRender.srcmap.nodes[bb.snip.container.srid].s);
    const dt = toDomTarget(b, toRender, { id: 't1', num: 1, state: 'open' });
    assert.deepEqual({ kind: dt.kind, srid: dt.srid, region: dt.region }, { kind: 'element', srid: bb.snip.container.srid, region: IN_DIAGRAM.region });
  });

  test('edits inside the covered blocks: changed, still the whole covered lines', () => {
    const a = createAnchor({ version: 1, capture: MULTI, source: MD, render: md, format: 'markdown' });
    let next = edit(MD, '  Auth --> Store[(Token store)]\n```', '  Auth --> Store[(Token store)]\n  Auth --> Audit[Audit log]\n```');
    next = edit(next, '> to the auth service for validation.', '> to the auth service, which validates them.');
    const { a: b } = step('markdown', MD, next, a);
    assert.equal(b.state, 'changed');
    assert.deepEqual([b.src.startLine, b.src.endLine], [29, 40], 'the last covered line is kept, the new diagram line included');
    assert.ok(b.src.text.endsWith('which validates them.'));
    assert.equal(/** @type {any} */ (b).snip.covers, 'image + diagram + quote', 'covers describes the original snip');
  });

  test('a linked rewrite of the covered blocks: edited', () => {
    const a = createAnchor({ version: 1, capture: IN_DIAGRAM, source: MD, render: md, format: 'markdown' });
    const next = edit(MD, '  Gateway --> Auth[Auth service]', '  Gateway -->|JWT| Auth[Auth service]');
    const hunks = lineHunks(MD, next);
    const { a: b, toRender } = step('markdown', MD, next, a, { link: { hunkIds: hunks.map((h) => h.id), linked: true } });
    assert.equal(b.state, 'edited');
    assert.deepEqual([b.src.startLine, b.src.endLine], [31, 36]);
    assert.equal(toDomTarget(b, toRender, { id: 't1' }).kind, 'element');
  });

  test('the container element is gone: the box is no longer drawn, the blocks are outlined', () => {
    const html = render('html', HTML);
    const cap = { kind: 'snip', srids: [selectSrid(html, { tag: 'p', text: 'Requests arrive' }), selectSrid(html, { tag: 'img' })],
      containerSrid: selectSrid(html, { tag: 'section', id: 'overview' }), region: { x: 0, y: 0.2, w: 1, h: 0.6 }, text: 'Requests arrive', label: 'area' };
    const a = /** @type {any} */ (createAnchor({ version: 1, capture: cap, source: HTML, render: html, format: 'html' }));
    assert.deepEqual([a.src.startLine, a.src.endLine], [27, 28]);
    assert.equal(a.snip.container.tag, 'section');
    assert.equal(a.snip.covers, 'paragraph + image');
    const next = edit(edit(HTML, '<section id="overview">', '<div class="overview">'), '  <ul id="generated" aria-label="Pipeline stages"></ul>\n</section>', '  <ul id="generated" aria-label="Pipeline stages"></ul>\n</div>');
    const { a: b, toRender } = step('html', HTML, next, a);
    const bb = /** @type {any} */ (b);
    assert.equal(b.state, 'exact', 'the covered lines are untouched');
    assert.equal(bb.snip.container, null);
    assert.equal(b.region, null);
    const dt = toDomTarget(b, toRender, { id: 't1' });
    assert.equal(dt.kind, 'source');
    assert.equal(toRender.srcmap.nodes[/** @type {number} */ (dt.srid)].t, 'p');
  });

  test('everything covered deleted: orphaned (lastKnown keeps the snip); DomTarget paints nothing', () => {
    const a = createAnchor({ version: 1, capture: IN_DIAGRAM, source: MD, render: md, format: 'markdown' });
    const fence = MD.slice(a.src.start, a.src.end);
    const { a: b, toRender } = step('markdown', MD, MD.replace(`${fence}\n\n`, ''), a);
    const bb = /** @type {any} */ (b);
    assert.equal(b.state, 'orphaned');
    assert.equal(b.kind, 'snip');
    assert.equal(bb.lastKnown.snip.covers, 'diagram');
    assert.ok(bb.snip, 'the orphan keeps the snip info');
    const dt = toDomTarget(b, toRender, { id: 't1' });
    assert.deepEqual({ kind: dt.kind, state: dt.state, srid: dt.srid, region: dt.region }, { kind: 'source', state: 'orphaned', srid: null, region: null });
    assert.equal(describeAnchor(b, { source: MD }).label, 'snip (diagram)');
  });

  test('the live working copy and a step without a render', () => {
    const a = createAnchor({ version: 1, capture: IN_DIAGRAM, source: MD, render: md, format: 'markdown' });
    const working = `Preface.\n\n${MD}`;
    const liveRender = render('markdown', working);
    const live = /** @type {any} */ (mapAnchorToWorking(a, MD, working, null, null, { render: liveRender, format: 'markdown' }));
    assert.deepEqual([live.src.startLine, live.src.endLine], [33, 38]);
    assert.equal(liveRender.srcmap.nodes[live.snip.container.srid].k, 'mermaid');
    assert.equal(toDomTarget(live, liveRender, { id: 't1' }).kind, 'element');

    // relocated in the source only (no render): the container's offsets are carried, then found again
    const hunks = lineHunks(MD, working);
    const noRender = /** @type {any} */ (reanchor({ anchor: a, fromSource: MD, toSource: working, hunks, mapper: offsetMapper(MD, working, hunks), toRender: null, format: 'markdown', version: 2 }));
    assert.equal(noRender.snip.container.srid, null);
    assert.equal(noRender.snip.container.s, a.snip.container.s + 'Preface.\n\n'.length);
    const again = `${working}\nAppendix.\n`;
    const { a: c, toRender } = step('markdown', working, again, noRender);
    assert.equal(toRender.srcmap.nodes[/** @type {any} */ (c).snip.container.srid].k, 'mermaid');
  });
});
