// @ts-check
// Doc lookup when the agent does not run from the workspace root (src/cli/runtime.js openContext / docContext /
// relatedWorkspaceRoots) and the `next:` hint of `open` (src/cli/commands/open.js docRef), against the real engine
// and store. Without git, `.specreview/` lives next to the spec (e.g. docs/.specreview) while the agent runs
// `specreview wait my-spec` from the project root:
//   - an id is found from the parent dir for wait / status / feedback / revise;
//   - the same id in two related workspaces is a UsageError naming both;
//   - unrelated registered workspaces (siblings, a prefix-sharing sibling) are never matched;
//   - `wait` without a doc picks the single related workspace's single doc;
//   - `open` prints the id when the cwd's workspace is the doc's, else the path relative to the cwd, and that
//     hinted command works as printed.
// The temp dirs are used through os.tmpdir() without realpath, so on macOS the cwd comes through the /var ->
// /private/var symlink while the registry stores real paths. Binds no ports (ensureDaemon is stubbed).

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-lookup-'));
const HOME = path.join(BASE, 'home');
fs.mkdirSync(HOME);
process.env.SPECREVIEW_HOME = HOME;

const { main } = await import('../../src/cli/main.js');
const { memorySink } = await import('../../src/cli/io.js');
const ops = await import('../../src/core/review/index.js');
const { createContext } = await import('../../src/core/review/context.js');
const { relatedWorkspaceRoots } = await import('../../src/cli/runtime.js');

const SPEC = ['# My Spec', '', '## Goals', '', 'The service MUST retry 3 times.', '', '## Limits', '', 'Requests time out after 30 s.', ''].join('\n');

/**
 * Runs the CLI in-process from `cwd` against the real engine.
 * @param {string} cwd
 * @param {string[]} argv
 * @param {{ input?: string }} [o]
 */
async function cli(cwd, argv, o = {}) {
  const out = memorySink();
  const err = memorySink();
  const code = await main(argv, {
    cwd,
    env: { SPECREVIEW_HOME: HOME, CLAUDECODE: '1' },
    stdin: Readable.from(o.input !== undefined ? [Buffer.from(o.input)] : []),
    stdout: out,
    stderr: err,
    ensureDaemon: async () => /** @type {any} */ ({ pid: 1, uiPort: 5891, contentPort: 5892, token: 'tok', secret: 's', version: '0.1.0', startedAt: '' }),
    openBrowser: async () => {},
    pollMs: 30,
    heartbeatMs: 60000,
  });
  return { code, stdout: out.text(), stderr: err.text() };
}

/**
 * Writes a spec file (creating its directories) and returns its path.
 * @param {string} file
 * @param {string} [text]
 */
function writeSpec(file, text = SPEC) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/**
 * The reviewer submits a comment on `quote` (played through the engine, like the daemon would).
 * @param {string} root workspace root
 * @param {string} docId
 * @param {string} quote
 * @param {string} body
 */
async function review(root, docId, quote, body) {
  const ctx = await createContext({ root, cwd: root, agent: 'claude', reviewer: 'Eric' });
  const doc = /** @type {any} */ (await ctx.store.getDoc(docId));
  const render = await ctx.render(doc, doc.head);
  const text = render.text.text;
  const g0 = text.indexOf(quote);
  assert.ok(g0 >= 0, `${quote} is not in the rendered text`);
  // the element whose rendered span contains the quote
  let srid = null;
  let best = Infinity;
  for (const s of render.srcmap.order) {
    const span = render.text.spans[s];
    if (span && span[0] <= g0 && span[1] >= g0 + quote.length && span[1] - span[0] < best) {
      srid = s;
      best = span[1] - span[0];
    }
  }
  const capture = { kind: 'text', startSrid: srid, endSrid: srid, exact: quote, prefix: text.slice(Math.max(0, g0 - 32), g0), suffix: text.slice(g0 + quote.length, g0 + quote.length + 32) };
  await ops.saveDraft(ctx, docId, { kind: 'thread', type: 'comment', capture: /** @type {any} */ (capture), body });
  await ops.submitReview(ctx, docId, { verdict: 'changes_requested', body: '' });
}

