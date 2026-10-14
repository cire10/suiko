// @ts-check
// Shared Playwright fixtures and helpers for the UI e2e tests:
//   - `mock`: a fresh mock daemon per test (scenario chosen with test.use({ scenario })), closed afterwards;
//   - `ui`: helpers to open a doc and wait for the guest handshake, reach the doc iframe, select text in it, click
//     elements inside it, and read the guest's debug state.

import { test as base, expect } from '@playwright/test';
import { TESTID } from '../../src/shared/protocol.js';
import { startMockServer } from './mock-server.mjs';

/** @typedef {Awaited<ReturnType<typeof startMockServer>>} Mock */
/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Frame} Frame */

export class Ui {
  /** @param {Page} page @param {Mock} mock */
  constructor(page, mock) {
    this.page = page;
    this.mock = mock;
    /** @type {string[]} */
    this.errors = [];
    page.on('pageerror', (e) => this.errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') this.errors.push(`console: ${m.text()}`);
    });
  }

  /** Opens a doc and waits until the guest is connected. @param {string} id */
  async open(id) {
    await this.page.goto(this.mock.url(id));
    await this.ready();
  }

  async ready() {
    // the doc frame of the version shown (Changes side by side adds the older version's, .compare-base)
    await expect(this.page.locator('.frame-wrap:not(.compare-base)[data-guest="ready"]')).toBeAttached({ timeout: 15000 });
  }

  /** The doc iframe's Frame (the version shown; not the older version of Changes side by side). */
  async frame() {
    await this.ready();
    const handle = await this.page.getByTestId(TESTID.docFrame).elementHandle();
    const f = await handle?.contentFrame();
    if (!f || !f.url().startsWith(this.mock.contentOrigin)) throw new Error('doc frame not found');
    return f;
  }

  /** The older version's iframe of Changes side by side, once its guest is connected. */
  async baseFrame() {
    await expect(this.page.locator('.frame-wrap.compare-base[data-guest="ready"]')).toBeAttached({ timeout: 15000 });
    const handle = await this.page.getByTestId(TESTID.compareBaseFrame).elementHandle();
    const f = await handle?.contentFrame();
    if (!f) throw new Error('base frame not found');
    return f;
  }

  /**
   * The guest's debug snapshot (its overlay is a closed shadow root). Retries while the doc frame is navigating
   * (version switch, live reload) and the guest is not loaded yet.
   */
  async inspect() {
    for (let attempt = 0; ; attempt++) {
      try {
        const f = await this.frame();
        return await f.evaluate(() => /** @type {any} */ (window).__suikoGuest.inspect());
      } catch (err) {
        const transient = /Execution context was destroyed|detached|__suikoGuest|reading 'inspect'/.test(String(err));
        if (!transient || attempt >= 20) throw err;
        await this.page.waitForTimeout(150);
      }
    }
  }

  /**
   * Selects the first occurrence of `text` in the doc body with the Selection API and waits for the guest to
   * report it to the UI (the selection button becomes enabled).
   * @param {string} text
   */
  async selectText(text) {
    const f = await this.frame();
    await f.evaluate((t) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = /** @type {Text} */ (walker.currentNode);
        const i = n.data.indexOf(t);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + t.length);
        const sel = /** @type {Selection} */ (getSelection());
        sel.removeAllRanges();
        sel.addRange(r);
        /** @type {HTMLElement} */ (n.parentElement).scrollIntoView({ block: 'center' });
        return;
      }
      throw new Error(`text not found: ${t}`);
    }, text);
    await expect(this.page.locator('[data-selection-comment]')).toBeEnabled();
  }

  /**
   * Page coordinates of the centre of an element (or of a text inside it) in the doc iframe.
   * @param {string} selector
   * @param {string} [text]
   */
  async pointIn(selector, text) {
    const f = await this.frame();
    const r = await f.evaluate(({ selector: sel, text: t }) => {
      /** @param {Element} el */
      const textRange = (el) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const n = /** @type {Text} */ (walker.currentNode);
          const i = n.data.indexOf(/** @type {string} */ (t));
          if (i < 0) continue;
          const range = document.createRange();
          range.setStart(n, i);
          range.setEnd(n, i + /** @type {string} */ (t).length);
          return range;
        }
        return null;
      };
      // The first matching element (that contains the text, when one is given).
      for (const el of document.querySelectorAll(sel)) {
        const range = t ? textRange(el) : null;
        if (t && !range) continue;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const rect = (range || el).getBoundingClientRect();
        return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      }
      throw new Error(`no element ${sel}${t ? ` containing "${t}"` : ''}`);
    }, { selector, text });
    const box = await this.page.locator('[data-testid="doc-frame"]').boundingBox();
    if (!box) throw new Error('doc frame has no box');
    return { x: box.x + r.x, y: box.y + r.y, w: r.w, h: r.h, cx: box.x + r.x + r.w / 2, cy: box.y + r.y + r.h / 2 };
  }

  /** Waits two animation frames inside the doc. */
  async settle() {
    const f = await this.frame();
    await f.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(ok, 50)))));
  }

  /** A thread card by thread id. @param {string} id */
  card(id) {
    return this.page.locator(`[data-testid="thread-card"][data-thread-id="${id}"]`);
  }
}

export const test = base.extend(/** @type {any} */ ({
  scenario: ['round2', { option: true }],
  mock: async (/** @type {any} */ { scenario }, /** @type {any} */ use) => {
    const mock = await startMockServer({ scenario });
    await use(mock);
    await mock.close();
  },
  ui: async (/** @type {any} */ { page, mock }, /** @type {any} */ use) => {
    await use(new Ui(page, mock));
  },
}));

export { expect };
