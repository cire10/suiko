// @ts-check
// Render-fidelity regressions of capture -> anchor resolution on realistic AI-written specs
// (test/fixtures/docs/rf): sections whose heading sits in a wrapper (RF-1), the last Markdown section and the
// document's link / footnote definitions (RF-5), selections containing inline math (RF-2), a multi-line selection
// in a fence inside a blockquote (RF-3), picks of script-generated elements (RF-4), footnote ordinals, back-refs
// and escaped table pipes (RF-6), generated text outside every element (RF-10) and selections across two
// Markdown links (RF-11). Captures are built from the render's own text stream, which is what the guest sends.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAnchor, sectionRange } from '../../src/core/anchor/index.js';
import { renderSource } from '../../src/core/render/index.js';
import { balanceMarkdown, findQuote, toPlain } from '../../src/core/text/index.js';
import { footnoteOrder } from '../../src/core/text/plain.js';
import { describeAnchor } from '../../src/core/anchor/describe.js';
import * as ops from '../../src/core/review/index.js';
import { FIXTURES, engineCtx, findSrid, makeWorkspace, textCapture } from '../helpers/engine.js';

const RF = path.join(FIXTURES, 'rf');

/**
 * @param {string} name file in test/fixtures/docs/rf
 */
async function load(name) {
  const source = fs.readFileSync(path.join(RF, name), 'utf8');
  const format = /** @type {'markdown' | 'html'} */ (name.endsWith('.md') ? 'markdown' : 'html');
  const render = await renderSource({ format, source, docPath: `docs/rf/${name}` });
  /** @param {any} capture */
  const anchor = (capture) => createAnchor({ version: 1, capture, source, render, format, docPath: `docs/rf/${name}` });
  /** @param {string} text */
  const heading = (text) => /** @type {any} */ (render.outline.find((o) => o.text === text)).srid;
  /** @param {string} text */
  const section = (text) => anchor({ kind: 'section', headingSrid: heading(text) });
  return { source, format, render, anchor, heading, section };
}

describe('sections of headings inside wrappers (RF-1)', () => {
  test('an h2 in a flex <div> row with a badge spans its whole <section>', async () => {
    const d = await load('checkout-spec.html');
    const a = d.section('1. Overview');
    assert.ok(a.src.text.startsWith('<h2'));
    assert.match(a.src.text, /<strong>4 steps<\/strong>/);
    assert.ok(a.src.text.endsWith('</section>'), a.src.text.slice(-40));
    for (const h of ['2. Payment flow', '3. API changes', '4. Rollout']) {
      assert.ok(d.section(h).src.endLine - d.section(h).src.startLine >= 5, `${h} covers its body`);
    }
  });

  test('an h1 in a <header> (with an eyebrow) and a README <div align="center"> h1 span the document', async () => {
    const sdk = await load('sdk-guide.html');
    const h1 = sdk.section('SDK Retry Policy');
    assert.ok(h1.src.text.includes('Compatibility'), 'covers the h2 sections that follow');
    const mem = await load('agent-memory.md');
    const top = mem.section('Agent Memory Service');
    assert.equal(top.src.endLine, mem.source.trimEnd().split('\n').length);
  });

  test('a heading directly in <section> and a card <div> holding the body still end with their container', async () => {
    const d = await load('checkout-spec.html');
    const sub = d.section('3.1 Request example');
    assert.ok(sub.src.text.endsWith('</section>'));
    const html = '<!doctype html><html><body><div class="card"><h2>A</h2><p>Alpha body.</p></div>\n<p>Between cards.</p>\n<div class="card"><h2>B</h2><p>Beta.</p></div></body></html>';
    const r = await renderSource({ format: 'html', source: html, docPath: 'c.html' });
    const hA = /** @type {any} */ (r.outline.find((o) => o.text === 'A')).srid;
    const range = sectionRange(r, html, hA);
    assert.equal(html.slice(range.start, range.end), '<h2>A</h2><p>Alpha body.</p></div>');
  });

  test('an agreed section in a wrapper is protected by the lock guard', async () => {
    const ws = await makeWorkspace({ files: ['rf/checkout-spec.html'] });
    try {
      const ctx = await engineCtx(ws.root);
      const { doc } = await ops.openDoc(ctx, { path: 'docs/rf/checkout-spec.html' });
      const v1 = await ctx.render(doc, 1);
      const hs = /** @type {any} */ (v1.outline.find((o) => o.text === '1. Overview')).srid;
      await ops.addLock(ctx, doc.id, { capture: { kind: 'section', headingSrid: hs } });
      await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: { kind: 'doc' }, body: 'Overall fine.' });
      await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', body: '' });
      await ops.feedback(ctx, doc.id, {});
      const file = ws.file('docs/rf/checkout-spec.html');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<strong>4 steps</strong>', '<strong>6 steps</strong>'));
      const r = await ops.revise(ctx, doc.id, { dryRun: true, threads: { t1: { status: 'answered', reply: 'ok' } } });
      assert.equal(r.refused, true);
      assert.ok(r.guards.errors.some((/** @type {any} */ e) => e.code === 'lock'));
    } finally {
      await ws.cleanup();
    }
  });
});

