// @ts-check
// Later review rounds against the mock daemon (scenario 'round2': kitchen-sink.md v2 answers rv1, see
// mock-data.mjs): the "since my last review" entry into Changes mode, what waits for the reviewer's check (Looks
// good / Reopen), thread mini-diffs (text and image), agent questions, live updates over SSE (a new version,
// delivery), the rule that a new version never switches the view while a comment is being written, and that every
// TESTID is rendered.

import { TESTID } from '../../src/shared/protocol.js';
import { expect, test } from './fixtures.mjs';
import { makePng } from './mock-data.mjs';

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
  await expect(items.and(page.locator('[data-hunk-id="h3"]'))).toContainText('Also changed: Bumped the "Last revised" date');
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

  // Round results: the agent's replies in (v1, v2] with Looks good / Not yet (and Reply for the agent's question t6).
  const results = page.locator('.round-results .result');
  await expect(results).toHaveCount(4);
  await expect(results.and(page.locator('[data-thread-id="t6"]')).getByRole('button', { name: 'Reply' })).toBeVisible();
  await expect(results.and(page.locator('[data-thread-id="t1"]'))).toContainText('30 s reuse-detection grace window');
  const r1 = results.and(page.locator('[data-thread-id="t1"]'));
  await expect(r1.getByTestId(TESTID.verifyAccept)).toHaveText('Looks good');
  await expect(r1.getByTestId(TESTID.verifyReopen)).toHaveText('Not yet');
  await r1.getByTestId(TESTID.verifyAccept).click();
  await expect(r1).toContainText('Done');
  await expect(r1.getByTestId(TESTID.verifyAccept)).toHaveCount(0);
  expect(mock.doc('kitchen-sink').thread('t1').status).toBe('resolved');

  // The seen state survives a reload (the app opens in Changes mode again).
  await page.reload();
  await ui.ready();
  await expect(page.locator('.changes-view .progress')).toHaveText('1/3 reviewed');
  expect(ui.errors).toEqual([]);
});

test('Your turn: looks good, not yet with a reply, keep a thread that lost its place as a general comment', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await focusUi(page);
  await page.keyboard.press('v');
  await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.filter[data-filter="mine"]')).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByTestId(TESTID.threadPanel);
  // t1 changed, t2 answered, t4 not changed (to check), t6 a question for the reviewer
  await expect(panel.getByTestId(TESTID.threadCard)).toHaveCount(4);

  // Looks good on t1 (changed).
  await ui.card('t1').getByTestId(TESTID.verifyAccept).click();
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 't1 is done' })).toBeVisible();
  await expect(ui.card('t1')).toHaveCount(0);
  expect(mock.doc('kitchen-sink').thread('t1').status).toBe('resolved');

  // Reopen t2 (answered; its ⋯ menu) with a reply: it becomes a reply draft of the next review.
  await ui.cardMenu(ui.card('t2'), 'reopen');
  const reply = ui.card('t2').getByTestId(TESTID.replyTextarea);
  await expect(reply).toBeFocused();
  await reply.fill('The PNG still shows the store **next to** the gateway.');
  await ui.card('t2').getByTestId(TESTID.replyAdd).click();
  await expect.poll(() => mock.doc('kitchen-sink').drafts.items.length).toBe(1);
  expect(mock.doc('kitchen-sink').drafts.items[0]).toMatchObject({ kind: 'reply', thread: 't2', reopen: true });
  await expect(page.locator('.drafts-count')).toContainText('1');
  // A thread with a pending reply stays in Your turn (the reply is not sent yet).
  await expect(ui.card('t2').locator('.pending-reply')).toContainText('Reopen (draft)');
  await expect(ui.card('t2').locator('.pending-reply strong')).toHaveText('next to');

  // t4: Claude didn't change it and its line was removed; Move here / Keep as general are in its ⋯ menu.
  const t4 = ui.card('t4');
  await expect(t4.locator('.status-chip')).toHaveText('Claude didn\'t change it');
  await ui.cardMenu(t4, 'general');
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 't4 moved' })).toBeVisible();
  const moved = mock.doc('kitchen-sink').thread('t4');
  expect(moved.anchors['2'].kind).toBe('doc');
  await page.locator('.filter[data-filter="all"]').click();
  await expect(ui.card('t4').locator('.anchor-chip')).toHaveCount(0);
  await expect(ui.card('t4')).toContainText('General comment');
  expect(ui.errors).toEqual([]);
});

