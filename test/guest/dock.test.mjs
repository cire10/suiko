// @ts-check
// Browser tests for how the guest's drawing fits the reviewer UI around it:
//   - the room under the UI's tool dock: once the UI connects, an HTML document gets 72 px of empty room after its
//     content (so its last line scrolls clear of the dock), the Markdown shell none (its padding is that room), and
//     `positions` says whether the pointer is near the frame's bottom edge (pointerLow), where the dock floats;
//   - the overlay's colour language: thread pins and text highlights by whose turn the thread is, in the UI's hues
//     (light and dark), the UI's indigo accent for the pick box, and no GitHub (Primer) colours in the guest at all;
//   - the older version of a side-by-side comparison: a "⊕ N lines added" note never covers text (the left margin,
//     else a tick at the seam with the count in its tooltip).
// Run: node --test "test/guest/**/*.test.mjs"

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startHarness } from './server.mjs';
import { openDoc, send, mark, waitMsg, inspect, settle, rectOf } from './helpers.mjs';

const home = mkdtempSync(join(tmpdir(), 'sr-guest-home-'));
process.env.SPECREVIEW_HOME = home;
const GUEST_DIR = fileURLToPath(new URL('../../src/guest/', import.meta.url));

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

/** @param {{x:number, y:number, width:number, height:number}} a @param {{x:number, y:number, w:number, h:number}} b */
function overlaps(a, b) {
  return a.x < b.x + b.w - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.height - 0.5;
}

describe('room under the tool dock', () => {
  test('an HTML document gets 72 px after its content, so its last line can scroll clear of the dock', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      const ins = await inspect(d.frame);
      assert.deepEqual(ins.endRoom, { on: 'body', px: 72 });
      // scrolled to the end, the last line sits at least 72 px above the frame's bottom edge
      const gap = await d.frame.evaluate(() => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: /** @type {any} */ ('instant') });
        const last = /** @type {Element} */ (document.querySelector('[data-srid="30"]'));
        return window.innerHeight - last.getBoundingClientRect().bottom;
      });
      assert.ok(gap >= 72, `the last line clears the dock (${gap} px under it)`);
      // the document itself gained no node
      assert.equal(await d.frame.evaluate(() => document.body.lastElementChild?.localName), 'script');
    } finally {
      await d.close();
    }
  });

  test('a flex body gets the room on <html>; the Markdown shell gets none (its padding is the room)', async () => {
    const shell = await openDoc(browser, harness, 'shell');
    try {
      assert.equal((await inspect(shell.frame)).endRoom, null);
      assert.equal(await shell.frame.evaluate(() => document.adoptedStyleSheets.some((s) => [...s.cssRules].some((r) => /::after/.test(r.cssText)))), false);
    } finally {
      await shell.close();
    }
    const flex = await openDoc(browser, harness, 'prose', { initScript: () => {
      document.addEventListener('DOMContentLoaded', () => { document.body.style.display = 'flex'; document.body.style.flexDirection = 'column'; });
    } });
    try {
      assert.deepEqual((await inspect(flex.frame)).endRoom, { on: 'html', px: 72 });
    } finally {
      await flex.close();
    }
  });

  test('positions say when the pointer comes near the bottom edge, and when it leaves the frame', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      let from = await mark(d.page);
      await d.page.mouse.move(450, 300);
      await d.page.mouse.move(450, 660, { steps: 4 }); // the frame is 700 px tall: within 120 px of its bottom
      let pos = await waitMsg(d.page, 'positions', from, (m) => m.pointerLow === true);
      assert.equal(pos.pointerLow, true);
      assert.equal((await inspect(d.frame)).pointerLow, true);
      from = await mark(d.page);
      await d.page.mouse.move(450, 300, { steps: 4 });
      pos = await waitMsg(d.page, 'positions', from, (m) => m.pointerLow === false);
      assert.equal(pos.pointerLow, false);
      // near the bottom again, then out of the frame (onto the UI)
      await d.page.mouse.move(450, 660, { steps: 4 });
      await waitMsg(d.page, 'positions', from, (m) => m.pointerLow === true);
      from = await mark(d.page);
      await d.page.mouse.move(950, 660, { steps: 4 });
      pos = await waitMsg(d.page, 'positions', from, (m) => m.pointerLow === false);
      assert.equal(pos.pointerLow, false);
    } finally {
      await d.close();
    }
  });
});

