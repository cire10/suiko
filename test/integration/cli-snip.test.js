// @ts-check
// `specreview snip` against the real engine and store (in-process main(), plus real `bin/specreview.js` processes
// for the waiting agent): a screen snip becomes a reviewer DRAFT (GENERAL comment or question with the image
// attached, drafts.changed {source:'snip'}), --file skips the picker, --send submits a one-item review that wakes a
// background `specreview wait` whose packet names the image's absolute path, Esc cancels (exit 0, nothing added),
// no picker is exit 1, and without <doc> the doc is the workspace's only one, else the most recently active.
// The real macOS picker is NEVER run: SPECREVIEW_SCREENCAPTURE always points at the fake command of
// test/fixtures/snip/capture.js (or at a path that does not exist). SPECREVIEW_HOME is a temp dir.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '../../bin/specreview.js');
const DOC = 'kitchen-sink';
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-cli-snip-')));
// never the real /usr/sbin/screencapture, even if a test forgets to pick a fake
process.env.SPECREVIEW_SCREENCAPTURE = path.join(TMP, 'no-such-capture-command');

const h = await import('../helpers/engine.js');
const ops = await import('../../src/core/review/index.js');
const { main } = await import('../../src/cli/main.js');
const { memorySink } = await import('../../src/cli/io.js');
const { createFakeCapture, makePng } = await import('../fixtures/snip/capture.js');

const fake = createFakeCapture(path.join(TMP, 'fake'));

/** @type {Awaited<ReturnType<typeof h.makeWorkspace>>} */
let ws;
/** @type {any} */
let ctx;

