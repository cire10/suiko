// @ts-check
// The thread panel, the composer and the words around them (the UI fix round's V4, V13, V9, L9, L10, L11):
//   - V4: a doc without threads or drafts opens without the thread panel (the doc keeps its width), its empty state
//     has no filters, and the first comment or thread, or Changes, opens it; a doc with threads opens with it;
//   - V13: a card's anchor: the quote on its own line (two lines at most), the section muted under it, the lines only
//     in the tooltip;
//   - V9: "Claude will see: “…” (§1.1 Milestones)" with the lines in the tooltip; "Sent 02:59" / "Claude has it ·
//     03:03"; the Send dialog says "What happens next", and its not-connected box shows exactly the prompt it copies;
//   - L9: a "Record as decision…" being typed stays when the agent answers that thread and it leaves the filter shown;
//   - L10: a code review's inline "Record as decision…" opens the panel card's input also when that card is focused,
//     and nothing opens later on its own;
//   - L11: side by side keeps where it started (Review) through a moment below 900 px: Done goes back there.

import { test, expect } from './fixtures.mjs';
import { TESTID } from '../../src/shared/protocol.js';

/** @param {import('@playwright/test').Page} page @param {string} mode */
const modeTab = (page, mode) => page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="${mode}"]`);
/** @param {import('@playwright/test').Page} page @param {string} key */
const filter = (page, key) => page.locator(`.thread-panel .filter[data-filter="${key}"]`);

test.describe('fresh docs, the defaults', () => {
  test.use({ scenario: 'fresh', prefs: 'defaults' });

  test('V4: a doc with nothing to list opens without the thread panel; the first comment opens it; the empty state has no filters', async ({ page, ui, mock }) => {
    await ui.open('app-spec');
    const side = page.locator('#sr-side');
    await expect(side).toBeHidden();
    const frame = await page.getByTestId(TESTID.docFrame).boundingBox();
    const main = await page.locator('main.center').boundingBox();
    expect(Math.round(frame?.width ?? 0)).toBe(Math.round(main?.width ?? -1));
    // the threads button opens it: the empty state only
    await page.locator('.threads-toggle').click();
    await expect(side).toBeVisible();
    await expect(page.locator('.thread-panel .filters')).toHaveCount(0);
    await expect(page.locator('.thread-panel .empty')).toContainText('No comments yet.');
    await page.locator('.threads-toggle').click();
    await expect(side).toBeHidden();
    // closed by the reviewer on this page: a comment still opens it
    await ui.selectText('Requests arrive through the API gateway');
    await page.locator('[data-selection-comment]').click();
    await expect(side).toBeVisible();
    await expect(page.getByTestId(TESTID.composer)).toBeVisible();
    expect(ui.errors).toEqual([]);
  });

  test('V4: a draft arriving opens the panel of a doc that opened without it; a doc with threads opens with it', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    const side = page.locator('#sr-side');
    await expect(side).toBeHidden();
    // a draft saved elsewhere (another tab, `suiko snip`): the panel opens, as it would have been open
    mock.doc('kitchen-sink').saveDraft({ kind: 'thread', type: 'comment', severity: 'normal', capture: { kind: 'doc' }, body: 'From elsewhere', version: 1 });
    await expect(side).toBeVisible();
    await expect(filter(page, 'mine')).toBeVisible();
    // another doc with threads opens with the panel
    const d = mock.doc('app-spec');
    d.saveDraft({ kind: 'thread', type: 'comment', severity: 'normal', capture: { kind: 'doc' }, body: 'Overall', version: 1 });
    d.submitReview({ verdict: 'comment', body: '' });
    await ui.open('app-spec');
    await expect(side).toBeVisible();
    expect(ui.errors).toEqual([]);
  });

  test('V4: Changes opens the panel of a doc that opened without it (the list of changes is there)', async ({ page, ui, mock }) => {
    const d = mock.doc('kitchen-sink');
    d.revise({ source: d.source(1).replace('Last revised 2026-10-10.', 'Last revised 2026-10-11.'), summary: 'date' });
    await ui.open('kitchen-sink');
    await ui.inMode('review');
    const side = page.locator('#sr-side');
    await expect(side).toBeHidden();
    await page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="changes"]`).click();
    await expect(side).toBeVisible();
    await expect(page.getByTestId(TESTID.changeItem)).toHaveCount(1);
    await expect(page.getByTestId(TESTID.changeItem)).toBeVisible();
    expect(ui.errors).toEqual([]);
  });

  test('V9: the composer says what Claude will see in plain words; the lines are in its tooltip', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await ui.selectText('Remove the legacy session store.');
    await page.locator('[data-selection-comment]').click();
    const sees = page.getByTestId(TESTID.composer).locator('.agent-sees');
    await expect(sees).toHaveText('Claude will see: “Remove the legacy session store.” (§1.1 Milestones)');
    await expect(sees).toHaveAttribute('title', /^Claude will see: L\d+ §1\.1 Milestones “Remove the legacy session store\.”$/);
    await expect(page.getByTestId(TESTID.composer)).not.toContainText('Agent');
  });

  test('V9: the review\'s progress in plain words: "Sent 02:59", then "Claude has it · 03:03"', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    const d = mock.doc('kitchen-sink');
    d.saveDraft({ kind: 'thread', type: 'comment', severity: 'normal', capture: { kind: 'doc' }, body: 'Overall', version: 1 });
    const rv = d.submitReview({ verdict: 'comment', body: '' });
    const progress = page.getByTestId(TESTID.turnPill).locator('.review-progress');
    await expect(progress).toHaveText(/^Sent \d\d:\d\d$/);
    d.deliver(rv.id, 'claude');
    await expect(progress).toHaveText(/^Claude has it · \d\d:\d\d$/);
    await page.getByTestId(TESTID.turnPill).click();
    await expect(page.locator('.turn-facts')).toContainText(/Your last review\s*Claude has it · \d\d:\d\d/);
  });

  test('V9: the Send dialog says "What happens next"; the not-connected box shows exactly the prompt it copies', async ({ page, ui, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await ui.open('kitchen-sink');
    await page.getByTestId(TESTID.submitReviewOpen).click();
    const dialog = page.getByTestId(TESTID.submitReviewDialog);
    await expect(dialog.locator('legend')).toHaveText('What happens next');
    await expect(dialog).not.toContainText('Verdict');
    const box = dialog.locator('.no-agent');
    await expect(box).toContainText("Claude isn't connected. Your feedback waits until Claude asks for it. After you send, paste this into Claude's chat:");
    await expect(box.locator('code.prompt')).toHaveText('Run suiko feedback kitchen-sink and address it.');
    await box.getByRole('button', { name: 'Copy prompt' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Run suiko feedback kitchen-sink and address it.');
  });
});

test.describe('round 2', () => {
  test.use({ scenario: 'round2', prefs: 'defaults' });

  test('V13: a card\'s anchor: the quote on its own line (two at most, not italic), the section under it, the lines in the tooltip', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await filter(page, 'all').click();
    const target = ui.card('t1').locator('.card-target');
    const quote = target.locator('[data-anchor-quote]');
    const section = target.locator('.target-section');
    await expect(quote).toHaveText('“rotated on every use”');
    await expect(section).toHaveText(/^§/);
    await expect(target.locator('.target-lines')).toHaveCount(0);
    await expect(target).not.toContainText(/\bL\d+/);
    await expect(target).toHaveAttribute('title', /\(§.+ L\d+(-\d+)?\)$/);
    const q = await quote.boundingBox();
    const s = await section.boundingBox();
    expect((s?.y ?? 0) >= (q?.y ?? 0) + (q?.height ?? 0) - 1).toBe(true);
    const style = await target.locator('.target-what').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { clamp: cs.webkitLineClamp, italic: getComputedStyle(/** @type {Element} */ (el.querySelector('.quote'))).fontStyle };
    });
    expect(style).toEqual({ clamp: '2', italic: 'normal' });
  });

  test('L11: side by side from Review keeps where it started through a moment below 900 px; Done goes back to Review', async ({ page, ui }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await ui.open('kitchen-sink');
    await ui.inMode('review');
    await page.getByTestId(TESTID.commandPaletteOpen).click();
    await page.getByTestId(TESTID.commandPaletteInput).fill('compare side by side');
    await page.keyboard.press('Enter');
    await ui.baseFrame();
    await expect(page.locator('#sr-side')).toBeHidden();
    await page.setViewportSize({ width: 850, height: 800 });
    await expect(page.getByTestId(TESTID.compareBaseFrame)).toHaveCount(0);
    await page.setViewportSize({ width: 1100, height: 800 });
    await ui.baseFrame();
    await expect(page.locator('#sr-side')).toBeHidden();
    const done = page.getByTestId(TESTID.compareBar).getByRole('button', { name: 'Done comparing' });
    await expect(done).not.toHaveAttribute('title', /the changes inline/);
    await done.click();
    await ui.inMode('review');
    // what side by side hid is back
    await expect(page.locator('#sr-side')).toBeVisible();
    expect(ui.errors).toEqual([]);
  });
});

