// @ts-check
// The reviewer's own versions made from the page (actions.js ownRecord: Record as my revision, a code review's
// Re-snapshot, Apply now of a suggestion), and a plan's keys:
//   - one toast says it; its version.created event announces nothing more (no "Updated to vN", no note, no tab badge);
//   - the view shows it whatever "When Claude records a new version" says, but only forward and never over an open
//     comment (no warning then: the banner offers it);
//   - an answer that comes after the reviewer moved to another doc is dropped, and leaves nothing behind for that doc;
//   - on a plan (Claude Code's plan mode), the palette and Settings show the composer's keys as they work there
//     (comments wait as drafts, model.js sendModeOf).

import { CODE_TESTID, TESTID } from '../../src/shared/protocol.js';
import { expect, test } from './fixtures.mjs';
import { A_V2 } from './mock-code.mjs';

/** @typedef {import('@playwright/test').Page} Page */

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
/** @param {Page} page @param {string|RegExp} text */
const toastWith = (page, text) => page.getByTestId(TESTID.toast).filter({ hasText: text });
/** @param {Page} page */
const picker = (page) => page.getByTestId(TESTID.versionPicker);
/** @param {Page} page */
const focusUi = (page) => page.evaluate(() => /** @type {HTMLElement|null} */ (document.activeElement)?.blur?.());

/** Sets preferences before the app loads (over the legacy pin). @param {Page} page @param {Record<string, string>} prefs */
async function setPrefs(page, prefs) {
  await page.addInitScript((p) => {
    if (window.top !== window) return;
    for (const [k, v] of Object.entries(p)) localStorage.setItem(`suiko.${k}`, v);
  }, prefs);
}

/**
 * Holds the HTTP answer of POST .../record: the mock records the version (and emits version.created) at once; the UI
 * gets the answer only on release().
 * @param {Page} page @param {any} mock
 */
async function holdRecord(page, mock) {
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((/** @type {(v?: any) => void} */ r) => { release = r; });
  await page.route('**/record', async (route) => {
    const resp = await route.fetch({ headers: { ...(await route.request().allHeaders()), origin: mock.uiOrigin } });
    await gate;
    await route.fulfill({ response: resp });
  });
  return { release: () => release() };
}

/** Another doc in the same page (the app's own navigation: module state stays). @param {Page} page @param {any} d */
async function openInPage(page, d) {
  await page.evaluate((p) => {
    history.pushState({}, '', p);
    dispatchEvent(new PopStateEvent('popstate'));
  }, `/d/${encodeURIComponent(d.ws)}/${encodeURIComponent(d.id)}`);
}

/** @param {Page} page */
async function recordViaBanner(page) {
  await page.getByRole('button', { name: 'Record as my revision' }).click();
  await page.getByRole('textbox', { name: 'Revision summary' }).fill('my edit');
  await page.getByRole('button', { name: 'Record', exact: true }).click();
}

/** A suggestion on "Ship rotation behind a flag.", sent at once, then Apply now. @param {Page} page @param {any} ui */
async function applyNowOnASuggestion(page, ui) {
  await ui.selectText('Ship rotation behind a flag.');
  await focusUi(page);
  await page.keyboard.press('s');
  await page.getByTestId(TESTID.composerSuggestion).fill('Ship rotation behind the token-rotation flag.');
  await page.getByTestId(TESTID.composerSendNow).click();
  await expect(ui.card('t1')).toBeVisible();
  await ui.card('t1').getByRole('button', { name: 'Apply now' }).click();
  await expect(toastWith(page, 'Suggestion applied as v2.')).toBeVisible();
}