describe('the UI\'s colour language', () => {
  /** One thread per turn, all on visible text of the 'prose' fixture. */
  const TURNS = [
    { id: 't1', num: 1, kind: 'text', state: 'open', srid: 3, quote: 'Refresh tokens are' },
    { id: 't2', num: 2, kind: 'text', state: 'addressed', srid: 6, quote: 'grace window' },
    { id: 't3', num: 3, kind: 'text', state: 'needs_input', srid: 25, quote: 'Rotated tokens are logged' },
    { id: 't4', num: 4, kind: 'text', state: 'planned', srid: 10, quote: 'Phase one ships' },
    { id: 't5', num: 5, kind: 'text', state: 'outdated', srid: 11, quote: 'Phase two ships' },
    { id: 'd1', num: 6, kind: 'text', state: 'draft', srid: 2, quote: 'Token Service' },
    { id: 't6', num: 7, kind: 'text', state: 'declined', srid: 8, quote: 'Rollout plan' },
  ];
  /** Pin fill per thread, as the UI's chips colour them (tokens.css): light, then dark. */
  const LIGHT = {
    t1: 'rgb(79, 70, 229)', t2: 'rgb(26, 127, 55)', t3: 'rgb(188, 76, 0)', t4: 'rgb(130, 80, 223)', t5: 'rgb(107, 107, 117)',
    d1: 'rgb(224, 231, 255)', t6: 'rgb(154, 103, 0)',
  };
  const DARK = {
    t1: 'rgb(129, 140, 248)', t2: 'rgb(63, 185, 80)', t3: 'rgb(219, 109, 40)', t4: 'rgb(171, 125, 248)', t5: 'rgb(138, 138, 149)',
    d1: 'rgb(43, 42, 82)', t6: 'rgb(210, 153, 34)',
  };

  /** @param {any} ins */
  const pinFills = (ins) => Object.fromEntries(ins.layers.pins.map((/** @type {any} */ p) => [p.key.slice(4), p.bg]));

  test('pins and text highlights say whose turn a thread is, like its card\'s chip, in light and dark', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      await send(d.page, 'setTargets', { targets: TURNS });
      await settle(d.frame);
      let ins = await inspect(d.frame);
      assert.deepEqual(pinFills(ins), LIGHT);
      const tones = Object.fromEntries(ins.layers.pins.map((/** @type {any} */ p) => [p.key.slice(4), /\bst-(\w+)/.exec(p.cls)?.[1]]));
      // t6: the agent did not change it: amber, like the "Claude didn't change it" chip (not the green of "check it")
      assert.deepEqual(tones, { t1: 'with', t2: 'check', t3: 'answer', t4: 'planned', t5: 'lost', d1: 'draft', t6: 'declined' });
      const hl = await d.frame.evaluate(() => {
        /** @type {Record<string, string[]>} */
        const out = {};
        for (const [name, h] of /** @type {any} */ (CSS).highlights) out[name] = [...h].map((/** @type {Range} */ r) => r.toString());
        return out;
      });
      assert.deepEqual(hl['sr-open'], ['Refresh tokens are']);
      assert.deepEqual(hl['sr-check'], ['grace window']);
      assert.deepEqual(hl['sr-answer'], ['Rotated tokens are logged']);
      assert.deepEqual(hl['sr-planned'], ['Phase one ships']);
      assert.deepEqual(hl['sr-outdated'], ['Phase two ships']);
      assert.deepEqual(hl['sr-draft'], ['Token Service']);
      assert.deepEqual(hl['sr-declined'], ['Rollout plan']);

      // the selected thread keeps its colour and gets the accent's ring
      await send(d.page, 'focus', { id: 't2' });
      await settle(d.frame);
      ins = await inspect(d.frame);
      const t2 = ins.layers.pins.find((/** @type {any} */ p) => p.key === 'pin:t2');
      assert.match(t2.cls, /\bst-check\b.*\bactive\b/);
      assert.equal(t2.bg, LIGHT.t2);

      // the dark theme: the same meanings in the UI's dark hues
      await send(d.page, 'setTheme', { theme: 'dark' });
      await settle(d.frame);
      assert.deepEqual(pinFills(await inspect(d.frame)), DARK);
    } finally {
      await d.close();
    }
  });

  test('the pick box and its label chip use the UI\'s accent', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      await send(d.page, 'setTool', { tool: 'pick' });
      await settle(d.frame);
      const h1 = await rectOf(d.frame, '[data-srid="2"]');
      await d.page.mouse.move(h1.x + 20, h1.y + h1.h / 2);
      await settle(d.frame, 60);
      // the overlay's shadow root is closed: its colours are read through inspect()
      const ins = await inspect(d.frame);
      assert.ok(ins.pickBox, 'a pick box is drawn');
      assert.equal(ins.pickBox.border, 'rgb(79, 70, 229)');
      assert.equal(ins.pickBox.chipBg, 'rgb(79, 70, 229)');
    } finally {
      await d.close();
    }
  });

  test('no GitHub (Primer) colours are left in the guest', () => {
    const PRIMER = ['#0969da', '#1f6feb', '#1f2328', '#4493f8', '#e16f24', '#fb8500', '#2da44e', '#cf222e', '#8c959f'];
    for (const f of readdirSync(GUEST_DIR).filter((x) => x.endsWith('.js'))) {
      const src = readFileSync(join(GUEST_DIR, f), 'utf8').toLowerCase();
      for (const c of PRIMER) assert.ok(!src.includes(c), `${f} still uses ${c}`);
    }
  });
});

