// @ts-check
// Render fidelity against the REAL daemon (test/e2e/real-daemon.mjs): what a full HTML report needs from the content
// origin itself, end to end. A report that frames a page of its own next to it (a status widget): the content
// origin's frame-ancestors allows the content origin ('self') as well as the UI, so the widget loads in the doc's
// frame (it was refused before), and nothing is reported as failed.

import { test as base, expect } from '@playwright/test';
import { TESTID } from '../../src/shared/protocol.js';
import { pinnedPage, Ui } from './fixtures.mjs';
import { startRealDaemon } from './real-daemon.mjs';

/** @typedef {Awaited<ReturnType<typeof startRealDaemon>>} Real */

const test = base.extend(/** @type {any} */ ({
  // the preferences these specs were written for (fixtures.mjs LEGACY_PREFS)
  page: pinnedPage,
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here
  real: async ({}, /** @type {(r: Real) => Promise<void>} */ use) => {
    const real = await startRealDaemon({ files: ['nested/ops-weekly.html', 'nested/status-widget.html'], open: ['nested/ops-weekly.html'] });
    await use(real);
    await real.close();
  },
  ui: async (/** @type {any} */ { page, real }, /** @type {(u: Ui) => Promise<void>} */ use) => {
    await use(new Ui(page, real));
  },
}));

test('a page the report frames next to it loads inside the doc frame, and no resource is reported failed', async (/** @type {any} */ { page, ui, real }) => {
  /** @type {Real} */
  const r = real;
  await page.goto(r.url('ops-weekly'));
  await ui.ready();
  const doc = await ui.frame();
  // the doc's own iframe: same origin as the doc (the content origin), framed by the doc, itself framed by the UI
  await expect.poll(async () => {
    const widget = doc.childFrames()[0];
    if (!widget) return null;
    try {
      return await widget.evaluate(() => ({ text: document.getElementById('status')?.textContent ?? null, ticked: document.body.dataset.ticked ?? null }));
    } catch {
      return null; // still loading, or the browser's "refused to connect" page
    }
  }, { timeout: 10000 }).toEqual({ text: 'All systems normal', ticked: '1' });
  // the guest saw no failed resource and no page error
  await page.waitForTimeout(400);
  const errs = await doc.evaluate(() => /** @type {any} */ (window).__suikoGuest.inspect().pageErrors);
  expect(errs).toEqual({ count: 0, last: '', externalsFailed: [], resourcesFailed: [] });
  await expect(page.getByTestId(TESTID.docFrame)).toBeVisible();
  expect(ui.errors).toEqual([]);
});
