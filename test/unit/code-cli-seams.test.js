// @ts-check
// The CLI / MCP seams of code reviews (design 2.11, 4.2, WP0b): `specreview review` parses its final spec into the
// ReviewInput that openCodeReview takes and (until WP3) exits 1 with "code review is not available in this build";
// MCP specreview_review maps onto the same input; `revise` replies and `reply --at` accept the repo-file forms
// (canonicalised), while a spec doc refuses them before anything is written.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageError } from '../../src/core/store/errors.js';
import { parseCommandArgs, normalizeAt } from '../../src/cli/args.js';
import { COMMANDS } from '../../src/cli/commands/index.js';
import * as review from '../../src/cli/commands/review.js';
import { ReviseInputSchema, validate } from '../../src/cli/schemas.js';
import { TOOLS } from '../../src/mcp/tools.js';
import * as ops from '../../src/core/review/ops.js';
import { CODE_NOT_AVAILABLE } from '../../src/core/code/index.js';
import { engineCtx, makeWorkspace } from '../helpers/engine.js';

/**
 * @param {string[]} argv
 * @param {Record<string, string>} [env]
 */
async function parseReview(argv, env = {}) {
  return review.parse(parseCommandArgs('review', argv, review.spec.options), /** @type {any} */ ({ env }));
}

describe('specreview review (stub with the final spec)', () => {
  test('registered in the loop group; --help names every flag of the spec', async () => {
    assert.equal(COMMANDS.review.group, 'loop');
    const mod = await COMMANDS.review.load();
    assert.equal(mod.spec.name, 'review');
    for (const f of ['--uncommitted', '--staged', '--base', '--committed', '--commit', '--path', '--context', '--max-files', '--title', '--browser', '--workspace', '--json']) {
      assert.ok(mod.spec.usage.includes(f), f);
    }
  });

  test('flags -> ReviewInput', async () => {
    const cases = /** @type {Array<[string[], object]>} */ ([
      [[], {}],
      [['--uncommitted'], { mode: 'uncommitted' }],
      [['--staged'], { mode: 'staged' }],
      [['--base', 'main'], { mode: 'since-base', base: 'main' }],
      [['--base', 'main', '--committed'], { mode: 'branch', base: 'main' }],
      [['main..HEAD'], { mode: 'range', range: 'main..HEAD' }],
      [['a...b'], { mode: 'range', range: 'a...b' }],
      [['--commit', 'abc1234'], { mode: 'commit', commit: 'abc1234' }],
      [['--path', 'src', '--path', 'test', '--context', '5', '--max-files', '10'], { paths: ['src', 'test'], context: 5, maxFiles: 10 }],
    ]);
    for (const [argv, input] of cases) assert.deepEqual((await parseReview(argv)).input, input, argv.join(' '));
    const p = await parseReview(['--title', 'T', '--browser', 'none']);
    assert.equal(p.title, 'T');
    assert.equal(p.browser, 'none');
    assert.equal((await parseReview([], { SPECREVIEW_BROWSER: 'pane' })).browser, 'pane');
  });

  test('conflicting or malformed flags are usage errors', async () => {
    for (const argv of [['--staged', '--base', 'x'], ['a..b', '--uncommitted'], ['--committed'], ['x'], ['a..b', 'c..d'], ['--context', 'x'], ['--max-files', '0'], ['--path', ''], ['--browser', 'tab']]) {
      await assert.rejects(parseReview(argv), UsageError, argv.join(' '));
    }
  });

  test('execute exits 1 until the code engine lands', async () => {
    const input = await parseReview([]);
    await assert.rejects(review.execute(/** @type {any} */ ({}), input), (err) => err instanceof UsageError && err.message === CODE_NOT_AVAILABLE);
    await assert.rejects(ops.openCodeReview(/** @type {any} */ ({}), { input: input.input }), (err) => err instanceof UsageError && err.message === CODE_NOT_AVAILABLE);
  });
});

