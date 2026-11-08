// @ts-check
// The calm-review defaults and the settings behind them, against the mock daemon (the UI's own defaults: no
// preferences pinned):
//   - sending right away: the composer's Send (Cmd/Ctrl+Enter) sends a comment at once as a one-item review with the
//     review's `edits` and `instant` ("Saved for Claude. It gets it when it connects." while Claude is not connected;
//     one such toast, not one per comment); Save as draft (Cmd/Ctrl+Shift+Enter) keeps it, and the draft card's Send sends it later; a
//     reply's Send goes at once too; "Ask before sending" asks first; with "When I click Send" the buttons and keys
//     swap back;
//   - doc edits: Auto sends `edits: 'batch'` on a long document (over 20,000 characters of text) and 'now' on a short
//     one; Right away / Batched override it;
//   - a new version: shown at once where the reviewer reads (Read or Review), at the same place, with "Updated to vN ·
//     Show changes"; never while a comment is being written or in Changes: then only "vN is ready · Show";
//   - opening: the latest version in Review, no change marks, even when it changed since the last review;
//   - Settings: a sidebar of sections (arrow keys move), every setting remembered, the live long / short line;
//   - the Send dialog: "Send" with drafts, "Approve" without (it starts on Approve vN), the verdicts in plain words.

import { TESTID } from '../../src/shared/protocol.js';
import { expect, test } from './fixtures.mjs';

/** @typedef {import('@playwright/test').Page} Page */

