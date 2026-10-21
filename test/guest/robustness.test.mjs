// @ts-check
// Browser regression tests for the guest under hostile-but-realistic documents: a CSP that forbids inline styles,
// links that would navigate the doc frame away, a modal <dialog>, a script that copies stamped elements, a page
// that throws continuously, and globals named like window properties. Same two-origin harness and system Chrome as
// guest.test.mjs.
// Run: node --test "test/guest/**/*.test.mjs"

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startHarness } from './server.mjs';
import { openDoc, send, mark, waitMsg, msgsOf, inspect, settle, selectText, rectOf } from './helpers.mjs';

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

/** @param {{x: number, y: number, width: number, height: number}} r */
const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** The local name of the topmost element at a viewport point of the doc. @param {import('playwright-core').Frame} frame */
async function hitAt(frame, x, y) {
  return frame.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    return el ? el.localName : null;
  }, [x, y]);
}

describe('document CSP (UIR-2)', () => {
  test("a CSP without 'unsafe-inline' styles neither unstyles the overlay nor lets it block the page", async () => {
    const d = await openDoc(browser, harness, 'csp', {
      initScript: () => {
        /** @type {any} */ (window).__cspViolations = [];
        document.addEventListener('securitypolicyviolation', (e) => {
          /** @type {any} */ (window).__cspViolations.push(e.violatedDirective);
        }, true);
      },
    });
    try {
      // The host is the full-viewport, click-through box it is meant to be (not the UA popover box).
      const host = await d.frame.evaluate(() => {
        const h = /** @type {HTMLElement} */ (document.querySelector('sr-overlay'));
        const cs = getComputedStyle(h);
        const r = h.getBoundingClientRect();
        return { pointerEvents: cs.pointerEvents, position: cs.position, x: r.x, y: r.y, w: r.width, h: r.height,
          vw: document.documentElement.clientWidth, vh: innerHeight };
      });
      assert.equal(host.pointerEvents, 'none');
      assert.equal(host.position, 'fixed');
      assert.equal(host.x, 0);
      assert.equal(host.y, 0);
      assert.ok(Math.abs(host.w - host.vw) <= 1 && Math.abs(host.h - host.vh) <= 1, JSON.stringify(host));
      // Nothing of the overlay sits over the document text.
      const p = await rectOf(d.frame, '[data-srid="5"]', 'select for review');
      assert.equal(await hitAt(d.frame, p.cx, p.cy), 'p');
      assert.notEqual(await hitAt(d.frame, host.vw / 2, host.vh / 2), 'sr-overlay');

      // The selection toolbar is styled and placed above the selection, and its buttons work.
      const from = await mark(d.page);
      await selectText(d.frame, 3, 'rotates refresh tokens');
      const sel = await waitMsg(d.page, 'selection', from, (m) => !!m.capture);
      const ins = await inspect(d.frame);
      assert.ok(ins.toolbar, 'toolbar shown');
      assert.equal(ins.styled, true);
      assert.ok(ins.toolbar.rect.bottom <= sel.rect.y + 1, `toolbar above the selection: ${JSON.stringify(ins.toolbar.rect)} vs ${JSON.stringify(sel.rect)}`);
      assert.ok(Math.abs(ins.toolbar.rect.x - sel.rect.x) < 12, 'toolbar left-aligned to the selection');
      assert.ok(ins.toolbar.rect.height < 60, 'toolbar is one row of buttons');
      const btn = ins.toolbar.buttons.find((/** @type {any} */ b) => b.action === 'comment');
      const from2 = await mark(d.page);
      await d.page.mouse.click(center(btn.rect).x, center(btn.rect).y);
      const act = await waitMsg(d.page, 'action', from2);
      assert.equal(act.action, 'comment');
      assert.equal(act.capture.exact, 'rotates refresh tokens');

      // Pins are drawn in the right margin.
      await send(d.page, 'setTargets', { targets: [{ id: 't1', num: 1, kind: 'text', state: 'open', srid: 5, quote: 'select for review' }] });
      await settle(d.frame, 60);
      const pin = (await inspect(d.frame)).layers.pins[0].rect;
      assert.equal(pin.x, host.vw - 26);
      assert.ok(Math.abs(pin.y - p.y) < 8, `pin next to its target: ${pin.y} vs ${p.y}`);

      const violations = await d.frame.evaluate(() => /** @type {any} */ (window).__cspViolations);
      assert.deepEqual(violations.filter((/** @type {string} */ v) => /style/.test(v)), []);
      assert.deepEqual(await d.frame.evaluate(() => /** @type {any} */ (window).__suikoGuest.errors()), []);
    } finally {
      await d.close();
    }
  });
});

