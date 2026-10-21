// Re-anchoring one version forward (src/core/anchor/reanchor.js; design 7.4 with the ORDER of BUILD_AMENDMENTS
// 4.2): untouched first, links only relocate intersecting anchors, exact / fuzzy relocation, original-anchor
// retry, orphans with lastKnown, overrides, element / section / cell specifics, config thresholds, inputs.
// The scenario corpus over the fixture docs lives in anchor-golden.test.js; these are focused unit cases.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SPECREVIEW_HOME ??= mkdtempSync(path.join(tmpdir(), 'sr-home-'));

const { renderSourceSync } = await import('../../src/core/render/index.js');
const { lineHunks, offsetMapper } = await import('../../src/core/diff/index.js');
const { UsageError } = await import('../../src/core/store/errors.js');
const { createAnchor, reanchor } = await import('../../src/core/anchor/index.js');
const { selectSrid } = await import('../fixtures/reanchor/harness.js');

const V1 = [
  '# Doc', '', '## Intro', '', 'Alpha beta gamma delta epsilon.', '',
  'The quick brown fox jumps over the lazy dog.', '', '![Diagram](img/d.png)', '', 'Tail paragraph.', '',
  '## Table', '', '| Key | Value |', '|-----|-------|', '| one | 1 |', '| two | 2 |', '| three | 3 |', '',
  '## Next', '', 'Last words here.', '',
].join('\n');

/** @param {string} source */
const render = (source) => renderSourceSync({ format: 'markdown', source, docPath: 'docs/d.md' });
const R1 = render(V1);

/** @param {string} exact @param {any} sel */
function textAnchor(exact, sel) {
  const p = selectSrid(R1, sel);
  return createAnchor({ version: 1, source: V1, render: R1, format: 'markdown', capture: { kind: 'text', startSrid: p, endSrid: p, exact, prefix: '', suffix: '' } });
}

/**
 * One step: re-anchor `anchor` from `from` to `to`; `link(hunks)` may return a link object.
 * @param {any} anchor @param {string} from @param {string} to @param {any} [extra]
 */
function step(anchor, from, to, extra = {}) {
  const hunks = lineHunks(from, to);
  const { link, ...rest } = extra;
  return reanchor({
    anchor, fromSource: from, toSource: to, hunks, mapper: offsetMapper(from, to, hunks), toRender: render(to),
    format: 'markdown', version: anchor.v + 1, link: typeof link === 'function' ? link(hunks) : link ?? null, ...rest,
  });
}

const gamma = textAnchor('gamma delta', { tag: 'p', text: 'Alpha' });
const fox = textAnchor('jumps over the lazy dog', { tag: 'p', text: 'quick brown' });

test('untouched text: exact on the same lines, moved after lines are inserted above', () => {
  const same = step(gamma, V1, V1.replace('Tail paragraph.', 'Tail paragraph, reworded.'));
  assert.equal(same.state, 'exact');
  assert.equal(same.v, 2);
  assert.equal(same.src.text, 'gamma delta');
  assert.equal(same.quote?.exact, 'gamma delta');

  const moved = step(gamma, V1, V1.replace('## Intro\n', '## Intro\n\nA new first paragraph.\n'));
  assert.equal(moved.state, 'moved');
  assert.equal(moved.src.startLine, gamma.src.startLine + 2);
  assert.equal(moved.mappedBy, gamma.mappedBy);
});

test('untouched text on a changed line stays exact (character-level mapping through the word diff)', () => {
  const a = step(gamma, V1, V1.replace('Alpha beta', 'Omega beta'));
  assert.equal(a.state, 'exact');
  assert.equal(a.src.text, 'gamma delta');
  const linked = step(gamma, V1, V1.replace('Alpha beta', 'Omega beta'), { link: (/** @type {any[]} */ h) => ({ hunkIds: [h[0].id] }) });
  assert.equal(linked.state, 'exact', 'a link to a hunk that changed other words of the line never moves the anchor');
});

