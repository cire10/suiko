// @ts-check
// What is left to do, and approving (the UI fix round's V1, V2, V3, L7, L12 / V10, V15):
//   - V1: a comment sent right away does not reset "since your last review" (the Changes tab keeps its count and the
//     base stays "v1 · last review"); going through everything the round answered does, with Undo;
//   - V2: the header's Approve with something still pending: "Mark v2 final" is not ticked, warning rows say what an
//     approval would leave (planned changes with Apply, threads for you with Show, threads with Claude, Must fix), and
//     Enter never approves past them (the focus starts on the first warning's button);
//   - V3: with only planned changes left the turn pill reads "Apply 2 planned" and its popover's main action is Apply;
//   - L7: every entry point applies the same planned changes (a planned thread with a reply not sent yet included,
//     marked "Also waits for you" under Planned changes);
//   - L12 / V10: the popover's sentence about them reads right;
//   - V15: a thread that lost its place is in Your turn, not a "problem".

import { test, expect } from './fixtures.mjs';
import { TESTID } from '../../src/shared/protocol.js';

/** @param {any} mock */
const reviewPosts = (mock) => mock.requests.filter((/** @type {any} */ r) => r.method === 'POST' && /\/reviews$/.test(r.path)).map((/** @type {any} */ r) => r.body);
/** @param {import('@playwright/test').Page} page @param {string|RegExp} text */
const toastWith = (page, text) => page.getByTestId(TESTID.toast).filter({ hasText: text });
/** @param {import('@playwright/test').Page} page @param {string} mode */
const modeTab = (page, mode) => page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="${mode}"]`);
/** @param {import('@playwright/test').Page} page @param {string} key */
const filter = (page, key) => page.locator(`.thread-panel .filter[data-filter="${key}"]`);

test.describe('round 2, sending right away', () => {
  test.use({ scenario: 'round2', prefs: 'defaults' });

  test('V1: one comment sent right away keeps "Changes 3" and the "v1 · last review" base', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    const badge = modeTab(page, 'changes').locator('.badge');
    await expect(badge).toHaveText('3');
    await ui.selectText('Remove the legacy session store.');
    await page.locator('[data-selection-comment]').click();
    await page.getByTestId(TESTID.composerTextarea).fill('Why remove it now?');
    await page.getByTestId(TESTID.composerSendNow).click();
    await expect(page.getByTestId(TESTID.composer)).toHaveCount(0);
    expect(reviewPosts(mock).at(-1)).toMatchObject({ instant: true, draftIds: [expect.stringMatching(/^d\d+$/)] });
    const d = mock.doc('kitchen-sink');
    expect(d.reviews.at(-1).instant).toBe(true);
    expect(d.doc.lastReviewedVersion).toBe(1);
    await expect(badge).toHaveText('3');
    await modeTab(page, 'changes').click();
    await expect(page.locator('#sr-base option:checked')).toHaveText('v1 · last review');
    await expect(page.locator('.changes-title')).toContainText('since your last review');
    await expect(page.getByTestId(TESTID.acceptRevisions)).toBeVisible();
    expect(ui.errors).toEqual([]);
  });

  test('V1: going through everything v2 answered makes its changes no longer new (Undo puts them back)', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    const badge = modeTab(page, 'changes').locator('.badge');
    await expect(badge).toHaveText('3');
    // v2 answered t1, t2, t4 and asked t6: done one by one from Your turn
    for (const id of ['t1', 't2', 't4']) {
      await ui.card(id).getByTestId(TESTID.verifyAccept).click();
      await expect(toastWith(page, `${id} is done.`)).toBeVisible();
      await expect(badge).toHaveText('3');
    }
    await ui.card('t6').getByRole('button', { name: 'Reply', exact: true }).click();
    await ui.card('t6').getByTestId(TESTID.replyTextarea).fill('Yes, per client, 30 s by default.');
    await ui.card('t6').getByTestId(TESTID.replyAdd).click();
    const done = toastWith(page, 'You went through everything v2 answered: its changes no longer count as new.');
    await expect(done).toBeVisible();
    await expect(badge).toHaveCount(0);
    const d = mock.doc('kitchen-sink');
    expect(d.doc.acceptedVersion).toBe(2);
    expect(d.doc.lastReviewedVersion).toBe(1);
    await done.getByRole('button', { name: 'Undo' }).click();
    await expect(badge).toHaveText('3');
    expect(d.doc.acceptedVersion ?? null).toBeNull();
    expect(ui.errors).toEqual([]);
  });

  test('V2: Approve with things pending: Mark final off, warnings with their actions; Enter never approves past them', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await page.getByTestId(TESTID.submitReviewOpen).click();
    const dialog = page.getByTestId(TESTID.submitReviewDialog);
    await expect(dialog.locator('input[value="approved"]')).toBeChecked();
    await expect(dialog.getByLabel('Mark v2 final')).not.toBeChecked();
    await expect(dialog.locator('[data-warning="yours"]')).toHaveText(/2 threads still wait for you\s*Show/);
    await expect(dialog.locator('[data-warning="agent"]')).toHaveText('1 thread is still with Claude');
    await expect(dialog.locator('[data-warning="must-fix"]')).toContainText('1 Must fix thread is still open (t1)');
    await expect(dialog.locator('[data-warning="planned"]')).toHaveCount(0);
    // the focus is on the first warning's button, not on Approve: Enter shows the threads, nothing is approved
    await expect(dialog.locator('[data-warning="yours"] button')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(filter(page, 'mine')).toHaveAttribute('aria-selected', 'true');
    expect(reviewPosts(mock)).toHaveLength(0);
    // the answers "Mark 2 answered threads done" would not close count too once it is unticked
    await page.getByTestId(TESTID.submitReviewOpen).click();
    await dialog.getByLabel('Mark 2 answered threads done').uncheck();
    await expect(dialog.locator('[data-warning="yours"]')).toContainText('4 threads still wait for you');
    // Enter in a field (a checkbox) does not approve either; the Approve button itself does
    await dialog.getByLabel('Mark v2 final').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    expect(reviewPosts(mock)).toHaveLength(0);
    await page.getByTestId(TESTID.submitConfirm).click();
    await expect(dialog).toHaveCount(0);
    expect(reviewPosts(mock)).toEqual([expect.objectContaining({ verdict: 'approved', markFinal: false })]);
    expect(ui.errors).toEqual([]);
  });

  test('V15: a thread that lost its place is in Your turn, not a problem: no problems chip', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await expect(page.getByTestId(TESTID.turnPill)).toHaveAccessibleName(/Your turn · 4/);
    await page.waitForTimeout(500);
    await expect(page.getByTestId(TESTID.problems)).toHaveCount(0);
    // t4 lost its place (and Claude did not change it): it waits in Your turn
    await expect(ui.card('t4')).toBeVisible();
    await expect(filter(page, 'mine')).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('rich, only planned changes left', () => {
  test.use({ scenario: 'rich', prefs: 'defaults' });

  test('V3 / V10: the pill reads "Apply 2 planned"; its popover says it right and applies them; Approve warns about them', async ({ page, ui, mock }) => {
    const d = mock.doc('kitchen-sink');
    for (const id of ['t1', 't2', 't4', 't6', 't7']) d.resolve(id);
    await ui.open('kitchen-sink');
    const pill = page.getByTestId(TESTID.turnPill);
    await expect(pill).toHaveAccessibleName(/^Apply 2 planned/);
    await expect(pill.locator('.turn-text')).toHaveText('Apply 2 planned');
    await expect(pill).toHaveClass(/turn-yours/);
    // the threads button still counts open threads
    await expect(page.locator('.threads-toggle')).toHaveAttribute('aria-label', 'Threads (2)');
    // Approve: Mark v2 final off, the planned changes first, with Apply 2 focused
    await page.getByTestId(TESTID.submitReviewOpen).click();
    const dialog = page.getByTestId(TESTID.submitReviewDialog);
    await expect(dialog.getByLabel('Mark v2 final')).not.toBeChecked();
    await expect(dialog.locator('[data-warning="planned"]')).toHaveText(/2 planned changes aren't in v2 yet\s*Apply 2/);
    await expect(dialog.locator('[data-warning="planned"] button')).toBeFocused();
    await page.keyboard.press('Escape');
    // the pill's popover: the sentence, and Apply as the main action
    await pill.click();
    await expect(page.locator('.turn-planned')).toHaveText('Claude planned 2 changes. They go into the document when you apply them.');
    const apply = page.locator('[data-apply-planned]');
    await expect(apply).toHaveText('Apply 2 planned');
    await expect(apply).toHaveClass(/btn-primary/);
    await apply.click();
    await expect.poll(() => reviewPosts(mock).length).toBe(1);
    expect(reviewPosts(mock)[0]).toMatchObject({ draftIds: [], apply: ['t3', 't8'], edits: 'now', instant: true });
    expect(ui.errors).toEqual([]);
  });

  test('L12: one planned change: "It goes into the document when you apply it."', async ({ page, ui, mock }) => {
    const d = mock.doc('kitchen-sink');
    for (const id of ['t1', 't2', 't4', 't6', 't7', 't8']) d.resolve(id);
    await ui.open('kitchen-sink');
    await page.getByTestId(TESTID.turnPill).click();
    await expect(page.locator('.turn-planned')).toHaveText('Claude planned 1 change. It goes into the document when you apply it.');
  });
});

test.describe('rich, batched, a planned thread that also waits for you', () => {
  test.use({ scenario: 'rich' });

  test('L7: the panel, a card, the pill and the palette apply the same planned changes; the one with a reply says so', async ({ page, ui, mock }) => {
    const d = mock.doc('kitchen-sink');
    d.saveDraft({ kind: 'reply', thread: 't3', body: 'Also mention the rotation window.', reopen: false });
    await ui.open('kitchen-sink');
    await filter(page, 'agent').click();
    const apply = page.getByTestId(TESTID.applyPlanned);
    await expect(apply).toHaveText('Apply 2');
    await expect(page.locator('.planned-group .group-label')).toContainText('Planned changes · 2');
    await expect(ui.card('t3').locator('[data-also-yours]')).toHaveText('Also waits for you');
    await expect(ui.card('t8').locator('[data-also-yours]')).toHaveCount(0);
    // it is in Your turn too (its reply is not sent yet)
    await expect(filter(page, 'mine').locator('.count')).toHaveText(await page.getByTestId(TESTID.turnPill).locator('.turn-count').innerText());
    await page.getByTestId(TESTID.turnPill).click();
    await expect(page.locator('[data-apply-planned]')).toHaveText('Apply 2 planned');
    await page.keyboard.press('Escape');
    // the palette's count
    await page.getByTestId(TESTID.commandPaletteOpen).click();
    await page.getByTestId(TESTID.commandPaletteInput).fill('apply planned');
    await expect(page.locator(`[data-testid="${TESTID.commandItem}"][data-command-id="apply-planned"]`)).toContainText('2');
    await page.keyboard.press('Escape');
    await apply.click();
    await expect.poll(() => reviewPosts(mock).length).toBe(1);
    expect(reviewPosts(mock)[0]).toMatchObject({ draftIds: [], apply: ['t3', 't8'], edits: 'now' });
    // the reply draft stayed a draft
    expect(d.drafts.items.map((/** @type {any} */ x) => [x.kind, x.thread])).toEqual([['reply', 't3']]);
    expect(ui.errors).toEqual([]);
  });
});
