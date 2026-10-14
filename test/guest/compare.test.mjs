// @ts-check
// Browser tests for comparing versions in the guest: the older version of a side-by-side comparison (changes with
// side 'old', painted from hunks[].oldSide), the placement of removed-content tabs, and the heading carried by
// scroll reports (which lines the two versions up). Run: node --test "test/guest/**/*.test.mjs"

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startHarness } from './server.mjs';
import { openDoc, send, mark, waitMsg, inspect, settle, rectOf } from './helpers.mjs';

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

/** @param {{x:number, y:number, width:number, height:number}} a @param {{x:number, y:number, w:number, h:number}} b */
function overlaps(a, b) {
  return a.x < b.x + b.w - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.height - 0.5;
}

/** A pure deletion right before the second item of the fixture's tight list (no margin between the items). */
const DELETION = {
  hunks: [{ id: 'h9', op: 'del', old: { start: 10, lines: 1 }, new: { start: 10, lines: 0 }, srids: [], words: [],
    deleted: { text: '- gone', html: null, lines: 1 }, insertBefore: { srid: 11 }, section: [], threads: ['t4'], other: null }],
};

describe('removed-content tabs', () => {
  test('between tight list items the tab goes after the next item\'s first line, never over the item before it', async () => {
    const d = await openDoc(browser, harness, 'prose', { initPayload: { mode: 'changes' } });
    try {
      const from = await mark(d.page);
      await send(d.page, 'setChanges', { changes: DELETION });
      await waitMsg(d.page, 'positions', from, (m) => typeof m.hunks.h9 === 'number');
      await settle(d.frame);
      const byKey = Object.fromEntries((await inspect(d.frame)).layers.changes.map((/** @type {any} */ x) => [x.key, x]));
      const prev = await rectOf(d.frame, '[data-srid="10"]');
      const next = await rectOf(d.frame, '[data-srid="11"]');
      assert.equal(byKey['tab:h9'].text, '⊖ 1 line removed');
      assert.ok(!overlaps(byKey['tab:h9'].rect, prev), 'the tab does not cover the item before the deletion');
      assert.ok(!overlaps(byKey['badge:h9:t:t4'].rect, prev), 'nor does its badge');
      assert.ok(byKey['tab:h9'].rect.y >= next.y - 1 && byKey['tab:h9'].rect.y < next.y + next.h, 'on the next item\'s line');
    } finally {
      await d.close();
    }
  });

  test('in a narrow column with no room after the line, the tab goes compact into the next item\'s corner', async () => {
    const d = await openDoc(browser, harness, 'prose', { initPayload: { mode: 'changes' } });
    try {
      // a narrow column (the harness frame is 900 px wide): the items' lines wrap and fill it
      await d.frame.evaluate(() => { /** @type {HTMLElement} */ (document.querySelector('[data-srid="9"]')).style.width = '190px'; });
      await settle(d.frame);
      const from = await mark(d.page);
      await send(d.page, 'setChanges', { changes: DELETION });
      await waitMsg(d.page, 'positions', from, (m) => typeof m.hunks.h9 === 'number');
      await settle(d.frame);
      const byKey = Object.fromEntries((await inspect(d.frame)).layers.changes.map((/** @type {any} */ x) => [x.key, x]));
      const prev = await rectOf(d.frame, '[data-srid="10"]');
      const next = await rectOf(d.frame, '[data-srid="11"]');
      const tab = byKey['tab:h9'];
      assert.ok(!overlaps(tab.rect, prev), 'the tab does not cover the item before the deletion');
      assert.ok(tab.rect.x >= next.x - 1 && tab.rect.x + tab.rect.width <= next.x + next.w + 1, 'inside the next item');
      assert.ok(tab.rect.y >= next.y - 1, 'from the next item\'s top');
      assert.match(tab.cls, /\bcompact\b/);
      assert.equal(tab.text, '⊖ 1');
    } finally {
      await d.close();
    }
  });
});

