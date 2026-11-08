// @ts-check
// Browser tests for the guest's keyboard handling (src/guest/85-keys.js): the app-level combos Mod+K (command
// palette), Mod+, (settings) and Mod+/ (keyboard shortcuts), forwarded from anywhere in the doc and default-prevented
// unless the page claims them, the single-key preference (setPrefs / init.prefs {singleKeys}), and a page that
// handles keys itself (07-page.js PageKeys: its single keys stay its own) or a widget that takes keys.
// Driven through the two-origin harness in server.mjs with system Chrome (playwright-core, channel 'chrome').
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

/** CDP modifier bits (Input.dispatchKeyEvent). */
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

/** The UI-visible part of forwarded `key` messages. @param {any[]} msgs */
const keysOf = (msgs) => msgs.map((k) => ({ key: k.key, meta: k.meta, ctrl: k.ctrl, shift: k.shift, alt: k.alt }));

/**
 * Records every keydown that reaches the doc's window (key, code, modifiers and, once dispatch is over, whether its
 * default was prevented) on window.__seen. Modifier-only keydowns are skipped.
 * @param {import('playwright-core').Frame} frame
 */
async function watchKeys(frame) {
  await frame.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__seen = [];
    window.addEventListener('keydown', (e) => {
      if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return;
      setTimeout(() => w.__seen.push({ key: e.key, code: e.code, meta: e.metaKey, ctrl: e.ctrlKey, prevented: e.defaultPrevented }));
    }, true);
  });
}

/** @param {import('playwright-core').Frame} frame @returns {Promise<any[]>} */
const seen = (frame) => frame.evaluate(() => /** @type {any} */ (window).__seen.splice(0));

/**
 * A trusted keydown + keyup with an arbitrary key / code pair (what a non-US layout produces), via CDP.
 * @param {import('playwright-core').CDPSession} cdp
 * @param {{ key: string, code: string, vk: number, modifiers: number, autoRepeat?: boolean }} k
 */
async function rawKey(cdp, k) {
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers: k.modifiers };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, autoRepeat: !!k.autoRepeat });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

