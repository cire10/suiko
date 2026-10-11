// @ts-check
// Later review rounds against the mock daemon (scenario 'round2': kitchen-sink.md v2 answers rv1, see
// mock-data.mjs): the "since my last review" entry into Changes mode, the Verify queue (Accept / Reopen), thread
// mini-diffs (text and image), agent questions, live updates over SSE (a new version, delivery), the rule that a
// new version never switches the view while a comment is being written, and that every TESTID is rendered.

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

test('opens in Changes mode since the last review: grouped change list, seen progress, n / p, assets, round results', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
  await expect(page.locator('#sr-base')).toHaveValue('1');
  await expect(page.locator('.changes-title')).toContainText('since your last review');

  const items = page.getByTestId(TESTID.changeItem);
  await expect(items).toHaveCount(3);
  const h1 = items.and(page.locator('[data-hunk-id="h1"]'));
  await expect(h1).toContainText('with a 30 s reuse-detection grace window');
  await expect(h1.getByRole('button', { name: 't1' })).toBeVisible();
  await expect(items.and(page.locator('[data-hunk-id="h2"]'))).toContainText('removed');
  await expect(items.and(page.locator('[data-hunk-id="h3"]'))).toContainText('other: Bumped the "Last revised" date');
  await expect(page.locator('.change-group .group-title').first()).toHaveText('3 Tokens › 3.2 Token refresh');
  // The guest paints the change overlay of the same comparison.
  await expect.poll(async () => (await ui.inspect()).changes.map((/** @type {any} */ m) => m.id)).toEqual(['h1', 'h2', 'h3', 'asset:img/arch.png']);

  // "Seen" progress, kept per comparison in localStorage.
  const progress = page.locator('.changes-view .progress');
  await expect(progress).toHaveText('0/3 reviewed');
  await h1.locator('.seen-box').check();
  await expect(progress).toHaveText('1/3 reviewed');

  // n / p walk the change list.
  await focusUi(page);
  await page.keyboard.press('n');
  await expect(page.locator('.change-item.active')).toHaveAttribute('data-hunk-id', 'h1');
  await page.keyboard.press('n');
  await expect(page.locator('.change-item.active')).toHaveAttribute('data-hunk-id', 'h2');
  await page.keyboard.press('p');
  await expect(page.locator('.change-item.active')).toHaveAttribute('data-hunk-id', 'h1');

  // The redrawn image: before / after pair resolved against DocState.contentBase (relative URLs, as the engine sends).
  const base = mock.doc('kitchen-sink').contentBase;
  const imgs = page.locator('.asset-change img');
  await expect(imgs).toHaveCount(2);
  await expect(imgs.nth(0)).toHaveAttribute('src', `${base}/v1/img/arch.png`);
  await expect(imgs.nth(1)).toHaveAttribute('src', `${base}/v2/img/arch.png`);
  await imgs.nth(1).scrollIntoViewIfNeeded();
  await expect.poll(() => imgs.nth(0).evaluate((/** @type {HTMLImageElement} */ i) => i.naturalWidth)).toBe(160);
  await expect.poll(() => imgs.nth(1).evaluate((/** @type {HTMLImageElement} */ i) => i.naturalWidth)).toBe(240);
  await expect(page.locator('.asset-change').getByRole('button', { name: 't2' })).toBeVisible();

  // Round results: the agent's replies in (v1, v2] with Accept / Reopen (and the agent's question t6).
  const results = page.locator('.round-results .result');
  await expect(results).toHaveCount(4);
  await expect(results.and(page.locator('[data-thread-id="t6"]')).getByRole('button', { name: 'Answer claude' })).toBeVisible();
  await expect(results.and(page.locator('[data-thread-id="t1"]'))).toContainText('30 s reuse-detection grace window');
  const r1 = results.and(page.locator('[data-thread-id="t1"]'));
  await r1.getByTestId(TESTID.verifyAccept).click();
  await expect(r1).toContainText('Resolved');
  await expect(r1.getByTestId(TESTID.verifyAccept)).toHaveCount(0);
  expect(mock.doc('kitchen-sink').thread('t1').status).toBe('resolved');

  // The seen state survives a reload (the app opens in Changes mode again).
  await page.reload();
  await ui.ready();
  await expect(page.locator('.changes-view .progress')).toHaveText('1/3 reviewed');
  expect(ui.errors).toEqual([]);
});

