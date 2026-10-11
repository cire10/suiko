// @ts-check
// `specreview review` against real (scripted) repositories, main() in-process with the daemon stubbed: every local
// mode, the JSON and text output, the file kinds (untracked, binary, renamed, deleted, secrets excluded), re-runs
// (unchanged, a new round, a closed review reopened), the workspace at the repository root, the exit codes
// (1 not a repo, 3 refused, 4 not found / nothing to review), `--file` on ask/show, `diff` of a code review, wait's
// dirty refusal, and MCP specreview_review.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import * as ops from '../../src/core/review/ops.js';
import { main } from '../../src/cli/main.js';
import { memorySink } from '../../src/cli/io.js';
import { callTool } from '../../src/mcp/server.js';
import { TOOLS } from '../../src/mcp/tools.js';
import { lineDraft, lines, makeRepo, submit } from '../helpers/git-repo.js';

const DAEMON = { pid: 1, uiPort: 5873, contentPort: 5874, token: 'tok', secret: 's', version: '0.1.0', startedAt: '' };

/** @type {Awaited<ReturnType<typeof makeRepo>>} */
let r;
beforeEach(async () => {
  r = await makeRepo({ files: { 'src/a.js': lines(20), 'src/old.js': lines(12, (i) => `old ${i}`), 'gone.txt': 'bye\n' } });
});
afterEach(async () => {
  await r.cleanup();
});

/**
 * Runs the CLI in-process (ensureDaemon and the browser stubbed).
 * @param {string[]} argv
 * @param {{ cwd?: string, input?: string }} [o]
 */
async function cli(argv, o = {}) {
  const out = memorySink();
  const err = memorySink();
  const code = await main(argv, {
    cwd: o.cwd ?? r.root,
    env: { SPECREVIEW_BROWSER: 'none', SPECREVIEW_HOME: r.home, HOME: r.base, PATH: process.env.PATH },
    stdin: Readable.from(o.input !== undefined ? [Buffer.from(o.input)] : []),
    stdout: out,
    stderr: err,
    ensureDaemon: async () => /** @type {any} */ (DAEMON),
    openBrowser: async () => {},
    pollMs: 50,
  });
  return { code, stdout: out.text(), stderr: err.text() };
}

/**
 * `review --json` -> its JSON.
 * @param {string[]} args
 * @param {{ cwd?: string }} [o]
 */
async function reviewJson(args, o = {}) {
  const res = await cli(['review', ...args, '--json'], o);
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout);
}