describe('app-level shortcuts (Mod+K, Mod+, Mod+/)', () => {
  test('are forwarded with their modifiers and default-prevented, also with focus in a doc <input>', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      await watchKeys(d.frame);
      await d.page.mouse.click(700, 690); // focus the doc body
      let from = await mark(d.page);
      await d.page.keyboard.press('Meta+k');
      await d.page.keyboard.press('Control+Comma');
      await d.page.keyboard.press('Meta+Slash');
      await d.page.keyboard.press('Control+k');
      await d.page.keyboard.press('Meta+Shift+K');
      await waitMsg(d.page, 'key', from, (m) => m.key === 'K');
      assert.deepEqual(keysOf(await msgsOf(d.page, 'key', from)), [
        { key: 'k', meta: true, ctrl: false, shift: false, alt: false },
        { key: ',', meta: false, ctrl: true, shift: false, alt: false },
        { key: '/', meta: true, ctrl: false, shift: false, alt: false },
        { key: 'k', meta: false, ctrl: true, shift: false, alt: false },
        { key: 'K', meta: true, ctrl: false, shift: true, alt: false },
      ]);
      await settle(d.frame, 50);
      assert.ok((await seen(d.frame)).every((e) => e.prevented), 'every combo is default-prevented');

      // Other modifier combos are left alone: neither forwarded nor prevented (Ctrl+Alt is AltGr on Windows).
      from = await mark(d.page);
      await d.page.keyboard.press('Meta+b');
      await d.page.keyboard.press('Control+j');
      await d.page.keyboard.press('Control+Alt+k');
      await d.page.keyboard.press('Meta+Shift+Slash'); // Cmd+? (macOS Help menu)
      await settle(d.frame, 100);
      assert.deepEqual(await msgsOf(d.page, 'key', from), []);
      assert.deepEqual((await seen(d.frame)).map((e) => [e.key, e.prevented]),
        [['b', false], ['j', false], ['k', false], ['?', false]]);

      // In an editable element of the doc: the combos are global, the field keeps its text, plain keys stay local.
      const input = await rectOf(d.frame, '#name');
      await d.page.mouse.click(input.cx, input.cy);
      from = await mark(d.page);
      await d.page.keyboard.type('xy');
      await d.page.keyboard.press('Meta+k');
      await d.page.keyboard.press('Control+Slash');
      await d.page.keyboard.press('Meta+Comma');
      await d.page.keyboard.type('w');
      await waitMsg(d.page, 'key', from, (m) => m.key === ',');
      await settle(d.frame, 50);
      assert.deepEqual(keysOf(await msgsOf(d.page, 'key', from)), [
        { key: 'k', meta: true, ctrl: false, shift: false, alt: false },
        { key: '/', meta: false, ctrl: true, shift: false, alt: false },
        { key: ',', meta: true, ctrl: false, shift: false, alt: false },
      ]);
      assert.equal(await d.frame.evaluate(() => /** @type {HTMLInputElement} */ (document.getElementById('name')).value), 'xyw');
      assert.equal(await d.frame.evaluate(() => document.activeElement && document.activeElement.id), 'name');
      assert.deepEqual((await seen(d.frame)).map((e) => [e.key, e.prevented]),
        [['x', false], ['y', false], ['k', true], ['/', true], [',', true], ['w', false]]);
    } finally {
      await d.close();
    }
  });

  test('non-Latin layouts match by physical key; Latin characters are never taken by physical key', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      await watchKeys(d.frame);
      await d.page.mouse.click(700, 690);
      const cdp = await d.context.newCDPSession(d.page);
      const from = await mark(d.page);
      await rawKey(cdp, { key: 'л', code: 'KeyK', vk: 75, modifiers: MOD.meta }); // Russian: Cmd+K
      await rawKey(cdp, { key: 'б', code: 'Comma', vk: 188, modifiers: MOD.ctrl }); // Russian: Ctrl+,
      await rawKey(cdp, { key: '-', code: 'Slash', vk: 189, modifiers: MOD.meta }); // German: Cmd+- (zoom out)
      await rawKey(cdp, { key: '/', code: 'Digit7', vk: 55, modifiers: MOD.ctrl | MOD.alt }); // AltGr+7 typing '/'
      await rawKey(cdp, { key: 'k', code: 'KeyK', vk: 75, modifiers: MOD.meta, autoRepeat: true }); // held Cmd+K
      await waitMsg(d.page, 'key', from, (m) => m.key === ',');
      await settle(d.frame, 100);
      assert.deepEqual(keysOf(await msgsOf(d.page, 'key', from)), [
        { key: 'k', meta: true, ctrl: false, shift: false, alt: false },
        { key: ',', meta: false, ctrl: true, shift: false, alt: false },
      ]);
      assert.deepEqual((await seen(d.frame)).map((e) => [e.key, e.code, e.prevented]), [
        ['л', 'KeyK', true],
        ['б', 'Comma', true],
        ['-', 'Slash', false],
        ['/', 'Digit7', false],
        ['k', 'KeyK', true], // an auto-repeat is default-prevented but not forwarded again
      ]);
    } finally {
      await d.close();
    }
  });

  test('the page keeps a combo it handles, even from a window listener added after the guest started', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      await d.frame.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.__pageK = 0;
        w.__stops = 1;
        // Registered after load, so after every guest listener: it still runs before the guest decides.
        window.addEventListener('keydown', (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
            e.preventDefault();
            w.__pageK++;
          }
        });
        // Stops propagation of the first Ctrl+, (without preventing it): the page claimed that one.
        document.addEventListener('keydown', (e) => {
          if (e.key === ',' && w.__stops > 0) {
            w.__stops--;
            e.stopPropagation();
          }
        });
      });
      await watchKeys(d.frame);
      await d.page.mouse.click(700, 690);
      const from = await mark(d.page);
      await d.page.keyboard.press('Meta+k');
      await d.page.keyboard.press('Control+Comma');
      await d.page.keyboard.press('Control+Comma');
      await d.page.keyboard.press('Meta+Slash');
      await waitMsg(d.page, 'key', from, (m) => m.key === '/');
      await settle(d.frame, 100);
      assert.equal(await d.frame.evaluate(() => /** @type {any} */ (window).__pageK), 1);
      assert.deepEqual(keysOf(await msgsOf(d.page, 'key', from)), [
        { key: ',', meta: false, ctrl: true, shift: false, alt: false },
        { key: '/', meta: true, ctrl: false, shift: false, alt: false },
      ]);
      assert.deepEqual((await seen(d.frame)).map((e) => [e.key, e.prevented]),
        [['k', true], [',', false], [',', true], ['/', true]]);
    } finally {
      await d.close();
    }
  });

  test('untrusted (script-dispatched) combos are never forwarded nor prevented', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      const from = await mark(d.page);
      const prevented = await d.frame.evaluate(() => {
        const out = [];
        const input = /** @type {HTMLInputElement} */ (document.getElementById('name'));
        for (const target of [document.body, input]) {
          for (const init of [{ key: 'k', metaKey: true }, { key: ',', ctrlKey: true }, { key: '/', metaKey: true },
            { key: 'л', code: 'KeyK', ctrlKey: true }]) {
            const ev = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
            target.dispatchEvent(ev);
            out.push(ev.defaultPrevented);
          }
        }
        return out;
      });
      await settle(d.frame, 100);
      assert.ok(prevented.every((p) => p === false));
      assert.deepEqual(await msgsOf(d.page, 'key', from), []);
    } finally {
      await d.close();
    }
  });

  test('are forwarded in readonly mode and during pick / snip mode; never taken without a connected UI', async () => {
    const d = await openDoc(browser, harness, 'prose', { initPayload: { mode: 'readonly' } });
    try {
      await d.page.mouse.click(700, 690);
      let from = await mark(d.page);
      await d.page.keyboard.press('Meta+k');
      await waitMsg(d.page, 'key', from, (m) => m.key === 'k' && m.meta);

      await send(d.page, 'init', { mode: 'review', theme: 'light', targets: [], changes: null, activeId: null, hidden: false });
      for (const tool of ['snip', 'pick']) {
        await send(d.page, 'setTool', { tool });
        await settle(d.frame);
        assert.equal((await inspect(d.frame))[tool === 'snip' ? 'snip' : 'picker'].active, true);
        from = await mark(d.page);
        await d.page.keyboard.press('Control+Slash');
        await waitMsg(d.page, 'key', from, (m) => m.key === '/' && m.ctrl);
        assert.equal((await inspect(d.frame))[tool === 'snip' ? 'snip' : 'picker'].active, true, `${tool} mode stays on`);
        assert.deepEqual(await msgsOf(d.page, 'toolChanged', from), []);
      }
    } finally {
      await d.close();
    }

    // The doc opened on its own (not framed by the UI): the guest never connects, so it leaves the combos alone.
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    try {
      const page = await context.newPage();
      await page.goto(harness.docUrl('prose'));
      await page.waitForFunction(() => !!(/** @type {any} */ (window).__suikoGuest));
      await watchKeys(page.mainFrame());
      await page.mouse.click(700, 690);
      await page.keyboard.press('Meta+k');
      await page.keyboard.press('Control+Comma');
      await settle(page.mainFrame(), 50);
      assert.deepEqual((await seen(page.mainFrame())).map((e) => [e.key, e.prevented]), [['k', false], [',', false]]);
    } finally {
      await context.close();
    }
  });
});

