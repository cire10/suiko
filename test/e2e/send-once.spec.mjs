// @ts-check
// One copy of a comment, always (the UI fix round's L2-L5 and the sending part of V9), with the calm-review defaults
// (Send comments: Right away):
//   - a reply draft being edited in the reply box has no Send of its own on its pending row; the Send dialog sends it
//     and closes the box (L2);
//   - a Send whose review request fails keeps the composer / reply box open with the error, bound to the draft it
//     created: that draft's card has no Send of its own, a retry sends it once, the Send dialog sends it and closes
//     the composer, Cancel deletes it and says so, and a draft gone meanwhile is never silently recreated (L3);
//   - a held Cmd/Ctrl+Enter acts once: its auto-repeat never answers "Ask before sending" (composer, reply box) nor
//     sends twice (the Send dialog's summary) (L4);
//   - Edit on a pending reply opens that reply draft, also when the thread has two; Use in doc, with sending batched,
//     joins the thread's reply draft instead of making a second one; startReply can prefill a new reply (L5);
//   - the toasts: "Saved for Claude. It gets it when it connects." while Claude is not connected, "Sent to Claude."
//     while it listens, and an identical toast replaces the one on screen instead of stacking (V9).
// The mock is the in-memory daemon (mock-server.mjs) on random ports.

import { test, expect } from './fixtures.mjs';
import { TESTID } from '../../src/shared/protocol.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** @param {any} mock */
const reviewPosts = (mock) => mock.requests.filter((/** @type {any} */ r) => r.method === 'POST' && /\/reviews$/.test(r.path)).map((/** @type {any} */ r) => r.body);
/** @param {any} mock */
const draftPosts = (mock) => mock.requests.filter((/** @type {any} */ r) => r.method === 'POST' && /\/drafts$/.test(r.path)).map((/** @type {any} */ r) => r.body);
/** @param {import('@playwright/test').Page} page @param {string|RegExp} text */
const toastWith = (page, text) => page.getByTestId(TESTID.toast).filter({ hasText: text });

/** A thread t1 (a general comment of round 1) to reply to. @param {any} mock */
function withThread(mock) {
  const d = mock.doc('kitchen-sink');
  d.saveDraft({ kind: 'thread', type: 'comment', severity: 'normal', capture: { kind: 'doc' }, body: 'Overall: fine', version: 1 });
  d.submitReview({ verdict: 'comment', body: '' });
  return d;
}

/**
 * Holds Cmd/Ctrl+Enter: the first keydown, then (once `between` is done: what the first press showed) one auto-repeat
 * (Playwright marks it repeat: true), as a key held past the system's repeat delay sends it.
 * @param {import('@playwright/test').Page} page @param {() => Promise<unknown>} [between]
 */
async function holdModEnter(page, between) {
  await page.keyboard.down(MOD);
  await page.keyboard.down('Enter');
  await between?.();
  await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  await page.keyboard.up(MOD);
}

