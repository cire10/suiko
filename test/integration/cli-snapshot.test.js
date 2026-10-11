// @ts-check
// The CLI commands that review text which is not a workspace file, against the real engine (main() in-process,
// ensureDaemon stubbed): `open -` (piped text, `--name` re-pipes as vN+1), `open <dir>` (recursive, skips,
// the 200-file cap), `last` (a fixture Claude Code transcript; the scratch workspace when the cwd is $HOME),
// `revise --source` and the refusals of file-only commands on snapshot docs.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import * as ops from '../../src/core/review/index.js';
import { main } from '../../src/cli/main.js';
import { memorySink } from '../../src/cli/io.js';
import { expandPaths } from '../../src/cli/commands/open.js';
import { scratchRootFor } from '../../src/cli/snapshot.js';
import { engineCtx, makeWorkspace, textCapture } from '../helpers/engine.js';

const DAEMON = { pid: 1, uiPort: 5873, contentPort: 5874, token: 'tok', secret: 's', version: '0.1.0', startedAt: '' };
const SID = '7c1d2e3f-aaaa-4bbb-8ccc-dddd00001111';

/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
beforeEach(async () => {
  ws = await makeWorkspace({ files: ['kitchen-sink.md'] });
  fs.mkdirSync(path.join(ws.root, '.git'));
});
afterEach(async () => {
  await ws.cleanup();
});

/**
 * Runs the CLI in-process (ensureDaemon and the browser stubbed).
 * @param {string[]} argv
 * @param {{ input?: string, cwd?: string }} [o]
 */
async function cli(argv, o = {}) {
  const out = memorySink();
  const err = memorySink();
  /** @type {string[]} */
  const opened = [];
  const code = await main(argv, {
    cwd: o.cwd ?? ws.root,
    env: {
      SPECREVIEW_BROWSER: 'none',
      SPECREVIEW_HOME: /** @type {string} */ (process.env.SPECREVIEW_HOME),
      HOME: process.env.HOME,
      ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } : {}),
    },
    stdin: Readable.from(o.input !== undefined ? [Buffer.from(o.input)] : []),
    stdout: out,
    stderr: err,
    ensureDaemon: async () => /** @type {any} */ (DAEMON),
    openBrowser: async (url) => void opened.push(url),
    pollMs: 50,
  });
  return { code, stdout: out.text(), stderr: err.text(), opened };
}

/**
 * The reviewer comments on `quote` in the doc's head and submits.
 * @param {string} docId
 * @param {string} quote
 * @param {string} [root]
 */
async function review(docId, quote, root = ws.root) {
  const ctx = await engineCtx(root);
  const doc = await ctx.store.requireDoc(docId);
  const render = await ctx.render(doc, doc.head);
  await ops.saveDraft(ctx, docId, { kind: 'thread', type: 'comment', capture: textCapture(render, quote), body: 'Say more.' });
  await ops.submitReview(ctx, docId, { verdict: 'changes_requested', body: '' });
  return ctx;
}

const NOTES = '# Release notes\n\n- Faster sync.\n- Fixed the login loop.\n';

