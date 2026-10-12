// @ts-check
// `suiko show <doc> <tid>` text against the REAL engine: the thread must carry the working-copy `src>` lines
// (an Edit old_string) and the `crop:` path of an image region, like a packet item does. Packet overflow lines
// ("suiko show <doc> t21") and the skill ("the user mentions t4") send the agent to `show`, so without them
// the agent had only the rendered `on:` quote and could not see the region the reviewer drew. Also covers the
// MCP tool (same execute()) and withThreadSource() on its own (no duplicates when a formatter already prints them).

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HAS_ENGINE = fs.existsSync(path.resolve(HERE, '../../src/core/review/ops.js'));
const DOC = 'kitchen-sink';

const { main } = await import('../../src/cli/main.js');
const { memorySink } = await import('../../src/cli/io.js');
const { threadSourceLines, withThreadSource } = await import('../../src/cli/format.js');

/** @type {any} */
let h = null;
/** @type {any} */
let ops = null;
/** @type {any} */
let ws = null;
/** @type {any} */
let ctx = null;

before(async () => {
  if (!HAS_ENGINE) return;
  h = await import('../helpers/engine.js');
  ops = await import('../../src/core/review/index.js');
  ws = await h.makeWorkspace(); // also points SPECREVIEW_HOME at a temp dir
  fs.mkdirSync(path.join(ws.root, '.git'));
  ctx = await h.engineCtx(ws.root);
});
after(async () => {
  if (ws) await ws.cleanup();
});

/** @param {string[]} argv */
async function cli(argv) {
  const out = memorySink();
  const err = memorySink();
  const code = await main(argv, {
    cwd: ws.root,
    env: { SPECREVIEW_BROWSER: 'none', SPECREVIEW_HOME: /** @type {string} */ (process.env.SPECREVIEW_HOME), CLAUDECODE: '1' },
    stdin: Readable.from([]),
    stdout: out,
    stderr: err,
    ensureDaemon: async () => /** @type {any} */ ({ pid: 1, uiPort: 5871, contentPort: 5872, token: 'tok', secret: 's', version: '0.1.0', startedAt: '' }),
    openBrowser: async () => {},
    pollMs: 50,
  });
  return { code, stdout: out.text(), stderr: err.text() };
}

const LINE = 'Refresh tokens are rotated on every use, and the previous token is invalidated';

describe('show <doc> <tid> prints src> and crop like a packet item', { skip: HAS_ENGINE ? false : 'src/core/review/ops.js not present' }, () => {
  test('setup: open, a text comment (t1) and an image region with a crop (t2)', async () => {
    assert.equal((await cli(['open', 'docs/kitchen-sink.md'])).code, 0);
    const doc = await ctx.store.getDoc(DOC);
    const render = await ctx.render(doc, doc.head);
    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: h.textCapture(render, 'rotated on every use'), body: 'Use a 30 s grace window.' });
    const crop = await ops.saveAttachment(ctx, DOC, { dataUrl: h.TINY_PNG });
    const img = h.findSrid(render, (/** @type {any} */ n) => n.t === 'img');
    await ops.saveDraft(ctx, DOC, {
      kind: 'thread', type: 'question', capture: h.elementCapture(render, img, { region: { x: 0.4, y: 0.1, w: 0.22, h: 0.2 } }), body: 'Which arrow is async?', attachments: [crop.path],
    });
    await ops.submitReview(ctx, DOC, { verdict: 'changes_requested', body: '' });
  });

  test('text thread: src> follows on: and is an exact, unique substring of the file', async () => {
    const r = await cli(['show', DOC, 't1']);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.split('\n');
    assert.match(lines[0], /^\[t1\] comment · OPEN · anchor exact \(v1 L(\d+)\)$/);
    assert.equal(lines[1], '  on: "rotated on every use"');
    assert.equal(lines[2], `  src> ${LINE}`);
    assert.equal(lines[3], '  v1 Eric (rv1): Use a 30 s grace window.');
    assert.doesNotMatch(r.stdout, /working copy:|crop:|image:|shortened/);
    const file = ws.read('docs/kitchen-sink.md');
    assert.equal(file.split(LINE).length, 2, 'src> is a unique Edit old_string');
  });

  test('image region thread: src> and the absolute crop path (a readable file)', async () => {
    const r = await cli(['show', DOC, 't2']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^\[t2\] question · OPEN · anchor exact \(v1 L\d+\) · <img alt="System overview"> region x40-62% y10-30%$/m);
    assert.match(r.stdout, /^ {2}src> !\[System overview\]\(\.\/img\/arch\.png/m);
    const m = /^ {2}crop: (\S+) {2}\(Read it to see the region\)$/m.exec(r.stdout);
    assert.ok(m, r.stdout);
    assert.ok(path.isAbsolute(m[1]) && m[1].endsWith(path.join('attachments', 'a1.png')), m[1]);
    assert.ok(fs.existsSync(m[1]), 'the crop path exists');
    // the crop/src lines come before the conversation
    assert.ok(r.stdout.indexOf('crop: ') < r.stdout.indexOf('Eric (rv1)'));
    // --json is unchanged: it already carried src and the absolute attachments path
    const j = JSON.parse((await cli(['show', DOC, 't2', '--json'])).stdout);
    assert.deepEqual(j.attachments, [m[1]]);
  });

  test('unrecorded edits above the anchor: the working-copy lines are named and src> is still exact', async () => {
    const before = ws.read('docs/kitchen-sink.md');
    try {
      h.editFile(ws.file('docs/kitchen-sink.md'), '### 3.2 Token refresh', 'Inserted line.\n\n### 3.2 Token refresh');
      const r = await cli(['show', DOC, 't1']);
      assert.equal(r.code, 0, r.stderr);
      const head = Number(/anchor exact \(v1 L(\d+)\)/.exec(r.stdout)?.[1]);
      const lines = r.stdout.split('\n');
      assert.equal(lines[2], `  working copy: L${head + 2}`);
      assert.equal(lines[3], `  src> ${LINE}`);
      assert.equal(ws.read('docs/kitchen-sink.md').split('\n')[head + 1], LINE, 'the named working-copy line holds the src> text');
    } finally {
      ws.write('docs/kitchen-sink.md', before);
    }
  });

  test('MCP suiko_show returns the same text (src> and crop:)', async () => {
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const { callTool } = await import('../../src/mcp/server.js');
    const tool = /** @type {any} */ (TOOLS.find((t) => t.name === 'suiko_show'));
    const res = await callTool(tool, { doc: DOC, thread_id: 't2' }, null, { cwd: ws.root, env: { SPECREVIEW_BROWSER: 'none', SPECREVIEW_HOME: process.env.SPECREVIEW_HOME, CLAUDECODE: '1' } });
    assert.equal(res.isError, undefined, res.content[0].text);
    assert.match(res.content[0].text, /^ {2}src> !\[System overview\]/m);
    assert.match(res.content[0].text, /^ {2}crop: \S+a1\.png {2}\(Read it to see the region\)$/m);
  });
});