describe('Markdown definitions do not belong to the last section (RF-5)', () => {
  test('§7 of the rate limiter ends before the link and footnote definitions', async () => {
    const d = await load('rate-limiter.md');
    const s7 = d.section('7. Open Questions');
    assert.ok(s7.src.text.endsWith('[gateway README](https://example.com/gateway#limits).'), s7.src.text.slice(-60));
    assert.doesNotMatch(s7.src.text, /\[\^perf\]:|\[jira\]:/);
    // a section that is all definitions keeps at least its heading; definitions in the middle stay
    const md = '# T\n\n## A\n\nSee [x].\n\n[x]: https://x.example\n\nMore text.\n\n## B\n\nB body.\n\n[y]: https://y.example\n';
    const r = await renderSource({ format: 'markdown', source: md, docPath: 'm.md' });
    const a = /** @type {any} */ (r.outline.find((o) => o.text === 'A')).srid;
    const b = /** @type {any} */ (r.outline.find((o) => o.text === 'B')).srid;
    let range = sectionRange(r, md, a);
    assert.ok(md.slice(range.start, range.end).endsWith('More text.'));
    range = sectionRange(r, md, b);
    assert.equal(md.slice(range.start, range.end), '## B\n\nB body.');
  });

  test('locking §7 does not refuse an edit of the TL;DR footnote definition', async () => {
    const ws = await makeWorkspace({ files: ['rf/rate-limiter.md'] });
    try {
      const ctx = await engineCtx(ws.root);
      const { doc } = await ops.openDoc(ctx, { path: 'docs/rf/rate-limiter.md' });
      const v1 = await ctx.render(doc, 1);
      const hs = /** @type {any} */ (v1.outline.find((o) => o.text === '7. Open Questions')).srid;
      await ops.addLock(ctx, doc.id, { capture: { kind: 'section', headingSrid: hs } });
      await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'Expected p99 overhead'), body: 'Which instance?' });
      await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', body: '' });
      await ops.feedback(ctx, doc.id, {});
      const file = ws.file('docs/rf/rate-limiter.md');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Measured on a c6i.2xlarge', 'Measured on a c7i.2xlarge'));
      const r = await ops.revise(ctx, doc.id, { dryRun: true, threads: { t1: { status: 'addressed', reply: 'c7i.', at: 'L158' } } });
      assert.deepEqual(r.guards.errors, []);
      assert.equal(r.refused, false);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('selections the source does not spell verbatim', () => {
  test('inline math: the selection anchors to its own line, not the whole paragraph (RF-2)', async () => {
    const d = await load('rate-limiter.md');
    const sel = "A request is admitted iff count(t)<L, where L is the tenant's limit";
    const a = d.anchor(textCapture(d.render, sel));
    assert.equal(a.mappedBy, 'narrowed');
    assert.equal(a.generated, false);
    assert.equal(a.src.text, "A request is admitted iff $\\text{count}(t) < L$, where $L$ is the tenant's limit");
    assert.equal(a.src.startLine, a.src.endLine);
    assert.equal(toPlain('markdown', 'cost $O(n^2)$, $t_{ttl}$ and $\\lambda \\le 2$, $n-1$').text, 'cost O(n2), tttl and λ ≤ 2, n−1');
  });

  test('a multi-line selection in a fence inside a blockquote is a code anchor on its own lines (RF-3)', async () => {
    const d = await load('migration-plan.md');
    const pre = findSrid(d.render, (n) => n.k === 'code' && d.source.slice(n.s, n.e).includes('check replication lag'));
    const text = d.render.text.text;
    const i = text.indexOf('# check replication lag before cutover');
    const end = text.indexOf('AS lag;"', i) + 'AS lag;"'.length;
    const exact = text.slice(i, end);
    assert.match(exact, /\n/);
    const a = d.anchor({ kind: 'text', startSrid: pre, endSrid: pre, exact, prefix: '', suffix: '' });
    assert.equal(a.kind, 'code');
    assert.equal(a.generated, false);
    assert.equal(a.mappedBy, 'textmap');
    assert.deepEqual(a.code && [a.code.fromLine, a.code.toLine], [1, 2]);
    assert.ok(a.src.text.startsWith('# check replication lag before cutover\n> psql -c'));
    // the markup-tolerant global search reports that single occurrence once
    const hits = findQuote(d.source, exact, { markupTolerant: true, format: 'markdown' });
    assert.equal(hits.length, 1);
  });

  test('footnote ordinals, back-reference arrows and escaped table pipes (RF-6)', async () => {
    const d = await load('rate-limiter.md');
    assert.deepEqual([...footnoteOrder(d.source)], [['perf', 1], ['history', 2]]);
    const tldr = d.anchor(textCapture(d.render, 'Expected p99 overhead is < 2 ms.1'));
    assert.equal(tldr.generated, false);
    assert.equal(tldr.src.text, 'Expected p99 overhead is **< 2 ms**.[^perf]');

    const note = d.anchor(textCapture(d.render, 'Measured on a c6i.2xlarge with Redis 7.2 on the same AZ; see the benchmark notebook. ↩'));
    assert.equal(note.generated, false);
    assert.equal(note.src.text, 'Measured on a c6i.2xlarge with Redis 7.2 on the same AZ; see the benchmark notebook.');

    const pipe = d.anchor(textCapture(d.render, 'users|accounts', 0));
    assert.equal(pipe.generated, false);
    assert.equal(pipe.src.text, 'users\\|accounts');
  });

  test('a selection across two links widens to both whole links (RF-11)', async () => {
    const d = await load('rate-limiter.md');
    const a = d.anchor(textCapture(d.render, 'API keys RFC and the gateway README'));
    assert.equal(a.src.text, '[API keys RFC][rfc-keys] and the [gateway README](https://example.com/gateway#limits)');
    const hay = 'x [a][r] y [b](u) z';
    assert.deepEqual(balanceMarkdown(hay, 3, 13), [2, 17]);
  });

  test('generated text outside every element is a GENERAL anchor keeping the quote, not the whole file (RF-10)', async () => {
    const d = await load('rate-limiter.md');
    const a = d.anchor({ kind: 'text', startSrid: null, endSrid: null, exact: 'Footnotes', prefix: 'gateway README.', suffix: 'Measured on' });
    assert.equal(a.kind, 'doc');
    assert.equal(a.quote?.exact, 'Footnotes');
    const desc = describeAnchor(a, { source: d.source, format: 'markdown' });
    assert.equal(desc.label, 'GENERAL');
    assert.equal(desc.on, 'Footnotes');
    assert.equal(desc.lines, null);
  });
});

describe('picks of script-generated elements (RF-4)', () => {
  test('cards built from a JS array: each pick keeps its own text and points at its literal', async () => {
    const d = await load('options.html');
    const cards = findSrid(d.render, (n) => n.a?.id === 'cards');
    const pick = (/** @type {string} */ label) => d.anchor({ kind: 'element', srid: cards, tag: 'div', label });
    const b = pick('div "Option B: Memcached Viable Estimated cost: $2.3…"');
    const c = pick('h3 "Option C: CDN edge cache"');
    for (const a of [b, c]) {
      assert.equal(a.generated, true);
      assert.equal(a.mappedBy, 'raw-source');
      assert.equal(a.host?.label, '<div id="cards">');
    }
    assert.equal(b.src.text, 'Option B: Memcached');
    assert.equal(c.src.text, 'Option C: CDN edge cache');
    assert.notEqual(b.src.startLine, c.src.startLine);
    const db = describeAnchor(b, { source: d.source, format: 'html' });
    const dc = describeAnchor(c, { source: d.source, format: 'html' });
    assert.notEqual(db.on, dc.on);
    assert.match(String(db.on), /^Option B: Memcached/);

    // picking a stamped element itself is unchanged
    const p = findSrid(d.render, (n) => n.t === 'p');
    const own = d.anchor({ kind: 'element', srid: p, tag: 'p', label: 'p "We evaluated three approaches for the product-ca…"' });
    assert.equal(own.kind, 'element');
    assert.equal(own.generated, false);
  });
});