test.describe('fresh doc, sending right away', () => {
  test.use({ scenario: 'fresh', prefs: 'defaults' });

  test('L2: the reply draft the box edits has no Send of its own; the Send dialog sends it once and closes the box', async ({ page, ui, mock }) => {
    const d = withThread(mock);
    await ui.open('kitchen-sink');
    const t1 = ui.card('t1');
    await t1.getByRole('button', { name: 'Reply', exact: true }).click();
    await t1.getByTestId(TESTID.replyTextarea).fill('Keep this for later');
    await page.keyboard.press(`${MOD}+Shift+Enter`);
    const row = t1.locator('.pending-reply');
    await expect(row).toContainText('Keep this for later');
    await expect(row.getByRole('button')).toHaveText(['Send', 'Edit', 'Delete']);
    // Edit: the box holds the draft; its row says so and keeps only Delete
    await row.getByRole('button', { name: 'Edit' }).click();
    await expect(t1.getByTestId(TESTID.replyTextarea)).toHaveValue('Keep this for later');
    await expect(row).toContainText('Being edited below');
    await expect(row.getByRole('button')).toHaveText(['Delete']);
    await t1.getByTestId(TESTID.replyTextarea).fill('Keep this for later, edited');
    // the Send dialog sends the edited text, and the box (bound to the sent draft) closes
    await page.getByTestId(TESTID.submitReviewOpen).click();
    await page.getByTestId(TESTID.submitReviewDialog).locator('input[value="comment"]').check();
    await page.getByTestId(TESTID.submitConfirm).click();
    await expect(page.getByTestId(TESTID.submitReviewDialog)).toHaveCount(0);
    await expect(t1.getByTestId(TESTID.replyTextarea)).toHaveCount(0);
    expect(d.thread('t1').comments.map((/** @type {any} */ c) => c.body)).toEqual(['Overall: fine', 'Keep this for later, edited']);
    expect(d.drafts.items).toEqual([]);
    expect(ui.errors).toEqual([]);
  });

  test('L3: a failed Send keeps the composer bound to its draft: the card has no Send; Send again sends it once', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await ui.generalComment();
    await page.getByTestId(TESTID.composerTextarea).fill('Failing comment');
    mock.failNext('POST', /\/reviews$/, 500);
    await page.keyboard.press(`${MOD}+Enter`);
    const composer = page.getByTestId(TESTID.composer);
    await expect(composer.locator('.error')).toContainText('Not sent');
    await expect(composer.locator('.error')).toContainText('kept as draft d1');
    await expect(page.getByTestId(TESTID.composerTextarea)).toHaveValue('Failing comment');
    // its draft is listed, but as being edited, with no Send of its own
    const card = page.locator(`[data-testid="${TESTID.threadCard}"][data-draft-id="d1"]`);
    await expect(card).toContainText('Being edited');
    await expect(card.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    // the retry saves into d1 and sends it: one thread, no second draft
    await page.getByTestId(TESTID.composerTextarea).fill('Failing comment, take two');
    await page.getByTestId(TESTID.composerSendNow).click();
    await expect(composer).toHaveCount(0);
    const d = mock.doc('kitchen-sink');
    expect(d.threads.map((/** @type {any} */ t) => t.comments[0].body)).toEqual(['Failing comment, take two']);
    expect(draftPosts(mock)).toHaveLength(1);
    expect(reviewPosts(mock).map((/** @type {any} */ r) => r.draftIds)).toEqual([['d1'], ['d1']]);
    expect(ui.errors.filter((e) => !/500/.test(e))).toEqual([]);
  });

  test('L3: after a failed Send, the Send dialog sends the composer\'s draft (its text as typed) and closes the composer', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await ui.generalComment();
    await page.getByTestId(TESTID.composerTextarea).fill('Flaky network comment');
    mock.failNext('POST', /\/reviews$/, 503);
    await page.keyboard.press(`${MOD}+Enter`);
    const composer = page.getByTestId(TESTID.composer);
    await expect(composer.locator('.error')).toContainText('Connection lost');
    await page.getByTestId(TESTID.composerTextarea).fill('Flaky network comment, edited');
    await expect(page.getByTestId(TESTID.submitReviewOpen)).toHaveText(/Send\s*1/);
    await page.getByTestId(TESTID.submitReviewOpen).click();
    const dialog = page.getByTestId(TESTID.submitReviewDialog);
    // the open comment is in the review (its draft): no "not in this review yet" note
    await expect(dialog).not.toContainText('not in this review yet');
    await dialog.locator('input[value="comment"]').check();
    await page.getByTestId(TESTID.submitConfirm).click();
    await expect(dialog).toHaveCount(0);
    await expect(composer).toHaveCount(0);
    const d = mock.doc('kitchen-sink');
    expect(d.threads.map((/** @type {any} */ t) => t.comments[0].body)).toEqual(['Flaky network comment, edited']);
    expect(d.drafts.items).toEqual([]);
  });

  test('L3: Cancel after a failed Send deletes the draft it created and says so; Undo brings the text back', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await ui.generalComment();
    await page.getByTestId(TESTID.composerTextarea).fill('Discard me');
    mock.failNext('POST', /\/reviews$/, 500);
    await page.keyboard.press(`${MOD}+Enter`);
    const composer = page.getByTestId(TESTID.composer);
    await expect(composer.locator('.error')).toBeVisible();
    await composer.getByRole('button', { name: 'Cancel' }).click();
    const toast = toastWith(page, 'Comment discarded, and its draft d1 deleted.');
    await expect(toast).toBeVisible();
    await expect.poll(() => mock.doc('kitchen-sink').drafts.items.length).toBe(0);
    await expect(page.getByTestId(TESTID.submitReviewOpen)).toHaveText('Approve');
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByTestId(TESTID.composerTextarea)).toHaveValue('Discard me');
    await expect(composer.locator('.error')).toHaveCount(0);
    // sending it now makes a new draft (the old one is gone), once
    await page.getByTestId(TESTID.composerSendNow).click();
    await expect(composer).toHaveCount(0);
    expect(mock.doc('kitchen-sink').threads.map((/** @type {any} */ t) => t.comments[0].body)).toEqual(['Discard me']);
  });

  test('L3: a retry whose draft went out meanwhile (another tab) sends nothing again and says so', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await ui.generalComment();
    await page.getByTestId(TESTID.composerTextarea).fill('Sent elsewhere');
    mock.failNext('POST', /\/reviews$/, 500);
    await page.keyboard.press(`${MOD}+Enter`);
    const composer = page.getByTestId(TESTID.composer);
    await expect(composer.locator('.error')).toBeVisible();
    // another tab sends the whole review, d1 with it
    const d = mock.doc('kitchen-sink');
    d.submitReview({ verdict: 'comment', body: '' });
    await page.getByTestId(TESTID.composerSendNow).click();
    await expect(composer.locator('.error')).toContainText('Draft d1 was already sent or deleted, so nothing was sent again');
    expect(d.threads.map((/** @type {any} */ t) => t.comments[0].body)).toEqual(['Sent elsewhere']);
    expect(draftPosts(mock)).toHaveLength(1);
  });

  test('L3: a failed reply Send keeps the box open with the error; its pending row has no Send; the retry sends one reply', async ({ page, ui, mock }) => {
    const d = withThread(mock);
    await ui.open('kitchen-sink');
    const t1 = ui.card('t1');
    await t1.getByRole('button', { name: 'Reply', exact: true }).click();
    await t1.getByTestId(TESTID.replyTextarea).fill('Reply that fails');
    mock.failNext('POST', /\/reviews$/, 500);
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(t1.locator('.reply-error')).toContainText('Not sent');
    await expect(t1.getByTestId(TESTID.replyTextarea)).toHaveValue('Reply that fails');
    const row = t1.locator('.pending-reply');
    await expect(row).toContainText('Being edited below');
    await expect(row.getByRole('button')).toHaveText(['Delete']);
    await t1.getByTestId(TESTID.replyAdd).click();
    await expect(t1.getByTestId(TESTID.replyTextarea)).toHaveCount(0);
    expect(d.thread('t1').comments.map((/** @type {any} */ c) => c.body)).toEqual(['Overall: fine', 'Reply that fails']);
    expect(d.drafts.items).toEqual([]);
  });

  test('V9: "Saved for Claude" while it is not connected, "Sent to Claude." while it listens; identical toasts do not stack', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    for (const text of ['First', 'Second', 'Third']) {
      await ui.generalComment();
      await page.getByTestId(TESTID.composerTextarea).fill(text);
      await page.getByTestId(TESTID.composerSendNow).click();
      await expect(page.getByTestId(TESTID.composer)).toHaveCount(0);
    }
    await expect(toastWith(page, 'Saved for Claude. It gets it when it connects.')).toHaveCount(1);
    await expect(toastWith(page, 'Sent to Claude')).toHaveCount(0);
    mock.doc('kitchen-sink').setWaiters([{ agent: 'claude' }]);
    await expect(page.getByTestId(TESTID.turnPill)).toContainText('listening');
    await ui.generalComment();
    await page.getByTestId(TESTID.composerTextarea).fill('Fourth');
    await page.getByTestId(TESTID.composerSendNow).click();
    await expect(toastWith(page, 'Sent to Claude.')).toHaveCount(1);
    expect(ui.errors).toEqual([]);
  });
});

