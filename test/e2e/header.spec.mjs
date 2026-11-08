// @ts-check
// The calm one-row header and what moved out of it, against the mock daemon:
//   - the top bar stays one row (<= 56 px, nothing clipped, no page scroll, the primary button in view, the title
//     readable) at 1440, 1100, 1000, 900 and 600 px in every mode, light and dark, for the round2, fresh and code
//     scenarios;
//   - the More menu is an accessible menu button: Enter / Space / ArrowDown open it on the first item, ArrowUp on the
//     last, a click on the menu itself; arrows wrap, Home / End jump, a letter moves to the next item starting with it;
//     Esc closes it and gives the focus back, Tab closes it and moves on, a click outside or into the doc closes it;
//     its keys never reach the global shortcuts (also Esc with a comment open), the app combos still work; every
//     item does what its old button did, with its key shown;
//   - the turn pill says whose turn it is as presence, delivery, versions and approval arrive (short below 1200 px,
//     only the dot below 1024 px), and its popover says why and offers "Show my turn" / "Copy the prompt";
//   - the problems chip shows only when something is wrong (a script error in the page; a thread that lost its place
//     is not a problem: Your turn has it);
//   - the tool dock: hidden but mounted in Source / History, quieter in Read, faded while the doc scrolls; none in a
//     code review;
//   - the Changes tab counts the new changes; Accept all and Inline / Side by side live in the Changes panel; side by
//     side shows no version pickers in the header; the primary button is "Send N" / "Approve"; Document info; the
//     palette still offers everything that left the header.

import { TESTID } from '../../src/shared/protocol.js';
import { expect, test } from './fixtures.mjs';

