// @ts-check
// Browser tests for the guest script (WP6), driven through the two-origin harness in server.mjs with system Chrome
// (playwright-core, channel 'chrome'). Run: node --test "test/guest/**/*.test.mjs"

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startHarness } from './server.mjs';
import { openDoc, send, mark, waitMsg, msgsOf, inspect, settle, selectText, rectOf, pngSize } from './helpers.mjs';

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

const TEXT_KEYS = ['kind', 'startSrid', 'endSrid', 'exact', 'prefix', 'suffix'];

/** Whether two viewport rects intersect (more than half a pixel). @param {{left:number, top:number, right:number, bottom:number}} a @param {{left:number, top:number, right:number, bottom:number}} b */
function overlaps(a, b) {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

describe('handshake', () => {
  test('hello over window.postMessage, then ready over the MessagePort', async () => {
    const d = await openDoc(browser, harness, 'prose', { init: false });
    try {
      const hello = await waitMsg(d.page, 'hello');
      assert.equal(hello.sr, 1);
      assert.equal(hello.target, 'ws1/prose/v1');
      assert.equal(hello.title, 'Token Service Spec');
      assert.equal(hello.href, harness.docUrl('prose'));
      assert.equal(hello.highlightApi, true);
      const hellos = await msgsOf(d.page, 'hello');
      assert.equal(hellos.length, 1, 'exactly one hello reaches the real parent origin');

      const ready = await waitMsg(d.page, 'ready');
      assert.deepEqual(ready.outline, [
        { srid: 2, level: 1, text: 'Token Service', id: 'title' },
        { srid: 8, level: 2, text: 'Rollout plan', id: 'rollout' },
      ]);
      assert.deepEqual(ready.features, { mermaid: false, math: true, code: false });
      assert.deepEqual(ready.externalsFailed, []);

      // The connect message was consumed by the guest's capture listener: the author's listener never saw it.
      const authorMsgs = await d.frame.evaluate(() => /** @type {any} */ (window).__authorMessages);
      assert.ok(!authorMsgs.some((/** @type {any} */ m) => m && m.type === 'connect'));

      const g = await d.frame.evaluate(() => ({
        enumerable: Object.keys(window).includes('__specreviewGuest'),
        present: '__specreviewGuest' in window,
        connected: /** @type {any} */ (window).__specreviewGuest.connected,
        children: [...document.documentElement.children].map((c) => c.localName),
      }));
      assert.deepEqual(g, { enumerable: false, present: true, connected: true, children: ['head', 'body', 'sr-overlay'] });
      const ins = await inspect(d.frame);
      assert.equal(ins.mounted, true);
      assert.equal(ins.topLayer, true);
      assert.deepEqual(d.pageErrors, []);
    } finally {
      await d.close();
    }
  });

  test('media doc reports mermaid feature', async () => {
    const d = await openDoc(browser, harness, 'media', { init: false });
    try {
      const ready = await waitMsg(d.page, 'ready');
      assert.equal(ready.features.mermaid, true);
    } finally {
      await d.close();
    }
  });
});

describe('selection capture', () => {
  test('selecting text yields the exact frozen text capture shape', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      const from = await mark(d.page);
      await selectText(d.frame, 4, 'rotated on every use');
      const msg = await waitMsg(d.page, 'selection', from, (m) => !!m.capture);
      assert.deepEqual(Object.keys(msg.capture), TEXT_KEYS);
      assert.deepEqual(msg.capture, {
        kind: 'text',
        startSrid: 4,
        endSrid: 4,
        exact: 'rotated on every use',
        prefix: 'oken Service Refresh tokens are ',
        suffix: ' and expire after 30 days. A reu',
      });
      assert.equal(typeof msg.rect.x, 'number');
      assert.ok(msg.rect.width > 0 && msg.rect.height > 0);
      const ins = await inspect(d.frame);
      assert.ok(ins.toolbar, 'mini-toolbar is shown');
      assert.deepEqual(ins.toolbar.buttons.map((/** @type {any} */ b) => b.action), ['comment', 'suggest', 'question', 'agree']);
    } finally {
      await d.close();
    }
  });

  test('selection spanning inline markup uses the nearest srid ancestors of both ends', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      const from = await mark(d.page);
      await selectText(d.frame, 3, 'tokens are rotated on every use and expire');
      const msg = await waitMsg(d.page, 'selection', from, (m) => !!m.capture);
      assert.equal(msg.capture.startSrid, 3);
      assert.equal(msg.capture.endSrid, 3);
      assert.equal(msg.capture.exact, 'tokens are rotated on every use and expire');

      const from2 = await mark(d.page);
      await selectText(d.frame, 3, 'every use and expire after 30');
      const msg2 = await waitMsg(d.page, 'selection', from2, (m) => !!m.capture);
      assert.equal(msg2.capture.startSrid, 4);
      assert.equal(msg2.capture.endSrid, 5);
      assert.equal(msg2.capture.exact, 'every use and expire after 30');
    } finally {
      await d.close();
    }
  });

  test('mouse drag across list items, then the toolbar posts an action', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      const a = await rectOf(d.frame, '[data-srid="10"]', 'Phase one');
      const b = await rectOf(d.frame, '[data-srid="11"]', 'Phase two');
      const from = await mark(d.page);
      await d.page.mouse.move(a.x + 1, a.cy);
      await d.page.mouse.down();
      await d.page.mouse.move(b.x + b.w - 1, b.cy, { steps: 8 });
      await d.page.mouse.up();
      const msg = await waitMsg(d.page, 'selection', from, (m) => !!m.capture);
      assert.equal(msg.capture.kind, 'text');
      assert.equal(msg.capture.startSrid, 10);
      assert.equal(msg.capture.endSrid, 11);
      assert.equal(msg.capture.exact.replace(/\s+/g, ' '), 'Phase one ships to internal users. Phase two');

      const ins = await inspect(d.frame);
      const q = ins.toolbar.buttons.find((/** @type {any} */ x) => x.action === 'question');
      const from2 = await mark(d.page);
      await d.page.mouse.click(q.rect.x + q.rect.width / 2, q.rect.y + q.rect.height / 2);
      const act = await waitMsg(d.page, 'action', from2);
      assert.equal(act.action, 'question');
      assert.deepEqual(act.capture, msg.capture);
      assert.ok(act.rect && act.rect.width > 0);
      // The page selection survives the toolbar click and the toolbar hides until the selection changes.
      const after = await d.frame.evaluate(() => String(getSelection()));
      assert.ok(after.startsWith('Phase one'));
      await settle(d.frame, 200);
      assert.equal((await inspect(d.frame)).toolbar, null);
    } finally {
      await d.close();
    }
  });

  test('triple-click selects a paragraph: trimmed exact, srids of that paragraph only', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      const r = await rectOf(d.frame, '[data-srid="6"]', 'grace');
      const from = await mark(d.page);
      await d.page.mouse.click(r.cx, r.cy, { clickCount: 3 });
      const msg = await waitMsg(d.page, 'selection', from, (m) => !!m.capture && m.capture.exact.startsWith('A reuse'));
      assert.equal(msg.capture.exact, 'A reuse-detection grace window of 30 s applies to concurrent refreshes.');
      assert.equal(msg.capture.startSrid, 6);
      assert.equal(msg.capture.endSrid, 6);
      assert.equal(msg.capture.prefix, 'y use and expire after 30 days. ');
      assert.equal(msg.capture.suffix, ' Rollout plan Phase one ships to');
    } finally {
      await d.close();
    }
  });

  test('selection inside math snaps to the math element (element capture)', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      const from = await mark(d.page);
      await selectText(d.frame, 13, 'mc');
      const msg = await waitMsg(d.page, 'selection', from, (m) => !!m.capture);
      assert.deepEqual(msg.capture, { kind: 'element', srid: 13, tag: 'span', label: 'math "E=mc²"' });
    } finally {
      await d.close();
    }
  });

  test('readonly mode suppresses captures and pick mode', async () => {
    const d = await openDoc(browser, harness, 'prose', { initPayload: { mode: 'readonly' } });
    try {
      await selectText(d.frame, 4, 'rotated on every use');
      await settle(d.frame, 250);
      const sel = await msgsOf(d.page, 'selection');
      assert.ok(sel.every((/** @type {any} */ m) => m.capture === null));
      await send(d.page, 'setTool', { tool: 'pick' });
      await settle(d.frame);
      assert.equal((await inspect(d.frame)).glass, false);
    } finally {
      await d.close();
    }
  });

  /** Line boxes of the current page selection (non-empty client rects) and the viewport width. @param {import('playwright-core').Frame} frame */
  async function selectionBoxes(frame) {
    return frame.evaluate(() => {
      const range = /** @type {Selection} */ (getSelection()).getRangeAt(0);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
      return { rects, vw: document.documentElement.clientWidth };
    });
  }

  test('the mini-toolbar sits above the first line of a multi-line selection, else below the last line', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      const from = await mark(d.page);
      // From "rotated" (second paragraph's first line) to "grace window" (the next paragraph): two line boxes.
      await selectText(d.frame, 1, 'rotated on every use and expire after 30 days.\nA reuse-detection grace window');
      await waitMsg(d.page, 'selection', from, (m) => !!m.capture);
      let { rects, vw } = await selectionBoxes(d.frame);
      const firstTop = Math.min(...rects.map((r) => r.top));
      const lastBottom = Math.max(...rects.map((r) => r.bottom));
      assert.ok(lastBottom - firstTop > 40, 'the selection spans several lines');
      let tb = (await inspect(d.frame)).toolbar;
      assert.ok(tb, 'mini-toolbar is shown');
      assert.ok(tb.rect.bottom <= firstTop + 0.5, `toolbar (bottom ${tb.rect.bottom}) is above the first line (top ${firstTop})`);
      const startX = Math.min(Math.max(rects[0].left, 4), vw - tb.rect.width - 4);
      assert.ok(Math.abs(tb.rect.x - startX) <= 1, `left-aligned to the selection start (${tb.rect.x} vs ${startX})`);
      for (const r of rects) assert.ok(!overlaps(tb.rect, r), 'the toolbar covers no selected text');

      // Scrolled so that the first line is at the top of the viewport: no room above -> below the last line.
      await d.frame.evaluate(() => {
        const p = /** @type {Element} */ (document.querySelector('[data-srid="3"]'));
        window.scrollBy(0, p.getBoundingClientRect().top - 8);
      });
      await settle(d.frame, 50);
      ({ rects, vw } = await selectionBoxes(d.frame));
      tb = (await inspect(d.frame)).toolbar;
      assert.ok(tb, 'mini-toolbar is still shown after scrolling');
      const below = Math.max(...rects.map((r) => r.bottom));
      assert.ok(tb.rect.y >= below - 0.5, `toolbar (top ${tb.rect.y}) is below the last line (bottom ${below})`);
      for (const r of rects) assert.ok(!overlaps(tb.rect, r), 'the toolbar covers no selected text');
    } finally {
      await d.close();
    }
  });

  test('c / s / q / a with a doc selection post an action (not a key) and dismiss the toolbar', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      await d.page.mouse.click(700, 690); // focus the doc body
      const from = await mark(d.page);
      await selectText(d.frame, 4, 'rotated on every use');
      const sel = await waitMsg(d.page, 'selection', from, (m) => !!m.capture);
      assert.ok((await inspect(d.frame)).toolbar, 'mini-toolbar is shown');

      const from2 = await mark(d.page);
      await d.page.keyboard.press('q');
      const act = await waitMsg(d.page, 'action', from2);
      assert.equal(act.action, 'question');
      assert.deepEqual(act.capture, sel.capture);
      assert.ok(act.rect && act.rect.width > 0);
      await settle(d.frame, 200);
      assert.equal((await inspect(d.frame)).toolbar, null, 'the toolbar is dismissed for that capture');
      assert.ok(String(await d.frame.evaluate(() => String(getSelection()))).startsWith('rotated'), 'selection kept');

      // Other keys are still forwarded while the selection exists; the same keys again post actions.
      await d.page.keyboard.press('j');
      await d.page.keyboard.press('c');
      await d.page.keyboard.press('s');
      await d.page.keyboard.press('a');
      await settle(d.frame, 100);
      assert.deepEqual((await msgsOf(d.page, 'key', from2)).map((/** @type {any} */ k) => k.key), ['j']);
      assert.deepEqual((await msgsOf(d.page, 'action', from2)).map((/** @type {any} */ a) => a.action),
        ['question', 'comment', 'suggest', 'agree']);
      assert.equal((await inspect(d.frame)).toolbar, null);

      // Without a selection the key is forwarded to the UI as before.
      const from3 = await mark(d.page);
      await send(d.page, 'clearSelection');
      await waitMsg(d.page, 'selection', from3, (m) => m.capture === null);
      await d.page.keyboard.press('c');
      const key = await waitMsg(d.page, 'key', from3);
      assert.equal(key.key, 'c');
      assert.deepEqual(await msgsOf(d.page, 'action', from3), []);
    } finally {
      await d.close();
    }
  });

  test('clearSelection removes the selection and posts a null capture', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      const from = await mark(d.page);
      await selectText(d.frame, 6, 'grace window');
      await waitMsg(d.page, 'selection', from, (m) => !!m.capture);
      const from2 = await mark(d.page);
      await send(d.page, 'clearSelection');
      await waitMsg(d.page, 'selection', from2, (m) => m.capture === null);
      assert.equal(await d.frame.evaluate(() => String(getSelection())), '');
      assert.equal((await inspect(d.frame)).toolbar, null);
    } finally {
      await d.close();
    }
  });
});