test.describe('fresh doc, "Ask before sending"', () => {
  test.use({ scenario: 'fresh', prefs: 'defaults' });
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (window.top === window && localStorage.getItem('suiko.confirmSendNow') == null) localStorage.setItem('suiko.confirmSendNow', '1');
    });
  });

  test('L4: a held Cmd/Ctrl+Enter in the composer shows the question and never answers it', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await ui.generalComment();
    await expect(page.getByTestId(TESTID.composer).locator('.agent-sees')).toBeVisible();
    await page.getByTestId(TESTID.composerTextarea).fill('Held key comment');
    await holdModEnter(page, () => expect(page.locator('[data-confirm-send]')).toBeVisible());
    await expect(page.locator('[data-confirm-send]')).toBeVisible();
    await page.waitForTimeout(500);
    expect(reviewPosts(mock)).toHaveLength(0);
    // a deliberate second press confirms
    await page.getByTestId(TESTID.composerTextarea).focus();
    await page.keyboard.press(`${MOD}+Enter`);
    await expect.poll(() => reviewPosts(mock).length).toBe(1);
  });

  test('L4: a held Cmd/Ctrl+Enter in the reply box shows the question and never answers it', async ({ page, ui, mock }) => {
    withThread(mock);
    await ui.open('kitchen-sink');
    const t1 = ui.card('t1');
    await t1.getByRole('button', { name: 'Reply', exact: true }).click();
    await t1.getByTestId(TESTID.replyTextarea).fill('Held key reply');
    const before = reviewPosts(mock).length;
    await holdModEnter(page, () => expect(t1.locator('[data-confirm-send]')).toBeVisible());
    await expect(t1.locator('[data-confirm-send]')).toBeVisible();
    await page.waitForTimeout(500);
    expect(reviewPosts(mock).length - before).toBe(0);
  });
});

