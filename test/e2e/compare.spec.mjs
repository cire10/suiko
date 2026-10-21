// @ts-check
// Reading and comparing against the mock daemon (scenario 'round2': kitchen-sink.md v2 answers rv1, see
// mock-data.mjs): Read mode (the latest version with nothing drawn over it), the "[v1 · last review] → [v2]" range of
// Changes, Changes side by side (the older version in a second, read-only frame, removed text struck through, scrolled
// together, the newer frame never reloaded), Accept all in the Verify queue (with Undo; declines stay), the "Show
// changes" switch, Accept all revisions (with Undo; the doc then opens without its changes) and Settings > Default
// view.

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
    await expect(results.getByTestId(TESTID.verifyAcceptAll)).toHaveText('Accept all (2)');
    await page.getByTestId(TESTID.commandPaletteOpen).click();
    await page.getByTestId(TESTID.commandPaletteInput).fill('accept all');
    const item = page.locator(`[data-testid="${TESTID.commandItem}"][data-command-id="accept-all"]`);
    await expect(item).toContainText('2 addressed or answered');
    await item.click();
    await expect.poll(() => mock.doc('kitchen-sink').threads.filter((t) => t.status === 'resolved').length).toBe(3);
    await expect(results.getByTestId(TESTID.verifyAcceptAll)).toHaveCount(0);
  });
});

test.describe('Show changes and Accept all revisions', () => {
  /** @param {import('@playwright/test').Page} page */
  const changesSwitch = (page) => page.getByTestId(TESTID.showChanges).getByRole('switch');
  /** Inserted-word marks the guest paints (Changes). @param {import('./fixtures.mjs').Ui} ui */
  const insMarks = async (ui) => (await ui.inspect()).highlights['sr-ins'] || 0;

  test('the switch turns the change marks on, and off back to where you were', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    // opened on its changes: the agent revised since the last review
    await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
    await expect(changesSwitch(page)).toBeChecked();
    await expect(page.getByTestId(TESTID.showChanges)).toContainText('Show changes');
    await expect(page.getByTestId(TESTID.showChanges).locator('.badge')).toHaveText('3');
    await expect(changesSwitch(page)).toHaveAccessibleName('Show changes (3 new)');
    await expect.poll(() => insMarks(ui)).toBeGreaterThan(0);

    // off: the doc opened on its changes, so the Default view (Review)
    await changesSwitch(page).click();
    await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
    await expect(changesSwitch(page)).not.toBeChecked();
    await expect.poll(() => insMarks(ui)).toBe(0);

    // from Read: on, then off goes back to Read
    await modeTab(page, 'read').click();
    await changesSwitch(page).click();
    await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => insMarks(ui)).toBeGreaterThan(0);
    await changesSwitch(page).click();
    await expect(modeTab(page, 'read')).toHaveAttribute('aria-selected', 'true');

    // the palette has both
    await page.getByTestId(TESTID.commandPaletteOpen).click();
    await page.getByTestId(TESTID.commandPaletteInput).fill('show changes');
    await page.locator(`[data-testid="${TESTID.commandItem}"][data-command-id="show-changes"]`).click();
    await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId(TESTID.commandPaletteOpen).click();
    await page.getByTestId(TESTID.commandPaletteInput).fill('hide changes');
    await page.locator(`[data-testid="${TESTID.commandItem}"][data-command-id="hide-changes"]`).click();
    await expect(modeTab(page, 'read')).toHaveAttribute('aria-selected', 'true');

    // the tabs say what they show; Source and History have no switch
    await expect(modeTab(page, 'review')).toHaveAttribute('title', /^Review: Comment on the rendered document, with your threads highlighted/);
    await modeTab(page, 'source').click();
    await expect(page.getByTestId(TESTID.showChanges)).toHaveCount(0);
    expect(ui.errors).toEqual([]);
  });

  test('accepts the latest version and its addressed / answered threads, leaves Changes, undoes; later versions compare with it', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    const d = mock.doc('kitchen-sink');
    const resolved = () => d.threads.filter((t) => t.status === 'resolved').map((t) => t.id).sort();
    const accept = page.getByTestId(TESTID.acceptRevisions);
    await expect(accept).toHaveAttribute('title', /^Accept the revisions of v2 \(since v1\): they stop showing as new, and the 2 threads claude addressed or answered are resolved/);
    await accept.click();
    const toast = page.getByTestId(TESTID.toast).filter({ hasText: 'Accepted the revisions of v2 and 2 threads (t1, t2). 1 declined thread is still in Verify.' });
    await expect(toast).toBeVisible();
    expect(d.doc.acceptedVersion).toBe(2);
    expect(resolved()).toEqual(['t1', 't2', 't5']);
    // the change marks are gone: Review (the Default view), nothing new to show or accept
    await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => insMarks(ui)).toBe(0);
    await expect(accept).toHaveCount(0);
    await expect(page.getByTestId(TESTID.showChanges).locator('.badge')).toHaveCount(0);
    // the changes are seen in the Changes list
    await changesSwitch(page).click();
    await expect(page.locator('.changes-view .progress')).toHaveText('3/3 reviewed');

    // Undo: the revisions are new again, the threads back in Verify
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'The revisions of v2 are to review again; 2 threads are back in Verify.' })).toBeVisible();
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
    await expect(page.getByTestId(TESTID.showChanges).locator('.badge')).toHaveText('1');
    await expect(accept).toHaveAttribute('title', /^Accept the revisions of v3 \(since v2\)/);
    await changesSwitch(page).click();
    await expect(page.locator('#sr-base')).toHaveValue('2');
    await expect(page.locator('#sr-base option:checked')).toHaveText('v2 · accepted');
    await expect(page.locator('.changes-title')).toContainText('since the revisions you accepted');
    await expect(page.getByTestId(TESTID.changeItem)).toHaveCount(1);
    expect(ui.errors).toEqual([]);
  });

  test('Settings > Default view: Read opens the doc clean, Review in Review; the switch shows what is new', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId(TESTID.settingsOpen).click();
    const choice = page.locator('[data-setting="openIn"]');
    await expect(choice.getByRole('radio', { name: 'Changes when revised' })).toBeChecked();
    await choice.getByRole('radio', { name: 'Read' }).check();
    await page.keyboard.press('Escape');

    await page.reload();
    await ui.ready();
    await expect(modeTab(page, 'read')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await ui.inspect()).hidden).toBe(true);
    await expect(page.getByTestId(TESTID.showChanges).locator('.badge')).toHaveText('3');
    await expect(page.getByTestId(TESTID.acceptRevisions)).toBeVisible();
    await changesSwitch(page).click();
    await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
    await changesSwitch(page).click();
    await expect(modeTab(page, 'read')).toHaveAttribute('aria-selected', 'true');

    await page.getByTestId(TESTID.settingsOpen).click();
    await page.locator('[data-setting="openIn"]').getByRole('radio', { name: 'Review' }).check();
    await page.keyboard.press('Escape');
    await page.reload();
    await ui.ready();
    await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
    expect(ui.errors).toEqual([]);
  });
});