describe('MCP specreview_review', () => {
  const tool = /** @type {any} */ (TOOLS.find((t) => t.name === 'specreview_review'));

  test('runs the review command with the same ReviewInput', async () => {
    assert.ok(tool);
    assert.equal(tool.command, 'review');
    assert.deepEqual(Object.keys(tool.schema.shape).sort(), ['base', 'commit', 'mode', 'paths', 'range', 'title', 'workspace']);
    const rt = /** @type {any} */ ({ env: {}, cwd: '/' });
    assert.deepEqual(await tool.toInput(tool.schema.parse({}), rt), { input: {}, title: undefined });
    assert.deepEqual((await tool.toInput(tool.schema.parse({ base: 'main' }), rt)).input, { mode: 'since-base', base: 'main' });
    assert.deepEqual((await tool.toInput(tool.schema.parse({ mode: 'branch', base: 'main', paths: ['src'] }), rt)).input, { mode: 'branch', base: 'main', paths: ['src'] });
    assert.deepEqual((await tool.toInput(tool.schema.parse({ mode: 'range', range: 'a..b' }), rt)).input, { mode: 'range', range: 'a..b' });
    await assert.rejects(tool.toInput(tool.schema.parse({ mode: 'staged', base: 'main' }), rt), UsageError);
    await assert.rejects(tool.toInput(tool.schema.parse({ mode: 'commit' }), rt), UsageError);
    assert.throws(() => tool.schema.parse({ mode: 'pr' }), 'PR mode is WP3b');
  });
});

describe('the `at` forms of code reviews in the CLI', () => {
  test('revise input accepts repo-file forms in threads.*.at and other[].at', () => {
    const ok = validate(
      {
        summary: 's',
        threads: { t1: { status: 'addressed', reply: 'done', at: 'src/a.js:L12-14,L20,"a,b.js":L3' } },
        other: [{ at: 'src/a.js#h3', why: 'w' }, { at: 'del:src/a.js#h1', why: 'w' }, { at: 'src/b.js:L3-4', why: 'w' }, { at: 'del:h6', why: 'spec form' }],
      },
      ReviseInputSchema,
      'revise input',
    );
    assert.equal(ok.threads.t1.at, 'src/a.js:L12-14,L20,"a,b.js":L3');
    for (const bad of [{ threads: { t1: { status: 'addressed', reply: 'r', at: 'src/a.js' } } }, { other: [{ at: 'del:src/a.js:L3', why: 'w' }] }]) {
      assert.throws(() => validate({ summary: 's', threads: {}, ...bad }, ReviseInputSchema, 'revise input'), UsageError);
    }
  });

  test('reply --at canonicalises code forms and keeps the spec forms', () => {
    assert.equal(normalizeAt('L12-L14, L20'), 'L12-14,L20');
    assert.equal(normalizeAt('src/a.js:L12-L14, L20'), 'src/a.js:L12-14,L20');
    assert.equal(normalizeAt('"a,b.js":l3'), '"a,b.js":L3');
    assert.throws(() => normalizeAt('src/a.js'), UsageError);
  });
});

describe('a spec doc refuses the code forms', () => {
  /** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
  let ws;
  beforeEach(async () => {
    ws = await makeWorkspace({ files: ['kitchen-sink.md'] });
  });
  afterEach(async () => {
    await ws.cleanup();
  });

  test('revise with a repo-file `at` is a usage error before anything is recorded; reply --at too', async () => {
    const ctx = await engineCtx(ws.root);
    const opened = await ops.openDoc(ctx, { path: 'docs/kitchen-sink.md' });
    const id = opened.doc.id;
    await ctx.store.saveThread(id, /** @type {any} */ ({
      schema: 1, id: 't1', doc: id, type: 'comment', severity: 'normal', status: 'open', createdIn: 1, createdBy: { kind: 'human', name: 'Eric' }, review: null,
      anchors: {}, override: null, suggestion: null, comments: [], changes: [], attachments: [], decision: null, resolvedIn: null, updatedAt: new Date().toISOString(),
    }));
    ws.write('docs/kitchen-sink.md', `${ws.read('docs/kitchen-sink.md')}\nOne more line.\n`);
    await assert.rejects(
      ops.revise(ctx, id, { summary: 's', threads: { t1: { status: 'addressed', reply: 'r', at: 'docs/kitchen-sink.md:L3' } } }),
      (err) => err instanceof UsageError && /file paths are for code reviews/.test(err.message),
    );
    await assert.rejects(ops.revise(ctx, id, { summary: 's', threads: {}, other: [{ at: 'docs/kitchen-sink.md#h1', why: 'w' }] }), UsageError);
    assert.equal((await ctx.store.requireDoc(id)).head, 1, 'nothing recorded');
    await assert.rejects(ops.reply(ctx, id, 't1', { body: 'b', at: 'docs/kitchen-sink.md:L3' }), (err) => err instanceof UsageError && /file paths are for code reviews/.test(err.message));
  });
});