/** @typedef {import('@playwright/test').Page} Page */

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** @param {Page} page @param {string} mode */
const modeTab = (page, mode) => page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="${mode}"]`);

/** Moves keyboard focus back to the UI document (out of the doc iframe). @param {Page} page */
async function focusUi(page) {
  await page.evaluate(() => /** @type {HTMLElement|null} */ (document.activeElement)?.blur?.());
}

/**
 * The top bar keeps one row with nothing cut off.
 * @param {Page} page @param {string} label
 */
async function expectHeaderFits(page, label) {
  const m = await page.evaluate(() => {
    const bar = /** @type {HTMLElement} */ (document.querySelector('.topbar'));
    const send = /** @type {HTMLElement} */ (document.querySelector('[data-testid="submit-review-open"]')).getBoundingClientRect();
    return {
      height: bar.getBoundingClientRect().height,
      clipped: bar.scrollWidth - bar.clientWidth,
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      sendRight: send.right,
      sendWidth: send.width,
      width: document.documentElement.clientWidth,
      title: /** @type {HTMLElement} */ (document.querySelector('.doc-name')).getBoundingClientRect().width,
    };
  });
  expect(m.height, label).toBeLessThanOrEqual(56);
  expect(m.clipped, label).toBeLessThanOrEqual(0);
  expect(m.page, label).toBeLessThanOrEqual(0);
  expect(m.sendRight, label).toBeLessThanOrEqual(m.width);
  expect(m.sendWidth, label).toBeGreaterThan(40);
  expect(m.title, label).toBeGreaterThan(40);
}

/**
 * Walks the widths and modes of a doc already open, in both colour schemes.
 * @param {Page} page @param {string[]} keys mode keys @param {string} name
 */
async function walkHeader(page, keys, name) {
  for (const scheme of /** @type {const} */ (['light', 'dark'])) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1440, 1100, 1000, 900, 600]) {
      await page.setViewportSize({ width, height: 820 });
      for (const key of keys) {
        await focusUi(page);
        await page.keyboard.press(key);
        await expect.poll(() => page.locator('.doc-view').getAttribute('data-mode')).not.toBeNull();
        await page.waitForTimeout(60);
        const mode = await page.locator('.doc-view').getAttribute('data-mode');
        await expectHeaderFits(page, `${name} ${scheme} ${width}px ${mode}`);
      }
    }
  }
}

test.describe('the header keeps one row', () => {
  test('round 2 (a comparison, your turn): every mode, 1440 to 600 px, light and dark', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await expect(page.getByTestId(TESTID.turnPill).locator('.turn-count')).toHaveText('4');
    await walkHeader(page, ['0', '1', '2', '3', '4'], 'round2');
    expect(ui.errors).toEqual([]);
  });

  test.describe('fresh doc', () => {
    test.use({ scenario: 'fresh' });

    test('a first version: every mode, 1440 to 600 px, light and dark', async ({ page, ui }) => {
      await ui.open('kitchen-sink');
      await walkHeader(page, ['0', '1', '2', '3', '4'], 'fresh');
      expect(ui.errors).toEqual([]);
    });
  });

  test.describe('code review', () => {
    test.use({ scenario: 'code' });

    test('Files, Changes and History, 1440 to 600 px, light and dark', async ({ page, ui }) => {
      await page.goto(ui.mock.url('cr-feat'));
      await expect(page.locator('[data-view="code"][data-ready]')).toBeAttached({ timeout: 15000 });
      await walkHeader(page, ['1', '2', '4'], 'code');
      expect(ui.errors).toEqual([]);
    });
  });
});

test('More menu: opened from the keyboard or the mouse, arrows, type-ahead, Esc / Tab / a click outside close it', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  const more = page.getByTestId(TESTID.moreMenu);
  const menu = page.getByRole('menu', { name: 'More' });
  await expect(more).toHaveAttribute('aria-haspopup', 'menu');
  await expect(more).toHaveAttribute('aria-expanded', 'false');

  // Enter: open, first item focused; the button points at the menu
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(more).toHaveAttribute('aria-controls', /** @type {string} */ (await menu.getAttribute('id')));
  await expect(ui.menuItem('source')).toBeFocused();
  await expect(menu.getByRole('menuitem')).toHaveText([/Source/, /History/, /Hide marks/, /Theme: System/, /Keyboard shortcuts/, /Settings/, /Document info/]);
  // keys shown at the right
  await expect(ui.menuItem('source').locator('.menu-key')).toHaveText('3');
  await expect(ui.menuItem('settings').locator('.menu-key')).toHaveText(/^(⌘,|Ctrl\+,)$/);

  // arrows wrap, Home / End jump, a letter moves to the next item starting with it
  await page.keyboard.press('ArrowDown');
  await expect(ui.menuItem('history')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(ui.menuItem('info')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(ui.menuItem('source')).toBeFocused();
  await page.keyboard.press('End');
  await expect(ui.menuItem('info')).toBeFocused();
  await page.keyboard.press('k');
  await expect(ui.menuItem('help')).toBeFocused();
  await page.keyboard.press('s');
  await expect(ui.menuItem('settings')).toBeFocused();
  await page.keyboard.press('s');
  await expect(ui.menuItem('source')).toBeFocused();

  // keys inside never reach the global shortcuts: j (next thread), 1 (Review), \ (thread panel)
  for (const key of ['j', '1', '\\']) await page.keyboard.press(key);
  await expect(page.locator(`[data-testid="${TESTID.threadCard}"][aria-current="true"]`)).toHaveCount(0);
  await ui.inMode('changes');
  await expect(page.locator('#sr-side')).toBeVisible();
  await expect(menu).toBeVisible();

  // Esc: closed, the focus back on the button
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(more).toBeFocused();

  // ArrowUp opens it on the last item; Tab closes it and moves on to the next control
  await page.keyboard.press('ArrowUp');
  await expect(ui.menuItem('info')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId(TESTID.submitReviewOpen)).toBeFocused();
  // Space opens it; Shift+Tab goes back to the button
  await more.focus();
  await page.keyboard.press(' ');
  await expect(ui.menuItem('source')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();

  // A click opens it with the menu itself focused (nothing looks chosen); hovering an item focuses it.
  await more.click();
  await expect(menu).toBeFocused();
  await ui.menuItem('history').hover();
  await expect(ui.menuItem('history')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(ui.menuItem('hide')).toBeFocused();
  // a click outside closes it (an invisible layer takes that click: it does nothing else)
  const head = /** @type {{ x: number, y: number }} */ (await page.locator('.changes-head').boundingBox());
  await page.mouse.click(head.x + 5, head.y + 5);
  await expect(menu).toHaveCount(0);
  // so does a click over the doc (its iframe never tells this document about its own clicks)
  const p = await ui.pointIn('p', 'This spec describes');
  await more.click();
  await expect(menu).toBeVisible();
  await page.mouse.click(p.x + 5, p.cy);
  await expect(menu).toHaveCount(0);
  // and a second click on the button
  await more.click();
  await expect(menu).toBeVisible();
  const b = /** @type {{ x: number, y: number, width: number, height: number }} */ (await more.boundingBox());
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(menu).toHaveCount(0);
  await expect(more).toHaveAttribute('aria-expanded', 'false');

  // The app combos pass through: Cmd+K opens the palette and the menu closes.
  await more.click();
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.getByTestId(TESTID.commandPalette)).toBeVisible();
  await expect(menu).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(ui.errors).toEqual([]);
});

test('More menu: Esc closes only the menu, never a comment being written', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  await modeTab(page, 'review').click();
  await page.getByRole('button', { name: 'General comment' }).click();
  const ta = page.getByTestId(TESTID.composerTextarea);
  await ta.fill('Keep me');
  await page.getByTestId(TESTID.moreMenu).click();
  await expect(page.getByRole('menu', { name: 'More' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'More' })).toHaveCount(0);
  await expect(page.getByTestId(TESTID.composer)).toBeVisible();
  await expect(ta).toHaveValue('Keep me');
  expect(ui.errors).toEqual([]);
});

test('More menu items: Source, History (a tab while shown), Hide marks, Theme, shortcuts, Settings, Document info', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await expect(modeTab(page, 'source')).toHaveCount(0);
  await expect(modeTab(page, 'history')).toHaveCount(0);
  await ui.menu('source');
  await ui.inMode('source');
  await expect(modeTab(page, 'source')).toHaveAttribute('aria-selected', 'true');
  await ui.menu('history');
  await ui.inMode('history');
  await expect(modeTab(page, 'source')).toHaveCount(0);
  await expect(modeTab(page, 'history')).toHaveAttribute('aria-selected', 'true');
  // the open mode is marked in the menu
  await page.getByTestId(TESTID.moreMenu).click();
  await expect(ui.menuItem('history')).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await modeTab(page, 'review').click();
  await expect(modeTab(page, 'history')).toHaveCount(0);

  // Hide marks: the item flips to Show marks
  await ui.menu('hide');
  await expect.poll(async () => (await ui.inspect()).hidden).toBe(true);
  await page.getByTestId(TESTID.moreMenu).click();
  await expect(ui.menuItem('hide')).toHaveText(/Show marks/);
  await expect(ui.menuItem('hide')).toHaveAttribute('aria-label', 'Show annotations');
  await ui.menuItem('hide').click();
  await expect.poll(async () => (await ui.inspect()).hidden).toBe(false);
  // Read mode has no marks: the item is disabled and does nothing
  await modeTab(page, 'read').click();
  await page.getByTestId(TESTID.moreMenu).click();
  const hide = page.getByRole('menuitem', { name: 'Hide annotations' });
  await expect(hide).toBeDisabled();
  await hide.click({ force: true });
  await expect(page.getByRole('menu', { name: 'More' })).toBeVisible();
  await page.keyboard.press('Escape');
  await modeTab(page, 'review').click();
  await expect.poll(async () => (await ui.inspect()).hidden).toBe(false);

  // Keyboard shortcuts: the overlay; closing it gives the focus back to the More button
  await ui.menu('help');
  await expect(page.getByTestId(TESTID.helpOverlay)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(TESTID.helpOverlay)).toHaveCount(0);
  await expect(page.getByTestId(TESTID.moreMenu)).toBeFocused();

  // Document info: what the status bar used to say
  await ui.menu('info');
  const info = page.getByTestId('doc-info');
  await expect(info).toBeVisible();
  await expect(info.locator('[data-info="version"]')).toHaveText('v2 (latest)');
  await expect(info.locator('[data-info="final"]')).toHaveText('none yet');
  await expect(info.locator('[data-info="working"]')).toContainText('clean');
  await expect(info.locator('[data-info="errors"]')).toHaveText('none');
  await expect(info.locator('[data-info="resources"]')).toHaveText('all loaded');
  await expect(info.locator('[data-info="lost"]')).toContainText('t4');
  await expect(info.locator('[data-info="agent"]')).toContainText('Claude isn\'t connected');
  await expect(info).toContainText(mock.doc('kitchen-sink').doc.path);
  await info.getByRole('button', { name: 'Show them' }).click();
  await expect(info).toHaveCount(0);
  await expect(page.locator('.filter[data-filter="mine"]')).toHaveAttribute('aria-selected', 'true');
  await expect(ui.card('t4')).toBeVisible();
  expect(ui.errors).toEqual([]);
});

test('the outline\'s section menu is the same menu: keyboard, Esc gives the focus back', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  await ui.showOutline();
  const button = page.getByRole('button', { name: 'Actions for section 3 Tokens' });
  await button.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Section 3 Tokens' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Comment on section' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Mark agreed' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(TESTID.composer).locator('.agent-sees')).toContainText('3 Tokens');
  expect(ui.errors).toEqual([]);
});

test('turn pill: your turn with its count, the popover explains it, Show my turn opens the thread panel on it', async ({ page, ui, mock }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: mock.uiOrigin });
  await ui.open('kitchen-sink');
  const pill = page.getByTestId(TESTID.turnPill);
  // t1, t2, t4 answered by the agent (to check), t6 its question
  await expect(pill.locator('.turn-count')).toHaveText('4');
  await expect(pill).toContainText('Your turn');
  await expect(pill).toHaveAttribute('aria-label', 'Your turn · 4, Claude isn\'t connected');
  await expect(pill.getByTestId(TESTID.presence)).toHaveAttribute('data-presence', 'none');
  await expect(pill).toHaveAttribute('aria-haspopup', 'dialog');

  await pill.click();
  const pop = page.getByRole('dialog', { name: 'Review status' });
  await expect(pop).toBeVisible();
  await expect(pop).toBeFocused();
  await expect(pop).toContainText('Claude isn\'t connected');
  await expect(pop).toContainText('v2 answers your last review');
  await expect(pop.locator('.turn-mine li')).toHaveText([/3\s*answers to check/, /1\s*question for you/]);
  // Tab walks its buttons; Esc closes it and gives the focus back
  await page.keyboard.press('Tab');
  await expect(pop.getByRole('button', { name: 'Show my turn' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await expect(pill).toBeFocused();

  await pill.click();
  await pop.getByRole('button', { name: 'Copy the prompt for Claude' }).click();
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'Prompt copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Run suiko feedback kitchen-sink and address it.');

  await pill.click();
  await pop.getByRole('button', { name: 'Show my turn' }).click();
  await expect(pop).toHaveCount(0);
  await expect(page.locator('.side-tabs [role="tab"][aria-selected="true"]')).toHaveText('Threads');
  await expect(page.locator('.filter[data-filter="mine"]')).toHaveAttribute('aria-selected', 'true');
  // the panel counts what the pill counts
  await expect(page.locator('.filter[data-filter="mine"] .count')).toHaveText('4');
  await expect(ui.card('t1')).toBeVisible();

  // Accepting the answers brings the count down
  await ui.card('t1').getByTestId(TESTID.verifyAccept).click();
  await expect(pill.locator('.turn-count')).toHaveText('3');
  // the palette offers the same
  await focusUi(page);
  await page.keyboard.press(`${MOD}+k`);
  await page.getByTestId(TESTID.commandPaletteInput).fill('show my turn');
  await expect(page.getByTestId(TESTID.commandItem).first()).toHaveAttribute('data-command-id', 'my-turn');
  await expect(page.getByTestId(TESTID.commandItem).first()).toContainText('Your turn · 3');
  await page.keyboard.press('Escape');
  expect(ui.errors).toEqual([]);
});

test.describe('fresh doc', () => {
  test.use({ scenario: 'fresh' });

  test('turn pill follows the agent: not connected, listening, working on a review, editing, the answer, approved', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    const d = mock.doc('kitchen-sink');
    const pill = page.getByTestId(TESTID.turnPill);
    const presence = pill.getByTestId(TESTID.presence);
    await expect(pill.locator('.turn-text')).toHaveText('Claude isn\'t connected');
    await expect(presence).toHaveAttribute('data-presence', 'none');
    await expect(pill.locator('.turn-count')).toHaveCount(0);

    d.setWaiters([{ agent: 'claude' }]);
    await expect(pill.locator('.turn-text')).toHaveText('Claude is listening');
    await expect(presence).toHaveClass(/tone-ok/);

    // a review goes out; the waiting agent gets it at once
    d.submitReview({ verdict: 'comment', body: 'A first look', draftIds: [] });
    await expect(pill.locator('.turn-text')).toHaveText('Claude is working…');
    await expect(presence).toHaveAttribute('data-presence', 'revising');
    await expect(pill.locator('.review-progress')).toHaveText(/^Claude has it · \d\d:\d\d$/);

    d.setWorking(`${d.source(1)}\nMore text.\n`);
    await expect(pill.locator('.turn-text')).toHaveText('Claude is editing');
    await expect(presence).toHaveAttribute('data-presence', 'editing');

    d.setWorking(null);
    d.revise({ source: d.source(1).replace('Prototype the issuer.', 'Prototype the issuer first.'), summary: 'wording' });
    await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
    await expect(pill.locator('.review-progress')).toHaveCount(0);
    await expect(pill.locator('.turn-text')).toHaveText('Claude isn\'t connected');

    // nothing left for either side: Approve is the next step (accent)
    const send = page.getByTestId(TESTID.submitReviewOpen);
    await expect(send).toHaveText('Approve');
    await expect(send).toHaveClass(/btn-primary/);
    d.submitReview({ verdict: 'approved', body: '', draftIds: [], markFinal: true, expectHead: 2 });
    await expect(pill.locator('.turn-text')).toHaveText('Approved v2');
    await expect(presence).toHaveAttribute('data-presence', 'none');
    expect(ui.errors).toEqual([]);
  });

  test('turn pill: the short label below 1200 px, only the dot below 1024 px; the name stays whole', async ({ page, ui, mock }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await ui.open('kitchen-sink');
    mock.doc('kitchen-sink').setWaiters([{ agent: 'claude' }]);
    const pill = page.getByTestId(TESTID.turnPill);
    await expect(pill.locator('.turn-text')).toHaveText('Listening');
    await expect(pill.getByTestId(TESTID.presence)).toHaveText(/Claude is listening/);
    await expect(pill).toHaveAttribute('aria-label', 'Claude is listening');
    await page.setViewportSize({ width: 980, height: 800 });
    await expect(pill.locator('.turn-text')).toBeHidden();
    await expect(pill.locator('.dot')).toBeVisible();
    await expect(pill).toHaveAttribute('aria-label', 'Claude is listening');
    expect(ui.errors).toEqual([]);
  });

  test('primary button: Approve without drafts (neutral before a round), Send N with them', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    const send = page.getByTestId(TESTID.submitReviewOpen);
    await expect(send).toHaveText('Approve');
    await expect(send).not.toHaveClass(/btn-primary/);
    await expect(send.locator('.drafts-count')).toHaveCount(0);
    await ui.selectText('Prototype the issuer.');
    await page.locator('[data-selection-comment]').click();
    await page.getByTestId(TESTID.composerTextarea).fill('Which language?');
    await page.getByTestId(TESTID.composerAdd).click();
    await expect(send).toHaveText('Send 1');
    await expect(send).toHaveClass(/btn-primary/);
    await expect(send.locator('.drafts-count strong')).toHaveText('1');
    await expect(send).toHaveAttribute('title', /your 1 comment goes to the agent/);
    await send.click();
    await expect(page.getByTestId(TESTID.submitReviewDialog)).toBeVisible();
    expect(ui.errors).toEqual([]);
  });

  test('problems chip: none while all is well; a script error in the page shows it, Reload clears it', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    const chip = page.getByTestId(TESTID.problems);
    await expect(chip).toHaveCount(0);
    const f = await ui.frame();
    await f.evaluate(() => setTimeout(() => { throw new Error('chart failed to draw'); }));
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText('1');
    await expect(chip).toHaveAttribute('aria-label', /1 problem: 1 script error in the page/);
    await chip.click();
    const pop = page.getByRole('dialog', { name: 'Problems' });
    await expect(pop.locator('[data-problem="errors"]')).toContainText('1 script error in the page');
    await expect(pop.locator('[data-problem="errors"]')).toContainText('chart failed to draw');
    await pop.getByRole('button', { name: 'Reload the document' }).click();
    await ui.ready();
    await expect(chip).toHaveCount(0);
    // (Playwright reports the doc's own error too)
    expect(ui.errors.filter((e) => !e.includes('chart failed to draw'))).toEqual([]);
  });
});

test('no problems chip for a thread that lost its place: Your turn has it, and its card gives it a place again', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  await page.waitForTimeout(300);
  await expect(page.getByTestId(TESTID.problems)).toHaveCount(0);
  // v: Your turn, where t4 (Claude didn't change it, and its line is gone) waits
  await focusUi(page);
  await page.keyboard.press('v');
  await expect(page.locator('.filter[data-filter="mine"]')).toHaveAttribute('aria-selected', 'true');
  await expect(ui.card('t4')).toBeVisible();
  // kept as a general comment (in its ⋯ menu: Claude didn't change it, which comes first), it has a place again
  await ui.cardMenu(ui.card('t4'), 'general');
  await expect(ui.card('t4').locator('.card-target')).toHaveText('General comment');
  await expect(page.getByTestId(TESTID.problems)).toHaveCount(0);
  expect(ui.errors).toEqual([]);
});

test('tool dock: over the doc, hidden but mounted in Source / History, quieter in Read, faded while the doc scrolls', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  const dock = page.getByTestId(TESTID.toolDock);
  await expect(dock).toBeVisible();
  for (const id of [TESTID.pickTool, TESTID.snipTool, TESTID.snipScreen]) await expect(dock.getByTestId(id)).toBeVisible();
  await expect(dock.locator('[data-selection-comment]')).toBeDisabled();
  // inside the doc area, at the bottom centre, clear of the thread panel
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await dock.boundingBox());
  const center = /** @type {{ x: number, y: number, width: number, height: number }} */ (await page.locator('main.center').boundingBox());
  expect(box.height).toBeLessThanOrEqual(37);
  expect(Math.abs(box.x + box.width / 2 - (center.x + center.width / 2))).toBeLessThan(2);
  expect(box.y + box.height).toBeLessThanOrEqual(center.y + center.height - 8);

  await ui.selectText('Remove the legacy session store.');
  await expect(dock.locator('[data-selection-comment]')).toBeEnabled();

  await focusUi(page);
  await page.keyboard.press('3');
  await expect(dock).toBeHidden();
  await expect(page.locator('[data-selection-comment]')).toBeAttached();
  await page.keyboard.press('4');
  await expect(dock).toBeHidden();
  await page.keyboard.press('0');
  await expect(dock).toBeVisible();
  await expect(dock).toHaveClass(/is-quiet/);
  await expect.poll(() => dock.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.6');
  await page.keyboard.press('1');
  await expect(dock).not.toHaveClass(/is-quiet/);

  // scrolling the doc fades it, then it comes back (with no text selected: a selection keeps it up, dock.spec.mjs)
  const f = await ui.frame();
  await f.evaluate(() => getSelection()?.removeAllRanges());
  await expect(dock.locator('[data-selection-comment]')).toBeDisabled();
  await f.evaluate(() => window.scrollBy(0, 400));
  await expect(dock).toHaveClass(/is-scrolling/);
  await expect(dock).not.toHaveClass(/is-scrolling/, { timeout: 3000 });
  expect(ui.errors).toEqual([]);
});

test('the dock\'s Comment opens the composer and hides the doc\'s selection toolbar; the selection stays', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  await ui.selectText('Remove the legacy session store.');
  await expect.poll(async () => !!(await ui.inspect()).toolbar).toBe(true);
  await page.getByTestId(TESTID.toolDock).locator('[data-selection-comment]').click();
  await expect(page.getByTestId(TESTID.composer)).toBeVisible();
  await expect.poll(async () => (await ui.inspect()).toolbar).toBe(null);
  const f = await ui.frame();
  expect(await f.evaluate(() => String(getSelection()))).toBe('Remove the legacy session store.');
  expect(ui.errors).toEqual([]);
});

test('a document with its own key handling: the first single key it keeps gets one note, once per doc', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  const f = await ui.frame();
  // the page installs a key listener of its own (PageKeys counts listeners added through addEventListener)
  await f.evaluate(() => document.addEventListener('keydown', () => {}));
  await f.locator('h1').first().click();
  await page.keyboard.press('b');
  const note = page.locator('.toast', { hasText: 'This document has its own keyboard shortcuts' });
  await expect(note).toHaveCount(1);
  await expect(note).toContainText('Use the tools at the bottom of the document, or select text and press c.');
  expect(await ui.inspect().then((g) => g.snip?.active)).toBeFalsy();
  await page.keyboard.press('e');
  await page.waitForTimeout(300);
  await expect(note).toHaveCount(1);
  expect(ui.errors).toEqual([]);
});

test('Changes: the tab counts the new changes; Accept all and Inline / Side by side are in the Changes panel', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  await ui.inMode('changes');
  await expect(modeTab(page, 'changes').locator('.badge')).toHaveText('3');
  await expect(modeTab(page, 'changes')).toContainText('(3 new)');
  const header = page.locator('.topbar');
  const panel = page.locator('.changes-view');
  await expect(header.getByTestId(TESTID.compareLayout)).toHaveCount(0);
  await expect(header.getByTestId(TESTID.acceptRevisions)).toHaveCount(0);
  await expect(panel.getByTestId(TESTID.acceptRevisions)).toHaveText('Accept all');
  await expect(panel.getByTestId(TESTID.acceptRevisions)).toHaveAttribute('aria-label', 'Accept all revisions');
  await expect(panel.getByTestId(TESTID.compareLayout)).toBeVisible();
  await expect(header.locator('#sr-base')).toHaveValue('1');
  await expect(header.locator('#sr-version')).toHaveValue('2');
  await expect(header.locator('#sr-base option[value="1"]')).toHaveText('v1 · last review');
  await expect(header.locator('#sr-version option[value="2"]')).toHaveText('v2 · latest');

  // side by side: the frames' headers have the versions (the compare bar its own switch), not the top bar or the panel
  await panel.getByTestId(TESTID.compareLayout).locator('[data-layout="split"]').click();
  await ui.baseFrame();
  await expect(header.locator('#sr-base')).toHaveCount(0);
  await expect(header.getByTestId(TESTID.versionPicker)).toHaveCount(0);
  await expect(panel.getByTestId(TESTID.compareLayout)).toHaveCount(0);

  // the Changes tab is the switch: Review turns the marks off
  await modeTab(page, 'review').click();
  await ui.inMode('review');
  await expect(modeTab(page, 'changes').locator('.badge')).toHaveText('3');
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
  await expect(page.locator('#sr-base')).toHaveCount(0);
  expect(ui.errors).toEqual([]);
});

test('the palette still offers everything that left the header', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  await focusUi(page);
  await page.keyboard.press(`${MOD}+k`);
  const input = page.getByTestId(TESTID.commandPaletteInput);
  await expect(input).toBeFocused();
  await input.fill('');
  for (const id of ['mode-source', 'mode-history', 'hide', 'theme', 'settings', 'help', 'show-changes', 'hide-changes',
    'accept-revisions', 'compare-split', 'compare-inline', 'toggle-outline', 'my-turn', 'doc-info']) {
    await expect(page.locator(`[data-testid="${TESTID.commandItem}"][data-command-id="${id}"]`)).toHaveCount(1);
  }
  await input.fill('document info');
  await expect(page.getByTestId(TESTID.commandItem).first()).toHaveAttribute('data-command-id', 'doc-info');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('doc-info')).toBeVisible();
  expect(ui.errors).toEqual([]);
});

test.describe('code review', () => {
  test.use({ scenario: 'code' });

  test('no tool dock, no Source; History is in the More menu; the file tree stays beside the diffs from 1200 px', async ({ page, ui }) => {
    await page.goto(ui.mock.url('cr-feat'));
    await expect(page.locator('[data-view="code"][data-ready]')).toBeAttached({ timeout: 15000 });
    await expect(page.getByTestId(TESTID.toolDock)).toHaveCount(0);
    await expect(page.locator('#sr-nav')).toBeVisible();
    await page.getByTestId(TESTID.moreMenu).click();
    await expect(page.getByRole('menu', { name: 'More' }).getByRole('menuitem')).toHaveText([/History/, /Theme/, /Keyboard shortcuts/, /Settings/, /Document info/]);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(page.locator('#sr-nav')).toBeHidden();
    expect(ui.errors).toEqual([]);
  });
});
