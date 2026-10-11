// Unit tests: src/core/diff/changes.js (changeSet: srids, rendered-text word targets, deletions, sections).
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.SPECREVIEW_HOME ??= mkdtempSync(path.join(tmpdir(), 'sr-home-'));

const { changeSet, lineHunks } = await import('../../src/core/diff/index.js');
const { renderSource, elementText } = await import('../../src/core/render/index.js');

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'docs');
const kitchen = readFileSync(path.join(FIXTURES, 'kitchen-sink.md'), 'utf8');
const appSpec = readFileSync(path.join(FIXTURES, 'app-spec.html'), 'utf8');

/** Render `to` and compute the change set from `from`. */
async function changes(from, to, format = 'markdown') {
  const toRender = await renderSource({ format, source: to, docPath: format === 'html' ? 'docs/a.html' : 'docs/k.md' });
  const hunks = lineHunks(from, to);
  return { toRender, hunks, c: changeSet({ fromSource: from, toSource: to, toRender, format, hunks }) };
}

/** srid of the element of `tag` whose source starts with `prefix`. */
const sridOf = (r, src, tag, prefix) =>
  r.srcmap.order.find((id) => r.srcmap.nodes[id].t === tag && src.slice(r.srcmap.nodes[id].s, r.srcmap.nodes[id].e).startsWith(prefix));

test('a one-word edit maps to the paragraph srid with a rendered-text word target', async () => {
  const to = kitchen.replace('rotated on every use', 'rotated on first use');
  const { toRender, c } = await changes(kitchen, to);
  assert.equal(c.hunks.length, 1);
  const h = c.hunks[0];
  assert.equal(h.op, 'mod');
  const para = sridOf(toRender, to, 'p', 'Refresh tokens are rotated');
  assert.deepEqual(h.srids, [para]);
  assert.deepEqual(h.words.map((w) => [w.srid, w.quote]), [[para, 'first']]);
  assert.ok(h.words[0].prefix.endsWith('rotated on '), `prefix ${JSON.stringify(h.words[0].prefix)}`);
  assert.ok(h.words[0].suffix.startsWith(' use, and the previous'), `suffix ${JSON.stringify(h.words[0].suffix)}`);
  assert.ok(h.words[0].prefix.length <= 32 && h.words[0].suffix.length <= 32);
  assert.deepEqual(h.deleted, { text: 'every', html: null, lines: 1 });
  assert.equal(h.insertBefore, null);
  assert.deepEqual(h.section, ['Token Service Implementation Spec', '3 Tokens', '3.2 Token refresh']);
  assert.deepEqual(h.old, { start: h.new.start, lines: 1 });
  assert.deepEqual(c.stats, { added: 1, removed: 1, hunks: 1, blocksChanged: 1 });
});

test('replaced text inside emphasis is reported as plain rendered text', async () => {
  const to = kitchen.replace('**token service**', '**token issuer service**');
  const { toRender, c } = await changes(kitchen, to);
  const h = c.hunks[0];
  const para = sridOf(toRender, to, 'p', 'This spec describes');
  assert.deepEqual(h.srids, [para]);
  assert.deepEqual(h.words.map((w) => w.quote), ['issuer']);
  // context comes from the global rendered-text stream (it may cross the element boundary)
  const stream = toRender.text.text.replace(/\s+/g, ' ');
  assert.ok(stream.includes(h.words[0].prefix + 'issuer' + h.words[0].suffix));
  assert.ok(elementText(toRender, para).includes('token issuer service'));
});

test('a deleted section reports insertBefore (next block) and rendered deleted html', async () => {
  const start = kitchen.indexOf('### 1.1 Milestones');
  const end = kitchen.indexOf('## 2 Architecture');
  const to = kitchen.slice(0, start) + kitchen.slice(end);
  const { toRender, c } = await changes(kitchen, to);
  assert.equal(c.hunks.length, 1);
  const h = c.hunks[0];
  assert.equal(h.op, 'del');
  assert.deepEqual(h.srids, []);
  assert.deepEqual(h.words, []);
  const h2 = sridOf(toRender, to, 'h2', '## 2 Architecture');
  assert.deepEqual(h.insertBefore, { srid: h2 });
  assert.equal(h.insertAfter, null);
  assert.equal(h.deleted.lines, 6);
  assert.ok(h.deleted.text.startsWith('### 1.1 Milestones'));
  assert.match(h.deleted.html, /<h3>1\.1 Milestones<\/h3>/);
  assert.match(h.deleted.html, /<ol>/);
  assert.ok(!h.deleted.html.includes('data-srid'));
  assert.deepEqual(c.stats, { added: 0, removed: 6, hunks: 1, blocksChanged: 0 });
});

