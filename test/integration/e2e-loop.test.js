// @ts-check
// End-to-end agent loop with REAL processes (integration): every agent step is the real CLI (`bin/specreview.js`)
// run as a subprocess, the reviewer side is the real daemon's HTTP API driven exactly as the UI drives it
// (POST /anchors/resolve -> POST /drafts -> POST /reviews, with the UI's headers), and nothing is stubbed.
//
//   kitchen-sink.md: open (daemon starts, URL printed) -> `wait` in the background -> round 1 review with a text
//   phrase, an image region (+ crop attachment), a table cell and a suggestion -> wait exits 0 with the packet ->
//   `apply` + a direct file edit -> `revise --replies -` (v2, linked hunks, re-anchored threads) -> diff over the API
//   -> round 2 (reopen + resolutions + a decision) -> `edit --stdin` + revise (v3) -> approve with markFinal ->
//   `final --decisions`.
//   app-spec.html: round 1 (text, image region, table cell, script-generated text, suggestion) through v2.
//   Also: `specreview mcp` (tools/list + a call), the hooks (output + timing), `install claude` as a dry run
//   (HOME and CLAUDE_CONFIG_DIR point at a temp dir; nothing may be written), and `stop`.
//
// Isolation: temp workspace, temp SPECREVIEW_HOME and HOME, and a free UI/content port pair in 5850-5899
// (SPECREVIEW_PORT; never the default 4777/4778). The daemon is stopped in after() even when a step fails.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'bin', 'specreview.js');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'docs');

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-loop-')));
const HOME = path.join(BASE, 'sr-home'); // SPECREVIEW_HOME (also for this process, before the project modules load)
process.env.SPECREVIEW_HOME = HOME;
const { renderSource } = await import('../../src/core/render/index.js');
const { cellCapture, elementCapture, findSrid, textCapture } = await import('../helpers/engine.js');
const USER_HOME = path.join(BASE, 'user-home'); // HOME for the subprocesses (install claude must not see ~/.claude)
const WS = path.join(BASE, 'ws');
const AGENT = 'claude';

/** @type {Record<string, string>} */
let ENV = {};
/** @type {number} */
let PORT = 0;
/** @type {{ uiPort: number, token: string, pid: number } | null} */
let daemon = null;
/** @type {Set<import('node:child_process').ChildProcess>} */
const children = new Set();

before(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(USER_HOME, { recursive: true });
  fs.mkdirSync(path.join(WS, '.git'), { recursive: true }); // workspace discovery stops here
  fs.mkdirSync(path.join(WS, 'docs', 'img'), { recursive: true });
  for (const f of ['kitchen-sink.md', 'app-spec.html', 'img/arch.png']) fs.copyFileSync(path.join(FIXTURES, f), path.join(WS, 'docs', f));
  PORT = await freePortPair();
  ENV = {
    PATH: /** @type {string} */ (process.env.PATH),
    HOME: USER_HOME,
    SPECREVIEW_HOME: HOME,
    SPECREVIEW_PORT: String(PORT),
    SPECREVIEW_AGENT: AGENT,
    CLAUDE_CONFIG_DIR: path.join(USER_HOME, '.claude'),
  };
});

