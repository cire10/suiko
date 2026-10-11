// @ts-check
// `specreview plan-gate` (the Claude Code PermissionRequest hook for ExitPlanMode) as a real process: fixture hook
// JSON on stdin, a temp workspace and SPECREVIEW_HOME, the real daemon (ensureDaemon starts it on a free port pair
// in 5700-5749; other suites use 5800-5899). The reviewer's side is played through the engine ops. Asserts the exact
// deny decision (plan feedback citing the plan file), the exact allow decision (updatedInput with the reviewed plan)
// after a second ExitPlanMode recorded v2, delivery only once the decision was printed, and failing open (nothing on
// stdout, exit 0, nothing delivered) on bad input, bad arguments, a timeout, SIGTERM and a daemon that cannot start.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as ops from '../../src/core/review/index.js';
import { main } from '../../src/cli/main.js';
import { memorySink } from '../../src/cli/io.js';
import { planText } from '../../src/cli/commands/plan-gate.js';
import { engineCtx, makeWorkspace, textCapture } from '../helpers/engine.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/specreview.js');
const SESSION = 'f00dfeed-0000-4000-8000-000000000001';

/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
/** @type {Awaited<ReturnType<typeof engineCtx>>} */
let ctx;
/** @type {string} */
let planFile;
/** @type {number} */
let port;
/** @type {typeof import('../../src/cli/daemon-client.js')} */
let client;

const PLAN_V1 = ['# Plan: token refresh', '', '## Steps', '', '1. Rotate refresh tokens on every use.', '2. Keep a 30 s grace window.', '3. Ship behind a flag.', ''].join('\n');
const PLAN_V2 = PLAN_V1.replace('2. Keep a 30 s grace window.', '2. Keep a 60 s grace window, configurable per client.');

before(async () => {
  ws = await makeWorkspace({ files: [] }); // points SPECREVIEW_HOME at a temp dir
  fs.mkdirSync(path.join(ws.root, '.git'));
  ctx = await engineCtx(ws.root);
  const plans = path.join(path.dirname(ws.root), 'claude', 'plans');
  fs.mkdirSync(plans, { recursive: true });
  planFile = path.join(plans, 'gentle-otter.md');
  fs.writeFileSync(planFile, PLAN_V1);
  port = await freePortPair();
  client = await import('../../src/cli/daemon-client.js');
});
after(async () => {
  await client?.stopDaemon({ timeoutMs: 3000 }).catch(() => {});
  await ws?.cleanup();
});

/**
 * @param {number} p
 * @returns {Promise<boolean>}
 */
function portFree(p) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** A UI port N in 5700-5748 with N and N+1 free (random start: test files run in parallel). */
async function freePortPair() {
  const start = Math.floor(Math.random() * 25);
  for (let i = 0; i < 25; i++) {
    const p = 5700 + ((start + i) % 25) * 2;
    if ((await portFree(p)) && (await portFree(p + 1))) return p;
  }
  throw new Error('no free port pair in 5700-5749');
}

/**
 * The PermissionRequest hook input Claude Code sends for ExitPlanMode.
 * @param {Record<string, unknown>} [toolInput]
 * @param {Record<string, unknown>} [extra]
 */
function hookInput(toolInput = { plan: PLAN_V1, planFilePath: planFile }, extra = {}) {
  return {
    session_id: SESSION,
    transcript_path: path.join(path.dirname(ws.root), 'claude', 'projects', 'p', `${SESSION}.jsonl`),
    cwd: ws.root,
    permission_mode: 'plan',
    hook_event_name: 'PermissionRequest',
    tool_name: 'ExitPlanMode',
    tool_input: toolInput,
    ...extra,
  };
}

/**
 * Spawns `specreview plan-gate <args>` with `input` (an object is JSON-encoded) on stdin.
 * @param {unknown} input
 * @param {string[]} [args]
 */