after(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
});

describe('lookup from a directory above the workspace root', () => {
  // proj/docs/my-spec.md, no git: the store is proj/docs/.specreview; the agent runs from proj/
  const PROJ = path.join(BASE, 'proj');
  const DOCS = path.join(PROJ, 'docs');
  /** @type {string} */
  let root;

  before(async () => {
    writeSpec(path.join(DOCS, 'my-spec.md'));
    const r = await cli(PROJ, ['open', 'docs/my-spec.md', '--browser', 'none']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(DOCS, '.specreview')), 'the store lives next to the spec');
    assert.ok(!fs.existsSync(path.join(PROJ, '.specreview')));
    root = fs.realpathSync(DOCS);
  });

  test('open from the parent dir prints the path relative to the cwd in the next: hint', async () => {
    const r = await cli(PROJ, ['open', 'docs/my-spec.md', '--browser', 'none']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^next: run `specreview wait docs\/my-spec\.md` in the background$/m, r.stdout);
    const j = await cli(PROJ, ['open', 'docs/my-spec.md', '--json']);
    assert.equal(JSON.parse(j.stdout).ref, 'docs/my-spec.md');
    // from the workspace root itself (and below it) the id is enough
    const fromRoot = await cli(DOCS, ['open', 'my-spec.md']);
    assert.match(fromRoot.stdout, /^next: open the URL \(browser pane\), then run `specreview wait my-spec` in the background$/m, fromRoot.stdout);
  });

  test('relatedWorkspaceRoots matches through the symlinked tmp dir', async () => {
    assert.deepEqual(await relatedWorkspaceRoots(PROJ), [root]);
    assert.deepEqual(await relatedWorkspaceRoots(path.join(DOCS, '.')), [root]);
  });

  test('status <id> and feedback <id> work from the parent dir', async () => {
    const s = await cli(PROJ, ['status', 'my-spec']);
    assert.equal(s.code, 0, s.stderr);
    assert.match(s.stdout, /^my-spec {2}my-spec\.md {2}head v1/m, s.stdout);
    const sj = await cli(PROJ, ['status', 'my-spec', '--json']);
    assert.equal(JSON.parse(sj.stdout).docs[0].doc, 'my-spec');
    const all = await cli(PROJ, ['status']);
    assert.equal(all.code, 0, all.stderr);
    assert.match(all.stdout, /^my-spec /m, 'status without a doc uses the single related workspace');
    const f = await cli(PROJ, ['feedback', 'my-spec', '--peek']);
    assert.equal(f.code, 0, f.stderr);
    assert.match(f.stdout, /^SPECREVIEW FEEDBACK · my-spec/m, f.stdout);
  });

  test('wait <id>, the hinted wait <path>, and wait with no doc deliver from the parent dir', async () => {
    await review(root, 'my-spec', 'retry 3 times', 'Say which errors are retried.');
    const w = await cli(PROJ, ['wait', 'my-spec', '--timeout', '20s']);
    assert.equal(w.code, 0, w.stderr);
    assert.match(w.stdout, /^SPECREVIEW FEEDBACK · my-spec \(my-spec\.md\) · review rv1 on v1/m, w.stdout);
    assert.match(w.stdout, /Eric: Say which errors are retried\./);

    await review(root, 'my-spec', 'time out after 30 s', 'Make it configurable.');
    const byPath = await cli(PROJ, ['wait', 'docs/my-spec.md', '--timeout', '20s']);
    assert.equal(byPath.code, 0, byPath.stderr);
    assert.match(byPath.stdout, /review rv2 on v1/);

    await review(root, 'my-spec', 'Requests time', 'And document the default.');
    const noDoc = await cli(PROJ, ['wait', '--timeout', '20s']);
    assert.equal(noDoc.code, 0, noDoc.stderr);
    assert.match(noDoc.stdout, /^SPECREVIEW FEEDBACK · my-spec · review rv3 on v1/m, noDoc.stdout);
  });

  test('a timed-out wait <path> repeats the path in its retry hint', async () => {
    const t = await cli(PROJ, ['wait', 'docs/my-spec.md', '--timeout', '1s']);
    assert.equal(t.code, 2, t.stderr);
    assert.match(t.stdout, /no review yet for my-spec after 1s\. Run `specreview wait docs\/my-spec\.md` again/, t.stdout);
  });

  test('revise <id> records a version from the parent dir', async () => {
    const file = path.join(DOCS, 'my-spec.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('The service MUST retry 3 times.', 'The service MUST retry 3 times on 5xx and timeouts.'));
    const replies = JSON.stringify({
      summary: 'retry errors',
      threads: {
        t1: { status: 'addressed', reply: 'Listed the retried errors.' },
        t2: { status: 'declined', reply: 'Out of scope for v1.' },
        t3: { status: 'declined', reply: 'Out of scope for v1.' },
      },
    });
    const r = await cli(PROJ, ['revise', 'my-spec', '--replies', '-'], { input: replies });
    assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^specreview: recorded v2 for my-spec /m, r.stdout);
    const log = await cli(PROJ, ['log', 'my-spec']);
    assert.match(log.stdout, /^v2 /m);
  });
});

