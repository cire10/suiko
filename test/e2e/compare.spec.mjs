// @ts-check
// Reading and comparing against the mock daemon (scenario 'round2': kitchen-sink.md v2 answers rv1, see
// mock-data.mjs): Read mode (the latest version with nothing drawn over it), the "[v1 · last review] → [v2]" range of
// Changes, Changes side by side ("compare focus": the older version in a second, read-only frame beside the newer one
// at the same width, the compare bar with the change stepper, the frame headers with the version pickers, the rails
// hidden and put back, scrolled together both ways, a change step landing the change level in both frames and marked
// on both sides, Done back to the mode before, the newer frame never reloaded, inline below 900 px, both rails hidden
// at 900-1199 px), Accept all of what Claude changed or answered (with Undo; declines stay), the Changes tab as the change marks'
// switch (with the number of new changes), Accept all revisions in the Changes panel (with Undo; the doc then opens
// without its changes) and Settings > Default view.
// Top bar controls are reached the way the redesigned header offers them: the Read / Review / Changes tabs, and keys
// for the rest (3 = Source, Ctrl+, = Settings, h = hide marks); the Changes panel holds Accept all and, when side by
// side is not shown, Inline / Side by side.

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

/** Shows the outline rail when it is behind the ≡ button. @param {import('@playwright/test').Page} page */
async function showOutline(page) {
  const nav = page.locator('#sr-nav');
  if (!(await nav.isVisible())) await page.locator('button[aria-controls="sr-nav"]').click();
  await expect(nav).toBeVisible();
}

/** Total ranges of the thread / draft / lock highlights the guest paints (threads by whose turn they are). @param {any} ins */
const threadHighlights = (ins) => ['sr-open', 'sr-check', 'sr-declined', 'sr-answer', 'sr-planned', 'sr-resolved', 'sr-active', 'sr-draft', 'sr-lock',
  'sr-outdated']
  .reduce((n, k) => n + (ins.highlights[k] || 0), 0);

/** The top of the "3 Tokens" heading in a doc frame (viewport coordinates). @param {import('@playwright/test').Frame} f */
const tokensTop = (f) => f.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find((x) => /^\s*3 Tokens/.test(x.textContent || ''));
  return Math.round(h?.getBoundingClientRect().top ?? 9999);
});

/** Scrolls a doc frame so the "3 Tokens" heading sits a third down it (the level line of side by side). @param {import('@playwright/test').Frame} f */
const tokensToThird = (f) => f.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find((x) => /^\s*3 Tokens/.test(x.textContent || ''));
  if (h) window.scrollBy({ top: h.getBoundingClientRect().top - Math.round(innerHeight / 3), behavior: 'instant' });
  return Math.round(innerHeight / 3);
});