function gate(input, args = []) {
  const child = spawn(process.execPath, [BIN, 'plan-gate', ...args], {
    cwd: ws.root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SPECREVIEW_HOME: process.env.SPECREVIEW_HOME,
      SPECREVIEW_BROWSER: 'none',
      SPECREVIEW_PORT: String(port),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  /** @type {Promise<{ code: number | null, signal: string | null, stdout: string, stderr: string }>} */
  const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, done, stderr: () => stderr };
}

/** @param {() => boolean | Promise<boolean>} cond */
async function until(cond, ms = 20000, what = 'condition') {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Waits until the gate recorded `version` of the plan doc with origin `key` and registered its waiter.
 * @param {string} key
 * @param {number} version
 * @param {() => string} stderr
 */
async function gateWaiting(key, version, stderr) {
  /** @type {any} */
  let doc = null;
  await until(
    async () => {
      doc = await ctx.store.findDocByOrigin(key);
      if (!doc || doc.head < version) return false;
      return (await ctx.store.listWaiters(doc.id)).length > 0;
    },
    20000,
    `the gate waiting on v${version} (stderr: ${stderr()})`,
  );
  return doc;
}

/**
 * The reviewer submits a review (one comment on `quote` unless approving without one).
 * @param {string} docId
 * @param {'changes_requested' | 'comment' | 'approved'} verdict
 * @param {string | null} quote
 * @param {string} [body]
 */
async function submit(docId, verdict, quote, body = '') {
  const doc = await ctx.store.requireDoc(docId);
  if (quote) {
    const render = await ctx.render(doc, doc.head);
    await ops.saveDraft(ctx, docId, { kind: 'thread', type: 'comment', severity: 'blocking', capture: textCapture(render, quote), body: 'Make it configurable per client.' });
  }
  return ops.submitReview(ctx, docId, { verdict, body });
}

describe('plan-gate', () => {
  const KEY = () => `claude-plan:${SESSION}:${planFile}`;

  test('request changes -> exact deny with plan feedback; a second ExitPlanMode records v2 -> approve -> exact allow', async () => {
    const g1 = gate(hookInput());
    const doc = await gateWaiting(KEY(), 1, g1.stderr);
    assert.equal(doc.kind, 'snapshot');
    assert.equal(doc.path, `plans/${doc.id}.md`);
    assert.equal(doc.id, 'plan-token-refresh');
    assert.deepEqual(
      { ...doc.origin, transcript: undefined },
      { type: 'plan', key: KEY(), session: SESSION, planFilePath: planFile, cwd: ws.root, transcript: undefined },
    );
    assert.match(g1.stderr(), new RegExp(`specreview: review the plan \\(plan-token-refresh v1\\) at http://127\\.0\\.0\\.1:${port}/d/[0-9a-f]+/plan-token-refresh\\?k=`));

    await submit(doc.id, 'changes_requested', 'Keep a 30 s grace window.', 'Close, but not yet.');
    const r1 = await g1.done;
    assert.equal(r1.code, 0, r1.stderr);
    assert.equal(r1.stdout.endsWith('\n'), true);
    assert.equal(r1.stdout.split('\n').length, 2, 'exactly one line on stdout');
    const deny = JSON.parse(r1.stdout);
    const message = deny.hookSpecificOutput?.decision?.message;
    assert.deepEqual(deny, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } });
    assert.equal(
      message,
      [
        'YOUR PLAN WAS NOT APPROVED: the reviewer requested changes (SpecReview rv1 on v1).',
        `Plan file: ${planFile}   (line numbers below are lines of this file)`,
        'Reviewer summary: Close, but not yet.',
        '1 thread needs action (1 new): 1 blocking',
        '',
        '[t1] blocking · comment · L6 · §Steps',
        '  on: "Keep a 30 s grace window."',
        '  src> 2. Keep a 30 s grace window.',
        '  Eric: Make it configurable per client.',
        '',
        'WHAT TO DO:',
        `- Make targeted changes to ${planFile} with the Edit tool (src> lines are exact old_string). Never rewrite the whole plan or write a new plan file.`,
        '- Address every thread above: change the plan where a thread asks for it; answer questions in the plan (or tell the user, if the answer does not belong in it).',
        '- Then call ExitPlanMode again. The reviewer will see a diff of your changes (v1 -> v2) and approve or comment again.',
      ].join('\n'),
    );
    const rv1 = await ctx.store.getReview(doc.id, 'rv1');
    assert.ok(rv1?.deliveredTo?.claude, 'delivered after the decision was printed');

    // Claude edits the plan file and calls ExitPlanMode again (with a stale inline plan: the file wins)
    fs.writeFileSync(planFile, PLAN_V2);
    const g2 = gate(hookInput({ plan: PLAN_V1, planFilePath: planFile }));
    const d2 = await gateWaiting(KEY(), 2, g2.stderr);
    assert.equal(d2.id, doc.id, 'the same doc');
    const { manifest } = await ctx.store.readVersion(doc.id, 2);
    assert.equal(manifest.capturedBy, 'snapshot');
    assert.equal(manifest.origin.key, KEY());
    assert.deepEqual(manifest.hunks.map((h) => h.threads), [['t1']], 'the change is attributed to t1');
    const t1 = await ctx.store.getThread(doc.id, 't1');
    assert.deepEqual(t1?.changes.map((c) => c.version), [2]);
    assert.equal((await ops.changes(ctx, doc.id, { from: 1, to: 2 })).hunks.length, 1);

    await submit(doc.id, 'approved', null, 'Ship it.');
    const r2 = await g2.done;
    assert.equal(r2.code, 0, r2.stderr);
    assert.deepEqual(JSON.parse(r2.stdout), {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { plan: PLAN_V2, planFilePath: planFile } } },
    });
    assert.ok((await ctx.store.getReview(doc.id, 'rv2'))?.deliveredTo?.claude);

    // a third ExitPlanMode of the unchanged plan is not allowed by the earlier approval: it waits for a new review
    const g3 = gate(hookInput(), ['--timeout', '1500ms']);
    const r3 = await g3.done;
    assert.equal(r3.code, 0, r3.stderr);
    assert.equal(r3.stdout, '');
    assert.match(r3.stderr, /plan gate ended without a review/);
    assert.equal((await ctx.store.requireDoc(doc.id)).head, 2, 'identical plan: no new version');
  });

  test('an inline plan (no plan file) gets its own doc and a feedback without a plan file', async () => {
    const inline = '# Inline plan\n\nDo the thing carefully.\n';
    const g = gate(hookInput({ plan: inline }, { session_id: 'inline-session' }));
    const doc = await gateWaiting('claude-plan:inline-session:inline', 1, g.stderr);
    await submit(doc.id, 'comment', 'Do the thing carefully.');
    const r = await g.done;
    assert.equal(r.code, 0, r.stderr);
    const message = JSON.parse(r.stdout).hookSpecificOutput.decision.message;
    assert.match(message, /^YOUR PLAN WAS NOT APPROVED: the reviewer commented on it \(SpecReview rv1 on v1\)\.\nThe plan has no plan file: line numbers below are lines of the plan text you submitted\.\n/);
    assert.match(message, /- Revise the plan: change only what the threads ask for/);
  });

  test('SIGTERM while waiting: exit 0, nothing printed, the review is not marked delivered', async () => {
    const g = gate(hookInput({ plan: '# Signal plan\n\nWait for it.\n' }, { session_id: 'sigterm-session' }));
    const doc = await gateWaiting('claude-plan:sigterm-session:inline', 1, g.stderr);
    g.child.kill('SIGTERM');
    const r = await g.done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    await until(async () => (await ctx.store.listWaiters(doc.id)).length === 0, 5000, 'the waiter to be removed');
    await submit(doc.id, 'approved', null);
    assert.equal((await ctx.store.getReview(doc.id, 'rv1'))?.deliveredTo?.claude, undefined);
  });

  test('fails open on bad input and bad arguments: exit 0, nothing on stdout', async () => {
    const cases = [
      ['not json', []],
      ['', []],
      [JSON.stringify([1, 2]), []],
      [JSON.stringify(hookInput(undefined, { tool_name: 'Bash' })), []],
      [JSON.stringify(hookInput(undefined, { hook_event_name: 'PreToolUse' })), []],
      [JSON.stringify(hookInput({})), []],
      [JSON.stringify(hookInput({ plan: '   ' })), []],
      [JSON.stringify(hookInput()), ['--bogus']],
      [JSON.stringify(hookInput()), ['--timeout', 'soon']],
      [JSON.stringify(hookInput()), ['extra']],
    ];
    const results = await Promise.all(cases.map(([input, args]) => gate(input, /** @type {string[]} */ (args)).done));
    results.forEach((r, i) => {
      assert.equal(r.code, 0, `case ${i}: ${r.stderr}`);
      assert.equal(r.stdout, '', `case ${i}`);
    });
    assert.match(results[7].stderr, /plan-gate: .*bogus.*; letting Claude Code ask instead/);
  });

  test('--help prints the usage', async () => {
    const r = await gate('', ['--help']).done;
    assert.equal(r.code, 0);
    assert.match(r.stdout, /plan-gate \[--timeout 30m\]/);
  });

  test('fails open when the daemon cannot start, and delivers nothing', async () => {
    const out = memorySink();
    const err = memorySink();
    const input = hookInput({ plan: '# No daemon\n\nPlan text.\n' }, { session_id: 'no-daemon' });
    const code = await main(['plan-gate'], {
      cwd: ws.root,
      env: { SPECREVIEW_BROWSER: 'none', SPECREVIEW_HOME: process.env.SPECREVIEW_HOME },
      stdin: Readable.from([Buffer.from(JSON.stringify(input))]),
      stdout: out,
      stderr: err,
      ensureDaemon: async () => {
        throw new Error('port in use');
      },
      openBrowser: async () => {},
    });
    assert.equal(code, 0);
    assert.equal(out.text(), '');
    assert.match(err.text(), /plan-gate failed open \(Claude Code asks in the terminal\): port in use/);
    const doc = await ctx.store.findDocByOrigin('claude-plan:no-daemon:inline');
    assert.ok(doc, 'the plan is still recorded');
    assert.deepEqual(await ctx.store.listWaiters(doc.id), []);
  });
});