test.describe('rich, batched', () => {
  test.use({ scenario: 'rich' });

  test('L9: a decision being typed stays when the agent answers that thread and it leaves the filter shown', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await filter(page, 'agent').click();
    const t8 = ui.card('t8');
    await ui.cardMenu(t8, 'decision');
    const input = t8.locator('.decision-input input');
    await expect(input).toBeFocused();
    await input.fill('Flag rotation_v2, off by default');
    mock.doc('kitchen-sink').agentReply('t8', { status: 'answered', body: 'Done thinking: rotation_v2, off by default.' });
    await expect(t8.locator('.status-chip')).toHaveText('Claude answered');
    await expect(input).toHaveValue('Flag rotation_v2, off by default');
    // recorded: the thread is done, the input closes, and the card leaves the Claude filter with it
    await t8.getByRole('button', { name: 'Record and mark done' }).click();
    await expect.poll(() => mock.doc('kitchen-sink').thread('t8').decision?.text).toBe('Flag rotation_v2, off by default');
    await expect(ui.card('t8')).toHaveCount(0);
    expect(ui.errors).toEqual([]);
  });
});

test.describe('code review', () => {
  test.use({ scenario: 'code', prefs: 'defaults' });

  test('L10: an inline "Record as decision…" opens the input on the panel card also when it is focused; nothing opens later', async ({ page, ui, mock }) => {
    await page.goto(mock.url('cr-feat'));
    const inline = page.locator('[data-inline-id="t1"]');
    await expect(inline).toBeVisible({ timeout: 15000 });
    await inline.locator('.tid').click();
    await expect(ui.card('t1')).toHaveAttribute('aria-current', 'true');
    await inline.locator('[data-card-menu]').click();
    await page.locator('[role="menuitem"][data-action="decision"]').click();
    const input = ui.card('t1').locator('.decision-input');
    await expect(input).toBeVisible();
    await input.getByRole('button', { name: 'Cancel' }).click();
    await expect(input).toHaveCount(0);
    // focusing another thread and back opens nothing by itself
    await page.locator('[data-inline-id="t2"] .tid').click();
    await expect(ui.card('t2')).toHaveAttribute('aria-current', 'true');
    await inline.locator('.tid').click();
    await expect(ui.card('t1')).toHaveAttribute('aria-current', 'true');
    await page.waitForTimeout(300);
    await expect(input).toHaveCount(0);
    expect(ui.errors).toEqual([]);
  });
});