describe('open -', () => {
  test('--name: the first pipe records v1, a changed re-pipe vN+1, an identical one nothing', async () => {
    const a = await cli(['open', '-', '--name', 'notes'], { input: NOTES });
    assert.equal(a.code, 0, a.stderr);
    const lines = a.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'specreview: tracking piped text as "notes" (markdown, 4 lines) · recorded v1');
    assert.match(lines[1], /^review UI: http:\/\/127\.0\.0\.1:5873\/d\/[^/]+\/notes\?k=tok$/);
    assert.equal(lines[2], 'next: run `specreview wait notes` in the background');
    assert.equal(lines.length, 3);

    const ctx = await engineCtx(ws.root);
    const doc = await ctx.store.requireDoc('notes');
    assert.deepEqual([doc.kind, doc.path, doc.title, doc.origin.key, doc.origin.name], ['snapshot', 'text/notes.md', 'Release notes', 'stdin:notes', 'notes']);

    const b = await cli(['open', '-', '--name', 'notes'], { input: NOTES.replace('Faster sync.', 'Much faster sync.') });
    assert.equal(b.code, 0, b.stderr);
    assert.equal(b.stdout.split('\n')[0], 'specreview: recorded v2 of "notes" (piped text; +1 -1 lines)');
    const c = await cli(['open', '-', '--name', 'notes', '--json'], { input: NOTES.replace('Faster sync.', 'Much faster sync.') });
    assert.equal(c.code, 0, c.stderr);
    const j = JSON.parse(c.stdout);
    assert.deepEqual([j.doc, j.version, j.created, j.scratch, j.ref, j.name], ['notes', 2, false, false, 'notes', 'notes']);
    assert.equal(fs.existsSync(path.join(ws.root, 'text')), false, 'nothing written at the synthetic path');
  });

  test('without --name every pipe is a new doc; --title names it', async () => {
    const a = await cli(['open', '-', '--title', 'Draft answer'], { input: 'Some text.\n' });
    const b = await cli(['open', '-', '--title', 'Draft answer'], { input: 'Some text.\n' });
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    assert.match(a.stdout, /^specreview: tracking piped text as "draft-answer" /);
    assert.match(b.stdout, /^specreview: tracking piped text as "draft-answer-2" /);
  });

  test('usage errors: empty stdin, - with other paths, --name without -', async () => {
    const empty = await cli(['open', '-'], { input: '  \n' });
    assert.equal(empty.code, 1);
    assert.match(empty.stderr, /nothing was piped on stdin/);
    const mixed = await cli(['open', '-', 'docs/kitchen-sink.md'], { input: 'x' });
    assert.equal(mixed.code, 1);
    const name = await cli(['open', 'docs/kitchen-sink.md', '--name', 'n']);
    assert.equal(name.code, 1);
  });
});