describe('single-key shortcuts preference (setPrefs / init.prefs)', () => {
  test('setPrefs singleKeys:false forwards c / s / q / a and b as keys; the toolbar and setTool keep working', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      assert.deepEqual((await inspect(d.frame)).prefs, { singleKeys: true }, 'default');
      await d.page.mouse.click(700, 690); // focus the doc body
      await send(d.page, 'setPrefs', { singleKeys: false });
      await settle(d.frame);
      assert.deepEqual((await inspect(d.frame)).prefs, { singleKeys: false });

      let from = await mark(d.page);
      await selectText(d.frame, 4, 'rotated on every use');
      const sel = await waitMsg(d.page, 'selection', from, (m) => !!m.capture);
      from = await mark(d.page);
      for (const k of ['c', 's', 'q', 'a', 'b']) await d.page.keyboard.press(k);
      await waitMsg(d.page, 'key', from, (m) => m.key === 'b');
      await settle(d.frame, 100);
      assert.deepEqual((await msgsOf(d.page, 'key', from)).map((/** @type {any} */ k) => k.key), ['c', 's', 'q', 'a', 'b']);
      assert.deepEqual(await msgsOf(d.page, 'action', from), []);
      assert.deepEqual(await msgsOf(d.page, 'toolChanged', from), []);
      let ins = await inspect(d.frame);
      assert.equal(ins.snip.active, false);
      assert.ok(ins.toolbar, 'the mini-toolbar is still shown for the selection');

      // The mini-toolbar still posts actions.
      const btn = ins.toolbar.buttons.find((/** @type {any} */ x) => x.action === 'comment');
      from = await mark(d.page);
      await d.page.mouse.click(btn.rect.x + btn.rect.width / 2, btn.rect.y + btn.rect.height / 2);
      const act = await waitMsg(d.page, 'action', from);
      assert.equal(act.action, 'comment');
      assert.deepEqual(act.capture, sel.capture);

      // Snip mode started from the UI still works, and Esc still leaves it.
      await send(d.page, 'setTool', { tool: 'snip' });
      await settle(d.frame);
      assert.equal((await inspect(d.frame)).snip.active, true);
      from = await mark(d.page);
      await d.page.keyboard.press('Escape');
      await waitMsg(d.page, 'toolChanged', from, (m) => m.tool === 'select');
      assert.equal((await inspect(d.frame)).snip.active, false);

      // A setPrefs without the field changes nothing; singleKeys:true restores the guest's own handling.
      await send(d.page, 'setPrefs', {});
      await send(d.page, 'setPrefs', { singleKeys: 'no' });
      await settle(d.frame);
      assert.deepEqual((await inspect(d.frame)).prefs, { singleKeys: false });
      await send(d.page, 'setPrefs', { singleKeys: true });
      await d.page.mouse.click(700, 690);
      from = await mark(d.page);
      await selectText(d.frame, 6, 'grace window');
      await waitMsg(d.page, 'selection', from, (m) => !!m.capture);
      from = await mark(d.page);
      await d.page.keyboard.press('q');
      assert.equal((await waitMsg(d.page, 'action', from)).action, 'question');
      await d.page.keyboard.press('b');
      await waitMsg(d.page, 'toolChanged', from, (m) => m.tool === 'snip');
      await settle(d.frame, 100);
      assert.deepEqual(await msgsOf(d.page, 'key', from), []);
      ins = await inspect(d.frame);
      assert.equal(ins.snip.active, true);
    } finally {
      await d.close();
    }
  });

  test('init prefs are honoured, and an init without prefs keeps the current ones', async () => {
    const d = await openDoc(browser, harness, 'prose', { initPayload: { prefs: { singleKeys: false } } });
    try {
      assert.deepEqual((await inspect(d.frame)).prefs, { singleKeys: false });
      await d.page.mouse.click(700, 690);
      let from = await mark(d.page);
      await d.page.keyboard.press('b');
      await waitMsg(d.page, 'key', from, (m) => m.key === 'b');

      await send(d.page, 'init', { mode: 'review', theme: 'light', targets: [], changes: null, activeId: null, hidden: false });
      await settle(d.frame);
      from = await mark(d.page);
      await d.page.keyboard.press('b');
      await waitMsg(d.page, 'key', from, (m) => m.key === 'b');
      assert.deepEqual(await msgsOf(d.page, 'toolChanged', from), []);

      await send(d.page, 'init', { mode: 'review', theme: 'light', targets: [], changes: null, activeId: null, hidden: false,
        prefs: { singleKeys: true } });
      await settle(d.frame);
      from = await mark(d.page);
      await d.page.keyboard.press('b');
      await waitMsg(d.page, 'toolChanged', from, (m) => m.tool === 'snip');
      await settle(d.frame, 100);
      assert.deepEqual(await msgsOf(d.page, 'key', from), []);
    } finally {
      await d.close();
    }
  });
});

