// @ts-check
// WP4 CLI tests against a stub engine (test/integration/helpers/cli-harness.js): argument parsing, output formats
// (text and --json), exit codes, agent-name resolution, doc resolution by id and by path, and error reporting.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SPECREVIEW_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-home-cli-'));

const { makeWorkspace, runCli, stubEngine, tempDir } = await import('./helpers/cli-harness.js');
const { parseDuration, parseDiffRange, parseBreakLocks, resolveAgent, parseVersionRef } = await import('../../src/cli/args.js');
const { hoistCommand } = await import('../../src/cli/main.js');

/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;

before(async () => {
  ws = await makeWorkspace();
});
after(() => {
  ws.cleanup();
  fs.rmSync(/** @type {string} */ (process.env.SPECREVIEW_HOME), { recursive: true, force: true });
});

/** @param {Record<string, any>} [extra] */
function deps(extra = {}) {
  const engine = stubEngine(ws.store, extra.overrides ?? {});
  delete extra.overrides;
  return { engine, d: { ops: engine.ops, createContext: engine.createContext, cwd: ws.root, ...extra } };
}

describe('arg helpers', () => {
  test('parseDuration', () => {
    assert.equal(parseDuration('0'), 0);
    assert.equal(parseDuration('90'), 90000);
    assert.equal(parseDuration('500ms'), 500);
    assert.equal(parseDuration('30m'), 1800000);
    assert.equal(parseDuration('1h30m'), 5400000);
    assert.throws(() => parseDuration('soon'), /invalid duration/);
  });
  test('parseDiffRange / parseVersionRef', () => {
    assert.deepEqual(parseDiffRange('v1..v2'), { from: 1, to: 2 });
    assert.deepEqual(parseDiffRange('v3..live'), { from: 3, to: 'live' });
    assert.deepEqual(parseDiffRange('v2'), { from: 2, to: 'head' });
    assert.deepEqual(parseDiffRange('..v3'), { from: undefined, to: 3 });
    assert.deepEqual(parseDiffRange(undefined), { from: undefined, to: undefined });
    assert.equal(parseVersionRef('V4'), 4);
    assert.throws(() => parseDiffRange('a..b'), /invalid version/);
  });
  test('parseBreakLocks', () => {
    assert.deepEqual(parseBreakLocks(['L1=user asked', 'L2="quoted why"']), { L1: 'user asked', L2: 'quoted why' });
    assert.throws(() => parseBreakLocks(['L1']), /reason is required/);
    assert.throws(() => parseBreakLocks(['X1=why']), /expected L<n>/);
  });
  test('resolveAgent: --as > SPECREVIEW_AGENT > CLAUDECODE > agent', () => {
    assert.equal(resolveAgent('codex', { SPECREVIEW_AGENT: 'x', CLAUDECODE: '1' }), 'codex');
    assert.equal(resolveAgent(undefined, { SPECREVIEW_AGENT: 'gemini', CLAUDECODE: '1' }), 'gemini');
    assert.equal(resolveAgent(undefined, { CLAUDECODE: '1' }), 'claude');
    assert.equal(resolveAgent(undefined, {}), 'agent');
    assert.throws(() => resolveAgent('bad name!', {}), /invalid agent name/);
  });
  test('global options before the command are hoisted', () => {
    assert.deepEqual(hoistCommand(['--json', 'status']), ['status', '--json']);
    assert.deepEqual(hoistCommand(['--as', 'codex', 'wait', 'x']), ['wait', '--as', 'codex', 'x']);
    assert.deepEqual(hoistCommand(['status', '--json']), ['status', '--json']);
  });
});