describe('navigation away from the doc (UIR-6)', () => {
  /**
   * Clicks an element of the links fixture (scrolled to the top first) and returns the URLs of the popups that
   * opened: waits for `expected` popups (then a little longer, to catch extra ones).
   * @param {Awaited<ReturnType<typeof openDoc>>} d @param {string} selector @param {number} expected
   */
  async function clickLink(d, selector, expected) {
    /** @type {string[]} */
    const popups = [];
    /** @param {import('playwright-core').Page} p */
    const onPage = async (p) => {
      await p.waitForLoadState('domcontentloaded').catch(() => {});
      popups.push(p.url());
      await p.close().catch(() => {});
    };
    d.context.on('page', onPage);
    try {
      await d.frame.evaluate(() => window.scrollTo(0, 0));
      await settle(d.frame);
      const r = await rectOf(d.frame, selector);
      await d.page.mouse.click(r.x + Math.min(10, r.w / 2), r.cy);
      const until = Date.now() + 5000;
      while (popups.length < expected && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => setTimeout(resolve, expected ? 150 : 400));
      return popups;
    } finally {
      d.context.off('page', onPage);
    }
  }

  /**
   * The frame still shows the reviewed doc (never reloaded) and its guest still answers on the original port.
   * @param {Awaited<ReturnType<typeof openDoc>>} d
   */
  async function assertStillReviewing(d, hash = '') {
    assert.equal(d.frame.url(), harness.docUrl('links') + hash);
    assert.equal(await d.frame.evaluate(() => /** @type {any} */ (window).__suikoGuest.connected), true);
    assert.equal((await msgsOf(d.page, 'hello')).length, 1, 'no second page load');
    await send(d.page, 'setHidden', { hidden: true });
    await settle(d.frame);
    assert.equal((await inspect(d.frame)).hidden, true);
    await send(d.page, 'setHidden', { hidden: false });
    await settle(d.frame);
    assert.equal((await inspect(d.frame)).hidden, false);
  }

  test('links and scripts that would leave the doc open a new tab; the frame keeps the reviewed doc', async () => {
    const d = await openDoc(browser, harness, 'links');
    try {
      const raw = (/** @type {string} */ from) => `${harness.contentOrigin}/raw/prose.html?from=${from}`;
      assert.deepEqual(await clickLink(d, '#rel', 1), [harness.docUrl('prose')]);
      await assertStillReviewing(d);
      assert.deepEqual(await clickLink(d, '#abs', 1), [raw('abs')]);
      assert.deepEqual(await clickLink(d, '#nested-inner', 1), [raw('nested')]);
      assert.deepEqual(await clickLink(d, '#svg-link text', 1), [raw('svg')]);
      // A click handler that sets location.href (user activation) is kept in the frame too.
      assert.deepEqual(await clickLink(d, '#scripted', 1), [raw('script')]);
      // target=_top: blocked by the sandbox (and the parent is the UI) -> new tab instead.
      assert.deepEqual(await clickLink(d, '#top-link', 1), [raw('top')]);
      assert.equal(d.page.url(), harness.parentUrl('links'));
      await assertStillReviewing(d);

      // Left alone: target=_blank (the browser opens it), page-routed links, javascript: links.
      assert.deepEqual(await clickLink(d, '#blank', 1), [raw('blank')]);
      assert.deepEqual(await clickLink(d, '#router', 0), []);
      assert.equal(await d.frame.evaluate(() => /** @type {any} */ (window).__routed), 1);
      assert.deepEqual(await clickLink(d, '#js', 0), []);
      assert.equal(await d.frame.evaluate(() => /** @type {any} */ (window).__jsLink), 1);
      await assertStillReviewing(d);
      // A navigation started by a timer is kept in the frame too.
      await d.frame.evaluate(() => setTimeout(() => { location.href = '/raw/prose.html?from=timer'; }, 0));
      await settle(d.frame, 300);
      await assertStillReviewing(d);
      // Same-document fragment links still scroll.
      assert.deepEqual(await clickLink(d, '#frag', 0), []);
      await assertStillReviewing(d, '#end');
      const nav = (await inspect(d.frame)).navigation;
      assert.equal(nav.navigationApi, true);
      assert.equal(nav.blocked, 7);

      // A Navigation API router that intercepts the navigation keeps it (a same-document navigation).
      assert.deepEqual(await clickLink(d, '#nav-router', 0), []);
      assert.equal(await d.frame.evaluate(() => /** @type {any} */ (window).__navRouted), 1);
      assert.equal(d.frame.url(), `${harness.contentOrigin}/doc/routed/page`);
      assert.equal((await inspect(d.frame)).navigation.blocked, 7);
      assert.equal((await msgsOf(d.page, 'hello')).length, 1, 'no second page load');

      // The UI (the parent) still navigates the frame freely, e.g. to switch versions.
      const from = await mark(d.page);
      await d.page.evaluate((url) => {
        /** @type {HTMLIFrameElement} */ (document.getElementById('doc')).src = url;
      }, harness.docUrl('prose'));
      const hello = await waitMsg(d.page, 'hello', from);
      assert.equal(hello.target, 'ws1/prose/v1');
      assert.deepEqual(await d.frame.evaluate(() => /** @type {any} */ (window).__suikoGuest.errors()), []);
    } finally {
      await d.close();
    }
  });

  test('without the Navigation API, link clicks are kept in the frame by the click guard', async () => {
    const d = await openDoc(browser, harness, 'links', {
      initScript: () => {
        try {
          Object.defineProperty(window, 'navigation', { value: undefined, configurable: true });
        } catch { /* ignore */ }
      },
    });
    try {
      assert.deepEqual(await clickLink(d, '#rel', 1), [harness.docUrl('prose')]);
      assert.equal((await inspect(d.frame)).navigation.navigationApi, false);
      assert.deepEqual(await clickLink(d, '#svg-link text', 1), [`${harness.contentOrigin}/raw/prose.html?from=svg`]);
      assert.deepEqual(await clickLink(d, '#router', 0), []);
      assert.equal(await d.frame.evaluate(() => /** @type {any} */ (window).__routed), 1);
      await assertStillReviewing(d);
      assert.deepEqual(await clickLink(d, '#frag', 0), []);
      await assertStillReviewing(d, '#end');
    } finally {
      await d.close();
    }
  });
});