describe('the older version of a side-by-side comparison: "lines added" notes', () => {
  /** Two lines added before the second item of the fixture's tight list (no margin between the items). */
  const ADDED = {
    side: 'old',
    hunks: [{ id: 'h7', op: 'add', old: { start: 19, lines: 0 }, new: { start: 19, lines: 2 }, srids: [99], words: [],
      deleted: null, insertBefore: null, section: [], threads: [], other: null,
      oldSide: { srids: [], words: [], insertBefore: { srid: 11 }, insertAfter: null } }],
  };

  /** Makes both list items full lines in a narrow column (no room after their first line). @param {any} frame @param {string} ulMargin */
  const narrowList = (frame, ulMargin) => frame.evaluate((m) => {
    const ul = /** @type {HTMLElement} */ (document.querySelector('[data-srid="9"]'));
    ul.style.width = '170px';
    ul.style.marginLeft = m;
    for (const li of ul.querySelectorAll('li')) li.textContent += ' More words so that every line is full of text here.';
  }, ulMargin);

  test('with no room above or after the first line, the note goes into the left margin, never over text', async () => {
    const d = await openDoc(browser, harness, 'prose', { initPayload: { mode: 'readonly' } });
    try {
      await narrowList(d.frame, '0px');
      await settle(d.frame);
      const from = await mark(d.page);
      await send(d.page, 'setChanges', { changes: ADDED });
      await waitMsg(d.page, 'positions', from, (m) => typeof m.hunks.h7 === 'number');
      await settle(d.frame);
      const tab = (await inspect(d.frame)).layers.changes.find((/** @type {any} */ x) => x.key === 'tab:h7');
      const li = await rectOf(d.frame, '[data-srid="11"]');
      const ul = await rectOf(d.frame, '[data-srid="9"]');
      assert.match(tab.cls, /\bcompact\b/);
      assert.equal(tab.text, '⊕ 2');
      assert.ok(tab.rect.x + tab.rect.width <= ul.x, 'left of the list, in the margin');
      assert.ok(!overlaps(tab.rect, li), 'never over the item\'s text');
      assert.ok(Math.abs(tab.rect.y - li.y) <= 3, 'at the item the lines come before');
    } finally {
      await d.close();
    }
  });

  test('with no margin either, it is a tick at the seam with the count in its tooltip', async () => {
    const d = await openDoc(browser, harness, 'prose', { initPayload: { mode: 'readonly' } });
    try {
      await narrowList(d.frame, '-56px'); // the list starts at the frame's left edge
      await settle(d.frame);
      const from = await mark(d.page);
      await send(d.page, 'setChanges', { changes: ADDED });
      await waitMsg(d.page, 'positions', from, (m) => typeof m.hunks.h7 === 'number');
      await settle(d.frame);
      const tab = (await inspect(d.frame)).layers.changes.find((/** @type {any} */ x) => x.key === 'tab:h7');
      const li = await rectOf(d.frame, '[data-srid="11"]');
      const vw = await d.frame.evaluate(() => document.documentElement.clientWidth);
      assert.match(tab.cls, /\btick\b/);
      assert.equal(tab.text, '');
      assert.match(tab.title, /2 lines added here in the newer version/);
      assert.ok(tab.rect.x >= vw - 10, 'at the frame\'s inner edge');
      assert.ok(!overlaps(tab.rect, li), 'never over the item\'s text');
    } finally {
      await d.close();
    }
  });
});
