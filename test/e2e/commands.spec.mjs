// @ts-check
// The command palette (Cmd/Ctrl+K), Settings (Cmd/Ctrl+,) and the keyboard shortcuts overlay (Cmd/Ctrl+/ or ?),
// against the mock daemon (scenario 'round2'):
//   - the palette opens with Cmd+K and Ctrl+K from the UI, from inside the doc iframe (real key presses, forwarded by
//     the guest) and from inside the composer (whose draft stays), and from the top-bar button; Esc gives the focus
//     back;
//   - fuzzy search with highlighted matches; arrows / Enter; dimmed commands show why and do not run;
//   - "t4" jumps to a thread, headings and versions are found, sub-lists (version, compare in two steps, the close
//     confirmation, another doc) with a breadcrumb and Backspace to go back; recent commands come first;
//   - palette-only commands: filters, Submit review as a verdict, Mark all changes seen, Record, copy, close session;
//   - every setting takes effect and is remembered: theme, outline rail, thread panel, single-letter shortcuts (off:
//     c / b / j do nothing in the UI or the doc, the guest is told), switching to Changes on a new version, asking
//     before Send now, the default verdict, About;
//   - the keyboard shortcuts overlay is generated from the command registry and can be filtered;
//   - one dialog at a time.

import { TESTID } from '../../src/shared/protocol.js';
import { FIXTURE_DIR } from './mock-data.mjs';
import { expect, test } from './fixtures.mjs';

test.use({ scenario: 'round2' });

/** Cmd on macOS (where the UI shows ⌘), Ctrl elsewhere. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** @typedef {import('@playwright/test').Page} Page */