test('a deletion at the end of the document points insertAfter at the last block', async () => {
  const to = kitchen.slice(0, kitchen.indexOf('[^rfc]: OAuth')).replace(/note[^\n]*\n?$/, '') ;
  const from = to + 'Trailing paragraph to delete.\n';
  const { toRender, c } = await changes(from, to);
  const h = c.hunks[c.hunks.length - 1];
  assert.equal(h.op, 'del');
  assert.equal(h.insertBefore, null);
  assert.ok(h.insertAfter && toRender.srcmap.nodes[h.insertAfter.srid].b);
  assert.equal(toRender.srcmap.nodes[h.insertAfter.srid].e <= to.length, true);
});

test('added list item, table cell edit, code edit and mermaid edit map to their blocks', async () => {
  let to = kitchen.replace('- [ ] Load test the issuer\n', '- [ ] Load test the issuer\n- [ ] Write the runbook\n');
  to = to.replace('| 30 d |', '| 14 d |');
  to = to.replace('if (family.revoked) throw', 'if (family.revoked || family.expired) throw');
  to = to.replace('Auth --> Store[(Token store)]', 'Auth --> Store[(Token DB)]');
  const { toRender, c } = await changes(kitchen, to);
  assert.equal(c.hunks.length, 4);
  const [mermaid, cell, code, item] = c.hunks;

  assert.equal(toRender.srcmap.nodes[mermaid.srids[0]].k, 'mermaid');
  assert.deepEqual(mermaid.words, [], 'mermaid source is not rendered text');

  assert.equal(toRender.srcmap.nodes[cell.srids[0]].k, 'cell');
  assert.equal(elementText(toRender, cell.srids[0]), '14 d');
  assert.deepEqual(cell.words.map((w) => w.quote), ['14']);
  assert.deepEqual(cell.section.slice(-1), ['3 Tokens']);

  assert.equal(toRender.srcmap.nodes[code.srids[0]].k, 'code');
  assert.deepEqual(code.words.map((w) => w.quote), ['|| family.expired']);
  assert.ok(code.words[0].prefix.endsWith('if (family.revoked '));

  assert.equal(item.op, 'add');
  const li = sridOf(toRender, to, 'li', '- [ ] Write the runbook');
  assert.deepEqual(item.srids, [li]);
  assert.deepEqual(item.words.map((w) => w.quote), ['Write the runbook']);
  assert.equal(item.deleted, null);
  assert.equal(c.stats.blocksChanged, 4);
});

test('markup-only changes keep the block srid but produce no word targets', async () => {
  const to = kitchen.replace('Rotate refresh tokens safely.', 'Rotate refresh tokens **safely**.');
  const { toRender, c } = await changes(kitchen, to);
  const h = c.hunks[0];
  const li = sridOf(toRender, to, 'li', '- Rotate refresh');
  assert.deepEqual(h.srids, [li]);
  assert.deepEqual(h.words, []);
});

test('multi-paragraph insertion yields one word target per leaf block', async () => {
  const anchor = 'Last revised 2026-10-10.\n';
  const to = kitchen.replace(anchor, `${anchor}\nFirst *added* para.\n\nSecond added para.\n`);
  const { toRender, c } = await changes(kitchen, to);
  const h = c.hunks[0];
  assert.equal(h.op, 'add');
  assert.equal(h.srids.length, 2);
  assert.deepEqual(h.words.map((w) => w.quote), ['First added para.', 'Second added para.']);
  assert.deepEqual(h.srids, h.words.map((w) => w.srid));
  assert.ok(h.srids.every((id) => toRender.srcmap.nodes[id].t === 'p'));
});

test('HTML docs: cell edits map to the td, deletions carry text only', async () => {
  let to = appSpec.replace('<td>members only</td>', '<td>members and partners</td>');
  to = to.replace('  <p>Requests arrive through the API gateway and are processed in three stages.</p>\n', '');
  const { toRender, c } = await changes(appSpec, to, 'html');
  assert.equal(c.hunks.length, 2);
  const [del, mod] = c.hunks;
  assert.equal(del.op, 'del');
  assert.equal(del.deleted.html, null);
  assert.ok(del.deleted.text.includes('<p>Requests arrive'));
  assert.equal(toRender.srcmap.nodes[del.insertBefore.srid].t, 'img');
  assert.deepEqual(del.section, ['Checkout Service', '1. Overview']);
  assert.equal(mod.op, 'mod');
  assert.equal(toRender.srcmap.nodes[mod.srids[0]].t, 'td');
  assert.deepEqual(mod.words.map((w) => w.quote), ['and partners']);
  assert.deepEqual(mod.section, ['Checkout Service', '3. Pricing rules']);
});

test('changeSet without a render still reports hunks, deletions and stats', () => {
  const c = changeSet({ fromSource: 'a\nb\n', toSource: 'a\nc\n', toRender: null, format: 'markdown' });
  assert.equal(c.hunks.length, 1);
  assert.deepEqual(c.hunks[0].srids, []);
  assert.deepEqual(c.hunks[0].deleted, { text: 'b', html: null, lines: 1 });
  assert.deepEqual(c.stats, { added: 1, removed: 1, hunks: 1, blocksChanged: 0 });
});