/** The top of the active change's box in a doc frame (viewport coordinates), or null. @param {import('@playwright/test').Frame} f */
const activeTop = (f) => f.evaluate(() => {
  const box = /** @type {any} */ (window).__suikoGuest.inspect().layers.changes?.find((/** @type {any} */ x) => x.key.startsWith('active:'));
  return box ? Math.round(box.rect.y) : null;
});

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
    await showOutline(page);
    await expect(page.locator('.outline .badge')).toHaveCount(0);
    await expect(page.locator('.outline-link').first()).toBeVisible();
    // hiding the marks has nothing to do here, and says so
    await focusUi(page);
    await page.keyboard.press('h');
    await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'Read mode shows no annotations' })).toBeVisible();

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
    await expect(page.getByTestId(TESTID.toast).filter({ hasText: /Saved as a draft \(d\d+\)\. It goes to Claude when you send\./ })).toBeVisible();
    await expect(composer).toBeHidden();
    await expect(page.locator('#sr-side')).toBeHidden();
    await expect(modeTab(page, 'read')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.drafts-count')).toContainText('1');
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
    // Source (3) shows the same range; Review shows only the version
    await focusUi(page);
    await page.keyboard.press('3');
    await expect(page.locator('.doc-view')).toHaveAttribute('data-mode', 'source');
    await expect(from).toHaveValue('1');
    await modeTab(page, 'review').click();
    await expect(from).toHaveCount(0);
  });

  test.describe('side by side', () => {
    // a frame tall enough to scroll the headings compared below to the level line (a third down) in both versions
    test.use({ viewport: { width: 1400, height: 760 } });

    test('compare focus: the older version beside the newer one at the same width, the bar and the frame headers', async ({ page, ui, mock }) => {
      await ui.open('kitchen-sink');
      const main = await ui.frame();
      await main.evaluate(() => { /** @type {any} */ (window).__sameFrame = true; });
      const railBefore = await page.locator('#sr-nav').isVisible();
      await expect(page.locator('#sr-side')).toBeVisible();

      const layout = page.getByTestId(TESTID.compareLayout);
      await expect(layout.locator('[data-layout="inline"]')).toHaveAttribute('aria-pressed', 'true');
      await layout.locator('[data-layout="split"]').click();
      await expect(page.locator('.center')).toHaveClass(/\bis-split\b/);

      // the doc area is the two versions': the thread panel and the outline rail are put away
      await expect(page.locator('#sr-side')).toBeHidden();
      await expect(page.locator('#sr-nav')).toBeHidden();
      const bar = page.getByTestId(TESTID.compareBar);
      await expect(bar).toBeVisible();
      await expect(bar.getByTestId(TESTID.compareLayout).locator('[data-layout="split"]')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId(TESTID.compareLayout)).toHaveCount(1);
      await expect(page.getByTestId(TESTID.compareStep)).toContainText('3 changes');
      // each frame's header holds its version picker (the top bar shows neither) and says what the version is
      const oldHead = page.locator('.compare-head-old');
      const newHead = page.locator('.compare-head-new');
      await expect(oldHead.getByTestId(TESTID.compareFrom)).toHaveValue('1');
      await expect(oldHead).toContainText('your last review');
      await expect(newHead.getByTestId(TESTID.versionPicker)).toHaveValue('2');
      await expect(newHead).toContainText('latest');
      await expect(page.getByTestId(TESTID.compareFrom)).toHaveCount(1);
      await expect(page.getByTestId(TESTID.versionPicker)).toHaveCount(1);

      // the older version (v1), read-only, with the changes placed in it, at the newer one's width
      const base = await ui.baseFrame();
      expect(base.url()).toContain(`${mock.doc('kitchen-sink').contentBase}/v1/`);
      const widths = await Promise.all([TESTID.compareBaseFrame, TESTID.docFrame].map(async (id) => (await page.getByTestId(id).boundingBox())?.width ?? 0));
      expect(Math.abs(widths[0] - widths[1])).toBeLessThanOrEqual(1);
      expect(widths[0]).toBeGreaterThan(650);
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
      // the newer version is the same frame as before (never reloaded) and still draws its additions; beside the older
      // version it marks the removed lines with a note (no "removed" button: they are right there on the left)
      expect(await main.evaluate(() => /** @type {any} */ (window).__sameFrame)).toBe(true);
      await expect.poll(async () => (await ui.inspect()).highlights['sr-ins'] || 0).toBeGreaterThan(0);
      await expect.poll(async () => (await ui.inspect()).layers.changes.find((/** @type {any} */ x) => x.key === 'tab:h2')?.cls).toMatch(/\bnote\b/);

      // Done (side by side was opened from Changes): Changes inline again, the panel and the rail as they were
      expect(await page.evaluate(() => localStorage.getItem('suiko.compareLayout'))).toBe('split');
      await bar.getByRole('button', { name: 'Done comparing' }).click();
      await expect(page.getByTestId(TESTID.compareBaseFrame)).toHaveCount(0);
      await expect(page.getByTestId(TESTID.compareBar)).toHaveCount(0);
      await expect(page.locator('.center')).not.toHaveClass(/\bis-split\b/);
      await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#sr-side')).toBeVisible();
      expect(await page.locator('#sr-nav').isVisible()).toBe(railBefore);
      expect(await page.evaluate(() => localStorage.getItem('suiko.compareLayout'))).toBe('inline');
      await expect.poll(async () => (await ui.inspect()).layers.changes.find((/** @type {any} */ x) => x.key === 'tab:h2')?.cls).not.toMatch(/\bnote\b/);
      expect(await main.evaluate(() => /** @type {any} */ (window).__sameFrame)).toBe(true);
      expect(ui.errors).toEqual([]);
    });

    test('scrolled together both ways; a change step puts the change level in both frames and marks it on both sides', async ({ page, ui }) => {
      await ui.open('kitchen-sink');
      await page.getByTestId(TESTID.compareLayout).locator('[data-layout="split"]').click();
      const base = await ui.baseFrame();
      const main = await ui.frame();

      // the reader scrolls the newer version: the older one follows, the heading level with it
      await page.getByTestId(TESTID.docFrame).hover();
      const third = await tokensToThird(main);
      expect(Math.abs(await tokensTop(main) - third)).toBeLessThanOrEqual(1);
      await expect.poll(async () => Math.abs(await tokensTop(base) - third)).toBeLessThanOrEqual(2);
      // and the other way round: the newer version follows the older one
      await main.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await expect.poll(() => base.evaluate(() => Math.round(window.scrollY))).toBe(0);
      await page.getByTestId(TESTID.compareBaseFrame).hover();
      await tokensToThird(base);
      await expect.poll(async () => Math.abs(await tokensTop(main) - third)).toBeLessThanOrEqual(2);

      // n steps through the changes: the change is level in both frames and marked on both sides
      await focusUi(page);
      await page.keyboard.press('n');
      const step = page.getByTestId(TESTID.compareStep);
      await expect(step).toContainText('1 of 3');
      await expect(page.locator('.change-item.active')).toHaveAttribute('data-hunk-id', 'h1');
      await expect.poll(async () => {
        const [a, b] = [await activeTop(main), await activeTop(base)];
        return a != null && b != null && Math.abs(a - b) <= 1;
      }).toBe(true);
      // ...and stays level: neither frame echoes the other's step
      await page.waitForTimeout(600);
      const [a1, b1] = [await activeTop(main), await activeTop(base)];
      expect(Math.abs(/** @type {number} */ (a1) - /** @type {number} */ (b1))).toBeLessThanOrEqual(1);
      expect(((await main.evaluate(() => /** @type {any} */ (window).__suikoGuest.inspect())).activeHunk)).toBe('h1');
      expect(((await base.evaluate(() => /** @type {any} */ (window).__suikoGuest.inspect())).activeHunk)).toBe('h1');
      // a link over the seam joins the change in both frames once they are still
      const link = page.locator('.compare-links path[data-hunk="h1"]');
      await expect(link).toHaveClass(/\bactive\b/);
      await expect(page.locator('.compare-links')).not.toHaveClass(/\bis-moving\b/);

      // the bar's arrows do the same
      await step.getByRole('button', { name: 'Next change' }).click();
      await expect(step).toContainText('2 of 3');
      await step.getByRole('button', { name: 'Previous change' }).click();
      await expect(step).toContainText('1 of 3');
      await expect(step.getByRole('button', { name: 'Previous change' })).toBeDisabled();
      expect(ui.errors).toEqual([]);
    });

    test('right after entering it, each change step scrolls each frame once (no late line-up, no echo)', async ({ page, ui }) => {
      await ui.open('kitchen-sink');
      await page.getByTestId(TESTID.compareLayout).locator('[data-layout="split"]').click();
      const base = await ui.baseFrame();
      const main = await ui.frame();
      /** @param {import('@playwright/test').Frame} f */
      const watch = (f) => f.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.__scrolls = [];
        addEventListener('scroll', () => w.__scrolls.push(Math.round(scrollY)), { passive: true });
      });
      /** @param {import('@playwright/test').Frame} f @returns {Promise<number[]>} */
      const scrolls = (f) => f.evaluate(() => /** @type {any} */ (window).__scrolls.splice(0));
      await watch(main);
      await watch(base);
      await focusUi(page);
      for (const n of [1, 2]) {
        await page.keyboard.press('n');
        await expect(page.getByTestId(TESTID.compareStep)).toContainText(`${n} of 3`);
        await page.waitForTimeout(800);
        const [m, b] = [await scrolls(main), await scrolls(base)];
        // one programmatic scroll lands as one position (the scroll event may fire once or twice for it)
        expect(new Set(m).size, `newer frame, step ${n}: ${m}`).toBeLessThanOrEqual(1);
        expect(new Set(b).size, `older frame, step ${n}: ${b}`).toBeLessThanOrEqual(1);
      }
      expect(ui.errors).toEqual([]);
    });

    test('a Changes layout: other modes show one version and put the rails back; the palette switches it', async ({ page, ui }) => {
      await ui.open('kitchen-sink');
      await page.getByTestId(TESTID.compareLayout).locator('[data-layout="split"]').click();
      await ui.baseFrame();
      await modeTab(page, 'review').click();
      await expect(page.getByTestId(TESTID.compareBaseFrame)).toHaveCount(0);
      await expect(page.getByTestId(TESTID.compareBar)).toHaveCount(0);
      await expect(page.getByTestId(TESTID.compareLayout)).toHaveCount(0);
      await expect(page.locator('#sr-side')).toBeVisible();
      // back in Changes, the older version is beside it again (remembered), in compare focus
      await modeTab(page, 'changes').click();
      await ui.baseFrame();
      await expect(page.getByTestId(TESTID.compareBar)).toBeVisible();
      await expect(page.locator('#sr-side')).toBeHidden();
      // the palette: "Compare inline"
      await page.getByTestId(TESTID.commandPaletteOpen).click();
      await page.getByTestId(TESTID.commandPaletteInput).fill('compare inline');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId(TESTID.compareBaseFrame)).toHaveCount(0);
      await expect(page.locator('#sr-side')).toBeVisible();
      expect(ui.errors).toEqual([]);
    });

    test('Done goes back to the mode it started from; the thread panel can be opened while comparing', async ({ page, ui }) => {
      await ui.open('kitchen-sink');
      await modeTab(page, 'review').click();
      // the palette: "Compare side by side", from Review
      await page.getByTestId(TESTID.commandPaletteOpen).click();
      await page.getByTestId(TESTID.commandPaletteInput).fill('compare side by side');
      await page.keyboard.press('Enter');
      await ui.baseFrame();
      await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#sr-side')).toBeHidden();
      // \ opens the panel while comparing; both frames keep the same width
      await focusUi(page);
      await page.keyboard.press('\\');
      await expect(page.locator('#sr-side')).toBeVisible();
      const widths = await Promise.all([TESTID.compareBaseFrame, TESTID.docFrame].map(async (id) => (await page.getByTestId(id).boundingBox())?.width ?? 0));
      expect(Math.abs(widths[0] - widths[1])).toBeLessThanOrEqual(1);
      // Done: back to Review; Changes is inline next time
      await page.getByTestId(TESTID.compareBar).getByRole('button', { name: 'Done comparing' }).click();
      await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId(TESTID.compareBaseFrame)).toHaveCount(0);
      await expect(page.locator('#sr-side')).toBeVisible();
      await modeTab(page, 'changes').click();
      await expect(page.locator('.center')).not.toHaveClass(/\bis-split\b/);
      await expect(page.getByTestId(TESTID.compareBaseFrame)).toHaveCount(0);
      expect(ui.errors).toEqual([]);
    });
  });

  test('side by side: c pressed in the older version never comments on the newer frame\'s selection', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await page.getByTestId(TESTID.compareLayout).locator('[data-layout="split"]').click();
    const base = await ui.baseFrame();
    await ui.selectText('rotated on every use');
    // drag-select a phrase in the older version, as a reviewer would, then press c there
    const box = await base.evaluate(() => {
      // text the scroll sync keeps in view next to the newer frame's selection
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const r = document.createRange();
      while (walker.nextNode()) {
        const n = /** @type {Text} */ (walker.currentNode);
        const i = n.data.indexOf('previous token');
        if (i < 0) continue;
        r.setStart(n, i);
        r.setEnd(n, i + 'previous token'.length);
        break;
      }
      const b = r.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    });
    const frame = await page.getByTestId(TESTID.compareBaseFrame).boundingBox();
    const y = (frame?.y ?? 0) + box.y + box.h / 2;
    await page.mouse.move((frame?.x ?? 0) + box.x + 2, y);
    await page.mouse.down();
    await page.mouse.move((frame?.x ?? 0) + box.x + box.w - 2, y, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.press('c');
    await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'The older version is read-only' })).toBeVisible();
    await expect(page.getByTestId(TESTID.composer)).toHaveCount(0);
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
    await expect(page.getByTestId(TESTID.compareBar)).toHaveCount(0);
    await expect.poll(async () => (await ui.inspect()).highlights['sr-ins'] || 0).toBeGreaterThan(0);
  });
});