/** @param {Page} page */
const palette = (page) => page.getByTestId(TESTID.commandPalette);
/** @param {Page} page */
const paletteInput = (page) => page.getByTestId(TESTID.commandPaletteInput);
/** @param {Page} page @param {string} id */
const item = (page, id) => page.locator(`[data-testid="${TESTID.commandItem}"][data-command-id="${id}"]`);
/** @param {Page} page */
const firstItem = (page) => page.getByTestId(TESTID.commandItem).first();
/** @param {Page} page */
const activeItem = (page) => page.locator(`[data-testid="${TESTID.commandItem}"][aria-selected="true"]`);
/** @param {Page} page @param {string} mode */
const modeTab = (page, mode) => page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="${mode}"]`);
/** @param {Page} page @param {string} text */
const toastWith = (page, text) => page.getByTestId(TESTID.toast).filter({ hasText: text });

/** Moves keyboard focus back to the UI document (out of the doc iframe). @param {Page} page */
async function focusUi(page) {
  await page.evaluate(() => /** @type {HTMLElement|null} */ (document.activeElement)?.blur?.());
}

/** Opens the palette with the keyboard and types a query. @param {Page} page @param {string} [query] */
async function openPalette(page, query = '') {
  await page.keyboard.press(`${MOD}+k`);
  await expect(paletteInput(page)).toBeFocused();
  if (query) await paletteInput(page).fill(query);
}

/** Clicks into a paragraph of the doc, so key presses go to the iframe. @param {import('./fixtures.mjs').Ui} ui */
async function focusDoc(ui) {
  const p = await ui.pointIn('p', 'This spec describes');
  await ui.page.mouse.click(p.x + 5, p.cy);
  await expect.poll(() => ui.page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(TESTID.docFrame);
}

test('Cmd+K and Ctrl+K toggle the palette from the UI, from inside the doc and from the button; Esc gives the focus back', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  const button = page.getByTestId(TESTID.commandPaletteOpen);
  await expect(button.locator('kbd')).toHaveText(/^(⌘K|Ctrl\+K)$/);

  await focusUi(page);
  await page.keyboard.press(`${MOD}+k`);
  await expect(palette(page)).toBeVisible();
  await expect(paletteInput(page)).toBeFocused();
  await expect(paletteInput(page)).toHaveAttribute('placeholder', 'Type a command, a thread like t4, or a section…');
  await page.keyboard.press(`${MOD}+k`); // toggles
  await expect(palette(page)).toHaveCount(0);
  await page.keyboard.press('Control+k'); // the macOS fallback works everywhere
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);

  await button.click();
  await expect(paletteInput(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
  await expect(button).toBeFocused();

  // From inside the document: the guest forwards the combo (a real key press in the frame).
  await focusDoc(ui);
  await page.keyboard.press(`${MOD}+k`);
  await expect(palette(page)).toBeVisible();
  await expect(paletteInput(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(TESTID.docFrame);
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press('Escape');
  expect(ui.errors).toEqual([]);
});

test('fuzzy search ranks and highlights; arrows and Enter run; an empty query lists everything by category', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  await focusUi(page);
  await openPalette(page);
  const titles = page.locator('.palette-section-title');
  await expect(titles).toHaveText(['Comment', 'Review', 'Navigate', 'View', 'App']);
  const count = await page.getByTestId(TESTID.commandItem).count();
  expect(count).toBeGreaterThan(40);
  expect(count).toBeLessThanOrEqual(200);
  // Shortcut chips at the right.
  await expect(item(page, 'verify').locator('.pi-keys kbd')).toHaveText('v');
  await expect(item(page, 'settings').locator('.pi-keys kbd')).toHaveText(/^(⌘,|Ctrl\+,)$/);

  await paletteInput(page).fill('verif');
  await expect(firstItem(page)).toHaveAttribute('data-command-id', 'verify');
  await expect(firstItem(page).locator('mark')).toHaveText(['Verif']);
  await expect(firstItem(page)).toHaveAttribute('aria-selected', 'true');

  // A subsequence across words, in any order.
  await paletteInput(page).fill('approve submit');
  await expect(firstItem(page)).toHaveAttribute('data-command-id', 'submit-approve');
  await paletteInput(page).fill('gtt');
  await expect(firstItem(page)).toHaveAttribute('data-command-id', 'goto-thread');
  await paletteInput(page).fill('zzqxv');
  await expect(page.getByTestId(TESTID.commandItem)).toHaveCount(0);
  await expect(palette(page)).toContainText('Nothing matches');

  // ↓ / Ctrl+N move, Enter runs the active row.
  await paletteInput(page).fill('mode');
  await expect(activeItem(page)).toHaveAttribute('data-command-id', 'mode-review');
  await page.keyboard.press('ArrowDown');
  await expect(activeItem(page)).toHaveAttribute('data-command-id', 'mode-changes');
  await page.keyboard.press('Control+n');
  await expect(activeItem(page)).toHaveAttribute('data-command-id', 'mode-source');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Control+p');
  await expect(activeItem(page)).toHaveAttribute('data-command-id', 'mode-review');
  await page.keyboard.press('ArrowUp'); // wraps around
  await expect(page.getByTestId(TESTID.commandItem).last()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(activeItem(page)).toHaveAttribute('data-command-id', 'mode-review');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await expect(activeItem(page)).toHaveAttribute('data-command-id', 'mode-history');
  await page.keyboard.press('Enter');
  await expect(palette(page)).toHaveCount(0);
  await expect(modeTab(page, 'history')).toHaveAttribute('aria-selected', 'true');

  // A click runs too.
  await modeTab(page, 'review').click();
  await openPalette(page, 'hide annot');
  await expect(firstItem(page)).toHaveAttribute('data-command-id', 'hide');
  await item(page, 'hide').click();
  await expect(palette(page)).toHaveCount(0);
  await expect.poll(async () => (await ui.inspect()).hidden).toBe(true);
  expect(ui.errors).toEqual([]);
});

test('commands that cannot run now are dimmed with the reason and are not run', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await modeTab(page, 'review').click();
  await focusUi(page);
  await openPalette(page, 'comment on the sel');
  const comment = item(page, 'comment');
  await expect(comment).toHaveAttribute('aria-disabled', 'true');
  await expect(comment).toContainText('select text in the doc first');
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeVisible();
  await comment.click({ force: true }); // (aria-disabled: Playwright would wait for it to be enabled)
  await expect(palette(page)).toBeVisible();
  await expect(page.getByTestId(TESTID.composer)).toHaveCount(0);
  await paletteInput(page).fill('accept the decl');
  await expect(item(page, 'accept-decline')).toContainText('focus a thread first');
  await page.keyboard.press('Escape');

  // Screen snips need the macOS picker: once the daemon said it has none, the command says so.
  mock.setScreenSnip({ mode: 'unsupported' });
  await page.getByTestId(TESTID.snipScreen).click();
  await expect(toastWith(page, 'Snipping the screen needs macOS')).toBeVisible();
  await focusUi(page);
  await openPalette(page, 'snip anywhere');
  await expect(item(page, 'snip-screen')).toHaveAttribute('aria-disabled', 'true');
  await expect(item(page, 'snip-screen')).toContainText('needs macOS');
  await page.keyboard.press('Escape');

  // With a selection, the same command opens the composer (focused).
  await ui.selectText('Remove the legacy session store.');
  await focusUi(page);
  await openPalette(page, 'comment on');
  await expect(item(page, 'comment')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(firstItem(page)).toHaveAttribute('data-command-id', 'comment');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(TESTID.composer)).toBeVisible();
  await expect(page.getByTestId(TESTID.composerTextarea)).toBeFocused();
  // (The browser logs the daemon's 501 for the screen snip.)
  expect(ui.errors.filter((e) => !/status of 501/.test(e))).toEqual([]);
});

test('"t4" jumps to a thread; headings, versions, compare in two steps; Backspace goes back; recent commands come first', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  await focusUi(page);

  await openPalette(page, 't4');
  await expect(firstItem(page)).toHaveAttribute('data-command-id', 'goto-thread:t4');
  await expect(firstItem(page)).toContainText('t4 · comment');
  await page.keyboard.press('Enter');
  await expect(ui.card('t4')).toHaveAttribute('aria-current', 'true');

  // Words of a comment find its thread.
  await openPalette(page, 'grace window');
  await expect(page.locator('.palette-section-title').first()).toHaveText('Threads');
  await page.keyboard.press('Escape');

  // A heading: the doc scrolls there.
  await openPalette(page, 'rollout checklist');
  await expect(firstItem(page)).toHaveAttribute('data-command-id', /^goto-section:\d+$/);
  await expect(firstItem(page)).toContainText('4 Rollout checklist');
  await page.keyboard.press('Enter');
  const f = await ui.frame();
  await expect.poll(() => f.evaluate(() => window.scrollY)).toBeGreaterThan(200);

  // Go to thread… opens a sub-list with a breadcrumb; Backspace in the empty input goes back.
  await openPalette(page, 'go to thread');
  await expect(firstItem(page)).toHaveAttribute('data-command-id', 'goto-thread');
  await page.keyboard.press('Enter');
  await expect(page.locator('.palette-crumbs')).toContainText('Go to thread');
  await expect(item(page, 'goto-thread:t1')).toBeVisible();
  await expect(paletteInput(page)).toHaveValue('');
  await expect(paletteInput(page)).toHaveAttribute('placeholder', /thread id like t4/);
  await page.keyboard.press('Backspace');
  await expect(page.locator('.palette-crumbs')).toHaveCount(0);
  await expect(item(page, 'verify')).toBeVisible();
  await page.keyboard.press('Escape');

  // Switch to version…: v1, then the doc shows v1.
  await openPalette(page, 'switch to version');
  await page.keyboard.press('Enter');
  await expect(item(page, 'switch-version:2')).toHaveAttribute('aria-disabled', 'true'); // shown now
  await paletteInput(page).fill('v1');
  await expect(firstItem(page)).toHaveAttribute('data-command-id', 'switch-version:1');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('1');
  await ui.ready();

  // Compare versions…: from v1, then to v2 (Changes with that pair).
  await focusUi(page);
  await openPalette(page, 'compare versions');
  await page.keyboard.press('Enter');
  await expect(item(page, 'compare:1')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.palette-crumbs')).toContainText('From v1');
  await expect(firstItem(page)).toHaveAttribute('data-command-id', 'compare:1:1-2');
  await page.keyboard.press('Enter');
  await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
  await expect(page.locator('#sr-base')).toHaveValue('1');

  // Recent: the commands run last, newest first, kept across reloads.
  await focusUi(page);
  await openPalette(page);
  await expect(page.locator('.palette-section-title').first()).toHaveText('Recent');
  const recent = page.locator('.palette-section').first().getByTestId(TESTID.commandItem);
  await expect(recent).toHaveCount(4);
  await expect(recent.nth(0)).toHaveAttribute('data-command-id', 'compare');
  await expect(recent.nth(1)).toHaveAttribute('data-command-id', 'switch-version');
  await expect(recent.nth(2)).toHaveAttribute('data-command-id', 'goto-section');
  await expect(recent.nth(3)).toHaveAttribute('data-command-id', 'goto-thread');
  await page.keyboard.press('Escape');
  await page.reload();
  await ui.ready();
  await focusUi(page);
  await openPalette(page);
  await expect(page.locator('.palette-section').first().getByTestId(TESTID.commandItem).first()).toHaveAttribute('data-command-id', 'compare');
  expect(ui.errors).toEqual([]);
});

test('palette-only commands: filters, submit as a verdict, mark all seen, record, close the session, another doc', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
  await focusUi(page);

  await openPalette(page, 'mark all changes seen');
  await page.keyboard.press('Enter');
  await expect(page.locator('.change-item.seen')).toHaveCount(3);
  await expect(page.locator('.changes-stats .progress')).toHaveText('3/3 reviewed');
  await openPalette(page, 'mark all changes seen');
  await expect(item(page, 'mark-seen')).toContainText('all changes are already seen');
  await page.keyboard.press('Escape');

  await openPalette(page, 'filter resolved');
  await expect(firstItem(page)).toHaveAttribute('data-command-id', 'filter-resolved');
  await page.keyboard.press('Enter');
  await expect(page.locator('.filter[data-filter="resolved"]')).toHaveAttribute('aria-selected', 'true');
  await expect(ui.card('t5')).toBeVisible();

  await openPalette(page, 'submit request changes');
  await expect(firstItem(page)).toHaveAttribute('data-command-id', 'submit-changes');
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId(TESTID.submitReviewDialog);
  await expect(dialog.locator('input[value="changes_requested"]')).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Record: only with unrecorded changes; it opens the banner's form with its summary focused.
  await openPalette(page, 'record working');
  await expect(item(page, 'record')).toContainText('no unrecorded changes');
  await page.keyboard.press('Escape');
  const d = mock.doc('kitchen-sink');
  d.setWorking(d.source(2).replace('Last revised 2026-10-11.', 'Last revised 2026-10-13.'));
  await expect(page.locator('.banner-warn')).toContainText('Unrecorded changes on disk');
  await focusUi(page);
  await openPalette(page, 'record working');
  await page.keyboard.press('Enter');
  const summary = page.getByLabel('Revision summary');
  await expect(summary).toBeFocused();
  await summary.fill('Fixed the date');
  await page.keyboard.press('Enter');
  await expect(toastWith(page, 'Recorded as v3')).toBeVisible();

  // Copy the "tell the agent" prompt.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: mock.uiOrigin });
  await focusUi(page);
  await openPalette(page, 'copy prompt');
  await expect(firstItem(page)).toHaveAttribute('data-command-id', 'copy-prompt');
  await page.keyboard.press('Enter');
  await expect(toastWith(page, 'Prompt copied')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Run `specreview feedback kitchen-sink` and address it.');
  await openPalette(page, 'copy spec path');
  await page.keyboard.press('Enter');
  await expect(toastWith(page, 'kitchen-sink.md')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${FIXTURE_DIR}/kitchen-sink.md`);

  // Close the session: asks first.
  await openPalette(page, 'close the review');
  await page.keyboard.press('Enter');
  await expect(page.locator('.palette-crumbs')).toContainText('Close the review session');
  await expect(firstItem(page)).toHaveAttribute('data-command-id', 'close-session:confirm');
  await page.keyboard.press('Enter');
  await expect(page.locator('.banner-muted')).toContainText('This review session is closed.');
  expect(d.doc.state).toBe('closed');

  // Another document.
  await focusUi(page);
  await openPalette(page, 'open another');
  await page.keyboard.press('Enter');
  await expect(item(page, 'open-doc:ws0e2e01/kitchen-sink')).toHaveAttribute('aria-disabled', 'true');
  await item(page, 'open-doc:ws0e2e01/app-spec').click();
  await expect(page).toHaveURL(/\/d\/ws0e2e01\/app-spec$/);
  await ui.ready();
  expect(ui.errors).toEqual([]);
});

