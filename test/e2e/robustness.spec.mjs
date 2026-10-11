// @ts-check
// Regression tests for the UI robustness findings (UIR-*): typed input is never dropped silently, a new version
// never changes what the Submit dialog approves, edits in progress go out with the review, retries do not duplicate
// drafts, and a double click sends one request. Most run against the mock daemon; UIR-1 and UIR-7 also run against
// the REAL daemon + engine (test/e2e/real-daemon.mjs), whose submit and targets semantics they depend on.

import { test as base } from '@playwright/test';
import { TESTID } from '../../src/shared/protocol.js';
import { expect, test, Ui } from './fixtures.mjs';
import { startRealDaemon } from './real-daemon.mjs';

/** @typedef {import('@playwright/test').Page} Page */

/** @param {Page} page @param {string} mode */
const modeTab = (page, mode) => page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="${mode}"]`);

/** @param {Page} page */
async function focusUi(page) {
  await page.evaluate(() => /** @type {HTMLElement|null} */ (document.activeElement)?.blur?.());
}

/** @param {Page} page @param {string|RegExp} text */
const toastWith = (page, text) => page.getByTestId(TESTID.toast).filter({ hasText: text });

/** Clicks plain text in the doc, so the focus (and the next key) is inside the doc iframe. @param {Page} page @param {Ui} ui */
async function focusDoc(page, ui) {
  const p = await ui.pointIn('p', 'This spec describes');
  await page.mouse.click(p.x + 5, p.cy);
}

test.describe('fresh doc', () => {
  test.use({ scenario: 'fresh' });

  test('UIR-1: Approve is refused when the version on screen is not the newest one, also when no event announced it', async ({ page, ui, mock }) => {
    // No event stream: the agent's revision lands without the UI hearing about it.
    await page.route('**/api/events**', (route) => route.abort());
    await ui.open('kitchen-sink');
    await page.getByTestId(TESTID.submitReviewOpen).click();
    const dialog = page.getByTestId(TESTID.submitReviewDialog);
    await dialog.locator('input[value="approved"]').check();
    await expect(dialog.getByLabel('Mark v1 final')).toBeChecked();
    const d = mock.doc('kitchen-sink');
    d.revise({ source: d.source(1).replace('Last revised 2026-10-10.', 'Last revised 2026-10-12.'), summary: 'late edit' });
    await page.getByTestId(TESTID.submitConfirm).click();
    await expect(dialog.locator('.error')).toHaveText('v2 arrived while you were reviewing v1. Review v2 before approving.');
    expect(d.doc.final).toBeNull();
    expect(d.reviews).toHaveLength(0);
    // The check refreshed the state: the dialog now says so itself, and Approve stays off.
    await expect(dialog.locator('.stale-warning')).toContainText('v2 arrived while you were reviewing v1');
    await expect(page.getByTestId(TESTID.submitConfirm)).toBeDisabled();
    await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('1');
  });

  test('UIR-3: submitting while a draft is being edited sends the edited text and closes the editor', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await ui.selectText('Prototype the issuer.');
    await page.locator('[data-selection-comment]').click();
    await page.getByTestId(TESTID.composerTextarea).fill('Original draft text');
    await page.getByTestId(TESTID.composerAdd).click();
    const draft = page.locator(`[data-testid="${TESTID.threadCard}"][data-draft-id="d1"]`);
    await expect(draft).toContainText('Original draft text');

    await draft.getByRole('button', { name: 'Edit' }).click();
    const composer = page.getByTestId(TESTID.composer);
    await expect(composer).toContainText('Edit draft d1');
    await page.getByTestId(TESTID.composerTextarea).fill('Edited text, not yet saved');
    // Straight to Submit (well within the 800 ms autosave debounce).
    await page.keyboard.press('ControlOrMeta+Shift+Enter');
    await page.getByTestId(TESTID.submitConfirm).click();
    await expect(page.getByTestId(TESTID.submitReviewDialog)).toBeHidden();
    await expect(toastWith(page, 'Review submitted (rv1)')).toBeVisible();
    const d = mock.doc('kitchen-sink');
    expect(d.thread('t1').comments[0].body).toBe('Edited text, not yet saved');
    expect(d.drafts.items).toEqual([]);
    // The editor of the submitted draft is gone (it could never be saved again).
    await expect(composer).toBeHidden();
    await expect(ui.card('t1')).toContainText('Edited text, not yet saved');
    await expect(toastWith(page, 'not found')).toHaveCount(0);
    expect(ui.errors).toEqual([]);
  });

  test('UIR-4: an edited suggestion is input: kept when another composer is asked for, restorable after Cancel and after a reload', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await ui.selectText('Ship rotation behind a flag.');
    await focusUi(page);
    await page.keyboard.press('s');
    const input = page.getByTestId(TESTID.composerSuggestion);
    await expect(input).toHaveValue('Ship rotation behind a flag.');
    const edited = 'Ship rotation behind the token-rotation flag, default off.';
    await input.fill(edited);
    await expect(page.getByTestId(TESTID.composerTextarea)).toHaveValue('');

    // Another selection + c: refused, the suggestion stays.
    await ui.selectText('Rotate refresh tokens safely.');
    await focusUi(page);
    await page.keyboard.press('c');
    await expect(toastWith(page, 'Finish or cancel the open comment first.')).toBeVisible();
    await expect(input).toHaveValue(edited);
    await expect(page.getByTestId(TESTID.composer).locator('.agent-sees')).toContainText('Ship rotation behind a flag.');

    // Reload: the backup brings the suggestion back.
    await page.waitForTimeout(600); // backup debounce (400 ms)
    await page.reload();
    await ui.ready();
    const restore = toastWith(page, 'You have an unsent comment from earlier.');
    await expect(restore).toBeVisible();
    await restore.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByTestId(TESTID.composerSuggestion)).toHaveValue(edited);

    // Cancel offers Undo for a suggestion-only composer.
    await page.getByTestId(TESTID.composer).getByRole('button', { name: 'Cancel' }).click();
    const undo = toastWith(page, 'Comment discarded.');
    await expect(undo).toBeVisible();
    await undo.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByTestId(TESTID.composerSuggestion)).toHaveValue(edited);
  });

  test('UIR-9: retrying Send now after a failed review request sends the same draft, not a copy', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await ui.selectText('Remove the legacy session store.');
    await page.locator('[data-selection-comment]').click();
    await page.getByTestId(TESTID.composerTextarea).fill('Send this right now');
    mock.failNext('POST', /\/reviews$/, 503);
    await page.getByTestId(TESTID.composerSendNow).click();
    const composer = page.getByTestId(TESTID.composer);
    await expect(composer.locator('.error')).toContainText('Connection lost');
    const d = mock.doc('kitchen-sink');
    expect(d.drafts.items.map((x) => x.id)).toEqual(['d1']);
    await expect(page.getByTestId(TESTID.composerSendNow)).toBeEnabled();

    await page.getByTestId(TESTID.composerSendNow).click();
    await expect(toastWith(page, 'Sent to the agent')).toBeVisible();
    await expect(composer).toBeHidden();
    expect(d.drafts.items).toEqual([]);
    expect(d.reviews).toHaveLength(1);
    expect(d.reviews[0].newThreads).toEqual(['t1']);
    expect(d.thread('t1').comments[0].body).toBe('Send this right now');
    const posts = mock.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/reviews'));
    expect(posts.map((r) => r.body.draftIds)).toEqual([['d1'], ['d1']]);
    await expect(page.locator('.drafts-count')).toContainText('0');
  });

  test('UIR-11: the Submit dialog keeps the summary and verdict through Esc and a backdrop click, until submitted', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    const open = page.getByTestId(TESTID.submitReviewOpen);
    const dialog = page.getByTestId(TESTID.submitReviewDialog);
    const summary = dialog.getByLabel('Summary');
    await open.click();
    await summary.fill('A long summary I do not want to type twice.');
    await dialog.locator('input[value="changes_requested"]').check();
    await summary.press('Escape');
    await expect(dialog).toBeHidden();
    await open.click();
    await expect(summary).toHaveValue('A long summary I do not want to type twice.');
    await expect(dialog.locator('input[value="changes_requested"]')).toBeChecked();

    // A click on the backdrop closes it too, without losing anything.
    await page.mouse.click(12, 450); // the scrim, left of the centred dialog
    await expect(dialog).toBeHidden();
    await open.click();
    await expect(summary).toHaveValue('A long summary I do not want to type twice.');

    await page.getByTestId(TESTID.submitConfirm).click();
    await expect(dialog).toBeHidden();
    expect(mock.doc('kitchen-sink').reviews[0]).toMatchObject({ verdict: 'changes_requested', body: 'A long summary I do not want to type twice.' });
    // Submitted: the next review starts empty.
    await open.click();
    await expect(summary).toHaveValue('');
  });

  test('UIR-12: a double click on Apply now sends one request and reports no false error', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await ui.selectText('Ship rotation behind a flag.');
    await focusUi(page);
    await page.keyboard.press('s');
    await page.getByTestId(TESTID.composerSuggestion).fill('Ship rotation behind the token-rotation flag.');
    await page.getByTestId(TESTID.composerSendNow).click();
    await expect(ui.card('t1')).toBeVisible();

    await ui.card('t1').getByRole('button', { name: 'Apply now' }).dblclick();
    await expect(toastWith(page, 'Suggestion applied as v2.')).toBeVisible();
    await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
    await page.waitForTimeout(300);
    expect(mock.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/threads/t1/apply'))).toHaveLength(1);
    await expect(toastWith(page, /unrecorded changes|Could not apply/)).toHaveCount(0);
  });

  test('UIR-6: a doc page that navigates away shows as disconnected, with a way back; normal loads never do', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    const lost = page.locator('[data-frame-lost]');
    // A version switch reloads the frame with a guest: no banner.
    const d = mock.doc('kitchen-sink');
    d.revise({ source: d.source(1).replace('Last revised 2026-10-10.', 'Last revised 2026-10-12.'), summary: 'v2' });
    await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
    await ui.ready();
    await page.waitForTimeout(1800);
    await expect(lost).toHaveCount(0);

    // The frame leaves for a page without the guest (what a link does where the Navigation API is missing).
    const f = await ui.frame();
    await f.goto(`${mock.contentOrigin}/not-the-doc.html`).catch(() => {});
    await expect(lost).toBeVisible({ timeout: 5000 });
    await expect(lost).toContainText('The document navigated away');
    await expect(page.locator('.frame-wrap')).toHaveAttribute('data-guest', 'loading');
    await lost.getByRole('button', { name: 'Back to v2' }).click();
    await ui.ready();
    await expect(lost).toHaveCount(0);
    expect((await ui.frame()).url()).toMatch(/\/v2\/.*kitchen-sink\.md/);
    expect(await ui.inspect()).toBeTruthy();
    expect(ui.errors.filter((e) => !/404|Failed to load resource/.test(e))).toEqual([]);
  });
});

test.describe('round 2', () => {
  test.use({ scenario: 'round2' });

  test('UIR-3: an edited reply draft goes out with the review; deleting it while editing keeps the text as a new reply', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await modeTab(page, 'review').click();
    const t3 = ui.card('t3');
    await t3.getByRole('button', { name: 'Reply' }).click();
    await t3.getByTestId(TESTID.replyTextarea).fill('Old reply text');
    await t3.getByTestId(TESTID.replyAdd).click();
    await expect(t3.locator('.pending-reply')).toContainText('Old reply text');
    const d = mock.doc('kitchen-sink');
    const [saved] = d.drafts.items;

    // Edit the pending reply, then delete it from its own Delete link: the typed text stays and can be added.
    await t3.locator('.pending-reply').getByRole('button', { name: 'Edit' }).click();
    await expect(t3.getByTestId(TESTID.replyTextarea)).toHaveValue('Old reply text');
    await t3.getByTestId(TESTID.replyTextarea).fill('Edited before deleting');
    await t3.locator('.pending-reply').getByRole('button', { name: 'Delete' }).click();
    await expect(t3.locator('.pending-reply')).toHaveCount(0);
    await expect(t3.getByTestId(TESTID.replyTextarea)).toHaveValue('Edited before deleting');
    await t3.getByTestId(TESTID.replyAdd).click();
    await expect(t3.locator('.pending-reply')).toContainText('Edited before deleting');
    await expect(toastWith(page, 'Reply not saved')).toHaveCount(0);
    expect(d.drafts.items.map((x) => [x.kind, x.body])).toEqual([['reply', 'Edited before deleting']]);
    expect(d.drafts.items[0].id).not.toBe(saved.id);

    // Edit it again and submit the review without saving: the edited text is what the agent gets.
    await t3.locator('.pending-reply').getByRole('button', { name: 'Edit' }).click();
    await t3.getByTestId(TESTID.replyTextarea).fill('New reply text after edit');
    await page.getByTestId(TESTID.submitReviewOpen).click();
    await page.getByTestId(TESTID.submitConfirm).click();
    await expect(page.getByTestId(TESTID.submitReviewDialog)).toBeHidden();
    const comments = d.thread('t3').comments;
    expect(comments[comments.length - 1].body).toBe('New reply text after edit');
    expect(d.drafts.items).toEqual([]);
    await expect(t3.getByTestId(TESTID.replyTextarea)).toHaveCount(0);
    expect(ui.errors).toEqual([]);
  });

  test('UIR-5: a typed reply survives Reply on another thread and Esc in the doc; Cancel offers Undo', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await modeTab(page, 'review').click();
    const t3 = ui.card('t3');
    await t3.getByRole('button', { name: 'Reply' }).click();
    const box = t3.getByTestId(TESTID.replyTextarea);
    await box.fill('A long reply about the refresh TTL.');

    // Reply / Reopen on another thread: refused while this one holds text.
    await ui.card('t1').getByTestId(TESTID.verifyReopen).click();
    await expect(toastWith(page, 'Finish or cancel the open reply on t3 first.')).toBeVisible();
    await expect(box).toHaveValue('A long reply about the refresh TTL.');
    await expect(ui.card('t1').getByTestId(TESTID.replyTextarea)).toHaveCount(0);

    // Esc pressed inside the doc (to clear a selection, close the page's own popup...) does not discard it.
    await focusDoc(page, ui);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await expect(box).toHaveValue('A long reply about the refresh TTL.');

    // Cancel discards it with an Undo.
    await t3.getByRole('button', { name: 'Cancel' }).click();
    await expect(box).toHaveCount(0);
    const undo = toastWith(page, 'Reply discarded.');
    await expect(undo).toBeVisible();
    await undo.getByRole('button', { name: 'Undo' }).click();
    await expect(t3.getByTestId(TESTID.replyTextarea)).toHaveValue('A long reply about the refresh TTL.');

    // The same holds for the composer: Esc in the doc keeps a written comment.
    await t3.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'General comment' }).click();
    await page.getByTestId(TESTID.composerTextarea).fill('Overall the rollout section needs owners.');
    await focusDoc(page, ui);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await expect(page.getByTestId(TESTID.composerTextarea)).toHaveValue('Overall the rollout section needs owners.');
  });

  test('UIR-12: a double click on Resolve sends one request and shows one toast', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await modeTab(page, 'review').click();
    await ui.card('t3').getByRole('button', { name: 'Resolve' }).dblclick();
    await expect(toastWith(page, 't3 resolved.')).toHaveCount(1);
    await expect.poll(() => mock.doc('kitchen-sink').thread('t3').status).toBe('resolved');
    await page.waitForTimeout(300);
    expect(mock.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/threads/t3/resolve'))).toHaveLength(1);
    await expect(toastWith(page, 't3 resolved.')).toHaveCount(1);
  });
});

// ------------------------------------------------------------------------------------------ the real daemon

/** @typedef {Awaited<ReturnType<typeof startRealDaemon>>} Real */

const realTest = base.extend(/** @type {any} */ ({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here
  real: async ({}, /** @type {(r: Real) => Promise<void>} */ use) => {
    const real = await startRealDaemon();
    await use(real);
    await real.close();
  },
  ui: async (/** @type {any} */ { page, real }, /** @type {(u: Ui) => Promise<void>} */ use) => {
    await use(new Ui(page, real));
  },
}));

realTest('UIR-1 (real daemon): a revision recorded while the Submit dialog is open neither switches the view nor gets approved unseen', async (/** @type {any} */ { page, ui, real }) => {
  /** @type {Real} */
  const r = real;
  await ui.open('kitchen-sink');
  await page.getByTestId(TESTID.submitReviewOpen).click();
  const dialog = page.getByTestId(TESTID.submitReviewDialog);
  await dialog.getByLabel('Summary').fill('Looks good to me.');
  await dialog.locator('input[value="approved"]').check();
  await expect(dialog.getByLabel('Mark v1 final')).toBeChecked();

  const ks = r.read('docs/kitchen-sink.md');
  r.write('docs/kitchen-sink.md', ks.replace('Rotate refresh tokens safely.', 'Rotate refresh tokens UNSAFELY (changed by agent).'));
  await r.revise('kitchen-sink', { summary: 'late edit' });

  await expect(toastWith(page, 'v2 ready')).toBeVisible();
  await expect(dialog.locator('.stale-warning')).toContainText('v2 arrived while you were reviewing v1. Review v2 before approving.');
  await expect(dialog.getByLabel('Mark v1 final')).toBeVisible();
  await expect(page.getByTestId(TESTID.submitConfirm)).toBeDisabled();
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('1');
  expect((await r.state('kitchen-sink')).doc.final ?? null).toBeNull();

  // Review v2 first (the summary is kept), then approve it.
  await dialog.getByRole('button', { name: 'Review v2' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
  await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId(TESTID.submitReviewOpen).click();
  await expect(dialog.getByLabel('Summary')).toHaveValue('Looks good to me.');
  await expect(dialog.locator('input[value="approved"]')).toBeChecked();
  await expect(dialog.getByLabel('Mark v2 final')).toBeChecked();
  await expect(dialog.locator('.stale-warning')).toHaveCount(0);
  await page.getByTestId(TESTID.submitConfirm).click();
  await expect(dialog).toBeHidden();
  await expect(toastWith(page, 'Approved (rv1)')).toBeVisible();
  const st = await r.state('kitchen-sink');
  expect(st.doc.final).toMatchObject({ version: 2 });
  expect(st.doc.lastReviewedVersion).toBe(2);
  expect(ui.errors).toEqual([]);
});

realTest('UIR-7 (real daemon): drafts written on v1 are carried forward to v2 when their text is still there; one whose text is gone says so and leads back to v1', async (/** @type {any} */ { page, ui, real }) => {
  /** @type {Real} */
  const r = real;
  await ui.open('kitchen-sink');
  for (const [text, body] of [['Ship rotation behind a flag.', 'draft on v1'], ['Remove the legacy session store.', 'gone in v2']]) {
    await ui.selectText(text);
    await focusUi(page);
    await page.keyboard.press('c');
    await page.getByTestId(TESTID.composerTextarea).fill(body);
    await page.getByTestId(TESTID.composerAdd).click();
    await expect(page.getByTestId(TESTID.composerTextarea)).toBeHidden();
  }
  const card1 = page.locator(`[data-testid="${TESTID.threadCard}"][data-draft-id="d1"]`);
  const card2 = page.locator(`[data-testid="${TESTID.threadCard}"][data-draft-id="d2"]`);
  await expect(card1).toBeVisible();
  await expect(card2).toBeVisible();
  await expect(card1.locator('.draft-version')).toHaveCount(0);
  await expect.poll(async () => (await ui.inspect()).highlights['sr-draft'] || 0).toBeGreaterThan(1);

  // The agent records v2: a new line above the first drafted sentence, the second one removed. No composer is open,
  // so the view follows.
  const ks = r.read('docs/kitchen-sink.md');
  r.write('docs/kitchen-sink.md', ks
    .replace('2. Ship rotation behind a flag.', '2. Ship rotation behind a flag in staging first.\n3. Ship rotation behind a flag.')
    .replace('3. Remove the legacy session store.\n', ''));
  await r.revise('kitchen-sink', { summary: 'milestone' });
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');

  // d1: carried forward and painted on v2 (the chip only says where it was written).
  const chip1 = card1.locator('.draft-version');
  await expect(chip1).toHaveText('On v1');
  await expect(chip1).not.toHaveClass(/tone-warn/);
  await expect(chip1).not.toHaveAttribute('title', /not shown/);
  await expect(card1.locator('.target-lines')).toHaveText(/^v1 L\d+/);
  await card1.locator('.comment-body').click();
  await expect.poll(async () => (await ui.inspect()).activeId).toBe('d1');
  await expect(toastWith(page, 'was written on v1')).toHaveCount(0);
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');

  // d2: its text is gone on v2, so it is not painted; its card leads back to v1.
  const chip2 = card2.locator('.draft-version');
  await expect(chip2).toHaveText('On v1');
  await expect(chip2).toHaveClass(/tone-warn/);
  await expect(chip2).toHaveAttribute('title', /not shown on v2/);
  await card2.locator('.comment-body').click();
  const toast = toastWith(page, 'd2 was written on v1 and is not shown on v2');
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'View on v1' }).click();
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('1');
  await expect.poll(async () => (await ui.inspect()).activeId).toBe('d2');
  await expect.poll(async () => (await ui.inspect()).highlights['sr-draft'] || 0).toBeGreaterThan(1);
  await expect(card2.locator('.draft-version')).toHaveCount(0);
  expect(ui.errors).toEqual([]);
});