test.describe('between 900 and 1199 px', () => {
  test.use({ viewport: { width: 1100, height: 800 } });

  test('side by side still works, with both rails hidden and nothing overflowing', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await page.getByTestId(TESTID.compareLayout).locator('[data-layout="split"]').click();
    await ui.baseFrame();
    await expect(page.getByTestId(TESTID.compareBar)).toBeVisible();
    await expect(page.locator('#sr-side')).toBeHidden();
    await expect(page.locator('#sr-nav')).toBeHidden();
    const widths = await Promise.all([TESTID.compareBaseFrame, TESTID.docFrame].map(async (id) => (await page.getByTestId(id).boundingBox())?.width ?? 0));
    expect(Math.abs(widths[0] - widths[1])).toBeLessThanOrEqual(1);
    expect(widths[0]).toBeGreaterThan(500);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const bar = await page.getByTestId(TESTID.compareBar).boundingBox();
    expect(bar?.height).toBeLessThanOrEqual(40);
    expect(ui.errors).toEqual([]);
  });
});

test.describe('Accept all', () => {
  test('accepts every thread Claude changed or answered at once, keeps the one it did not change, and undoes', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await focusUi(page);
    await page.keyboard.press('v');
    await expect(page.locator('.filter.active')).toHaveAttribute('data-filter', 'mine');
    const bar = page.locator('.thread-panel .accept-all-bar');
    // a short label; its tooltip names the agent
    await expect(bar.locator('.accept-all-text')).toHaveText('2 changed or answered');
    await expect(bar.locator('.accept-all-text')).toHaveAttribute('title', '2 threads Claude changed or answered');
    await expect(bar.getByTestId(TESTID.verifyAcceptAll)).toHaveText('Accept all 2');
    await expect(bar).toContainText('1 thread Claude didn\'t change');
    await bar.getByTestId(TESTID.verifyAcceptAll).click();
    await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'Accepted 2 threads (t1, t2). 1 thread Claude didn\'t change is still yours to decide.' })).toBeVisible();
    const doc = mock.doc('kitchen-sink');
    expect(doc.threads.filter((t) => t.status === 'resolved').map((t) => t.id).sort()).toEqual(['t1', 't2', 't5']);
    // Your turn keeps the one Claude did not change (t4) and its question (t6)
    await expect(page.locator('.thread-panel').getByTestId(TESTID.threadCard)).toHaveCount(2);
    await expect(ui.card('t4')).toBeVisible();
    await expect(ui.card('t6')).toBeVisible();
    await expect(bar.getByTestId(TESTID.verifyAcceptAll)).toHaveCount(0);

    // Undo puts them back where the agent left them
    await page.getByTestId(TESTID.toast).getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByTestId(TESTID.toast).filter({ hasText: '2 threads are back in Your turn.' })).toBeVisible();
    await expect.poll(() => doc.threads.filter((t) => t.id === 't1' || t.id === 't2').map((t) => t.status).sort()).toEqual(['addressed', 'answered']);
    await expect(bar.getByTestId(TESTID.verifyAcceptAll)).toHaveText('Accept all 2');

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

  test('a thread you are replying to is left out, and its reply box keeps its text', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await focusUi(page);
    await page.keyboard.press('v');
    await ui.card('t2').getByRole('button', { name: 'Reply', exact: true }).click();
    const reply = page.getByTestId(TESTID.replyTextarea);
    await reply.fill('One more thing about this');
    await page.locator('.thread-panel .accept-all-bar').getByTestId(TESTID.verifyAcceptAll).click();
    await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'Accepted 1 thread (t1).' })).toContainText('t2 was left out: you are replying to it.');
    expect(mock.doc('kitchen-sink').threads.find((t) => t.id === 't2')?.status).not.toBe('resolved');
    await expect(reply).toHaveValue('One more thing about this');
    expect(ui.errors).toEqual([]);
  });

  test('the Changes round results offer it too, and the palette', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    const results = page.locator('.round-results');
    await expect(results.getByTestId(TESTID.verifyAcceptAll)).toHaveText('Accept all 2');
    await page.getByTestId(TESTID.commandPaletteOpen).click();
    await page.getByTestId(TESTID.commandPaletteInput).fill('accept all');
    const item = page.locator(`[data-testid="${TESTID.commandItem}"][data-command-id="accept-all"]`);
    await expect(item).toContainText('2 changed or answered by Claude');
    await item.click();
    await expect.poll(() => mock.doc('kitchen-sink').threads.filter((t) => t.status === 'resolved').length).toBe(3);
    await expect(results.getByTestId(TESTID.verifyAcceptAll)).toHaveCount(0);
  });
});