test('on the doc list the palette offers what works there and opens a doc', async ({ page, mock }) => {
  await page.goto(mock.url());
  await expect(page.getByTestId(TESTID.docList).locator('li')).toHaveCount(2);
  await page.keyboard.press('t'); // the theme key works here too
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.keyboard.press(`${MOD}+k`);
  await expect(paletteInput(page)).toBeFocused();
  await expect(paletteInput(page)).toHaveAttribute('placeholder', 'Type a command…');
  await expect(item(page, 'comment')).toHaveCount(0);
  await expect(item(page, 'settings')).toBeVisible();
  await paletteInput(page).fill('open another');
  await page.keyboard.press('Enter');
  await paletteInput(page).fill('kitchen');
  await expect(firstItem(page)).toHaveAttribute('data-command-id', 'open-doc:ws0e2e01/kitchen-sink');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/d\/ws0e2e01\/kitchen-sink$/);
  await expect(page.getByTestId(TESTID.docFrame)).toBeVisible();
});

test('Settings: Cmd+, and the gear; theme, rail, thread panel, verdict, Send now confirmation, About; remembered', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await focusUi(page);
  const settings = page.getByTestId(TESTID.settingsDialog);
  await page.keyboard.press(`${MOD}+,`);
  await expect(settings).toBeVisible();
  await page.keyboard.press(`${MOD}+,`);
  await expect(settings).toHaveCount(0);
  await page.keyboard.press('Control+,');
  await expect(settings).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await page.getByTestId(TESTID.settingsOpen).click();
  await expect(settings).toBeVisible();

  // About.
  const about = settings.locator('[data-setting="about"]');
  await expect(about.locator('[data-about="version"]')).toHaveText('v0.0.0-mock');
  await expect(about.locator('[data-about="root"]')).toHaveText(FIXTURE_DIR);
  await expect(about.locator('[data-about="path"]')).toHaveText(`${FIXTURE_DIR}/kitchen-sink.md`);
  await expect(about.locator('[data-about="ports"]')).toHaveText(`UI ${new URL(mock.uiOrigin).port} · content ${new URL(mock.contentOrigin).port}`);
  await expect(about).toContainText('specreview feedback kitchen-sink');

  // Theme: the same state as `t`.
  await settings.getByRole('radio', { name: 'Dark' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Outline rail: Never hides it beside the doc (the menu button shows it again), Always / Auto.
  const nav = page.locator('#sr-nav');
  await expect(nav).toBeVisible();
  await settings.getByRole('radio', { name: 'Never' }).check();
  await expect(nav).toBeHidden();
  await expect(page.locator('button[aria-controls="sr-nav"]')).toBeVisible();

  // Thread panel open by default: off hides it now and on the next load.
  await settings.getByRole('switch', { name: 'Thread panel open by default' }).uncheck();
  await expect(page.locator('#sr-side')).toBeHidden();

  // Default verdict when nothing is blocking.
  await settings.locator('[data-setting="defaultVerdict"]').getByRole('radio', { name: 'Request changes' }).check();
  // Ask before Send now.
  await settings.getByRole('switch', { name: 'Ask before Send now' }).check();
  await page.keyboard.press('Escape');

  await page.reload();
  await ui.ready();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(nav).toBeHidden();
  await expect(page.locator('#sr-side')).toBeHidden();
  await page.locator('button[aria-controls="sr-nav"]').click();
  await expect(nav).toBeVisible();
  await page.locator('button[aria-controls="sr-nav"]').click();
  await expect(nav).toBeHidden();

  await page.getByTestId(TESTID.submitReviewOpen).click();
  await expect(page.getByTestId(TESTID.submitReviewDialog).locator('input[value="changes_requested"]')).toBeChecked();
  await page.keyboard.press('Escape');

  // Ask before Send now: the key asks first; nothing goes out until confirmed.
  await page.locator('.threads-toggle').click();
  await modeTab(page, 'review').click();
  await page.getByRole('button', { name: 'General comment' }).click();
  await page.getByTestId(TESTID.composerTextarea).fill('Ship it after the load test.');
  await page.keyboard.press(`${MOD}+Shift+Enter`);
  const confirm = page.locator('[data-confirm-send]');
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('button', { name: 'Send now' })).toBeFocused();
  const reviews = () => mock.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/reviews')).length;
  expect(reviews()).toBe(0);
  await page.keyboard.press('Escape'); // backs out of the question, keeps the comment
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId(TESTID.composerTextarea)).toHaveValue('Ship it after the load test.');
  await page.getByTestId(TESTID.composerSendNow).click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Send now' }).click();
  await expect(toastWith(page, 'Sent to the agent.')).toBeVisible();
  expect(reviews()).toBe(1);

  // Back to the defaults: Auto rail and the panel open by default.
  await page.getByTestId(TESTID.settingsOpen).click();
  await settings.getByRole('radio', { name: 'Always' }).check();
  await expect(nav).toBeVisible();
  await settings.getByRole('radio', { name: 'Auto' }).check();
  await settings.getByRole('switch', { name: 'Thread panel open by default' }).check();
  await expect(page.locator('#sr-side')).toBeVisible();
  await expect(page.locator('button[aria-controls="sr-nav"]')).toHaveCount(0);
  expect(ui.errors).toEqual([]);
});