test.describe('fresh doc, sending batched', () => {
  test.use({ scenario: 'fresh' });

  test('L4: a held Cmd/Ctrl+Enter in the Send dialog\'s summary sends one review', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await ui.generalComment();
    await page.getByTestId(TESTID.composerTextarea).fill('A draft');
    await page.getByTestId(TESTID.composerAdd).click();
    await page.getByTestId(TESTID.submitReviewOpen).click();
    await page.getByTestId(TESTID.submitReviewDialog).getByLabel('Summary').fill('Overall fine');
    await holdModEnter(page, () => page.waitForTimeout(50));
    await expect(page.getByTestId(TESTID.submitReviewDialog)).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(reviewPosts(mock)).toHaveLength(1);
  });

  test('L5: Edit on a pending reply opens that draft, also when the thread has two; startReply can prefill a new reply', async ({ page, ui, mock }) => {
    const d = withThread(mock);
    d.saveDraft({ kind: 'reply', thread: 't1', body: 'First reply draft' });
    d.saveDraft({ kind: 'reply', thread: 't1', body: 'Second reply draft' });
    await ui.open('kitchen-sink');
    const t1 = ui.card('t1');
    const rows = t1.locator('.pending-reply');
    await expect(rows).toHaveCount(2);
    await rows.nth(1).getByRole('button', { name: 'Edit' }).click();
    const box = t1.getByTestId(TESTID.replyTextarea);
    await expect(box).toHaveValue('Second reply draft');
    await expect(rows.nth(1)).toContainText('Being edited below');
    await expect(rows.nth(0)).not.toContainText('Being edited');
    // the other one: the box (unchanged) switches to it
    await rows.nth(0).getByRole('button', { name: 'Edit' }).click();
    await expect(box).toHaveValue('First reply draft');
    // with text typed, switching is refused (nothing typed is lost)
    await box.fill('First reply draft, edited');
    await rows.nth(1).getByRole('button', { name: 'Edit' }).click();
    await expect(toastWith(page, 'Finish or cancel the reply you are writing first.')).toBeVisible();
    await expect(box).toHaveValue('First reply draft, edited');
    await t1.getByTestId(TESTID.replyAdd).click();
    await expect.poll(() => d.drafts.items.map((/** @type {any} */ x) => x.body)).toEqual(['First reply draft, edited', 'Second reply draft']);
    // a prefilled new reply (the image viewer's Reply): on a thread without a reply draft
    d.saveDraft({ kind: 'thread', type: 'comment', severity: 'normal', capture: { kind: 'doc' }, body: 'Another', version: 1 });
    d.submitReview({ verdict: 'comment', body: '', draftIds: [d.drafts.items.at(-1).id] });
    await page.locator('.thread-panel .filter[data-filter="all"]').click();
    await expect(ui.card('t2')).toBeVisible();
    await page.evaluate(async () => {
      // the UI's own module instance (the page loaded it from this URL)
      // @ts-ignore
      const actions = await import('/ui/actions.js');
      actions.startReply('t2', { body: 'About chart.png: ' });
    });
    await expect(ui.card('t2').getByTestId(TESTID.replyTextarea)).toHaveValue('About chart.png: ');
    await expect(ui.card('t2').getByTestId(TESTID.replyTextarea)).toBeFocused();
  });
});

test.describe('rich doc, sending batched', () => {
  test.use({ scenario: 'rich' });

  test('L5: Use in doc joins the thread\'s reply draft (its use), and Edit opens that one draft', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await page.locator('.thread-panel .filter[data-filter="all"]').click();
    const t7 = ui.card('t7');
    await t7.getByRole('button', { name: 'Reply', exact: true }).click();
    await t7.getByTestId(TESTID.replyTextarea).fill('Thanks, nice chart.');
    await t7.getByTestId(TESTID.replyAdd).click();
    await expect(t7.locator('.pending-reply')).toContainText('Thanks, nice chart.');
    const d = mock.doc('kitchen-sink');
    await t7.locator('.preview-card').getByTestId(TESTID.useAttachment).click();
    await expect(toastWith(page, 'Added to your review')).toBeVisible();
    await expect.poll(() => d.drafts.items.filter((/** @type {any} */ x) => x.thread === 't7').map((/** @type {any} */ x) => [x.body, x.use]))
      .toEqual([['Thanks, nice chart.', ['attachments/a2.html']]]);
    expect(draftPosts(mock).filter((/** @type {any} */ b) => b.thread === 't7')).toHaveLength(1);
    await expect(t7.locator('.pending-reply')).toHaveCount(1);
    await expect(t7.locator('.pending-reply')).toContainText('Put chart.html in the document');
    await t7.locator('.pending-reply').getByRole('button', { name: 'Edit' }).click();
    await expect(t7.getByTestId(TESTID.replyTextarea)).toHaveValue('Thanks, nice chart.');
    await expect(t7.locator('.reply-box .system-line')).toContainText('Asks Claude to put chart.html in the document');
    expect(ui.errors).toEqual([]);
  });
});