describe('pick mode', () => {
  /** @param {Awaited<ReturnType<typeof openDoc>>} d @param {{cx:number, cy:number}} r @param {string} label */
  async function hover(d, r, label) {
    await d.page.mouse.move(r.cx, r.cy);
    await d.frame.waitForFunction((l) => {
      const ins = /** @type {any} */ (window).__specreviewGuest.inspect();
      return ins.pickBox && ins.pickBox.label === l;
    }, label, { timeout: 3000 });
  }

  test('img: hover label chip, click -> element capture, tool returns to select', async () => {
    const d = await openDoc(browser, harness, 'media');
    try {
      await send(d.page, 'setTool', { tool: 'pick' });
      await settle(d.frame);
      assert.equal((await inspect(d.frame)).glass, true);
      const img = await rectOf(d.frame, 'img');
      await hover(d, img, 'img "System overview"');
      const from = await mark(d.page);
      await d.page.mouse.down();
      await d.page.mouse.up();
      const act = await waitMsg(d.page, 'action', from);
      assert.equal(act.action, 'comment');
      assert.deepEqual(act.capture, { kind: 'element', srid: 5, tag: 'img', label: 'img "System overview"' });
      assert.ok(act.rect.width >= 299);
      await waitMsg(d.page, 'toolChanged', from, (m) => m.tool === 'select');
      const ins = await inspect(d.frame);
      assert.equal(ins.glass, false);
      assert.equal(ins.pickBox, null);
    } finally {
      await d.close();
    }
  });

  test('table cell: rowspan/colspan-aware cell capture via the scope chooser', async () => {
    const d = await openDoc(browser, harness, 'media');
    try {
      await send(d.page, 'setTool', { tool: 'pick' });
      await settle(d.frame);
      const cell = await rectOf(d.frame, '[data-srid="19"]');
      await hover(d, cell, 'td refresh_token / TTL');
      await d.page.mouse.down();
      await d.page.mouse.up();
      await d.frame.waitForFunction(() => !!(/** @type {any} */ (window).__specreviewGuest.inspect().chooser));
      const ins = await inspect(d.frame);
      assert.deepEqual(ins.chooser.buttons.map((/** @type {any} */ b) => b.action), ['cell', 'row', 'column', 'table']);
      const btn = ins.chooser.buttons.find((/** @type {any} */ b) => b.action === 'cell');
      const from = await mark(d.page);
      await d.page.mouse.click(btn.rect.x + btn.rect.width / 2, btn.rect.y + btn.rect.height / 2);
      const act = await waitMsg(d.page, 'action', from);
      assert.deepEqual(act.capture, {
        kind: 'element', srid: 19, tag: 'td', label: 'td refresh_token / TTL',
        cell: { row: 2, col: 1, rowKey: 'refresh_token', colHeader: 'TTL', text: 'sliding window' },
        scope: 'cell',
      });

      // Row scope through the keyboard ('2') on another cell.
      await d.page.mouse.move(5, 5);
      await send(d.page, 'setTool', { tool: 'pick' });
      await settle(d.frame);
      const jwt = await rectOf(d.frame, '[data-srid="23"]');
      await hover(d, jwt, 'td access_token / Notes');
      await d.page.mouse.down();
      await d.page.mouse.up();
      await d.frame.waitForFunction(() => !!(/** @type {any} */ (window).__specreviewGuest.inspect().chooser));
      const from2 = await mark(d.page);
      await d.page.keyboard.press('2');
      const act2 = await waitMsg(d.page, 'action', from2);
      assert.equal(act2.capture.scope, 'row');
      assert.equal(act2.capture.srid, 20);
      assert.equal(act2.capture.tag, 'tr');
      assert.deepEqual(act2.capture.cell, { row: 3, col: 2, rowKey: 'access_token', colHeader: 'Notes', text: 'JWT' });
    } finally {
      await d.close();
    }
  });

  test('inline svg: <text> hover targets its <g>; [ and ] walk the chain', async () => {
    const d = await openDoc(browser, harness, 'media');
    try {
      await d.page.mouse.click(600, 690); // focus the document (empty area)
      await send(d.page, 'setTool', { tool: 'pick' });
      await settle(d.frame);
      const t = await rectOf(d.frame, '[data-srid="27"]');
      await hover(d, t, 'svg g "Auth"');
      await d.page.keyboard.press('[');
      await d.frame.waitForFunction(() => /** @type {any} */ (window).__specreviewGuest.inspect().pickBox.label === 'svg "Auth Gateway"');
      await d.page.keyboard.press(']');
      await d.page.keyboard.press(']');
      await d.frame.waitForFunction(() => /** @type {any} */ (window).__specreviewGuest.inspect().pickBox.label === 'svg text "Auth"');
      await d.page.keyboard.press('[');
      await d.frame.waitForFunction(() => /** @type {any} */ (window).__specreviewGuest.inspect().pickBox.label === 'svg g "Auth"');
      const from = await mark(d.page);
      await d.page.mouse.down();
      await d.page.mouse.up();
      const act = await waitMsg(d.page, 'action', from);
      assert.deepEqual(act.capture, { kind: 'element', srid: 25, tag: 'g', label: 'svg g "Auth"' });
      // '[' / ']' were consumed by pick mode, never forwarded as keys.
      const keys = await msgsOf(d.page, 'key');
      assert.ok(!keys.some((/** @type {any} */ k) => k.key === '[' || k.key === ']'));
    } finally {
      await d.close();
    }
  });

  test('mermaid node: svg {nodeId, label} on the stamped pre.mermaid (data-id and id pattern)', async () => {
    const d = await openDoc(browser, harness, 'media');
    try {
      await send(d.page, 'setTool', { tool: 'pick' });
      await settle(d.frame);
      const gw = await rectOf(d.frame, 'pre.mermaid g[data-id="Gateway"] rect');
      await hover(d, gw, 'mermaid node "Gateway"');
      let from = await mark(d.page);
      await d.page.mouse.down();
      await d.page.mouse.up();
      let act = await waitMsg(d.page, 'action', from);
      assert.deepEqual(act.capture, {
        kind: 'element', srid: 31, tag: 'pre', label: 'mermaid node "Gateway"',
        svg: { nodeId: 'Gateway', label: 'Gateway' },
      });

      await send(d.page, 'setTool', { tool: 'pick' });
      await settle(d.frame);
      const auth = await rectOf(d.frame, 'pre.mermaid #flowchart-Auth-2 rect');
      await hover(d, auth, 'mermaid node "Auth"');
      from = await mark(d.page);
      await d.page.mouse.down();
      await d.page.mouse.up();
      act = await waitMsg(d.page, 'action', from);
      assert.deepEqual(act.capture.svg, { nodeId: 'Auth', label: 'Auth' });
      assert.equal(act.capture.srid, 31);
    } finally {
      await d.close();
    }
  });

  test('Esc exits pick mode and posts toolChanged', async () => {
    const d = await openDoc(browser, harness, 'media');
    try {
      await d.page.mouse.click(600, 690);
      await send(d.page, 'setTool', { tool: 'pick' });
      await settle(d.frame);
      const from = await mark(d.page);
      await d.page.keyboard.press('Escape');
      await waitMsg(d.page, 'toolChanged', from, (m) => m.tool === 'select');
      assert.equal((await inspect(d.frame)).glass, false);
      assert.equal((await msgsOf(d.page, 'key', from)).length, 0);
    } finally {
      await d.close();
    }
  });

  test('shift-drag on an img yields a region and a PNG crop', async () => {
    const d = await openDoc(browser, harness, 'media');
    try {
      await send(d.page, 'setTool', { tool: 'pick' });
      await settle(d.frame);
      const img = await rectOf(d.frame, 'img');
      const from = await mark(d.page);
      await d.page.keyboard.down('Shift');
      await d.page.mouse.move(img.x + 30, img.y + 40);
      await d.page.mouse.down();
      await d.page.mouse.move(img.x + 90, img.y + 90, { steps: 4 });
      await d.page.mouse.move(img.x + 150, img.y + 140, { steps: 4 });
      await d.page.mouse.up();
      await d.page.keyboard.up('Shift');
      const act = await waitMsg(d.page, 'action', from);
      const c = act.capture;
      assert.deepEqual(Object.keys(c), ['kind', 'srid', 'tag', 'label', 'region']);
      assert.equal(c.kind, 'element');
      assert.equal(c.srid, 5);
      assert.equal(c.tag, 'img');
      assert.match(c.label, /^img "System overview" region x10-50% y20-70%$/);
      for (const [k, v] of Object.entries({ x: 0.1, y: 0.2, w: 0.4, h: 0.5 })) {
        assert.ok(Math.abs(c.region[k] - v) < 0.01, `region.${k}=${c.region[k]}`);
      }
      assert.match(act.crop, /^data:image\/png;base64,/);
      const size = pngSize(act.crop);
      assert.ok(Math.abs(size.width - 120) <= 2 && Math.abs(size.height - 100) <= 2, JSON.stringify(size));
    } finally {
      await d.close();
    }
  });

  test('shift-drag on a canvas and on an inline svg crops them', async () => {
    const d = await openDoc(browser, harness, 'media');
    try {
      for (const [sel, srid, tag] of /** @type {Array<[string, number, string]>} */ ([['canvas', 32, 'canvas'], ['svg[data-srid="24"]', 24, 'svg']])) {
        await send(d.page, 'setTool', { tool: 'pick' });
        await settle(d.frame);
        const r = await rectOf(d.frame, sel);
        const from = await mark(d.page);
        await d.page.keyboard.down('Shift');
        await d.page.mouse.move(r.x + 5, r.y + 5);
        await d.page.mouse.down();
        await d.page.mouse.move(r.x + r.w / 2, r.y + r.h - 5, { steps: 5 });
        await d.page.mouse.up();
        await d.page.keyboard.up('Shift');
        const act = await waitMsg(d.page, 'action', from);
        assert.equal(act.capture.srid, srid);
        assert.equal(act.capture.tag, tag);
        assert.ok(act.capture.region.w > 0.3 && act.capture.region.w < 0.6);
        assert.match(act.crop || '', /^data:image\/png;base64,/, `${tag} crop`);
      }
    } finally {
      await d.close();
    }
  });
});