after(async () => {
  for (const c of children) c.kill('SIGKILL');
  try {
    await run(['stop'], { timeoutMs: 8000 });
  } catch {
    // fall through to the pid kill below
  }
  const info = readDaemonInfo();
  if (info && pidAlive(info.pid)) process.kill(info.pid, 'SIGKILL');
  fs.rmSync(BASE, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------ helpers

/** @param {number} port */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** A UI port N in 5850-5898 with N and N+1 free (random start: test files run in parallel). */
async function freePortPair() {
  const slots = 24; // 5850, 5852, ... 5896
  const start = Math.floor(Math.random() * slots);
  for (let i = 0; i < slots; i++) {
    const p = 5850 + ((start + i) % slots) * 2;
    if ((await portFree(p)) && (await portFree(p + 1))) return p;
  }
  throw new Error('no free port pair in 5850-5899');
}

/** @param {number} pid */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readDaemonInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME, 'daemon.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Starts the real CLI as a process (cwd = the workspace).
 * @param {string[]} args
 * @param {{ stdin?: string, env?: Record<string, string> }} [opts]
 */
function start(args, { stdin, env = {} } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: WS, env: { ...ENV, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  const res = { stdout: '', stderr: '', code: /** @type {number | null} */ (null), ms: 0 };
  const t0 = Date.now();
  child.stdout.setEncoding('utf8').on('data', (d) => (res.stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d) => (res.stderr += d));
  const done = new Promise((resolve) => {
    child.on('close', (code) => {
      children.delete(child);
      res.code = code;
      res.ms = Date.now() - t0;
      resolve(res);
    });
  });
  child.stdin.end(stdin ?? '');
  return { child, res, done: /** @type {Promise<typeof res>} */ (done) };
}

/**
 * Runs the real CLI to completion.
 * @param {string[]} args
 * @param {{ stdin?: string, env?: Record<string, string>, timeoutMs?: number }} [opts]
 */
async function run(args, opts = {}) {
  const p = start(args, opts);
  const timer = setTimeout(() => p.child.kill('SIGKILL'), opts.timeoutMs ?? 30000);
  const res = await p.done;
  clearTimeout(timer);
  return res;
}

/**
 * Runs the CLI and asserts exit 0.
 * @param {string[]} args
 * @param {{ stdin?: string, env?: Record<string, string> }} [opts]
 */
async function ok(args, opts) {
  const r = await run(args, opts);
  assert.equal(r.code, 0, `specreview ${args.join(' ')} exited ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return r;
}

/**
 * Waits until `fn` returns a truthy value.
 * @template T
 * @param {() => Promise<T> | T} fn
 * @param {string} what
 * @param {number} [ms]
 * @returns {Promise<T>}
 */
async function until(fn, what, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * The reviewer UI's API client: same routes, Bearer token, and the Origin header a browser sends.
 * @param {string} wsId
 * @param {string} docId
 */
function uiApi(wsId, docId) {
  const d = /** @type {NonNullable<typeof daemon>} */ (daemon);
  const origin = `http://127.0.0.1:${d.uiPort}`;
  /**
   * @param {string} method
   * @param {string} p path under /api/docs/<ws>/<doc>
   * @param {unknown} [body]
   * @returns {Promise<any>}
   */
  const call = async (method, p, body) => {
    const r = await fetch(`${origin}/api/docs/${wsId}/${docId}${p}`, {
      method,
      headers: { authorization: `Bearer ${d.token}`, origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(json)}`);
    return json;
  };
  return {
    state: () => call('GET', ''),
    resolve: (/** @type {number} */ version, /** @type {any} */ capture) => call('POST', '/anchors/resolve', { version, capture }),
    attach: (/** @type {string} */ dataUrl) => call('POST', '/attachments', { dataUrl }),
    draft: (/** @type {any} */ item) => call('POST', '/drafts', item),
    submit: (/** @type {any} */ body) => call('POST', '/reviews', body),
    targets: (/** @type {number | 'live'} */ v) => call('GET', `/versions/${v}/targets`),
    diff: (/** @type {string} */ q = '') => call('GET', `/diff${q}`),
    minidiff: (/** @type {string} */ tid) => call('GET', `/threads/${tid}/minidiff`),
  };
}

/**
 * The thread draft the composer posts for a resolved capture (src/ui/actions.js addToReview).
 * @param {any} resolved POST /anchors/resolve result
 * @param {number} version
 * @param {{ type?: string, severity?: string, body: string, suggestion?: string, attachments?: string[] }} o
 */
function threadDraft(resolved, version, o) {
  const a = resolved.anchor;
  return {
    kind: 'thread',
    type: o.type ?? (o.suggestion !== undefined ? 'suggestion' : 'comment'),
    severity: o.severity ?? 'normal',
    anchor: a,
    body: o.body,
    suggestion: o.suggestion === undefined ? null : {
      mode: 'text', old: a.src.text, new: o.suggestion, version,
      start: a.src.start, end: a.src.end, startLine: a.src.startLine, endLine: a.src.endLine,
    },
    attachments: o.attachments ?? [],
    version,
  };
}

/**
 * Starts `specreview wait <doc>` in the background and resolves once its waiter is visible to the daemon (presence).
 * @param {ReturnType<typeof uiApi>} api
 * @param {string} docId
 */
async function startWait(api, docId) {
  const w = start(['wait', docId]);
  await until(async () => (await api.state()).waiters?.some((/** @type {any} */ x) => x.agent === AGENT), `${docId} waiter presence`);
  return w;
}

/**
 * @param {ReturnType<typeof start>} w
 * @param {number} [ms]
 */
async function waitExit(w, ms = 20000) {
  const timer = setTimeout(() => w.child.kill('SIGKILL'), ms);
  const res = await w.done;
  clearTimeout(timer);
  return res;
}

/** @param {string} rel */
const wsFile = (rel) => path.join(WS, rel);
/** @param {string} rel */
const readWs = (rel) => fs.readFileSync(wsFile(rel), 'utf8');

/**
 * Replaces exactly one occurrence (what the agent's Edit tool does).
 * @param {string} rel @param {string} from @param {string} to
 */
function editWs(rel, from, to) {
  const text = readWs(rel);
  const i = text.indexOf(from);
  assert.ok(i >= 0 && text.indexOf(from, i + 1) < 0, `edit: ${JSON.stringify(from)} must occur exactly once`);
  fs.writeFileSync(wsFile(rel), text.slice(0, i) + to + text.slice(i + from.length));
}

/** @param {string} rel */
async function renderWs(rel) {
  const source = readWs(rel);
  return renderSource({ format: rel.endsWith('.md') ? 'markdown' : 'html', source, docPath: rel });
}

/** Line number (1-based) of the first line containing `needle`. @param {string} rel @param {string} needle */
function lineOf(rel, needle) {
  const i = readWs(rel).split('\n').findIndex((l) => l.includes(needle));
  assert.ok(i >= 0, `no line contains ${JSON.stringify(needle)}`);
  return i + 1;
}

/** @param {any} state @param {string} tid */
const threadOf = (state, tid) => state.threads.find((/** @type {any} */ t) => t.id === tid);

// ------------------------------------------------------------------------------------------------ the loop

describe('the real agent loop (CLI processes + daemon API)', () => {
  /** @type {string} */
  let wsId = '';
  const MD = 'docs/kitchen-sink.md';
  const HTML = 'docs/app-spec.html';

  test('open: tracks the doc, starts the daemon on the test port and prints the review URL', async () => {
    const r = await ok(['open', MD]);
    const m = /^review UI: (http:\/\/127\.0\.0\.1:(\d+)\/d\/([0-9a-f]{8})\/kitchen-sink\?k=([0-9a-f]+))$/m.exec(r.stdout);
    assert.ok(m, r.stdout);
    assert.equal(Number(m[2]), PORT);
    assert.match(r.stdout, /tracking docs\/kitchen-sink\.md as "kitchen-sink" \(markdown, 83 lines\) · recorded v1/);
    wsId = m[3];
    const info = readDaemonInfo();
    assert.ok(info && pidAlive(info.pid), 'daemon.json names a live daemon');
    assert.equal(info.uiPort, PORT);
    assert.equal(info.contentPort, PORT + 1);
    assert.equal(info.token, m[4]);
    daemon = { uiPort: info.uiPort, token: info.token, pid: info.pid };
    const page = await fetch(m[1]);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<script type="module" src="\/ui\/main\.js"><\/script>/);
    // the rendered doc and the guest bundle are served by the content origin
    const st = await uiApi(wsId, 'kitchen-sink').state();
    assert.match(st.contentBase, new RegExp(`^http://127\\.0\\.0\\.1:${PORT + 1}/c/[0-9a-f]{24}$`));
    const docRes = await fetch(`${st.contentBase}/v1/docs/kitchen-sink.md`);
    assert.equal(docRes.status, 200);
    const docHtml = await docRes.text();
    assert.match(docHtml, /data-srid="\d+"/);
    const guestSrc = /<script src="([^"]+\/guest\.js)"/.exec(docHtml);
    assert.ok(guestSrc, 'the guest tag is inserted');
    assert.equal((await fetch(guestSrc[1])).status, 200);
    assert.equal((await fetch(`${st.contentBase}/v1/docs/img/arch.png`)).status, 200);
  });

  test('round 1 (Markdown): review with text, image region, table cell and suggestion is delivered to wait', async () => {
    const api = uiApi(wsId, 'kitchen-sink');
    const w = await startWait(api, 'kitchen-sink');
    assert.equal(w.res.code, null, 'wait is still listening');
    const render = await renderWs(MD);
    const v = (await api.state()).doc.head;
    assert.equal(v, 1);

    const text = await api.resolve(v, textCapture(render, 'rotated on every use'));
    assert.equal(text.preview.text, 'Agent will see: L51 §3 Tokens > 3.2 Token refresh "rotated on every use"');
    const img = await api.resolve(v, elementCapture(render, findSrid(render, (n) => n.t === 'img'), { region: { x: 0.1, y: 0.2, w: 0.4, h: 0.5 } }));
    assert.match(img.preview.text, /^Agent will see: L29 §2 Architecture .*region x10-50% y20-70%$/);
    const cell = await api.resolve(v, cellCapture(render, 'refresh_token', 'TTL', { row: 2, col: 1, text: '30 d' }));
    assert.match(cell.preview.text, /L46 .*row "refresh_token" x col "TTL" = "30 d"/);
    const sug = await api.resolve(v, textCapture(render, 'Ship rotation behind a flag.'));
    assert.equal(sug.anchor.src.text, 'Ship rotation behind a flag.');

    // the UI uploads the pick's crop first and attaches its path to the draft
    const crop = await api.attach(`data:image/png;base64,${fs.readFileSync(wsFile('docs/img/arch.png')).toString('base64')}`);
    assert.match(crop.path, /^attachments\/a1\.png$/);

    const drafts = [
      await api.draft(threadDraft(text, v, { severity: 'blocking', body: 'What happens to in-flight requests during rotation?' })),
      await api.draft(threadDraft(img, v, { body: 'The token store box is missing from this diagram.', attachments: [crop.path] })),
      await api.draft(threadDraft(cell, v, { type: 'question', body: 'Is 30 d too long for refresh tokens?' })),
      await api.draft(threadDraft(sug, v, { severity: 'nit', body: 'Name the flag.', suggestion: 'Ship rotation behind the `token_rotation` flag.' })),
    ];
    assert.deepEqual(drafts.map((d) => d.id), ['d1', 'd2', 'd3', 'd4']);
    assert.equal(w.res.code, null, 'drafts are never delivered');
    const rv = await api.submit({ verdict: 'changes_requested', body: 'Good start; a few gaps.' });
    assert.equal(rv.id, 'rv1');
    assert.deepEqual(rv.newThreads, ['t1', 't2', 't3', 't4']);

    const res = await waitExit(w);
    assert.equal(res.code, 0, res.stderr);
    const out = res.stdout;
    assert.match(out, /^SPECREVIEW FEEDBACK · kitchen-sink \(docs\/kitchen-sink\.md\) · review rv1 on v1 · CHANGES REQUESTED$/m);
    assert.match(out, /4 threads need action \(4 new\)/);
    assert.match(out, /^\[t1\] blocking · comment · L51 · §3 Tokens > 3\.2 Token refresh$/m);
    assert.match(out, /^ {2}src> Refresh tokens are rotated on every use, and the previous token is invalidated$/m);
    assert.match(out, /^\[t2\] comment · L29 · §2 Architecture · .*region x10-50% y20-70%$/m);
    assert.match(out, new RegExp(`crop: ${path.join(WS, '.specreview', 'docs', 'kitchen-sink', 'attachments', 'a1.png').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(out, /^\[t3\] question · L46 · .*row "refresh_token" x col "TTL" = "30 d"$/m);
    assert.match(out, /^ {2}src> \| refresh_token \| 30 d \| `token_store` \|$/m);
    assert.match(out, /^\[t4\] nit · suggestion · L24 · .* apply verbatim: specreview apply kitchen-sink t4$/m);
    assert.match(out, /^ {2}- Ship rotation behind a flag\.$/m);
    assert.match(out, /^ {2}\+ Ship rotation behind the `token_rotation` flag\.$/m);
    assert.match(out, /NEXT: .*specreview revise kitchen-sink --replies -/);
    const st = await api.state();
    assert.ok(st.reviews[0].deliveredTo[AGENT], 'delivery recorded for the agent');
    assert.deepEqual(st.waiters, [], 'the waiter is gone after delivery');
  });

  test('agent: apply + direct edit + revise records v2 with linked hunks and re-anchored threads', async () => {
    const api = uiApi(wsId, 'kitchen-sink');
    const applied = await ok(['apply', 'kitchen-sink', 't4']);
    assert.match(applied.stdout, /applied t4 at L24 \(exact\)/);
    assert.match(readWs(MD), /^2\. Ship rotation behind the `token_rotation` flag\.$/m);
    // feedback/apply acked the delivered review
    assert.ok((await api.state()).reviews[0].ackedBy[AGENT]);

    // the agent's Edit tool: a direct change of the commented line and of the commented cell
    editWs(MD, 'rotated on every use, and', 'rotated on every use (requests in flight keep a 30 s grace window), and');
    editWs(MD, '| refresh_token | 30 d |', '| refresh_token | 14 d |');
    const replies = {
      summary: 'Grace window, flag name, shorter refresh TTL',
      threads: {
        t1: { status: 'addressed', reply: 'Added a 30 s grace window for in-flight requests.' },
        t2: { status: 'declined', reply: 'The mermaid diagram right below already shows the token store.' },
        t3: { status: 'addressed', reply: 'Yes; lowered to 14 d.', at: `L${lineOf(MD, '| refresh_token |')}` },
        t4: { status: 'addressed', reply: 'Applied.' },
      },
    };
    const r = await ok(['revise', 'kitchen-sink', '--replies', '-'], { stdin: JSON.stringify(replies) });
    assert.match(r.stdout, /recorded v2 for kitchen-sink \(\+3 -3 lines, 3 hunks\) · responds to rv1/);
    assert.match(r.stdout, /^ {2}h1 L24 +§1\.1 Milestones +-> t4 addressed +\(tagged: apply\)$/m);
    assert.match(r.stdout, /^ {2}h2 L46 +§3 Tokens +-> t3 addressed +\(hint\)$/m);
    assert.match(r.stdout, /^ {2}h3 L51 +§3\.2 Token refresh +-> t1 addressed +\(overlap\)$/m);
    assert.match(r.stdout, /t2 declined \(reply only\)/);
    assert.match(r.stdout, /anchors: 4 threads \+ 0 locks -> .* 0 orphaned/);

    const st = await api.state();
    assert.equal(st.doc.head, 2);
    assert.equal(st.versions.length, 2);
    assert.equal(st.versions[1].respondsTo, 'rv1');
    assert.equal(st.working.dirty, false);
    const status = Object.fromEntries(st.threads.map((/** @type {any} */ t) => [t.id, t.status]));
    assert.deepEqual(status, { t1: 'addressed', t2: 'declined', t3: 'addressed', t4: 'addressed' });
    const a = (/** @type {string} */ tid) => threadOf(st, tid).anchors[2];
    assert.ok(['exact', 'edited'].includes(a('t1').state), a('t1').state);
    assert.match(a('t1').src.text, /rotated on every use/);
    assert.equal(a('t2').state, 'exact');
    assert.equal(a('t2').kind, 'element');
    assert.equal(a('t3').kind, 'cell');
    assert.equal(a('t3').state, 'edited');
    assert.equal(a('t3').cell.text, '14 d');
    assert.equal(a('t4').state, 'edited');
    assert.equal(a('t4').src.text, 'Ship rotation behind the `token_rotation` flag.');
    assert.equal(a('t4').quote.exact, 'Ship rotation behind the token_rotation flag.');

    // every thread resolves to an element of the v2 render (what the guest paints)
    const targets = await api.targets(2);
    assert.equal(targets.threads.length, 4);
    for (const t of targets.threads) assert.ok(t.srid != null, `${t.id} has a srid at v2`);
    assert.equal(targets.threads.find((/** @type {any} */ t) => t.id === 't4').quote, 'Ship rotation behind the token_rotation flag.');
  });

  test('reviewer: GET diff over the API shows the v1 -> v2 changes, thread links and mini-diffs', async () => {
    const api = uiApi(wsId, 'kitchen-sink');
    const diff = await api.diff();
    assert.equal(diff.from, 1);
    assert.equal(diff.to, 2);
    assert.equal(diff.stats.hunks, 3);
    const byThread = Object.fromEntries(diff.hunks.flatMap((/** @type {any} */ h) => h.threads.map((/** @type {string} */ t) => [t, h])));
    assert.equal(byThread.t4.linkedBy, 'tagged');
    assert.equal(byThread.t3.linkedBy, 'hint');
    assert.equal(byThread.t1.linkedBy, 'overlap');
    for (const h of diff.hunks) assert.ok(h.srids.length > 0 && h.words.length > 0, `${h.id} highlights inserted words`);
    assert.deepEqual(Object.keys(diff.threadLinks).sort(), ['t1', 't3', 't4']);
    const mini = await api.minidiff('t4');
    assert.equal(mini.kind, 'text');
    assert.equal(mini.from, 1);
    assert.equal(mini.version, 2);
    assert.match(mini.before, /Ship rotation behind a flag\./);
    assert.match(mini.after, /token_rotation/);
    // the same through the CLI
    const stat = await ok(['diff', 'kitchen-sink', '--stat']);
    assert.match(stat.stdout, /^v1\.\.v2 {2}\+3 -3 {2}3 hunks$/m);
    const unified = await ok(['diff', 'kitchen-sink', 'v1..v2', '--unified']);
    assert.match(unified.stdout, /^-2\. Ship rotation behind a flag\.$/m);
    assert.match(unified.stdout, /^\+2\. Ship rotation behind the `token_rotation` flag\.$/m);
  });

  test('round 2: a reopen, resolutions and a decision; the agent edits with edit --stdin and records v3', async () => {
    const api = uiApi(wsId, 'kitchen-sink');
    const w = await startWait(api, 'kitchen-sink');
    await api.draft({ kind: 'reply', thread: 't1', body: 'Also say what the client sees after the grace window.', reopen: true });
    await api.draft({ kind: 'resolve', thread: 't2' });
    await api.draft({ kind: 'resolve', thread: 't3', decision: 'Refresh tokens live 14 days.' });
    await api.draft({ kind: 'resolve', thread: 't4' });
    const rv = await api.submit({ verdict: 'changes_requested', body: 'Almost there.' });
    assert.deepEqual(rv.reopened, ['t1']);
    assert.deepEqual(rv.resolved, ['t2', 't3', 't4']);

    const res = await waitExit(w);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /review rv2 on v2 · CHANGES REQUESTED/);
    assert.match(res.stdout, /1 thread needs action: 1 reopened {3}\(3 resolved this round\)/);
    assert.match(res.stdout, /^\[t1\] REOPENED · blocking · comment · L51 /m);
    assert.match(res.stdout, /DECISIONS to keep true: D1 \(t3\) Refresh tokens live 14 days\./);

    const edits = [{ threads: ['t1'], old: 'keep a 30 s grace window)', new: 'keep a 30 s grace window; after it the client gets `401 token_reused`)' }];
    const e = await ok(['edit', 'kitchen-sink', '--stdin'], { stdin: JSON.stringify(edits) });
    assert.match(e.stdout, /edited L51 for t1/);
    const r = await ok(['revise', 'kitchen-sink', '--replies', '-'], {
      stdin: JSON.stringify({ summary: 'Client behaviour after the grace window', threads: { t1: { status: 'addressed', reply: 'Documented the 401.' } } }),
    });
    assert.match(r.stdout, /recorded v3 for kitchen-sink \(\+1 -1 lines, 1 hunk\) · responds to rv2/);
    assert.match(r.stdout, /h1 L51 .*-> t1 addressed +\(tagged: edit\)/);
    assert.match(r.stdout, /guards: ok/);
  });

  test('round 3: approve with markFinal; final --decisions writes the decisions file', async () => {
    const api = uiApi(wsId, 'kitchen-sink');
    const w = await startWait(api, 'kitchen-sink');
    // An approve of the version the reviewer saw (v2) while v3 is head is refused, and changes nothing.
    await assert.rejects(
      api.submit({ verdict: 'approved', body: 'Ship it.', markFinal: true, reviewedVersion: 2 }),
      /POST \/reviews -> 409 .*v3 of kitchen-sink was recorded after you opened v2.*"code":"CONFLICT"/,
    );
    assert.equal((await api.state()).doc.final ?? null, null);
    const rv = await api.submit({ verdict: 'approved', body: 'Ship it.', markFinal: true, resolveAddressed: true, reviewedVersion: 3 });
    assert.equal(rv.markFinal, true);
    assert.deepEqual(rv.resolved, ['t1']);
    const res = await waitExit(w);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /review rv3 on v3 · APPROVED/);
    assert.match(res.stdout, /specreview final kitchen-sink/);

    const f = await ok(['final', 'kitchen-sink', '--decisions']);
    assert.match(f.stdout, /final: kitchen-sink = v3 \(approved in rv3 by .*; 3 versions, 3 reviews, 4 threads resolved, 1 decision\)/);
    assert.match(f.stdout, /working copy matches v3: ok/);
    const decisions = readWs('docs/kitchen-sink.decisions.md');
    assert.match(decisions, /^# Decisions: Token Service Implementation Spec$/m);
    assert.match(decisions, /^### D1: Refresh tokens live 14 days\.$/m);
    const st = await api.state();
    assert.equal(st.doc.state, 'approved');
    assert.equal(st.doc.final.version, 3);
    const log = await ok(['log', 'kitchen-sink']);
    assert.match(log.stdout, /^final: v3 \(rv3, /m);
    const status = JSON.parse((await ok(['status', 'kitchen-sink', '--json'])).stdout);
    assert.equal(status.docs[0].final.version, 3);
    assert.equal(status.docs[0].working, 'clean');
  });

  test('round 1 (HTML): text, image region, table cell, script-generated text and a suggestion through v2', async () => {
    const opened = await ok(['open', HTML]);
    assert.match(opened.stdout, /tracking docs\/app-spec\.html as "app-spec" \(html, 124 lines\) · recorded v1/);
    assert.match(opened.stdout, new RegExp(`^review UI: http://127\\.0\\.0\\.1:${PORT}/d/${wsId}/app-spec\\?k=${daemon?.token}$`, 'm'), 'the running daemon is reused');
    assert.equal(readDaemonInfo()?.pid, daemon?.pid);
    const api = uiApi(wsId, 'app-spec');
    const st0 = await api.state();
    const docRes = await fetch(`${st0.contentBase}/v1/docs/app-spec.html`);
    assert.equal(docRes.status, 200);
    assert.match(await docRes.text(), /var stages = \['Validate cart'/, 'the author script is served untouched');

    const w = await startWait(api, 'app-spec');
    const render = await renderWs(HTML);
    const text = await api.resolve(1, textCapture(render, 'processed in three stages'));
    assert.equal(text.preview.text, 'Agent will see: L27 §1. Overview "processed in three stages"');
    const img = await api.resolve(1, elementCapture(render, findSrid(render, (n) => n.t === 'img'), { region: { x: 0, y: 0, w: 0.5, h: 0.5 } }));
    assert.match(img.preview.text, /L28 .*region x0-50% y0-50%/);
    const cell = await api.resolve(1, cellCapture(render, 'coupon', 'Priority', { row: 2, col: 2, text: '1' }));
    assert.match(cell.preview.text, /L65 .*row "coupon" x col "Priority" = "1"/);
    const ul = findSrid(render, (n) => n.t === 'ul' && n.a?.id === 'generated');
    const generated = await api.resolve(1, { kind: 'text', startSrid: ul, endSrid: ul, exact: 'Price & tax', prefix: 'Validate cart ', suffix: ' Authorize payment' });
    assert.equal(generated.anchor.generated, true);
    const sug = await api.resolve(1, textCapture(render, 'carts over 10 items'));
    await api.draft(threadDraft(text, 1, { body: 'Name the three stages here.' }));
    await api.draft(threadDraft(img, 1, { body: 'Label the gateway in the picture.' }));
    await api.draft(threadDraft(cell, 1, { type: 'question', body: 'Why does coupon beat volume_discount?' }));
    await api.draft(threadDraft(generated, 1, { body: 'Call it "Price and tax".' }));
    await api.draft(threadDraft(sug, 1, { severity: 'blocking', body: 'The threshold is 20.', suggestion: 'carts over 20 items' }));
    await api.submit({ verdict: 'changes_requested', body: '' });

    const res = await waitExit(w);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /^SPECREVIEW FEEDBACK · app-spec \(docs\/app-spec\.html\) · review rv1 on v1 · CHANGES REQUESTED$/m);
    assert.match(res.stdout, /5 threads need action \(5 new\)/);
    assert.match(res.stdout, /^ {2}src> {3}<p>Requests arrive through the API gateway and are processed in three stages\.<\/p>$/m);
    assert.match(res.stdout, /^\[t5\] blocking · suggestion · L64 · .*apply verbatim: specreview apply app-spec t5$/m);
    assert.match(res.stdout, /^\[t4\] comment · L96 · .*script-rendered text inside <ul id="generated">$/m);
    assert.match(res.stdout, /^ {2}src> {5}var stages = \['Validate cart', 'Price & tax', 'Authorize payment'\];$/m);

    await ok(['apply', 'app-spec', 't5']);
    assert.match(readWs(HTML), /<td>carts over 20 items<\/td>/);
    editWs(HTML, "'Price & tax'", "'Price and tax'");
    editWs(HTML, 'processed in three stages.', 'processed in three stages: validate, price, authorize.');
    const r = await ok(['revise', 'app-spec', '--replies', '-'], {
      stdin: JSON.stringify({
        summary: 'Stages named, threshold 20, stage label',
        threads: {
          t1: { status: 'addressed', reply: 'Named them.' },
          t2: { status: 'declined', reply: 'The image is generated; out of scope.' },
          t3: { status: 'answered', reply: 'Coupons are explicit customer intent.' },
          t4: { status: 'addressed', reply: 'Renamed.', at: `L${lineOf(HTML, "'Price and tax'")}` },
          t5: { status: 'addressed', reply: 'Applied.' },
        },
      }),
    });
    assert.match(r.stdout, /recorded v2 for app-spec \(\+3 -3 lines, 3 hunks\) · responds to rv1/);
    assert.match(r.stdout, /anchors: 5 threads \+ 0 locks -> .* 0 orphaned/);
    const st = await api.state();
    assert.equal(st.doc.head, 2);
    const states = Object.fromEntries(st.threads.map((/** @type {any} */ t) => [t.id, t.anchors[2].state]));
    assert.equal(states.t2, 'exact');
    assert.equal(states.t3, 'exact');
    assert.equal(states.t5, 'edited');
    const diff = await api.diff();
    assert.deepEqual(diff.hunks.map((/** @type {any} */ h) => h.threads).flat().sort(), ['t1', 't4', 't5']);
  });

  test('hooks: prompt reports an undelivered review, pre-write denies a full rewrite; both answer fast', async () => {
    const api = uiApi(wsId, 'app-spec');
    await api.submit({ verdict: 'comment', body: 'One more look later.' }); // nobody is waiting
    const promptInput = JSON.stringify({ session_id: 's1', prompt: 'continue', cwd: WS });
    const p = await ok(['hook', 'prompt'], { stdin: promptInput });
    const ctx = JSON.parse(p.stdout).hookSpecificOutput;
    assert.equal(ctx.hookEventName, 'UserPromptSubmit');
    assert.match(ctx.additionalContext, /review rv2 on app-spec .* not delivered/);
    const pw = await ok(['hook', 'pre-write'], {
      stdin: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: wsFile(MD), content: '# Rewritten\n' }, cwd: WS }),
    });
    const deny = JSON.parse(pw.stdout).hookSpecificOutput;
    assert.equal(deny.permissionDecision, 'deny');
    assert.match(deny.permissionDecisionReason, /docs\/kitchen-sink\.md is under SpecReview/);
    // outside a workspace: silent, exit 0
    const none = await ok(['hook', 'prompt'], { stdin: JSON.stringify({ prompt: 'x', cwd: USER_HOME }) });
    assert.equal(none.stdout, '');
    // timing (amendments 5: < 150 ms cold; generous here because test files run in parallel)
    const times = [];
    for (let i = 0; i < 3; i++) times.push((await ok(['hook', 'prompt'], { stdin: promptInput })).ms);
    assert.ok(Math.min(...times) < 1500, `hook prompt took ${times.join(', ')} ms`);
  });

  test('mcp: tools/list and a tool call over stdio against the real engine', async () => {
    const child = spawn(process.execPath, [BIN, 'mcp'], { cwd: WS, env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    const send = (/** @type {any} */ m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const reply = (/** @type {number} */ id) =>
      until(() => out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === id), `mcp reply ${id}`, 15000);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } });
    assert.equal((await reply(1)).result.serverInfo.name, 'specreview');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = (await reply(2)).result.tools.map((/** @type {any} */ t) => t.name);
    for (const n of ['specreview_open', 'specreview_wait', 'specreview_feedback', 'specreview_apply', 'specreview_edit', 'specreview_revise', 'specreview_final']) {
      assert.ok(names.includes(n), `${n} is listed`);
    }
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'specreview_threads', arguments: { doc: 'app-spec', status: 'all' } } });
    const call = (await reply(3)).result;
    assert.notEqual(call.isError, true, JSON.stringify(call));
    assert.deepEqual(call.structuredContent.threads.map((/** @type {any} */ t) => t.id), ['t1', 't2', 't3', 't4', 't5']);
    assert.match(call.content[0].text, /t5/);
    child.stdin.end();
    const code = await new Promise((resolve) => child.on('close', resolve));
    children.delete(child);
    assert.equal(code, 0);
  });

  test('install claude without --apply is a dry run: prints the plan, writes nothing', async () => {
    const r = await ok(['install', 'claude', '--with-hooks', '--with-mcp']);
    const claudeDir = path.join(USER_HOME, '.claude');
    assert.match(r.stdout, new RegExp(`would create ${claudeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/skills/spec-review/SKILL\\.md`));
    assert.match(r.stdout, /hook pre-write/);
    assert.match(r.stdout, /claude mcp add --scope user specreview -- /);
    assert.match(r.stdout, /dry run: nothing written/);
    assert.equal(fs.existsSync(claudeDir), false, 'nothing was written');
    assert.deepEqual(fs.readdirSync(USER_HOME), []);
  });

  test('stop: the daemon shuts down', async () => {
    const pid = /** @type {number} */ (daemon?.pid);
    await ok(['stop']);
    await until(() => !pidAlive(pid), 'daemon exit', 8000);
    assert.equal(await portFree(PORT), true);
  });
});
