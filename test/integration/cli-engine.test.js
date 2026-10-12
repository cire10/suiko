// @ts-check
// WP4 against the REAL review engine (src/core/review, WP3) and store (WP1): the CLI (main() in-process, plus real
// `bin/suiko.js` processes for wait supersede/interrupt), the hooks and the MCP server drive one review loop
// on test/fixtures/docs/kitchen-sink.md. The reviewer's side (drafts, submit) is played through the engine ops,
// like the daemon would. The daemon itself is stubbed (ensureDaemon); test/integration/cli-daemon-client.test.js
// covers the daemon lifecycle. Skipped when the engine is not installed.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '../../bin/suiko.js');
const ENGINE = path.resolve(HERE, '../../src/core/review/ops.js');
const HAS_ENGINE = fs.existsSync(ENGINE);
const DOC = 'kitchen-sink';

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
  fs.mkdirSync(path.join(ws.root, '.git')); // the workspace root is the "repository" root
  ctx = await h.engineCtx(ws.root);
});
after(async () => {
  if (ws) await ws.cleanup();
});

const { main } = await import('../../src/cli/main.js');
const { memorySink } = await import('../../src/cli/io.js');
const { runHook } = await import('../../src/cli/hooks.js');

/**
 * Runs the CLI in-process against the real engine (ensureDaemon stubbed).
 * @param {string[]} argv
 * @param {{ input?: string, stdout?: any, env?: Record<string, string> }} [o]
 */
async function cli(argv, o = {}) {
  const out = o.stdout ?? memorySink();
  const err = memorySink();
  const code = await main(argv, {
    cwd: ws.root,
    env: { SPECREVIEW_BROWSER: 'none', SPECREVIEW_HOME: /** @type {string} */ (process.env.SPECREVIEW_HOME), CLAUDECODE: '1', ...(o.env ?? {}) },
    stdin: Readable.from(o.input !== undefined ? [Buffer.from(o.input)] : []),
    stdout: out,
    stderr: err,
    ensureDaemon: async () => /** @type {any} */ ({ pid: 1, uiPort: 5871, contentPort: 5872, token: 'tok', secret: 's', version: '0.1.0', startedAt: '' }),
    openBrowser: async () => {},
    pollMs: 50,
  });
  return { code, stdout: out.text(), stderr: err.text() };
}

/**
 * Runs a hook in-process and returns its parsed output (null when silent).
 * @param {'pre-write' | 'prompt'} name
 * @param {any} payload
 */
async function hook(name, payload) {
  const out = memorySink();
  await runHook(name, { stdin: Readable.from([Buffer.from(JSON.stringify(payload))]), stdout: out, env: { SPECREVIEW_BROWSER: 'none', SPECREVIEW_HOME: process.env.SPECREVIEW_HOME }, cwd: ws.root });
  return out.text() ? JSON.parse(out.text()) : null;
}

/** @param {string} id */
function reviewFile(id) {
  return path.join(ws.root, '.specreview', 'docs', DOC, 'reviews', `${id}.json`);
}

/**
 * Spawns `suiko <args>` as a real process in the workspace.
 * @param {string[]} args
 */
function spawnCli(args) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: ws.root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SPECREVIEW_BROWSER: 'none', SPECREVIEW_HOME: process.env.SPECREVIEW_HOME, CLAUDECODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, done, err: () => stderr };
}