describe('targets', () => {
  const TARGETS = [
    { id: 't1', num: 1, kind: 'text', state: 'open', srid: 4, endSrid: 4, quote: 'rotated on every use', prefix: 'tokens are ', suffix: ' and expire', region: null, svg: null, cell: null, label: '' },
    { id: 't2', num: 2, kind: 'text', state: 'resolved', srid: 7, endSrid: null, quote: 'concurrent refreshes', prefix: '', suffix: '', region: null, svg: null, cell: null, label: '' },
    { id: 't3', num: 3, kind: 'element', state: 'open', srid: 8, endSrid: null, quote: null, prefix: '', suffix: '', region: null, svg: null, cell: null, label: 'h2 "Rollout plan"' },
    // quote outside its scope: found in the whole document
    { id: 't4', num: 4, kind: 'text', state: 'addressed', srid: 6, endSrid: 6, quote: 'Tokens are rotated on every use', prefix: 'logged. ', suffix: ' in the legacy', region: null, svg: null, cell: null, label: '' },
    { id: 't5', num: 5, kind: 'text', state: 'outdated', srid: 11, endSrid: 11, quote: 'Phase two ships', prefix: '', suffix: '', region: null, svg: null, cell: null, label: '' },
    // quote nowhere: outline the scope element ('block')
    { id: 't6', num: 6, kind: 'text', state: 'open', srid: 6, endSrid: 6, quote: 'words that do not exist', prefix: '', suffix: '', region: null, svg: null, cell: null, label: '' },
    // neither element nor quote: missing
    { id: 't7', num: 7, kind: 'text', state: 'orphaned', srid: 9999, endSrid: null, quote: 'nothing like this', prefix: '', suffix: '', region: null, svg: null, cell: null, label: '' },
    // inside a closed <details>: hidden
    { id: 't8', num: 8, kind: 'text', state: 'open', srid: 16, endSrid: 16, quote: 'secret rotation interval', prefix: '', suffix: '', region: null, svg: null, cell: null, label: '' },
    { id: 'L1', num: null, kind: 'text', state: 'lock', srid: 10, endSrid: 11, quote: 'Phase one ships to internal users.', prefix: '', suffix: '', region: null, svg: null, cell: null, label: 'Phase one' },
    // inside a hidden tab panel: hidden
    { id: 'd1', num: 9, kind: 'text', state: 'draft', srid: 24, endSrid: 24, quote: 'Rate limits', prefix: '', suffix: '', region: null, svg: null, cell: null, label: '' },
    { id: 't10', num: 10, kind: 'doc', state: 'open', srid: null, endSrid: null, quote: null, prefix: '', suffix: '', region: null, svg: null, cell: null, label: 'GENERAL' },
    // whitespace-insensitive and spanning inline markup
    { id: 't11', num: 11, kind: 'text', state: 'open', srid: 3, endSrid: 3, quote: 'Refresh tokens are\n   rotated   on every use and   expire', prefix: '', suffix: '', region: null, svg: null, cell: null, label: '' },
  ];

  test('DomTargets resolve, paint CSS highlights and post positions', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      const from = await mark(d.page);
      await send(d.page, 'setTargets', { targets: TARGETS });
      const pos = await waitMsg(d.page, 'positions', from, (m) => Object.keys(m.targets).length === 12);
      const st = Object.fromEntries(Object.entries(pos.targets).map(([k, v]) => [k, /** @type {any} */ (v).state]));
      assert.deepEqual(st, {
        t1: 'ok', t2: 'ok', t3: 'ok', t4: 'ok', t5: 'ok', t6: 'block', t7: 'missing', t8: 'hidden', L1: 'ok', d1: 'hidden',
        t10: 'ok', t11: 'ok',
      });
      assert.equal(pos.targets.t7.top, null);
      assert.equal(pos.targets.t10.top, 0);
      assert.ok(pos.targets.t1.top > 0 && pos.targets.t1.height > 0);
      assert.ok(pos.targets.t5.top > pos.targets.t1.top);
      assert.ok(typeof pos.scrollY === 'number' && pos.viewportH === 700 && pos.docH > 700);

      const hl = await d.frame.evaluate(() => {
        /** @type {Record<string, string[]>} */
        const out = {};
        for (const [name, h] of /** @type {any} */ (CSS).highlights) out[name] = [...h].map((/** @type {Range} */ r) => r.toString());
        return out;
      });
      assert.deepEqual(hl['sr-open'].sort(), ['Refresh tokens are rotated on every use and expire', 'Tokens are rotated on every use', 'rotated on every use', 'secret rotation interval'].sort());
      assert.deepEqual(hl['sr-resolved'], ['concurrent refreshes']);
      assert.deepEqual(hl['sr-outdated'], ['Phase two ships']);
      assert.deepEqual(hl['sr-lock'], ['Phase one ships to internal users.']);
      assert.deepEqual(hl['sr-draft'], ['Rate limits']);
      assert.deepEqual(hl['sr-active'], []);

      const ins = await inspect(d.frame);
      const marks = ins.layers.marks.map((/** @type {any} */ m) => m.key);
      assert.ok(marks.includes('outline:t3'), 'element target outlined');
      assert.ok(marks.includes('outline:t6'), 'block target outlined');
      assert.ok(marks.includes('bracket:L1'), 'lock bracket drawn');
      const blockBox = ins.layers.marks.find((/** @type {any} */ m) => m.key === 'outline:t6');
      assert.match(blockBox.cls, /\bblock\b/);
      const pins = ins.layers.pins.map((/** @type {any} */ p) => p.text);
      assert.deepEqual(pins.slice().sort(), ['1', '11', '2', '3', '4', '5', '6'].sort(), 'pins for visible non-lock targets');
      // Pins never overlap.
      const tops = ins.layers.pins.map((/** @type {any} */ p) => p.rect.y).sort((/** @type {number} */ a, /** @type {number} */ b) => a - b);
      for (let i = 1; i < tops.length; i++) assert.ok(tops[i] - tops[i - 1] >= 21.5);
      // The adopted stylesheet only holds ::highlight rules.
      const sheets = await d.frame.evaluate(() => document.adoptedStyleSheets.map((s) => [...s.cssRules].map((r) => r.cssText)));
      assert.equal(sheets.length, 1);
      assert.ok(sheets[0].every((t) => t.startsWith('::highlight(sr-')));
    } finally {
      await d.close();
    }
  });

  test('focus reveals a target inside <details>, activates and scrolls', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      await send(d.page, 'setTargets', { targets: TARGETS });
      await settle(d.frame);
      const from = await mark(d.page);
      await send(d.page, 'focus', { id: 't8' });
      const pos = await waitMsg(d.page, 'positions', from, (m) => m.targets.t8 && m.targets.t8.state === 'ok');
      assert.ok(pos.targets.t8.height > 0);
      assert.equal(await d.frame.evaluate(() => /** @type {HTMLDetailsElement} */ (document.querySelector('details')).open), true);
      const hl = await d.frame.evaluate(() => [.../** @type {any} */ (CSS).highlights.get('sr-active')].map((r) => r.toString()));
      assert.deepEqual(hl, ['secret rotation interval']);
      assert.equal((await inspect(d.frame)).activeId, 't8');
    } finally {
      await d.close();
    }
  });

  test('reveal clicks the controlling tab (author script switches the panel)', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      await send(d.page, 'setTargets', { targets: TARGETS });
      await settle(d.frame);
      const from = await mark(d.page);
      await send(d.page, 'reveal', { id: 'd1' });
      await waitMsg(d.page, 'positions', from, (m) => m.targets.d1 && m.targets.d1.state === 'ok');
      const hidden = await d.frame.evaluate(() => [/** @type {HTMLElement} */ (document.getElementById('panel-a')).hidden,
        /** @type {HTMLElement} */ (document.getElementById('panel-b')).hidden]);
      assert.deepEqual(hidden, [true, false]);
    } finally {
      await d.close();
    }
  });

  test('clicking a highlight or a pin posts activate', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      await send(d.page, 'setTargets', { targets: TARGETS });
      await settle(d.frame);
      const r = await rectOf(d.frame, '[data-srid="7"]', 'concurrent');
      let from = await mark(d.page);
      await d.page.mouse.click(r.cx, r.cy);
      let act = await waitMsg(d.page, 'activate', from);
      assert.equal(act.id, 't2');

      const ins = await inspect(d.frame);
      const pin = ins.layers.pins.find((/** @type {any} */ p) => p.key === 'pin:t3');
      from = await mark(d.page);
      await d.page.mouse.click(pin.rect.x + pin.rect.width / 2, pin.rect.y + pin.rect.height / 2);
      act = await waitMsg(d.page, 'activate', from);
      assert.equal(act.id, 't3');
      assert.equal((await inspect(d.frame)).activeId, 't3');
    } finally {
      await d.close();
    }
  });

  test('element targets on media: region box, mermaid node box and outline', async () => {
    const d = await openDoc(browser, harness, 'media');
    try {
      const from = await mark(d.page);
      await send(d.page, 'setTargets', {
        targets: [
          { id: 'r1', num: 1, kind: 'element', state: 'open', srid: 5, endSrid: null, quote: null, prefix: '', suffix: '', region: { x: 0.5, y: 0.5, w: 0.25, h: 0.25 }, svg: null, cell: null, label: 'img' },
          { id: 'm1', num: 2, kind: 'element', state: 'needs_input', srid: 31, endSrid: null, quote: null, prefix: '', suffix: '', region: null, svg: { nodeId: 'Auth', label: 'Auth' }, cell: null, label: 'mermaid node' },
          { id: 'c1', num: 3, kind: 'cell', state: 'open', srid: 19, endSrid: null, quote: 'sliding window', prefix: '', suffix: '', region: null, svg: null, cell: { row: 2, col: 1 }, label: 'td' },
        ],
      });
      const pos = await waitMsg(d.page, 'positions', from, (m) => Object.keys(m.targets).length === 3);
      assert.deepEqual(Object.values(pos.targets).map((/** @type {any} */ v) => v.state), ['ok', 'ok', 'ok']);
      const ins = await inspect(d.frame);
      const img = await rectOf(d.frame, 'img');
      const region = ins.layers.marks.find((/** @type {any} */ m) => m.key === 'region:r1');
      assert.ok(region, 'region box drawn');
      assert.ok(Math.abs(region.rect.x - (img.x + 150)) < 1.5 && Math.abs(region.rect.y - (img.y + 100)) < 1.5);
      assert.ok(Math.abs(region.rect.width - 75) < 1.5 && Math.abs(region.rect.height - 50) < 1.5);
      const node = ins.layers.marks.find((/** @type {any} */ m) => m.key === 'outline:m1');
      assert.match(node.cls, /\bnode\b/);
      const auth = await rectOf(d.frame, '#flowchart-Auth-2');
      assert.ok(Math.abs(node.rect.x - (auth.x - 3)) < 1.5 && Math.abs(node.rect.width - (auth.w + 6)) < 1.5);
      assert.ok(ins.layers.marks.some((/** @type {any} */ m) => m.key === 'outline:c1'));
      assert.equal(ins.targets.find((/** @type {any} */ t) => t.id === 'm1').mark, 'g');
    } finally {
      await d.close();
    }
  });

  test('setHidden clears highlights and annotation layers; setTheme switches the overlay theme', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      await send(d.page, 'setTargets', { targets: TARGETS });
      await settle(d.frame);
      assert.ok((await inspect(d.frame)).highlights['sr-open'] > 0);
      await send(d.page, 'setHidden', { hidden: true });
      await settle(d.frame);
      let ins = await inspect(d.frame);
      assert.equal(ins.hidden, true);
      assert.equal(ins.highlights['sr-open'], 0);
      assert.equal(ins.layers.pins.length, 0);
      await send(d.page, 'setHidden', { hidden: false });
      await send(d.page, 'setTheme', { theme: 'dark' });
      await settle(d.frame);
      ins = await inspect(d.frame);
      assert.ok(ins.highlights['sr-open'] > 0);
      assert.equal(ins.theme, 'dark');
      // An authored HTML doc (no shell theme links) keeps its own colour scheme: <html> is not touched.
      assert.equal(await d.frame.evaluate(() => document.documentElement.getAttribute('style')), null);
    } finally {
      await d.close();
    }
  });

  test('setTheme flips the shell theme links and dispatches sr-theme; unmarked mermaid text is excluded', async () => {
    const d = await openDoc(browser, harness, 'shell', { init: false });
    try {
      const ready = await waitMsg(d.page, 'ready');
      assert.deepEqual(ready.features, { mermaid: true, math: false, code: true });
      await send(d.page, 'setTheme', { theme: 'dark' });
      await settle(d.frame);
      const media = () => d.frame.evaluate(() => [...document.querySelectorAll('link[data-sr-theme]')]
        .map((l) => `${l.getAttribute('data-sr-theme')}=${l.getAttribute('media')}`));
      assert.deepEqual(await media(), ['light=not all', 'dark=all']);
      // The shell's own colour scheme follows too (dark scrollbars / form controls on the dark sheet).
      const scheme = () => d.frame.evaluate(() => [document.documentElement.style.colorScheme, getComputedStyle(document.documentElement).colorScheme]);
      assert.deepEqual(await scheme(), ['dark', 'dark']);
      // ...and html[data-sr-theme], which pins the page background in shell.css (also past the article on overscroll).
      const pinned = () => d.frame.evaluate(() => document.documentElement.getAttribute('data-sr-theme'));
      assert.equal(await pinned(), 'dark');
      await send(d.page, 'setTheme', { theme: 'light' });
      await settle(d.frame);
      assert.deepEqual(await media(), ['light=all', 'dark=not all']);
      assert.deepEqual(await scheme(), ['light', 'light']);
      assert.equal(await pinned(), 'light');
      await send(d.page, 'setTheme', { theme: 'system' });
      await settle(d.frame);
      assert.deepEqual(await media(), ['light=(prefers-color-scheme: light)', 'dark=(prefers-color-scheme: dark)']);
      assert.equal(await d.frame.evaluate(() => document.documentElement.getAttribute('style')), null, 'system: inline scheme removed');
      assert.equal(await pinned(), null, 'system: no forced background');
      assert.deepEqual(await d.frame.evaluate(() => /** @type {any} */ (window).__themes), ['dark', 'light', 'system']);

      const raw = await d.frame.evaluate(() => /** @type {any} */ (window).__specreviewGuest.modules.TextWalk.docIndex().raw);
      assert.ok(!raw.includes('Alpha'), 'mermaid source is not rendered text');
      assert.ok(raw.includes('const answer = 42;\nconsole.log(answer);'), 'code text is kept verbatim');
      // Selecting inside the diagram snaps to the diagram element.
      const from = await mark(d.page);
      await selectText(d.frame, 4, 'Alpha');
      const msg = await waitMsg(d.page, 'selection', from, (m) => !!m.capture);
      assert.deepEqual(msg.capture, { kind: 'element', srid: 4, tag: 'div', label: 'mermaid diagram' });
      // A selection inside code keeps its newline verbatim.
      const from2 = await mark(d.page);
      await selectText(d.frame, 6, '42;\nconsole');
      const msg2 = await waitMsg(d.page, 'selection', from2, (m) => !!m.capture && m.capture.kind === 'text');
      assert.equal(msg2.capture.exact, '42;\nconsole');
      assert.equal(msg2.capture.startSrid, 6);
    } finally {
      await d.close();
    }
  });

  test('init carries targets, changes and the active id', async () => {
    const d = await openDoc(browser, harness, 'prose', { initPayload: { targets: TARGETS.slice(0, 2), activeId: 't1' } });
    try {
      const from = 0;
      await waitMsg(d.page, 'positions', from, (m) => Object.keys(m.targets).length === 2);
      const ins = await inspect(d.frame);
      assert.equal(ins.activeId, 't1');
      assert.equal(ins.highlights['sr-active'], 1);
    } finally {
      await d.close();
    }
  });
});