describe('withThreadSource / threadSourceLines', () => {
  const show = (/** @type {Record<string, any>} */ extra = {}) => ({
    kind: 'thread',
    thread: { id: 't4', type: 'comment', status: 'open', comments: [] },
    anchor: { state: 'exact', v: 2, lines: [10, 11] },
    workingLines: [10, 11],
    label: 'text',
    on: 'quoted',
    src: 'line ten\nline eleven',
    srcUnique: true,
    attachments: [],
    ...extra,
  });

  test('inserts after on:, else after the header; never duplicates what the formatter printed', () => {
    assert.equal(
      withThreadSource('[t4] comment\n  on: "quoted"\n  v2 Eric (rv1): hi', show()),
      '[t4] comment\n  on: "quoted"\n  src> line ten\n  src> line eleven\n  v2 Eric (rv1): hi',
    );
    assert.equal(withThreadSource('[t4] comment\n  v2 Eric (rv1): hi', show()), '[t4] comment\n  src> line ten\n  src> line eleven\n  v2 Eric (rv1): hi');
    const already = '[t4] comment\n  src> line ten\n  src> line eleven\n  crop: /a.png  (Read it to see the region)\n  v2 Eric (rv1): hi';
    assert.equal(withThreadSource(already, show({ label: 'region', attachments: ['/a.png'] })), already);
    // a comment body line that happens to start with "src>" is indented deeper and does not count
    assert.match(withThreadSource('[t4] comment\n  v2 Eric (rv1): see\n    src> x', show()), /^ {2}src> line ten$/m);
  });

  test('notes and attachment kinds follow the packet rules; nothing for orphaned/doc threads or bare Threads', () => {
    assert.deepEqual(threadSourceLines(show({ srcUnique: false, workingLines: [12, 13] })), [
      '  working copy: L12-13',
      '  src> line ten',
      '  src> line eleven',
      '  (src> is shortened or not unique; Read around L12-13 before editing)',
    ]);
    assert.deepEqual(threadSourceLines(show({ src: 'x data:image/png;base64,...(2 KB)', srcEditable: false })), [
      '  src> x data:image/png;base64,...(2 KB)',
      '  (data: URIs elided above; Read the file for the exact text)',
    ]);
    assert.deepEqual(threadSourceLines(show({ src: null, workingLines: null, label: '<img alt="x">', attachments: ['/abs/a1.png'] })), [
      '  image: /abs/a1.png  (Read it to see the image the reviewer attached)',
    ]);
    // the engine says what the attachments are (show().attachmentKind); the label is only a fallback
    assert.deepEqual(threadSourceLines(show({ src: null, workingLines: null, label: 'snip (figure + 2 paragraphs)', attachmentKind: 'snip', attachments: ['/abs/a2.png'] })), [
      '  image: /abs/a2.png  (Read it to see what the reviewer snipped)',
    ]);
    assert.deepEqual(threadSourceLines(show({ src: null, workingLines: null, label: 'GENERAL', attachmentKind: 'image', attachments: ['/abs/a3.png'] })), [
      '  image: /abs/a3.png  (Read it to see the image the reviewer attached)',
    ]);
    assert.deepEqual(threadSourceLines(show({ src: null, workingLines: null, label: '<img alt="x"> region x1-2% y1-2%', attachments: ['/abs/a4.png'] })), [
      '  crop: /abs/a4.png  (Read it to see the region)',
    ]);
    assert.deepEqual(threadSourceLines(show({ src: null, workingLines: null, anchor: null })), []);
    const bare = { id: 't4', type: 'comment', comments: [], src: 'x' };
    assert.equal(withThreadSource('[t4] comment', bare), '[t4] comment');
  });
});
