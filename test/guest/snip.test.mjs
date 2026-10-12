// @ts-check
// Browser tests for snip mode (src/guest/65-snip.js): `b` / setTool {tool:'snip'}, the drag, the frozen SnipCapture
// shape, the PNG crop rendered by the vendored modern-screenshot (served by the harness under /__sr/<RV>/vendor/ like
// the daemon does) and the region round trip through the painter. Run: node --test "test/guest/**/*.test.mjs"

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startHarness } from './server.mjs';
import { openDoc, send, mark, waitMsg, msgsOf, inspect, settle, rectOf, decodePng, near } from './helpers.mjs';

const home = mkdtempSync(join(tmpdir(), 'sr-guest-snip-home-'));
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

const SNIP_KEYS = ['kind', 'srids', 'startSrid', 'endSrid', 'containerSrid', 'region', 'text', 'label'];
const RED = [220, 40, 40];
const GREEN = [40, 180, 60];
const WHITE = [255, 255, 255];

/** @typedef {Awaited<ReturnType<typeof openDoc>>} Doc */

/** @param {Doc} d */
const snipState = (d) => d.frame.evaluate(() => /** @type {any} */ (window).__suikoGuest.inspect().snip);

/**
 * Drags a box with the mouse (snip mode must be on), from (x0, y0) to (x1, y1) in page = iframe viewport coordinates.
 * @param {Doc} d @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
 */
async function drag(d, x0, y0, x1, y1) {
  await d.page.mouse.move(x0, y0);
  await d.page.mouse.down();
  await d.page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 3 });
  await d.page.mouse.move(x1, y1, { steps: 3 });
  await d.page.mouse.up();
}

/** A DomTarget for a snip anchor as the engine sends it back (kind 'element', srid = containerSrid). */
function snipTarget(/** @type {string} */ id, /** @type {any} */ capture) {
  return { id, num: 1, kind: 'element', state: 'open', srid: capture.containerSrid, endSrid: null, quote: null, prefix: '',
    suffix: '', region: capture.region, svg: null, cell: null, label: capture.label };
}

/**
 * Mean per-channel difference (0..255) of two decoded PNGs of the same size, and the share of clearly different pixels.
 * @param {ReturnType<typeof decodePng>} a @param {ReturnType<typeof decodePng>} b
 */
function pixelDiff(a, b) {
  assert.ok(Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1, `${a.width}x${a.height} vs ${b.width}x${b.height}`);
  let sum = 0;
  let bad = 0;
  let n = 0;
  for (let y = 0; y < Math.min(a.height, b.height); y++) {
    for (let x = 0; x < Math.min(a.width, b.width); x++) {
      const p = a.pixel(x, y);
      const q = b.pixel(x, y);
      const d = (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2])) / 3;
      sum += d;
      if (d > 64) bad++;
      n++;
    }
  }
  return { mean: sum / n, bad: bad / n };
}

/**
 * Snips a viewport box and returns the action plus a screenshot of the same area (taken once the overlay is clear).
 * @param {Doc} d @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
 */
