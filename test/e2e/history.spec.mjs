// @ts-check
// Plain words where the reviewer reads what happened and whose turn it is, against the mock daemon:
//   - History: chips "Feedback" / "Needs changes" / "Approved vN", "You sent 5 comments", "Claude has it · 03:03" /
//     "Waiting for Claude", "What changed", "Compare with…", review ids (rvN) only in tooltips; comments sent one at a
//     time (Send comments: Right away) are one row ("3 comments sent") that expands to list them;
//   - the doc list (Home): "Your turn N", "With Claude N", "Waiting for Claude", "Claude is listening", "Final vN";
//   - the agent's own name wherever the agent is meant (help, palette, Settings, Home), never "the agent";
//   - Settings: "When I send drafts, start on"; one size for every section, the section pane the only scroller.

import { TESTID } from '../../src/shared/protocol.js';
import { expect, test } from './fixtures.mjs';

/** @typedef {import('@playwright/test').Page} Page */

/** @param {Page} page @param {string} mode */
const modeTab = (page, mode) => page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="${mode}"]`);

test('History speaks plain words: what you sent, whether Claude has it, What changed; review ids only in tooltips', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  await ui.menu('history');
  const review = page.locator('.tl-review');
  await expect(review).toHaveCount(1);
  await expect(review.locator('.tl-what')).toHaveText('You sent 5 comments');
  await expect(review.locator('.chip')).toHaveText('Needs changes');
  await expect(review).toContainText('on v1');
  await expect(review).toContainText(/Claude has it · \d\d:\d\d/);
  await expect(review).toContainText('1 part marked agreed');
  await expect(review.locator('.tl-head')).toHaveAttribute('title', 'rv1');
  // no rvN, no "delivered to", no GitHub verdicts on screen (the agent's own summary of v2 may say what it likes)
  for (const text of [await review.innerText(), ...(await page.locator('.tl-version .tl-head, .tl-version .tl-actions').allInnerTexts())]) {
    expect(text).not.toMatch(/\brv\d|delivered to|Changes requested|Diff vs previous|\.\.\./);
  }

  const v2 = page.getByTestId(TESTID.historyRow).and(page.locator('[data-version="2"]'));
  await expect(v2).toContainText(/answers your review of \d\d:\d\d/);
  await expect(v2.getByText(/^answers your review/)).toHaveAttribute('title', 'rv1');
  await expect(v2.getByRole('button', { name: 'What changed' })).toBeEnabled();
  await expect(v2.getByRole('button', { name: 'Compare with…' })).toBeEnabled();
  await expect(v2).toContainText('Claude');
  await expect(v2).not.toContainText('claude');
  expect(ui.errors).toEqual([]);
});

test.describe('comments sent one at a time', () => {
  test.use(/** @type {any} */ ({ prefs: 'defaults' }));

  test('a run of one-comment reviews is one History row that expands; it says how many Claude has', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    const texts = ['Prototype the issuer.', 'Ship rotation behind a flag.', 'Detect reuse of a rotated token.'];
    for (const t of texts) {
      await ui.selectText(t);
      await page.getByTestId(TESTID.toolDock).locator('[data-selection-comment]').click();
      await page.getByTestId(TESTID.composerTextarea).fill(`A note on "${t}"`);
      await page.getByTestId(TESTID.composerSendNow).click();
      await expect(page.getByTestId(TESTID.composer)).toBeHidden();
    }
    const d = mock.doc('kitchen-sink');
    await expect.poll(() => d.reviews.length).toBe(4);
    await ui.menu('history');
    const run = page.locator('.tl-review.tl-group');
    await expect(run).toHaveCount(1);
    await expect(run.locator('.tl-what')).toHaveText('3 comments sent');
    await expect(run.locator('.chip')).toHaveText('Feedback');
    await expect(run).toContainText('Waiting for Claude');
    await expect(run).toHaveAttribute('data-review', 'rv4 rv3 rv2');
    await expect(run.locator('.tl-head')).toHaveAttribute('title', 'rv2, rv3, rv4');
    // the older review stays a row of its own; the versions are not pushed down by three identical rows
    await expect(page.locator('.timeline > li')).toHaveCount(4);

    // Claude picks one up
    d.deliver('rv2');
    await expect(run).toContainText('Claude has 1 · 2 waiting');

    // expanded: one line per comment, with its thread
    await run.getByRole('button', { name: 'Show each' }).click();
    await expect(run.getByRole('button', { name: 'Hide each' })).toHaveAttribute('aria-expanded', 'true');
    const lines = run.locator('.tl-run li');
    await expect(lines).toHaveCount(3);
    await expect(lines.nth(2)).toContainText(/comment\s*\d\d:\d\d\s*Claude has it/);
    await expect(lines.nth(0)).toContainText('Waiting for Claude');
    const tid = d.reviews.find((/** @type {any} */ r) => r.id === 'rv4').newThreads[0];
    await expect(lines.nth(0).getByRole('button', { name: tid })).toBeVisible();
    await lines.nth(0).getByRole('button', { name: tid }).click();
    await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
    await expect(ui.card(tid)).toHaveAttribute('aria-current', 'true');
    expect(ui.errors).toEqual([]);
  });
});

test('the doc list says whose turn it is, a review waiting for Claude, and the final version', async ({ page, mock }) => {
  await page.goto(mock.url());
  const ks = page.getByTestId(TESTID.docList).locator('li', { hasText: 'kitchen-sink.md' });
  await expect(ks).toContainText('Your turn 4');
  await expect(ks).toContainText('With Claude 1');
  await expect(ks).not.toContainText(/\d open|undelivered|Waiting for/);
  const d = mock.doc('kitchen-sink');
  d.submitReview({ verdict: 'comment', body: 'One more thing: name the owner of the rollout.', draftIds: [] });
  const waiting = ks.locator('.chip', { hasText: 'Waiting for Claude' });
  await expect(waiting).toBeVisible();
  await expect(waiting).toHaveAttribute('title', 'A review you sent waits for Claude: it gets it when it connects');
  d.setWaiters([{ agent: 'claude' }]);
  await expect(ks).toContainText('Claude is listening');
  d.setWaiters([]);
  d.submitReview({ verdict: 'approved', markFinal: true, body: '', draftIds: [] });
  await expect(ks).toContainText('Final v2');
  await expect(ks).not.toContainText('FINAL');
});

test('the agent\'s own name in the help, the palette, Settings and the doc list (never "the agent")', async ({ page, ui, mock }) => {
  mock.doc('kitchen-sink').setWaiters([{ agent: 'gemini' }]);
  await ui.open('kitchen-sink');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+/' : 'Control+/');
  const help = page.getByTestId(TESTID.helpOverlay);
  await expect(help).toBeVisible();
  await expect(help.locator('[data-key-row="accept-decline"]')).toContainText('Agree when Gemini didn\'t change it');
  await expect(help.locator('[data-key-row="accept-all"]')).toContainText('every thread Gemini changed or answered');
  await expect(help).not.toContainText('the agent');
  await page.keyboard.press('Escape');

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await page.keyboard.type('Open settings');
  await expect(page.locator(`[data-testid="${TESTID.commandItem}"][data-command-id="settings"]`)).toContainText('General, reading, sending, Gemini and its context');
  await page.keyboard.press('Escape');

  await ui.settings('context');
  await expect(page.locator('[data-section="context"]')).toHaveText('Gemini & context');
  await page.keyboard.press('Escape');

  await page.goto(mock.url());
  const ks = page.getByTestId(TESTID.docList).locator('li', { hasText: 'kitchen-sink.md' });
  await expect(ks).toContainText('With Gemini 1');
  await expect(ks).toContainText('Gemini is listening');
  expect(ui.errors).toEqual([]);
});

test('Settings: one size for every section, the section pane the only scroller; "When I send drafts, start on"', async ({ page, ui }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await ui.open('kitchen-sink');
  await ui.settings('general');
  const dlg = page.getByTestId(TESTID.settingsDialog);
  const backdrop = page.locator('.modal-backdrop');
  /** @type {Record<string, any>} */
  const seen = {};
  for (const sec of ['general', 'reading', 'sending', 'context', 'about']) {
    await dlg.locator(`[data-section="${sec}"]`).click();
    await expect(dlg.locator(`[data-section="${sec}"]`)).toHaveAttribute('aria-selected', 'true');
    const box = await dlg.boundingBox();
    seen[sec] = { top: Math.round(box?.y ?? -1), height: Math.round(box?.height ?? -1) };
    // the dialog fits the window: nothing of it below the fold, the backdrop never scrolls
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(700);
    expect(await backdrop.evaluate((e) => e.scrollHeight <= e.clientHeight)).toBe(true);
  }
  expect(new Set(Object.values(seen).map((x) => `${x.top}/${x.height}`)).size).toBe(1);
  expect(seen.general.height).toBe(620); // min(640px, 100vh - 80px)

  // Reading is longer than the pane: the pane scrolls, the title and footer stay where they are
  await dlg.locator('[data-section="reading"]').click();
  const pane = dlg.locator('.settings');
  expect(await pane.evaluate((e) => e.scrollHeight > e.clientHeight && getComputedStyle(e).overflowY === 'auto')).toBe(true);
  const head = await dlg.locator('.modal-head').boundingBox();
  const foot = await dlg.locator('.settings-foot').boundingBox();
  await pane.evaluate((e) => { e.scrollTop = e.scrollHeight; });
  await expect(dlg.locator('[data-setting="panelOpen"]')).toBeInViewport();
  expect(await dlg.locator('.modal-head').boundingBox()).toEqual(head);
  expect(await dlg.locator('.settings-foot').boundingBox()).toEqual(foot);

  await dlg.locator('[data-section="sending"]').click();
  await expect(dlg.locator('#sr-set-verdict')).toHaveText('When I send drafts, start on');
  await expect(dlg.locator('[data-setting="defaultVerdict"]')).toHaveAttribute('aria-label', 'When I send drafts, start on');
  await expect(dlg).not.toContainText('Verdict');
  // one element per id (the tab panel's id is not reused by a setting)
  expect(await page.locator('[id="sr-set-panel"]').count()).toBe(1);
  expect(ui.errors).toEqual([]);
});