test.describe('the Changes tab and Accept all revisions', () => {
  /** Inserted-word marks the guest paints (Changes). @param {import('./fixtures.mjs').Ui} ui */
  const insMarks = async (ui) => (await ui.inspect()).highlights['sr-ins'] || 0;

  test('the Changes tab turns the change marks on, with the number of new changes; another tab turns them off', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    // opened on its changes: the agent revised since the last review
    await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
    await expect(modeTab(page, 'changes').locator('.badge')).toHaveText('3');
    await expect.poll(() => insMarks(ui)).toBeGreaterThan(0);

    // off: Review
    await modeTab(page, 'review').click();
    await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => insMarks(ui)).toBe(0);

    // from Read: on, then off again with Read
    await modeTab(page, 'read').click();
    await modeTab(page, 'changes').click();
    await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => insMarks(ui)).toBeGreaterThan(0);
    await modeTab(page, 'read').click();
    await expect(modeTab(page, 'read')).toHaveAttribute('aria-selected', 'true');

    // the palette has both; hiding them goes back where the reviewer came from (Read)
    await page.getByTestId(TESTID.commandPaletteOpen).click();
    await page.getByTestId(TESTID.commandPaletteInput).fill('show changes');
    await page.locator(`[data-testid="${TESTID.commandItem}"][data-command-id="show-changes"]`).click();
    await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId(TESTID.commandPaletteOpen).click();
    await page.getByTestId(TESTID.commandPaletteInput).fill('hide changes');
    await page.locator(`[data-testid="${TESTID.commandItem}"][data-command-id="hide-changes"]`).click();
    await expect(modeTab(page, 'read')).toHaveAttribute('aria-selected', 'true');

    // the tabs say what they show
    await expect(modeTab(page, 'review')).toHaveAttribute('title', /^Review: Comment on the rendered document, with your threads highlighted/);
    expect(ui.errors).toEqual([]);
  });

  test('accepted threads leave the doc: a resolved thread is drawn only while its card is selected', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await modeTab(page, 'review').click();
    await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
    /** What the guest draws for threads: text highlights, the selected thread, t2's outline, t5's pin. */
    const drawn = async () => {
      const ins = await ui.inspect();
      return {
        // unresolved threads, whoever's turn (with Claude, to check, a question, planned)
        open: ['sr-open', 'sr-check', 'sr-declined', 'sr-answer', 'sr-planned'].reduce((n, k) => n + (ins.highlights[k] || 0), 0),
        resolved: ins.highlights['sr-resolved'] || 0,
        active: ins.highlights['sr-active'] || 0,
        activeId: ins.activeId,
        t2: !!ins.layers.marks?.some((/** @type {any} */ m) => m.key === 'outline:t2'),
        t5: !!ins.layers.pins?.some((/** @type {any} */ p) => p.key === 'pin:t5'),
      };
    };
    /** Clicks a card itself, not a control in it. @param {string} id */
    const select = (id) => ui.card(id).click({ position: { x: 6, y: 6 } });
    /** @param {string} filter */
    const showFilter = (filter) => page.locator(`.filter[data-filter="${filter}"]`).click();

    // t5 was resolved before this round: not drawn. t1 and t6 are text threads still open, t2 a picked image.
    const start = { open: 2, resolved: 0, active: 0, activeId: null, t2: true, t5: false };
    await expect.poll(drawn).toEqual(start);

    // accepted while selected: its card leaves Open, and nothing of it stays
    await select('t1');
    await expect.poll(drawn).toEqual({ ...start, active: 1, activeId: 't1' });
    await ui.card('t1').getByTestId(TESTID.verifyAccept).click();
    await expect(ui.card('t1')).toHaveCount(0);
    await expect.poll(drawn).toEqual({ ...start, open: 1 });

    // the same with Accept all revisions (in the Changes panel, which then goes back to Review); its Undo draws the
    // thread again
    await select('t2');
    await expect.poll(async () => (await drawn()).activeId).toBe('t2');
    await modeTab(page, 'changes').click();
    await page.getByTestId(TESTID.acceptRevisions).click();
    const toast = page.getByTestId(TESTID.toast).filter({ hasText: 'Accepted the revisions of v2 and 1 thread (t2).' });
    await expect(toast).toBeVisible();
    await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(drawn).toEqual({ ...start, open: 1, t2: false });
    await expect(page.locator('.thread-panel [aria-current="true"]')).toHaveCount(0);
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(drawn).toEqual({ ...start, open: 1 });

    // a thread that is done is still there to look at: selecting its card scrolls to it and draws it
    await showFilter('done');
    await select('t5');
    await expect.poll(drawn).toEqual({ ...start, open: 1, resolved: 1, active: 1, activeId: 't5', t5: true });
    // until its card leaves the panel
    await showFilter('agent');
    await expect.poll(drawn).toEqual({ ...start, open: 1 });

    // a card still listed after marking it done stays selected (All lists the threads that are done)
    await showFilter('all');
    await select('t3');
    await expect.poll(async () => (await drawn()).activeId).toBe('t3');
    await ui.cardMenu(ui.card('t3'), 'done');
    await expect(ui.card('t3').locator('.status-chip')).toHaveText('Done');
    await expect(ui.card('t3')).toHaveAttribute('aria-current', 'true');
    expect((await drawn()).activeId).toBe('t3');
    expect(ui.errors).toEqual([]);
  });

  test('accepts the latest version and its addressed / answered threads, leaves Changes, undoes; later versions compare with it', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    const d = mock.doc('kitchen-sink');
    const resolved = () => d.threads.filter((t) => t.status === 'resolved').map((t) => t.id).sort();
    const accept = page.getByTestId(TESTID.acceptRevisions);
    await expect(accept).toHaveAttribute('title', /^Accept the revisions of v2 \(since v1\): they stop showing as new, and the 2 threads claude changed or answered are done/);
    await accept.click();
    const toast = page.getByTestId(TESTID.toast).filter({ hasText: 'Accepted the revisions of v2 and 2 threads (t1, t2). 1 thread Claude didn\'t change is still yours to decide.' });
    await expect(toast).toBeVisible();
    expect(d.doc.acceptedVersion).toBe(2);
    expect(resolved()).toEqual(['t1', 't2', 't5']);
    // the change marks are gone: Review (the Default view), nothing new to show or accept
    await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => insMarks(ui)).toBe(0);
    await expect(accept).toHaveCount(0);
    await expect(modeTab(page, 'changes').locator('.badge')).toHaveCount(0);
    // the changes are seen in the Changes list
    await modeTab(page, 'changes').click();
    await expect(page.locator('.changes-view .progress')).toHaveText('3/3 reviewed');

    // Undo: the revisions are new again, the threads back in Your turn
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'The revisions of v2 are to review again; 2 threads are back in Your turn.' })).toBeVisible();
    await expect.poll(() => d.doc.acceptedVersion).toBeUndefined();
    expect(resolved()).toEqual(['t5']);
    await expect(accept).toBeVisible();
    await expect(page.locator('.changes-view .progress')).toHaveText('0/3 reviewed');

    // the palette accepts too; the doc then opens without its changes
    await page.getByTestId(TESTID.commandPaletteOpen).click();
    await page.getByTestId(TESTID.commandPaletteInput).fill('accept all revisions');
    await page.locator(`[data-testid="${TESTID.commandItem}"][data-command-id="accept-revisions"]`).click();
    await expect.poll(() => d.doc.acceptedVersion).toBe(2);
    await page.reload();
    await ui.ready();
    await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
    await expect(accept).toHaveCount(0);

    // a later version: its changes count from the accepted version
    d.revise({ source: d.source(2).replace('| refresh_token | 30 d |', '| refresh_token | 14 d |'), summary: 'Shorter refresh TTL' });
    await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('3');
    await expect(modeTab(page, 'changes').locator('.badge')).toHaveText('1');
    await modeTab(page, 'changes').click();
    await expect(accept).toHaveAttribute('title', /^Accept the revisions of v3 \(since v2\)/);
    await expect(page.locator('#sr-base')).toHaveValue('2');
    await expect(page.locator('#sr-base option:checked')).toHaveText('v2 · accepted');
    await expect(page.locator('.changes-title')).toContainText('since the revisions you accepted');
    await expect(page.getByTestId(TESTID.changeItem)).toHaveCount(1);
    expect(ui.errors).toEqual([]);
  });

  test('Settings > Open documents in: Read opens the doc clean, Review in Review; the Changes tab shows what is new', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
    /** Opens the doc again from the doc list (the preference applies to every doc opened from now on). */
    const reopen = async () => {
      await page.getByRole('link', { name: 'Suiko' }).first().click();
      await page.getByTestId(TESTID.docList).getByRole('link', { name: /Token Service Implementation Spec/ }).click();
      await ui.ready();
    };
    /** @param {string} value */
    const chooseOpenIn = async (value) => {
      await focusUi(page);
      await page.keyboard.press('Control+Comma');
      await page.getByTestId(TESTID.settingsDialog).locator('[role="tab"][data-section="reading"]').click();
      const choice = page.getByTestId(TESTID.settingsDialog).locator('[data-setting="openIn"]');
      await choice.locator(`input[value="${value}"]`).check();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId(TESTID.settingsDialog)).toHaveCount(0);
    };
    await focusUi(page);
    await page.keyboard.press('Control+Comma');
    await page.getByTestId(TESTID.settingsDialog).locator('[role="tab"][data-section="reading"]').click();
    await expect(page.getByTestId(TESTID.settingsDialog).locator('[data-setting="openIn"] input[value="auto"]')).toBeChecked();
    await page.keyboard.press('Escape');

    await chooseOpenIn('read');
    await reopen();
    await expect(modeTab(page, 'read')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await ui.inspect()).hidden).toBe(true);
    await expect(modeTab(page, 'changes').locator('.badge')).toHaveText('3');
    await modeTab(page, 'changes').click();
    await expect(page.getByTestId(TESTID.acceptRevisions)).toBeVisible();
    await modeTab(page, 'read').click();
    await expect(modeTab(page, 'read')).toHaveAttribute('aria-selected', 'true');

    await chooseOpenIn('review');
    await reopen();
    await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
    expect(ui.errors).toEqual([]);
  });
});