async function snipAndShoot(d, x0, y0, x1, y1) {
  await send(d.page, 'setTool', { tool: 'snip' });
  await settle(d.frame);
  const from = await mark(d.page);
  await drag(d, x0, y0, x1, y1);
  const act = await waitMsg(d.page, 'action', from, null, 10000);
  await settle(d.frame, 50);
  const shot = await d.page.screenshot({ clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
  return { act, shot: decodePng('data:image/png;base64,' + shot.toString('base64')), crop: decodePng(act.crop) };
}

/** Starts recording the author-visible DOM mutations of the doc (the guest must cause none). @param {Doc} d */
async function watchDom(d) {
  await d.frame.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__mutations = [];
    new MutationObserver((records) => {
      for (const r of records) w.__mutations.push(`${r.type}:${/** @type {Element} */ (r.target).localName || r.target.nodeName}`);
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  });
}

describe('snip mode', () => {
  test('b in the doc toggles snip mode and posts toolChanged; Esc cancels; Shift+B is forwarded', async () => {
    const d = await openDoc(browser, harness, 'snip');
    try {
      await d.page.mouse.click(760, 600); // focus the doc (empty area)
      const from = await mark(d.page);
      await d.page.keyboard.press('b');
      await waitMsg(d.page, 'toolChanged', from, (m) => m.tool === 'snip');
      let ins = await inspect(d.frame);
      assert.equal(ins.glass, true);
      assert.match(ins.hint, /Esc/);
      assert.equal(ins.snip.active, true);

      let at = await mark(d.page);
      await d.page.keyboard.press('b');
      await waitMsg(d.page, 'toolChanged', at, (m) => m.tool === 'select');
      ins = await inspect(d.frame);
      assert.equal(ins.glass, false);
      assert.equal(ins.hint, null);

      at = await mark(d.page);
      await d.page.keyboard.press('b');
      await waitMsg(d.page, 'toolChanged', at, (m) => m.tool === 'snip');
      at = await mark(d.page);
      await d.page.keyboard.press('Escape');
      await waitMsg(d.page, 'toolChanged', at, (m) => m.tool === 'select');
      assert.equal((await inspect(d.frame)).glass, false);

      at = await mark(d.page);
      await d.page.keyboard.press('Shift+B');
      const key = await waitMsg(d.page, 'key', at, (m) => m.key === 'B');
      assert.equal(key.shift, true);
      await settle(d.frame, 100);
      assert.equal((await msgsOf(d.page, 'toolChanged', at)).length, 0);
      assert.equal((await inspect(d.frame)).glass, false);
      // A script in the doc cannot fake keys: untrusted Shift+B / b / c are neither forwarded nor acted on.
      at = await mark(d.page);
      await d.frame.evaluate(() => {
        for (const init of [{ key: 'B', shiftKey: true }, { key: 'b' }, { key: 'c' }, { key: 'Enter', metaKey: true, shiftKey: true }]) {
          document.body.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }));
        }
      });
      await settle(d.frame, 100);
      assert.equal((await msgsOf(d.page, 'key', at)).length, 0);
      assert.equal((await msgsOf(d.page, 'toolChanged', at)).length, 0);
      assert.equal((await inspect(d.frame)).snip.active, false);
      // Neither b nor Esc ever reached the UI as keys, and nothing was snipped.
      const keys = (await msgsOf(d.page, 'key', from)).map((m) => m.key);
      assert.deepEqual(keys, ['B']);
      assert.equal((await msgsOf(d.page, 'action', from)).length, 0);
    } finally {
      await d.close();
    }
  });

  test('setTool switches snip / pick / select silently; readonly refuses snips and forwards b', async () => {
    const d = await openDoc(browser, harness, 'snip');
    try {
      const from = await mark(d.page);
      await send(d.page, 'setTool', { tool: 'snip' });
      await settle(d.frame);
      let ins = await inspect(d.frame);
      assert.equal(ins.snip.active, true);
      assert.equal(ins.glass, true);
      await send(d.page, 'setTool', { tool: 'pick' });
      await settle(d.frame);
      ins = await inspect(d.frame);
      assert.equal(ins.snip.active, false);
      assert.equal(ins.picker.active, true);
      assert.equal(ins.hint, null);
      await send(d.page, 'setTool', { tool: 'snip' });
      await settle(d.frame);
      ins = await inspect(d.frame);
      assert.equal(ins.picker.active, false);
      assert.equal(ins.snip.active, true);
      await send(d.page, 'setTool', { tool: 'select' });
      await settle(d.frame);
      ins = await inspect(d.frame);
      assert.equal(ins.snip.active, false);
      assert.equal(ins.glass, false);
      assert.equal((await msgsOf(d.page, 'toolChanged', from)).length, 0);

      await send(d.page, 'init', { mode: 'readonly', theme: 'light', targets: [], changes: null, activeId: null, hidden: false });
      await send(d.page, 'setTool', { tool: 'snip' });
      await settle(d.frame);
      assert.equal((await inspect(d.frame)).snip.active, false);
      await d.page.mouse.click(760, 600);
      const at = await mark(d.page);
      await d.page.keyboard.press('b');
      await waitMsg(d.page, 'key', at, (m) => m.key === 'b');
      assert.equal((await msgsOf(d.page, 'toolChanged', at)).length, 0);
      assert.equal((await inspect(d.frame)).snip.active, false);
    } finally {
      await d.close();
    }
  });

  test('b typed into an editable field is left alone', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      await d.frame.click('#name');
      const from = await mark(d.page);
      await d.page.keyboard.type('bb');
      await settle(d.frame, 100);
      assert.equal(await d.frame.evaluate(() => /** @type {HTMLInputElement} */ (document.getElementById('name')).value), 'bb');
      assert.equal((await inspect(d.frame)).snip.active, false);
      assert.equal((await msgsOf(d.page, 'toolChanged', from)).length, 0);
      assert.equal((await msgsOf(d.page, 'key', from)).length, 0);
    } finally {
      await d.close();
    }
  });

  test('a drag over text and an image yields the exact SnipCapture, a matching PNG crop, and paints back in place', async () => {
    const d = await openDoc(browser, harness, 'snip');
    try {
      const bravo = await rectOf(d.frame, 'p[data-srid="4"]', 'bravo');
      const delta = await rectOf(d.frame, 'p[data-srid="4"]', 'delta');
      const img = await rectOf(d.frame, 'img');
      const sec = await rectOf(d.frame, 'section');
      const x0 = Math.round(bravo.x - 1);
      const y0 = Math.round(bravo.y + 2);
      const x1 = Math.round(delta.x + delta.w + 1);
      const y1 = Math.round(img.y + 60);
      await watchDom(d);
      await send(d.page, 'setTool', { tool: 'snip' });
      await settle(d.frame);
      const from = await mark(d.page);
      await drag(d, x0, y0, x1, y1);
      const act = await waitMsg(d.page, 'action', from, null, 10000);
      await waitMsg(d.page, 'toolChanged', from, (m) => m.tool === 'select');

      const c = act.capture;
      assert.equal(act.action, 'comment');
      assert.deepEqual(Object.keys(c), SNIP_KEYS);
      assert.equal(c.kind, 'snip');
      assert.deepEqual(c.srids, [4, 6]);
      assert.equal(c.startSrid, 4);
      assert.equal(c.endSrid, 6);
      assert.equal(c.containerSrid, 2, 'the section is the deepest stamped element containing the box');
      assert.equal(c.text, 'bravo charlie delta');
      assert.equal(c.label, 'area in "2. Request flow" (paragraph + figure)');
      const want = { x: (x0 - sec.x) / sec.w, y: (y0 - sec.y) / sec.h, w: (x1 - x0) / sec.w, h: (y1 - y0) / sec.h };
      for (const [k, v] of Object.entries(want)) assert.ok(Math.abs(c.region[k] - v) < 0.002, `region.${k}=${c.region[k]} want ${v}`);
      assert.ok(Math.abs(act.rect.x - x0) <= 1 && Math.abs(act.rect.y - y0) <= 1, JSON.stringify(act.rect));
      assert.ok(Math.abs(act.rect.width - (x1 - x0)) <= 1 && Math.abs(act.rect.height - (y1 - y0)) <= 1);

      // The crop is exactly the boxed area at devicePixelRatio 1: text pixels at the top, the image's red and green
      // quadrants below.
      assert.match(act.crop, /^data:image\/png;base64,/);
      const png = decodePng(act.crop);
      assert.ok(Math.abs(png.width - (x1 - x0)) <= 1 && Math.abs(png.height - (y1 - y0)) <= 1, `${png.width}x${png.height}`);
      assert.ok(near(png.pixel(img.x + 100 - x0, img.y + 30 - y0), RED), `red at ${png.pixel(img.x + 100 - x0, img.y + 30 - y0)}`);
      assert.ok(near(png.pixel(img.x + 160 - x0, img.y + 30 - y0), GREEN), `green at ${png.pixel(img.x + 160 - x0, img.y + 30 - y0)}`);
      let ink = 0;
      for (let y = 0; y < bravo.h - 4; y++) {
        for (let x = 0; x < png.width; x++) if (png.pixel(x, y)[0] < 120) ink++;
      }
      assert.ok(ink > 40, `text glyphs rendered in the crop (${ink} dark pixels)`);
      const snip = await snipState(d);
      assert.equal(snip.lastCrop.ok, true);
      assert.equal(snip.active, false);
      assert.equal(snip.pending, false);

      // Round trip: the engine sends the snip back as an element target on containerSrid; the region box is drawn
      // exactly over the dragged box.
      await send(d.page, 'setTargets', { targets: [snipTarget('s1', c)] });
      await settle(d.frame);
      const ins = await inspect(d.frame);
      const box = ins.layers.marks.find((/** @type {any} */ m) => m.key === 'region:s1');
      assert.ok(box, 'region box drawn');
      assert.ok(Math.abs(box.rect.x - x0) < 1.5 && Math.abs(box.rect.y - y0) < 1.5, JSON.stringify(box.rect));
      assert.ok(Math.abs(box.rect.width - (x1 - x0)) < 1.5 && Math.abs(box.rect.height - (y1 - y0)) < 1.5);
      assert.equal(ins.snipBox, null);
      assert.equal(ins.dragBox, null);

      // Observe-only: rendering the crop never touched the author's DOM.
      assert.deepEqual(await d.frame.evaluate(() => /** @type {any} */ (window).__mutations), []);
      assert.deepEqual(await d.frame.evaluate(() => /** @type {any} */ (window).__suikoGuest.errors()), []);
      assert.deepEqual(d.pageErrors, []);
    } finally {
      await d.close();
    }
  });

  test('the crop leaves out the overlay: outlines, pins and the snip box never show in it', async () => {
    const d = await openDoc(browser, harness, 'snip');
    try {
      await send(d.page, 'setTargets', { targets: [
        { id: 't1', num: 1, kind: 'element', state: 'open', srid: 6, endSrid: null, quote: null, prefix: '', suffix: '',
          region: null, svg: null, cell: null, label: 'img' },
      ] });
      await settle(d.frame);
      const outline = (await inspect(d.frame)).layers.marks.find((/** @type {any} */ m) => m.key === 'outline:t1');
      assert.ok(outline, 'the outline is drawn on the page');
      const img = await rectOf(d.frame, 'img');
      const x0 = Math.round(img.x - 12);
      const y0 = Math.round(img.y - 12);
      await send(d.page, 'setTool', { tool: 'snip' });
      await settle(d.frame);
      const from = await mark(d.page);
      await drag(d, x0, y0, x0 + 72, y0 + 72);
      const act = await waitMsg(d.page, 'action', from, null, 10000);
      assert.deepEqual(act.capture.srids, [6]);
      assert.equal(act.capture.containerSrid, 2);
      assert.equal(act.capture.label, 'area in "2. Request flow" (img "System overview")');
      assert.equal(act.capture.text, '');
      const png = decodePng(act.crop);
      // The outline's 2 px border runs at img.x - 3 .. img.x - 1: in the crop that column is page background.
      for (const y of [20, 40, 60]) {
        const px = png.pixel(img.x - 2 - x0, img.y + y - y0 - 12);
        assert.ok(near(px, WHITE, 8), `no outline in the crop at y=${y}: ${px}`);
      }
      // No snip / drag box border along the crop's edges, and the image itself is there.
      for (const [x, y] of [[0, 0], [1, 30], [30, 1], [png.width - 1, png.height - 1]]) {
        assert.ok(!near(png.pixel(x, y), [9, 105, 218], 40), `no blue box at ${x},${y}: ${png.pixel(x, y)}`);
      }
      assert.ok(near(png.pixel(40, 40), RED), `image pixels: ${png.pixel(40, 40)}`);
    } finally {
      await d.close();
    }
  });

  test('a click or a tiny drag keeps snip mode; Esc then cancels without an action', async () => {
    const d = await openDoc(browser, harness, 'snip');
    try {
      await send(d.page, 'setTool', { tool: 'snip' });
      await settle(d.frame);
      const from = await mark(d.page);
      await drag(d, 100, 300, 104, 340);
      await d.page.mouse.click(200, 300);
      await settle(d.frame, 200);
      assert.equal((await msgsOf(d.page, 'action', from)).length, 0);
      assert.equal((await snipState(d)).active, true);
      await d.page.keyboard.press('Escape');
      await waitMsg(d.page, 'toolChanged', from, (m) => m.tool === 'select');
      await settle(d.frame, 100);
      assert.equal((await msgsOf(d.page, 'action', from)).length, 0);
      assert.equal((await msgsOf(d.page, 'key', from)).length, 0);
    } finally {
      await d.close();
    }
  });

  test('outside every stamped container: region of the document; at devicePixelRatio 2 the crop is capped at 1600 px', async () => {
    const d = await openDoc(browser, harness, 'snip', { contextOptions: { deviceScaleFactor: 2 } });
    try {
      const h1 = await rectOf(d.frame, 'h1');
      const bravo = await rectOf(d.frame, 'p[data-srid="4"]', 'bravo');
      const size = await d.frame.evaluate(() => {
        const se = /** @type {Element} */ (document.scrollingElement);
        return { w: se.scrollWidth, h: se.scrollHeight };
      });
      const x0 = 4;
      const y0 = Math.round(h1.y + 4);
      const x1 = 884;
      const y1 = Math.round(bravo.y + 12);
      await send(d.page, 'setTool', { tool: 'snip' });
      await settle(d.frame);
      const from = await mark(d.page);
      await drag(d, x0, y0, x1, y1);
      const act = await waitMsg(d.page, 'action', from, null, 10000);
      const c = act.capture;
      assert.deepEqual(c.srids, [1, 3, 4]);
      assert.equal(c.containerSrid, null);
      assert.equal(c.label, 'area over "Snip fixture" (2 headings + paragraph)');
      assert.match(c.text, /^Snip fixture 2\. Request flow Alpha bravo charlie delta echo foxtrot\.$/);
      const want = { x: x0 / size.w, y: y0 / size.h, w: (x1 - x0) / size.w, h: (y1 - y0) / size.h };
      for (const [k, v] of Object.entries(want)) assert.ok(Math.abs(c.region[k] - v) < 0.002, `region.${k}=${c.region[k]} want ${v}`);
      const png = decodePng(act.crop);
      assert.equal(png.width, 1600, 'devicePixelRatio 2 would give 1760 px: capped at 1600');
      assert.ok(Math.abs(png.height - (y1 - y0) * (1600 / (x1 - x0))) <= 1.5, `${png.width}x${png.height}`);
      assert.equal((await snipState(d)).lastCrop.root, 'html');
    } finally {
      await d.close();
    }
  });

  test('KaTeX math reads as its TeX source, not the layout-order HTML text with zero-width struts', async () => {
    const d = await openDoc(browser, harness, 'math');
    try {
      const p2 = await rectOf(d.frame, 'p[data-srid="2"]');
      const p3 = await rectOf(d.frame, 'p[data-srid="3"]');
      await send(d.page, 'setTool', { tool: 'snip' });
      await settle(d.frame);
      const from = await mark(d.page);
      await drag(d, 4, Math.round(p2.y - 2), 900, Math.round(p3.y + p3.h - 2));
      const act = await waitMsg(d.page, 'action', from, null, 10000);
      const text = act.capture.text;
      assert.equal(text,
        '$$A = 1 - \\frac{\\text{failed enqueue requests}}{\\text{total enqueue requests}} \\geq 0.999$$ and inline $x^2$ reads as TeX too.');
      assert.doesNotMatch(text, /[\u200b\u200c\u200d\u2060\ufeff]/);

      // inline math takes its spacing from the text around it: no space before ',' or ')' or inside a word
      const p4 = await rectOf(d.frame, 'p[data-srid="4"]');
      await send(d.page, 'setTool', { tool: 'snip' });
      await settle(d.frame);
      const from4 = await mark(d.page);
      await drag(d, 4, Math.round(p4.y - 2), 900, Math.round(p4.y + p4.h - 2));
      const act4 = await waitMsg(d.page, 'action', from4, null, 10000);
      assert.equal(act4.capture.text, 'Sizes $x$, then ($a/b$) and the $n$th item.');
    } finally {
      await d.close();
    }
  });

  test('inside a mermaid diagram: anchored to the stamped <pre>; snip and pick regions both paint back in place', async () => {
    const d = await openDoc(browser, harness, 'snip');
    try {
      await d.frame.evaluate(() => window.scrollTo(0, 300));
      await settle(d.frame);
      await watchDom(d);
      const svg = await rectOf(d.frame, 'pre.mermaid svg');
      const pre = await rectOf(d.frame, 'pre.mermaid');
      const x0 = Math.round(svg.x + 30);
      const y0 = Math.round(svg.y + 10);
      const x1 = Math.round(svg.x + 200);
      const y1 = Math.round(svg.y + 70);
      await send(d.page, 'setTool', { tool: 'snip' });
      await settle(d.frame);
      let from = await mark(d.page);
      await drag(d, x0, y0, x1, y1);
      const act = await waitMsg(d.page, 'action', from, null, 10000);
      const c = act.capture;
      assert.deepEqual(c.srids, [9]);
      assert.equal(c.containerSrid, 9);
      assert.equal(c.text, '', 'mermaid text is diagram source (TEXT_EXCLUDE)');
      assert.equal(c.label, 'area in "2. Request flow" (mermaid diagram)');
      assert.ok(Math.abs(c.region.x - (x0 - pre.x) / pre.w) < 0.002, 'fractions of the <pre> border box');
      assert.ok(act.crop, 'svg content is rasterised too');
      const png = decodePng(act.crop);
      assert.ok(near(png.pixel(80 - 30, 30 - 10), [204, 221, 238], 16), `node fill: ${png.pixel(50, 20)}`);

      // Pick: shift-drag over the same diagram (an element capture with a region on the stamped <pre>).
      await send(d.page, 'setTool', { tool: 'pick' });
      await settle(d.frame);
      from = await mark(d.page);
      await d.page.keyboard.down('Shift');
      await drag(d, svg.x + 250, svg.y + 15, svg.x + 390, svg.y + 65);
      await d.page.keyboard.up('Shift');
      const pick = await waitMsg(d.page, 'action', from, null, 10000);
      assert.equal(pick.capture.srid, 9);
      await send(d.page, 'setTargets', { targets: [
        snipTarget('s1', c),
        { ...snipTarget('p1', { containerSrid: 9, region: pick.capture.region, label: pick.capture.label }) },
      ] });
      await settle(d.frame);
      const marks = (await inspect(d.frame)).layers.marks;
      const s1 = marks.find((/** @type {any} */ m) => m.key === 'region:s1');
      const p1 = marks.find((/** @type {any} */ m) => m.key === 'region:p1');
      assert.ok(Math.abs(s1.rect.x - x0) < 1.5 && Math.abs(s1.rect.y - y0) < 1.5 && Math.abs(s1.rect.width - (x1 - x0)) < 1.5,
        `snip region ${JSON.stringify(s1.rect)}`);
      assert.ok(Math.abs(p1.rect.x - (svg.x + 250)) < 1.5 && Math.abs(p1.rect.y - (svg.y + 15)) < 1.5 &&
        Math.abs(p1.rect.width - 140) < 1.5 && Math.abs(p1.rect.height - 50) < 1.5, `pick region ${JSON.stringify(p1.rect)}`);
      // The live diagram was never touched (the rasteriser only ever edits its own copy).
      assert.deepEqual(await d.frame.evaluate(() => /** @type {any} */ (window).__mutations), []);
    } finally {
      await d.close();
    }
  });

  test('crops match a screenshot of the same area, whatever element renders them', async () => {
    const d = await openDoc(browser, harness, 'snip');
    try {
      // One box per kind of render root: the paragraph's <section> (the box pokes out of the <p>), the bordered +
      // padded section, the figure, the img, the mermaid <pre>, and <html> (a box reaching into the page margin).
      const cases = /** @type {Array<[string, number, string]>} */ ([['p[data-srid="4"]', -3, 'section'],
        ['section', 30, 'section'], ['figure', 2, 'figure'], ['img', 40, 'img'], ['pre.mermaid', 6, 'pre'], ['h1', -8, 'html']]);
      for (const [sel, inset, want] of cases) {
        await d.frame.evaluate((s) => {
          const el = /** @type {Element} */ (document.querySelector(s));
          window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - 100));
        }, sel);
        await settle(d.frame);
        const r = await rectOf(d.frame, sel);
        const [x0, y0, x1, y1] = [r.x + inset, r.y + inset, r.x + r.w - inset, r.y + r.h - inset].map(Math.round);
        const { crop, shot } = await snipAndShoot(d, x0, y0, x1, y1);
        const diff = pixelDiff(crop, shot);
        const root = (await snipState(d)).lastCrop.root;
        assert.equal(root, want, `${sel}: rendered from <${root}>`);
        assert.ok(diff.mean < 1.5 && diff.bad < 0.003, `${sel} (root ${root}): ${JSON.stringify(diff)}`);
      }
    } finally {
      await d.close();
    }
  });

  test('a long document: only the area is rendered (blocks above it cut from the root), still pixel-exact', async () => {
    const d = await openDoc(browser, harness, 'shell');
    try {
      await d.frame.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = 'body{margin:8px;font:15px/22px Helvetica,Arial,sans-serif} h2{margin:24px 0 16px} ' +
          'p{margin:0 0 16px} blockquote{margin:0 0 16px;padding:0 1em;border-left:4px solid #ddd} ' +
          'img{display:block;width:120px;height:80px}';
        document.head.appendChild(style);
        const html = [];
        let n = 100;
        for (let i = 0; i < 400; i++) {
          if (i % 40 === 0) html.push(`<h2 data-srid="${n++}">Section ${i / 40}</h2>`);
          if (i % 37 === 0) html.push(`<blockquote data-srid="${n++}"><p data-srid="${n++}">Quoted ${i}.</p></blockquote>`);
          if (i % 90 === 0) html.push(`<figure data-srid="${n++}"><img data-srid="${n++}" src="/img/arch.png?i=${i}" alt="a"></figure>`);
          html.push(`<p data-srid="${n++}">Paragraph ${i} with <em data-srid="${n++}">emphasis</em> and <code>code</code>, ` +
            'long enough to wrap over two lines of the document column at this width, with a few more words.</p>');
        }
        /** @type {Element} */ (document.querySelector('article')).insertAdjacentHTML('beforeend', html.join(''));
        window.scrollTo(0, document.documentElement.scrollHeight * 0.8);
      });
      await settle(d.frame, 100);
      for (const [x0, x1] of [[20, 700], [2, 700]]) {
        const { act, crop, shot } = await snipAndShoot(d, x0, 150, x1, 480);
        const diff = pixelDiff(crop, shot);
        const info = (await snipState(d)).lastCrop;
        assert.ok(diff.mean < 1.5 && diff.bad < 0.003, `x0=${x0} (root ${info.root}): ${JSON.stringify(diff)}`);
        assert.ok(act.capture.srids.length >= 5, JSON.stringify(act.capture.srids));
        if (x0 === 20) {
          assert.equal(info.root, 'article', 'the box is inside the article: it alone is rendered');
          assert.ok(info.cut > 300, `blocks above the box left out of the clone: ${info.cut}`);
        } else {
          assert.equal(info.root, 'html', 'a box reaching into the page margin renders the whole page');
        }
      }
    } finally {
      await d.close();
    }
  });

  test('the box follows the page when it scrolls during the drag', async () => {
    const d = await openDoc(browser, harness, 'snip');
    try {
      await send(d.page, 'setTool', { tool: 'snip' });
      await settle(d.frame);
      const from = await mark(d.page);
      await d.page.mouse.move(100, 200);
      await d.page.mouse.down();
      await d.page.mouse.move(300, 250, { steps: 3 });
      await d.frame.evaluate(() => window.scrollBy({ top: 300, behavior: 'instant' }));
      await settle(d.frame);
      await d.page.mouse.move(300, 300, { steps: 2 });
      await d.page.mouse.up();
      const act = await waitMsg(d.page, 'action', from, null, 10000);
      assert.ok(Math.abs(act.rect.height - 400) <= 1, `doc box 200..600 is 400 px high: ${JSON.stringify(act.rect)}`);
      assert.ok(Math.abs(act.rect.y - -100) <= 1, 'viewport y when sent (scrolled by 300)');
      assert.ok(act.capture.srids.includes(6) && act.capture.srids.includes(8), JSON.stringify(act.capture.srids));
    } finally {
      await d.close();
    }
  });

  test('a document CSP that blocks data: images still gets the snip, without a crop', async () => {
    const d = await openDoc(browser, harness, 'csp');
    try {
      const p = await rectOf(d.frame, 'p[data-srid="3"]');
      await send(d.page, 'setTool', { tool: 'snip' });
      await settle(d.frame);
      const from = await mark(d.page);
      await drag(d, p.x, p.y - 2, p.x + 200, p.y + p.h + 2);
      const act = await waitMsg(d.page, 'action', from, null, 10000);
      assert.equal(act.capture.kind, 'snip');
      assert.deepEqual(act.capture.srids, [3]);
      assert.ok(act.capture.text.startsWith('The token service'), act.capture.text);
      assert.equal('crop' in act, false);
      const snip = await snipState(d);
      assert.equal(snip.lastCrop.ok, false);
      assert.ok(snip.lastCrop.error && snip.lastCrop.error !== 'timeout', snip.lastCrop.error);
      assert.deepEqual(await d.frame.evaluate(() => /** @type {any} */ (window).__suikoGuest.errors()), []);
    } finally {
      await d.close();
    }
  });
});