test('links relocate only anchors whose text the linked hunk changed', () => {
  const v2 = V1.replace('lazy dog', 'lazy cat').replace('Last words', 'Final words');
  const hunks = lineHunks(V1, v2);
  assert.equal(hunks.length, 2);
  const otherLink = step(fox, V1, v2, { link: { hunkIds: [hunks[1].id] } });
  assert.equal(otherLink.state, 'changed', 'edited by an unlinked hunk');
  assert.equal(otherLink.src.text, 'jumps over the lazy cat');
  const ownLink = step(fox, V1, v2, { link: { hunkIds: [hunks[0].id] } });
  assert.equal(ownLink.state, 'edited');
  assert.equal(ownLink.src.text, 'jumps over the lazy cat', 'narrowed to the best match inside the linked hunk');
  assert.equal(ownLink.quote?.exact, 'jumps over the lazy cat');
  const gammaLinked = step(gamma, V1, v2, { link: { hunkIds: hunks.map((h) => h.id) } });
  assert.equal(gammaLinked.state, 'exact', 'links to hunks elsewhere do not move untouched anchors');
});

test('a linked rewrite too different to narrow anchors on the linked whole lines', () => {
  const v2 = V1.replace('The quick brown fox jumps over the lazy dog.', 'A completely new sentence about cats and mice.');
  const a = step(fox, V1, v2, { link: (/** @type {any[]} */ h) => ({ hunkIds: h.map((x) => x.id) }) });
  assert.equal(a.state, 'edited');
  assert.equal(a.src.text, 'A completely new sentence about cats and mice.');
  assert.deepEqual([a.src.startLine, a.src.endLine], [7, 7]);
});

test('a linked edit that rewrites the inside of the anchor (an applied suggestion) spans the new text', () => {
  const v2 = V1.replace('jumps over the lazy dog', 'jumps over the `lazy_dog` flag and the lazy dog');
  const a = step(fox, V1, v2, { link: (/** @type {any[]} */ h) => ({ hunkIds: [h[0].id] }) });
  assert.equal(a.state, 'edited');
  assert.equal(a.src.text, 'jumps over the `lazy_dog` flag and the lazy dog');
  assert.equal(a.quote?.exact, 'jumps over the lazy_dog flag and the lazy dog', 'the quote is rendered text');
});

test('a linked pure deletion: moved text is followed (moved / edited), gone text stays at the deletion point', () => {
  const linkDel = (/** @type {any[]} */ h) => ({ hunkIds: h.filter((x) => x.newLines === 0).map((x) => x.id) });
  const movedVerbatim = V1.replace('The quick brown fox jumps over the lazy dog.\n\n', '').replace('Tail paragraph.', 'Tail paragraph.\n\nThe quick brown fox jumps over the lazy dog.');
  const a = step(fox, V1, movedVerbatim, { link: linkDel });
  assert.equal(a.state, 'moved');
  assert.equal(a.src.text, 'jumps over the lazy dog');
  const movedReworded = V1.replace('The quick brown fox jumps over the lazy dog.\n\n', '').replace('![Diagram](img/d.png)\n', '![Diagram](img/d.png)\n\nThe quick brown fox jumped over the lazy dog.\n');
  const b = step(fox, V1, movedReworded, { link: linkDel });
  assert.equal(b.state, 'edited');
  assert.equal(b.src.text, 'jumped over the lazy dog');
  assert.ok(b.src.startLine > fox.src.startLine, 'followed to its new place');
  const gone = step(fox, V1, V1.replace('The quick brown fox jumps over the lazy dog.\n\n', ''), { link: linkDel });
  assert.equal(gone.state, 'edited');
  assert.equal(gone.src.text, '', 'an empty range at the deletion point');
});