describe('several related workspaces', () => {
  // multi/a/spec.md and multi/b/spec.md: two stores, both tracking the id "spec"
  const MULTI = path.join(BASE, 'multi');

  before(async () => {
    writeSpec(path.join(MULTI, 'a', 'spec.md'));
    writeSpec(path.join(MULTI, 'b', 'spec.md'));
    writeSpec(path.join(MULTI, 'b', 'only-b.md'));
    for (const f of ['a/spec.md', 'b/spec.md', 'b/only-b.md']) {
      const r = await cli(MULTI, ['open', f, '--browser', 'none']);
      assert.equal(r.code, 0, r.stderr);
    }
  });

  test('an id tracked in both is a UsageError naming both workspaces', async () => {
    for (const argv of [['status', 'spec'], ['wait', 'spec', '--timeout', '1s'], ['feedback', 'spec'], ['revise', 'spec', '-m', 'x']]) {
      const r = await cli(MULTI, argv);
      assert.equal(r.code, 1, `${argv.join(' ')}: ${r.stderr}`); // UsageError
      assert.match(r.stderr, /doc "spec" is tracked in several workspaces/);
      assert.ok(r.stderr.includes(fs.realpathSync(path.join(MULTI, 'a'))) && r.stderr.includes(fs.realpathSync(path.join(MULTI, 'b'))), r.stderr);
    }
  });

  test('an id tracked in only one of them is found; a path always resolves', async () => {
    const r = await cli(MULTI, ['status', 'only-b']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^only-b /m);
    const byPath = await cli(MULTI, ['status', 'a/spec.md']);
    assert.equal(byPath.code, 0, byPath.stderr);
    assert.match(byPath.stdout, /^spec {2}spec\.md /m);
  });

  test('an unknown id lists what the related workspaces track', async () => {
    const r = await cli(MULTI, ['status', 'nope']);
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /doc not found: nope \(tracked: only-b, spec\)/);
  });

  test('without a doc, several related workspaces are a UsageError naming them', async () => {
    const r = await cli(MULTI, ['wait', '--timeout', '1s']);
    assert.equal(r.code, 1, r.stderr); // UsageError
    assert.match(r.stderr, /several below it/);
    assert.ok(r.stderr.includes(fs.realpathSync(path.join(MULTI, 'a'))), r.stderr);
  });

  test('open hints the path for each doc (the id would be ambiguous from here)', async () => {
    const r = await cli(MULTI, ['open', 'a/spec.md', '--browser', 'none']);
    assert.match(r.stdout, /^next: run `specreview wait a\/spec\.md` in the background$/m, r.stdout);
  });
});