test('Settings: "Switch to Changes" on a new version, never while a comment is open', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await modeTab(page, 'review').click();
  await page.getByTestId(TESTID.settingsOpen).click();
  await page.getByTestId(TESTID.settingsDialog).getByRole('radio', { name: 'Switch to Changes' }).check();
  await page.keyboard.press('Escape');
  const d = mock.doc('kitchen-sink');
  d.revise({ source: d.source(2).replace('Last revised 2026-10-11.', 'Last revised 2026-10-12.'), summary: 'date' });
  await expect(toastWith(page, 'Showing what changed')).toBeVisible();
  await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('3');

  // With a comment open, only the toast (and the banner) say so.
  await modeTab(page, 'review').click();
  await page.getByRole('button', { name: 'General comment' }).click();
  await page.getByTestId(TESTID.composerTextarea).fill('Hold on');
  d.revise({ source: d.source(3).replace('Last revised 2026-10-12.', 'Last revised 2026-10-14.'), summary: 'date again' });
  await expect(toastWith(page, 'v4 ready')).toBeVisible();
  await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('3');
  await expect(page.getByTestId(TESTID.composerTextarea)).toHaveValue('Hold on');
  expect(ui.errors).toEqual([]);
});

test('single-letter shortcuts off: letters do nothing in the UI or the doc; Esc and Cmd combos work; remembered', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  await modeTab(page, 'review').click();
  await page.getByTestId(TESTID.settingsOpen).click();
  const settings = page.getByTestId(TESTID.settingsDialog);
  await expect(settings).toContainText('Single-letter shortcuts');
  await settings.getByRole('switch', { name: 'Single-letter shortcuts' }).uncheck();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await ui.inspect()).prefs?.singleKeys).toBe(false);

  const composer = page.getByTestId(TESTID.composer);
  const snipTool = page.getByTestId(TESTID.snipTool);
  // In the UI.
  await ui.selectText('Remove the legacy session store.');
  await focusUi(page);
  for (const key of ['c', 'b', 'j', '2', '?']) await page.keyboard.press(key);
  await page.waitForTimeout(300);
  await expect(composer).toHaveCount(0);
  await expect(snipTool).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-testid="thread-card"][aria-current="true"]')).toHaveCount(0);
  await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId(TESTID.helpOverlay)).toHaveCount(0);

  // In the doc: the guest neither acts on c / b nor does the UI.
  await focusDoc(ui);
  await ui.selectText('Remove the legacy session store.');
  for (const key of ['c', 'b', 'j']) await page.keyboard.press(key);
  await page.waitForTimeout(400);
  await expect(composer).toHaveCount(0);
  await expect(snipTool).toHaveAttribute('aria-pressed', 'false');
  expect((await ui.inspect()).snip.active).toBe(false);

  // Cmd+K still works from the doc; the help shows those keys as off.
  await page.keyboard.press(`${MOD}+k`);
  await expect(palette(page)).toBeVisible();
  await expect(item(page, 'verify').locator('.pi-keys')).toHaveCount(0);
  await expect(item(page, 'submit').locator('.pi-keys kbd')).toHaveText(/^(⌘⇧↵|Ctrl\+Shift\+Enter)$/);
  await page.keyboard.press(`${MOD}+/`);
  const help = page.getByTestId(TESTID.helpOverlay);
  await expect(help).toBeVisible();
  await expect(palette(page)).toHaveCount(0);
  await expect(help.locator('[data-key-row="comment"] .keys')).toHaveText('off (Settings)');
  await expect(help.locator('[data-key-row="submit"] kbd')).toHaveText(/^(⌘⇧↵|Ctrl\+Shift\+Enter)$/);
  await page.keyboard.press('Escape');

  // Remembered, and sent to the guest with init.
  await page.reload();
  await ui.ready();
  await expect.poll(async () => (await ui.inspect()).prefs?.singleKeys).toBe(false);
  await focusUi(page);
  await page.keyboard.press('h');
  await page.waitForTimeout(200);
  expect((await ui.inspect()).hidden).toBe(false);

  // On again from the palette: letters work in the UI and in the doc.
  await openPalette(page, 'single letter');
  await page.keyboard.press('Enter');
  await expect(toastWith(page, 'Single-letter shortcuts are on')).toBeVisible();
  await expect.poll(async () => (await ui.inspect()).prefs?.singleKeys).toBe(true);
  await focusDoc(ui);
  await ui.selectText('Remove the legacy session store.');
  await page.keyboard.press('c');
  await expect(composer).toBeVisible();
  expect(ui.errors).toEqual([]);
});