describe('top level', () => {
  test('--help lists commands and exits 0; no args exits 1', async () => {
    const r = await runCli(['--help']);
    assert.equal(r.code, 0);
    for (const cmd of ['open', 'wait', 'revise', 'install', 'hook']) assert.match(r.stdout, new RegExp(`\\n  ${cmd} `));
    assert.equal((await runCli([])).code, 1);
  });
  test('unknown command and unknown flag are usage errors (exit 1, specreview: prefix)', async () => {
    const r = await runCli(['frobnicate']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^specreview: unknown command "frobnicate"/);
    const { d } = deps();
    const r2 = await runCli(['status', '--bogus'], d);
    assert.equal(r2.code, 1);
    assert.match(r2.stderr, /^specreview: status: Unknown option '--bogus'/);
  });
  test('<cmd> --help prints usage', async () => {
    const r = await runCli(['revise', '--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage: specreview revise <doc>/);
  });
  test('--version', async () => {
    const r = await runCli(['--version']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/);
  });
});

describe('agent name and doc resolution', () => {
  test('createContext receives the resolved agent', async () => {
    for (const [env, flag, expected] of /** @type {const} */ ([
      [{ CLAUDECODE: '1' }, [], 'claude'],
      [{ SPECREVIEW_AGENT: 'codex', CLAUDECODE: '1' }, [], 'codex'],
      [{ CLAUDECODE: '1' }, ['--as', 'gemini'], 'gemini'],
      [{}, [], 'agent'],
    ])) {
      const { engine, d } = deps({ env: { ...env, SPECREVIEW_BROWSER: 'none', SPECREVIEW_HOME: process.env.SPECREVIEW_HOME } });
      const r = await runCli(['log', 'token-service', ...flag], d);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(engine.calls.find((c) => c.name === 'createContext')?.args[0].agent, expected);
    }
  });
  test('<doc> by id, by relative path and by absolute path', async () => {
    for (const arg of ['token-service', 'docs/specs/token-service.md', ws.file]) {
      const { engine, d } = deps();
      const r = await runCli(['log', arg], d);
      assert.equal(r.code, 0, r.stderr);
      const call = engine.calls.find((c) => c.name === 'log');
      assert.equal(call?.args[1], 'token-service');
    }
  });
  test('unknown doc -> exit 4 with the tracked ids', async () => {
    const { d } = deps();
    const r = await runCli(['log', 'nope'], d);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /^specreview: doc not found: nope \(tracked: token-service\)/);
  });
  test('--json error object on stdout', async () => {
    const { d } = deps();
    const r = await runCli(['log', 'nope', '--json'], d);
    assert.equal(r.code, 4);
    const j = JSON.parse(r.stdout);
    assert.equal(j.error.code, 'NOT_FOUND');
    assert.equal(j.error.exit, 4);
  });
});

describe('open', () => {
  test('tracks a new doc, prints the design 3.2 lines and the review URL', async () => {
    const root = tempDir('open');
    fs.mkdirSync(path.join(root, '.git'));
    const file = path.join(root, 'design.md');
    fs.writeFileSync(file, '# Design\n\nSee <https://cdn.example.com/x.js>.\n\n![a](https://img.example.org/a.png)\n');
    const { Store } = await import('../../src/core/store/store.js');
    /** @type {any} */
    let store = null;
    /** @type {string[][]} */
    const opened = [];
    const engine = {
      calls: /** @type {any[]} */ ([]),
    };
    const d = {
      cwd: root,
      createContext: async (/** @type {any} */ a) => {
        engine.calls.push(a);
        store = await Store.open(a.root ?? root);
        return { store, wsId: store.wsId, render: async () => ({ externals: ['https://img.example.org/a.png', 'https://cdn.example.com/x.js'] }) };
      },
      ops: {
        openDoc: async (/** @type {any} */ ctx, /** @type {any} */ o) => {
          const doc = await ctx.store.createDoc({ path: o.path, title: o.title });
          const m = await ctx.store.commitVersion(doc, { source: fs.readFileSync(o.path) });
          return { doc: await ctx.store.getDoc(doc.id), version: m, created: true, workingDirty: false };
        },
      },
      openBrowser: async (/** @type {string} */ url) => {
        opened.push([url]);
      },
    };
    const r = await runCli(['open', 'design.md', '--browser', 'system'], d);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.split('\n');
    assert.equal(lines[0], 'specreview: tracking design.md as "design" (markdown, 5 lines) · recorded v1');
    assert.equal(lines[1], `review UI: http://127.0.0.1:5801/d/${store.wsId}/design?k=tok123`);
    assert.match(lines[2], /^external hosts loaded live by the doc: cdn\.example\.com, img\.example\.org/);
    assert.match(r.stdout, /run `specreview wait design` in the background/);
    assert.match(r.stdout, /Recommended \.gitattributes lines/);
    assert.equal(engine.calls[0].create, true);
    assert.equal(engine.calls[0].root, root);
    assert.deepEqual(opened, [[`http://127.0.0.1:5801/d/${store.wsId}/design?k=tok123`]]);

    // already tracked + dirty, --json
    const d2 = { ...d, ops: { openDoc: async (/** @type {any} */ ctx) => ({ doc: (await ctx.store.listDocs())[0], version: 1, created: false, workingDirty: true }) } };
    const r2 = await runCli(['open', 'design.md', '--json'], d2);
    assert.equal(r2.code, 0, r2.stderr);
    const j = JSON.parse(r2.stdout);
    assert.equal(j.doc, 'design');
    assert.equal(j.version, 1);
    assert.equal(j.workingDirty, true);
    assert.equal(j.url, `http://127.0.0.1:5801/d/${store.wsId}/design?k=tok123`);
    const r3 = await runCli(['open', 'design.md', '--browser', 'none'], d2);
    assert.match(r3.stdout, /is already tracked as "design" \(head v1\) · working copy differs from v1 \(unrecorded\)/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  test('missing file -> exit 4; unsupported type -> exit 1; bad --browser -> exit 1', async () => {
    const { d } = deps();
    assert.equal((await runCli(['open', 'nope.md'], d)).code, 4);
    fs.writeFileSync(path.join(ws.root, 'notes.txt'), 'x');
    const r = await runCli(['open', 'notes.txt'], d);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unsupported file type/);
    assert.equal((await runCli(['open', 'docs/specs/token-service.md', '--browser', 'lynx'], d)).code, 1);
  });
  test('opens the system browser by default; --browser and $SPECREVIEW_BROWSER choose pane or none', async () => {
    /** @type {string[]} */
    const opened = [];
    const { d } = deps({ openBrowser: async (/** @type {string} */ url) => void opened.push(url) });
    const doc = 'docs/specs/token-service.md';
    const home = process.env.SPECREVIEW_HOME;
    const sys = await runCli(['open', doc], { ...d, env: { SPECREVIEW_HOME: home } });
    assert.equal(sys.code, 0, sys.stderr);
    assert.equal(opened.length, 1);
    assert.match(sys.stdout, /next: the URL was opened in the system browser/);
    const pane = await runCli(['open', doc], { ...d, env: { SPECREVIEW_HOME: home, SPECREVIEW_BROWSER: 'pane' } });
    assert.match(pane.stdout, /next: open the URL \(browser pane\)/);
    const flag = await runCli(['open', doc, '--browser', 'none'], { ...d, env: { SPECREVIEW_HOME: home, SPECREVIEW_BROWSER: 'system' } });
    assert.match(flag.stdout, /^next: run `specreview wait/m);
    assert.equal(opened.length, 1);
    const bad = await runCli(['open', doc], { ...d, env: { SPECREVIEW_HOME: home, SPECREVIEW_BROWSER: 'lynx' } });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /SPECREVIEW_BROWSER must be one of pane, system, none/);
    const failing = await runCli(['open', doc], {
      ...d,
      env: { SPECREVIEW_HOME: home },
      openBrowser: async () => {
        throw new Error('no display');
      },
    });
    assert.equal(failing.code, 0);
    assert.match(failing.stderr, /could not open the system browser: no display/);
    assert.match(failing.stdout, /next: the system browser could not be opened; give the user the URL/);
  });
  test('server start failure: doc tracked, exit 1, explained', async () => {
    const { d } = deps({
      ensureDaemon: async () => {
        throw new Error('port in use');
      },
    });
    const r = await runCli(['open', 'docs/specs/token-service.md'], d);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /already tracked as "token-service"/);
    assert.match(r.stdout, /review UI: unavailable \(port in use\)/);
    assert.match(r.stderr, /the review server could not be started: port in use/);
  });
  test('refuses a workspace root equal to $HOME unless --workspace is given', async () => {
    const fakeHome = tempDir('home');
    const file = path.join(fakeHome, 'spec.md');
    fs.writeFileSync(file, '# x\n');
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      if (os.homedir() !== fakeHome) return; // platform ignores HOME: nothing to test
      const { d } = deps({ cwd: fakeHome });
      const r = await runCli(['open', 'spec.md'], d);
      assert.equal(r.code, 3);
      assert.match(r.stderr, /refusing to use your home directory/);
    } finally {
      process.env.HOME = prevHome;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('feedback', () => {
  test('prints the packet (text) and passes the flags', async () => {
    const { engine, d } = deps();
    const r = await runCli(['feedback', 'token-service', '--peek', '--include-drafts'], d);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^SPECREVIEW FEEDBACK · token-service \(docs\/specs\/token-service\.md\) · review rv1 on v1 · CHANGES REQUESTED/);
    assert.match(r.stdout, /\n\[t1\] blocking · comment · L5-6 · §Token Service > 3 Tokens\n/);
    assert.match(r.stdout, /\n {2}src> Refresh tokens are rotated on every use, and the previous token is\n {2}src> invalidated immediately\.\n/);
    const opts = engine.calls.find((c) => c.name === 'feedback')?.args[2];
    assert.equal(opts.peek, true);
    assert.equal(opts.includeDrafts, true);
    assert.equal(opts.allOpen, false);
    assert.equal(typeof opts.write, 'function');
  });
  test('--json prints the packet object; an engine that does not call write() still prints', async () => {
    const { samplePacket } = await import('./helpers/cli-harness.js');
    const { d } = deps({ overrides: { feedback: async () => samplePacket() } });
    const r = await runCli(['feedback', 'token-service', '--json'], d);
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.doc, 'token-service');
    assert.equal(j.threads[0].id, 't1');
  });
  test('the text the engine writes is printed verbatim; a returned-only packet uses the engine formatter', async () => {
    const { samplePacket } = await import('./helpers/cli-harness.js');
    const written = await runCli(['feedback', 'token-service'], deps({ overrides: { feedback: async (/** @type {any} */ c, /** @type {any} */ id, /** @type {any} */ o) => {
      await o.write('ENGINE TEXT');
      return samplePacket();
    } } }).d);
    assert.equal(written.stdout, 'ENGINE TEXT\n');
    const { d } = deps({ format: { formatPacket: () => 'CUSTOM PACKET' }, overrides: { feedback: async () => samplePacket() } });
    const r = await runCli(['feedback', 'token-service'], d);
    assert.equal(r.stdout, 'CUSTOM PACKET\n');
  });
});

describe('apply / edit', () => {
  test('apply: applied + conflict lines, exit 3 on conflict', async () => {
    const { engine, d } = deps();
    const r = await runCli(['apply', 'token-service', 't3', 't9'], d);
    assert.equal(r.code, 3);
    assert.match(r.stdout, /^applied t3 at L10 \(exact\) · staged \(not recorded yet\)$/m);
    assert.match(r.stdout, /^conflict t9: expected text not found near L88; treat as a normal comment$/m);
    assert.deepEqual(engine.calls.find((c) => c.name === 'applySuggestions')?.args.slice(2), [['t3', 't9'], { dryRun: false }]);
    const ok = await runCli(['apply', 'token-service', 't3', '--dry-run', '--json'], deps().d);
    assert.equal(ok.code, 0);
    assert.equal(JSON.parse(ok.stdout).applied[0].id, 't3');
    assert.equal((await runCli(['apply', 'token-service', 'x3'], deps().d)).code, 1);
  });
  test('edit flags -> taggedEdit', async () => {
    const { engine, d } = deps();
    const r = await runCli(['edit', 'token-service', '--thread', 't1,t2', '--old', 'rotated on every use', '--new', 'rotated with grace'], d);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^edited L5-6 for t1,t2 · staged \(not recorded yet\)$/m);
    assert.deepEqual(engine.calls.find((c) => c.name === 'taggedEdit')?.args[2], {
      threads: ['t1', 't2'],
      oldString: 'rotated on every use',
      newString: 'rotated with grace',
      replaceAll: false,
    });
  });
  test('edit errors: missing flags exit 1; engine conflict exit 3', async () => {
    assert.equal((await runCli(['edit', 'token-service', '--old', 'a', '--new', 'b'], deps().d)).code, 1);
    const r = await runCli(['edit', 'token-service', '--thread', 't1', '--old', 'missing', '--new', 'b'], deps().d);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /^specreview: old_string not found/);
  });
  test('edit --stdin batch; stops at the first failure', async () => {
    const { engine, d } = deps({
      input: JSON.stringify([
        { threads: ['t1'], old: 'a', new: 'b' },
        { threads: 't2,t3', old: 'missing', new: 'c', all: true },
        { threads: ['t4'], old: 'x', new: 'y' },
      ]),
    });
    const r = await runCli(['edit', 'token-service', '--stdin', '--json'], d);
    assert.equal(r.code, 3);
    const j = JSON.parse(r.stdout);
    assert.equal(j.applied.length, 1);
    assert.equal(j.failed.index, 2);
    assert.match(r.stderr, /edit 2 failed: old_string not found .*1 later edit not attempted.*edits 1-1 were applied/);
    const edits = engine.calls.filter((c) => c.name === 'taggedEdit').map((c) => c.args[2]);
    assert.deepEqual(edits[1].threads, ['t2', 't3']);
    assert.equal(edits[1].replaceAll, true);
    assert.equal(edits.length, 2);
  });
  test('edit --stdin rejects bad JSON and unknown keys', async () => {
    const bad = await runCli(['edit', 'token-service', '--stdin'], deps({ input: '[{"threads":["t1"],"old":"a"' }).d);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /invalid edit --stdin JSON/);
    const unknown = await runCli(['edit', 'token-service', '--stdin'], deps({ input: '[{"threads":["t1"],"old":"a","new":"b","oops":1}]' }).d);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /Unrecognized key/);
  });
});

describe('reply / ask / reanchor / revert', () => {
  test('reply', async () => {
    const { engine, d } = deps();
    const r = await runCli(['reply', 'token-service', 't2', '-m', 'It sits in front.', '--status', 'answered', '--at', '90-91'], d);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'replied on t2 (answered) · no version recorded\n');
    assert.deepEqual(engine.calls.find((c) => c.name === 'reply')?.args.slice(2), ['t2', { body: 'It sits in front.', status: 'answered', at: 'L90-91', decision: undefined }]);
    assert.equal((await runCli(['reply', 'token-service', 't2', '-m', 'x', '--status', 'resolved'], deps().d)).code, 1);
    assert.equal((await runCli(['reply', 'token-service', 't2'], deps().d)).code, 1);
    assert.equal((await runCli(['reply', 'token-service', 't404', '-m', 'x'], deps().d)).code, 4);
  });
  test('ask', async () => {
    const { engine, d } = deps();
    const r = await runCli(['ask', 'token-service', '--lines', '10', '-m', 'Which TTL?'], d);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^asked t7 \(agent-question, needs_input\) at L10/);
    assert.deepEqual(engine.calls.find((c) => c.name === 'ask')?.args[2], { quote: undefined, lines: [10, 10], body: 'Which TTL?' });
    assert.equal((await runCli(['ask', 'token-service', '-m', 'q'], deps().d)).code, 1);
    assert.equal((await runCli(['ask', 'token-service', '--lines', '1', '--quote', 'x', '-m', 'q'], deps().d)).code, 1);
  });
  test('reanchor', async () => {
    const { engine, d } = deps();
    const r = await runCli(['reanchor', 'token-service', 't2', '--lines', 'L90-91'], d);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 're-anchored t2 to L90-91 (exact) · applied to head v1\n');
    assert.deepEqual(engine.calls.find((c) => c.name === 'reanchorThread')?.args.slice(2), ['t2', { lines: [90, 91], quote: undefined }]);
    assert.equal((await runCli(['reanchor', 'token-service', 't2'], deps().d)).code, 1);
    assert.equal((await runCli(['reanchor', 'token-service', 't2', '--lines', '9-3'], deps().d)).code, 1);
  });
  test('revert', async () => {
    const { engine, d } = deps();
    const r = await runCli(['revert', 'token-service', '--hunk', 'h5'], d);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^reverted hunk h5 in the working copy \(now L5-6\)/);
    assert.deepEqual(engine.calls.find((c) => c.name === 'revert')?.args[2], { hunk: 'h5', lock: undefined });
    assert.equal((await runCli(['revert', 'token-service'], deps().d)).code, 1);
    assert.equal((await runCli(['revert', 'token-service', '--hunk', 'h1', '--lock', 'L1'], deps().d)).code, 1);
  });
});

describe('revise', () => {
  const replies = {
    summary: 'rv1: grace window',
    threads: { t1: { status: 'addressed', reply: 'Done.' }, t4: { status: 'needs_input', reply: 'Which?', at: 'L12,L90-91' } },
    other: [{ at: 'del:h6', why: 'merged into 6' }],
  };
  test('--replies - with -m override and repeated --break-lock', async () => {
    const { engine, d } = deps({ input: JSON.stringify(replies) });
    const r = await runCli(['revise', 'token-service', '--replies', '-', '-m', 'custom summary', '--break-lock', 'L1=user asked', '--break-lock', 'L2=also', '--allow-rewrite'], d);
    assert.equal(r.code, 0, r.stderr);
    const input = engine.calls.find((c) => c.name === 'revise')?.args[2];
    assert.deepEqual(input, {
      summary: 'custom summary',
      threads: replies.threads,
      other: replies.other,
      breakLocks: { L1: 'user asked', L2: 'also' },
      allowRewrite: true,
    });
    assert.match(r.stdout, /recorded v2 for token-service/);
  });
  test('--replies <file>, --dry-run, --json', async () => {
    const file = path.join(ws.root, 'replies.json');
    fs.writeFileSync(file, JSON.stringify(replies));
    const { engine, d } = deps();
    const r = await runCli(['revise', 'token-service', '--replies', 'replies.json', '--dry-run', '--json'], d);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(engine.calls.find((c) => c.name === 'revise')?.args[2].dryRun, true);
    assert.equal(JSON.parse(r.stdout).version, 2);
  });
  test('refused -> exit 3 with REFUSED text', async () => {
    const { d } = deps({ input: JSON.stringify({ summary: 'refuse-me', threads: {} }) });
    const r = await runCli(['revise', 'token-service', '--replies', '-'], d);
    assert.equal(r.code, 3);
    assert.match(r.stdout, /^specreview: REFUSED - nothing recorded \(exit 3\)\n {2}ERR lock: h1 changes L1/);
  });
  test('invalid replies JSON -> exit 1 naming the field', async () => {
    const r1 = await runCli(['revise', 'token-service', '--replies', '-'], deps({ input: '{"threads":{"t1":{"status":"done","reply":"x"}}}' }).d);
    assert.equal(r1.code, 1);
    assert.match(r1.stderr, /invalid --replies JSON: threads\.t1\.status/);
    const r2 = await runCli(['revise', 'token-service', '--replies', '-'], deps({ input: '{"replies":{}}' }).d);
    assert.equal(r2.code, 1);
    assert.match(r2.stderr, /Unrecognized key: "replies"/);
    const r3 = await runCli(['revise', 'token-service', '--replies', '-'], deps({ input: '{"threads":{},"other":[{"at":"line 12","why":"x"}]}' }).d);
    assert.equal(r3.code, 1);
    assert.match(r3.stderr, /other\.0\.at/);
    assert.equal((await runCli(['revise', 'token-service', '--replies', 'missing.json'], deps().d)).code, 4);
  });
});

describe('inspect commands', () => {
  test('threads lists stored threads with the default active filter', async () => {
    const t = {
      schema: 1, id: 't1', doc: 'token-service', type: 'comment', severity: 'blocking', status: 'open', createdIn: 1,
      createdBy: { kind: 'human', name: 'Eric' }, review: null,
      anchors: { 1: { v: 1, kind: 'text', state: 'exact', src: { startLine: 5, endLine: 6 }, section: ['3 Tokens'] } },
      override: null, suggestion: null, comments: [{ id: 'c1', by: { kind: 'human', name: 'Eric' }, body: 'Use a grace window.', at: '', version: 1 }],
      changes: [], attachments: [], decision: null, resolvedIn: null, updatedAt: '',
    };
    await ws.store.saveThread('token-service', t);
    await ws.store.saveThread('token-service', { ...t, id: 't2', status: 'resolved', severity: 'normal' });
    const r = await runCli(['threads', 'token-service'], deps().d);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^t1 {2}open {2}blocking {2}comment {2}L5-6 {2}§3 Tokens {2}Eric: Use a grace window\.$/m);
    assert.match(r.stdout, /\(1 resolved not shown; --status all\)/);
    const all = JSON.parse((await runCli(['threads', 'token-service', '--status', 'all', '--json'], deps().d)).stdout);
    assert.deepEqual(all.threads.map((/** @type {any} */ x) => x.id), ['t1', 't2']);
    assert.equal((await runCli(['threads', 'token-service', '--status', 'weird'], deps().d)).code, 1);
    await ws.store.deleteThread('token-service', 't1');
    await ws.store.deleteThread('token-service', 't2');
  });
  test('show thread / show old source', async () => {
    const r = await runCli(['show', 'token-service', 't2'], deps().d);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^\[t2\] comment · OPEN/);
    assert.match(r.stdout, /v1 Eric: hello/);
    const { engine, d } = deps();
    const r2 = await runCli(['show', 'token-service', '--version', 'v1', '--lines', '1-2'], d);
    assert.equal(r2.stdout, 'v1 L1-2\n1  # Token Service\n2  \n');
    assert.deepEqual(engine.calls.find((c) => c.name === 'show')?.args[2], { thread: undefined, version: 1, lines: [1, 2] });
  });
  test('diff: range parsing, stat text and unified fallback from the store', async () => {
    const { engine, d } = deps();
    const r = await runCli(['diff', 'token-service', 'v1..v2'], d);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^v1\.\.v2 {2}\+2 -1 {2}1 hunk\n {2}h1 L5-7 {2}§3 Tokens {2}t1 \(overlap\)/);
    assert.deepEqual(engine.calls.find((c) => c.name === 'changes')?.args[2], { from: 1, to: 2 });
    fs.writeFileSync(ws.file, fs.readFileSync(ws.file, 'utf8').replace('3 times', '5 times'));
    const u = await runCli(['diff', 'token-service', 'v1..live', '--unified'], deps().d);
    assert.equal(u.code, 0, u.stderr);
    assert.match(u.stdout, /^--- v1\/docs\/specs\/token-service\.md\n\+\+\+ live\/docs\/specs\/token-service\.md\n@@ -7,4 \+7,4 @@\n/);
    assert.match(u.stdout, /\n-The client MUST retry 3 times\.\n\+The client MUST retry 5 times\.\n$/);
    fs.writeFileSync(ws.file, fs.readFileSync(ws.file, 'utf8').replace('5 times', '3 times'));
  });
  test('log / status / final / close', async () => {
    const log = await runCli(['log', 'token-service'], deps().d);
    assert.match(log.stdout, /^v1 {2}claude {2}2026-10-10T13:55:00\.000Z {2}initial draft$/m);
    const st = await runCli(['status'], deps().d);
    assert.equal(st.code, 0, st.stderr);
    assert.match(st.stdout, /^token-service {2}docs\/specs\/token-service\.md {2}head v1 {2}in_review/);
    const fin = await runCli(['final', 'token-service', '--decisions'], deps().d);
    assert.equal(fin.stdout, 'final: token-service = v3 (approved in rv3 by Eric)\nworking copy matches v3: ok\nwrote docs/specs/token-service.decisions.md\n');
    const cl = await runCli(['close', 'token-service', '--json'], deps().d);
    assert.equal(JSON.parse(cl.stdout).closed, true);
  });
  test('status outside any workspace: no tracked docs, exit 0', async () => {
    const dir = tempDir('empty');
    const r = await runCli(['status'], {
      cwd: dir,
      ops: {},
      createContext: async () => {
        const { NotFoundError } = await import('../../src/core/store/errors.js');
        throw new NotFoundError('no SpecReview store');
      },
    });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^no tracked docs here/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test('an engine without an op gives a clear error', async () => {
    const r = await runCli(['log', 'token-service'], { cwd: ws.root, ops: {}, createContext: async () => ({ store: ws.store }) });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /the review engine does not implement log\(\)/);
  });
});