test('a linked pure deletion never lands on a similar sibling the version left untouched', () => {
  const doc = '# Tokens\n\n## Rotation\n\n- Access tokens are rotated every 15 minutes.\n- Refresh tokens are rotated every 24 hours.\n- ID tokens are rotated every 60 minutes.\n\n## Next\n\nAlpha paragraph about caching.\n\nBeta paragraph about retries.\n';
  const r = renderSourceSync({ format: 'markdown', source: doc, docPath: 'docs/t.md' });
  /** @param {string} exact @param {string} tag */
  const anchorOn = (exact, tag) => {
    const p = selectSrid(r, { tag, text: exact });
    return createAnchor({ version: 1, source: doc, render: r, format: 'markdown', capture: { kind: 'text', startSrid: p, endSrid: p, exact, prefix: '', suffix: '' } });
  };
  const linkDel = (/** @type {any[]} */ h) => ({ hunkIds: h.filter((x) => x.newLines === 0).map((x) => x.id) });
  for (const [exact, tag, line] of /** @type {const} */ ([['Refresh tokens are rotated every 24 hours.', 'li', '- Refresh tokens are rotated every 24 hours.\n'], ['Alpha paragraph about caching.', 'p', 'Alpha paragraph about caching.\n\n']])) {
    const a = anchorOn(exact, tag);
    const to = doc.replace(line, '');
    const hunks = lineHunks(doc, to);
    const b = reanchor({ anchor: a, fromSource: doc, toSource: to, hunks, mapper: offsetMapper(doc, to, hunks), toRender: renderSourceSync({ format: 'markdown', source: to, docPath: 'docs/t.md' }), format: 'markdown', version: 2, link: linkDel(hunks) });
    assert.equal(b.state, 'edited', exact);
    assert.equal(b.src.text, '', `${exact}: the deletion point, not a sibling`);
  }
});

test('a linked edit at the edge of the anchored text is edited even though the old text survives verbatim', () => {
  const v2 = V1.replace('lazy dog.', 'lazy dogs.');
  const unlinked = step(fox, V1, v2);
  assert.equal(unlinked.state, 'exact', 'the quoted characters are all still there, on the same line');
  const linked = step(fox, V1, v2, { link: (/** @type {any[]} */ h) => ({ hunkIds: [h[0].id] }) });
  assert.equal(linked.state, 'edited');
  assert.equal(linked.src.text, 'jumps over the lazy dogs');
});

test('fuzzy relocation is changed; config thresholds can turn it into an orphan', () => {
  const v2 = V1.replace('jumps over the lazy dog', 'jumped over a lazy dog');
  const a = step(fox, V1, v2);
  assert.equal(a.state, 'changed');
  assert.equal(a.src.text, 'jumped over a lazy dog');
  const strict = step(fox, V1, v2, { config: { anchoring: { minQuoteSim: 0.95 } } });
  assert.equal(strict.state, 'orphaned');
});

test('orphans keep lastKnown and come back from it; the original anchor is retried last', () => {
  const v2 = V1.replace('The quick brown fox jumps over the lazy dog.\n\n', '');
  const orphan = step(fox, V1, v2);
  assert.equal(orphan.state, 'orphaned');
  assert.equal(orphan.srid, null);
  assert.equal(orphan.src.text, '');
  assert.equal(orphan.lastKnown?.src.text, 'jumps over the lazy dog');
  assert.equal(orphan.lastKnown?.state, 'exact');

  const still = step(orphan, v2, v2.replace('Tail', 'Tail end'));
  assert.equal(still.state, 'orphaned');
  assert.equal(still.lastKnown?.src.text, 'jumps over the lazy dog', 'lastKnown is not overwritten by an orphan');

  const back = step(still, v2.replace('Tail', 'Tail end'), V1);
  assert.equal(back.state, 'moved', 'found again from lastKnown');
  assert.equal(back.src.text, 'jumps over the lazy dog');
  assert.ok(!('lastKnown' in back));

  const rewritten = V1.replace('The quick brown fox jumps over the lazy dog.', 'A completely new sentence about cats and mice.');
  const edited = step(fox, V1, rewritten, { link: (/** @type {any[]} */ h) => ({ hunkIds: h.map((x) => x.id) }) });
  assert.equal(edited.state, 'edited');
  const reverted = step(edited, rewritten, V1, { originalAnchor: fox });
  assert.equal(reverted.state, 'moved', 'the edited text is gone; the original text is found');
  assert.equal(reverted.src.text, 'jumps over the lazy dog');
  const noOriginal = step(edited, rewritten, V1);
  assert.equal(noOriginal.state, 'orphaned');
});