describe('specreview review: modes', () => {
  test('default on a feature branch: since-base against main; the JSON of design 4.2; the file kinds', async () => {
    const base = r.git('rev-parse', 'HEAD');
    r.git('checkout', '-q', '-b', 'feat/token-refresh');
    r.write('src/a.js', lines(20, (i) => (i === 3 ? 'three' : `line ${i}`)));
    r.commit('one');
    r.write('src/new.js', lines(12, (i) => `old ${i}`).replace('old 12', 'new 12'));
    r.rm('src/old.js');
    r.rm('gone.txt');
    r.write('fresh.js', 'fresh\n');
    r.write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
    r.write('.env', 'TOKEN=x\n');
    const j = await reviewJson([]);
    assert.equal(j.doc, 'cr-feat-token-refresh');
    assert.equal(j.kind, 'code');
    assert.deepEqual([j.created, j.version, j.recorded, j.mode, j.base, j.baseSha, j.newSha, j.worktree], [true, 1, true, 'since-base', 'main', base, null, true]);
    assert.equal(j.headSha, r.git('rev-parse', 'HEAD'));
    assert.equal(j.root, r.root);
    assert.deepEqual(j.files, [
      { path: 'fresh.js', status: 'A', added: 1, removed: 0 },
      { path: 'gone.txt', status: 'D', added: 0, removed: 1 },
      { path: 'logo.png', status: 'A', added: 0, removed: 0 },
      { path: 'src/a.js', status: 'M', added: 1, removed: 1 },
      { path: 'src/new.js', oldPath: 'src/old.js', status: 'R', added: 1, removed: 1 },
    ]);
    assert.deepEqual(j.skipped, [{ path: '.env', reason: 'excluded' }, { path: 'logo.png', reason: 'binary' }]);
    assert.deepEqual(j.stats, { files: 5, added: 3, removed: 3 });
    assert.equal(j.url, `http://127.0.0.1:5873/d/${j.wsId}/cr-feat-token-refresh?k=tok`);
    assert.equal(j.ref, 'cr-feat-token-refresh');
    assert.ok(fs.existsSync(path.join(r.root, '.specreview')), 'the store is created at the repository root');
  });

  test('every explicit mode, with its text output', async () => {
    const c1 = r.git('rev-parse', 'HEAD');
    r.git('checkout', '-q', '-b', 'feat');
    r.write('src/a.js', lines(20, (i) => (i === 3 ? 'three' : `line ${i}`)));
    const c2 = r.commit('two');
    r.write('src/a.js', lines(20, (i) => (i === 3 ? 'three' : i === 4 ? 'four' : `line ${i}`)));
    r.git('add', 'src/a.js');
    r.write('wt.js', 'w\n');

    const text = await cli(['review', '--uncommitted']);
    assert.equal(text.code, 0, text.stderr);
    const out = text.stdout.trimEnd().split('\n');
    assert.match(out[0], /^specreview: code review cr-uncommitted v1 · uncommitted HEAD [0-9a-f]{7} \.\. working tree$/);
    assert.equal(out[1], '  2 files · +2 -1');
    assert.match(out[2], /^ {2}review UI: http:\/\/127\.0\.0\.1:5873\/d\/[^/]+\/cr-uncommitted\?k=tok$/);
    assert.equal(out[3], 'next: run `specreview wait cr-uncommitted` in the background');

    const cases = /** @type {Array<[string[], Record<string, unknown>]>} */ ([
      [['--staged'], { doc: 'cr-staged', mode: 'staged', worktree: false, files: 1 }],
      [['--base', 'main'], { doc: 'cr-feat', mode: 'since-base', base: 'main', baseSha: c1, files: 2 }],
      [['--base', 'main', '--committed'], { doc: 'cr-feat-2', mode: 'branch', newSha: c2, worktree: false, files: 1 }],
      [['main..feat'], { doc: 'cr-main-feat', mode: 'range', baseSha: c1, newSha: c2, files: 1 }],
      [['main...feat'], { doc: 'cr-main-feat-2', mode: 'range', baseSha: c1, newSha: c2, files: 1 }],
      [['--commit', c2.slice(0, 8)], { doc: `cr-${c2.slice(0, 7)}`, mode: 'commit', baseSha: c1, newSha: c2, files: 1 }],
    ]);
    for (const [args, want] of cases) {
      const j = await reviewJson(args);
      const got = { ...Object.fromEntries(Object.keys(want).map((k) => [k, j[k]])), files: j.files.length };
      assert.deepEqual(got, want, args.join(' '));
    }
  });

  test('--path limits the review; --title names it; a subdirectory cwd still uses the repository root', async () => {
    r.write('src/a.js', lines(21));
    r.write('other.txt', 'o\n');
    const j = await reviewJson(['--uncommitted', '--path', 'src', '--title', 'Just src'], { cwd: path.join(r.root, 'src') });
    assert.deepEqual(j.files.map((/** @type {any} */ f) => f.path), ['src/a.js']);
    assert.equal(j.root, r.root);
    assert.equal(j.ref, j.doc);
    const ctx = await r.ctx();
    assert.equal((await ctx.store.requireDoc(j.doc)).title, 'Just src');
    assert.notEqual(j.doc, (await reviewJson(['--uncommitted'])).doc, 'another spec (paths) is another review');
  });

  test('re-runs: unchanged, a new round, a closed review reopened', async () => {
    r.write('src/a.js', lines(21));
    await reviewJson(['--uncommitted']);
    const same = await cli(['review', '--uncommitted']);
    assert.match(same.stdout, /^specreview: code review cr-uncommitted unchanged since v1 · /);
    r.write('src/a.js', lines(22));
    const again = await reviewJson(['--uncommitted']);
    assert.deepEqual([again.created, again.recorded, again.version], [false, true, 2]);
    const ctx = await r.ctx();
    await ops.closeSession(ctx, 'cr-uncommitted');
    assert.equal((await ctx.store.requireDoc('cr-uncommitted')).state, 'closed');
    await reviewJson(['--uncommitted']);
    assert.notEqual((await ctx.store.requireDoc('cr-uncommitted')).state, 'closed');
  });
});