test('Reply on an answered thread: a follow-up on the thread, without reopening it', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await focusUi(page);
  await page.keyboard.press('v');
  const t2 = ui.card('t2');
  await expect(t2.locator('.status-chip')).toHaveText('Claude answered');
  await t2.getByRole('button', { name: 'Reply', exact: true }).click();
  const reply = t2.getByTestId(TESTID.replyTextarea);
  await expect(reply).toBeFocused();
  await expect(t2.getByRole('checkbox', { name: 'Reopen' })).not.toBeChecked();
  await reply.fill('Thanks. Does the diagram show the cache too?');
  await t2.getByTestId(TESTID.replyAdd).click();
  await expect.poll(() => mock.doc('kitchen-sink').drafts.items.length).toBe(1);
  expect(mock.doc('kitchen-sink').drafts.items[0]).toMatchObject({ kind: 'reply', thread: 't2', reopen: false });
  // the follow-up waits in the review (still Your turn); the thread keeps its status
  await expect(page.locator('.filter[data-filter="mine"]')).toHaveAttribute('aria-selected', 'true');
  await expect(ui.card('t2').locator('.pending-reply')).toContainText('Reply (draft)');
  await expect(ui.card('t2').locator('.status-chip')).toHaveText('Claude answered');
  expect(ui.errors).toEqual([]);
});

test('thread mini-diffs: text before / after and an image pair', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await modeTab(page, 'review').click();
  await page.locator('.filter[data-filter="all"]').click();

  const t1 = ui.card('t1');
  await ui.cardMenu(t1, 'show-change');
  await expect(t1.locator('.minidiff .worddiff')).toContainText('reuse-detection grace window');
  await expect(t1.locator('.minidiff .worddiff ins').first()).toBeVisible();
  await expect(t1.locator('.minidiff')).toContainText('v1 → v2');

  const t2 = ui.card('t2');
  await ui.cardMenu(t2, 'show-change');
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
  await page.locator('.filter[data-filter="mine"]').click();
  const t6 = ui.card('t6');
  await expect(t6.locator('.asked-banner')).toContainText('Claude asked you');
  await expect(t6.locator('.status-chip')).toHaveText('Needs your answer');
  await t6.getByRole('button', { name: 'Reply', exact: true }).click();
  const reply = t6.getByTestId(TESTID.replyTextarea);
  await expect(reply).toBeFocused();
  await reply.fill('Configurable per client, default 30 s.');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(t6.locator('.pending-reply')).toContainText('Configurable per client');
  expect(mock.doc('kitchen-sink').drafts.items).toMatchObject([{ kind: 'reply', thread: 't6', reopen: false }]);
});

