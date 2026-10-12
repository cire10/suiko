// @ts-check
// PR mode (design 4.18, WP3b): `suiko review --pr <n|url>` against a real repository whose origin is a local
// bare repository named acme/widgets.git holding refs/pull/1/head, with a fake gh (deps.gh) that records its calls.
// Covers: not checked out (one fetch into refs/specreview/pr/1, the packet's `gh pr checkout` line), checked out (the
// working tree, no fetch), the URL form, offline, gh missing / not signed in / PR not found, values from gh validated
// before any git call, no remote for the repository, rounds that never fetch, and close deleting the ref.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { main } from '../../src/cli/main.js';
import { memorySink } from '../../src/cli/io.js';
import { reviewInput } from '../../src/cli/commands/review.js';
import { parsePrArg, prRemote } from '../../src/core/code/pr.js';
import { openRepo } from '../../src/core/code/git.js';
import { lineDraft, lines, makeRepo, submit } from '../helpers/git-repo.js';

const DAEMON = { pid: 1, uiPort: 5873, contentPort: 5874, token: 'tok', secret: 's', version: '0.1.0', startedAt: '' };
const FIELDS = 'number,title,url,baseRefName,headRefName,baseRefOid,headRefOid,changedFiles';

/** @type {Awaited<ReturnType<typeof makeRepo>>} */
let r;
/** main at the branch point: the PR's base and merge-base */
let base = '';
/** the PR head */
let head = '';

beforeEach(async () => {
  r = await makeRepo({ files: { 'src/app.js': lines(10), 'README.md': '# widgets\n' } });
  base = r.git('rev-parse', 'HEAD');
  const remote = path.join(r.base, 'acme', 'widgets.git');
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  r.git('init', '-q', '--bare', remote);
  r.git('remote', 'add', 'origin', remote);
  r.git('push', '-q', 'origin', 'main');
  r.git('checkout', '-q', '-b', 'feature');
  r.write('src/app.js', lines(10).replace('line 3\n', 'line three\n'));
  r.write('src/new.js', 'export const x = 1;\n');
  head = r.commit('feature work');
  r.git('push', '-q', 'origin', 'feature', 'feature:refs/pull/1/head');
  r.git('checkout', '-q', 'main');
});
afterEach(async () => {
  await r.cleanup();
});

/**
 * A fake gh: answers repo view, pr view and the compare API for PR #1 of acme/widgets; `o` overrides answers.
 * @param {{ repo?: string, headOid?: string, mergeBase?: string, changedFiles?: number,
 *   fail?: (args: string[]) => ({ code: number, stdout: string, stderr: string } | null) }} [o]
 */
