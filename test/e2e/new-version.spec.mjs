// @ts-check
// Settings > When Claude records a new version (the UI fix round's L1, L6 and the "Just tell me" wording of V9):
//   - "Just tell me" (onNewVersion 'toast') never moves the view, in any mode, with or without a dialog or menu open:
//     a toast says what arrived ("Claude recorded v3 · 1 changed", Show changes / Show my turn; else Show / Show
//     changes) and the banner offers the switch;
//   - "Show what changed" ('changes') shows the new version's changes only while nothing is open (no dialog, menu or
//     text selection), else the same toast;
//   - "Show the new version" ('latest', the default) does not follow while text is selected in the doc (the first
//     step of a comment): "vN is ready · Show", the selection stays.

import { test, expect } from './fixtures.mjs';
import { TESTID } from '../../src/shared/protocol.js';

/** @param {import('@playwright/test').Page} page @param {string|RegExp} text */
const toastWith = (page, text) => page.getByTestId(TESTID.toast).filter({ hasText: text });
/** @param {import('@playwright/test').Page} page */
const shownVersion = (page) => page.getByTestId(TESTID.versionPicker);
/** @param {import('@playwright/test').Page} page */
const mode = (page) => page.locator('.doc-view');

/** The agent records the next version: only the "Last revised" date changes. @param {any} d @param {any} [extra] */
const bump = (d, extra = {}) => d.revise({
  source: d.source(d.head).replace(/Last revised 2026-10-(\d+)\./, (/** @type {string} */ _m, /** @type {string} */ n) => `Last revised 2026-10-${Number(n) + 1}.`),
  summary: 'date',
  ...extra,
});

/** @param {import('@playwright/test').Page} page @param {Record<string, string>} prefs */
async function withPrefs(page, prefs) {
  await page.addInitScript((p) => {
    if (window.top !== window) return;
    for (const [k, v] of Object.entries(p)) if (localStorage.getItem(`suiko.${k}`) == null) localStorage.setItem(`suiko.${k}`, v);
  }, prefs);
}

test.describe('"Just tell me" (onNewVersion toast)', () => {
  test.use({ scenario: 'round2', prefs: 'defaults' });
  test.beforeEach(async ({ page }) => withPrefs(page, { onNewVersion: 'toast' }));

  test('L1: in Review with nothing open the view stays; the note says what arrived; Show and Show changes move on request', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await ui.inMode('review');
    const d = mock.doc('kitchen-sink');
    bump(d);
    const note = toastWith(page, 'Claude recorded v3');
    await expect(note).toBeVisible();
    await expect(note.locator('button.btn')).toHaveText(['Show', 'Show changes']);
    await expect(note).not.toContainText(/ready|answers|Verify/);
    await page.waitForTimeout(600);
    await expect(shownVersion(page)).toHaveValue('2');
    await expect(page.locator('.banner-info')).toContainText('latest is v3');
    await note.getByRole('button', { name: 'Show', exact: true }).click();
    await expect(shownVersion(page)).toHaveValue('3');
    await ui.inMode('review');

    // a version that answers threads: "1 changed", Show changes / Show my turn
    bump(d, { replies: { t6: { status: 'addressed', reply: 'Made it configurable.' } } });
    const answered = toastWith(page, 'Claude recorded v4 · 1 changed');
    await expect(answered).toBeVisible();
    await expect(answered.locator('button.btn')).toHaveText(['Show changes', 'Show my turn']);
    await expect(shownVersion(page)).toHaveValue('3');
    await answered.getByRole('button', { name: 'Show changes' }).click();
    await expect(shownVersion(page)).toHaveValue('4');
    await ui.inMode('changes');
    expect(ui.errors).toEqual([]);
  });

  test('L1: with Settings open, in Source, or with a menu open the view stays too (and the menu stays open)', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    const d = mock.doc('kitchen-sink');
    await ui.settings('reading');
    bump(d);
    await expect(toastWith(page, 'Claude recorded v3')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(shownVersion(page)).toHaveValue('2');
    await page.keyboard.press('Escape');

    await ui.menu('source');
    await ui.inMode('source');
    bump(d);
    await expect(toastWith(page, 'Claude recorded v4')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(shownVersion(page)).toHaveValue('2');
    await ui.inMode('source');

    await page.getByTestId(TESTID.moreMenu).click();
    await expect(page.locator('[role="menu"]')).toBeVisible();
    bump(d);
    await expect(toastWith(page, 'Claude recorded v5')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(shownVersion(page)).toHaveValue('2');
    await expect(page.locator('[role="menu"]')).toBeVisible();
    expect(ui.errors).toEqual([]);
  });
});

test.describe('"Show what changed" (onNewVersion changes)', () => {
  test.use({ scenario: 'round2', prefs: 'defaults' });
  test.beforeEach(async ({ page }) => withPrefs(page, { onNewVersion: 'changes' }));

  test('L1: with Settings open only the note says so; with nothing open it shows the changes', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    const d = mock.doc('kitchen-sink');
    await ui.settings('reading');
    bump(d);
    await expect(toastWith(page, 'Claude recorded v3')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(shownVersion(page)).toHaveValue('2');
    await expect(mode(page)).toHaveAttribute('data-mode', 'review');
    await page.keyboard.press('Escape');

    bump(d);
    await expect(toastWith(page, 'Claude recorded v4. Showing what changed.')).toBeVisible();
    await expect(shownVersion(page)).toHaveValue('4');
    await ui.inMode('changes');
    expect(ui.errors).toEqual([]);
  });

  test('L6: a text selection in the doc keeps the view: only the note', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await ui.selectText('Detect reuse of a rotated token.');
    bump(mock.doc('kitchen-sink'));
    await expect(toastWith(page, 'Claude recorded v3')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(shownVersion(page)).toHaveValue('2');
    await expect(page.locator('[data-selection-comment]')).toBeEnabled();
  });
});

test.describe('"Show the new version" (onNewVersion latest, the default)', () => {
  test.use({ scenario: 'round2', prefs: 'defaults' });

  test('L6: a text selection in the doc (about to comment) keeps the view and the selection: "v3 is ready · Show"', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await ui.selectText('Detect reuse of a rotated token.');
    bump(mock.doc('kitchen-sink'));
    const ready = toastWith(page, 'v3 is ready');
    await expect(ready).toBeVisible();
    await page.waitForTimeout(500);
    await expect(shownVersion(page)).toHaveValue('2');
    await expect(page.locator('[data-selection-comment]')).toBeEnabled();
    // the comment can still be written on what was selected
    await page.locator('[data-selection-comment]').click();
    await expect(page.getByTestId(TESTID.composer)).toContainText('Detect reuse of a rotated token.');
    // without the selection the next version is followed again
    await page.getByTestId(TESTID.composer).getByRole('button', { name: 'Cancel' }).click();
    const f = await ui.frame();
    await f.evaluate(() => getSelection()?.removeAllRanges());
    await expect(page.locator('[data-selection-comment]')).toBeDisabled();
    await ready.getByRole('button', { name: 'Show' }).click();
    await expect(shownVersion(page)).toHaveValue('3');
    await ui.ready();
    bump(mock.doc('kitchen-sink'));
    await expect(toastWith(page, 'Updated to v4')).toBeVisible();
    await expect(shownVersion(page)).toHaveValue('4');
    expect(ui.errors).toEqual([]);
  });
});