test('a new version over SSE with "Just tell me": the note, tab badge, Show changes, d toggles the base', async ({ page, ui, mock }) => {
  await page.addInitScript(() => {
    if (window.top === window) localStorage.setItem('suiko.onNewVersion', 'toast');
  });
  await ui.open('kitchen-sink');
  await modeTab(page, 'review').click();
  const d = mock.doc('kitchen-sink');
  d.revise({
    source: d.source(2).replace('| refresh_token | 30 d |', '| refresh_token | 14 d |'),
    summary: 'Shorter refresh TTL',
    replies: { t3: { status: 'addressed', reply: 'Cut the refresh TTL to 14 days.' } },
    hunkLinks: { h1: { threads: ['t3'] } },
  });

  const toast = page.getByTestId(TESTID.toast).filter({ hasText: 'Claude recorded v3 · 1 changed' });
  await expect(toast).toBeVisible();
  await expect(page).toHaveTitle(/^\(v3\) Token Service Implementation Spec/);
  // "Just tell me": the view stays on v2 until the reviewer asks for v3
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
  await expect(ui.card('t3').locator('.status-chip')).toHaveText('Changed in v3 — check it');

  await toast.getByRole('button', { name: 'Show changes' }).click();
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('3');
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
  const presence = page.getByTestId(TESTID.turnPill).getByTestId(TESTID.presence);
  await expect(presence).toHaveText(/Claude isn't connected/);
  const d = mock.doc('kitchen-sink');
  d.setWaiters([{ agent: 'claude' }]);
  await expect(presence).toHaveText(/Claude is listening/);
  await expect(presence).toHaveAttribute('data-presence', 'listening');
  d.setWorking(`${d.source(2)}\nA new paragraph.\n`);
  await expect(presence).toHaveText(/Claude is editing/);
  await expect(presence).toHaveAttribute('data-presence', 'editing');
  await expect(page.locator('.banner-warn')).toContainText('Unrecorded changes on disk');
  // Preview live: the working copy, read-only.
  await page.locator('.banner-warn').getByRole('button', { name: 'Preview live' }).click();
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('live');
  await expect.poll(async () => (await ui.inspect()).mode).toBe('readonly');
  await expect(page.getByTestId(TESTID.pickTool)).toBeDisabled();
  d.setWorking(null);
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
  await expect(presence).toHaveText(/Claude is listening/);
});

test('presence and working-copy events that arrive while a refresh is out are not undone by its older answer', async ({ page, ui, mock }) => {
  // Hold the answer of the second doc-state request (the catch-up refresh when the event stream opens): it is
  // computed before the events below, so it says nobody listens and the working copy is clean.
  let requests = 0;
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((/** @type {(v?: any) => void} */ r) => { release = r; });
  /** @type {() => void} */
  let heldNow = () => {};
  const held = new Promise((/** @type {(v?: any) => void} */ r) => { heldNow = r; });
  await page.route(/\/api\/docs\/[^/]+\/kitchen-sink$/, async (route) => {
    requests++;
    if (requests !== 2) return route.continue();
    const response = await route.fetch();
    heldNow();
    await gate;
    return route.fulfill({ response });
  });
  await ui.open('kitchen-sink');
  await held;
  const d = mock.doc('kitchen-sink');
  const presence = page.getByTestId(TESTID.turnPill).getByTestId(TESTID.presence);
  d.setWaiters([{ agent: 'claude' }]);
  await expect(presence).toHaveAttribute('data-presence', 'listening');
  d.setWorking(`${d.source(2)}\nA new paragraph.\n`);
  await expect(presence).toHaveAttribute('data-presence', 'editing');
  release();
  await page.waitForTimeout(400);
  await expect(presence).toHaveAttribute('data-presence', 'editing');
  await expect(page.locator('.banner-warn')).toContainText('Unrecorded changes on disk');
  d.setWorking(null);
  await expect(presence).toHaveAttribute('data-presence', 'listening');
  expect(ui.errors).toEqual([]);
});

test('a new version never switches the view while a comment is being written', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await modeTab(page, 'review').click();
  await page.getByRole('button', { name: 'General comment' }).click();
  await page.getByTestId(TESTID.composerTextarea).fill('Overall the rollout section needs owners.');
  const d = mock.doc('kitchen-sink');
  d.revise({ source: d.source(2).replace('Last revised 2026-10-11.', 'Last revised 2026-10-12.'), summary: 'date' });
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'v3 is ready' })).toBeVisible();
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
  await expect(dialog).toContainText('Claude isn\'t connected');
  await expect(dialog.getByRole('button', { name: 'Copy prompt' })).toBeVisible();
  await expect(dialog.locator('code.prompt')).toHaveText('Run suiko feedback kitchen-sink and address it.');
  await dialog.locator('input[value="approved"]').check();
  // threads still wait for both sides: "Mark v2 final" starts unticked (the reviewer ticks it on purpose)
  await expect(dialog.getByLabel('Mark v2 final')).not.toBeChecked();
  await dialog.getByLabel('Mark v2 final').check();
  await expect(dialog.getByLabel('Mark 2 answered threads done')).toBeChecked();
  await expect(dialog.locator('[data-warning="must-fix"]')).toContainText('1 Must fix thread is still open (t1)');
  await page.getByTestId(TESTID.submitConfirm).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.banner-ok')).toContainText('Approved at v2.');
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'Approved (rv2)' })).toBeVisible();
  const d = mock.doc('kitchen-sink');
  expect(d.doc.final).toMatchObject({ version: 2, review: 'rv2' });
  expect(d.thread('t1').status).toBe('resolved');
  expect(d.thread('t2').status).toBe('resolved');
  expect(d.thread('t4').status).toBe('declined');
  // FINAL: in the version's label, the turn pill's details and Document info (the status bar is gone)
  await expect(page.getByTestId(TESTID.versionPicker).locator('option[value="2"]')).toHaveText('v2 · latest · final');
  await page.getByTestId(TESTID.turnPill).click();
  await expect(page.getByRole('dialog', { name: 'Review status' })).toContainText(/Final\s*v2/);
  await page.keyboard.press('Escape');
  await ui.menu('info');
  await expect(page.getByTestId('doc-info').locator('[data-info="final"]')).toHaveText('v2');
});