test('Verify queue: accept, reopen with a reply, keep an orphaned thread as a general comment', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await focusUi(page);
  await page.keyboard.press('v');
  await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.filter[data-filter="verify"]')).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByTestId(TESTID.threadPanel);
  await expect(panel.getByTestId(TESTID.threadCard)).toHaveCount(3);

  // Accept t1 (addressed).
  await ui.card('t1').getByTestId(TESTID.verifyAccept).click();
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 't1 resolved' })).toBeVisible();
  await expect(ui.card('t1')).toHaveCount(0);
  expect(mock.doc('kitchen-sink').thread('t1').status).toBe('resolved');

  // Reopen t2 (answered) with a reply: it becomes a reply draft of the next review.
  await ui.card('t2').getByTestId(TESTID.verifyReopen).click();
  const reply = ui.card('t2').getByTestId(TESTID.replyTextarea);
  await expect(reply).toBeFocused();
  await reply.fill('The PNG still shows the store **next to** the gateway.');
  await ui.card('t2').getByTestId(TESTID.replyAdd).click();
  await expect.poll(() => mock.doc('kitchen-sink').drafts.items.length).toBe(1);
  expect(mock.doc('kitchen-sink').drafts.items[0]).toMatchObject({ kind: 'reply', thread: 't2', reopen: true });
  await expect(page.locator('.drafts-count')).toContainText('1');
  // A thread with a pending reply leaves the Verify queue; it is still listed under Drafts.
  await expect(ui.card('t2')).toHaveCount(0);
  await page.locator('.filter[data-filter="drafts"]').click();
  await expect(ui.card('t2').locator('.pending-reply')).toContainText('Reopen (draft)');
  await expect(ui.card('t2').locator('.pending-reply strong')).toHaveText('next to');

  // t4 was declined and its line was removed: Orphaned, with Move here / Keep as general.
  await page.locator('.filter[data-filter="outdated"]').click();
  const t4 = ui.card('t4');
  await expect(t4.locator('.anchor-chip')).toHaveText('Orphaned');
  await expect(t4.locator('.status-chip')).toHaveText('Declined');
  await t4.getByRole('button', { name: 'Keep as general' }).click();
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 't4 moved' })).toBeVisible();
  const moved = mock.doc('kitchen-sink').thread('t4');
  expect(moved.anchors['2'].kind).toBe('doc');
  await page.locator('.filter[data-filter="all"]').click();
  await expect(ui.card('t4').locator('.anchor-chip')).toHaveCount(0);
  await expect(ui.card('t4')).toContainText('General comment');
  expect(ui.errors).toEqual([]);
});

test('thread mini-diffs: text before / after and an image pair', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await modeTab(page, 'review').click();
  await page.locator('.filter[data-filter="all"]').click();

  const t1 = ui.card('t1');
  await t1.locator('.minidiff summary').click();
  await expect(t1.locator('.minidiff .worddiff')).toContainText('reuse-detection grace window');
  await expect(t1.locator('.minidiff .worddiff ins').first()).toBeVisible();
  await expect(t1.locator('.minidiff')).toContainText('v1 → v2');

  const t2 = ui.card('t2');
  await t2.locator('.minidiff summary').click();
  const base = mock.doc('kitchen-sink').contentBase;
  await expect(t2.locator('.minidiff img')).toHaveCount(2);
  await expect(t2.locator('.minidiff img').nth(0)).toHaveAttribute('src', `${base}/v1/img/arch.png`);
  await expect(t2.locator('.minidiff img').nth(1)).toHaveAttribute('src', `${base}/v2/img/arch.png`);
  await expect(t2.locator('.minidiff figcaption').nth(0)).toHaveText('Before (v1)');

  // Clicking a card focuses it and asks the guest to highlight its anchor.
  await t2.locator('.card-target').click();
  await expect(t2).toHaveAttribute('aria-current', 'true');
  await expect.poll(async () => (await ui.inspect()).activeId).toBe('t2');
  expect(ui.errors).toEqual([]);
});

test('an agent question (needs input) is answered from its card', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await modeTab(page, 'review').click();
  await page.locator('.filter[data-filter="needs"]').click();
  const t6 = ui.card('t6');
  await expect(t6.locator('.asked-banner')).toContainText('claude asked you');
  await expect(t6.locator('.status-chip')).toHaveText('Needs you');
  await t6.getByRole('button', { name: 'Answer claude' }).click();
  const reply = t6.getByTestId(TESTID.replyTextarea);
  await expect(reply).toBeFocused();
  await reply.fill('Configurable per client, default 30 s.');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(t6.locator('.pending-reply')).toContainText('Configurable per client');
  expect(mock.doc('kitchen-sink').drafts.items).toMatchObject([{ kind: 'reply', thread: 't6', reopen: false }]);
});