describe('the older version of a side-by-side comparison', () => {
  /** Changes 'prose' v1 -> v2, as the older version (v1, the fixture) receives them. */
  const OLD = {
    side: 'old',
    stats: { added: 3, removed: 2, hunks: 3, blocksChanged: 3 },
    hunks: [
      { id: 'h1', op: 'mod', old: { start: 14, lines: 1 }, new: { start: 14, lines: 1 }, srids: [99], words: [],
        deleted: { text: 'rotated on every use', html: null, lines: 1 }, insertBefore: null, section: [],
        threads: ['t1'], other: null,
        oldSide: { srids: [3], words: [{ srid: 3, quote: 'rotated on every use', prefix: 'Refresh tokens are ', suffix: ' and expire' }],
          insertBefore: null, insertAfter: null } },
      { id: 'h2', op: 'add', old: { start: 16, lines: 0 }, new: { start: 16, lines: 2 }, srids: [98], words: [],
        deleted: null, insertBefore: null, section: [], threads: [], other: 'Added a section',
        oldSide: { srids: [], words: [], insertBefore: { srid: 8 }, insertAfter: null } },
      { id: 'h3', op: 'del', old: { start: 20, lines: 1 }, new: { start: 20, lines: 0 }, srids: [], words: [],
        deleted: { text: '- Phase one ships to internal users.', html: null, lines: 1 }, insertBefore: { srid: 97 }, section: [],
        threads: [], other: null,
        oldSide: { srids: [10], words: [{ srid: 10, quote: 'Phase one ships to internal users.', prefix: '', suffix: '' }],
          insertBefore: null, insertAfter: null } },
    ],
  };

  test('removed words struck through (sr-del), red bars, an "added" tab, no thread badges and no popovers', async () => {
    const d = await openDoc(browser, harness, 'prose', { initPayload: { mode: 'readonly' } });
    try {
      const from = await mark(d.page);
      await send(d.page, 'setChanges', { changes: OLD });
      await waitMsg(d.page, 'positions', from, (m) => Object.keys(m.hunks).length === 3);
      await settle(d.frame);
      const ins = await inspect(d.frame);
      const byKey = Object.fromEntries(ins.layers.changes.map((/** @type {any} */ x) => [x.key, x]));
      assert.match(byKey['bar:h1:3'].cls, /\bdel\b/);
      assert.match(byKey['bar:h3:10'].cls, /\bdel\b/);
      assert.equal(byKey['tab:h2'].text, '⊕ 2 lines added');
      assert.match(byKey['tab:h2'].cls, /\badd\b/);
      // where the added lines go: just above the heading they come before (it has a margin)
      const h2 = await rectOf(d.frame, '[data-srid="8"]');
      assert.ok(byKey['tab:h2'].rect.y < h2.y && byKey['tab:h2'].rect.y > h2.y - 30);
      assert.deepEqual(Object.keys(byKey).filter((k) => k.startsWith('badge:')), [], 'no thread or "other" badges');
      assert.equal(ins.highlights['sr-del'], 2);
      assert.equal(ins.highlights['sr-ins'], 0);
      const del = await d.frame.evaluate(() => [.../** @type {any} */ (CSS).highlights.get('sr-del')].map((r) => r.toString()));
      assert.deepEqual(del, ['rotated on every use', 'Phase one ships to internal users.']);

      // the "added" tab is a note, not a button: clicking it opens nothing
      const tab = byKey['tab:h2'].rect;
      await d.page.mouse.click(tab.x + tab.width / 2, tab.y + tab.height / 2);
      await settle(d.frame, 60);
      assert.equal((await inspect(d.frame)).popover, null);

      // threads painted later do not wipe the removed words (the change highlights are the overlay's own)
      await send(d.page, 'setTargets', { targets: [{ id: 't5', num: 5, kind: 'text', state: 'open', srid: 6, quote: 'concurrent refreshes' }] });
      await settle(d.frame);
      assert.equal((await inspect(d.frame)).highlights['sr-del'], 2);

      // hidden annotations hide them too, and bring them back
      await send(d.page, 'setHidden', { hidden: true });
      await settle(d.frame);
      assert.equal((await inspect(d.frame)).highlights['sr-del'], 0);
      await send(d.page, 'setHidden', { hidden: false });
      await settle(d.frame);
      assert.equal((await inspect(d.frame)).highlights['sr-del'], 2);

      // scrollTo {hunk} finds the hunk in this version too
      const from2 = await mark(d.page);
      await send(d.page, 'scrollTo', { hunk: 'h3' });
      await waitMsg(d.page, 'positions', from2);

      // the newer version (no side) ignores oldSide and paints its own words
      await send(d.page, 'setChanges', { changes: { ...OLD, side: undefined } });
      await settle(d.frame);
      const back = await inspect(d.frame);
      assert.equal(back.highlights['sr-del'], 0);
      assert.ok(!back.layers.changes.some((/** @type {any} */ x) => /\bdel\b/.test(x.cls)));
    } finally {
      await d.close();
    }
  });

  test('a hunk without oldSide (an older daemon) draws nothing on the older version', async () => {
    const d = await openDoc(browser, harness, 'prose', { initPayload: { mode: 'readonly' } });
    try {
      await send(d.page, 'setChanges', { changes: { side: 'old', hunks: [{ id: 'h1', op: 'mod', srids: [3], words: [], deleted: null }] } });
      await settle(d.frame, 60);
      const ins = await inspect(d.frame);
      assert.equal(ins.layers.changes.length, 0);
      assert.equal(ins.highlights['sr-del'], 0);
    } finally {
      await d.close();
    }
  });
});