describe('modal dialogs (UIR-8)', () => {
  test('while the page shows a modal dialog, the toolbar and pins over it take clicks', async () => {
    const d = await openDoc(browser, harness, 'dialog');
    try {
      const open = await rectOf(d.frame, '#open');
      await d.page.mouse.click(open.cx, open.cy);
      await settle(d.frame, 100);
      assert.equal(await d.frame.evaluate(() => document.getElementById('terms')?.matches(':modal')), true);

      // Select text inside the modal, then click the toolbar's Comment button with the real mouse.
      const from = await mark(d.page);
      await selectText(d.frame, 8, 'fourteen days of delivery');
      await waitMsg(d.page, 'selection', from, (m) => !!m.capture);
      let ins = await inspect(d.frame);
      const btn = ins.toolbar.buttons.find((/** @type {any} */ b) => b.action === 'comment');
      const c = center(btn.rect);
      assert.equal(await hitAt(d.frame, c.x, c.y), 'sr-overlay');
      const from2 = await mark(d.page);
      await d.page.mouse.click(c.x, c.y);
      const act = await waitMsg(d.page, 'action', from2);
      assert.equal(act.action, 'comment');
      assert.equal(act.capture.exact, 'fourteen days of delivery');
      assert.equal(act.capture.startSrid, 8);
      assert.equal(await d.frame.evaluate(() => String(getSelection())), 'fourteen days of delivery');
      assert.equal(await d.frame.evaluate(() => /** @type {any} */ (window).__dialogClicks), 0, 'overlay clicks stay out of the page');
      // (The overlay host lives inside the modal while it is open: everything outside it is inert.)
      ins = await inspect(d.frame);
      assert.equal(ins.parent, 'dialog');
      assert.equal(ins.topLayer, true);

      // A pin of a thread inside the modal activates it.
      await send(d.page, 'setTargets', { targets: [{ id: 't1', num: 1, kind: 'text', state: 'open', srid: 9, quote: 'Shipping costs' }] });
      await settle(d.frame, 60);
      const pin = (await inspect(d.frame)).layers.pins[0].rect;
      const from3 = await mark(d.page);
      await d.page.mouse.click(center(pin).x, center(pin).y);
      assert.equal((await waitMsg(d.page, 'activate', from3)).id, 't1');

      // Closing the dialog puts the host back under <html>, still on top and clickable.
      await d.frame.evaluate(() => getSelection()?.removeAllRanges());
      const close = await rectOf(d.frame, '#close');
      await d.page.mouse.click(close.cx, close.cy);
      await settle(d.frame, 100);
      assert.equal(await d.frame.evaluate(() => document.getElementById('terms')?.open), false);
      ins = await inspect(d.frame);
      assert.equal(ins.parent, 'html');
      assert.equal(ins.topLayer, true);
      assert.deepEqual(await d.frame.evaluate(() => [...document.documentElement.children].map((e) => e.localName)),
        ['head', 'body', 'sr-overlay']);
      assert.equal(await d.frame.evaluate(() => document.body.querySelector('sr-overlay')), null);
      await send(d.page, 'setTargets', { targets: [{ id: 't2', num: 2, kind: 'text', state: 'open', srid: 3, quote: 'modal dialog' }] });
      await settle(d.frame, 60);
      const pin2 = (await inspect(d.frame)).layers.pins[0].rect;
      const from4 = await mark(d.page);
      await d.page.mouse.click(center(pin2).x, center(pin2).y);
      assert.equal((await waitMsg(d.page, 'activate', from4)).id, 't2');

      // Opening it again by script moves the host back in.
      await d.frame.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById('terms')).showModal());
      await settle(d.frame, 100);
      assert.equal((await inspect(d.frame)).parent, 'dialog');
      assert.deepEqual(await d.frame.evaluate(() => /** @type {any} */ (window).__suikoGuest.errors()), []);
      assert.deepEqual(d.pageErrors, []);
    } finally {
      await d.close();
    }
  });
});