test('never silently wrong: a deleted copy of a repeated sentence does not jump to the surviving copy', () => {
  const v1 = '# Doc\n\n## A\n\nRetries use exponential backoff with jitter.\n\nOther text in A.\n\n## B\n\nSomething about B here.\n\nRetries use exponential backoff with jitter.\n\nEnd of B.\n';
  const r1 = render(v1);
  const p = selectSrid(r1, { tag: 'p', text: 'Retries use', nth: 1 });
  const a = createAnchor({ version: 1, source: v1, render: r1, format: 'markdown',
    capture: { kind: 'text', startSrid: p, endSrid: p, exact: 'Retries use exponential backoff with jitter.', prefix: 'Something about B here. ', suffix: ' End of B.' } });
  assert.equal(a.src.startLine, 13);
  const v2 = v1.replace('Something about B here.\n\nRetries use exponential backoff with jitter.\n\n', 'Something about B here.\n\n');
  const b = step(a, v1, v2);
  assert.equal(b.state, 'orphaned');
  assert.equal(b.lastKnown?.src.startLine, 13);
  const unique = v1.replace('## A\n\nRetries use exponential backoff with jitter.\n\n', '## A\n\n');
  const u = createAnchor({ version: 1, source: unique, render: render(unique), format: 'markdown',
    capture: { kind: 'text', startSrid: null, endSrid: null, exact: 'Retries use exponential backoff with jitter.', prefix: '', suffix: '' } });
  const moved = unique.replace('Something about B here.\n\nRetries use exponential backoff with jitter.\n\n', 'Something about B here.\n\n')
    .replace('## A\n\n', '## A\n\nRetries use exponential backoff with jitter.\n\n');
  assert.equal(step(u, unique, moved).state, 'moved', 'a unique distinctive text moved under another heading is still found');
});

test('overrides: lines or quote -> exact / override; an unknown quote falls back to normal re-anchoring', () => {
  const byLines = step(fox, V1, V1, { override: { lines: [11, 11] } });
  assert.deepEqual([byLines.state, byLines.mappedBy, byLines.kind, byLines.src.text], ['exact', 'override', 'source', 'Tail paragraph.']);
  const byQuote = step(fox, V1, V1, { override: { quote: 'Last words' } });
  assert.deepEqual([byQuote.state, byQuote.mappedBy, byQuote.src.text], ['exact', 'override', 'Last words']);
  const missing = step(fox, V1, V1, { override: { quote: 'not in the document' } });
  assert.deepEqual([missing.state, missing.mappedBy, missing.src.text], ['exact', 'textmap', 'jumps over the lazy dog']);
});

test('element anchors: follow the image, stay on the same tag, keep the old position for a linked removal', () => {
  const img = createAnchor({ version: 1, source: V1, render: R1, format: 'markdown', capture: { kind: 'element', srid: selectSrid(R1, { tag: 'img' }), tag: 'img', label: '' } });
  const relocated = V1.replace('![Diagram](img/d.png)\n\n', '').replace('Last words here.\n', 'Last words here.\n\n![Diagram](img/d.png)\n');
  const moved = step(img, V1, relocated);
  assert.equal(moved.state, 'moved');
  assert.equal(moved.src.text, '![Diagram](img/d.png)');
  assert.equal(render(relocated).srcmap.nodes[/** @type {number} */ (moved.srid)].t, 'img');
  assert.equal(moved.element?.srid, moved.srid);

  const replaced = V1.replace('![Diagram](img/d.png)', 'Diagram removed, see the text.');
  const linked = step(img, V1, replaced, { link: (/** @type {any[]} */ h) => ({ hunkIds: h.map((x) => x.id) }) });
  assert.equal(linked.state, 'edited');
  assert.equal(linked.element?.tag, 'img', 'kind data kept');
  assert.equal(linked.src.startLine, 9, 'old position mapped through the mapper');
  assert.equal(step(img, V1, replaced).state, 'orphaned', 'unlinked: no image any more');
});