test.use(/** @type {any} */ ({ prefs: 'defaults' }));

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** @param {Page} page @param {string} mode */
const modeTab = (page, mode) => page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="${mode}"]`);
/** @param {Page} page @param {string} text */
const toastWith = (page, text) => page.getByTestId(TESTID.toast).filter({ hasText: text });
/** @param {Page} page @param {string} key */
const filter = (page, key) => page.locator(`.thread-panel .filter[data-filter="${key}"]`);
/** The bodies of the POST .../reviews requests so far. @param {any} mock */
const reviewPosts = (mock) => mock.requests.filter((/** @type {any} */ r) => r.method === 'POST' && /\/reviews$/.test(r.path)).map((/** @type {any} */ r) => r.body);
/** Moves keyboard focus back to the UI document (out of the doc iframe). @param {Page} page */
async function focusUi(page) {
  await page.evaluate(() => /** @type {HTMLElement|null} */ (document.activeElement)?.blur?.());
}
/**
 * Sets preferences before the app loads (kept on reloads once the page changes them).
 * @param {Page} page @param {Record<string, string>} prefs
 */
async function withPrefs(page, prefs) {
  await page.addInitScript((p) => {
    if (window.top !== window) return;
    for (const [k, v] of Object.entries(p)) if (localStorage.getItem(`suiko.${k}`) == null) localStorage.setItem(`suiko.${k}`, v);
  }, prefs);
}

test.describe('sending (fresh doc)', () => {
  test.use(/** @type {any} */ ({ scenario: 'fresh' }));

  test('right away by default: Send (Cmd/Ctrl+Enter) sends the comment at once; Save as draft keeps it; the card sends it later', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await ui.selectText('Rotate refresh tokens safely.');
    await focusUi(page);
    await page.keyboard.press('c');
    const composer = page.getByTestId(TESTID.composer);
    const send = page.getByTestId(TESTID.composerSendNow);
    const save = page.getByTestId(TESTID.composerAdd);
    await expect(send).toHaveText(/^Send/);
    await expect(send).toHaveClass(/btn-primary/);
    await expect(send).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter Control+Enter');
    await expect(send.locator('kbd')).toHaveText(process.platform === 'darwin' ? '⌘↵' : 'Ctrl+↵');
    await expect(save).toHaveText(/^Save as draft/);
    await expect(save).toHaveAttribute('aria-keyshortcuts', 'Meta+Shift+Enter Control+Shift+Enter');
    // only the main button shows its key; the other names it in its tooltip
    await expect(save.locator('kbd')).toHaveCount(0);
    await expect(save).toHaveAttribute('title', /\((⌘⇧↵|Ctrl\+Shift\+Enter)\)$/);
    // the type is a segmented control; Must fix a toggle; key 3 makes it a nit (a removable chip)
    await expect(composer.getByRole('radiogroup', { name: 'Type' }).getByRole('radio')).toHaveText(['Comment', 'Question', 'Suggestion']);
    await composer.getByRole('button', { name: 'Must fix' }).click();
    await expect(composer.getByRole('button', { name: 'Must fix' })).toHaveAttribute('aria-pressed', 'true');
    await composer.getByRole('radio', { name: 'Comment' }).focus();
    await page.keyboard.press('3');
    await expect(composer.locator('.nit-chip')).toContainText('Nit');
    await expect(composer.getByRole('button', { name: 'Must fix' })).toHaveAttribute('aria-pressed', 'false');
    await composer.getByRole('button', { name: 'Remove Nit' }).click();
    await expect(composer.locator('.nit-chip')).toHaveCount(0);
    await page.getByTestId(TESTID.composerTextarea).fill('Rotation should also cover the id token.');
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(composer).toHaveCount(0);
    await expect(toastWith(page, 'Saved for Claude. It gets it when it connects.')).toBeVisible();
    const d = mock.doc('kitchen-sink');
    expect(reviewPosts(mock)).toEqual([{ verdict: 'comment', body: '', draftIds: ['d1'], reviewedVersion: 1, edits: 'now', instant: true }]);
    expect(d.threads.map((/** @type {any} */ t) => [t.id, t.status, t.severity])).toEqual([['t1', 'open', 'normal']]);
    await expect(ui.card('t1').locator('.status-chip')).toHaveText('With Claude');
    await expect(page.getByTestId(TESTID.submitReviewOpen)).toHaveText(/Approve/);

    // Save as draft (Cmd/Ctrl+Shift+Enter): nothing goes out; the draft card has Send · Edit · ⋯ (Delete)
    await ui.selectText('Detect reuse of a rotated token.');
    await focusUi(page);
    await page.keyboard.press('c');
    await page.getByTestId(TESTID.composerTextarea).fill('How fast is the detection?');
    await page.keyboard.press(`${MOD}+Shift+Enter`);
    await expect(composer).toHaveCount(0);
    expect(reviewPosts(mock)).toHaveLength(1);
    const draft = page.locator('[data-testid="thread-card"][data-draft-id="d2"]');
    await expect(draft.locator('.status-chip')).toHaveText('Draft');
    await expect(draft.locator(':scope > .card-actions > button.btn')).toHaveText(['Send', 'Edit']);
    await expect(page.getByTestId(TESTID.submitReviewOpen).locator('.drafts-count')).toHaveText('1');
    await draft.getByRole('button', { name: 'Send', exact: true }).click();
    // the same toast again replaces the first one instead of stacking
    await expect(toastWith(page, 'Saved for Claude.')).toHaveCount(1);
    expect(reviewPosts(mock).at(-1)).toEqual({ verdict: 'comment', body: '', draftIds: ['d2'], reviewedVersion: 1, edits: 'now', instant: true });
    await expect(ui.card('t2')).toBeVisible();
    expect(ui.errors).toEqual([]);
  });

  test('a reply\'s Send goes at once; Save as draft keeps it; "Ask before sending" asks first', async ({ page, ui, mock }) => {
    const d = mock.doc('kitchen-sink');
    d.saveDraft({ kind: 'thread', type: 'comment', severity: 'normal', capture: { kind: 'doc' }, body: 'Overall: fine', version: 1 });
    d.submitReview({ verdict: 'comment', body: '' });
    await ui.open('kitchen-sink');
    const t1 = ui.card('t1');
    await t1.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(t1.getByTestId(TESTID.replyAdd)).toHaveText('Send');
    await expect(t1.getByRole('button', { name: 'Save as draft' })).toBeVisible();
    await t1.getByTestId(TESTID.replyTextarea).fill('One more: the gateway timeout.');
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(toastWith(page, 'Saved for Claude.')).toBeVisible();
    expect(reviewPosts(mock).at(-1)).toMatchObject({ verdict: 'comment', body: '', edits: 'now', instant: true, draftIds: [expect.stringMatching(/^d\d+$/)] });
    expect(d.thread('t1').comments.at(-1).body).toBe('One more: the gateway timeout.');
    expect(d.drafts.items).toHaveLength(0);

    // Save as draft: a pending reply with Send / Edit / Delete
    await t1.getByRole('button', { name: 'Reply', exact: true }).click();
    await t1.getByTestId(TESTID.replyTextarea).fill('Later: the retry budget.');
    await page.keyboard.press(`${MOD}+Shift+Enter`);
    await expect(t1.locator('.pending-reply')).toContainText('Later: the retry budget.');
    expect(reviewPosts(mock)).toHaveLength(1);
    await expect(t1.locator('.pending-reply').getByRole('button')).toHaveText(['Send', 'Edit', 'Delete']);

    // Ask before sending: the reply box asks; Esc backs out; Send confirms
    await ui.settings('sending');
    await page.getByTestId(TESTID.settingsDialog).getByRole('switch', { name: 'Ask before sending' }).check();
    await page.keyboard.press('Escape');
    await t1.locator('.pending-reply').getByRole('button', { name: 'Edit' }).click();
    await t1.getByTestId(TESTID.replyAdd).click();
    const ask = t1.locator('[data-confirm-send]');
    await expect(ask).toContainText('Send this reply to Claude now?');
    await expect(ask.getByRole('button', { name: 'Send' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(ask).toHaveCount(0);
    expect(reviewPosts(mock)).toHaveLength(1);
    await t1.getByTestId(TESTID.replyAdd).click();
    await ask.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => reviewPosts(mock).length).toBe(2);
    expect(d.thread('t1').comments.at(-1).body).toBe('Later: the retry budget.');
    expect(ui.errors).toEqual([]);
  });

  test('When I click Send: Add to review is the main button (Cmd/Ctrl+Enter), Send now the other (Cmd/Ctrl+Shift+Enter)', async ({ page, ui, mock }) => {
    await withPrefs(page, { sendMode: 'batch' });
    await ui.open('kitchen-sink');
    await ui.selectText('Rotate refresh tokens safely.');
    await focusUi(page);
    await page.keyboard.press('c');
    await expect(page.getByTestId(TESTID.composerAdd)).toHaveText(/^Add to review/);
    await expect(page.getByTestId(TESTID.composerAdd)).toHaveClass(/btn-primary/);
    await expect(page.getByTestId(TESTID.composerSendNow)).toHaveText(/^Send now/);
    await page.getByTestId(TESTID.composerTextarea).fill('Kept for the review');
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(page.getByTestId(TESTID.composer)).toHaveCount(0);
    expect(reviewPosts(mock)).toHaveLength(0);
    const draft = page.locator('[data-testid="thread-card"][data-draft-id="d1"]');
    // batched: Edit · ⋯ (Send now, Delete)
    await expect(draft.locator(':scope > .card-actions > button.btn')).toHaveText(['Edit']);
    await draft.locator('[data-card-menu]').click();
    await expect(page.locator('[role="menu"] [role="menuitem"]')).toHaveText(['Send now', 'Delete']);
    await page.keyboard.press('Escape');
    await ui.selectText('Detect reuse of a rotated token.');
    await focusUi(page);
    await page.keyboard.press('c');
    await page.getByTestId(TESTID.composerTextarea).fill('Sent on its own');
    await page.keyboard.press(`${MOD}+Shift+Enter`);
    await expect(toastWith(page, 'Saved for Claude.')).toBeVisible();
    expect(reviewPosts(mock)).toEqual([expect.objectContaining({ draftIds: ['d2'], edits: 'now', instant: true })]);
    // the help lists the keys of this mode
    await focusUi(page);
    await page.keyboard.press('?');
    const help = page.getByTestId(TESTID.helpOverlay);
    await expect(help.locator('[data-key-row="send-now"] kbd')).toHaveText(process.platform === 'darwin' ? '⌘⇧↵' : 'Ctrl+Shift+Enter');
    await expect(help.locator('[data-key-row="add"] kbd')).toHaveText(process.platform === 'darwin' ? '⌘↵' : 'Ctrl+Enter');
    expect(ui.errors).toEqual([]);
  });

  test('Settings: a sidebar of sections; every setting is remembered; the help follows Send comments', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await focusUi(page);
    await page.keyboard.press('ControlOrMeta+,');
    const dialog = page.getByTestId(TESTID.settingsDialog);
    const tab = (/** @type {string} */ k) => dialog.locator(`[role="tab"][data-section="${k}"]`);
    await expect(dialog.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab'))
      .toHaveText(['General', 'Reading', 'Sending', 'Claude & context', 'About']);
    await expect(tab('general')).toHaveAttribute('aria-selected', 'true');
    await expect(tab('general')).toBeFocused();
    // arrow keys move between the sections
    await page.keyboard.press('ArrowDown');
    await expect(tab('reading')).toHaveAttribute('aria-selected', 'true');
    await expect(tab('reading')).toBeFocused();
    await expect(dialog.locator('[data-setting="openIn"]')).toBeVisible();
    await page.keyboard.press('End');
    await expect(tab('about')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(tab('general')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(tab('about')).toHaveAttribute('aria-selected', 'true');

    // the defaults
    await tab('reading').click();
    await expect(dialog.locator('input[name="sr-set-openIn"][value="review"]')).toBeChecked();
    await expect(dialog.locator('input[name="sr-set-onNewVersion"][value="latest"]')).toBeChecked();
    await tab('sending').click();
    await expect(dialog.locator('input[name="sr-set-sendMode"][value="now"]')).toBeChecked();
    await tab('context').click();
    await expect(dialog.locator('input[name="sr-set-editMode"][value="auto"]')).toBeChecked();
    await expect(dialog.locator('[data-doc-size]')).toHaveText(/^This document is short \([\d,]+ characters\), so edits happen right away\.$/);

    // every setting, remembered as suiko.<key>
    /** @type {Array<[string, string, string, string]>} section, name, value, stored key */
    const choices = [
      ['general', 'theme', 'dark', 'theme'],
      ['reading', 'openIn', 'auto', 'openIn'],
      ['reading', 'onNewVersion', 'changes', 'onNewVersion'],
      ['reading', 'railMode', 'never', 'railMode'],
      ['sending', 'sendMode', 'batch', 'sendMode'],
      ['sending', 'defaultVerdict', 'changes_requested', 'defaultVerdict'],
      ['context', 'editMode', 'batch', 'editMode'],
    ];
    for (const [section, name, value] of choices) {
      await tab(section).click();
      await dialog.locator(`[data-setting="${name}"] input[value="${value}"]`).check();
    }
    await tab('context').click();
    await expect(dialog.locator('[data-doc-size]')).toHaveText(/edits are batched \(your choice\)\.$/);
    await tab('general').click();
    await dialog.getByRole('switch', { name: 'Single-letter shortcuts' }).uncheck();
    await tab('reading').click();
    await dialog.getByRole('switch', { name: 'Thread panel open by default' }).uncheck();
    await tab('sending').click();
    await dialog.getByRole('switch', { name: 'Ask before sending' }).check();
    const stored = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.startsWith('suiko.'))));
    expect(stored).toMatchObject({
      'suiko.theme': 'dark', 'suiko.openIn': 'auto', 'suiko.onNewVersion': 'changes', 'suiko.railMode': 'never',
      'suiko.sendMode': 'batch', 'suiko.defaultVerdict': 'changes_requested', 'suiko.editMode': 'batch',
      'suiko.singleKeys': '0', 'suiko.sidebar': '0', 'suiko.confirmSendNow': '1',
    });
    await page.keyboard.press('Escape');
    await page.reload();
    await ui.ready();
    await page.keyboard.press('ControlOrMeta+,');
    for (const [section, name, value] of choices) {
      await tab(section).click();
      await expect(dialog.locator(`[data-setting="${name}"] input[value="${value}"]`)).toBeChecked();
    }
    await tab('sending').click();
    await expect(dialog.getByRole('switch', { name: 'Ask before sending' })).toBeChecked();
    await page.keyboard.press('Escape');
    // the verdict for drafts: the Send dialog starts on it once there is a draft (When I click Send: Add to review;
    // the thread panel is closed by default now)
    await page.locator('.threads-toggle').click();
    await page.getByRole('button', { name: 'General comment' }).click();
    await page.getByTestId(TESTID.composerTextarea).fill('A draft');
    await page.getByTestId(TESTID.composerAdd).click();
    await page.getByTestId(TESTID.submitReviewOpen).click();
    await expect(page.getByTestId(TESTID.submitReviewDialog).locator('input[value="changes_requested"]')).toBeChecked();
    expect(ui.errors).toEqual([]);
  });
});

test.describe('long documents (rich scenario)', () => {
  test.use(/** @type {any} */ ({ scenario: 'rich' }));

  test('Doc edits Auto: batched on a long document, right away on a short one; Settings says which', async ({ page, ui, mock }) => {
    await ui.open('long-spec');
    await ui.selectText('stamps them with the arrival time');
    await focusUi(page);
    await page.keyboard.press('c');
    await page.getByTestId(TESTID.composerTextarea).fill('Thirty days of replay is a lot of storage.');
    await page.getByTestId(TESTID.composerSendNow).click();
    await expect(toastWith(page, 'Saved for Claude.')).toBeVisible();
    expect(reviewPosts(mock).at(-1)).toMatchObject({ edits: 'batch', verdict: 'comment', instant: true });
    expect(mock.doc('long-spec').reviews.at(-1).edits).toBe('batch');
    const dialog = await ui.settings('context');
    await expect(dialog.locator('[data-doc-size]')).toHaveText('This document is long (24,672 characters), so edits are batched.');
    // Right away overrides it
    await dialog.locator('[data-setting="editMode"] input[value="now"]').check();
    await expect(dialog.locator('[data-doc-size]')).toHaveText('This document is long (24,672 characters); edits happen right away (your choice).');
    await page.keyboard.press('Escape');
    await ui.selectText('writes them to the partitioned log');
    await focusUi(page);
    await page.keyboard.press('c');
    await page.getByTestId(TESTID.composerTextarea).fill('Which partition key?');
    await page.keyboard.press(`${MOD}+Enter`);
    await expect.poll(() => reviewPosts(mock).at(-1)?.edits).toBe('now');

    // a short document: right away with Auto
    await page.evaluate(() => localStorage.removeItem('suiko.editMode'));
    await ui.open('kitchen-sink');
    await page.getByRole('button', { name: 'General comment' }).click();
    await page.getByTestId(TESTID.composerTextarea).fill('Looks calm.');
    await page.keyboard.press(`${MOD}+Enter`);
    await expect.poll(() => mock.doc('kitchen-sink').reviews.at(-1)?.body).toBe('');
    expect(reviewPosts(mock).at(-1)).toMatchObject({ edits: 'now' });
    expect(ui.errors).toEqual([]);
  });
});

test.describe('new versions and opening (round 2)', () => {
  test.use(/** @type {any} */ ({ scenario: 'round2' }));

  test('opens on the latest version in Review, without change marks, though it changed since the last review', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
    await expect(modeTab(page, 'changes').locator('.badge')).toHaveText('3');
    expect((await ui.inspect()).mode).toBe('review');
    await expect(filter(page, 'mine')).toHaveAttribute('aria-selected', 'true');
    expect(ui.errors).toEqual([]);
  });

  test('a new version: shown where the reader is, at the same place, with "Updated to vN · Show changes"', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    /** Where the heading "1.1 Milestones" sits in the doc frame (px from its top). */
    const milestones = async () => (await ui.frame()).evaluate(() => {
      const h = [...document.querySelectorAll('h3')].find((x) => x.textContent?.includes('1.1 Milestones'));
      return Math.round(/** @type {HTMLElement} */ (h).getBoundingClientRect().top);
    });
    // read down to "1.1 Milestones", 40 px into its section (the guest's reading line is 8 px below the top)
    await (await ui.frame()).evaluate(() => {
      const h = [...document.querySelectorAll('h3')].find((x) => x.textContent?.includes('1.1 Milestones'));
      window.scrollTo({ top: /** @type {HTMLElement} */ (h).getBoundingClientRect().top + window.scrollY - 8 + 40, behavior: 'instant' });
    });
    await expect.poll(milestones).toBe(-32);
    await page.waitForTimeout(400); // the guest reports where the reader is once scrolling settles
    const d = mock.doc('kitchen-sink');
    d.revise({ source: d.source(2).replace('Last revised 2026-10-11.', 'Last revised 2026-10-12.'), summary: 'date' });
    await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('3');
    await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
    const toast = toastWith(page, 'Updated to v3');
    await expect(toast).toBeVisible();
    await ui.ready();
    // the same place: the heading still sits 32 px above the top of the frame (not scrolled to the heading itself)
    await expect.poll(async () => Math.abs(await milestones() + 32), { timeout: 5000 }).toBeLessThanOrEqual(4);
    expect((await ui.inspect()).mode).toBe('review');
    // Show changes: Changes from the version the reviewer was reading
    await toast.getByRole('button', { name: 'Show changes' }).click();
    await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId(TESTID.compareFrom)).toHaveValue('2');
    expect(ui.errors).toEqual([]);
  });

  test('a new version while a comment is being written, or in Changes: only "vN is ready · Show"', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    await page.getByRole('button', { name: 'General comment' }).click();
    await page.getByTestId(TESTID.composerTextarea).fill('Hold on');
    const d = mock.doc('kitchen-sink');
    d.revise({ source: d.source(2).replace('Last revised 2026-10-11.', 'Last revised 2026-10-12.'), summary: 'date' });
    const ready = toastWith(page, 'v3 is ready');
    await expect(ready).toBeVisible();
    await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
    await expect(page.getByTestId(TESTID.composerTextarea)).toHaveValue('Hold on');
    await page.getByTestId(TESTID.composer).getByRole('button', { name: 'Cancel' }).click();
    await ready.getByRole('button', { name: 'Show' }).click();
    await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('3');
    await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');

    // in Changes the reviewer picked what to compare: the view stays
    await modeTab(page, 'changes').click();
    d.revise({ source: d.source(3).replace('Last revised 2026-10-12.', 'Last revised 2026-10-13.'), summary: 'date again' });
    await expect(toastWith(page, 'v4 is ready')).toBeVisible();
    await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('3');
    await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
    await toastWith(page, 'v4 is ready').getByRole('button', { name: 'Show' }).click();
    await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('4');
    await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
    expect(ui.errors).toEqual([]);
  });

  test('the Send dialog: "Approve" without drafts (starting on Approve vN), "Send" with them; plain verdicts', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await page.getByTestId(TESTID.submitReviewOpen).click();
    const dialog = page.getByTestId(TESTID.submitReviewDialog);
    await expect(dialog.locator('.modal-head h2')).toHaveText('Approve');
    await expect(dialog.locator('input[value="approved"]')).toBeChecked();
    await expect(dialog.locator('.verdict strong')).toHaveText(['Send feedback', 'Needs changes', 'Approve v2']);
    await expect(dialog.locator('.verdict-comment')).toContainText('Your comments go to Claude; no decision yet.');
    await expect(dialog.locator('.verdict-changes_requested')).toContainText('Claude should revise before you approve.');
    await expect(dialog.getByTestId(TESTID.submitConfirm)).toHaveText('Approve v2');
    await expect(dialog).toContainText('Claude isn\'t connected.');
    await dialog.locator('input[value="comment"]').check();
    await expect(dialog.getByTestId(TESTID.submitConfirm)).toHaveText('Send');
    await expect(dialog.locator('.modal-head h2')).toHaveText('Send');
    await page.keyboard.press('Escape');

    // with a draft: "Send", on Send feedback
    await page.getByRole('button', { name: 'General comment' }).click();
    await page.getByTestId(TESTID.composerTextarea).fill('Later');
    await page.getByTestId(TESTID.composerAdd).click();
    await expect(page.getByTestId(TESTID.submitReviewOpen)).toHaveText(/Send\s*1/);
    await page.getByTestId(TESTID.submitReviewOpen).click();
    await expect(dialog.locator('.modal-head h2')).toHaveText('Send');
    expect(ui.errors).toEqual([]);
  });
});