describe('copies of stamped elements (RF-8)', () => {
  test('targets, scrollTo and the outline use the stamped original, not a script-made copy', async () => {
    const d = await openDoc(browser, harness, 'clones', { init: false });
    try {
      const dup = await d.frame.evaluate(() => {
        const all = [...document.querySelectorAll('[data-srid="8"]')];
        return { count: all.length, firstInToc: !!all[0].closest('#toc') };
      });
      assert.deepEqual(dup, { count: 2, firstInToc: true }, 'the fixture copies the headings into the TOC first');

      const ready = await waitMsg(d.page, 'ready');
      assert.deepEqual(ready.outline.map((/** @type {any} */ h) => [h.srid, h.text]),
        [[2, 'Button component'], [5, 'Usage'], [8, 'Props'], [11, 'Accessibility']]);

      await send(d.page, 'init', { mode: 'review', theme: 'light', targets: [], changes: null, activeId: null, hidden: false });
      const real = await rectOf(d.frame, 'section > h2#props', 'Props');
      const copy = await rectOf(d.frame, '#toc h2#props', 'Props');
      assert.ok(Math.abs(real.y - copy.y) > 100);
      let from = await mark(d.page);
      await send(d.page, 'setTargets', { targets: [
        { id: 't1', num: 1, kind: 'text', state: 'open', srid: 8, quote: 'Props' },
        { id: 't2', num: 2, kind: 'element', state: 'open', srid: 11, quote: null },
      ] });
      let pos = await waitMsg(d.page, 'positions', from, (m) => !!m.targets.t1 && !!m.targets.t2);
      assert.ok(Math.abs(pos.targets.t1.top - real.y) <= 2, `t1 on the real heading: ${pos.targets.t1.top} vs ${real.y}`);
      const a11y = await rectOf(d.frame, 'section > h2#a11y');
      assert.ok(Math.abs(pos.targets.t2.top - a11y.y) <= 2, `t2 on the real heading: ${pos.targets.t2.top} vs ${a11y.y}`);

      from = await mark(d.page);
      await send(d.page, 'scrollTo', { srid: 8, offset: 0 });
      await waitMsg(d.page, 'scroll', from, (m) => m.topSrid === 8 || m.topSrid === 7);
      const top = await d.frame.evaluate(() => document.querySelector('section > h2#props')?.getBoundingClientRect().top);
      assert.ok(top != null && Math.abs(top) <= 2, `scrolled to the real heading (top ${top})`);

      // When the page removes the original, the remaining copy is used.
      await d.frame.evaluate(() => {
        window.scrollTo(0, 0);
        document.querySelector('section > h2#props')?.remove();
      });
      await settle(d.frame);
      from = await mark(d.page);
      await send(d.page, 'setTargets', { targets: [{ id: 't3', num: 3, kind: 'text', state: 'open', srid: 8, quote: 'Props' }] });
      pos = await waitMsg(d.page, 'positions', from, (m) => !!m.targets.t3);
      const copyNow = await rectOf(d.frame, '#toc h2#props', 'Props');
      assert.equal(pos.targets.t3.state, 'ok');
      assert.ok(Math.abs(pos.targets.t3.top - copyNow.y) <= 2, `t3 on the remaining copy: ${pos.targets.t3.top} vs ${copyNow.y}`);
    } finally {
      await d.close();
    }
  });
});