describe('scroll reports', () => {
  test('carry the headings around the reading line and the document edges, so another version can be lined up', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      let from = await mark(d.page);
      await send(d.page, 'scrollTo', { srid: 8, offset: -40 });
      let scroll = await waitMsg(d.page, 'scroll', from, (m) => !!m.heading && m.heading.srid === 8);
      assert.ok(Math.abs(scroll.heading.top - -40) <= 2, `the heading is 40 px above the top (${scroll.heading.top})`);
      assert.equal(scroll.next, null, 'no heading after "Rollout plan"');
      const height = await d.frame.evaluate(() => document.documentElement.scrollHeight);
      assert.ok(scroll.docTop < 0 && Math.abs(scroll.docEnd - scroll.docTop - height) <= 2, 'the document edges');

      // above the first heading: none at or above the reading line, the first one is next
      from = await mark(d.page);
      await d.frame.evaluate(() => window.scrollTo(0, 0));
      scroll = await waitMsg(d.page, 'scroll', from, (m) => m.heading === null && !!m.next && m.next.srid === 2);
      assert.ok(scroll.next.top > 8);
      assert.equal(scroll.docTop, 0);
    } finally {
      await d.close();
    }
  });

  test('scrollTo {sync}: the point a fraction of the way between two headings lands on the reading line', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      const top = (/** @type {number} */ srid) => d.frame.evaluate((x) => document.querySelector(`[data-srid="${x}"]`)?.getBoundingClientRect().top ?? NaN, srid);
      // halfway from the title (2) to "Rollout plan" (8)
      await send(d.page, 'scrollTo', { sync: { a: 2, b: 8, f: 0.5 } });
      await settle(d.frame);
      const a = await top(2);
      const b = await top(8);
      assert.ok(Math.abs((a + b) / 2 - 8) <= 2, `halfway point on the reading line (a ${a}, b ${b})`);
      // a = null: from the top of the document; f = 0 is the very top
      await send(d.page, 'scrollTo', { sync: { a: null, b: 2, f: 0 } });
      await settle(d.frame);
      assert.equal(await d.frame.evaluate(() => window.scrollY), 0);
      // b = null: towards the end of the document
      await send(d.page, 'scrollTo', { sync: { a: 8, b: null, f: 0 } });
      await settle(d.frame);
      assert.ok(Math.abs(await top(8) - 8) <= 2, 'the heading on the reading line');
    } finally {
      await d.close();
    }
  });

  test('scrollSync (side by side) is a guest preference; the keyboard preferences are kept', async () => {
    const d = await openDoc(browser, harness, 'prose', { initPayload: { prefs: { singleKeys: false, scrollSync: true } } });
    try {
      assert.deepEqual((await inspect(d.frame)).prefs, { singleKeys: false });
      await send(d.page, 'setPrefs', { scrollSync: false });
      assert.deepEqual((await inspect(d.frame)).prefs, { singleKeys: false });
      // with scrollSync on, reports come while the page scrolls, before it settles
      await send(d.page, 'setPrefs', { scrollSync: true });
      const from = await mark(d.page);
      await d.frame.evaluate(() => new Promise((resolve) => {
        let y = 0;
        const step = () => {
          y += 40;
          window.scrollTo(0, y);
          if (y < 800) setTimeout(step, 16);
          else resolve(undefined);
        };
        step();
      }));
      const reports = await d.page.evaluate((f) => /** @type {any} */ (window).__msgs.slice(f).filter((/** @type {any} */ m) => m.type === 'scroll').length, from);
      assert.ok(reports >= 3, `several scroll reports while scrolling (${reports})`);
    } finally {
      await d.close();
    }
  });
});
