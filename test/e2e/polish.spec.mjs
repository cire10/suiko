// @ts-check
// UI polish found while using the product by hand (mock daemon):
//   U1 the composer's "what the agent will see" line keeps its height while it resolves, and the composer takes the
//      focus also when the guest's selection toolbar (focus inside the doc iframe) opened it;
//   U2 "Submit review" keeps its element across DocState refreshes between a mousedown and its mouseup;
//   U3 table picks are labelled by their scope (row / column / table), U4 cards quote their anchor's text;
//   U5 the Submit dialog starts on "Request changes" when the review carries a blocking comment;
//   U6 change hunks read as inline word diffs (capped, "Show more"), U7 group titles drop the doc's only H1;
//   U8 hidden / missing anchor chips only while the rendered doc is shown;
//   U9 between 900 and 1199 px the outline rail is collapsed behind the menu button (remembered);
//   U10 a forwarded c / s / q / a racing the guest's action does not open the composer twice.

import { TESTID } from '../../src/shared/protocol.js';
import { expect, test } from './fixtures.mjs';

/** @param {import('@playwright/test').Page} page @param {string} mode */
const modeTab = (page, mode) => page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="${mode}"]`);

/** Moves keyboard focus back to the UI document (out of the doc iframe). @param {import('@playwright/test').Page} page */
async function focusUi(page) {
  await page.evaluate(() => /** @type {HTMLElement|null} */ (document.activeElement)?.blur?.());
}

/**
 * Clicks a button of the guest's selection mini-toolbar (closed shadow root: located through the debug snapshot).
 * @param {import('@playwright/test').Page} page @param {import('./fixtures.mjs').Ui} ui @param {string} action
 */
async function clickToolbar(page, ui, action) {
  /** @type {any} */
  let button = null;
  await expect.poll(async () => {
    button = (await ui.inspect()).toolbar?.buttons?.find((/** @type {any} */ b) => b.action === action) || null;
    return !!button;
  }).toBe(true);
  const box = /** @type {{ x: number, y: number }} */ (await page.getByTestId(TESTID.docFrame).boundingBox());
  const r = button.rect;
  const x = box.x + (r.left ?? r.x) + (r.width ?? r.w) / 2;
  const y = box.y + (r.top ?? r.y) + (r.height ?? r.h) / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}

/** Delays every POST /anchors/resolve so the composer can be observed while it is still resolving. @param {import('@playwright/test').Page} page @param {number} ms */
async function slowResolve(page, ms) {
  await page.route('**/anchors/resolve', async (route) => {
    await new Promise((ok) => setTimeout(ok, ms));
    await route.continue();
  });
}

test.describe('fresh doc', () => {
  test.use({ scenario: 'fresh' });

  test('U1: the composer opened from the selection toolbar takes the focus, and the preview line does not push the form down', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await slowResolve(page, 700);
    // A long selection: its preview needs more than the two lines it is given.
    // Focus inside the doc, as after selecting with the mouse.
    const h = await ui.pointIn('h3', 'Token refresh');
    await page.mouse.click(h.x + 2, h.cy);
    await ui.selectText('Refresh tokens are rotated on every use, and the previous token is invalidated');
    await expect(page.locator('[data-selection-comment]')).toBeEnabled();
    expect(await page.evaluate(() => document.activeElement?.localName)).toBe('iframe');
    await clickToolbar(page, ui, 'comment');

    const composer = page.getByTestId(TESTID.composer);
    const ta = page.getByTestId(TESTID.composerTextarea);
    await expect(composer.locator('.anchor-preview')).toContainText('Locating what the agent will see');
    // Focus left the doc iframe for the composer.
    await expect(ta).toBeFocused();
    const before = /** @type {{ y: number }} */ (await ta.boundingBox());
    const chipsBefore = /** @type {{ y: number }} */ (await composer.getByRole('radio', { name: 'Blocking' }).boundingBox());
    await expect(composer.locator('.agent-sees')).toContainText('Agent will see: L');
    const after = /** @type {{ y: number }} */ (await ta.boundingBox());
    const chipsAfter = /** @type {{ y: number }} */ (await composer.getByRole('radio', { name: 'Blocking' }).boundingBox());
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
    expect(Math.abs(chipsAfter.y - chipsBefore.y)).toBeLessThan(1);
    // Clamped to two lines; the whole text is in the tooltip.
    const sees = composer.locator('.agent-sees');
    await expect(sees).toHaveAttribute('title', /Refresh tokens are rotated on every use/);
    const lines = await sees.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
    expect(lines).toBeLessThanOrEqual(2);
    await expect(ta).toBeFocused();
    await page.keyboard.type('Typed right away.');
    await expect(ta).toHaveValue('Typed right away.');
    expect(ui.errors).toEqual([]);
  });

  test('U1: a suggestion opened with s focuses the suggested-text input once it is ready', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await slowResolve(page, 400);
    await ui.selectText('Ship rotation behind a flag.');
    // Focus is in the doc iframe: the key reaches the guest (which acts on the selection, or forwards the key).
    await page.keyboard.press('s');
    const composer = page.getByTestId(TESTID.composer);
    await expect(composer).toBeVisible();
    // While the anchor resolves, the textarea holds the focus (keys typed now are not shortcuts)...
    await expect(page.getByTestId(TESTID.composerTextarea)).toBeFocused();
    // ...then the suggestion input takes it.
    const input = page.getByTestId(TESTID.composerSuggestion);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Ship rotation behind a flag.');
    expect(ui.errors).toEqual([]);
  });

  test('U10: a guest action and a key for the same selection right after it open the composer once', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await ui.selectText('Prototype the issuer.');
    const resolves = () => mock.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/anchors/resolve')).length;
    expect(resolves()).toBe(0);
    // The toolbar posts `action`; `q` typed right after reaches the guest too (focus is still in the doc), which
    // either posts the same action again or forwards the key: either way one composer, opened once.
    await clickToolbar(page, ui, 'question');
    await page.keyboard.press('q');
    const composer = page.getByTestId(TESTID.composer);
    await expect(composer.getByRole('radio', { name: 'Question' })).toHaveAttribute('aria-checked', 'true');
    await page.waitForTimeout(400);
    expect(resolves()).toBe(1);
    await expect(page.getByTestId(TESTID.toast)).toHaveCount(0);
    expect(ui.errors).toEqual([]);
  });

  test('U2: Submit review opens on a real click even when DocState refreshes between mousedown and mouseup', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    const d = mock.doc('kitchen-sink');
    const submit = page.getByTestId(TESTID.submitReviewOpen);
    const dialog = page.getByTestId(TESTID.submitReviewDialog);
    // Each step changes what the second row of the top bar shows: presence, the progress chip appearing and
    // changing, the round status appearing while the progress chip goes away.
    const refreshes = [
      () => d.setWaiters([{ agent: 'claude' }]),
      () => d.setWaiters([]),
      () => d.submitReview({ verdict: 'comment', body: 'earlier', draftIds: [] }),
      () => d.deliver(d.latestReview().id, 'claude'),
      () => d.revise({ source: d.source(d.head).replace('Prototype the issuer.', 'Prototype the issuer first.'), summary: 'wording' }),
    ];
    const texts = ['Remove the legacy session store.', 'Ship rotation behind a flag.', 'Prototype the issuer', 'Revoke the whole token family', 'Detect reuse of a rotated token.'];
    for (const [i, refresh] of refreshes.entries()) {
      await ui.selectText(texts[i]);
      await page.locator('[data-selection-comment]').click();
      await page.getByTestId(TESTID.composerTextarea).fill(`Comment ${i}`);
      await page.getByTestId(TESTID.composerAdd).click();
      await expect(page.getByTestId(TESTID.composer)).toBeHidden();
      await expect(page.locator('.drafts-count strong')).toHaveText(String(i + 1));
      await submit.evaluate((el) => { /** @type {any} */ (el).__mark = 1; });
      const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await submit.boundingBox());
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      const before = await page.locator('.tb-sub').innerText();
      await refresh();
      await expect.poll(() => page.locator('.tb-sub').innerText()).not.toBe(before);
      // Same element, same place: the browser will dispatch the click.
      expect(await submit.evaluate((el) => /** @type {any} */ (el).__mark ?? null)).toBe(1);
      expect(await submit.boundingBox()).toEqual(box);
      await page.mouse.up();
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
    expect(ui.errors).toEqual([]);
  });

  test('U3 / U4: a table row pick is labelled as a row, and cards quote what they anchor to', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await focusUi(page);
    await page.keyboard.press('e');
    await expect.poll(async () => (await ui.inspect()).picker.active).toBe(true);
    const cell = await ui.pointIn('td', '30 d');
    await page.mouse.move(cell.cx - 5, cell.cy);
    await page.mouse.move(cell.cx, cell.cy, { steps: 3 });
    await page.mouse.click(cell.cx, cell.cy);
    await expect.poll(async () => !!(await ui.inspect()).chooser).toBe(true);
    await page.keyboard.press('2'); // Row
    const composer = page.getByTestId(TESTID.composer);
    await expect(composer.locator('.agent-sees')).toContainText('table row "refresh_token"');
    await page.getByTestId(TESTID.composerTextarea).fill('Why is this one different?');
    await page.getByTestId(TESTID.composerAdd).click();
    await expect(composer).toBeHidden();
    const [item] = mock.doc('kitchen-sink').drafts.items;
    expect(item.anchor).toMatchObject({ kind: 'cell', scope: 'row', cell: { rowKey: 'refresh_token' } });

    const draft = page.locator(`[data-testid="${TESTID.threadCard}"][data-draft-id="${item.id}"]`);
    await expect(draft.locator('.target-label')).toHaveText('table row "refresh_token"');
    await expect(draft).not.toContainText('×');
    await expect(draft.locator('[data-anchor-quote]')).toContainText('refresh_token');

    // A text selection: the card shows its lines and section, and quotes the selected text.
    await ui.selectText('Revoke the whole token family on reuse.');
    await page.locator('[data-selection-comment]').click();
    await page.getByTestId(TESTID.composerTextarea).fill('Including access tokens?');
    await page.getByTestId(TESTID.composerAdd).click();
    const textDraft = page.locator(`[data-testid="${TESTID.threadCard}"][data-draft-id="d2"]`);
    await expect(textDraft.locator('[data-anchor-quote]')).toHaveText('“Revoke the whole token family on reuse.”');
    await expect(textDraft.locator('.target-lines')).toHaveText(/^L\d+$/);
    await expect(textDraft.locator('.target-section')).toHaveText('§1 Goals');

    // Submitted, they become threads with the same labels.
    await page.getByTestId(TESTID.submitReviewOpen).click();
    await page.getByTestId(TESTID.submitConfirm).click();
    await expect(ui.card('t1').locator('.target-label')).toHaveText('table row "refresh_token"');
    await expect(ui.card('t2').locator('[data-anchor-quote]')).toHaveText('“Revoke the whole token family on reuse.”');
    expect(ui.errors).toEqual([]);
  });

  test('U5: the Submit dialog starts on "Request changes" when a draft is blocking, else on "Comment"', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    const dialog = page.getByTestId(TESTID.submitReviewDialog);
    const verdict = (/** @type {string} */ v) => dialog.locator(`[data-testid="${TESTID.submitVerdict}"] input[value="${v}"]`);

    await ui.selectText('Prototype the issuer.');
    await page.locator('[data-selection-comment]').click();
    await page.getByTestId(TESTID.composerTextarea).fill('Which language?');
    await page.getByTestId(TESTID.composerAdd).click();
    await page.getByTestId(TESTID.submitReviewOpen).click();
    await expect(verdict('comment')).toBeChecked();
    await page.keyboard.press('Escape');

    await ui.selectText('Remove the legacy session store.');
    await page.locator('[data-selection-comment]').click();
    await page.getByTestId(TESTID.composer).getByRole('radio', { name: 'Blocking' }).click();
    await page.getByTestId(TESTID.composerTextarea).fill('Not before the migration.');
    await page.getByTestId(TESTID.composerAdd).click();
    await page.getByTestId(TESTID.submitReviewOpen).click();
    await expect(verdict('changes_requested')).toBeChecked();
    await expect(page.getByTestId(TESTID.submitConfirm)).toHaveText('Request changes');
    expect(ui.errors).toEqual([]);
  });

  test('U6 / U7: hunks are inline word diffs capped at 6 lines; group titles drop the doc\'s only H1', async ({ page, ui, mock }) => {
    const d = mock.doc('kitchen-sink');
    const v1 = d.source(1);
    const extra = Array.from({ length: 9 }, (_, i) => `- Milestone check ${i + 1}: owners sign off.`).join('\n');
    d.revise({
      source: v1
        .replace('Issue short-lived *access tokens*', 'Issue short-lived, audience-bound *access tokens*')
        .replace('Ship rotation behind a flag.', `Ship rotation behind a flag.\n${extra}`),
      summary: 'Goals wording, milestone checks',
    });
    await ui.open('kitchen-sink');
    await modeTab(page, 'changes').click();
    await expect(page.locator('#sr-base')).toHaveValue('1');
    const items = page.getByTestId(TESTID.changeItem);
    await expect(items).toHaveCount(2);

    // The H1 "Token Service Implementation Spec" is the doc's only H1: not repeated in every group title (which
    // shows the last two headings of the chain).
    const titles = page.locator('.change-group .group-title');
    await expect(titles).toHaveText(['1 Goals', '1 Goals › 1.1 Milestones']);

    // A modified line: unchanged words as context, the inserted words marked.
    const goals = items.first().locator('[data-hunk-diff]');
    await expect(goals.locator('ins')).toHaveText([/^, ?audience-bound ?$/]);
    await expect(goals).toContainText('Issue short-lived');
    await expect(goals).toContainText('access tokens');
    await expect(goals.locator('del')).toHaveCount(0);

    // A long addition: capped at 6 lines with "Show more".
    const long = items.nth(1);
    const diff = long.locator('[data-hunk-diff]');
    await expect(diff.locator('.hd-line')).toHaveCount(6);
    await expect(diff).toHaveClass(/is-capped/);
    const more = long.locator('.hunk-more');
    await expect(more).toHaveText('Show 3 more lines');
    await more.click();
    await expect(diff.locator('.hd-line')).toHaveCount(9);
    await expect(diff).not.toHaveClass(/is-capped/);
    await expect(more).toHaveText('Show less');
    // The diff is part of the item's button: clicking it still goes to the hunk.
    await diff.click();
    await expect(long).toHaveClass(/active/);
    expect(ui.errors).toEqual([]);
  });
});

test.describe('round 2', () => {
  test.use({ scenario: 'round2' });

  test('U5: reopening a blocking thread defaults the verdict to "Request changes"', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await modeTab(page, 'review').click();
    await page.locator('.filter[data-filter="all"]').click();
    const t1 = ui.card('t1');
    await t1.getByTestId(TESTID.verifyReopen).click();
    await page.getByTestId(TESTID.replyTextarea).fill('The grace window needs a number.');
    await page.getByTestId(TESTID.replyAdd).click();
    await expect(page.locator('.drafts-count strong')).toHaveText('1');
    await page.getByTestId(TESTID.submitReviewOpen).click();
    await expect(page.getByTestId(TESTID.submitReviewDialog).locator('input[value="changes_requested"]')).toBeChecked();
    expect(ui.errors).toEqual([]);
  });

  test('U8: hidden / missing anchor chips only while the rendered doc is shown', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await modeTab(page, 'review').click();
    await page.locator('.filter[data-filter="all"]').click();
    const cards = page.getByTestId(TESTID.threadCard);
    await expect(cards).toHaveCount(6);
    // Collapse the section holding t3's table cell inside the doc: the guest reports the target hidden.
    const f = await ui.frame();
    await f.evaluate(() => {
      const table = /** @type {HTMLElement} */ (document.querySelector('table'));
      table.style.display = 'none';
      window.dispatchEvent(new Event('resize'));
    });
    const chip = ui.card('t3').getByRole('button', { name: 'Hidden: Reveal' });
    await expect(chip).toBeVisible();

    for (const mode of ['source', 'history']) {
      await modeTab(page, mode).click();
      await expect(page.getByTestId(TESTID.threadPanel)).toBeVisible();
      await expect(cards).toHaveCount(6);
      await expect(page.getByRole('button', { name: 'Hidden: Reveal' })).toHaveCount(0);
      await expect(page.locator('.card').filter({ hasText: 'Not on page' })).toHaveCount(0);
    }
    await modeTab(page, 'review').click();
    await expect(chip).toBeVisible();
    expect(ui.errors).toEqual([]);
  });
});

test.describe('medium viewport (1050 px)', () => {
  test.use({ scenario: 'round2', viewport: { width: 1050, height: 800 } });

  test('U9: the outline rail is collapsed behind the menu button, the doc gets the width, the choice is remembered', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    const nav = page.locator('#sr-nav');
    const toggle = page.locator('button[aria-controls="sr-nav"]');
    await expect(nav).toBeHidden();
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const side = /** @type {{ width: number }} */ (await page.locator('#sr-side').boundingBox());
    expect(side.width).toBeGreaterThanOrEqual(300);
    expect(side.width).toBeLessThanOrEqual(320);
    const doc = /** @type {{ width: number }} */ (await page.getByTestId(TESTID.docFrame).boundingBox());
    expect(doc.width).toBeGreaterThan(700);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

    // Open it: a column again (not a drawer), kept across reloads.
    await toggle.click();
    await expect(nav).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.scrim')).toHaveCount(0);
    const narrowerDoc = /** @type {{ width: number }} */ (await page.getByTestId(TESTID.docFrame).boundingBox());
    expect(narrowerDoc.width).toBeLessThan(doc.width - 150);
    await nav.locator('.outline-link', { hasText: '3 Tokens' }).click();
    await expect(nav).toBeVisible();
    await page.reload();
    await ui.ready();
    await expect(nav).toBeVisible();
    await page.locator('button[aria-controls="sr-nav"]').click();
    await expect(nav).toBeHidden();
    await page.reload();
    await ui.ready();
    await expect(nav).toBeHidden();
    expect(ui.errors).toEqual([]);
  });

  test('U9: at 1300 px the rail is always shown and the menu button is gone', async ({ page, ui }) => {
    await page.setViewportSize({ width: 1300, height: 800 });
    await ui.open('kitchen-sink');
    await expect(page.locator('#sr-nav')).toBeVisible();
    await expect(page.locator('button[aria-controls="sr-nav"]')).toHaveCount(0);
    expect(ui.errors).toEqual([]);
  });
});
