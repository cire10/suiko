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
  return spawnCli(['plan-gate', ...args], input);
}

/**
 * Spawns the CLI with `input` on stdin (Claude Code's environment: CLAUDECODE=1, so the agent is `claude`).
 * @param {string[]} argv
 * @param {unknown} input
 */
function spawnCli(argv, input) {
  const child = spawn(process.execPath, [BIN, ...argv], {
    cwd: ws.root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SPECREVIEW_HOME: process.env.SPECREVIEW_HOME,
      SPECREVIEW_BROWSER: 'none',
      SPECREVIEW_PORT: String(port),
      CLAUDECODE: '1',
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
    // Claude has no reply channel at the gate: the thread its edit is linked to is marked addressed (awaiting the
    // reviewer), so a later deny does not send it back as still open
    assert.equal(t1?.status, 'addressed');
    assert.equal(t1?.comments.at(-1)?.body, 'Changed in v2.');
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

/**
 * Runs the gate in-process (main()) with stubs; `deps` overrides the defaults (a fake daemon, a browser spy).
 * @param {unknown} input
 * @param {string[]} [args]
 * @param {Record<string, any>} [deps]
 */
async function gateInProcess(input, args = [], deps = {}) {
  const out = memorySink();
  const err = memorySink();
  /** @type {string[]} */
  const opened = [];
  const code = await main(['plan-gate', ...args], {
    cwd: ws.root,
    env: { SPECREVIEW_HOME: process.env.SPECREVIEW_HOME, ...(deps.env ?? {}) },
    stdin: Readable.from([Buffer.from(JSON.stringify(input))]),
    stdout: out,
    stderr: err,
    ensureDaemon: async () => /** @type {any} */ ({ pid: 1, uiPort: 5999, contentPort: 6000, token: 'tok', secret: 's', version: '0.1.0', startedAt: '' }),
    openBrowser: async (/** @type {string} */ url) => void opened.push(url),
    pollMs: 50,
    ...deps,
  });
  return { code, stdout: out.text(), stderr: err.text(), opened };
}

describe('plan-gate: the plan review belongs to the gate', () => {
  test('a background `wait --all` (same agent) never takes the plan review; a doc-less wait ignores the plan doc', async () => {
    const spec = path.join(ws.root, 'docs', 'race-spec.md');
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, '# Race spec\n\nSome text.\n');
    await ops.openDoc(ctx, { path: spec });

    const g = gate(hookInput({ plan: '# Race plan\n\nStep one.\n' }, { session_id: 'race-all' }));
    const doc = await gateWaiting('claude-plan:race-all:inline', 1, g.stderr);
    const all = spawnCli(['wait', '--all'], '');
    await until(async () => (await ctx.store.listWaiters('_all')).length > 0, 20000, 'wait --all to register');
    await submit(doc.id, 'approved', null);
    const r = await g.done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.decision.behavior, 'allow');
    all.child.kill('SIGTERM');
    const w = await all.done;
    assert.doesNotMatch(w.stdout, /SPECREVIEW FEEDBACK/);

    // `specreview wait` without a doc: the spec is the only doc that counts
    const out = memorySink();
    const err = memorySink();
    const code = await main(['wait', '--timeout', '200ms'], {
      cwd: ws.root,
      env: { SPECREVIEW_HOME: process.env.SPECREVIEW_HOME, CLAUDECODE: '1' },
      stdout: out,
      stderr: err,
      pollMs: 50,
    });
    assert.equal(code, 2, err.text());
    assert.match(out.text(), /no review yet for race-spec/);
  });

  test('a gate whose version is no longer head steps aside: it never supersedes the newer gate or allows with its stale plan', async () => {
    const file = path.join(path.dirname(planFile), 'stale.md');
    fs.writeFileSync(file, '# Plan\n\nOld step.\n');
    const key = `claude-plan:stale-session:${file}`;
    const input = hookInput({ plan: '', planFilePath: file }, { session_id: 'stale-session' });
    /** @type {any} */
    let y = null;
    // gate X recorded v1 and is slow to start the daemon; meanwhile Claude's next ExitPlanMode (gate Y) records v2
    const x = gateInProcess(input, ['--timeout', '20s'], {
      ensureDaemon: async () => {
        fs.writeFileSync(file, '# Plan\n\nNew step.\n');
        y = gate(input);
        await gateWaiting(key, 2, y.stderr);
        return { pid: 1, uiPort: 5999, contentPort: 6000, token: 'tok', secret: 's', version: '0.1.0', startedAt: '' };
      },
    });
    const rx = await x;
    assert.equal(rx.code, 0, rx.stderr);
    assert.equal(rx.stdout, '');
    assert.deepEqual(rx.opened, [], 'no browser for a stale gate');
    const doc = await ctx.store.findDocByOrigin(key);
    assert.equal(doc?.head, 2);
    await submit(doc.id, 'approved', null);
    const ry = await y.done;
    assert.equal(ry.code, 0, ry.stderr);
    assert.deepEqual(JSON.parse(ry.stdout).hookSpecificOutput.decision.updatedInput, { plan: '# Plan\n\nNew step.\n', planFilePath: file });
  });

  test('a signal while recording or starting the daemon: no browser is opened, nothing printed', async () => {
    const controller = new AbortController();
    const r = await gateInProcess(hookInput({ plan: '# Aborted\n\nText.\n' }, { session_id: 'abort-session' }), [], {
      env: { SPECREVIEW_BROWSER: 'system' },
      signal: controller.signal,
      ensureDaemon: async () => {
        controller.abort('SIGTERM'); // the user answered in the terminal while the daemon was starting
        return { pid: 1, uiPort: 5999, contentPort: 6000, token: 'tok', secret: 's', version: '0.1.0', startedAt: '' };
      },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.deepEqual(r.opened, []);
  });

  test('SPECREVIEW_BROWSER=pane opens the system browser (a hook has no pane); none keeps it closed', async () => {
    const pane = await gateInProcess(hookInput({ plan: '# Pane\n\nText.\n' }, { session_id: 'pane-session' }), ['--timeout', '300ms'], { env: { SPECREVIEW_BROWSER: 'pane' } });
    assert.equal(pane.code, 0, pane.stderr);
    assert.equal(pane.stdout, '');
    assert.equal(pane.opened.length, 1);
    assert.match(pane.opened[0], /^http:\/\/127\.0\.0\.1:5999\/d\/[0-9a-f]+\/pane\?k=tok$/);
    const flag = await gateInProcess(hookInput({ plan: '# Pane\n\nText.\n' }, { session_id: 'pane-session' }), ['--timeout', '300ms', '--browser', 'pane']);
    assert.equal(flag.opened.length, 1);
    const none = await gateInProcess(hookInput({ plan: '# Pane\n\nText.\n' }, { session_id: 'pane-session' }), ['--timeout', '300ms'], { env: { SPECREVIEW_BROWSER: 'none' } });
    assert.deepEqual(none.opened, []);
  });

  test('the workspace comes from $CLAUDE_PROJECT_DIR, not the cwd the session cd-ed into', async () => {
    const elsewhere = path.join(path.dirname(ws.root), 'elsewhere');
    fs.mkdirSync(path.join(elsewhere, '.git'), { recursive: true });
    const input = hookInput({ plan: '# Project plan\n\nText.\n' }, { session_id: 'cd-session', cwd: elsewhere });
    const r = await gateInProcess(input, ['--timeout', '300ms', '--browser', 'none'], { env: { CLAUDE_PROJECT_DIR: ws.root } });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(await ctx.store.findDocByOrigin('claude-plan:cd-session:inline'), 'recorded in the project workspace');
    assert.equal(fs.existsSync(path.join(elsewhere, '.specreview')), false);
  });

  test('the plugin loads the gate from hooks/plan-gate.json; hooks/hooks.json (also what `install claude --with-hooks` copies) has no blocking gate', () => {
    const plugin = path.resolve(path.dirname(BIN), '..', 'integrations', 'claude-code');
    const manifest = JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(manifest.hooks, './hooks/plan-gate.json');
    const gateHooks = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks', 'plan-gate.json'), 'utf8'));
    assert.deepEqual(gateHooks.hooks, {
      PermissionRequest: [{ matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: 'specreview plan-gate', timeout: 345600 }] }],
    });
    const hooks = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks', 'hooks.json'), 'utf8'));
    assert.deepEqual(Object.keys(hooks.hooks).sort(), ['PreToolUse', 'UserPromptSubmit']);
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

  test('a symlink counts only when its target is a .md file; the path is normalised', () => {
    const dir = path.dirname(planFile);
    const secret = path.join(dir, 'secret.env');
    fs.writeFileSync(secret, 'SECRET=hunter2\n');
    const toSecret = path.join(dir, 'leak.md');
    fs.symlinkSync(secret, toSecret);
    assert.deepEqual(planText({ plan: 'inline', planFilePath: toSecret }), { text: 'inline', file: null });
    const real = path.join(dir, 'real.md');
    fs.writeFileSync(real, '# Real\n');
    const toReal = path.join(dir, 'alias.md');
    fs.symlinkSync(real, toReal);
    assert.deepEqual(planText({ plan: 'inline', planFilePath: toReal }), { text: '# Real\n', file: toReal });
    const dotted = `${dir}/../${path.basename(dir)}/real.md`;
    assert.deepEqual(planText({ plan: 'inline', planFilePath: dotted }), { text: '# Real\n', file: real });
  });
});
