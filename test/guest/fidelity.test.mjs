// @ts-check
// Browser tests for how faithfully a doc runs inside the reviewer's frame (render fidelity): IntersectionObserver with
// rootMargin (07-page.js), the outline of headings the page hides (99-main.js), and pages the doc frames that refuse
// to be framed, plus Content-Security-Policy violations, in the page-error report (90-errors.js).
// Driven through the two-origin harness in server.mjs (the doc is a cross-origin frame, as in Suiko) with system
// Chrome. Run: node --test "test/guest/**/*.test.mjs"

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startHarness } from './server.mjs';
import { openDoc, waitMsg, msgsOf, settle } from './helpers.mjs';

const home = mkdtempSync(join(tmpdir(), 'sr-guest-home-'));
process.env.SPECREVIEW_HOME = home;

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let harness;
/** @type {import('playwright-core').Browser} */
let browser;

before(async () => {
  harness = await startHarness();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
  await browser?.close();
  await harness?.close();
  rmSync(home, { recursive: true, force: true });
});

/**
 * What an IntersectionObserver whose root is a line across the middle of the viewport says about the title at the
 * top (a scrollspy's setup): the title is not on that line.
 * @param {import('playwright-core').Frame} frame
 */
const spy = (frame) => frame.evaluate(() => new Promise((resolve) => {
  const io = new IntersectionObserver((entries) => {
    io.disconnect();
    const e = entries[0];
    resolve({ isIntersecting: e.isIntersecting, rootBounds: e.rootBounds ? Math.round(e.rootBounds.height) : null,
      root: io.root === document ? 'document' : io.root === null ? null : 'other', instance: io instanceof IntersectionObserver });
  }, { rootMargin: '-50% 0px -50% 0px' });
  io.observe(/** @type {Element} */ (document.getElementById('title')));
}));

describe('IntersectionObserver in the frame', () => {
  test('an observer without a root measures against the doc\'s own viewport: rootMargin works', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      assert.deepEqual(await spy(d.frame), { isIntersecting: false, rootBounds: 0, root: 'document', instance: true });
      // an explicit root and subclasses keep working
      const more = await d.frame.evaluate(() => new Promise((resolve) => {
        class Spy extends IntersectionObserver {}
        const body = document.body;
        const io = new Spy(() => {}, { root: body, threshold: [0, 1] });
        resolve({ sub: io instanceof Spy && io instanceof IntersectionObserver, root: io.root === body, thresholds: io.thresholds });
      }));
      assert.deepEqual(more, { sub: true, root: true, thresholds: [0, 1] });
      const noNew = await d.frame.evaluate(() => {
        try {
          /** @type {any} */ (IntersectionObserver)(() => {});
          return 'no error';
        } catch (err) {
          return /** @type {Error} */ (err).name;
        }
      });
      assert.equal(noNew, 'TypeError', 'calling it without new still throws');
    } finally {
      await d.close();
    }
  });

  test('a doc opened on its own (not framed) keeps the native observer', async () => {
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    try {
      const page = await context.newPage();
      await page.goto(harness.docUrl('prose'));
      await page.waitForFunction(() => !!(/** @type {any} */ (window).__suikoGuest));
      const r = await spy(page.mainFrame());
      assert.equal(r.root, null);
      assert.equal(r.isIntersecting, false);
    } finally {
      await context.close();
    }
  });
});

describe('a frame that gets narrower (side by side, a wider panel)', () => {
  test('a chart sized to its container follows it down, and the canvas keeps its own style', async () => {
    const d = await openDoc(browser, harness, 'chart');
    try {
      const state = () => d.frame.evaluate(() => ({
        vw: document.documentElement.clientWidth,
        sw: document.documentElement.scrollWidth,
        canvas: Math.round(/** @type {Element} */ (document.getElementById('chart')).getBoundingClientRect().width),
        maxWidth: /** @type {HTMLElement} */ (document.getElementById('chart')).style.maxWidth,
      }));
      await d.frame.waitForFunction(() => /** @type {any} */ (window).__resizes > 0);
      const wide = await state();
      assert.ok(wide.canvas > 800, `drawn at the frame's width (${wide.canvas})`);
      // the reviewer UI makes the frame narrower without reloading it
      await d.page.evaluate(() => { /** @type {HTMLElement} */ (document.getElementById('doc')).style.width = '520px'; });
      await d.frame.waitForFunction(() => {
        const c = /** @type {Element} */ (document.getElementById('chart')).getBoundingClientRect();
        return c.right <= document.documentElement.clientWidth && document.documentElement.scrollWidth <= document.documentElement.clientWidth;
      }, null, { timeout: 3000 });
      await settle(d.frame, 500);
      const narrow = await state();
      assert.ok(narrow.canvas < 520 && narrow.sw === narrow.vw, `redrawn inside the narrower frame (${JSON.stringify(narrow)})`);
      assert.equal(narrow.maxWidth, '', 'the canvas style is the page\'s again');
      // wider again: the chart grows with its container as usual
      await d.page.evaluate(() => { /** @type {HTMLElement} */ (document.getElementById('doc')).style.width = '900px'; });
      await d.frame.waitForFunction(() => /** @type {Element} */ (document.getElementById('chart')).getBoundingClientRect().width > 800, null, { timeout: 3000 });
    } finally {
      await d.close();
    }
  });
});

describe('the outline', () => {
  test('lists only the headings the page renders (no hidden tab panel, display: none or closed <details>)', async () => {
    const d = await openDoc(browser, harness, 'outline', { init: false });
    try {
      const ready = await waitMsg(d.page, 'ready');
      assert.deepEqual(ready.outline.map((/** @type {any} */ h) => h.text),
        ['Design doc', 'Options', 'Pros of A', 'Open details', 'Rollout']);
    } finally {
      await d.close();
    }
  });
});

describe('page errors', () => {
  test('a framed page that refuses to be framed and a blocked inline script are reported', async () => {
    const d = await openDoc(browser, harness, 'frames');
    try {
      const err = await waitMsg(d.page, 'pageError', 0, (m) => m.count >= 1 && m.resourcesFailed.length >= 1, 8000);
      assert.ok(err.resourcesFailed.some((/** @type {string} */ u) => u.endsWith('/frame/blocked.html')), 'the refused frame');
      assert.ok(!err.resourcesFailed.some((/** @type {string} */ u) => u.endsWith('/frame/ok.html')), 'not the one that loaded');
      assert.match(err.last, /Content Security Policy blocked an inline script or style \(script-src/);
      assert.equal(await d.frame.evaluate(() => /** @type {any} */ (window).__inlineRan ?? false), false);
      await settle(d.frame, 300);
      const last = (await msgsOf(d.page, 'pageError')).pop();
      assert.equal(last.count, 1, 'the violation counts once');
    } finally {
      await d.close();
    }
  });
});