test('a new version over SSE: toast, tab badge, Review changes, d toggles the base', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await modeTab(page, 'review').click();
  const d = mock.doc('kitchen-sink');
  d.revise({
    source: d.source(2).replace('| refresh_token | 30 d |', '| refresh_token | 14 d |'),
    summary: 'Shorter refresh TTL',
    replies: { t3: { status: 'addressed', reply: 'Cut the refresh TTL to 14 days.' } },
    hunkLinks: { h1: { threads: ['t3'] } },
  });

  const toast = page.getByTestId(TESTID.toast).filter({ hasText: 'v3 ready' });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('from claude');
  await expect(toast).toContainText('1 addressed');
  await expect(page).toHaveTitle(/^\(v3\) Token Service Implementation Spec/);
  // No composer was open, so the view followed the head.
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('3');
  await expect(ui.card('t3').locator('.status-chip')).toHaveText('Addressed in v3');

  await toast.getByRole('button', { name: 'Review changes' }).click();
  await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
  await expect(page).not.toHaveTitle(/^\(v3\)/);
  // Since the last review (v1): every change of v2 and v3.
  await expect(page.locator('#sr-base')).toHaveValue('1');
  await expect(page.getByTestId(TESTID.changeItem)).toHaveCount(4);
  const ttl = page.locator(`[data-testid="${TESTID.changeItem}"][data-hunk-id="h1"]`);
  // The hunk reads as an inline word diff of its source line: the unchanged words are context.
  const ttlDiff = ttl.locator('[data-hunk-diff]');
  await expect(ttlDiff.locator('del')).toHaveText('30');
  await expect(ttlDiff.locator('ins')).toHaveText('14');
  await expect(ttlDiff).toHaveText('| refresh_token | 3014 d | `token_store` |');
  // d: compare with the previous version instead.
  await focusUi(page);
  await page.keyboard.press('d');
  await expect(page.locator('#sr-base')).toHaveValue('2');
  const only = page.getByTestId(TESTID.changeItem);
  await expect(only).toHaveCount(1);
  await expect(only.locator('[data-hunk-diff] ins')).toHaveText('14');
  await expect(only.getByRole('button', { name: 't3' })).toBeVisible();
  expect(ui.errors).toEqual([]);
});

test('delivery and presence follow the event stream', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  const presence = page.getByTestId(TESTID.presence);
  await expect(presence).toHaveText(/No agent listening/);
  const d = mock.doc('kitchen-sink');
  d.setWaiters([{ agent: 'claude' }]);
  await expect(presence).toHaveText(/claude is listening/);
  await expect(presence).toHaveAttribute('data-presence', 'listening');
  d.setWorking(`${d.source(2)}\nA new paragraph.\n`);
  await expect(presence).toHaveText(/claude is editing \(unrecorded\)/);
  await expect(page.locator('.banner-warn')).toContainText('Unrecorded changes on disk');
  // Preview live: the working copy, read-only.
  await page.locator('.banner-warn').getByRole('button', { name: 'Preview live' }).click();
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('live');
  await expect.poll(async () => (await ui.inspect()).mode).toBe('readonly');
  await expect(page.getByTestId(TESTID.pickTool)).toBeDisabled();
  d.setWorking(null);
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
  await expect(presence).toHaveText(/claude is listening/);
});

test('a new version never switches the view while a comment is being written', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await modeTab(page, 'review').click();
  await page.getByRole('button', { name: 'General comment' }).click();
  await page.getByTestId(TESTID.composerTextarea).fill('Overall the rollout section needs owners.');
  const d = mock.doc('kitchen-sink');
  d.revise({ source: d.source(2).replace('Last revised 2026-10-11.', 'Last revised 2026-10-12.'), summary: 'date' });
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'v3 ready' })).toBeVisible();
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
  await expect(page.getByTestId(TESTID.composerTextarea)).toHaveValue('Overall the rollout section needs owners.');
  const banner = page.locator('.banner-info');
  await expect(banner).toContainText('latest is v3');
  await banner.getByRole('button', { name: 'Go to v3' }).click();
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'Finish or cancel the open comment' })).toBeVisible();
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
  // Cancel keeps an Undo; then the switch goes through.
  await page.getByTestId(TESTID.composer).getByRole('button', { name: 'Cancel' }).click();
  const undo = page.getByTestId(TESTID.toast).filter({ hasText: 'Comment discarded' });
  await expect(undo).toBeVisible();
  await undo.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId(TESTID.composerTextarea)).toHaveValue('Overall the rollout section needs owners.');
  await page.getByTestId(TESTID.composer).getByRole('button', { name: 'Cancel' }).click();
  await banner.getByRole('button', { name: 'Go to v3' }).click();
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('3');
  await expect(page.locator('.banner-info')).toHaveCount(0);
});