describe('a page that handles keys itself', () => {
  test('keeps its single keys; Escape, Cmd+Enter, the app combos and the selection actions still reach Suiko', async () => {
    const d = await openDoc(browser, harness, 'keyed');
    try {
      assert.equal((await inspect(d.frame)).pageKeys, true, 'the page added a keydown listener to document');
      await d.page.mouse.click(700, 690); // focus the doc body
      let from = await mark(d.page);
      // r is the page's own shortcut; j, 3, f, e, b, Shift+B would drive Suiko from a page without key handlers
      for (const k of ['r', 'j', '3', 'f', 'e', 'b', 'Shift+B']) await d.page.keyboard.press(k);
      await settle(d.frame, 120);
      assert.deepEqual(await msgsOf(d.page, 'key', from), [], 'no single key reaches Suiko');
      assert.deepEqual(await msgsOf(d.page, 'toolChanged', from), [], 'b does not snip');
      assert.equal((await inspect(d.frame)).snip.active, false);
      assert.equal(await d.frame.evaluate(() => /** @type {any} */ (window).__resets), 1, 'the page got its r');

      // Escape, Cmd+Enter and Cmd+Shift+Enter, and the app combos still do
      from = await mark(d.page);
      await d.page.keyboard.press('Escape');
      await d.page.keyboard.press('Meta+Enter');
      await d.page.keyboard.press('Control+Shift+Enter');
      await d.page.keyboard.press('Meta+k');
      await waitMsg(d.page, 'key', from, (m) => m.key === 'k');
      await settle(d.frame, 60);
      assert.deepEqual(keysOf(await msgsOf(d.page, 'key', from)), [
        { key: 'Escape', meta: false, ctrl: false, shift: false, alt: false },
        { key: 'Enter', meta: true, ctrl: false, shift: false, alt: false },
        { key: 'Enter', meta: false, ctrl: true, shift: true, alt: false },
        { key: 'k', meta: true, ctrl: false, shift: false, alt: false },
      ]);

      // an Escape the page uses (closing its own modal) stays with the page
      await d.frame.evaluate(() => { /** @type {any} */ (window).__modal = true; });
      from = await mark(d.page);
      await d.page.keyboard.press('Escape');
      await settle(d.frame, 100);
      assert.deepEqual(await msgsOf(d.page, 'key', from), []);

      // c / s / q / a with a selection are still the selection actions; without one, c stays with the page
      from = await mark(d.page);
      await selectText(d.frame, 4, 'seat price');
      await waitMsg(d.page, 'selection', from, (m) => !!m.capture);
      from = await mark(d.page);
      await d.page.keyboard.press('c');
      assert.equal((await waitMsg(d.page, 'action', from)).action, 'comment');
      await send(d.page, 'clearSelection');
      await waitMsg(d.page, 'selection', from, (m) => m.capture === null);
      from = await mark(d.page);
      await d.page.keyboard.press('c');
      await settle(d.frame, 100);
      assert.deepEqual(await msgsOf(d.page, 'key', from), []);
      assert.deepEqual(await msgsOf(d.page, 'action', from), []);
    } finally {
      await d.close();
    }
  });

  test('the first single key the page keeps is reported once per load (keyKept); combos, space and single keys off never', async () => {
    const d = await openDoc(browser, harness, 'keyed');
    try {
      await d.page.mouse.click(700, 690); // focus the doc body
      // single keys off: nothing to explain (Suiko would not act on them anyway)
      await send(d.page, 'setPrefs', { singleKeys: false });
      let from = await mark(d.page);
      await d.page.keyboard.press('b');
      await settle(d.frame, 120);
      assert.deepEqual(await msgsOf(d.page, 'keyKept', from), []);

      await send(d.page, 'setPrefs', { singleKeys: true });
      from = await mark(d.page);
      await d.page.keyboard.press('Space');
      await d.page.keyboard.press('Alt+j');
      await settle(d.frame, 120);
      assert.deepEqual(await msgsOf(d.page, 'keyKept', from), [], 'not for the space bar or a combo');
      for (const k of ['e', 'b', 'j']) await d.page.keyboard.press(k);
      await settle(d.frame, 150);
      const kept = await msgsOf(d.page, 'keyKept', from);
      assert.equal(kept.length, 1, 'once per page load');
      assert.equal(kept[0].key, 'e');
      assert.deepEqual(await msgsOf(d.page, 'key', from), [], 'the keys themselves still stay with the page');
    } finally {
      await d.close();
    }
  });

  test('a page without key handlers never reports keyKept', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      await d.page.mouse.click(700, 690);
      const from = await mark(d.page);
      await d.page.keyboard.press('j');
      await waitMsg(d.page, 'key', from, (m) => m.key === 'j');
      await settle(d.frame, 100);
      assert.deepEqual(await msgsOf(d.page, 'keyKept', from), []);
    } finally {
      await d.close();
    }
  });

  test('handlers added later, on<key> properties and listeners on the key\'s path count; the guest\'s own never do', async () => {
    const d = await openDoc(browser, harness, 'prose');
    try {
      assert.equal((await inspect(d.frame)).pageKeys, false);
      await d.page.mouse.click(700, 690);
      /** Presses j and says whether it reached Suiko. */
      const jForwarded = async () => {
        const from = await mark(d.page);
        await d.page.keyboard.press('j');
        await settle(d.frame, 100);
        return (await msgsOf(d.page, 'key', from)).length === 1;
      };
      assert.equal(await jForwarded(), true);

      // an on<key> handler property of window / document / <html> / <body>, while it is set
      await d.frame.evaluate(() => { window.onkeyup = () => {}; });
      assert.equal(await jForwarded(), false);
      assert.equal((await inspect(d.frame)).pageKeys, true);
      await d.frame.evaluate(() => { window.onkeyup = null; });
      assert.equal(await jForwarded(), true);

      // a listener on an element the key passes through (a focusable paragraph of the doc), not elsewhere
      await d.frame.evaluate(() => {
        const p = /** @type {HTMLElement} */ (document.getElementById('clicks'));
        p.tabIndex = -1;
        p.addEventListener('keydown', () => {});
        p.focus();
      });
      assert.equal(await jForwarded(), false);
      await d.page.mouse.click(700, 690); // back to the body: the paragraph's listener is not on the path
      assert.equal(await jForwarded(), true);

      // a listener added to the document later (after load) counts from then on
      await d.frame.evaluate(() => document.body.addEventListener('keypress', () => {}));
      assert.equal(await jForwarded(), false);
      assert.equal((await inspect(d.frame)).pageKeys, true);
    } finally {
      await d.close();
    }
  });

  test('keys typed into a widget (a listbox, a checkbox, an ARIA tab) stay with it', async () => {
    const d = await openDoc(browser, harness, 'keyed');
    try {
      // a widget keeps even Escape
      await d.frame.focus('#plans');
      let from = await mark(d.page);
      await d.page.keyboard.press('b'); // typeahead: Business
      await d.page.keyboard.press('Escape');
      await settle(d.frame, 100);
      assert.deepEqual(await msgsOf(d.page, 'key', from), []);
      assert.equal(await d.frame.evaluate(() => document.querySelector('[aria-selected="true"]')?.textContent), 'Business');
      await d.frame.focus('#annual');
      from = await mark(d.page);
      await d.page.keyboard.press('Escape');
      await settle(d.frame, 100);
      assert.deepEqual(await msgsOf(d.page, 'key', from), []);
    } finally {
      await d.close();
    }

    // a page without key handlers: its ARIA tab keeps j, the body forwards it
    const p = await openDoc(browser, harness, 'prose');
    try {
      await p.frame.focus('#tab-a');
      let from = await mark(p.page);
      await p.page.keyboard.press('j');
      await settle(p.frame, 100);
      assert.deepEqual(await msgsOf(p.page, 'key', from), []);
      await p.page.mouse.click(700, 690);
      from = await mark(p.page);
      await p.page.keyboard.press('j');
      await waitMsg(p.page, 'key', from, (m) => m.key === 'j');
    } finally {
      await p.close();
    }
  });
});