before(async () => {
  ws = await h.makeWorkspace(); // also points SPECREVIEW_HOME at a temp dir
  fs.mkdirSync(path.join(ws.root, '.git'));
  ctx = await h.engineCtx(ws.root);
  await ops.openDoc(ctx, { path: 'docs/kitchen-sink.md' });
});
after(async () => {
  await ws?.cleanup();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/**
 * Runs the CLI in-process with the fake picker in `mode` (or an explicit SPECREVIEW_SCREENCAPTURE).
 * @param {string[]} argv
 * @param {{ mode?: string, capture?: string, cwd?: string, home?: string }} [o]
 */
async function cli(argv, o = {}) {
  const out = memorySink();
  const err = memorySink();
  const code = await main(argv, {
    cwd: o.cwd ?? ws.root,
    env: {
      SPECREVIEW_HOME: /** @type {string} */ (process.env.SPECREVIEW_HOME),
      HOME: o.home ?? process.env.HOME,
      SPECREVIEW_SCREENCAPTURE: o.capture ?? fake.command(o.mode ?? 'ok'),
    },
    stdin: Readable.from([]),
    stdout: out,
    stderr: err,
    ensureDaemon: async () => /** @type {any} */ ({ pid: 1, uiPort: 5871, contentPort: 5872, token: 'tok', secret: 's', version: '0.1.0', startedAt: '' }),
    openBrowser: async () => {},
  });
  return { code, stdout: out.text(), stderr: err.text() };
}

/** Runtime events of the main workspace's doc. @returns {Promise<any[]>} */
function events() {
  return ctx.store.readEvents(DOC);
}

/** @param {string} root @param {string} docId */
function attachmentsDir(root, docId) {
  return path.join(root, '.specreview', 'docs', docId, 'attachments');
}

/** @param {() => boolean | Promise<boolean>} cond */
async function until(cond, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('specreview snip', () => {
  test('picker -> a GENERAL draft comment with the screenshot attached; the UI is told (drafts.changed source snip)', async () => {
    const before = fake.calls().length;
    const r = await cli(['snip', DOC, '-m', 'The header overlaps the logo']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'specreview: added a screenshot to kitchen-sink as draft d1 - open the review UI to comment and submit\n');
    assert.equal(r.stderr, '', 'an explicit doc is not announced');
    const calls = fake.calls();
    assert.equal(calls.length, before + 1, 'the picker ran once');
    assert.deepEqual(calls.at(-1)?.args.slice(0, 2), ['-i', '-x']);

    const drafts = (await ctx.store.getDrafts(DOC)).items;
    assert.equal(drafts.length, 1);
    const d = drafts[0];
    assert.equal(d.id, 'd1');
    assert.equal(d.kind, 'thread');
    assert.equal(d.type, 'comment');
    assert.equal(d.severity, 'normal');
    assert.equal(d.body, 'The header overlaps the logo');
    assert.equal(d.anchor.kind, 'doc');
    assert.deepEqual(d.attachments, ['attachments/a1.png']);
    assert.deepEqual(fs.readFileSync(path.join(attachmentsDir(ws.root, DOC), 'a1.png')), fake.small);

    const ev = (await events()).filter((e) => e.type === 'drafts.changed');
    assert.deepEqual(ev.map((e) => ({ draft: e.draft, source: e.source })), [{ draft: 'd1', source: 'snip' }]);
  });

  test('--question --json: a question draft; the JSON names the draft and the stored image', async () => {
    const r = await cli(['snip', DOC, '--question', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.doc, DOC);
    assert.equal(j.chosen, 'explicit');
    assert.equal(j.cancelled, false);
    assert.equal(j.draft, 'd2');
    assert.equal(j.type, 'question');
    assert.equal(j.sent, false);
    assert.equal(j.review, null);
    assert.equal(j.attachment.path, 'attachments/a2.png');
    assert.equal(j.attachment.file, path.join(attachmentsDir(ws.root, DOC), 'a2.png'));
    assert.deepEqual([j.attachment.width, j.attachment.height], [40, 30]);
    const d2 = (await ctx.store.getDrafts(DOC)).items.find((/** @type {any} */ d) => d.id === 'd2');
    assert.equal(d2.type, 'question');
    assert.equal(d2.body, '');
  });

  test('--file attaches an existing image without the picker (relative path, ~ expansion); bad files are errors', async () => {
    const png = makePng(12, 9);
    fs.writeFileSync(path.join(ws.root, 'shot.png'), png);
    const before = fake.calls().length;
    const r = await cli(['snip', DOC, '--file', 'shot.png', '-m', 'From the design review', '--json'], { mode: 'fail' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fake.calls().length, before, 'no picker with --file');
    const j = JSON.parse(r.stdout);
    assert.deepEqual([j.attachment.width, j.attachment.height], [12, 9]);
    assert.deepEqual(fs.readFileSync(j.attachment.file), png);

    // a Shortcut's shell may pass ~ unexpanded
    const viaHome = await cli(['snip', DOC, '--file', '~/shot.png', '--json'], { mode: 'fail', home: ws.root });
    assert.equal(viaHome.code, 0, viaHome.stderr);
    assert.deepEqual(fs.readFileSync(JSON.parse(viaHome.stdout).attachment.file), png);
    for (const id of [j.draft, JSON.parse(viaHome.stdout).draft]) await ops.deleteDraft(ctx, DOC, id); // keep later counts simple

    const missing = await cli(['snip', DOC, '--file', 'nope.png'], { mode: 'fail' });
    assert.equal(missing.code, 4);
    assert.match(missing.stderr, /^specreview: snip --file: no such file: .*nope\.png$/m);
    fs.writeFileSync(path.join(ws.root, 'notes.txt'), 'not an image');
    const notImage = await cli(['snip', DOC, '--file', 'notes.txt'], { mode: 'fail' });
    assert.equal(notImage.code, 1);
    assert.match(notImage.stderr, /is not a PNG or JPEG image/);
    assert.equal(fake.calls().length, before, 'still no picker');
  });

  test('Esc in the picker: exit 0, "cancelled", nothing stored or announced', async () => {
    const drafts = (await ctx.store.getDrafts(DOC)).items.length;
    const files = fs.readdirSync(attachmentsDir(ws.root, DOC)).length;
    const eventCount = (await events()).length;
    const r = await cli(['snip', DOC, '-m', 'never mind'], { mode: 'cancel' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'specreview: snip cancelled; nothing was added\n');
    const j = JSON.parse((await cli(['snip', DOC, '--json'], { mode: 'cancel' })).stdout);
    assert.equal(j.cancelled, true);
    assert.equal((await ctx.store.getDrafts(DOC)).items.length, drafts);
    assert.equal(fs.readdirSync(attachmentsDir(ws.root, DOC)).length, files);
    assert.equal((await events()).length, eventCount);
  });

  test('no picker on this machine: exit 1 with a clear message, nothing added', async () => {
    const drafts = (await ctx.store.getDrafts(DOC)).items.length;
    const r = await cli(['snip', DOC], { capture: path.join(TMP, 'no-such-capture-command') });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^specreview: screen snips need .*no-such-capture-command, which does not exist\. Attach an existing image with --file <png>/m);
    assert.equal(r.stdout, '');
    const j = await cli(['snip', DOC, '--json'], { capture: path.join(TMP, 'no-such-capture-command') });
    assert.equal(j.code, 1);
    assert.equal(JSON.parse(j.stdout).error.code, 'unsupported');
    assert.equal((await ctx.store.getDrafts(DOC)).items.length, drafts);
  });

  test('--send wakes a background `specreview wait`: the packet item is GENERAL and names the absolute image path', async () => {
    // the drafts of the earlier tests stay drafts: --send submits only its own one
    const draftsBefore = (await ctx.store.getDrafts(DOC)).items.map((/** @type {any} */ d) => d.id);
    const waiter = spawn(process.execPath, [BIN, 'wait', DOC], {
      cwd: ws.root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, SPECREVIEW_HOME: process.env.SPECREVIEW_HOME, CLAUDECODE: '1', SPECREVIEW_SCREENCAPTURE: path.join(TMP, 'no-such-capture-command') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    waiter.stdout.on('data', (d) => (stdout += d));
    waiter.stderr.on('data', (d) => (stderr += d));
    const done = new Promise((resolve) => waiter.on('close', (code) => resolve(code)));
    try {
      await until(async () => (await ctx.store.listWaiters(DOC)).some((/** @type {any} */ w) => w.pid === waiter.pid));
      const r = await cli(['snip', DOC, '--send', '-m', 'This is the login page today']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, 'specreview: sent a screenshot to claude as review rv1 on kitchen-sink\n');
      const code = await done;
      assert.equal(code, 0, stderr);
    } finally {
      waiter.kill('SIGKILL');
    }
    const t1 = await ctx.store.getThread(DOC, 't1');
    assert.equal(t1.attachments.length, 1);
    const abs = ctx.store.attachmentPath(DOC, t1.attachments[0]);
    assert.ok(path.isAbsolute(abs) && abs.startsWith(attachmentsDir(ws.root, DOC)), abs);
    assert.match(stdout, /^SPECREVIEW FEEDBACK · kitchen-sink \(docs\/kitchen-sink\.md\) · review rv1 on v1 · COMMENT$/m);
    assert.match(stdout, /^\[t1\] comment · GENERAL$/m);
    assert.ok(stdout.includes(`\n  image: ${abs}  (Read it to see the image the reviewer attached)\n`), stdout);
    assert.match(stdout, /^ {2}\S+: This is the login page today$/m, 'the reviewer comment (configured reviewer name)');
    assert.ok(fs.existsSync(abs));

    const rv = await ctx.store.getReview(DOC, 'rv1');
    assert.equal(rv.verdict, 'comment');
    assert.deepEqual(rv.newThreads, ['t1']);
    assert.equal(t1.anchors['1'].kind, 'doc');
    assert.deepEqual((await ctx.store.getDrafts(DOC)).items.map((/** @type {any} */ d) => d.id), draftsBefore, 'only the snip draft was submitted');
    const ev = (await events()).filter((e) => e.type === 'drafts.changed' && e.source === 'snip');
    // the UI is told about --send snips too (it toasts without [Edit] once the draft is gone)
    assert.match(String(ev.at(-1)?.draft), /^d\d+$/);
    assert.ok(!draftsBefore.includes(ev.at(-1)?.draft), 'the announced draft is the submitted one');
  });

  test('--send with nobody waiting: delivered by the next wait (JSON says who listened)', async () => {
    const r = await cli(['snip', DOC, '--send', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.sent, true);
    assert.equal(j.review, 'rv2');
    assert.deepEqual(j.listening, []);
    const t = await cli(['snip', DOC, '--send']);
    assert.match(t.stdout, /^specreview: sent a screenshot to the agent as review rv3 on kitchen-sink \(nobody is waiting right now; it is delivered by the next `specreview wait`\)$/m);
  });

  test('MCP specreview_feedback carries the snipped images: absolute paths in the text and the structured packet', async () => {
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const { callTool } = await import('../../src/mcp/server.js');
    const tool = /** @type {any} */ (TOOLS.find((x) => x.name === 'specreview_feedback'));
    const res = await callTool(tool, { doc: DOC, peek: true }, null, { cwd: ws.root, env: { SPECREVIEW_HOME: process.env.SPECREVIEW_HOME, CLAUDECODE: '1' } });
    assert.equal(res.isError, undefined, res.content[0].text);
    const text = res.content[0].text;
    const shown = [...text.matchAll(/^ {2}image: (\S+) {2}\(Read it to see the image the reviewer attached\)$/gm)].map((m) => m[1]);
    assert.equal(shown.length, 3, text); // t1 (delivered, still open) + t2 / t3 of the undelivered rv2 / rv3
    for (const p of shown) {
      assert.ok(path.isAbsolute(p) && fs.existsSync(p), p);
    }
    const packet = /** @type {any} */ (res.structuredContent)?.packets?.[0] ?? res.structuredContent;
    const threads = /** @type {any[]} */ (packet?.threads ?? []);
    assert.deepEqual(threads.map((t) => t.attachments).flat(), shown, 'JSON packets keep the absolute paths');
    assert.deepEqual([...new Set(threads.map((t) => t.attachmentKind))], ['image']);
  });
});

describe('specreview snip without <doc>', () => {
  /** @type {Array<{ root: string, id: string, ctx: any }>} */
  const extra = [];

  before(async () => {
    // two more workspaces: "multi" tracks two docs, "solo" one; all three are registered in SPECREVIEW_HOME
    for (const [name, files] of /** @type {Array<[string, string[]]>} */ ([['multi', ['alpha.md', 'beta.md']], ['solo', ['gamma.md']]])) {
      const root = path.join(TMP, name);
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });
      const c = await ops.createContext({ root, cwd: root, agent: 'claude', reviewer: 'Eric', createStore: true });
      for (const f of files) {
        fs.writeFileSync(path.join(root, f), `# ${f}\n\nSome text.\n`);
        const opened = await ops.openDoc(c, { path: f });
        extra.push({ root, id: opened.doc.id, ctx: c });
      }
    }
  });

  /** Makes a doc the most recently active one (a new event, strictly later than every earlier one). @param {string} id */
  async function touch(id) {
    const e = /** @type {{ ctx: any }} */ (extra.find((x) => x.id === id) ?? { ctx });
    await new Promise((r) => setTimeout(r, 5));
    await e.ctx.store.appendEvent(id, { type: 'presence' });
    await new Promise((r) => setTimeout(r, 5));
  }

  test('the workspace\'s only doc (cwd inside it), even when another doc is more recent', async () => {
    await touch('alpha');
    const r = await cli(['snip', '--json'], { cwd: path.join(TMP, 'solo') });
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.doc, 'gamma');
    assert.equal(j.chosen, 'workspace');
    assert.equal(r.stderr, '');
  });

  test('a workspace with several docs: the most recently active one, named on stderr', async () => {
    await touch('beta');
    const r = await cli(['snip'], { cwd: path.join(TMP, 'multi') });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^specreview: added a screenshot to beta as draft d1/);
    assert.match(r.stderr, /^specreview: no doc given; snipping to beta, the most recently active of 2 tracked docs \(pass the doc to choose\)$/m);
    const viaFlag = await cli(['snip', '--workspace', path.join(TMP, 'multi'), '--json'], { cwd: TMP });
    assert.equal(JSON.parse(viaFlag.stdout).doc, 'beta');
  });

  test('outside every workspace (a Shortcut started in $HOME): the most recently active doc of all workspaces', async () => {
    const away = path.join(TMP, 'elsewhere');
    fs.mkdirSync(away, { recursive: true });
    await touch('gamma');
    const r = await cli(['snip', '--json'], { cwd: away });
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.doc, 'gamma');
    assert.equal(j.chosen, 'recent');
    assert.equal(j.root, path.join(TMP, 'solo'));
    assert.match(r.stderr, new RegExp(`^specreview: no doc given; snipping to gamma in ${path.join(TMP, 'solo').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, the most recently active of \\d+ tracked docs`, 'm'));
    const drafts = await extra.find((x) => x.id === 'gamma')?.ctx.store.getDrafts('gamma');
    assert.equal(drafts.items.at(-1).attachments.length, 1);

    // a closed session is skipped while an open doc exists
    await ops.closeSession(/** @type {any} */ (extra.find((x) => x.id === 'gamma')).ctx, 'gamma');
    await touch('gamma');
    const next = JSON.parse((await cli(['snip', '--json'], { cwd: away })).stdout);
    assert.equal(next.doc, 'beta');
  });

  test('--workspace without tracked docs is exit 4', async () => {
    const empty = path.join(TMP, 'empty');
    fs.mkdirSync(path.join(empty, '.specreview'), { recursive: true });
    await ops.createContext({ root: empty, cwd: empty, createStore: true });
    const r = await cli(['snip', '--workspace', empty]);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /no tracked docs in /);
  });
});