test('keyboard shortcuts: Cmd+/ and ?, generated from the command registry, with a filter', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  await focusUi(page);
  const help = page.getByTestId(TESTID.helpOverlay);
  await page.keyboard.press(`${MOD}+/`);
  await expect(help).toBeVisible();
  await expect(help.locator('.keymap-group th')).toHaveText(['Comment', 'Review', 'Navigate', 'View', 'App']);
  await expect(help.locator('[data-key-row="palette"] kbd')).toHaveText(/^(⌘K|Ctrl\+K)$/);
  await expect(help.locator('[data-key-row="settings"] kbd')).toHaveText(/^(⌘,|Ctrl\+,)$/);
  await expect(help.locator('[data-key-row="help"] kbd')).toHaveText([/^(⌘\/|Ctrl\+\/)$/, '?']);
  await expect(help).toContainText('Everything is also in the command palette');

  // The rows are exactly the registry's help rows.
  const fromRegistry = await page.evaluate(async () => {
    const m = await import('/ui/commands.js');
    return m.helpGroups().flatMap((/** @type {any} */ g) => g.rows.map((/** @type {any} */ r) => r.id));
  });
  const shown = await help.locator('[data-key-row]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-key-row')));
  expect(shown).toEqual(fromRegistry);

  const filter = help.getByRole('searchbox', { name: 'Filter shortcuts' });
  await filter.fill('snip');
  await expect(help.locator('[data-key-row]')).toHaveCount(2);
  await expect(help.locator('[data-key-row="snip"]')).toBeVisible();
  await filter.fill('zzqx');
  await expect(help).toContainText('No shortcut matches');
  await page.keyboard.press(`${MOD}+/`);
  await expect(help).toHaveCount(0);

  await page.keyboard.press('?');
  await expect(help).toBeVisible();
  await page.keyboard.press('?');
  await expect(help).toHaveCount(0);
  await page.getByTestId(TESTID.helpOpen).click();
  await expect(help).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  expect(ui.errors).toEqual([]);
});