/** @param {() => boolean | Promise<boolean>} cond */
async function until(cond, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Reviewer submits a review with a comment on `quote` (and optionally a suggestion), via the engine ops. */
async function reviewerSubmits({ quote = 'rotated on every use', suggestion = null, verdict = 'changes_requested', body = 'Good start.' } = {}) {
  const doc = await ctx.store.getDoc(DOC);
  const render = await ctx.render(doc, doc.head);
  await ops.saveDraft(ctx, DOC, { kind: 'thread', type: 'comment', severity: 'blocking', capture: h.textCapture(render, quote), body: 'Use a 30 s grace window.' });
  if (suggestion) {
    await ops.saveDraft(ctx, DOC, {
      kind: 'thread', type: 'suggestion', capture: h.textCapture(render, suggestion.old), body: 'Name where it runs.', suggestion: { mode: 'text', new: suggestion.new },
    });
  }
  return ops.submitReview(ctx, DOC, { verdict, body });
}

describe('CLI + hooks + MCP against the real engine', { skip: HAS_ENGINE ? false : 'src/core/review/ops.js not present' }, () => {
  test('open: tracks the doc, records v1, prints the design 3.2 lines; re-open reports it', async () => {
    const r = await cli(['open', 'docs/kitchen-sink.md']);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.split('\n');
    assert.match(lines[0], /^suiko: tracking docs\/kitchen-sink\.md as "kitchen-sink" \(markdown, \d+ lines\) · recorded v1$/);
    assert.equal(lines[1], `review UI: http://127.0.0.1:5871/d/${ctx.wsId}/kitchen-sink?k=tok`);
    assert.doesNotMatch(r.stdout, /external hosts/, 'a plain <a href> is not loaded live');
    assert.match(r.stdout, /^next: run `suiko wait kitchen-sink` in the background$/m);
    const again = await cli(['open', 'docs/kitchen-sink.md', '--json']);
    assert.equal(again.code, 0, again.stderr);
    const j = JSON.parse(again.stdout);
    assert.equal(j.doc, DOC);
    assert.equal(j.version, 1);
    assert.equal(j.created, false);
    assert.equal(j.url, `http://127.0.0.1:5871/d/${ctx.wsId}/kitchen-sink?k=tok`);
  });

  test('wait with nothing submitted times out (exit 2) and removes its waiter', async () => {
    const r = await cli(['wait', DOC, '--timeout', '300ms']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^suiko: waiting for a review of kitchen-sink v1 \(as claude\)\. Safe to interrupt; nothing is lost\.$/m);
    assert.deepEqual(await ctx.store.listWaiters(DOC, { liveOnly: false }), []);
  });

  test('round 1: hook prompt reports the undelivered review; wait --json prints the packet before recording the delivery', async () => {
    await reviewerSubmits({ suggestion: { old: 'Prototype the issuer.', new: 'Prototype the issuer behind the gateway.' } });
    const st = await cli(['status', '--json']);
    assert.deepEqual(JSON.parse(st.stdout).docs[0].undelivered, ['rv1']);

    const note = await hook('prompt', { hook_event_name: 'UserPromptSubmit', cwd: ws.root, prompt: 'done' });
    assert.match(note.hookSpecificOutput.additionalContext, /^suiko: review rv1 on kitchen-sink \(2 threads, CHANGES REQUESTED\) was submitted at \d\d:\d\d and not delivered\. Run `suiko feedback kitchen-sink`/);

    // a stdout that records the delivery state at the moment each chunk is written
    const sink = memorySink();
    /** @type {any[]} */
    const deliveredAtWrite = [];
    const write = sink.write.bind(sink);
    /** @type {any} */ (sink).write = (/** @type {any} */ chunk, /** @type {any} */ a, /** @type {any} */ b) => {
      deliveredAtWrite.push(JSON.parse(fs.readFileSync(reviewFile('rv1'), 'utf8')).deliveredTo?.claude ?? null);
      return write(chunk, a, b);
    };
    const r = await cli(['wait', DOC, '--json'], { stdout: sink });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(deliveredAtWrite, [null], 'the packet reached stdout before rv1 was marked delivered');
    const packet = JSON.parse(r.stdout);
    assert.equal(packet.doc, DOC);
    assert.deepEqual(packet.threads.map((/** @type {any} */ t) => [t.id, t.type]), [['t2', 'suggestion'], ['t1', 'comment']]);
    assert.ok(JSON.parse(fs.readFileSync(reviewFile('rv1'), 'utf8')).deliveredTo.claude, 'delivered after the write');

    assert.equal(await hook('prompt', { cwd: ws.root }), null, 'delivered recently: the prompt hook is silent');
    const again = await cli(['wait', DOC, '--timeout', '200ms']);
    assert.equal(again.code, 2, 'nothing left to deliver');
  });

  test('feedback --peek prints the text packet without delivering; threads lists both', async () => {
    const r = await cli(['feedback', DOC, '--peek']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^SPECREVIEW FEEDBACK · kitchen-sink/);
    const t = await cli(['threads', DOC]);
    assert.equal(t.code, 0, t.stderr);
    assert.match(t.stdout, /^t1 {2}open\* {2}comment blocking {2}L\d+ /m);
    assert.match(t.stdout, /^t2 {2}open\* {2}suggestion {2}L\d+ /m);
  });

  test('targeted edits: apply + edit --stdin batch (all or nothing); the pre-write hook denies a whole-file Write', async () => {
    const a = await cli(['apply', DOC, 't2']);
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, /^applied t2 at L\d+ \(exact\) · staged \(not recorded yet\)$/m);
    // a failing batch is all or nothing
    const beforeBatch = ws.read('docs/kitchen-sink.md');
    const bad = await cli(['edit', DOC, '--stdin'], {
      input: JSON.stringify([
        { threads: ['t1'], old: 'rotated on every use', new: 'rotated with a 30 s grace window' },
        { threads: ['t1'], old: 'text that is not in the spec', new: 'x' },
      ]),
    });
    assert.equal(bad.code, 3, bad.stderr);
    assert.equal(ws.read('docs/kitchen-sink.md'), beforeBatch, 'nothing applied');
    const e = await cli(['edit', DOC, '--stdin'], {
      input: JSON.stringify([
        { threads: ['t1'], old: 'rotated on every use', new: 'rotated with a 30 s grace window' },
        { threads: 't1', old: 'the previous token is invalidated', new: 'the previous token is revoked' },
      ]),
    });
    assert.equal(e.code, 0, e.stderr);
    assert.match(e.stdout, /^edited L\d+ for t1 · tagged \(not recorded yet\)\nedited L\d+ for t1 · tagged \(not recorded yet\)$/m);
    const dup = await cli(['edit', DOC, '--thread', 't1', '--old', 'the', '--new', 'THE']);
    assert.equal(dup.code, 3, 'old_string not unique -> refused');
    assert.match(dup.stderr, /^suiko: /);

    const deny = await hook('pre-write', { tool_name: 'Write', cwd: ws.root, tool_input: { file_path: 'docs/kitchen-sink.md', content: '# A brand new spec\n' } });
    assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(deny.hookSpecificOutput.permissionDecisionReason, /^docs\/kitchen-sink\.md is under Suiko \(v1, 2 open threads\)/);
    const current = ws.read('docs/kitchen-sink.md');
    assert.equal(await hook('pre-write', { tool_name: 'Write', cwd: ws.root, tool_input: { file_path: 'docs/kitchen-sink.md', content: `${current}\nOne more line.\n` } }), null);

    const d = await cli(['diff', DOC, 'v1..live']);
    assert.equal(d.code, 0, d.stderr);
    assert.match(d.stdout, /^v1\.\.live {2}\+2 -2 {2}2 hunks$/m);
  });

  test('revise: --dry-run records nothing; then v2 is recorded with replies (and acknowledges rv1)', async () => {
    const replies = JSON.stringify({
      summary: 'rv1: grace window, issuer',
      threads: { t1: { status: 'addressed', reply: 'Added a 30 s grace window.' }, t2: { status: 'addressed', reply: 'Applied.' } },
    });
    const dry = await cli(['revise', DOC, '--replies', '-', '--dry-run'], { input: replies });
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /^suiko: dry run - would record v2 for kitchen-sink/);
    assert.equal((await ctx.store.getDoc(DOC)).head, 1);
    const r = await cli(['revise', DOC, '--replies', '-', '--json'], { input: replies });
    assert.equal(r.code, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.version, 2);
    assert.equal(report.refused, false);
    assert.deepEqual(report.replies.map((/** @type {any} */ x) => x.thread).sort(), ['t1', 't2']);
    assert.ok(JSON.parse(fs.readFileSync(reviewFile('rv1'), 'utf8')).ackedBy?.claude, 'the agent op acknowledged rv1');
  });

  test('inspect: log, diff (default range), show thread, show old source, status', async () => {
    const log = await cli(['log', DOC]);
    assert.equal(log.code, 0, log.stderr);
    assert.match(log.stdout, /^v2 {2}agent claude {2}\d\d:\d\d {2}rv1: grace window, issuer/m);
    assert.match(log.stdout, /^ {4}rv1 {2}reviewer|^ {4}rv1 {2}\S+ {2}\d\d:\d\d {2}CHANGES_REQUESTED/m);
    assert.match(log.stdout, /^final: none$/m);
    const diff = await cli(['diff', DOC]);
    assert.match(diff.stdout, /^v1\.\.v2 {2}\+2 -2 {2}2 hunks$/m);
    assert.match(diff.stdout, /t1 \(tagged\)/);
    const uni = await cli(['diff', DOC, 'v1..v2', '--unified']);
    assert.match(uni.stdout, /^-Refresh tokens are rotated on every use, and the previous token is invalidated$/m);
    assert.match(uni.stdout, /^\+Refresh tokens are rotated with a 30 s grace window, and the previous token is revoked$/m);
    const show = await cli(['show', DOC, 't1']);
    assert.match(show.stdout, /^\[t1\] comment · blocking · ADDRESSED · anchor edited \(v2 L\d+\)$/m);
    const src = await cli(['show', DOC, '--version', '1', '--lines', '1-2']);
    assert.equal(src.stdout, '---\ntitle: Token Service Implementation Spec\n');
    for (const v of ['head', 'live', 'v2']) {
      const r = await cli(['show', DOC, '--version', v, '--lines', '2-2']);
      assert.equal(r.code, 0, `${v}: ${r.stderr}`);
      assert.equal(r.stdout, 'title: Token Service Implementation Spec\n');
    }
    const status = await cli(['status', DOC]);
    assert.match(status.stdout, /^kitchen-sink {2}docs\/kitchen-sink\.md {2}head v2 \(claude, \d\d:\d\d\) {2}in_review$/m);
  });

  test('reply, ask, reanchor, threads --status', async () => {
    const reply = await cli(['reply', DOC, 't1', '-m', 'See also section 3.', '--status', 'answered']);
    assert.equal(reply.code, 0, reply.stderr);
    assert.equal(reply.stdout, 'replied on t1 (answered) · no version recorded\n');
    assert.equal((await cli(['reply', DOC, 't99', '-m', 'x'])).code, 4);
    const ask = await cli(['ask', DOC, '--quote', 'Ship rotation behind a flag.', '-m', 'Which flag system?', '--json']);
    assert.equal(ask.code, 0, ask.stderr);
    assert.equal(JSON.parse(ask.stdout).type, 'agent-question');
    const re = await cli(['reanchor', DOC, 't1', '--lines', '3-4']);
    assert.equal(re.code, 0, re.stderr);
    assert.match(re.stdout, /^re-anchored t1 to L3-4/);
    const needs = await cli(['threads', DOC, '--status', 'needs_input', '--json']);
    assert.deepEqual(JSON.parse(needs.stdout).threads.map((/** @type {any} */ t) => t.type), ['agent-question']);
  });

  test('guards: an unexplained deletion is refused (exit 3, nothing recorded); revert --hunk restores it', async () => {
    const before = ws.read('docs/kitchen-sink.md');
    const start = before.indexOf('## 3 Tokens');
    const end = before.indexOf('### 3.2 Token refresh');
    ws.write('docs/kitchen-sink.md', before.slice(0, start) + before.slice(end));
    const r = await cli(['revise', DOC, '-m', 'cleanup']);
    assert.equal(r.code, 3);
    assert.match(r.stdout, /^suiko: REFUSED - nothing recorded/);
    assert.equal((await ctx.store.getDoc(DOC)).head, 2);
    const wait = await cli(['wait', DOC, '--timeout', '1s']);
    assert.equal(wait.code, 3, 'dirty working copy');
    assert.match(wait.stderr, /has unrecorded edits/);
    const hunk = /fix: suiko revert kitchen-sink --hunk (h\d+)/.exec(r.stdout)?.[1] ?? 'h1';
    const rev = await cli(['revert', DOC, '--hunk', hunk]);
    assert.equal(rev.code, 0, rev.stderr);
    assert.equal(ws.read('docs/kitchen-sink.md'), before);
  });

  test('MCP tools on the real engine: status, threads, feedback (peek), show, wait (delivered, then waiting)', async () => {
    const { InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { createMcpServer } = await import('../../src/mcp/server.js');
    const server = createMcpServer({ cwd: ws.root, env: { SPECREVIEW_BROWSER: 'none', SPECREVIEW_HOME: process.env.SPECREVIEW_HOME, CLAUDECODE: '1' } });
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
    let id = 0;
    /** @param {string} method @param {any} params @returns {Promise<any>} */
    const request = (method, params) =>
      new Promise((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        client.send({ jsonrpc: '2.0', id: n, method, params });
      });
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    /** @param {string} name @param {any} args */
    const call = async (name, args) => (await request('tools/call', { name, arguments: args })).result;
    try {
      const status = await call('suiko_status', {});
      assert.equal(status.isError, undefined, status.content[0].text);
      assert.equal(status.structuredContent.docs[0].doc, DOC);
      const threads = await call('suiko_threads', { doc: DOC, status: 'all' });
      assert.ok(threads.structuredContent.threads.length >= 3);
      const fb = await call('suiko_feedback', { doc: DOC, peek: true });
      assert.equal(fb.isError, undefined, fb.content[0].text);
      assert.match(fb.content[0].text, /^SPECREVIEW FEEDBACK · kitchen-sink/);
      assert.equal(fb.structuredContent.doc, DOC);
      assert.equal(fb.structuredContent.schema, 1);
      const show = await call('suiko_show', { doc: DOC, thread_id: 't1' });
      assert.match(show.content[0].text, /^\[t1\] /);
      const nf = await call('suiko_show', { doc: DOC, thread_id: 't404' });
      assert.equal(nf.isError, true);
      const rv = await reviewerSubmits({ quote: 'Remove the legacy session store.' });
      const delivered = await call('suiko_wait', { doc: DOC, timeout_sec: 5 });
      assert.equal(delivered.isError, undefined, delivered.content[0].text);
      assert.match(delivered.content[0].text, new RegExp(`^SPECREVIEW FEEDBACK · kitchen-sink · review ${rv.id} on v2 · CHANGES REQUESTED$`, 'm'));
      assert.equal(delivered.structuredContent.doc, DOC);
      assert.deepEqual(delivered.structuredContent.reviews.map((/** @type {any} */ r) => r.id), [rv.id]);
      assert.ok(JSON.parse(fs.readFileSync(reviewFile(rv.id), 'utf8')).deliveredTo.claude);
      const wait = await call('suiko_wait', { doc: DOC, timeout_sec: 1 });
      assert.deepEqual(wait.structuredContent, { status: 'waiting', hint: 'call again' });
    } finally {
      await server.close();
    }
  });

  test('approve: the packet says APPROVED and FINAL; final --decisions checks the working copy and writes the file', async () => {
    await ops.resolveThread(ctx, DOC, 't1', { decision: '30 s grace window' });
    const rv = await ops.submitReview(ctx, DOC, { verdict: 'approved', body: 'Ship it.', markFinal: true, resolveAddressed: true });
    const w = await cli(['wait', DOC]);
    assert.equal(w.code, 0, w.stderr);
    assert.match(w.stdout, new RegExp(`^SPECREVIEW FEEDBACK · kitchen-sink · review ${rv.id} on v2 · APPROVED · FINAL = v2$`, 'm'));
    const f = await cli(['final', DOC, '--decisions']);
    assert.equal(f.code, 0, f.stderr);
    assert.match(f.stdout, new RegExp(`^final: kitchen-sink = v2 \\(approved in ${rv.id} by `, 'm'));
    assert.match(f.stdout, /^working copy matches v2: ok$/m);
    const wrote = /^wrote (.+)$/m.exec(f.stdout)?.[1];
    assert.ok(wrote && fs.existsSync(path.resolve(ws.root, wrote)), f.stdout);
    assert.match(fs.readFileSync(path.resolve(ws.root, /** @type {string} */ (wrote)), 'utf8'), /30 s grace window/);
  });

  test('real processes: a newer wait supersedes an older one (exit 6); SIGINT exits 130 and removes the waiter', async () => {
    const older = spawnCli(['wait', DOC]);
    await until(async () => (await ctx.store.listWaiters(DOC)).some((/** @type {any} */ w) => w.pid === older.child.pid));
    const newer = spawnCli(['wait', DOC]);
    const o = /** @type {any} */ (await older.done);
    assert.equal(o.code, 6, o.stderr);
    assert.match(o.stderr, /^suiko: superseded by pid \d+ \(a newer wait is listening\); ignore this\.$/m);
    assert.equal(o.stdout, '');
    await until(async () => (await ctx.store.listWaiters(DOC)).some((/** @type {any} */ w) => w.pid === newer.child.pid));
    newer.child.kill('SIGINT');
    const n = /** @type {any} */ (await newer.done);
    assert.equal(n.code, 130, n.stderr);
    assert.match(n.stderr, /wait interrupted \(SIGINT\); nothing was delivered/);
    assert.deepEqual(await ctx.store.listWaiters(DOC, { liveOnly: false }), []);
  });

  test('close: a running wait exits 5', async () => {
    const waiting = spawnCli(['wait', DOC]);
    await until(async () => (await ctx.store.listWaiters(DOC)).some((/** @type {any} */ w) => w.pid === waiting.child.pid));
    const c = await cli(['close', DOC]);
    assert.equal(c.code, 0, c.stderr);
    const w = /** @type {any} */ (await waiting.done);
    assert.equal(w.code, 5, w.stderr);
    assert.match(w.stdout, /review session for kitchen-sink was closed; stop waiting/);
  });

  test('open prints the external hosts a doc loads live, on the first open and on re-open', async () => {
    ws.write('docs/ext.md', '# Ext\n\n![remote](https://cdn.example.org/a.png)\n\n[a link](https://example.com/)\n');
    for (const run of [1, 2]) {
      const r = await cli(['open', 'docs/ext.md', '--browser', 'none']);
      assert.equal(r.code, 0, `run ${run}: ${r.stderr}`);
      assert.match(r.stdout, /^external hosts loaded live by the doc: cdn\.example\.org \(set render\.network to "block"/m);
      assert.match(r.stdout, /^next: run `suiko wait ext` in the background$/m);
    }
  });
});
