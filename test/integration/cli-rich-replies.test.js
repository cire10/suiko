// @ts-check
// Batched edits and rich replies from the agent's and the reviewer's terminals, against the REAL engine (CLI main()
// in-process, the MCP server over an in-memory transport; the daemon is stubbed):
// - `suiko reply --status planned --attach <file>...` (JSON lists the stored attachments; refused files: exit 1, a
//   missing one: exit 4, nothing posted), `suiko revise --replies -` with threads.tN.attachments (the schema caps
//   them), `suiko threads --status planned`;
// - `suiko snip --send --edits batch` marks its one-item review as batched edits;
// - MCP: suiko_reply / suiko_revise take `attachments` and status planned; titles and server instructions describe
//   how to handle feedback (no "write the spec once").

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { InMemoryTransport } from '@modelcontextprotocol/server';

const h = await import('../helpers/engine.js');
const ops = await import('../../src/core/review/index.js');
const { main } = await import('../../src/cli/main.js');
const { memorySink } = await import('../../src/cli/io.js');
const { createMcpServer } = await import('../../src/mcp/server.js');

const DOC = 'kitchen-sink';
const PNG = Buffer.from(h.TINY_PNG.split(',')[1], 'base64');
const DAEMON = { pid: 1, uiPort: 5891, contentPort: 5892, token: 'tok', secret: 's', version: '0.1.0', startedAt: '' };

/** @type {any} */
let ws;
/** @type {any} */
let ctx;

before(async () => {
  ws = await h.makeWorkspace(); // points SPECREVIEW_HOME at a temp dir
  fs.mkdirSync(path.join(ws.root, '.git'));
  fs.mkdirSync(path.join(ws.root, 'out'));
  fs.writeFileSync(path.join(ws.root, 'out', 'chart.png'), PNG);
  fs.writeFileSync(path.join(ws.root, 'out', 'chart.html'), '<!doctype html><p>chart</p>\n');
  fs.writeFileSync(path.join(ws.root, 'out', 'notes.txt'), 'not attachable\n');
  ctx = await h.engineCtx(ws.root);
  const { doc } = await ops.openDoc(ctx, { path: 'docs/kitchen-sink.md' });
  const v1 = await ctx.render(doc, 1);
  await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: h.textCapture(v1, 'rotated on every use'), body: 'Show the rotation as a chart.' });
  await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'question', capture: { kind: 'doc' }, body: 'Why Redis?' });
  await ops.submitReview(ctx, DOC, { verdict: 'comment', edits: 'batch' });
});
after(async () => {
  if (ws) await ws.cleanup();
});

/**
 * Runs the CLI in-process against the real engine (ensureDaemon stubbed).
 * @param {string[]} argv
 * @param {{ input?: string }} [o]
 */
async function cli(argv, o = {}) {
  const out = memorySink();
  const err = memorySink();
  const code = await main(argv, {
    cwd: ws.root,
    env: { SPECREVIEW_BROWSER: 'none', SPECREVIEW_HOME: /** @type {string} */ (process.env.SPECREVIEW_HOME), CLAUDECODE: '1' },
    stdin: Readable.from(o.input !== undefined ? [Buffer.from(o.input)] : []),
    stdout: out,
    stderr: err,
    ensureDaemon: async () => /** @type {any} */ (DAEMON),
    openBrowser: async () => {},
    pollMs: 50,
  });
  return { code, stdout: out.text(), stderr: err.text() };
}

