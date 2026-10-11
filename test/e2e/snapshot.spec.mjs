// @ts-check
// Snapshot docs (an agent message / piped text / a Claude Code plan, recorded from bytes; store/snapshot.js) in the
// reviewer UI against the REAL daemon and engine (test/e2e/real-daemon.mjs): the doc renders, never shows the
// Record banner (its working copy is its head), and after the agent records vN+1 (`recordSnapshot`, what the plan
// gate, `open -` and `revise --source` do) Changes, Source, History and Verify work as for a file doc. Snapshot docs
// get the strict sandbox and content policy (no inline script), and a fetched web page shows its host on Home.

import { test as base, expect } from '@playwright/test';
import { TESTID } from '../../src/shared/protocol.js';
import { Ui } from './fixtures.mjs';
import { startRealDaemon } from './real-daemon.mjs';

/** @typedef {Awaited<ReturnType<typeof startRealDaemon>>} Real */

const test = base.extend(/** @type {any} */ ({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here
  real: async ({}, /** @type {(r: Real) => Promise<void>} */ use) => {
    const real = await startRealDaemon({ files: [], open: [] });
    await use(real);
    await real.close();
  },
  ui: async (/** @type {any} */ { page, real }, /** @type {(u: Ui) => Promise<void>} */ use) => {
    await use(new Ui(page, real));
  },
}));

