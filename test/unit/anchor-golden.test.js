// Golden re-anchoring corpus (WP3a): test/fixtures/reanchor/*.json, run through createAnchor + reanchor one
// version at a time (see test/fixtures/reanchor/harness.js for the fixture format). Besides each fixture's
// expectations, every anchor at every version must satisfy the engine invariants below, in particular
// "never silently wrong": an anchor reported 'exact' or 'moved' still points at the very same source text.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SPECREVIEW_HOME ??= mkdtempSync(path.join(tmpdir(), 'sr-home-'));

const { ANCHOR_STATES } = await import('../../src/shared/protocol.js');
const { lineIndex } = await import('../../src/core/text/index.js');
const { describeAnchor, toDomTarget } = await import('../../src/core/anchor/index.js');
const { checkExpect, fixtureNames, loadFixture, runFixture } = await import('../fixtures/reanchor/harness.js');

const ANCHOR_KEYS = ['v', 'kind', 'state', 'mappedBy', 'src', 'quote', 'srid', 'endSrid', 'section', 'generated', 'element',
  'region', 'svg', 'cell', 'code', 'media'];

/**
 * Engine invariants for one anchor.
 * @param {any} a anchor at version `ver` @param {any} ver { v, source, render } @param {any} prev previous anchor
 * @param {any} created anchor created on v1 @param {boolean} overridden
 */
function invariants(a, ver, prev, created, overridden) {
  const errs = [];
  for (const k of ANCHOR_KEYS) if (!(k in a)) errs.push(`missing key ${k}`);
  if (a.v !== ver.v) errs.push(`v ${a.v} != ${ver.v}`);
  if (!ANCHOR_STATES.includes(a.state)) errs.push(`bad state ${a.state}`);
  if (a.src.text !== ver.source.slice(a.src.start, a.src.end)) errs.push('src.text is not the source slice');
  const li = lineIndex(ver.source);
  if (a.src.startLine !== li.lineOf(a.src.start)) errs.push('src.startLine mismatch');
  const endLine = a.src.end > a.src.start ? li.lineOf(a.src.end - 1) : li.lineOf(a.src.start);
  if (a.src.endLine !== endLine) errs.push('src.endLine mismatch');
  if (a.src.prefix !== ver.source.slice(Math.max(0, a.src.start - 32), a.src.start)) errs.push('src.prefix mismatch');
  if (a.state === 'orphaned') {
    if (a.srid !== null || a.endSrid !== null) errs.push('orphan keeps srids');
    if (!a.lastKnown || a.lastKnown.state === 'orphaned' || a.lastKnown.lastKnown) errs.push('orphan lastKnown malformed');
    if (a.src.text !== '') errs.push('orphan src is not empty');
  } else {
    for (const k of ['srid', 'endSrid']) {
      if (a[k] != null && !ver.render.srcmap.nodes[a[k]]) errs.push(`${k} ${a[k]} not in render`);
    }
    if (a.kind === 'element' && a.element) {
      if (a.element.srid !== a.srid) errs.push('element.srid != srid');
      const n = ver.render.srcmap.nodes[a.srid];
      if (!n || n.t.toLowerCase() !== a.element.tag) errs.push(`element tag ${n?.t} != ${a.element.tag}`);
    }
    if (prev && !overridden && (a.state === 'exact' || a.state === 'moved')) {
      const okText = a.src.text === (prev.lastKnown ?? prev).src.text || a.src.text === created.src.text;
      if (!okText) errs.push(`'${a.state}' but the text changed: ${JSON.stringify(a.src.text.slice(0, 60))}`);
    }
    if (prev && prev.state !== 'orphaned' && a.state === 'exact' && !overridden) {
      if (a.src.startLine !== prev.src.startLine || a.src.endLine !== prev.src.endLine) errs.push("'exact' on other lines");
    }
  }
  const dt = toDomTarget(a, ver.render, { id: 'x', num: 1, state: 'open' });
  if (a.state === 'orphaned' && (dt.state !== 'orphaned' || dt.srid !== null || dt.quote !== null)) errs.push('orphan DomTarget');
  const d = describeAnchor(a, { source: ver.source });
  if (a.kind !== 'doc' && a.state !== 'orphaned') {
    if (JSON.stringify(d.lines) !== JSON.stringify([a.src.startLine, a.src.endLine])) errs.push('describe lines mismatch');
    if (d.src == null || d.src.length > 1200) errs.push('describe src missing or too long');
  }
  return errs;
}

for (const name of fixtureNames()) {
  test(`golden re-anchoring: ${name}`, () => {
    const fx = loadFixture(name);
    const run = runFixture(fx);
    const errors = [];
    for (const [id, t] of Object.entries(fx.threads)) {
      if (t.expect) for (const e of checkExpect(run.created[id], t.expect, run.versions[0].render)) errors.push(`v1 ${id}: ${e}`);
      for (const e of invariants(run.created[id], run.versions[0], null, run.created[id], false)) errors.push(`v1 ${id}: ${e}`);
    }
    (fx.steps ?? []).forEach((step, i) => {
      const ver = run.versions[i + 1];
      const prev = run.versions[i];
      for (const id of Object.keys(fx.threads)) {
        const a = ver.anchors[id];
        const overridden = Boolean(step.override?.[id]);
        for (const e of invariants(a, ver, prev.anchors[id], run.created[id], overridden)) errors.push(`v${ver.v} ${id}: ${e}`);
        const exp = step.expect?.[id];
        if (exp) for (const e of checkExpect(a, exp, ver.render)) errors.push(`v${ver.v} ${id}: ${e}`);
      }
    });
    assert.deepEqual(errors, [], `${fx.name}: ${fx.description}`);
  });
}

test('golden corpus covers both fixture docs and the required scenarios', () => {
  const names = fixtureNames();
  const docs = new Set(names.map((n) => loadFixture(n).doc).filter(Boolean));
  assert.ok(docs.has('kitchen-sink.md') && docs.has('app-spec.html'), 'both test/fixtures/docs documents are used');
  for (const required of ['reword', 'insert-above', 'move-paragraph', 'table-row-edit', 'image-swap', 'mermaid-rename',
    'full-regeneration', 'linked-adjacent-image', 'code-line-insert', 'html-generated']) {
    assert.ok(names.includes(`${required}.json`), `missing golden fixture ${required}.json`);
  }
});