test('locks: the outline marks agreed sections; Unlock from the section menu', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await ui.showOutline();
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
  // changes mode: change items, round results (verify accept / reopen, accept all), compare range and layout; the
  // top bar's turn pill (presence), More menu, and the tool dock
  await collect();
  // the problems chip: the file missing on disk (a thread that lost its place is not a problem)
  mock.doc('kitchen-sink').emit('working.changed', { dirty: false, missing: true }, { volatile: true });
  await expect(page.getByTestId(TESTID.problems)).toBeVisible();
  await collect();
  mock.doc('kitchen-sink').emit('working.changed', { dirty: false, missing: false }, { volatile: true });
  await expect(page.getByTestId(TESTID.problems)).toHaveCount(0);
  await page.getByTestId(TESTID.compareLayout).locator('[data-layout="split"]').click();
  await ui.baseFrame();
  await collect(); // the older version's frame
  // back to inline from the palette (side by side has its own bar for it)
  await focusUi(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId(TESTID.commandPaletteInput).fill('compare inline');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(TESTID.compareBaseFrame)).toHaveCount(0);
  await modeTab(page, 'review').click();
  await page.locator('.filter[data-filter="mine"]').click();
  await ui.card('t1').getByTestId(TESTID.verifyReopen).click();
  await collect(); // reply textarea + add
  await ui.card('t1').getByRole('button', { name: 'Cancel' }).click();
  await ui.selectText('Ship rotation behind a flag.');
  await focusUi(page);
  await page.keyboard.press('s');
  await expect(page.getByTestId(TESTID.composerSuggestion)).toBeVisible();
  await collect(); // composer, textarea, add, send now, suggestion
  await page.getByTestId(TESTID.composer).getByRole('button', { name: 'Cancel' }).click();
  // A screen snip (the mock's fake picker): a composer with the screenshot thumbnail.
  await page.getByTestId(TESTID.snipScreen).click();
  await expect(page.getByTestId(TESTID.composerAttachment)).toBeVisible();
  await collect(); // snip tool, snip screen, composer attachment
  await page.getByTestId(TESTID.composer).getByRole('button', { name: 'Cancel' }).click();
  await focusUi(page);
  await page.keyboard.press('t');
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'Theme: light' })).toBeVisible();
  await collect(); // toast
  await page.getByTestId(TESTID.submitReviewOpen).click();
  await expect(page.getByTestId(TESTID.submitReviewDialog)).toBeVisible();
  await collect(); // dialog, verdict, confirm
  await page.keyboard.press('Escape');
  await ui.menu('history');
  await expect(page.getByTestId(TESTID.historyRow)).toHaveCount(2);
  await collect();
  // The command palette (top-bar button), Settings and the keyboard shortcuts (in the More menu).
  await page.getByTestId(TESTID.commandPaletteOpen).click();
  await expect(page.getByTestId(TESTID.commandItem).first()).toBeVisible();
  await collect(); // palette, its input, items
  await page.keyboard.press('Escape');
  await page.getByTestId(TESTID.moreMenu).click();
  await expect(ui.menuItem('settings')).toBeVisible();
  await collect(); // the menu's settings and help items
  await ui.menuItem('settings').click();
  await expect(page.getByTestId(TESTID.settingsDialog)).toBeVisible();
  await collect();
  await page.keyboard.press('Escape');
  await ui.menu('help');
  await expect(page.getByTestId(TESTID.helpOverlay)).toBeVisible();
  await collect();
  await page.keyboard.press('Escape');
  // Batched edits and rich replies: the agent plans t3's change and attaches a picture to its reply.
  const d = mock.doc('kitchen-sink');
  const pic = d.addAgentAttachment('sketch.png', makePng(24, 16, () => [79, 70, 229, 255]));
  d.agentReply('t3', { status: 'planned', body: 'I will make it 7 d.', attachments: [pic] });
  await modeTab(page, 'review').click();
  await page.locator('.filter[data-filter="agent"]').click();
  await expect(page.getByTestId(TESTID.applyPlanned)).toBeVisible();
  await expect(ui.card('t3').getByTestId(TESTID.useAttachment)).toBeVisible();
  await collect(); // Apply N, Use in doc
  const missing = Object.values(TESTID).filter((id) => !seen.has(id));
  expect(missing).toEqual([]);
});

test('Changes: a changed asset that is not an image (an HTML chart the doc frames) is one line with Open links, never a broken picture', async ({ page, ui, mock }) => {
  // The mock's v1 -> v2 only redraws an image; add an HTML chart the agent put next to the doc (as `suiko revise`
  // records it: a new asset).
  await page.route(/\/diff\?from=/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.assets = [...(body.assets || []), { path: 'charts/churn.html', from: null, to: 'sha256:00', fromUrl: null, toUrl: 'v2/charts/churn.html', srids: [], threads: [] }];
    await route.fulfill({ response: res, json: body });
  });
  await ui.open('kitchen-sink');
  const base = mock.doc('kitchen-sink').contentBase;
  const row = page.locator('.asset-change[data-asset="charts/churn.html"]');
  await row.scrollIntoViewIfNeeded();
  await expect(row).toContainText('Added in v2');
  await expect(row.locator('img')).toHaveCount(0);
  await expect(row.getByRole('link', { name: 'Open v2' })).toHaveAttribute('href', `${base}/v2/charts/churn.html`);
  await expect(row.getByRole('link', { name: /Open v1/ })).toHaveCount(0);
  // the image keeps its before / after pair
  await expect(page.locator('.asset-change[data-asset="img/arch.png"] img')).toHaveCount(2);
  expect(ui.errors).toEqual([]);
});