test('Cmd+K inside the composer opens the palette and keeps the draft; one dialog at a time', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  await modeTab(page, 'review').click();
  await page.getByRole('button', { name: 'General comment' }).click();
  const ta = page.getByTestId(TESTID.composerTextarea);
  await expect(ta).toBeFocused();
  await page.keyboard.type('Keep this text');
  await page.keyboard.press(`${MOD}+k`);
  await expect(palette(page)).toBeVisible();
  await expect(ta).toHaveValue('Keep this text');
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
  await expect(ta).toBeFocused();
  await expect(ta).toHaveValue('Keep this text');

  // Settings from the textarea, then the palette over it, then the help: each replaces the other.
  await page.keyboard.press(`${MOD}+,`);
  await expect(page.getByTestId(TESTID.settingsDialog)).toBeVisible();
  await page.keyboard.press(`${MOD}+k`);
  await expect(palette(page)).toBeVisible();
  await expect(page.getByTestId(TESTID.settingsDialog)).toHaveCount(0);
  await page.keyboard.press(`${MOD}+/`);
  await expect(page.getByTestId(TESTID.helpOverlay)).toBeVisible();
  await expect(palette(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(TESTID.helpOverlay)).toHaveCount(0);
  await expect(ta).toHaveValue('Keep this text');

  // A reply box keeps its text too.
  await page.getByTestId(TESTID.composer).getByRole('button', { name: 'Cancel' }).click();
  await ui.card('t3').getByRole('button', { name: 'Reply', exact: true }).click();
  const reply = page.getByTestId(TESTID.replyTextarea);
  await reply.fill('Still open?');
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reply).toBeFocused();
  await expect(reply).toHaveValue('Still open?');
  expect(ui.errors).toEqual([]);
});

test.describe('narrow viewport (600 px)', () => {
  test.use({ viewport: { width: 600, height: 860 } });

  test('the palette and Settings fit the width; the menu toggles the outline drawer', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await page.getByTestId(TESTID.commandPaletteOpen).click();
    const box = await palette(page).boundingBox();
    expect(box?.width).toBeLessThanOrEqual(600);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await paletteInput(page).fill('toggle the outline');
    await page.keyboard.press('Enter');
    await expect(page.locator('#sr-nav')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press(`${MOD}+,`);
    const s = await page.getByTestId(TESTID.settingsDialog).boundingBox();
    expect(s?.width).toBeLessThanOrEqual(600);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    expect(ui.errors).toEqual([]);
  });
});