describe('open <dir>', () => {
  test('tracks the spec files recursively, skips dot-dirs, node_modules and outside symlinks, prints the home URL', async () => {
    const d = (/** @type {string} */ rel, text = '# T\n\ntext\n') => {
      const abs = path.join(ws.root, 'specs', rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
      return abs;
    };
    d('a.md', '# A\n');
    d('sub/b.markdown', '# B\n');
    d('sub/c.html', '<h1>C</h1>\n');
    d('notes.txt', 'not a spec');
    d('.drafts/hidden.md');
    d('node_modules/pkg/readme.md');
    const outside = path.join(path.dirname(ws.root), 'outside.md');
    fs.writeFileSync(outside, '# Outside\n');
    fs.symlinkSync(outside, path.join(ws.root, 'specs', 'link-out.md'));
    fs.symlinkSync(path.join(ws.root, 'specs', 'a.md'), path.join(ws.root, 'specs', 'sub', 'link-in.md'));

    const r = await cli(['open', 'specs']);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.deepEqual(lines.slice(0, 4), [
      'specreview: tracking specs/a.md as "a" (markdown, 1 lines) · recorded v1',
      'specreview: tracking specs/sub/b.markdown as "b" (markdown, 1 lines) · recorded v1',
      'specreview: tracking specs/sub/c.html as "c" (html, 1 lines) · recorded v1',
      // sub/link-in.md resolves to a.md, which is tracked once
      'review UI (all docs): http://127.0.0.1:5873/?k=tok',
    ]);
    assert.equal(lines[4], 'skipped: 1 dot-directory, 1 node_modules, 1 symlink leading outside the directory');
    assert.equal(lines[5], 'next: run `specreview wait --all` in the background');
    assert.equal(lines[6], `created ${path.join(ws.root, '.specreview')}/ (commit it with the specs)`);
    assert.equal(lines.length, 7);

    const again = await cli(['open', 'specs', '--json']);
    assert.equal(again.code, 0, again.stderr);
    const j = JSON.parse(again.stdout);
    assert.deepEqual(j.docs.map((/** @type {any} */ x) => [x.doc, x.created]), [['a', false], ['b', false], ['c', false]]);
    assert.equal(j.home, 'http://127.0.0.1:5873/?k=tok');
    assert.deepEqual(j.skipped, { dot: 1, nodeModules: 1, denied: 0, symlinks: 1, overCap: 0 });
  });

  test('stops at 200 files and counts the rest; a directory without specs is a usage error', async () => {
    const dir = path.join(ws.root, 'many');
    fs.mkdirSync(dir);
    for (let i = 0; i < 205; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(3, '0')}.md`), `# ${i}\n`);
    const e = expandPaths(ws.root, ['many']);
    assert.equal(e.files.length, 200);
    assert.equal(e.dirs, 1);
    assert.equal(e.skipped.overCap, 5);
    assert.equal(path.basename(e.files[0]), 'f000.md');

    fs.mkdirSync(path.join(ws.root, 'empty'));
    const r = await cli(['open', 'empty']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no \.md/);
  });
});

describe('last', () => {
  /** Writes a fixture transcript and returns its path. */
  function transcript(/** @type {string} */ dir, /** @type {string[]} */ texts) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${SID}.jsonl`);
    /** @type {any[]} */
    const lines = [{ type: 'user', uuid: 'u1', parentUuid: null, sessionId: SID, message: { role: 'user', content: 'Explain the plan.' } }];
    texts.forEach((t, i) => lines.push({ type: 'assistant', uuid: `a${i}`, parentUuid: i ? `a${i - 1}` : 'u1', sessionId: SID, message: { id: 'msg_01', role: 'assistant', content: [{ type: 'text', text: t }] } }));
    lines.push({ type: 'user', uuid: 'u2', parentUuid: `a${texts.length - 1}`, sessionId: SID, message: { role: 'user', content: '<command-name>/specreview-last</command-name>' } });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  }

  test('opens the last assistant message as a snapshot doc and prints the URL and the wait command', async () => {
    const claude = path.join(ws.home, 'claude-config');
    transcript(path.join(claude, 'projects', '-some-project'), ['## Token refresh\n\nRotate on every use.', 'Grace window: 30 s.']);
    const env = { CLAUDE_CONFIG_DIR: claude };
    const r = await withEnv(env, () => cli(['last', '--session', SID]));
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'specreview: tracking agent message as "token-refresh" (markdown, 5 lines) · recorded v1');
    assert.match(lines[1], /^review UI: http:\/\/127\.0\.0\.1:5873\/d\/[^/]+\/token-refresh\?k=tok$/);
    assert.equal(
      lines[2],
      'next: run `specreview wait token-refresh` in the background (Bash run_in_background: true) and end your turn. ' +
        'When the review arrives, write your complete revised answer to a file and record it with `specreview revise token-refresh --source <file> --replies -` (replies JSON on stdin), then wait again.',
    );
    const ctx = await engineCtx(ws.root);
    const doc = await ctx.store.requireDoc('token-refresh');
    assert.deepEqual([doc.kind, doc.origin.type, doc.origin.key, doc.origin.messageId], ['snapshot', 'message', `claude-msg:${SID}:msg_01`, 'msg_01']);
    assert.equal((await ctx.store.readVersion(doc.id, 1)).source, '## Token refresh\n\nRotate on every use.\n\nGrace window: 30 s.');

    const again = await withEnv(env, () => cli(['last', '--session', SID]));
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.stdout.split('\n')[0], 'specreview: "token-refresh" (agent message) is unchanged (identical to v1)');
  });

  test('from $HOME the doc goes to the scratch workspace and every command names it', async () => {
    const userHome = path.join(path.dirname(ws.root), 'userhome');
    fs.mkdirSync(userHome);
    const file = transcript(path.join(userHome, 'transcripts'), ['Short answer.']);
    const r = await withEnv({ HOME: userHome }, () => cli(['last', '--transcript', file, '--title', 'Answer'], { cwd: userHome }));
    assert.equal(r.code, 0, r.stderr);
    const scratch = scratchRootFor(userHome);
    assert.equal(path.dirname(scratch), path.join(ws.home, 'scratch'));
    assert.match(path.basename(scratch), /^[0-9a-f]{8}$/);
    assert.match(r.stdout, new RegExp(`specreview wait answer --workspace ${esc(scratch)}\``));
    assert.match(r.stdout, new RegExp(`specreview revise answer --workspace ${esc(scratch)} --source <file>`));
    assert.match(r.stdout, /^note: this directory cannot be a workspace, so the doc lives in the scratch workspace .* \(follow-up commands need --workspace, as shown\)$/m);
    assert.equal(fs.existsSync(path.join(userHome, '.specreview')), false);
    assert.ok(fs.existsSync(path.join(scratch, '.specreview', 'docs', 'answer', 'doc.json')));

    const show = await withEnv({ HOME: userHome }, () => cli(['show', 'answer', '--workspace', scratch], { cwd: userHome }));
    assert.equal(show.code, 0, show.stderr);
    assert.match(show.stdout, /Short answer\./);
  });

  test('errors: no transcript, no message with text, both --session and --transcript', async () => {
    const env = { CLAUDE_CONFIG_DIR: path.join(ws.home, 'none') };
    const none = await withEnv(env, () => cli(['last', '--session', SID]));
    assert.equal(none.code, 4);
    assert.match(none.stderr, /no Claude Code transcript found/);
    const empty = path.join(ws.root, 'empty.jsonl');
    fs.writeFileSync(empty, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
    const noText = await cli(['last', '--transcript', empty]);
    assert.equal(noText.code, 1);
    assert.match(noText.stderr, /no assistant message with text/);
    const both = await cli(['last', '--session', SID, '--transcript', empty]);
    assert.equal(both.code, 1);
  });
});