describe('changes overlay', () => {
  const CHANGES = {
    stats: { added: 3, removed: 4, hunks: 3, blocksChanged: 3 },
    hunks: [
      { id: 'h1', op: 'mod', old: { start: 14, lines: 1 }, new: { start: 14, lines: 1 }, srids: [3],
        words: [{ srid: 3, quote: 'rotated on every use', prefix: 'tokens are ', suffix: ' and expire' }],
        deleted: { text: 'rotated hourly', html: null, lines: 1 }, insertBefore: null, section: ['Token Service'],
        threads: ['t1'], linkedBy: 'overlap', other: null },
      { id: 'h2', op: 'add', old: { start: 18, lines: 0 }, new: { start: 18, lines: 2 }, srids: [10, 11], words: [],
        deleted: null, insertBefore: null, section: ['Token Service', 'Rollout plan'], threads: [], other: null },
      { id: 'h3', op: 'del', old: { start: 16, lines: 3 }, new: { start: 16, lines: 0 }, srids: [], words: [],
        deleted: { text: 'Old section\ngone', html: '<h2>Old section</h2><p onclick="alert(1)">gone<script>window.__pwned = 1</script></p><img src="x" onerror="window.__pwned = 2">', lines: 3 },
        insertBefore: { srid: 8 }, section: ['Token Service'], threads: [], other: 'Merged into rollout' },
    ],
  };

  test('bars, sr-ins highlights, removed tabs with sanitised popovers, badges and hunk positions', async () => {
    const d = await openDoc(browser, harness, 'prose', { initPayload: { mode: 'changes' } });
    try {
      const from = await mark(d.page);
      await send(d.page, 'setChanges', { changes: CHANGES });
      const pos = await waitMsg(d.page, 'positions', from, (m) => Object.keys(m.hunks).length === 3);
      for (const id of ['h1', 'h2', 'h3']) assert.equal(typeof pos.hunks[id], 'number', id);
      assert.ok(pos.hunks.h1 < pos.hunks.h3 && pos.hunks.h3 < pos.hunks.h2);

      const ins = await inspect(d.frame);
      const byKey = Object.fromEntries(ins.layers.changes.map((/** @type {any} */ x) => [x.key, x]));
      assert.match(byKey['bar:h1:3'].cls, /\bmod\b/);
      assert.match(byKey['bar:h2:10'].cls, /\badd\b/);
      assert.match(byKey['bar:h2:11'].cls, /\badd\b/);
      assert.equal(byKey['tab:h3'].text, '⊖ 3 lines removed');
      assert.equal(byKey['tab:h1'].text, '⊖ was');
      assert.equal(byKey['badge:h1:t:t1'].text, 't1');
      assert.equal(byKey['badge:h3:other'].text, 'other');
      assert.equal(byKey['badge:h3:other'].title, 'Merged into rollout');
      // the removed tab sits just above the insertBefore element
      const h2 = await rectOf(d.frame, '[data-srid="8"]');
      assert.ok(byKey['tab:h3'].rect.y < h2.y && byKey['tab:h3'].rect.y > h2.y - 30);
      assert.equal(ins.highlights['sr-ins'], 1);
      const insText = await d.frame.evaluate(() => [.../** @type {any} */ (CSS).highlights.get('sr-ins')].map((r) => r.toString()));
      assert.deepEqual(insText, ['rotated on every use']);

      // Open the deleted-content popover: rendered html, no scripts / handlers executed or kept.
      const tab = byKey['tab:h3'].rect;
      await d.page.mouse.click(tab.x + tab.width / 2, tab.y + tab.height / 2);
      await settle(d.frame, 100);
      const pop = (await inspect(d.frame)).popover;
      assert.equal(pop.for, 'h3');
      assert.match(pop.text, /Old section/);
      assert.doesNotMatch(pop.html, /script|onclick|onerror/i);
      assert.equal(await d.frame.evaluate(() => /** @type {any} */ (window).__pwned), undefined);

      // Thread badge -> activate.
      const badge = byKey['badge:h1:t:t1'].rect;
      const from2 = await mark(d.page);
      await d.page.mouse.click(badge.x + badge.width / 2, badge.y + badge.height / 2);
      const act = await waitMsg(d.page, 'activate', from2);
      assert.equal(act.id, 't1');

      // Clearing removes everything.
      await send(d.page, 'setChanges', { changes: null });
      await settle(d.frame);
      const after = await inspect(d.frame);
      assert.equal(after.layers.changes.length, 0);
      assert.equal(after.highlights['sr-ins'], 0);
      assert.equal(after.popover, null);
    } finally {
      await d.close();
    }
  });

  test('tabs and badges of changed table cells stay inside the cell box, never over neighbouring cells', async () => {
    const d = await openDoc(browser, harness, 'media', { initPayload: { mode: 'changes' } });
    try {
      // A short text in the wide (colspan) cell leaves room for the full tab after it.
      await d.frame.evaluate(() => { /** @type {Element} */ (document.querySelector('[data-srid="19"]')).textContent = 'sliding'; });
      const from = await mark(d.page);
      await send(d.page, 'setChanges', { changes: { hunks: [
        // narrow cells whose row above is a body row / the header row
        { id: 'c1', op: 'mod', srids: [22], words: [{ srid: 22, quote: '15 min' }], deleted: { text: '10 min', html: null, lines: 1 },
          insertBefore: null, threads: ['t7'], other: null },
        { id: 'c2', op: 'mod', srids: [17], words: [], deleted: { text: 'static', html: null, lines: 1 },
          insertBefore: null, threads: [], other: 'Wording' },
        // a changed cell without removed text: badges only
        { id: 'c3', op: 'add', srids: [16], words: [], deleted: null, insertBefore: null, threads: ['t8', 't9'], other: null },
        // a removed row: the tab goes into the following row's first cell
        { id: 'c4', op: 'del', srids: [], words: [], deleted: { text: 'id_token | 5 min | JWT', html: null, lines: 1 },
          insertBefore: { srid: 21 }, threads: [], other: null },
        // a cell with room after its text: the full tab on that line, still inside the cell
        { id: 'c5', op: 'mod', srids: [19], words: [], deleted: { text: 'fixed', html: null, lines: 1 },
          insertBefore: null, threads: ['t5'], other: null },
      ] } });
      await waitMsg(d.page, 'positions', from, (m) => Object.keys(m.hunks).length === 5);
      await settle(d.frame);
      const ins = await inspect(d.frame);
      const byKey = Object.fromEntries(ins.layers.changes.map((/** @type {any} */ x) => [x.key, x]));
      const cells = await d.frame.evaluate(() => Object.fromEntries([...document.querySelectorAll('td, th')].map((c) => {
        const r = document.createRange();
        r.selectNodeContents(c);
        const b = c.getBoundingClientRect();
        return [c.getAttribute('data-srid'), {
          box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
          text: [...r.getClientRects()].filter((x) => x.width > 0).map((x) => ({ left: x.left, top: x.top, right: x.right, bottom: x.bottom })),
        }];
      })));
      /** @param {any} r @param {string} srid @param {string} what */
      const check = (r, srid, what) => {
        const box = cells[srid].box;
        assert.ok(r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5,
          `${what} ${JSON.stringify(r)} lies inside cell ${srid} ${JSON.stringify(box)}`);
        for (const [other, c] of Object.entries(cells)) {
          if (other === srid) continue;
          for (const t of c.text) assert.ok(!overlaps(r, t), `${what} does not cover the text of cell ${other}`);
        }
      };
      check(byKey['tab:c1'].rect, '22', 'tab c1');
      check(byKey['badge:c1:t:t7'].rect, '22', 'badge c1/t7');
      check(byKey['tab:c2'].rect, '17', 'tab c2');
      check(byKey['badge:c2:other'].rect, '17', 'badge c2/other');
      check(byKey['badge:c3:t:t8'].rect, '16', 'badge c3/t8');
      check(byKey['badge:c3:t:t9'].rect, '16', 'badge c3/t9');
      check(byKey['tab:c4'].rect, '21', 'tab c4');
      assert.ok(!overlaps(byKey['badge:c3:t:t8'].rect, byKey['badge:c3:t:t9'].rect), 'badges do not overlap each other');
      assert.ok(!overlaps(byKey['tab:c1'].rect, byKey['badge:c1:t:t7'].rect), 'the badge does not overlap the tab');
      check(byKey['tab:c5'].rect, '19', 'tab c5');
      check(byKey['badge:c5:t:t5'].rect, '19', 'badge c5/t5');
      assert.equal(byKey['tab:c5'].text, '⊖ was', 'room after the text: the full tab');
      assert.ok(byKey['tab:c5'].rect.x >= cells['19'].text[0].right, 'after the end of the text');
      assert.equal(byKey['tab:c1'].text, '⊖', 'narrow cell: compact tab');
      assert.match(byKey['tab:c1'].cls, /\bcompact\b/);
      assert.match(byKey['tab:c1'].title, /replaced text/);
      assert.match(byKey['tab:c4'].title, /1 line removed/);

      // The compact tab still opens the removed-text popover.
      const tab = byKey['tab:c1'].rect;
      await d.page.mouse.click(tab.x + tab.width / 2, tab.y + tab.height / 2);
      await settle(d.frame, 100);
      const pop = (await inspect(d.frame)).popover;
      assert.equal(pop && pop.for, 'c1');
      assert.match(pop.text, /10 min/);
    } finally {
      await d.close();
    }
  });

  test('scrollTo {hunk} scrolls the change into view', async () => {
    const d = await openDoc(browser, harness, 'prose', { initPayload: { mode: 'changes', changes: {
      hunks: [{ id: 'h9', op: 'mod', srids: [30], words: [], deleted: null, insertBefore: null }],
    } } });
    try {
      const from = await mark(d.page);
      await send(d.page, 'scrollTo', { hunk: 'h9' });
      const pos = await waitMsg(d.page, 'positions', from, (m) => m.scrollY > 500);
      assert.ok(pos.hunks.h9 >= pos.scrollY && pos.hunks.h9 <= pos.scrollY + pos.viewportH);
      const scroll = await waitMsg(d.page, 'scroll', from);
      assert.equal(typeof scroll.topSrid, 'number');
    } finally {
      await d.close();
    }
  });
});