describe('CLI', () => {
  test('the batch packet, then reply --status planned --attach: stored, listed; refused files post nothing', async () => {
    const fb = await cli(['feedback', DOC]);
    assert.equal(fb.code, 0, fb.stderr);
    assert.match(fb.stdout, /^EDITS: batch\. Answer every thread now\./m);
    const said = fb.stdout.split('\n').filter((l) => /^(EDITS|NEXT):/.test(l));
    assert.equal(said.length, 2, fb.stdout);
    // waiting before answering is refused, and the refusal asks for planned replies, not edits
    const early = await cli(['wait', DOC, '--timeout', '200ms']);
    assert.equal(early.code, 3, early.stderr);
    assert.match(early.stderr, /^suiko: kitchen-sink: 2 threads you received still wait on your answer: t1 \(comment\), t2 \(question\)\./m);
    assert.ok(
      early.stderr.includes(
        '  Reply on each: `suiko revise kitchen-sink --replies -` (one entry per thread; batched edits: no edits yet, status "planned" with exactly what you will change), ' +
          'or `suiko reply kitchen-sink <tid> -m <answer> --status planned` (or answered, declined, needs_input; a reply without --status leaves the thread open).',
      ),
      early.stderr,
    );
    // the delivered round read again (`suiko feedback`, as the prompt hook says after a lost packet) says the same
    const again = await cli(['feedback', DOC]);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(again.stdout.split('\n').filter((l) => /^(EDITS|NEXT):/.test(l)), said);

    const bad = await cli(['reply', DOC, 't1', '-m', 'Planned.', '--status', 'planned', '--attach', 'out/notes.txt']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /reply to t1: out\/notes\.txt is not an attachable file \(allowed: \.png \.jpg \.jpeg \.gif \.webp \.svg \.html \.htm\)/);
    const missing = await cli(['reply', DOC, 't1', '-m', 'Planned.', '--status', 'planned', '--attach', 'out/nope.png']);
    assert.equal(missing.code, 4, missing.stderr);
    assert.equal((await ctx.store.getThread(DOC, 't1'))?.comments.length, 1, 'nothing posted');
    const status = await cli(['reply', DOC, 't1', '-m', 'x', '--status', 'later']);
    assert.equal(status.code, 1);
    assert.match(status.stderr, /--status must be one of addressed, answered, declined, needs_input, planned/);

    const r = await cli(['reply', DOC, 't1', '-m', 'I will add this chart under the rotation paragraph.', '--status', 'planned', '--attach', 'out/chart.png', '--attach', path.join(ws.root, 'out', 'chart.html')]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'replied on t1 (planned) · attached 2 files · no version recorded\n');
    const json = await cli(['threads', DOC, '--status', 'planned', '--json']);
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout).threads.map((/** @type {any} */ t) => [t.id, t.status, t.actionable]), [['t1', 'planned', false]]);
    const c = /** @type {any} */ (await ctx.store.getThread(DOC, 't1')).comments.at(-1);
    assert.deepEqual(c.attachments, [
      { path: 'attachments/a1.png', name: 'chart.png', kind: 'image' },
      { path: 'attachments/a2.html', name: 'chart.html', kind: 'html' },
    ]);
  });

  test('revise --replies - takes attachments per thread (the schema caps them); the wait is not refused by a planned thread', async () => {
    const tooMany = await cli(['revise', DOC, '--replies', '-'], { input: JSON.stringify({ threads: { t2: { status: 'answered', reply: 'x', attachments: Array(7).fill('out/chart.png') } } }) });
    assert.equal(tooMany.code, 1);
    assert.match(tooMany.stderr, /invalid --replies JSON: threads\.t2\.attachments: at most 6 files per reply/);
    const r = await cli(['revise', DOC, '--replies', '-'], { input: JSON.stringify({ threads: { t2: { status: 'answered', reply: 'Latency; see the chart.', attachments: ['out/chart.png'] } } }) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^ {2}t2 answered \(\+1 file\)$/m);
    const w = await cli(['wait', DOC, '--timeout', '200ms']);
    assert.equal(w.code, 2, `timeout, not refused: ${w.stderr}`);
  });

  test('snip --send --edits batch: the one-item review asks for batched edits', async () => {
    const bad = await cli(['snip', DOC, '--file', 'out/chart.png', '--edits', 'batch']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--edits applies to --send/);
    assert.equal((await cli(['snip', DOC, '--file', 'out/chart.png', '--send', '--edits', 'soon'])).code, 1);
    const r = await cli(['snip', DOC, '--file', 'out/chart.png', '--send', '--edits', 'batch', '-m', 'This screen too.', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const review = await ctx.store.getReview(DOC, JSON.parse(r.stdout).review);
    assert.equal(review?.edits, 'batch');
  });
});

describe('MCP', () => {
  /** @param {Record<string, any>} [extra] */
  async function connect(extra = {}) {
    const server = createMcpServer({
      cwd: ws.root,
      env: { SPECREVIEW_BROWSER: 'none', SPECREVIEW_HOME: /** @type {string} */ (process.env.SPECREVIEW_HOME), CLAUDECODE: '1' },
      ensureDaemon: async () => /** @type {any} */ (DAEMON),
      ...extra,
    });
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    /** @type {Map<number, (m: any) => void>} */
    const pending = new Map();
    client.onmessage = (/** @type {any} */ m) => {
      if (m.id !== undefined && pending.has(m.id)) {
        /** @type {(m: any) => void} */ (pending.get(m.id))(m);
        pending.delete(m.id);
      }
    };
    await server.connect(serverSide);
    await client.start();
    let nextId = 0;
    /** @param {string} method @param {any} params @returns {Promise<any>} */
    const request = (method, params) =>
      new Promise((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        client.send({ jsonrpc: '2.0', id, method, params });
      });
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return { init, request, close: () => server.close() };
  }

  test('tools take attachments and planned; titles and instructions describe handling feedback only', async () => {
    const c = await connect();
    const instructions = String(c.init.result.instructions);
    assert.doesNotMatch(instructions, /write the spec|spec once|specs\b/i);
    assert.match(instructions, /EDITS: batch/);
    assert.match(instructions, /APPLY packet/);
    assert.match(instructions, /use: line/);
    const tools = (await c.request('tools/list', {})).result.tools;
    const tool = (/** @type {string} */ n) => tools.find((/** @type {any} */ t) => t.name === n);
    assert.equal(tool('suiko_open').title, 'Open a document for review');
    assert.doesNotMatch(tool('suiko_open').description, /\bspecs?\b/i);
    assert.equal(tool('suiko_final').title, 'Finalize an approved document');
    const reply = tool('suiko_reply').inputSchema.properties;
    assert.ok(reply.status.enum.includes('planned'));
    assert.equal(reply.attachments.type, 'array');
    assert.equal(reply.attachments.maxItems, 6);
    const reviseThread = tool('suiko_revise').inputSchema.properties.threads.additionalProperties;
    assert.ok(reviseThread.properties.status.enum.includes('planned'));
    assert.equal(reviseThread.properties.attachments.type, 'array');
    await c.close();
  });

  test('suiko_reply attaches files; suiko_revise posts planned replies with attachments', async () => {
    const c = await connect();
    // a new thread for the MCP replies
    const v1 = await ctx.render(await ctx.store.requireDoc(DOC), 1);
    await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', capture: h.textCapture(v1, 'Prototype the issuer.'), body: 'Sketch the issuer.' });
    const rv = await ops.submitReview(ctx, DOC, { verdict: 'comment', edits: 'batch' });
    const tid = rv.newThreads[0];
    let r = (await c.request('tools/call', { name: 'suiko_reply', arguments: { doc: DOC, thread_id: tid, body: 'A sketch.', status: 'answered', attachments: [path.join(ws.root, 'out', 'chart.html')] } })).result;
    assert.equal(r.isError, undefined, r.content[0].text);
    assert.deepEqual(r.structuredContent.attachments.map((/** @type {any} */ a) => [a.name, a.kind]), [['chart.html', 'html']]);
    r = (await c.request('tools/call', { name: 'suiko_reply', arguments: { doc: DOC, thread_id: tid, body: 'x', attachments: ['out/notes.txt'] } })).result;
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /not an attachable file/);
    r = (await c.request('tools/call', { name: 'suiko_revise', arguments: { doc: DOC, summary: 'plan', threads: { [tid]: { status: 'planned', reply: 'I will add the sketch.', attachments: ['out/chart.png'] } } } })).result;
    assert.equal(r.isError, undefined, r.content[0].text);
    const t = /** @type {any} */ (await ctx.store.getThread(DOC, tid));
    assert.equal(t.status, 'planned');
    assert.equal(t.comments.at(-1).attachments[0].name, 'chart.png');
    await c.close();
  });
});