describe('unrelated registered workspaces', () => {
  // proj-other/docs/.specreview tracks "other-spec"; sib/ and proj-other's prefix-sharing sibling must not see it
  const OTHER = path.join(BASE, 'proj-other');
  const SIB = path.join(BASE, 'sib');
  const PREFIX = path.join(BASE, 'proj-oth'); // a sibling whose name is a prefix of proj-other

  before(async () => {
    writeSpec(path.join(OTHER, 'docs', 'other-spec.md'));
    const r = await cli(OTHER, ['open', 'docs/other-spec.md', '--browser', 'none']);
    assert.equal(r.code, 0, r.stderr);
    fs.mkdirSync(SIB, { recursive: true });
    fs.mkdirSync(PREFIX, { recursive: true });
  });

  test('ids of sibling workspaces are never matched', async () => {
    for (const cwd of [SIB, PREFIX]) {
      assert.deepEqual(await relatedWorkspaceRoots(cwd), []);
      for (const argv of [['status', 'other-spec'], ['wait', 'other-spec', '--timeout', '1s'], ['feedback', 'other-spec'], ['revise', 'other-spec', '-m', 'x']]) {
        const r = await cli(cwd, argv);
        assert.equal(r.code, 4, `${argv.join(' ')} from ${cwd}: ${r.stderr}`);
        assert.match(r.stderr, /no SpecReview workspace found/);
      }
      const w = await cli(cwd, ['wait', '--timeout', '1s']);
      assert.equal(w.code, 4, w.stderr);
      const s = await cli(cwd, ['status']);
      assert.equal(s.code, 0, s.stderr);
      assert.match(s.stdout, /^no tracked docs here/);
    }
  });

  test('from inside another workspace, a sibling workspace id is not found either', async () => {
    const r = await cli(path.join(BASE, 'proj', 'docs'), ['status', 'other-spec']);
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /doc not found: other-spec \(tracked: my-spec\)/);
  });

  test('open from an unrelated dir hints the relative path, and that path works from there', async () => {
    const r = await cli(SIB, ['open', '../proj-other/docs/other-spec.md', '--browser', 'none']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^next: run `specreview wait \.\.\/proj-other\/docs\/other-spec\.md` in the background$/m, r.stdout);
    const s = await cli(SIB, ['status', '../proj-other/docs/other-spec.md']);
    assert.equal(s.code, 0, s.stderr);
    assert.match(s.stdout, /^other-spec /m);
  });
});

describe('open hint with an explicit --workspace above a nearer store', () => {
  test('the hint names the id with --workspace when neither the cwd nor the file finds the doc workspace', async () => {
    const nest = path.join(BASE, 'nest');
    const away = path.join(BASE, 'away');
    fs.mkdirSync(away, { recursive: true });
    writeSpec(path.join(nest, 'inner', 'inner-doc.md'));
    writeSpec(path.join(nest, 'inner', 'outer-doc.md'));
    const inner = await cli(path.join(nest, 'inner'), ['open', 'inner-doc.md', '--browser', 'none']); // store at nest/inner
    assert.equal(inner.code, 0, inner.stderr);
    const r = await cli(away, ['open', '../nest/inner/outer-doc.md', '--workspace', '../nest', '--browser', 'none']); // store at nest
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^next: run `specreview wait outer-doc --workspace \.\.\/nest` in the background$/m, r.stdout);
    const s = await cli(away, ['status', 'outer-doc', '--workspace', '../nest']);
    assert.equal(s.code, 0, s.stderr);
    assert.match(s.stdout, /^outer-doc /m);
  });
});

describe('open hint quoting', () => {
  test('a path with spaces is shell-quoted', async () => {
    const dir = path.join(BASE, 'quoted');
    writeSpec(path.join(dir, 'my docs', "it's.md"));
    const r = await cli(dir, ['open', "my docs/it's.md", '--browser', 'none']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^next: run `specreview wait 'my docs\/it'\\''s\.md'` in the background$/m, r.stdout);
    const s = await cli(dir, ['status', "my docs/it's.md"]);
    assert.equal(s.code, 0, s.stderr);
  });
});