describe('specreview review: exit codes', () => {
  test('1 outside a repository; 4 nothing to review / unknown base or commit; 3 too many files or unmerged --staged', async () => {
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-plain-')));
    try {
      const res = await cli(['review'], { cwd: plain });
      assert.equal(res.code, 1);
      assert.match(res.stderr, /not inside a git repository/);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
    const nothing = await cli(['review', '--uncommitted']);
    assert.equal(nothing.code, 4);
    assert.match(nothing.stderr, /nothing to review/);
    assert.equal((await cli(['review', '--base', 'nope'])).code, 4);
    assert.equal((await cli(['review', '--commit', 'deadbeef'])).code, 4);
    assert.equal((await cli(['review', 'main..nope'])).code, 4);
    for (let i = 0; i < 3; i++) r.write(`many/${i}.txt`, `${i}\n`);
    const many = await cli(['review', '--uncommitted', '--max-files', '2']);
    assert.equal(many.code, 3);
    assert.match(many.stderr, /--path|--max-files/);
    assert.equal((await cli(['review', '--staged', '--uncommitted'])).code, 1, 'conflicting flags');
  });
});

describe('code reviews through the other commands', () => {
  test('ask / show --file, diff per file, and wait refusing a dirty review', async () => {
    r.write('src/a.js', lines(20, (i) => (i === 5 ? 'five' : `line ${i}`)));
    await reviewJson(['--uncommitted']);
    const ask = await cli(['ask', 'cr-uncommitted', '--file', 'a.js', '--lines', '5', '-m', 'five?'], { cwd: path.join(r.root, 'src') });
    assert.equal(ask.code, 0, ask.stderr);
    assert.match(ask.stdout, /asked t1 at src\/a\.js:L5/);
    const show = await cli(['show', 'cr-uncommitted', '--file', 'src/a.js', '--lines', '4-6']);
    assert.equal(show.stdout, 'src/a.js · v1 · L4-6 of 20\n4  line 4\n5  five\n6  line 6\n');
    const old = await cli(['show', 'cr-uncommitted', '--file', 'src/a.js', '--side', 'old', '--lines', '5-5', '--json']);
    assert.equal(JSON.parse(old.stdout).text, 'line 5\n');
    assert.equal((await cli(['show', 'cr-uncommitted', '--side', 'old'])).code, 1, '--side needs --file');

    r.write('src/a.js', lines(20, (i) => (i === 5 ? 'FIVE' : `line ${i}`)));
    const dirty = await cli(['wait', 'cr-uncommitted', '--timeout', '5s']);
    assert.equal(dirty.code, 3);
    assert.match(dirty.stderr, /files changed since v1 \(src\/a\.js\): run `specreview revise cr-uncommitted` to record the round first, or pass --allow-dirty/);

    const rev = await cli(['revise', 'cr-uncommitted', '-m', 'caps']);
    assert.equal(rev.code, 0, rev.stderr);
    assert.match(rev.stdout, /recorded v2 for cr-uncommitted/);
    const stat = await cli(['diff', 'cr-uncommitted', 'v1..v2']);
    assert.equal(stat.stdout, 'cr-uncommitted v1..v2 · 1 file changed · +1 -1\n  src/a.js  +1 -1\n');
    const uni = await cli(['diff', 'cr-uncommitted', 'v1..v2', '--unified']);
    assert.match(uni.stdout, /^--- a\/src\/a\.js@v1\n\+\+\+ b\/src\/a\.js@v2\n@@ -2,7 \+2,7 @@\n/);
    assert.equal((await cli(['diff', 'cr-uncommitted', 'v1..live'])).code, 1);
    const edit = await cli(['edit', 'cr-uncommitted', '--thread', 't1', '--old', 'line 6', '--new', 'six']);
    assert.equal(edit.code, 3, 'edit is refused on a code review');
    assert.equal((await cli(['revert', 'cr-uncommitted', '--hunk', 'h1'])).code, 3, 'revert too');
  });

  test('MCP specreview_review runs the same command (structured JSON)', async () => {
    r.write('src/a.js', lines(21));
    const tool = /** @type {any} */ (TOOLS.find((t) => t.name === 'specreview_review'));
    const deps = { cwd: r.root, env: { SPECREVIEW_BROWSER: 'none', SPECREVIEW_HOME: r.home, HOME: r.base, PATH: process.env.PATH }, ensureDaemon: async () => /** @type {any} */ (DAEMON) };
    const res = await callTool(tool, tool.schema.parse({ mode: 'uncommitted' }), null, deps);
    assert.ok(!res.isError, JSON.stringify(res.content));
    assert.equal(/** @type {any} */ (res.structuredContent).doc, 'cr-uncommitted');
    assert.match(res.content[0].text, /code review cr-uncommitted v1/);
    const bad = await callTool(tool, tool.schema.parse({ mode: 'commit', commit: 'deadbeef' }), null, deps);
    assert.equal(bad.isError, true);
  });
});

describe('a full loop through the CLI', () => {
  test('review -> reviewer -> wait delivers the packet -> apply -> edit -> revise --replies - -> v2 -> diff', async () => {
    r.write('src/a.js', lines(20, (i) => (i === 5 ? 'const five = 5;' : i === 12 ? 'const twelve = 12;' : `line ${i}`)));
    await reviewJson(['--uncommitted']);
    const ctx = await r.ctx({ reviewer: 'Eric' });
    await lineDraft(ctx, 'cr-uncommitted', { file: 'src/a.js', lines: 12, body: 'Call it TWELVE.' });
    await lineDraft(ctx, 'cr-uncommitted', { file: 'src/a.js', lines: 5, suggestion: 'const five = 5; // checked', body: 'note it' });
    await submit(ctx, 'cr-uncommitted');
    const w = await cli(['wait', 'cr-uncommitted', '--timeout', '10s']);
    assert.equal(w.code, 0, w.stderr);
    assert.match(w.stdout, /\[t1\] comment · src\/a\.js:L12\n  src> const twelve = 12;/);
    assert.match(w.stdout, /\[t2\] suggestion · src\/a\.js:L5 · apply verbatim: specreview apply cr-uncommitted t2/);
    assert.equal((await cli(['apply', 'cr-uncommitted', 't2'])).code, 0);
    // the agent's Edit with the src> line as old_string
    r.write('src/a.js', r.read('src/a.js').replace('const twelve = 12;', 'const TWELVE = 12;'));
    const replies = JSON.stringify({ summary: 'renamed', threads: { t1: { status: 'addressed', reply: 'Renamed.', at: 'src/a.js:L12' }, t2: { status: 'addressed', reply: 'Applied.' } } });
    const rev = await cli(['revise', 'cr-uncommitted', '--replies', '-'], { input: replies });
    assert.equal(rev.code, 0, rev.stderr);
    assert.match(rev.stdout, /src\/a\.js#h\d+\s+L5\s+-> t2 addressed\s+\(tagged: apply\)/);
    assert.match(rev.stdout, /src\/a\.js#h\d+\s+L12\s+-> t1 addressed\s+\(hint\)/);
    const t1 = /** @type {any} */ (await ctx.store.getThread('cr-uncommitted', 't1'));
    assert.deepEqual([t1.anchors['2'].file.path, t1.anchors['2'].src.startLine, t1.anchors['2'].src.text], ['src/a.js', 12, 'const TWELVE = 12;']);
    const d = await cli(['diff', 'cr-uncommitted', 'v1..v2']);
    assert.equal(d.stdout, 'cr-uncommitted v1..v2 · 1 file changed · +2 -2\n  src/a.js  +2 -2  -> t1, t2\n');
  });
});
