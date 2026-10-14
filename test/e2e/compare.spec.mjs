// @ts-check
// Reading and comparing against the mock daemon (scenario 'round2': kitchen-sink.md v2 answers rv1, see
// mock-data.mjs): Read mode (the latest version with nothing drawn over it), the "[v1 · last review] → [v2]" range of
// Changes, Changes side by side (the older version in a second, read-only frame, removed text struck through, scrolled
// together, the newer frame never reloaded), and Accept all in the Verify queue (with Undo; declines stay).

import { TESTID } from '../../src/shared/protocol.js';
import { expect, test } from './fixtures.mjs';

test.use({ scenario: 'round2' });

/** @param {import('@playwright/test').Page} page @param {string} mode */
const modeTab = (page, mode) => page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="${mode}"]`);

/** Moves keyboard focus into the UI document (not the doc iframe) without pressing a control. @param {import('@playwright/test').Page} page */
async function focusUi(page) {
  await page.evaluate(() => {
    /** @type {HTMLElement|null} */ (document.activeElement)?.blur?.();
    document.body.focus();
  });
}

/** Total ranges of the thread / draft / lock highlights the guest paints. @param {any} ins */
const threadHighlights = (ins) => ['sr-open', 'sr-resolved', 'sr-active', 'sr-draft', 'sr-lock', 'sr-outdated']
  .reduce((n, k) => n + (ins.highlights[k] || 0), 0);

test.describe('Read mode', () => {
  test('the latest version with nothing drawn over it, no thread panel, a plain outline; 0 / 1 switch', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
    // the doc shows threads, a lock and changes in Changes mode
    await expect.poll(async () => threadHighlights(await ui.inspect())).toBeGreaterThan(0);

    await modeTab(page, 'read').click();
    await expect(modeTab(page, 'read')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.doc-view')).toHaveClass(/\bmode-read\b/);
    await expect(page.locator('#sr-side')).toBeHidden();
    await expect.poll(async () => {
      const ins = await ui.inspect();
      return { hidden: ins.hidden, marks: threadHighlights(ins) + (ins.highlights['sr-ins'] || 0) };
    }).toEqual({ hidden: true, marks: 0 });
    // the outline is a plain table of contents
    await expect(page.locator('.outline .badge')).toHaveCount(0);
    await expect(page.locator('.outline-link').first()).toBeVisible();
    // the "hide annotations" switch has nothing to do here
    await expect(page.getByRole('button', { name: 'Hide annotations' })).toBeDisabled();

    // 1: back to Review, everything painted again
    await focusUi(page);
    await page.keyboard.press('1');
    await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#sr-side')).toBeVisible();
    await expect.poll(async () => {
      const ins = await ui.inspect();
      return !ins.hidden && threadHighlights(ins) > 0;
    }).toBe(true);
    await expect(page.locator('.outline .badge').first()).toBeVisible();

    // 0 from an older version: Read shows the latest one
    await page.getByTestId(TESTID.versionPicker).selectOption('1');
    await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('1');
    await focusUi(page);
    await page.keyboard.press('0');
    await expect(modeTab(page, 'read')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
    await ui.ready();
    await expect.poll(async () => (await ui.inspect()).hidden).toBe(true);
    expect(ui.errors).toEqual([]);
  });

  test('a comment from Read mode: the composer shows, the draft is added, the doc stays clean', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await modeTab(page, 'read').click();
    await expect(page.locator('#sr-side')).toBeHidden();
    await ui.selectText('Revoke the whole token family');
    await focusUi(page);
    await page.keyboard.press('c');
    const composer = page.getByTestId(TESTID.composer);
    await expect(composer).toBeVisible();
    await expect(page.locator('#sr-side')).toBeVisible();
    await page.getByTestId(TESTID.composerTextarea).fill('Say what happens to in-flight requests.');
    await page.getByTestId(TESTID.composerAdd).click();
    await expect(page.getByTestId(TESTID.toast).filter({ hasText: /Added to your review \(d\d+\)/ })).toBeVisible();
    await expect(composer).toBeHidden();
    await expect(page.locator('#sr-side')).toBeHidden();
    await expect(modeTab(page, 'read')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.drafts-count strong')).toHaveText('1');
    await expect.poll(async () => (await ui.inspect()).highlights['sr-draft'] || 0).toBe(0);

    // the thread button shows the threads, in Review
    await page.locator('.threads-toggle').click();
    await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#sr-side').getByTestId(TESTID.threadPanel)).toBeVisible();
    expect(ui.errors).toEqual([]);
  });
});

test.describe('comparing versions', () => {
  test('Changes shows the range as [older] → [newer]; picking the older end changes the comparison', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    const from = page.getByTestId(TESTID.compareFrom);
    await expect(from).toHaveValue('1');
    await expect(from.locator('option:checked')).toHaveText(/v1 · last review/);
    await expect(page.locator('.compare-arrow')).toBeVisible();
    await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
    // Source mode shows the same range; Review shows only the version
    await modeTab(page, 'source').click();
    await expect(from).toHaveValue('1');
    await modeTab(page, 'review').click();
    await expect(from).toHaveCount(0);
  });

  test('side by side: the older version beside the newer one, removed text struck through, scrolled together', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    const main = await ui.frame();
    await main.evaluate(() => { /** @type {any} */ (window).__sameFrame = true; });

    const layout = page.getByTestId(TESTID.compareLayout);
    await expect(layout.locator('[data-layout="inline"]')).toHaveAttribute('aria-pressed', 'true');
    await layout.locator('[data-layout="split"]').click();
    await expect(layout.locator('[data-layout="split"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.center')).toHaveClass(/\bis-split\b/);
    await expect(page.locator('.compare-head-old')).toContainText('v1 · your last review');
    await expect(page.locator('.compare-head-new')).toContainText('v2 · latest');

    // the older version (v1), read-only, with the changes placed in it
    const base = await ui.baseFrame();
    expect(base.url()).toContain(`${mock.doc('kitchen-sink').contentBase}/v1/`);
    /** @param {import('@playwright/test').Frame} f */
    const guestOf = (f) => f.evaluate(() => /** @type {any} */ (window).__suikoGuest.inspect());
    await expect.poll(async () => {
      const ins = await guestOf(base);
      return {
        mode: ins.mode,
        del: ins.highlights['sr-del'] > 0,
        sides: [...new Set(ins.changes.map((/** @type {any} */ m) => m.side))],
        redBars: ins.layers.changes.some((/** @type {any} */ x) => /^bar:/.test(x.key) && /\bdel\b/.test(x.cls)),
      };
    }).toEqual({ mode: 'readonly', del: true, sides: ['old'], redBars: true });
    const removed = await base.evaluate(() => [.../** @type {any} */ (CSS).highlights.get('sr-del')].map((r) => r.toString()));
    expect(removed).toContain('Load test the issuer');
    // the newer version is the same frame as before (never reloaded) and still draws its changes inline
    expect(await main.evaluate(() => /** @type {any} */ (window).__sameFrame)).toBe(true);
    await expect.poll(async () => (await ui.inspect()).highlights['sr-ins'] || 0).toBeGreaterThan(0);

    // scrolling the newer version brings the older one to the same place: a heading on the reading line of one is on
    // the reading line of the other
    await page.getByTestId(TESTID.docFrame).hover();
    const tokensTop = (/** @type {import('@playwright/test').Frame} */ f) => f.evaluate(() => {
      const h = [...document.querySelectorAll('h2')].find((x) => /^\s*3 Tokens/.test(x.textContent || ''));
      return Math.round(h?.getBoundingClientRect().top ?? 9999);
    });
    await main.evaluate(() => {
      const h = [...document.querySelectorAll('h2')].find((x) => /^\s*3 Tokens/.test(x.textContent || ''));
      if (h) window.scrollBy({ top: h.getBoundingClientRect().top - 8, behavior: 'instant' });
    });
    expect(Math.abs(await tokensTop(main) - 8)).toBeLessThanOrEqual(1);
    await expect.poll(async () => Math.abs(await tokensTop(base) - 8)).toBeLessThanOrEqual(2);

    // n walks the changes in both versions
    await focusUi(page);
    await page.keyboard.press('n');
    await expect(page.locator('.change-item.active')).toHaveAttribute('data-hunk-id', 'h1');

    // the choice is remembered; Inline takes the older version away, the newer frame stays
    expect(await page.evaluate(() => localStorage.getItem('suiko.compareLayout'))).toBe('split');
    await layout.locator('[data-layout="inline"]').click();
    await expect(page.getByTestId(TESTID.compareBaseFrame)).toHaveCount(0);
    await expect(page.locator('.center')).not.toHaveClass(/\bis-split\b/);
    expect(await main.evaluate(() => /** @type {any} */ (window).__sameFrame)).toBe(true);
    expect(ui.errors).toEqual([]);
  });

  test('side by side is a Changes layout: other modes show one version; the palette switches it', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await page.getByTestId(TESTID.compareLayout).locator('[data-layout="split"]').click();
    await ui.baseFrame();
    await modeTab(page, 'review').click();
    await expect(page.getByTestId(TESTID.compareBaseFrame)).toHaveCount(0);
    await expect(page.getByTestId(TESTID.compareLayout)).toHaveCount(0);
    // back in Changes, the older version is beside it again
    await modeTab(page, 'changes').click();
    await ui.baseFrame();
    // the palette: "Compare inline"
    await page.getByTestId(TESTID.commandPaletteOpen).click();
    await page.getByTestId(TESTID.commandPaletteInput).fill('compare inline');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(TESTID.compareBaseFrame)).toHaveCount(0);
    expect(ui.errors).toEqual([]);
  });
});

test.describe('narrow viewport', () => {
  test.use({ viewport: { width: 700, height: 860 } });

  test('no side by side below 900 px: the changes stay inline', async ({ page, ui }) => {
    await page.addInitScript(() => localStorage.setItem('suiko.compareLayout', 'split'));
    await ui.open('kitchen-sink');
    await expect(page.locator('#sr-mode')).toHaveValue('changes');
    await expect(page.getByTestId(TESTID.compareLayout)).toHaveCount(0);
    await expect(page.getByTestId(TESTID.compareBaseFrame)).toHaveCount(0);
    await expect.poll(async () => (await ui.inspect()).highlights['sr-ins'] || 0).toBeGreaterThan(0);
  });
});

test.describe('Accept all', () => {
  test('accepts every addressed or answered thread in Verify at once, keeps the declined one, and undoes', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await focusUi(page);
    await page.keyboard.press('v');
    await expect(page.locator('.filter.active')).toHaveAttribute('data-filter', 'verify');
    const bar = page.locator('.thread-panel .accept-all-bar');
    await expect(bar).toContainText('2 addressed or answered');
    await expect(bar).toContainText('1 declined');
    await bar.getByTestId(TESTID.verifyAcceptAll).click();
    await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'Accepted 2 threads (t1, t2). 1 declined thread is still in Verify.' })).toBeVisible();
    const doc = mock.doc('kitchen-sink');
    expect(doc.threads.filter((t) => t.status === 'resolved').map((t) => t.id).sort()).toEqual(['t1', 't2', 't5']);
    // only the decline is left to verify
    await expect(page.locator('.thread-panel').getByTestId(TESTID.threadCard)).toHaveCount(1);
    await expect(ui.card('t4')).toBeVisible();
    await expect(bar.getByTestId(TESTID.verifyAcceptAll)).toHaveCount(0);

    // Undo puts them back where the agent left them
    await page.getByTestId(TESTID.toast).getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByTestId(TESTID.toast).filter({ hasText: '2 threads are back in Verify.' })).toBeVisible();
    await expect.poll(() => doc.threads.filter((t) => t.id === 't1' || t.id === 't2').map((t) => t.status).sort()).toEqual(['addressed', 'answered']);
    await expect(bar.getByTestId(TESTID.verifyAcceptAll)).toHaveText('Accept all (2)');

    // Shift+X from the UI does the same; from inside the doc it does nothing (keys that change state are UI-only)
    const f = await ui.frame();
    await f.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Shift+X');
    await page.waitForTimeout(300);
    expect(doc.threads.filter((t) => t.status === 'resolved').length).toBe(1);
    await focusUi(page);
    await page.keyboard.press('Shift+X');
    await expect.poll(() => doc.threads.filter((t) => t.status === 'resolved').length).toBe(3);
    expect(ui.errors).toEqual([]);
  });

  test('the Changes round results offer it too, and the palette', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    const results = page.locator('.round-results');
    await expect(results.getByTestId(TESTID.verifyAcceptAll)).toHaveText('Accept all (2)');
    await page.getByTestId(TESTID.commandPaletteOpen).click();
    await page.getByTestId(TESTID.commandPaletteInput).fill('accept all');
    await expect(page.locator(`[data-testid="${TESTID.commandItem}"][data-command-id="accept-all"]`)).toContainText('2 addressed or answered');
    await page.keyboard.press('Enter');
    await expect.poll(() => mock.doc('kitchen-sink').threads.filter((t) => t.status === 'resolved').length).toBe(3);
    await expect(results.getByTestId(TESTID.verifyAcceptAll)).toHaveCount(0);
  });
});