describe('security and fidelity', () => {
  test('forged window messages after the handshake are ignored; only the port is trusted', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      // From the parent window, as a window message (not via the port).
      await d.page.evaluate((origin) => {
        const w = /** @type {HTMLIFrameElement} */ (document.getElementById('doc')).contentWindow;
        w?.postMessage({ sr: 1, type: 'setHidden', hidden: true }, origin);
        w?.postMessage({ sr: 1, type: 'setTool', tool: 'pick' }, origin);
      }, harness.contentOrigin);
      // From the document itself.
      await d.frame.evaluate(() => {
        window.postMessage({ sr: 1, type: 'setHidden', hidden: true }, '*');
        window.postMessage({ sr: 1, type: 'setTool', tool: 'pick' }, '*');
      });
      // A second 'connect' with a fresh port from the real parent.
      await d.page.evaluate((origin) => {
        const ch = new MessageChannel();
        /** @type {any} */ (window).__forged = ch.port1;
        /** @type {any} */ (window).__forgedMsgs = [];
        ch.port1.onmessage = (e) => /** @type {any} */ (window).__forgedMsgs.push(e.data);
        /** @type {HTMLIFrameElement} */ (document.getElementById('doc')).contentWindow?.postMessage({ sr: 1, type: 'connect' }, origin, [ch.port2]);
      }, harness.contentOrigin);
      await settle(d.frame, 100);
      await d.page.evaluate(() => /** @type {any} */ (window).__forged.postMessage({ sr: 1, type: 'setHidden', hidden: true }));
      await settle(d.frame, 100);
      let ins = await inspect(d.frame);
      assert.equal(ins.hidden, false);
      assert.equal(ins.glass, false);
      assert.deepEqual(await d.page.evaluate(() => /** @type {any} */ (window).__forgedMsgs), []);
      // The genuine port still works.
      await send(d.page, 'setHidden', { hidden: true });
      await settle(d.frame);
      ins = await inspect(d.frame);
      assert.equal(ins.hidden, true);
    } finally {
      await d.close();
    }
  });

  test("the author's scripts keep working with the guest present", async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      const tab = await rectOf(d.frame, '#tab-b');
      await d.page.mouse.click(tab.cx, tab.cy);
      const counter = await rectOf(d.frame, '#clicks');
      await d.page.mouse.click(counter.cx, counter.cy);
      await d.page.mouse.click(counter.cx, counter.cy);
      const state = await d.frame.evaluate(() => ({
        a: /** @type {HTMLElement} */ (document.getElementById('panel-a')).hidden,
        b: /** @type {HTMLElement} */ (document.getElementById('panel-b')).hidden,
        clicks: /** @type {HTMLElement} */ (document.getElementById('clicks')).textContent,
      }));
      assert.deepEqual(state, { a: true, b: false, clicks: 'clicks: 2' });
      assert.deepEqual(d.pageErrors, []);
      assert.deepEqual(await d.frame.evaluate(() => /** @type {any} */ (window).__specreviewGuest.errors()), []);
    } finally {
      await d.close();
    }
  });

  test('observe-only: author DOM untouched, one overlay element, one extra global', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(harness.rawUrl('media'));
      const base = await page.evaluate(() => ({ props: Object.getOwnPropertyNames(window), body: document.body.outerHTML }));
      await page.close();

      const d = await openDoc(browser, harness, 'media');
      try {
        await send(d.page, 'setTargets', { targets: [
          { id: 'x1', num: 1, kind: 'element', state: 'open', srid: 5, quote: null, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
          { id: 'x2', num: 2, kind: 'text', state: 'open', srid: 33, quote: 'Closing paragraph' },
        ] });
        await send(d.page, 'setChanges', { changes: { hunks: [{ id: 'h1', op: 'mod', srids: [33], words: [{ srid: 33, quote: 'media' }], deleted: { text: 'old', html: null, lines: 1 } }] } });
        await send(d.page, 'setTool', { tool: 'pick' });
        await settle(d.frame);
        const img = await rectOf(d.frame, 'img');
        await d.page.mouse.move(img.cx, img.cy);
        await settle(d.frame, 100);
        await send(d.page, 'setTool', { tool: 'select' });
        await selectText(d.frame, 33, 'Closing');
        await settle(d.frame, 200);
        const now = await d.frame.evaluate(() => ({
          props: Object.getOwnPropertyNames(window),
          body: document.body.outerHTML,
          tail: [...document.documentElement.children].map((c) => c.localName),
          overlays: document.querySelectorAll('sr-overlay').length,
        }));
        const added = now.props.filter((p) => !base.props.includes(p));
        assert.deepEqual(added, ['__specreviewGuest']);
        assert.equal(now.body, base.body);
        assert.deepEqual(now.tail, ['head', 'body', 'sr-overlay']);
        assert.equal(now.overlays, 1);
      } finally {
        await d.close();
      }
    } finally {
      if (!page.isClosed()) await page.close();
    }
  });

  test('keys are forwarded only from non-editable focus and when not defaultPrevented', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      await d.page.mouse.click(700, 690); // focus the doc body
      const from = await mark(d.page);
      await d.page.keyboard.press('j');
      await d.page.keyboard.press('z'); // the author's handler prevents 'z'
      await d.page.keyboard.press('Shift+?');
      const input = await rectOf(d.frame, '#name');
      await d.page.mouse.click(input.cx, input.cy);
      await d.page.keyboard.type('xy');
      await d.page.keyboard.press('Escape');
      await settle(d.frame, 100);
      const keys = await msgsOf(d.page, 'key', from);
      assert.deepEqual(keys.map((/** @type {any} */ k) => ({ key: k.key, meta: k.meta, ctrl: k.ctrl, shift: k.shift, alt: k.alt })), [
        { key: 'j', meta: false, ctrl: false, shift: false, alt: false },
        { key: '?', meta: false, ctrl: false, shift: true, alt: false },
      ]);
    } finally {
      await d.close();
    }
  });

  test('page errors and failed external resources are reported', async () => {
    const d = await openDoc(browser, harness, 'errors');
    try {
      const err = await waitMsg(d.page, 'pageError', 0, (m) => m.count >= 2 && m.externalsFailed.length >= 1 &&
        m.resourcesFailed.length >= 1, 8000);
      assert.ok(err.externalsFailed.includes('http://127.0.0.1:9/missing.png'));
      assert.ok(err.resourcesFailed.some((/** @type {string} */ u) => u.endsWith('/img/nope.png')));
      const all = await msgsOf(d.page, 'pageError');
      const last = all[all.length - 1];
      assert.equal(last.count, 2);
      assert.ok(/boom from author|rejected by author/.test(last.last));
    } finally {
      await d.close();
    }
  });

  test('the overlay is re-shown above a modal dialog opened by the page', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      await send(d.page, 'setTargets', { targets: [{ id: 't1', num: 1, kind: 'text', state: 'open', srid: 4, quote: 'rotated on every use' }] });
      await settle(d.frame);
      const pin = (await inspect(d.frame)).layers.pins[0].rect;
      await d.frame.evaluate(() => {
        const dlg = document.createElement('dialog');
        dlg.style.cssText = 'width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:#fff';
        dlg.textContent = 'author modal';
        document.body.appendChild(dlg);
        dlg.showModal();
      });
      await settle(d.frame, 100);
      assert.equal((await inspect(d.frame)).topLayer, true);
      // Read the pixel at the pin centre from a screenshot: it must be the pin colour, not the white dialog.
      const shot = await d.page.screenshot({ clip: { x: pin.x + 6, y: pin.y + 6, width: 4, height: 4 } });
      const rgb = await d.page.evaluate(async (b64) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
        ctx.drawImage(img, 0, 0);
        return [...ctx.getImageData(1, 1, 1, 1).data.slice(0, 3)];
      }, shot.toString('base64'));
      assert.ok(rgb[0] > 150 && rgb[2] < 100, `pin colour expected, got ${rgb}`);
    } finally {
      await d.close();
    }
  });

  test('without the Highlight API the overlay draws fallback rects', async () => {
    const d = await openDoc(browser, harness, 'prose', {
      initScript: () => {
        try {
          Object.defineProperty(CSS, 'highlights', { value: undefined, configurable: true });
        } catch { /* ignore */ }
      },
    });
    try {
      const hello = await waitMsg(d.page, 'hello');
      assert.equal(hello.highlightApi, false);
      await send(d.page, 'setTargets', { targets: [{ id: 't1', num: 1, kind: 'text', state: 'open', srid: 4, quote: 'rotated on every use' }] });
      await settle(d.frame, 60);
      const ins = await inspect(d.frame);
      assert.ok(ins.layers.fallback && ins.layers.fallback.length >= 1);
      const r = await rectOf(d.frame, '[data-srid="4"]');
      const f = ins.layers.fallback[0].rect;
      assert.ok(Math.abs(f.x - r.x) < 1 && Math.abs(f.width - r.w) < 1);
    } finally {
      await d.close();
    }
  });
});