describe('planText', () => {
  test('the plan file wins when it is an absolute .md regular file; else the inline plan', () => {
    const dir = path.dirname(planFile);
    const md = path.join(dir, 'p.md');
    fs.writeFileSync(md, '﻿# From file\n');
    assert.deepEqual(planText({ plan: 'inline', planFilePath: md }), { text: '# From file\n', file: md });
    assert.deepEqual(planText({ plan: 'inline', planFilePath: 'relative.md' }), { text: 'inline', file: null });
    const txt = path.join(dir, 'p.txt');
    fs.writeFileSync(txt, 'text file');
    assert.deepEqual(planText({ plan: 'inline', planFilePath: txt }), { text: 'inline', file: null });
    assert.deepEqual(planText({ plan: 'inline', planFilePath: path.join(dir, 'missing.md') }), { text: 'inline', file: null });
    assert.deepEqual(planText({ plan: 'inline', planFilePath: dir + '.md' }), { text: 'inline', file: null });
    const big = path.join(dir, 'big.md');
    fs.writeFileSync(big, 'x'.repeat(2 * 1024 * 1024));
    assert.deepEqual(planText({ plan: 'inline', planFilePath: big }), { text: 'inline', file: null });
    const empty = path.join(dir, 'empty.md');
    fs.writeFileSync(empty, '\n');
    assert.deepEqual(planText({ plan: 'inline', planFilePath: empty }), { text: 'inline', file: null });
    assert.equal(planText({}), null);
    assert.equal(planText({ plan: 42 }), null);
  });
});