describe('page errors (UIR-10)', () => {
  test('a page that throws more often than the debounce interval is still reported while it throws', async () => {
    const d = await openDoc(browser, harness, 'errors-fast');
    try {
      const first = await waitMsg(d.page, 'pageError', 0, (m) => m.count >= 1, 4000);
      assert.match(first.last, /drawFrame/);
      const atLeast = /** @type {(m: any) => boolean} */ (new Function('m', `return m.count >= ${first.count + 8};`));
      const later = await waitMsg(d.page, 'pageError', 0, atLeast, 4000);
      assert.match(later.last, /drawFrame/);
      const guestCount = await d.frame.evaluate(() => /** @type {any} */ (window).__suikoGuest.inspect().pageErrors.count);
      assert.ok(guestCount - later.count < 15, `the UI lags at most ~1 s behind (${later.count} of ${guestCount})`);
    } finally {
      await d.close();
    }
  });
});

describe('page globals', () => {
  test('a top-level `var parent` (or top, self, name) in the page neither blocks the handshake nor selections', async () => {
    const d = await openDoc(browser, harness, 'globals');
    try {
      assert.equal(await d.frame.evaluate(() => /** @type {any} */ (window).parent === document.documentElement), true, 'the page replaced window.parent');
      const from = await mark(d.page);
      await selectText(d.frame, 3, 'reused the names');
      const msg = await waitMsg(d.page, 'selection', from, (m) => !!m.capture);
      assert.equal(msg.capture.exact, 'reused the names');
      assert.deepEqual(d.pageErrors, []);
    } finally {
      await d.close();
    }
  });
});
