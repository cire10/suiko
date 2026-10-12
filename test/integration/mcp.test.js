// @ts-check
// WP4 MCP server tests. In-process: createMcpServer() with a stub engine, driven over the SDK's InMemoryTransport by
// a minimal JSON-RPC client (initialize, tools/list, tools/call, progress, cancellation). Out-of-process: spawn
// `suiko mcp` and speak JSON-RPC over stdio (stdout must carry JSON-RPC only).

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/server';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-home-mcp-'));
process.env.SPECREVIEW_HOME = HOME;
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/suiko.js');

const { makeWorkspace, packetText, samplePacket, stubEngine } = await import('./helpers/cli-harness.js');
const { createMcpServer } = await import('../../src/mcp/server.js');
const { TOOLS } = await import('../../src/mcp/tools.js');

/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
before(async () => {
  ws = await makeWorkspace();
});
after(() => {
  ws.cleanup();
  fs.rmSync(HOME, { recursive: true, force: true });
});

/**
 * Connects a server built with a stub engine to an in-memory JSON-RPC client.
 * @param {Record<string, Function>} [overrides]
 * @param {Record<string, any>} [extraDeps]
 */
async function connect(overrides = {}, extraDeps = {}) {
  const engine = stubEngine(ws.store, overrides);
  const server = createMcpServer({
    ops: engine.ops,
    createContext: engine.createContext,
    cwd: ws.root,
    env: { SPECREVIEW_BROWSER: 'none', SPECREVIEW_HOME: HOME, CLAUDECODE: '1' },
    ensureDaemon: async () => /** @type {any} */ ({ pid: 1, uiPort: 5811, contentPort: 5812, token: 'tk', secret: 's', version: '0.1.0', startedAt: '' }),
    ...extraDeps,
  });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  /** @type {Map<number, (m: any) => void>} */
  const pending = new Map();
  /** @type {any[]} */
  const notifications = [];
  client.onmessage = (/** @type {any} */ m) => {
    if (m.id !== undefined && pending.has(m.id)) {
      /** @type {(m: any) => void} */ (pending.get(m.id))(m);
      pending.delete(m.id);
    } else if (m.method) notifications.push(m);
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
  assert.equal(init.result.serverInfo.name, 'suiko');
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  /** @param {string} name @param {any} args @param {any} [meta] */
  const call = async (name, args, meta) => (await request('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) })).result;
  return { engine, request, call, client, notifications, nextIdPeek: () => nextId + 1, close: () => server.close() };
}

describe('mcp (in-process)', () => {
  test('tools/list exposes every tool with JSON schemas', async () => {
    const c = await connect();
    const res = await c.request('tools/list', {});
    const names = res.result.tools.map((/** @type {any} */ t) => t.name).sort();
    const expected = [
      'suiko_apply', 'suiko_ask', 'suiko_diff', 'suiko_edit', 'suiko_feedback', 'suiko_final',
      'suiko_log', 'suiko_open', 'suiko_reanchor', 'suiko_reply', 'suiko_revert', 'suiko_review', 'suiko_revise',
      'suiko_show', 'suiko_snapshot', 'suiko_status', 'suiko_threads', 'suiko_wait',
    ];
    assert.deepEqual(names, expected);
    assert.equal(TOOLS.length, expected.length);
    const wait = res.result.tools.find((/** @type {any} */ t) => t.name === 'suiko_wait');
    assert.equal(wait.inputSchema.properties.timeout_sec.maximum, 600);
    const revise = res.result.tools.find((/** @type {any} */ t) => t.name === 'suiko_revise');
    assert.deepEqual(revise.inputSchema.required.sort(), ['doc', 'summary', 'threads']);
    assert.equal(revise.inputSchema.properties.force, undefined);
    // the network tool: public hosts through the default reader only
    const snap = res.result.tools.find((/** @type {any} */ t) => t.name === 'suiko_snapshot');
    assert.deepEqual(Object.keys(snap.inputSchema.properties).sort(), ['title', 'url', 'workspace']);
    assert.equal(snap.annotations.openWorldHint, true);
    await c.close();
  });

  test('suiko_snapshot refuses a private host and an offline environment without fetching', async () => {
    const c = await connect();
    const priv = await c.call('suiko_snapshot', { url: 'http://127.0.0.1:9/spec.html' });
    assert.equal(priv.isError, true);
    assert.match(priv.content[0].text, /non-public address/);
    await c.close();
    const off = await connect({}, { env: { SPECREVIEW_BROWSER: 'none', SPECREVIEW_HOME: HOME, SPECREVIEW_OFFLINE: '1' } });
    const r = await off.call('suiko_snapshot', { url: 'https://example.com/' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /network is turned off/);
    await off.close();
  });

  test('suiko_feedback: CLI text as content, packet as structuredContent', async () => {
    const c = await connect();
    const r = await c.call('suiko_feedback', { doc: 'token-service', peek: true });
    assert.equal(r.isError, undefined);
    assert.match(r.content[0].text, /^SPECREVIEW FEEDBACK · token-service/);
    assert.equal(r.structuredContent.doc, 'token-service');
    assert.equal(r.structuredContent.threads[0].id, 't1');
    assert.equal(c.engine.calls.find((x) => x.name === 'feedback')?.args[2].peek, true);
    assert.equal(c.engine.calls.find((x) => x.name === 'createContext')?.args[0].agent, 'claude');
    await c.close();
  });

  test('suiko_open returns {doc, version, url}', async () => {
    const c = await connect({
      openDoc: async (/** @type {any} */ ctx) => ({ doc: await ctx.store.getDoc('token-service'), version: 1, created: false, workingDirty: false }),
    });
    const r = await c.call('suiko_open', { path: ws.file });
    assert.equal(r.isError, undefined, r.content[0].text);
    assert.equal(r.structuredContent.doc, 'token-service');
    assert.equal(r.structuredContent.version, 1);
    assert.equal(r.structuredContent.url, `http://127.0.0.1:5811/d/${ws.store.wsId}/token-service?k=tk`);
    assert.match(r.content[0].text, /review UI: http:\/\/127\.0\.0\.1:5811\//);
    await c.close();
  });

  test('suiko_revise maps arguments; a refusal is isError', async () => {
    const c = await connect();
    const ok = await c.call('suiko_revise', {
      doc: 'token-service',
      summary: 'rv1 fixes',
      threads: { t1: { status: 'addressed', reply: 'Done.', at: 'L5-7' } },
      other: [{ at: 'h2', why: 'typo' }],
      break_locks: { L1: 'user asked' },
      dry_run: true,
    });
    assert.equal(ok.isError, undefined, ok.content[0].text);
    assert.deepEqual(c.engine.calls.find((x) => x.name === 'revise')?.args[2], {
      summary: 'rv1 fixes',
      threads: { t1: { status: 'addressed', reply: 'Done.', at: 'L5-7' } },
      other: [{ at: 'h2', why: 'typo' }],
      breakLocks: { L1: 'user asked' },
      dryRun: true,
    });
    const refused = await c.call('suiko_revise', { doc: 'token-service', summary: 'refuse-me', threads: {} });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /^suiko: REFUSED - nothing recorded/);
    assert.equal(refused.structuredContent.refused, true);
    await c.close();
  });

  test('errors: not found and invalid arguments are isError', async () => {
    const c = await connect();
    const nf = await c.call('suiko_reply', { doc: 'token-service', thread_id: 't404', body: 'x' });
    assert.equal(nf.isError, true);
    assert.equal(nf.structuredContent.error.exit, 4);
    assert.match(nf.content[0].text, /^suiko: thread not found: t404/);
    const bad = await c.call('suiko_apply', { doc: 'token-service', thread_ids: [] });
    assert.equal(bad.isError, true);
    const doc = await c.call('suiko_log', { doc: 'nope' });
    assert.equal(doc.isError, true);
    assert.equal(doc.structuredContent.error.code, 'NOT_FOUND');
    await c.close();
  });

  test('suiko_log without doc uses the only doc', async () => {
    const c = await connect();
    const r = await c.call('suiko_log', {});
    assert.equal(r.isError, undefined, r.content[0].text);
    assert.equal(c.engine.calls.find((x) => x.name === 'log')?.args[1], 'token-service');
    await c.close();
  });

  test('suiko_wait: default 50 s bound; timeout -> {status: waiting}; closed -> {status: closed}', async () => {
    const c = await connect({ waitForFeedback: async () => ({ status: 'timeout' }) });
    const r = await c.call('suiko_wait', { doc: 'token-service' });
    assert.equal(r.isError, undefined);
    assert.deepEqual(r.structuredContent, { status: 'waiting', hint: 'call again' });
    assert.equal(c.engine.calls.find((x) => x.name === 'waitForFeedback')?.args[1].timeoutMs, 50000);
    const tooLong = await c.call('suiko_wait', { doc: 'token-service', timeout_sec: 601 });
    assert.equal(tooLong.isError, true);
    await c.close();
    const c2 = await connect({ waitForFeedback: async () => ({ status: 'closed', docId: 'token-service' }) });
    const closed = await c2.call('suiko_wait', { timeout_sec: 5 });
    assert.equal(closed.isError, undefined);
    assert.equal(closed.structuredContent.status, 'closed');
    await c2.close();
  });

  test('suiko_wait delivers the packet and sends progress notifications', async () => {
    const c = await connect(
      {
        waitForFeedback: async (/** @type {any} */ ctx, /** @type {any} */ opts) => {
          await new Promise((r) => setTimeout(r, 150));
          const p = samplePacket();
          await opts.write(packetText(p)); // text only, like WP3's engine; structuredContent comes from the result
          return { status: 'delivered', packets: [p], text: packetText(p) };
        },
      },
      { progressMs: 40 },
    );
    const r = await c.call('suiko_wait', { doc: 'token-service', timeout_sec: 5 }, { progressToken: 'tok-1' });
    assert.equal(r.isError, undefined);
    assert.match(r.content[0].text, /^SPECREVIEW FEEDBACK · token-service/);
    assert.equal(r.structuredContent.doc, 'token-service');
    const progress = c.notifications.filter((n) => n.method === 'notifications/progress');
    assert.ok(progress.length >= 1, `progress notifications: ${progress.length}`);
    assert.equal(progress[0].params.progressToken, 'tok-1');
    await c.close();
  });

  test('a cancelled suiko_wait aborts the engine wait and delivers nothing', async () => {
    /** @type {AbortSignal | null} */
    let seen = null;
    /** @type {string | null} */
    let lateWrite = null;
    const c = await connect({
      waitForFeedback: async (/** @type {any} */ ctx, /** @type {any} */ opts) => {
        seen = opts.signal;
        await new Promise((resolve) => opts.signal.addEventListener('abort', resolve, { once: true }));
        lateWrite = await opts.write(packetText(samplePacket())).then(() => 'written', (/** @type {Error} */ e) => e.message);
        return { status: 'timeout', packets: [], text: '', aborted: true };
      },
    });
    const id = c.nextIdPeek();
    c.call('suiko_wait', { doc: 'token-service', timeout_sec: 30 }); // never answered once cancelled
    const t0 = Date.now();
    while (!seen && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10));
    await c.client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'user' } });
    while (lateWrite === null && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
    assert.equal(/** @type {any} */ (seen)?.aborted, true);
    assert.match(String(lateWrite), /not delivering/);
    await c.close();
  });
});

describe('mcp (stdio process)', () => {
  test('`suiko mcp` answers initialize and tools/list; stdout is JSON-RPC only', async () => {
    const child = spawn(process.execPath, [BIN, 'mcp'], {
      cwd: ws.root,
      env: { PATH: process.env.PATH, HOME: os.homedir(), SPECREVIEW_BROWSER: 'none', SPECREVIEW_HOME: HOME },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    const send = (/** @type {any} */ m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const t0 = Date.now();
    while (out.split('\n').filter(Boolean).length < 2 && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 20));
    child.stdin.end();
    const code = await new Promise((resolve) => child.on('close', resolve));
    const lines = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines[0].id, 1);
    assert.equal(lines[0].result.serverInfo.name, 'suiko');
    assert.equal(lines[1].id, 2);
    assert.ok(lines[1].result.tools.some((/** @type {any} */ t) => t.name === 'suiko_wait'));
    assert.equal(code, 0);
  });
});