describe('revise --source and refusals', () => {
  test('records the given text as vN+1 with replies; the usage errors explain', async () => {
    assert.equal((await cli(['open', '-', '--name', 'answer'], { input: NOTES })).code, 0);
    await review('answer', 'Fixed the login loop.');

    const noSource = await cli(['revise', 'answer', '--replies', '-'], { input: '{}' });
    assert.equal(noSource.code, 1);
    assert.match(noSource.stderr, /answer is a snapshot \(piped text\): there is no working file to record\. To revise it, write the complete revised text to a file/);
    assert.match(noSource.stderr, /specreview revise answer --source <file> --replies -/);

    const both = await cli(['revise', 'answer', '--source', '-', '--replies', '-'], { input: NOTES });
    assert.equal(both.code, 1);
    assert.match(both.stderr, /--replies must name a file/);

    const src = path.join(ws.root, 'answer-v2.md');
    fs.writeFileSync(src, NOTES.replace('Fixed the login loop.', 'Fixed the login loop on Safari.'));
    const replies = JSON.stringify({ threads: { t1: { status: 'addressed', reply: 'Named the browser.' } } });
    const r = await cli(['revise', 'answer', '--source', src, '--replies', '-'], { input: replies });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /v2/);
    const ctx = await engineCtx(ws.root);
    const doc = await ctx.store.requireDoc('answer');
    assert.equal(doc.head, 2);
    const { manifest, source } = await ctx.store.readVersion('answer', 2);
    assert.equal(manifest.capturedBy, 'snapshot');
    assert.deepEqual(manifest.hunks.map((h) => h.threads), [['t1']]);
    assert.match(source, /on Safari/);

    // --source - with --replies from a file
    const repliesFile = path.join(ws.root, 'replies.json');
    fs.writeFileSync(repliesFile, '{}');
    const viaStdin = await cli(['revise', 'answer', '--source', '-', '--replies', repliesFile], { input: `${source}- One more.\n` });
    assert.equal(viaStdin.code, 0, viaStdin.stderr);
    assert.equal((await ctx.store.requireDoc('answer')).head, 3);

    const missing = await cli(['revise', 'answer', '--source', 'nope.md']);
    assert.equal(missing.code, 4);

    assert.equal((await cli(['open', 'docs/kitchen-sink.md'])).code, 0);
    const fileDoc = await cli(['revise', 'kitchen-sink', '--source', src]);
    assert.equal(fileDoc.code, 1);
    assert.match(fileDoc.stderr, /kitchen-sink tracks the file docs\/kitchen-sink\.md: edit the file, then run revise without --source/);
  });

  test('apply, edit and revert on a snapshot are refused (exit 3) with what to do instead', async () => {
    assert.equal((await cli(['open', '-', '--name', 'answer'], { input: NOTES })).code, 0);
    await review('answer', 'Fixed the login loop.');
    const apply = await cli(['apply', 'answer', 't1']);
    assert.equal(apply.code, 3);
    assert.match(apply.stderr, /answer is a snapshot \(piped text\), not a file in the workspace, so SpecReview cannot apply suggestions to it\. Instead, write the complete revised text to a file/);
    const edit = await cli(['edit', 'answer', '--thread', 't1', '--old', 'login', '--new', 'sign-in']);
    assert.equal(edit.code, 3);
    assert.match(edit.stderr, /cannot edit it/);
    const status = await cli(['status', 'answer']);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /\(piped text\)/);
    assert.doesNotMatch(status.stdout, /working copy:/);
  });
});

/**
 * Runs `fn` with process.env overrides (the transcript lookup reads CLAUDE_CONFIG_DIR / HOME from the runtime env,
 * which cli() builds from process.env; the workspace discovery refuses os.homedir(), which reads $HOME).
 * @template T
 * @param {Record<string, string>} env
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withEnv(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** @param {string} s */
function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