test('section anchors: by heading text and level; moved, renamed, promoted', () => {
  const sec = createAnchor({ version: 1, source: V1, render: R1, capture: { kind: 'section', headingSrid: selectSrid(R1, { tag: 'h2', text: 'Table' }) } });
  assert.deepEqual([sec.src.startLine, sec.src.endLine], [13, 19]);
  const reordered = V1.replace('## Next\n\nLast words here.\n', '').replace('## Intro\n', '## Next\n\nLast words here.\n\n## Intro\n');
  const moved = step(sec, V1, reordered);
  assert.equal(moved.state, 'moved');
  assert.deepEqual([moved.src.startLine, moved.src.endLine], [17, 23]);
  assert.equal(moved.src.text, sec.src.text);

  const appended = V1.replace('| three | 3 |', '| three | 3 |\n| four | 4 |');
  const grown = step(sec, V1, appended);
  assert.equal(grown.state, 'changed', 'the extent is recomputed; the content changed');
  assert.deepEqual([grown.src.startLine, grown.src.endLine], [13, 20]);
  const grownLinked = step(sec, V1, appended, { link: (/** @type {any[]} */ h) => ({ hunkIds: [h[0].id] }) });
  assert.equal(grownLinked.state, 'edited', 'a linked hunk inside the new extent');
  const after = step(sec, V1, V1.replace('## Next\n', '## Inserted\n\nNew section.\n\n## Next\n'));
  assert.equal(after.state, 'exact', 'a section inserted after it leaves the extent alone');

  const renamed = step(sec, V1, V1.replace('## Table', '## Tables'));
  assert.equal(renamed.state, 'changed');
  assert.equal(renamed.element?.text, 'Tables');
  const promoted = step(sec, V1, V1.replace('## Table', '### Table'));
  assert.equal(promoted.state, 'changed');
  assert.equal(promoted.element?.tag, 'h3');
  assert.equal(step(sec, V1, V1.replace('## Table\n\n', '')).state, 'orphaned');
});

test('cell anchors: rows found by rowKey after a reorder; keys refreshed; linked edits are edited', () => {
  const row = createAnchor({ version: 1, source: V1, render: R1,
    capture: { kind: 'element', srid: selectSrid(R1, { tag: 'tr', text: 'two' }), tag: 'tr', label: '', cell: { row: 2, col: 1, rowKey: 'two', colHeader: 'Value', text: '2' }, scope: 'row' } });
  const reordered = step(row, V1, V1.replace('| one | 1 |\n| two | 2 |\n', '| two | 2 |\n| one | 1 |\n'));
  assert.equal(reordered.state, 'moved');
  assert.equal(reordered.src.text, '| two | 2 |');
  assert.deepEqual({ ...reordered.cell, tableSrid: 0 }, { tableSrid: 0, row: 1, col: 1, rowKey: 'two', colHeader: 'Value', text: '2' });

  const v2 = V1.replace('| two | 2 |', '| two | 22 |');
  const changed = step(row, V1, v2);
  assert.equal(changed.state, 'changed');
  assert.equal(changed.cell?.text, '22');
  assert.equal(step(row, V1, v2, { link: (/** @type {any[]} */ h) => ({ hunkIds: [h[0].id] }) }).state, 'edited');
});

test('without a render the anchor is relocated in the source only', () => {
  const v2 = `Preface.\n\n${V1}`;
  const a = reanchor({ anchor: fox, fromSource: V1, toSource: v2, version: 2 });
  assert.equal(a.state, 'moved');
  assert.equal(a.src.startLine, 9);
  assert.equal(a.srid, null);
  assert.deepEqual(a.section, fox.section);
});

test('manifest hunks without offsets are recomputed; doc anchors just move to the new version', () => {
  const v2 = `Preface.\n\n${V1}`;
  const a = reanchor({ anchor: fox, fromSource: V1, toSource: v2, toRender: render(v2), version: 2,
    hunks: [{ id: 'h1', oldStart: 1, oldLines: 0, newStart: 1, newLines: 2 }] });
  assert.equal(a.state, 'moved');
  assert.equal(a.src.startLine, 9);
  const doc = createAnchor({ version: 1, source: V1, render: R1, capture: { kind: 'doc' } });
  const d = reanchor({ anchor: doc, fromSource: V1, toSource: v2, version: 2 });
  assert.deepEqual([d.v, d.kind, d.state, d.src.start, d.src.end], [2, 'doc', 'exact', 0, 0]);
  const implicit = reanchor({ anchor: fox, fromSource: V1, toSource: V1 });
  assert.equal(implicit.v, 2, 'version defaults to anchor.v + 1');
});

test('bad input throws UsageError; results are deterministic', () => {
  assert.throws(() => reanchor(/** @type {any} */ ({ anchor: null, fromSource: V1, toSource: V1 })), UsageError);
  assert.throws(() => reanchor(/** @type {any} */ ({ anchor: fox, fromSource: V1, toSource: null })), UsageError);
  const v2 = V1.replace('jumps over the lazy dog', 'jumped over a lazy dog');
  assert.equal(JSON.stringify(step(fox, V1, v2)), JSON.stringify(step(fox, V1, v2)));
});