test.describe('fresh', () => {
  test.use(/** @type {any} */ ({ scenario: 'fresh', prefs: 'defaults' }));

  test('a plan: the palette and Settings show the composer\'s keys as they work there (comments wait as drafts)', async ({ page, ui, mock }) => {
    const d = mock.doc('kitchen-sink');
    d.doc.kind = 'snapshot';
    d.doc.origin = { type: 'plan', key: 'claude-plan:s1:inline', session: 's1' };
    await setPrefs(page, { sendMode: 'now' });
    await ui.open('kitchen-sink');
    // the help overlay follows the plan (Add to review first)...
    await focusUi(page);
    await page.keyboard.press(`${MOD}+/`);
    const helpAdd = await page.locator('[data-key-row="add"] kbd').allInnerTexts();
    const helpSend = await page.locator('[data-key-row="send-now"] kbd').allInnerTexts();
    expect(helpAdd.length).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    // ...and so does the palette: the same keys for the same commands
    await focusUi(page);
    await page.keyboard.press(`${MOD}+k`);
    const row = (/** @type {string} */ id) => page.locator(`[data-testid="${TESTID.commandItem}"][data-command-id="${id}"]`);
    await expect(row('add')).toBeVisible();
    expect(await row('add').locator('.pi-keys kbd').allInnerTexts()).toEqual(helpAdd);
    expect(await row('send-now').locator('.pi-keys kbd').allInnerTexts()).toEqual(helpSend);
    await page.keyboard.press('Escape');
    // Settings > Sending: the note, and "Ask before sending" names Send now (what asks on a plan)
    await ui.settings('sending');
    const dialog = page.getByTestId(TESTID.settingsDialog);
    await expect(dialog).toContainText('This document is a plan');
    await expect(dialog.locator('.setting', { has: page.locator('#sr-set-confirm') }).locator('.setting-hint')).toContainText('Send now');
    expect(ui.errors).toEqual([]);
  });

  test('Apply now with "Just tell me": one toast, no note, no tab badge, and the reviewer\'s version is shown', async ({ page, ui }) => {
    await setPrefs(page, { onNewVersion: 'toast', openIn: 'review', sendMode: 'now' });
    await ui.open('kitchen-sink');
    await applyNowOnASuggestion(page, ui);
    await expect(picker(page)).toHaveValue('2');
    await page.waitForTimeout(600);
    await expect(toastWith(page, /recorded v2/)).toHaveCount(0);
    await expect(page).not.toHaveTitle(/\(v2\)/);
    expect(ui.errors).toEqual([]);
  });

  test('Apply now with "Show the new version": no "Updated to v2" after "Suggestion applied as v2."', async ({ page, ui }) => {
    await setPrefs(page, { onNewVersion: 'latest', openIn: 'review', sendMode: 'now' });
    await ui.open('kitchen-sink');
    await applyNowOnASuggestion(page, ui);
    await expect(picker(page)).toHaveValue('2');
    await page.waitForTimeout(600);
    await expect(toastWith(page, 'Updated to v2')).toHaveCount(0);
    await expect(page).not.toHaveTitle(/\(v2\)/);
    expect(ui.errors).toEqual([]);
  });

  test('a record answered after the reviewer moved to another doc: nothing of it reaches that doc', async ({ page, ui, mock }) => {
    await setPrefs(page, { onNewVersion: 'toast', openIn: 'review' });
    const ks = mock.doc('kitchen-sink');
    const app = mock.doc('app-spec');
    await ui.open('kitchen-sink');
    const hold = await holdRecord(page, mock);
    ks.setWorking(`${ks.source(1)}\nA reviewer note.\n`);
    await recordViaBanner(page);
    await expect.poll(() => ks.head).toBe(2);
    await openInPage(page, app);
    await ui.ready();
    hold.release();
    await page.waitForTimeout(800);
    // kitchen-sink's answer is dropped on app-spec
    await expect(toastWith(page, 'Recorded as v2')).toHaveCount(0);
    // and app-spec's own v2 (the agent's) is announced as usual
    app.revise({ source: app.source(1).replace('</p>', ' (rev 2)</p>'), summary: 'agent v2' });
    await expect(toastWith(page, /recorded v2/)).toBeVisible();
    await expect(page).toHaveTitle(/\(v2\)/);
    expect(ui.errors).toEqual([]);
  });
});

test.describe('round2', () => {
  test.use(/** @type {any} */ ({ scenario: 'round2', prefs: 'defaults' }));

  test('an agent version shown while the reviewer\'s record is in flight stays shown', async ({ page, ui, mock }) => {
    await setPrefs(page, { onNewVersion: 'latest', openIn: 'review' });
    const ks = mock.doc('kitchen-sink');
    await ui.open('kitchen-sink');
    await expect(picker(page)).toHaveValue('2');
    const hold = await holdRecord(page, mock);
    ks.setWorking(`${ks.source(2)}\nA reviewer note.\n`);
    await recordViaBanner(page);
    await expect.poll(() => ks.head).toBe(3);
    ks.revise({ source: `${ks.source(3)}\nAn agent note.\n`, summary: 'agent v4' });
    await expect(picker(page)).toHaveValue('4');
    hold.release();
    await expect(toastWith(page, 'Recorded as v3')).toBeVisible();
    await page.waitForTimeout(600);
    // the record does not take the view back to its older v3
    await expect(picker(page)).toHaveValue('4');
    expect(ui.errors).toEqual([]);
  });
});

test.describe('code', () => {
  test.use(/** @type {any} */ ({ scenario: 'code', prefs: 'defaults' }));

  test('Re-snapshot with a comment open: no warning, the comment stays, the banner offers the new round', async ({ page, ui, mock }) => {
    await page.goto(ui.mock.url('cr-feat'));
    await expect(page.locator('[data-view="code"][data-ready]')).toBeAttached({ timeout: 15000 });
    if (await page.locator('#sr-mode').isVisible()) await page.locator('#sr-mode').selectOption('review');
    else await page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="review"]`).click();
    await expect(page.locator('[data-view="code"][data-mode="files"][data-ready]')).toBeAttached();
    await page.locator(`[data-testid="${CODE_TESTID.fileDiff}"][data-path="src/a.js"]`)
      .locator(`[data-testid="${CODE_TESTID.lineBtn}"][data-side="new"][data-line="3"]`).click();
    await page.keyboard.press('c');
    await page.getByTestId(TESTID.composerTextarea).fill('Half-written comment');
    mock.doc('cr-feat').setWorking({ 'src/a.js': `${A_V2}export const extra = 1;\n` });
    await expect(page.getByTestId(CODE_TESTID.resnapshot)).toBeEnabled();
    await page.getByTestId(CODE_TESTID.resnapshot).click();
    await expect(toastWith(page, 'Recorded as v3')).toBeVisible();
    // the record's refresh comes after its toast: watch a while for a switch nobody asked for (and its warning)
    for (let i = 0; i < 15; i++) {
      expect(await toastWith(page, 'Finish or cancel').count()).toBe(0);
      await page.waitForTimeout(100);
    }
    await expect(page.getByTestId(TESTID.composerTextarea)).toHaveValue('Half-written comment');
    await expect(picker(page)).toHaveValue('2');
    await expect(page.locator('.banners')).toContainText('latest is v3');
    expect(ui.errors).toEqual([]);
  });
});
