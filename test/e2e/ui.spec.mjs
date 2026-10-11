// @ts-check
// Layout, theming and keyboard against the mock daemon (scenario 'round2'): the narrow (< 900 px) drawer layout,
// the theme toggle (light / dark custom properties, the doc follows), the keyboard map (?, 1-4, j / k, x, e, c, Esc,
// h, \, keys forwarded from the doc), Source mode line comments, History actions, the doc list on the home page,
// and the reconnect banner when the daemon rejects the token.

import { TESTID } from '../../src/shared/protocol.js';
import { expect, test } from './fixtures.mjs';

test.use({ scenario: 'round2' });

/** @param {import('@playwright/test').Page} page @param {string} mode */
const modeTab = (page, mode) => page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="${mode}"]`);

/** Moves keyboard focus back to the UI document (out of the doc iframe). @param {import('@playwright/test').Page} page */
async function focusUi(page) {
  await page.evaluate(() => /** @type {HTMLElement|null} */ (document.activeElement)?.blur?.());
}

/** @param {import('@playwright/test').Page} page */
const horizontalOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe('narrow viewport (600 px)', () => {
  test.use({ viewport: { width: 600, height: 860 } });

  test('threads and outline become drawers, modes a dropdown, the doc is full width, no horizontal scroll', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await expect(page.locator('.mode-tabs')).toBeHidden();
    const modeSelect = page.locator('#sr-mode');
    await expect(modeSelect).toHaveValue('changes');
    await modeSelect.selectOption('review');
    await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');

    const side = page.locator('#sr-side');
    await expect(side).toBeHidden();
    const frameBox = await page.getByTestId(TESTID.docFrame).boundingBox();
    expect(frameBox?.width).toBeGreaterThan(580);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // "Threads (5)" opens the drawer over the doc; Esc closes it.
    await page.locator('.threads-toggle').click();
    await expect(side).toBeVisible();
    await expect(side.getByTestId(TESTID.threadPanel)).toBeVisible();
    await expect(side.getByTestId(TESTID.threadCard)).toHaveCount(5);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.keyboard.press('Escape');
    await expect(side).toBeHidden();

    // Clicking a pin in the doc opens the drawer on that thread.
    const f = await ui.frame();
    await f.evaluate(() => document.querySelector('img')?.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const box = /** @type {{x: number, y: number}} */ (frameBox);
    // The doc may still be laying out (mermaid renders late under load), so the pin can move between reading its
    // rect and clicking: click once its position is stable, and retry when the click missed.
    await expect(async () => {
      /** @type {any} */
      let pin = null;
      let last = '';
      await expect.poll(async () => {
        pin = (await ui.inspect()).layers.pins?.find((/** @type {any} */ p) => p.key === 'pin:t2');
        const ok = !!pin && pin.rect.top > 0 && pin.rect.bottom < 780;
        const key = ok ? `${Math.round(pin.rect.left)},${Math.round(pin.rect.top)}` : '';
        const stable = ok && key === last;
        last = key;
        return stable;
      }, { intervals: [100] }).toBe(true);
      await page.mouse.click(box.x + pin.rect.left + pin.rect.width / 2, box.y + pin.rect.top + pin.rect.height / 2);
      await expect(side).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 15000 });
    await expect(ui.card('t2')).toHaveAttribute('aria-current', 'true');
    await page.locator('#sr-side .drawer-head').getByRole('button', { name: 'Close panel' }).click();
    await expect(side).toBeHidden();

    // The outline drawer: jumping to a heading closes it.
    await page.locator('button[aria-controls="sr-nav"]').click();
    const nav = page.locator('#sr-nav');
    await expect(nav).toBeVisible();
    await nav.locator('.outline-link', { hasText: '4 Rollout checklist' }).click();
    await expect(nav).toBeHidden();
    await expect.poll(() => f.evaluate(() => window.scrollY)).toBeGreaterThan(200);

    // A comment opens the composer in the drawer.
    await ui.selectText('Enable rotation for 10% of clients');
    await focusUi(page);
    await page.keyboard.press('c');
    await expect(side).toBeVisible();
    await expect(side.getByTestId(TESTID.composer)).toBeVisible();
    await expect(side.getByTestId(TESTID.composerTextarea)).toBeFocused();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expect(ui.errors).toEqual([]);
  });
});

test('theme toggle: light and dark custom properties, explicit body background, the doc follows, persisted', async ({ page, ui }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await ui.open('kitchen-sink');
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await bg();
  expect(light).toMatch(/^rgb\(/);
  const toggle = page.locator('[data-theme-toggle]');
  await toggle.click(); // system -> light
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await toggle.click(); // light -> dark
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const dark = await bg();
  expect(dark).not.toBe(light);
  const [r, g, b] = (dark.match(/\d+/g) || []).map(Number);
  expect(r + g + b).toBeLessThan(150);
  await expect.poll(async () => (await ui.inspect()).theme).toBe('dark');
  const f = await ui.frame();
  await expect.poll(() => f.evaluate(() => document.querySelector('link[data-sr-theme="dark"]')?.getAttribute('media'))).toBe('all');

  // Kept across reloads; the guest gets it with init.
  await page.reload();
  await ui.ready();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(async () => (await ui.inspect()).theme).toBe('dark');

  // Back to "system": follows prefers-color-scheme.
  await page.locator('[data-theme-toggle]').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  expect(await bg()).toBe(light);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(bg).toBe(dark);
  expect(ui.errors).toEqual([]);
});

test('keyboard: ?, 1-4, j / k, x, e + Esc, c, Esc cancels, h, \\, and keys forwarded from the doc', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await focusUi(page);

  await page.keyboard.press('?');
  const help = page.getByTestId('help-overlay');
  await expect(help).toBeVisible();
  await expect(help).toContainText('Next / previous thread');
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();

  for (const [key, mode] of [['3', 'source'], ['4', 'history'], ['2', 'changes'], ['1', 'review']]) {
    await page.keyboard.press(key);
    await expect(modeTab(page, mode)).toHaveAttribute('aria-selected', 'true');
  }

  // j / k walk the Open threads in document order (t2 image L29, t3 cell L46, t1 L51, ...).
  await page.keyboard.press('j');
  await expect(ui.card('t2')).toHaveAttribute('aria-current', 'true');
  await expect.poll(async () => (await ui.inspect()).activeId).toBe('t2');
  await page.keyboard.press('j');
  await expect(ui.card('t3')).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('k');
  await expect(ui.card('t2')).toHaveAttribute('aria-current', 'true');
  // x accepts the focused (answered) thread.
  await page.keyboard.press('x');
  await expect.poll(() => mock.doc('kitchen-sink').thread('t2').status).toBe('resolved');

  // e toggles pick mode; Esc leaves it.
  const pick = page.getByTestId(TESTID.pickTool);
  await page.keyboard.press('e');
  await expect(pick).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await ui.inspect()).picker.active).toBe(true);
  await page.keyboard.press('Escape');
  await expect(pick).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await ui.inspect()).picker.active).toBe(false);

  // c without a selection explains what to do; with one it opens the composer. Esc cancels with Undo.
  await page.keyboard.press('c');
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'Select text in the document first' })).toBeVisible();
  await ui.selectText('Remove the legacy session store.');
  await focusUi(page);
  await page.keyboard.press('c');
  await expect(page.getByTestId(TESTID.composer)).toBeVisible();
  await expect(page.getByTestId(TESTID.composerTextarea)).toBeFocused();
  await page.keyboard.type('Which release?');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(TESTID.composer)).toBeHidden();
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'Comment discarded' })).toBeVisible();

  // h hides the annotations in the doc; \ toggles the side panel.
  await focusUi(page);
  await page.keyboard.press('h');
  await expect.poll(async () => (await ui.inspect()).hidden).toBe(true);
  await page.keyboard.press('h');
  await expect.poll(async () => (await ui.inspect()).hidden).toBe(false);
  await page.keyboard.press('\\');
  await expect(page.getByTestId(TESTID.threadPanel)).toBeHidden();
  await page.keyboard.press('\\');
  await expect(page.getByTestId(TESTID.threadPanel)).toBeVisible();

  // Keys typed with focus inside the doc are forwarded: navigation works, mutations (x) do not.
  await page.keyboard.press('j'); // t3 (t2 is resolved now and left the Open list)
  await expect(ui.card('t3')).toHaveAttribute('aria-current', 'true');
  const p = await ui.pointIn('p', 'This spec describes');
  await page.mouse.click(p.x + 5, p.cy);
  await page.keyboard.press('x');
  await page.keyboard.press('2');
  await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
  expect(mock.doc('kitchen-sink').thread('t3').status).toBe('open');
  expect(ui.errors).toEqual([]);
});

test('Source mode: diff against the base, numbered source, select lines and press c', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await modeTab(page, 'source').click();
  const view = page.locator('.source-view');
  await expect(view.locator('.diff-hunk')).toHaveCount(3);
  await expect(view.locator('.diff-hunk').first().locator('.hunk-head')).toContainText('t1');
  await expect(view.locator('.diff-hunk').first().locator('tr.op-ins ins')).toContainText('reuse-detection grace window');
  await view.locator('.seg').getByRole('button', { name: 'Split' }).click();
  await expect(view.locator('.diff-table.split').first()).toBeVisible();

  await view.getByLabel(/Diff against v1/).uncheck();
  const lines = mock.doc('kitchen-sink').source(2).replace(/\n$/, '').split('\n').length;
  await expect(view.locator('.code-table tbody tr')).toHaveCount(lines);
  await view.getByRole('button', { name: 'Line 51', exact: true }).click();
  await view.getByRole('button', { name: 'Line 52', exact: true }).click({ modifiers: ['Shift'] });
  await expect(view.locator('.sel-bar')).toContainText('L51-52');
  await page.keyboard.press('c');
  const composer = page.getByTestId(TESTID.composer);
  await expect(composer).toBeVisible();
  await expect(composer.locator('.agent-sees')).toContainText('L51-52');
  await page.getByTestId(TESTID.composerTextarea).fill('Split this paragraph.');
  await page.getByTestId(TESTID.composerAdd).click();
  await expect(composer).toBeHidden();
  const [item] = mock.doc('kitchen-sink').drafts.items;
  expect(item.anchor).toMatchObject({ kind: 'source', src: { startLine: 51, endLine: 52 } });
});

test('History: versions and reviews interleaved; View an old version, Diff vs previous', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  await modeTab(page, 'history').click();
  const rows = page.getByTestId(TESTID.historyRow);
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('data-version', '2');
  await expect(page.locator('.tl-review')).toContainText('Changes requested');
  await expect(page.locator('.tl-review')).toContainText('delivered to claude');

  await rows.and(page.locator('[data-version="1"]')).getByRole('button', { name: 'View' }).click();
  await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('1');
  await expect(page.locator('.banner-info')).toContainText('You are viewing v1');
  await ui.ready();
  await expect.poll(async () => (await ui.frame()).url()).toContain('/v1/');

  await modeTab(page, 'history').click();
  await rows.and(page.locator('[data-version="2"]')).getByRole('button', { name: 'Diff vs previous' }).click();
  await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
  await expect(page.locator('#sr-base')).toHaveValue('1');
  await expect(page.getByTestId(TESTID.changeItem)).toHaveCount(3);

  // Compare with...: any pair.
  await modeTab(page, 'history').click();
  await rows.and(page.locator('[data-version="1"]')).getByRole('button', { name: 'Compare with...' }).click();
  await page.locator('#cmp-1').selectOption('2');
  await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
  await expect(page.locator('#sr-base')).toHaveValue('1');
});

test('home lists every tracked doc and follows the event stream', async ({ page, mock }) => {
  await page.goto(mock.url());
  const list = page.getByTestId(TESTID.docList);
  await expect(list.locator('li')).toHaveCount(2);
  expect(page.url()).not.toContain('k=');
  const ks = list.locator('li', { hasText: 'kitchen-sink.md' });
  await expect(ks).toContainText('v2');
  await expect(ks).toContainText('In review');
  await expect(ks).toContainText('5 open');
  await expect(ks).not.toContainText('listening');
  mock.doc('kitchen-sink').setWaiters([{ agent: 'claude' }]);
  await expect(ks).toContainText('listening');
  await ks.getByRole('link').click();
  await expect(page).toHaveURL(/\/d\/ws0e2e01\/kitchen-sink$/);
  await expect(page.getByTestId(TESTID.docFrame)).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId(TESTID.docList)).toBeVisible();
});

test('a rejected token shows the reconnect banner until the daemon accepts it again', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  mock.setAcceptedToken('rotated-token');
  const banner = page.locator('.banner-conn');
  await expect(banner).toBeVisible({ timeout: 15000 });
  await expect(banner).toContainText('Reconnecting to SpecReview...');
  await expect(banner).toContainText('access token was rejected');
  mock.setAcceptedToken(null);
  await expect(banner).toBeHidden({ timeout: 15000 });
  // The event stream is back: a new version still arrives.
  const d = mock.doc('kitchen-sink');
  d.revise({ source: d.source(2).replace('Last revised 2026-10-11.', 'Last revised 2026-10-12.'), summary: 'date' });
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'v3 ready' })).toBeVisible();
});