/** @param {import('@playwright/test').Page} page @param {string} mode */
const modeTab = (page, mode) => page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="${mode}"]`);

/** src/ui/frame.js FRAME_SANDBOX_STRICT (that module imports the UI's import-map names, so it is not loaded here). */
const FRAME_SANDBOX_STRICT = 'allow-scripts allow-same-origin allow-modals allow-popups allow-popups-to-escape-sandbox';

const MESSAGE = ['# Token refresh answer', '', 'Rotate refresh tokens on every use.', '', 'Keep a 30 s grace window for concurrent clients.', '', 'Ship it behind a flag.', ''].join('\n');

test('a snapshot doc renders without the Record banner and shows Changes, Source, History and Verify after v2', async (/** @type {any} */ { page, ui, real }) => {
  /** @type {Real} */
  const r = real;
  const { doc } = await r.ops.openSnapshot(r.ctx, { source: MESSAGE, origin: { type: 'message', key: 'claude-msg:s1:msg_1', session: 's1', messageId: 'msg_1' } });
  expect(doc.kind).toBe('snapshot');
  expect(doc.path).toBe('messages/token-refresh-answer.md');

  await ui.open(doc.id);
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('1');
  await expect(page).toHaveTitle(/Token refresh answer/);
  const frame = await ui.frame();
  await expect(frame.locator('h1')).toHaveText('Token refresh answer');
  await expect(frame.locator('body')).toContainText('Keep a 30 s grace window');
  await expect(page.getByRole('button', { name: 'Record as my revision' })).toHaveCount(0);
  await expect(page.locator('.banner-warn')).toHaveCount(0);

  // The reviewer comments (through the engine, as the UI's own submit is covered elsewhere) and the agent gets it.
  const render = await r.ctx.render(doc, 1);
  const text = render.text.text;
  const quote = 'Keep a 30 s grace window';
  const g0 = text.indexOf(quote);
  const srid = render.srcmap.order.find((/** @type {number} */ s) => {
    const span = render.text.spans[s];
    return span && span[0] <= g0 && span[1] >= g0 + quote.length && render.srcmap.nodes[s].t === 'p';
  });
  await r.ops.saveDraft(r.ctx, doc.id, {
    kind: 'thread', type: 'comment', severity: 'blocking', body: 'Make the window configurable.',
    capture: { kind: 'text', startSrid: srid, endSrid: srid, exact: quote, prefix: text.slice(Math.max(0, g0 - 32), g0), suffix: text.slice(g0 + quote.length, g0 + quote.length + 32) },
  });
  await r.ops.submitReview(r.ctx, doc.id, { verdict: 'changes_requested', body: '' });
  const packet = await r.agentFeedback(doc.id);
  expect(packet.kind).toBe('snapshot');
  expect(packet.file).toBeNull();

  // The agent records its revised message as v2 (no working file involved).
  const res = await r.ops.recordSnapshot(r.ctx, doc.id, {
    source: MESSAGE.replace('Keep a 30 s grace window', 'Keep a configurable grace window (default 30 s)'),
    replies: { t1: { status: 'addressed', reply: 'It is configurable now.' } },
  });
  expect(res.refused).toBe(false);
  expect(res.version).toBe(2);
  const toast = page.getByTestId(TESTID.toast).filter({ hasText: 'v2 ready' });
  await expect(toast).toContainText('from claude');
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
  await expect(page.getByRole('button', { name: 'Record as my revision' })).toHaveCount(0);
  await expect(page.locator('.banner-warn')).toHaveCount(0);

  // Changes
  await toast.getByRole('button', { name: 'Review changes' }).click();
  await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#sr-base')).toHaveValue('1');
  const change = page.getByTestId(TESTID.changeItem);
  await expect(change).toHaveCount(1);
  await expect(change).toContainText('configurable grace window');
  await expect(change.getByRole('button', { name: 't1' })).toBeVisible();

  // Verify (round results): accept t1
  const r1 = page.locator('.round-results .result[data-thread-id="t1"]');
  await expect(r1).toContainText('configurable');
  await r1.getByTestId(TESTID.verifyAccept).click();
  await expect(r1).toContainText('Resolved');
  expect((await r.state(doc.id)).threads.find((/** @type {any} */ t) => t.id === 't1').status).toBe('resolved');

  // Source
  await modeTab(page, 'source').click();
  const view = page.locator('.source-view');
  await expect(view.locator('.diff-hunk')).toHaveCount(1);
  await expect(view.locator('.diff-hunk').first().locator('tr.op-ins')).toContainText('Keep a configurable grace window (default 30 s)');

  // History
  await modeTab(page, 'history').click();
  const rows = page.getByTestId(TESTID.historyRow);
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('data-version', '2');

  // Home lists it by what it is, not by its synthetic path
  await page.goto(r.url());
  await expect(page.getByTestId(TESTID.docList)).toContainText('Token refresh answer');
  await expect(page.getByTestId(TESTID.docList)).toContainText('agent message');
  expect(ui.errors).toEqual([]);
});

test('web page and piped-text snapshots: strict sandbox, no inline script, the Home row names the page host', async (/** @type {any} */ { page, ui, real }) => {
  /** @type {Real} */
  const r = real;
  const { doc: web } = await r.ops.openSnapshot(r.ctx, {
    source: '# Token Service\n\nSee [the RFC](https://example.org/rfc).\n\n![Flow](https://cdn.example.com/flow.png)\n',
    origin: { type: 'url', key: 'url:https://docs.example.com/spec', url: 'https://docs.example.com/spec', finalUrl: 'https://docs.example.com/spec', private: false },
    slug: 'docs.example.com spec',
    render: { network: 'block' },
  });
  expect(web.path).toBe('web/docs-example-com-spec.md');
  await ui.open(web.id);
  await expect(page.getByTestId(TESTID.docFrame)).toHaveAttribute('sandbox', FRAME_SANDBOX_STRICT);
  const frame = await ui.frame();
  await expect(frame.locator('h1')).toHaveText('Token Service');

  // a snapshot's raw HTML cannot run script: the content origin's strict policy allows only /__sr/ scripts
  const { doc: piped } = await r.ops.openSnapshot(r.ctx, {
    source: '# Piped\n\n<script>window.__INLINE_RAN = 1</script>\n\n<img src="x" onerror="window.__ONERROR_RAN = 1">\n\nPlain text.\n',
    origin: { type: 'stdin', key: null },
  });
  await ui.open(piped.id);
  const pf = await ui.frame();
  await expect(pf.locator('body')).toContainText('Plain text.');
  expect(await pf.evaluate(() => [/** @type {any} */ (window).__INLINE_RAN, /** @type {any} */ (window).__ONERROR_RAN])).toEqual([undefined, undefined]);
  expect(await pf.evaluate(() => typeof (/** @type {any} */ (window).__specreviewGuest))).toBe('object');

  await page.goto(r.url());
  await expect(page.locator('.doc-row', { hasText: 'Token Service' }).locator('.doc-path')).toHaveText('web page · docs.example.com');
});