function fakeGh(o = {}) {
  /** @type {string[][]} */
  const calls = [];
  /** @param {string[]} args */
  const fn = async (args) => {
    calls.push(args);
    const failed = o.fail?.(args);
    if (failed) return failed;
    if (args[0] === 'repo' && args[1] === 'view') return { code: 0, stdout: `${o.repo ?? 'acme/widgets'}\n`, stderr: '' };
    if (args[0] === 'pr' && args[1] === 'view') {
      const meta = { number: 1, title: 'Add feature', url: 'https://github.com/acme/widgets/pull/1', baseRefName: 'main', headRefName: 'feature', baseRefOid: base, headRefOid: o.headOid ?? head, changedFiles: o.changedFiles ?? 2 };
      return { code: 0, stdout: JSON.stringify(meta), stderr: '' };
    }
    if (args[0] === 'api') return { code: 0, stdout: `${o.mergeBase ?? base}\n`, stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
  };
  return { fn, calls };
}

/**
 * Runs the CLI in-process (ensureDaemon and the browser stubbed).
 * @param {string[]} argv
 * @param {{ gh?: Function, env?: Record<string, string> }} [o]
 */
async function cli(argv, o = {}) {
  const out = memorySink();
  const err = memorySink();
  const code = await main(argv, {
    cwd: r.root,
    env: { SPECREVIEW_BROWSER: 'none', SPECREVIEW_HOME: r.home, HOME: r.base, PATH: /** @type {string} */ (process.env.PATH), ...(o.env ?? {}) },
    stdin: Readable.from([]),
    stdout: out,
    stderr: err,
    ensureDaemon: async () => /** @type {any} */ (DAEMON),
    openBrowser: async () => {},
    pollMs: 50,
    ...(o.gh ? { gh: o.gh } : {}),
  });
  return { code, stdout: out.text(), stderr: err.text() };
}

const prRefSha = () => {
  try {
    return r.git('rev-parse', '--verify', '--quiet', 'refs/specreview/pr/1');
  } catch {
    return null;
  }
};

describe('review --pr', () => {
  test('not checked out: one fetch of the PR head into refs/specreview/pr/1; the packet says to gh pr checkout', async () => {
    const g = fakeGh();
    const res = await cli(['review', '--pr', '1', '--json'], { gh: g.fn });
    assert.equal(res.code, 0, res.stderr);
    const j = JSON.parse(res.stdout);
    assert.equal(j.doc, 'cr-pr-1');
    assert.equal(j.mode, 'pr');
    assert.deepEqual(j.pr, { repo: 'acme/widgets', number: 1, url: 'https://github.com/acme/widgets/pull/1', checkedOut: false, fetched: true });
    assert.equal(j.baseSha, base);
    assert.equal(j.newSha, head);
    assert.equal(j.worktree, false);
    assert.deepEqual(j.files.map((/** @type {any} */ f) => f.path).sort(), ['src/app.js', 'src/new.js']);
    assert.equal(prRefSha(), head, 'the PR head was fetched into refs/specreview/pr/1');
    assert.deepEqual(g.calls.map((a) => a.slice(0, 2).join(' ')), ['repo view', 'pr view', `api repos/acme/widgets/compare/${base}...${head}`]);
    assert.deepEqual(g.calls[1], ['pr', 'view', '1', '-R', 'acme/widgets', '--json', FIELDS]);

    const text = await cli(['review', '--pr', '1'], { gh: fakeGh().fn });
    assert.match(text.stdout, /^suiko: code review cr-pr-1 unchanged since v1 · pr #1 \(merge-base [0-9a-f]{7}\) \.\. [0-9a-f]{7}$/m);
    assert.match(text.stdout, /^ {2}PR #1 is not checked out here: line numbers are its head [0-9a-f]{7}; run `gh pr checkout 1` before editing$/m);

    const ctx = await r.ctx();
    await lineDraft(ctx, 'cr-pr-1', { file: 'src/app.js', lines: 3, body: 'Why "three"?' });
    await submit(ctx, 'cr-pr-1');
    const fb = await cli(['feedback', 'cr-pr-1']);
    assert.equal(fb.code, 0, fb.stderr);
    assert.match(fb.stdout, new RegExp(`PR #1 is not checked out here: run \`gh pr checkout 1\` before editing; line numbers are the PR head ${head.slice(0, 7)}\\.`));
    assert.match(fb.stdout, /src> line three/);
  });

  test('checked out (HEAD is the PR head, then commits on top): merge-base .. working tree, no fetch', async () => {
    r.git('checkout', '-q', 'feature');
    const res = await cli(['review', '--pr', '1', '--json'], { gh: fakeGh().fn });
    assert.equal(res.code, 0, res.stderr);
    const j = JSON.parse(res.stdout);
    assert.equal(j.worktree, true);
    assert.deepEqual(j.pr, { repo: 'acme/widgets', number: 1, url: 'https://github.com/acme/widgets/pull/1', checkedOut: true, fetched: false });
    assert.equal(prRefSha(), null, 'nothing fetched');

    r.write('src/new.js', 'export const x = 2;\n');
    r.commit('more work');
    const again = await cli(['review', '--pr', '1', '--json'], { gh: fakeGh().fn });
    assert.equal(again.code, 0, again.stderr);
    const j2 = JSON.parse(again.stdout);
    assert.equal(j2.worktree, true, 'commits on top of the PR head still count as checked out');
    assert.equal(j2.recorded, true);
    assert.equal(j2.version, 2);
  });

  test('a PR URL pins the repository (no gh repo view); --pr goes with no other mode', async () => {
    const g = fakeGh();
    const res = await cli(['review', '--pr', 'https://github.com/acme/widgets/pull/1/files', '--json'], { gh: g.fn });
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(g.calls.map((a) => a[0]), ['pr', 'api']);
    assert.deepEqual(parsePrArg('#12'), { repo: null, number: 12 });
    for (const bad of ['0', '-1', 'abc', 'https://evil.example/acme/widgets/pull/1', '1; rm -rf /', 'https://github.com/../x/pull/1']) assert.throws(() => parsePrArg(bad), /give a PR number or/);
    const both = await cli(['review', '--pr', '1', '--uncommitted'], { gh: fakeGh().fn });
    assert.equal(both.code, 1);
    assert.match(both.stderr, /pick one of <range>, --uncommitted, --staged, --base, --commit, --pr/);
    assert.throws(() => reviewInput({ mode: 'pr' }), /mode must be one of/, 'not through MCP or reviewInput');
  });

  test('offline: exit 3, with no gh call, no fetch and no store', async () => {
    const g = fakeGh();
    const res = await cli(['review', '--pr', '1'], { gh: g.fn, env: { SPECREVIEW_OFFLINE: '1' } });
    assert.equal(res.code, 3);
    assert.match(res.stderr, /review --pr uses the network \(gh, git fetch\), and SPECREVIEW_OFFLINE is set/);
    assert.equal(g.calls.length, 0);
    assert.equal(prRefSha(), null);
    assert.equal(fs.existsSync(path.join(r.root, '.specreview')), false);
  });

  test('gh missing or not signed in: exit 1; PR not found: exit 4', async () => {
    const missing = await cli(['review', '--pr', '1'], { env: { SPECREVIEW_GH: path.join(r.base, 'no-such-gh') } });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /gh \(the GitHub CLI\) is not installed at .*no-such-gh: PR reviews need it/);

    const auth = fakeGh({ fail: () => ({ code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' }) });
    const a = await cli(['review', '--pr', '1'], { gh: auth.fn });
    assert.equal(a.code, 1);
    assert.match(a.stderr, /gh is not signed in .*: run `gh auth login`/);

    const nf = fakeGh({ fail: (args) => (args[0] === 'pr' ? { code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 1. (repository.pullRequest)\n' } : null) });
    const n = await cli(['review', '--pr', '1'], { gh: nf.fn });
    assert.equal(n.code, 4);
    assert.match(n.stderr, /PR #1 in acme\/widgets not found/);
    assert.equal(prRefSha(), null);
  });

  test('values from gh are checked before any git call: a bad oid or owner/repo is exit 1 and nothing is fetched', async () => {
    for (const o of [{ headOid: 'deadbeef' }, { headOid: '--upload-pack=touch /tmp/x' }, { mergeBase: 'HEAD~1' }, { repo: '../evil' }, { repo: 'acme/..' }, { repo: 'a/b c' }]) {
      const res = await cli(['review', '--pr', '1'], { gh: fakeGh(o).fn });
      assert.equal(res.code, 1, JSON.stringify(o));
      assert.match(res.stderr, /gh returned an invalid (head commit|merge-base|repository name)/, JSON.stringify(o));
      assert.equal(prRefSha(), null, JSON.stringify(o));
    }
    const big = await cli(['review', '--pr', '1', '--max-files', '1'], { gh: fakeGh().fn });
    assert.equal(big.code, 3, 'changedFiles is checked against the limit first');
    assert.match(big.stderr, /PR #1 changes 2 files, more than 1/);
    assert.equal(prRefSha(), null);
  });

  test('no remote for the PR repository: exit 3 with the remote to add', async () => {
    r.git('remote', 'set-url', 'origin', path.join(r.base, 'someone', 'fork.git'));
    const res = await cli(['review', '--pr', '1'], { gh: fakeGh().fn });
    assert.equal(res.code, 3);
    assert.match(res.stderr, /no git remote here points at acme\/widgets: add one \(`git remote add upstream https:\/\/github\.com\/acme\/widgets\.git`\)/);
    const repo = await openRepo(r.root);
    r.git('remote', 'add', 'upstream', 'git@github.com:Acme/Widgets.git');
    assert.equal(await prRemote(repo, 'acme/widgets'), 'upstream', 'scp-style URLs match, case-insensitively');
  });

  test('rounds never fetch: a moved PR head is picked up only by running review --pr again; close deletes the ref', async () => {
    assert.equal((await cli(['review', '--pr', '1'], { gh: fakeGh().fn })).code, 0);
    r.git('checkout', '-q', 'feature');
    r.write('src/app.js', lines(10).replace('line 3\n', 'line three\n').replace('line 5\n', 'line five\n'));
    const moved = r.commit('PR update');
    r.git('push', '-q', 'origin', 'feature:refs/pull/1/head');
    r.git('checkout', '-q', 'main');

    // the daemon's Re-snapshot path: a round from local refs only (no gh in the engine, the ref unchanged)
    const { recordCodeRound } = await import('../../src/core/code/round.js');
    const ctx = await r.ctx();
    const round = await recordCodeRound(ctx, await ctx.store.requireDoc('cr-pr-1'), { author: { kind: 'agent', name: 'claude' }, capturedBy: 'round' });
    assert.ok('nothing' in round, 'no new round: the fetched ref did not move');
    assert.equal(prRefSha(), head);

    const again = await cli(['review', '--pr', '1', '--json'], { gh: fakeGh({ headOid: moved }).fn });
    assert.equal(again.code, 0, again.stderr);
    const j = JSON.parse(again.stdout);
    assert.equal(j.recorded, true);
    assert.equal(j.newSha, moved);
    assert.equal(prRefSha(), moved);
    const doc = /** @type {any} */ (await ctx.store.requireDoc('cr-pr-1'));
    assert.equal(doc.code.pr.headOid, moved, 'the stored PR head is refreshed');

    const closed = await cli(['close', 'cr-pr-1']);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal(prRefSha(), null, 'close deletes refs/specreview/pr/1');
  });
});
