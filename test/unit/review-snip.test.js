// @ts-check
// Snips through the review engine (in-process, kitchen-sink.md): a doc-area snip (key `b`) and a snip boxed in the
// mermaid diagram become drafts (preview "Agent will see: L29-39 §... snip (image + diagram + quote)", DomTargets:
// outlined blocks / a boxed element), next to a GENERAL screenshot (key `B` / `specreview snip`) and an image region
// crop; after submit the packet prints every attachment as an ABSOLUTE path with its Read hint (golden
// test/fixtures/packets/snips.txt; the JSON packet keeps the absolute paths and says what they are), `show` does
// too, and an edit above re-anchors the snips ('moved', still boxed). Set UPDATE_GOLDEN=1 to rewrite the golden.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as ops from '../../src/core/review/index.js';
import { setClock } from '../../src/core/util/time.js';
import { formatThread } from '../../src/core/review/packet.js';
import { withThreadSource } from '../../src/cli/format.js';
import { selectSrid } from '../fixtures/reanchor/harness.js';
import { PACKET_FIXTURES, TINY_PNG, editFile, elementCapture, engineCtx, makeWorkspace, normalizePacket } from '../helpers/engine.js';

/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
/** @type {() => void} */
let restoreClock;
const DOC = 'kitchen-sink';

before(async () => {
  let t = Date.parse('2026-10-11T09:00:00.000Z');
  restoreClock = setClock(() => (t += 1000));
  ws = await makeWorkspace();
});
after(async () => {
  restoreClock();
  await ws.cleanup();
});

