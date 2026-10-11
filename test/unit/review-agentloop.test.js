// @ts-check
// Agent-loop presentation regressions: packets and status name the spec so that it resolves from the agent's cwd
// (a non-git project whose `.specreview/` sits next to the spec in a subfolder), and section paths drop a top
// heading that merely names the doc even when it is not exactly the title.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as ops from '../../src/core/review/index.js';
import { createContext } from '../../src/core/review/context.js';
import { renderSource } from '../../src/core/render/index.js';
import { sectionAt } from '../../src/core/render/query.js';
import { sectionPath } from '../../src/core/review/labels.js';
import { makeWorkspace, textCapture } from '../helpers/engine.js';

/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
beforeEach(async () => {
  ws = await makeWorkspace({ files: [] });
});
afterEach(async () => {
  await ws.cleanup();
});

describe('paths shown to the agent resolve from its cwd (nongit-subfolder-paths-hook)', () => {
  test('a workspace in notes/specs/ seen from the project dir: packet and status name notes/specs/plan.md', async () => {
    const sub = path.join(ws.root, 'notes', 'specs');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'plan.md'), '# Plan\n\n## Steps\n\nShip the first milestone.\n');
    const ctx = await createContext({ root: sub, cwd: ws.root, agent: 'claude', reviewer: 'Eric', createStore: true });
    const { doc } = await ops.openDoc(ctx, { path: path.join(sub, 'plan.md') });
    assert.equal(doc.path, 'plan.md');
    const v1 = await ctx.render(doc, 1);
    await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'first milestone'), body: 'Which one?' });
    await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', body: '' });
    /** @type {string} */
    let text = '';
    const packet = /** @type {any} */ (await ops.feedback(ctx, doc.id, { write: (t) => { text = t; } }));
    assert.equal(packet.path, 'plan.md');
    assert.equal(packet.pathFromCwd, 'notes/specs/plan.md');
    assert.equal(fs.realpathSync(packet.file), fs.realpathSync(path.join(sub, 'plan.md')));
    assert.equal(fs.realpathSync(packet.root), fs.realpathSync(sub));
    assert.match(text.split('\n')[0], /^SPECREVIEW FEEDBACK · plan \(plan\.md\)/);
    assert.equal(text.split('\n')[1], 'File: notes/specs/plan.md (from your working directory)');

    const st = await ops.status(ctx);
    assert.equal(/** @type {any} */ (st.docs[0]).pathFromCwd, 'notes/specs/plan.md');
    assert.match(ops.formatStatus(st), /^plan {2}plan\.md .*\n {2}file: notes\/specs\/plan\.md \(from your working directory\)$/m);

    // from the workspace root itself nothing changes
    const atRoot = await createContext({ root: sub, cwd: sub, agent: 'claude' });
    /** @type {string} */
    let t2 = '';
    const p2 = /** @type {any} */ (await ops.feedback(atRoot, doc.id, { peek: true, write: (t) => { t2 = t; } }));
    assert.equal(p2.pathFromCwd, 'plan.md');
    assert.doesNotMatch(t2, /^File: /m);
    assert.doesNotMatch(ops.formatStatus(await ops.status(atRoot)), /file: /);
  });
});

describe('section paths drop a heading that names the doc (section-path-h1-noise)', () => {
  test('front-matter title "X Spec" with "# X": no "X >" prefix', async () => {
    const md = '---\ntitle: Rate Limiter Service Spec\n---\n\n# Rate Limiter Service\n\n## Goals\n\nLimit requests.\n';
    const r = await renderSource({ format: 'markdown', source: md, docPath: 'rl.md' });
    const sec = sectionAt(r, md.indexOf('Limit requests'));
    assert.deepEqual(sec, ['Rate Limiter Service', 'Goals']);
    assert.equal(sectionPath(sec, r.title), 'Goals');
  });

  test('HTML <title>Ops Dashboard Spec</title> with <h1>Ops Dashboard</h1>', async () => {
    const html = '<!doctype html><html><head><title>Ops Dashboard Spec</title></head><body><h1>Ops Dashboard</h1><h2>Panels</h2><p>Four panels.</p></body></html>';
    const r = await renderSource({ format: 'html', source: html, docPath: 'd.html' });
    const sec = sectionAt(r, html.indexOf('Four panels'));
    assert.equal(sectionPath(sec, r.title), 'Panels');
  });

  test('an unrelated top heading is kept; a single heading is never dropped', () => {
    assert.equal(sectionPath(['Payments', 'Refunds'], 'Spec v2'), 'Payments > Refunds');
    assert.equal(sectionPath(['Goals'], 'Goals'), 'Goals');
    assert.equal(sectionPath(['API Gateway', 'Limits'], 'API Gateway Design'), 'Limits');
  });
});