test('Approve: final and resolve-addressed options, a warning for open blocking threads', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await focusUi(page);
  await page.keyboard.press('f');
  const dialog = page.getByTestId(TESTID.submitReviewDialog);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('No agent is listening');
  await expect(dialog.getByRole('button', { name: 'Copy prompt' })).toBeVisible();
  await expect(dialog.locator('code.prompt')).toHaveText('Run `specreview feedback kitchen-sink` and address it.');
  await dialog.locator('input[value="approved"]').check();
  await expect(dialog.getByLabel('Mark v2 final')).toBeChecked();
  await expect(dialog.getByLabel('Resolve 2 addressed threads')).toBeChecked();
  await expect(dialog.locator('.warning')).toContainText('1 blocking thread is still open (t1)');
  await page.getByTestId(TESTID.submitConfirm).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.banner-ok')).toContainText('Approved at v2.');
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'Approved (rv2)' })).toBeVisible();
  const d = mock.doc('kitchen-sink');
  expect(d.doc.final).toMatchObject({ version: 2, review: 'rv2' });
  expect(d.thread('t1').status).toBe('resolved');
  expect(d.thread('t2').status).toBe('resolved');
  expect(d.thread('t4').status).toBe('declined');
  await expect(page.locator('.statusbar')).toContainText('FINAL: v2');
  await expect(page.getByTestId(TESTID.versionPicker).locator('option[value="2"]')).toContainText('FINAL');
});

test('locks: the outline marks agreed sections; Unlock from the section menu', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  const goals = page.locator('.outline-item', { hasText: '1 Goals' }).first();
  await expect(goals.locator('.badge.tone-lock')).toBeVisible();
  await expect.poll(async () => (await ui.inspect()).layers.marks?.some((/** @type {any} */ m) => m.key === 'bracket:L1')).toBe(true);
  await goals.getByRole('button', { name: 'Actions for section 1 Goals' }).click();
  await page.getByRole('menuitem', { name: 'Unlock (L1)' }).click();
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'L1 unlocked' })).toBeVisible();
  expect(mock.doc('kitchen-sink').locks[0].active).toBe(false);
  await expect(goals.locator('.badge.tone-lock')).toHaveCount(0);
  await expect.poll(async () => (await ui.inspect()).layers.marks?.some((/** @type {any} */ m) => m.key === 'bracket:L1')).toBe(false);
  // Mark the section agreed again from the same menu (asks for confirmation first).
  await goals.getByRole('button', { name: 'Actions for section 1 Goals' }).click();
  await page.getByRole('menuitem', { name: 'Mark agreed' }).click();
  const composer = page.getByTestId(TESTID.composer);
  await expect(composer).toContainText('Mark this section as agreed?');
  await composer.getByRole('button', { name: 'Mark agreed' }).click();
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'Marked agreed (L2)' })).toBeVisible();
  await expect(goals.locator('.badge.tone-lock')).toBeVisible();
});

test('every TESTID is rendered somewhere in the review flow', async ({ page, ui, mock }) => {
  /** @type {Set<string>} */
  const seen = new Set();
  const collect = async () => {
    for (const id of await page.evaluate(() => [...document.querySelectorAll('[data-testid]')].map((e) => /** @type {HTMLElement} */ (e).dataset.testid || ''))) seen.add(id);
  };
  await page.goto(mock.url());
  await expect(page.getByTestId(TESTID.docList).locator('li')).toHaveCount(2);
  await collect();
  await page.getByTestId(TESTID.docList).getByRole('link', { name: /Token Service Implementation Spec/ }).click();
  await ui.ready();
  await collect(); // changes mode: change items, round results (verify accept / reopen)
  await modeTab(page, 'review').click();
  await page.locator('.filter[data-filter="verify"]').click();
  await ui.card('t1').getByTestId(TESTID.verifyReopen).click();
  await collect(); // reply textarea + add
  await ui.card('t1').getByRole('button', { name: 'Cancel' }).click();
  await ui.selectText('Ship rotation behind a flag.');
  await focusUi(page);
  await page.keyboard.press('s');
  await expect(page.getByTestId(TESTID.composerSuggestion)).toBeVisible();
  await collect(); // composer, textarea, add, send now, suggestion
  await page.getByTestId(TESTID.composer).getByRole('button', { name: 'Cancel' }).click();
  await focusUi(page);
  await page.keyboard.press('t');
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'Theme: light' })).toBeVisible();
  await collect(); // toast
  await page.getByTestId(TESTID.submitReviewOpen).click();
  await expect(page.getByTestId(TESTID.submitReviewDialog)).toBeVisible();
  await collect(); // dialog, verdict, confirm
  await page.keyboard.press('Escape');
  await modeTab(page, 'history').click();
  await expect(page.getByTestId(TESTID.historyRow)).toHaveCount(2);
  await collect();
  const missing = Object.values(TESTID).filter((id) => !seen.has(id));
  expect(missing).toEqual([]);
});