test('snips: drafts, preview, DomTargets, packet (golden) with absolute attachment paths, show, re-anchoring', async () => {
  const ctx = await engineCtx(ws.root);
  const opened = await ops.openDoc(ctx, { path: 'docs/kitchen-sink.md' });
  const v1 = await ctx.render(opened.doc, 1);
  const IMG = selectSrid(v1, { tag: 'img' });
  const MERMAID = selectSrid(v1, { tag: 'pre', kind: 'mermaid' });
  const NOTE = selectSrid(v1, { tag: 'p', text: 'the gateway never stores tokens' });
  const area = { kind: 'snip', srids: [IMG, MERMAID, NOTE], startSrid: IMG, endSrid: NOTE, containerSrid: null, region: { x: 0, y: 0.05, w: 1, h: 0.9 },
    text: 'System overview Note: the gateway never stores tokens; it only forwards them', label: 'area over "2 Architecture" (image + diagram + note)' };
  const boxed = { kind: 'snip', srids: [MERMAID], startSrid: MERMAID, endSrid: MERMAID, containerSrid: MERMAID, region: { x: 0.3, y: 0.2, w: 0.4, h: 0.5 },
    text: 'API Gateway', label: 'area over the diagram' };

  // ---- composer preview
  const pv = await ops.resolveCapture(ctx, DOC, { capture: /** @type {any} */ (area) });
  assert.equal(pv.anchor.kind, /** @type {any} */ ('snip'));
  assert.equal(pv.preview.text, 'Agent will see: L29-39 §2 Architecture snip (image + diagram + quote)');
  assert.deepEqual(pv.preview.lines, [29, 39]);
  assert.equal(pv.preview.label, 'snip (image + diagram + quote)');
  // "Widen to block" does not apply to a snip (it already covers whole blocks)
  assert.deepEqual((await ops.resolveCapture(ctx, DOC, { capture: /** @type {any} */ (area), widen: true })).anchor.src, pv.anchor.src);

  // ---- drafts: two snips (with their crops), a GENERAL screenshot, an image region crop
  const a1 = await ops.saveAttachment(ctx, DOC, { dataUrl: TINY_PNG });
  const a2 = await ops.saveAttachment(ctx, DOC, { dataUrl: TINY_PNG });
  const a3 = await ops.saveAttachment(ctx, DOC, { dataUrl: TINY_PNG });
  const a4 = await ops.saveAttachment(ctx, DOC, { dataUrl: TINY_PNG });
  await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: area, body: 'The arrows contradict the note: the gateway does forward tokens.', attachments: [a1.path] });
  await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'question', severity: 'blocking', capture: boxed, body: 'Is the gateway the only way in?', attachments: [a2.path] });
  await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: { kind: 'doc' }, body: 'This is the login page today.', attachments: [a3.path] }, { source: 'snip' });
  await ops.saveDraft(ctx, DOC, {
    kind: 'thread', type: 'comment', capture: elementCapture(v1, IMG, { region: { x: 0.4, y: 0.1, w: 0.22, h: 0.2 } }), body: 'Label this arrow.', attachments: [a4.path],
  });
  const snipEvents = (await ctx.store.readEvents(DOC)).filter((e) => e.type === 'drafts.changed' && e.source === 'snip');
  assert.deepEqual(snipEvents.map((e) => e.draft), ['d3']);

  // ---- DomTargets: the multi-block snip outlines its first..last block, the boxed one draws its box in the diagram
  const targets = await ops.domTargets(ctx, DOC, 1);
  const byId = Object.fromEntries(targets.drafts.map((t) => [t.id, t]));
  assert.deepEqual(
    { kind: byId.d1.kind, srid: byId.d1.srid, endSrid: byId.d1.endSrid, quote: byId.d1.quote, region: byId.d1.region, label: byId.d1.label },
    { kind: 'source', srid: IMG, endSrid: NOTE, quote: null, region: null, label: 'snip (image + diagram + quote)' },
  );
  assert.deepEqual({ kind: byId.d2.kind, srid: byId.d2.srid, region: byId.d2.region }, { kind: 'element', srid: MERMAID, region: boxed.region });
  assert.equal(byId.d3.kind, 'doc');

  // ---- submit + wait: the golden packet
  const rv1 = await ops.submitReview(ctx, DOC, { verdict: 'changes_requested', body: 'See the snips.' });
  assert.deepEqual(rv1.newThreads, ['t1', 't2', 't3', 't4']);
  let written = '';
  const w = await ops.waitForFeedback(ctx, { docIds: [DOC], pollMs: 20, write: (text) => { written = text; } });
  assert.equal(w.status, 'delivered');
  const golden = path.join(PACKET_FIXTURES, 'snips.txt');
  const actual = normalizePacket(written, ws.root);
  if (process.env.UPDATE_GOLDEN || !fs.existsSync(golden)) fs.writeFileSync(golden, actual);
  assert.equal(actual, fs.readFileSync(golden, 'utf8'));

  const abs = (/** @type {string} */ rel) => ctx.store.attachmentPath(DOC, rel);
  const p = /** @type {any} */ (w.packets[0]);
  const byThread = Object.fromEntries(p.threads.map((/** @type {any} */ t) => [t.id, t]));
  assert.deepEqual(byThread.t1.attachments, [abs(a1.path)]);
  assert.equal(byThread.t1.attachmentKind, 'snip');
  assert.equal(byThread.t1.target, 'snip');
  assert.equal(byThread.t1.label, 'snip (image + diagram + quote)');
  assert.deepEqual(byThread.t1.lines, [29, 39]);
  assert.deepEqual(byThread.t3.attachments, [abs(a3.path)], 'a GENERAL thread carries its attachment too');
  assert.equal(byThread.t3.attachmentKind, 'image');
  assert.equal(byThread.t3.target, 'doc');
  assert.equal(byThread.t4.attachmentKind, 'region');
  for (const t of p.threads) for (const a of t.attachments) assert.ok(path.isAbsolute(a) && fs.existsSync(a), a);
  assert.ok(written.includes(`\n  image: ${abs(a1.path)}  (Read it to see what the reviewer snipped)\n`));
  assert.ok(written.includes(`\n  image: ${abs(a3.path)}  (Read it to see the image the reviewer attached)\n`));
  assert.ok(written.includes(`\n  crop: ${abs(a4.path)}  (Read it to see the region)\n`));

  // ---- show: the same lines (engine result + the CLI's src>/image: lines)
  const s1 = /** @type {any} */ (await ops.show(ctx, DOC, { thread: 't1' }));
  assert.equal(s1.attachmentKind, 'snip');
  assert.deepEqual(s1.attachments, [abs(a1.path)]);
  const text1 = withThreadSource(formatThread(s1), s1);
  assert.match(text1, /^\[t1\] comment · OPEN · anchor exact \(v1 L29-39\) · snip \(image \+ diagram \+ quote\)$/m);
  assert.ok(text1.includes(`  image: ${abs(a1.path)}  (Read it to see what the reviewer snipped)`), text1);
  const s3 = /** @type {any} */ (await ops.show(ctx, DOC, { thread: 't3' }));
  assert.ok(withThreadSource(formatThread(s3), s3).includes(`  image: ${abs(a3.path)}  (Read it to see the image the reviewer attached)`));

  // ---- the agent edits above both snips and records v2: the snips move, the boxed one keeps its box
  editFile(ws.file('docs/kitchen-sink.md'), '## 2 Architecture\n', '## 2 Architecture\n\nThe diagram below is normative.\n');
  const r = await ops.revise(ctx, DOC, {
    summary: 'note on the diagram',
    threads: { t1: { status: 'answered', reply: 'It forwards them; see the note.' }, t2: { status: 'answered', reply: 'Yes.' } },
    other: [{ at: 'L29', why: 'clarify that the diagram is normative' }],
  });
  assert.equal(r.refused, false, JSON.stringify(r.guards));
  const t1 = /** @type {any} */ (await ctx.store.getThread(DOC, 't1'));
  const t2 = /** @type {any} */ (await ctx.store.getThread(DOC, 't2'));
  assert.equal(t1.anchors['2'].state, 'moved');
  assert.deepEqual([t1.anchors['2'].src.startLine, t1.anchors['2'].src.endLine], [31, 41]);
  assert.equal(t2.anchors['2'].state, 'moved');
  const v2 = await ctx.render(await ctx.store.getDoc(DOC), 2);
  assert.equal(v2.srcmap.nodes[t2.anchors['2'].snip.container.srid].k, 'mermaid');
  const t2target = (await ops.domTargets(ctx, DOC, 2)).threads.find((x) => x.id === 't2');
  assert.deepEqual({ kind: t2target?.kind, region: t2target?.region }, { kind: 'element', region: boxed.region });
});
