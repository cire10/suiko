// @ts-check
// The calm thread panel and cards, against the mock daemon's 'rich' scenario (kitchen-sink after two rounds: t1
// changed, t2 / t7 answered, t4 declined, t6 a question, t5 done, t3 / t8 planned; t7's answer carries a picture and
// a live HTML chart), with the UI's own defaults:
//   - the filters say whose turn it is: Your turn (the same count as the turn pill), Claude (its planned changes first,
//     with Apply N), Done, All; the panel follows its default until the reviewer picks one; empty states in plain
//     words; earlier filter keys still work (the v key, palette commands);
//   - one status chip per card in plain words, at most two buttons, the rest in a ⋯ menu, by state; "Lost its place";
//     Record as decision; Show change;
//   - Apply: the panel's Apply N, a card's "Apply this now", the turn pill and the palette send a review with
//     `apply`, `draftIds: []` (pending drafts stay drafts) and `edits: 'now'`; a 409 says why and refreshes;
//   - rich replies: thumbnails open full size, the HTML preview runs in a sandboxed frame (scripts yes, same origin
//     no), Open large, and Use in doc (a reply with `use`, sent at once, or a draft when sending is batched).

import { TESTID } from '../../src/shared/protocol.js';
import { expect, test } from './fixtures.mjs';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Locator} Locator */

test.use(/** @type {any} */ ({ scenario: 'rich', prefs: 'defaults' }));

/** @param {Page} page @param {string} mode */
const modeTab = (page, mode) => page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="${mode}"]`);
/** @param {Page} page @param {string} text */
const toastWith = (page, text) => page.getByTestId(TESTID.toast).filter({ hasText: text });
/** @param {Page} page @param {string} key */
const filter = (page, key) => page.locator(`.thread-panel .filter[data-filter="${key}"]`);
/** The ids of the cards the panel lists, in order. @param {Page} page */
const listed = (page) => page.locator('.thread-panel [data-testid="thread-card"]').evaluateAll((els) => els.map((e) => /** @type {HTMLElement} */ (e).dataset.threadId || /** @type {HTMLElement} */ (e).dataset.draftId));
/** The data-action of a card's visible buttons. @param {Locator} card */
const buttons = (card) => card.locator(':scope > .card-actions > button.btn').evaluateAll((els) => els.map((e) => /** @type {HTMLElement} */ (e).dataset.action));
/** The data-action of a card's ⋯ menu items (it opens and closes the menu). @param {Page} page @param {Locator} card */
async function menuActions(page, card) {
  await card.locator('[data-card-menu]').click();
  const items = await page.locator('[role="menu"] [role="menuitem"]').evaluateAll((els) => els.map((e) => /** @type {HTMLElement} */ (e).dataset.action));
  await page.keyboard.press('Escape');
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  return items;
}
/** Moves keyboard focus back to the UI document (out of the doc iframe). @param {Page} page */
async function focusUi(page) {
  await page.evaluate(() => /** @type {HTMLElement|null} */ (document.activeElement)?.blur?.());
}
/** The bodies of the POST .../reviews requests so far. @param {any} mock */
const reviewPosts = (mock) => mock.requests.filter((/** @type {any} */ r) => r.method === 'POST' && /\/reviews$/.test(r.path)).map((/** @type {any} */ r) => r.body);

test('filters: Your turn by default with the turn pill\'s count, Claude with its planned changes first, Done, All', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  // the new default: the latest version in Review, no change marks
  await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
  await expect(filter(page, 'mine')).toHaveAttribute('aria-selected', 'true');
  await expect(filter(page, 'mine')).toContainText('Your turn');
  await expect(filter(page, 'mine').locator('.count')).toHaveText('5');
  await expect(page.getByTestId(TESTID.turnPill).locator('.turn-count')).toHaveText('5');
  await expect(filter(page, 'agent')).toContainText('Claude');
  await expect(filter(page, 'agent').locator('.count')).toHaveText('2');
  await expect(filter(page, 'done').locator('.count')).toHaveText('1');
  await expect(filter(page, 'all').locator('.count')).toHaveCount(0);
  expect((await listed(page)).sort()).toEqual(['t1', 't2', 't4', 't6', 't7']);
  // Accept all: what Claude changed or answered (t1, t2, t7), not the one it did not change (t4)
  const bar = page.locator('.thread-panel .accept-all-bar');
  await expect(bar.getByTestId(TESTID.verifyAcceptAll)).toHaveText('Accept all 3');
  await expect(bar).toContainText('1 thread Claude didn\'t change');

  await filter(page, 'agent').click();
  await expect(filter(page, 'agent')).toHaveAttribute('aria-selected', 'true');
  const planned = page.locator('.planned-group');
  await expect(planned.locator('.group-label')).toHaveText('Planned changes · 2');
  await expect(planned).toContainText('Claude answered these and will edit the document when you apply them.');
  await expect(planned.getByTestId(TESTID.applyPlanned)).toHaveText('Apply 2');
  await expect(planned.locator('[data-testid="thread-card"]')).toHaveCount(2);
  expect(await listed(page)).toEqual(['t8', 't3']);
  await expect(ui.card('t3').locator('.status-chip')).toHaveText('Will change');
  await filter(page, 'done').click();
  expect(await listed(page)).toEqual(['t5']);
  await filter(page, 'all').click();
  expect((await listed(page)).length).toBe(8);

  // The filter the reviewer picked stays while the state changes; the v key (formerly Verify) is Your turn again.
  await filter(page, 'done').click();
  await ui.card('t5').locator('[data-card-menu]').click();
  await page.locator('[role="menuitem"][data-action="reopen"]').click();
  await expect(filter(page, 'done').locator('.count')).toHaveText('0');
  await expect(filter(page, 'done')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.thread-panel .empty')).toHaveText('No finished threads yet.');
  await focusUi(page);
  await page.keyboard.press('v');
  await expect(filter(page, 'mine')).toHaveAttribute('aria-selected', 'true');
  // palette filter commands use the new words
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId(TESTID.commandPaletteInput).fill('threads with claude');
  await expect(page.getByTestId(TESTID.commandItem).first()).toHaveAttribute('data-command-id', 'filter-agent');
  await expect(page.getByTestId(TESTID.commandItem).first()).toContainText('Show threads with Claude');
  await page.keyboard.press('Enter');
  await expect(filter(page, 'agent')).toHaveAttribute('aria-selected', 'true');
  expect(ui.errors).toEqual([]);
});

test('the default filter follows what waits: Your turn, then Claude when nothing is left for you, then All', async ({ page, ui, mock }) => {
  // a doc with nothing in it opens without the thread panel; opened, the panel shows only its empty state, no filters
  await ui.open('app-spec');
  await expect(page.locator('#sr-side')).toBeHidden();
  await page.locator('.threads-toggle').click();
  await expect(page.locator('.thread-panel .filters')).toHaveCount(0);
  await expect(page.locator('.thread-panel .empty')).toContainText('No comments yet. Select text in the document to comment.');
  await ui.open('kitchen-sink');
  await expect(filter(page, 'mine')).toHaveAttribute('aria-selected', 'true');
  // everything that waited for the reviewer is done (in another tab, say): the panel shows what waits for Claude
  const d = mock.doc('kitchen-sink');
  for (const id of ['t1', 't2', 't4', 't6', 't7']) d.resolve(id);
  await expect(filter(page, 'mine').locator('.count')).toHaveText('0');
  await expect(filter(page, 'agent')).toHaveAttribute('aria-selected', 'true');
  expect(await listed(page)).toEqual(['t8', 't3']);
  await filter(page, 'mine').click();
  await expect(page.locator('.thread-panel .empty')).toContainText('Nothing needs you right now.');
  await expect(page.locator('.thread-panel .empty')).toContainText('2 threads wait for Claude.');
  expect(ui.errors).toEqual([]);
});

test('cards: one status chip, Must fix / ? flags, at most two buttons and a ⋯ menu by state', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await filter(page, 'all').click();
  const chip = (/** @type {string} */ id) => ui.card(id).locator('.status-chip');
  await expect(chip('t1')).toHaveText('Changed in v2 — check it');
  await expect(ui.card('t1').locator('.flag-must')).toHaveText('Must fix');
  await expect(chip('t2')).toHaveText('Claude answered');
  await expect(ui.card('t2').locator('.flag-question')).toHaveText('?');
  await expect(chip('t3')).toHaveText('Will change');
  await expect(chip('t4')).toHaveText('Claude didn\'t change it');
  await expect(ui.card('t4').locator('.flag-nit')).toHaveText('Nit');
  await expect(chip('t5')).toHaveText('Done');
  await expect(chip('t6')).toHaveText('Needs your answer');
  await expect(ui.card('t6').locator('.asked-banner')).toContainText('Claude asked you');
  // one chip per card (no anchor-state chip besides it)
  for (const id of ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']) await expect(ui.card(id).locator('.card-head .chip')).toHaveCount(1);

  expect(await buttons(ui.card('t1'))).toEqual(['accept', 'not-yet']);
  await expect(ui.card('t1').getByTestId(TESTID.verifyAccept)).toHaveText('Looks good');
  await expect(ui.card('t1').getByTestId(TESTID.verifyReopen)).toHaveText('Not yet');
  expect(await menuActions(page, ui.card('t1'))).toEqual(['reply', 'show-change', 'decision']);
  expect(await buttons(ui.card('t2'))).toEqual(['reply', 'accept']);
  await expect(ui.card('t2').getByTestId(TESTID.verifyAccept)).toHaveText('Done');
  expect(await menuActions(page, ui.card('t2'))).toEqual(['reopen', 'show-change', 'decision']);
  expect(await buttons(ui.card('t3'))).toEqual(['reply']);
  expect(await menuActions(page, ui.card('t3'))).toEqual(['apply', 'done', 'decision']);
  // t4: Claude did not change it, and its line is gone in v2: Move here / Keep as general in the menu
  expect(await buttons(ui.card('t4'))).toEqual(['reply', 'accept']);
  expect(await menuActions(page, ui.card('t4'))).toEqual(['reopen', 'decision', 'move', 'general', 'view-on']);
  expect(await buttons(ui.card('t5'))).toEqual([]);
  expect(await menuActions(page, ui.card('t5'))).toEqual(['reopen']);
  expect(await buttons(ui.card('t6'))).toEqual(['reply', 'accept']);
  expect(await menuActions(page, ui.card('t6'))).toEqual(['decision']);

  // Show change (t1's menu): the before / after of its anchor, hidden again with ×
  await ui.cardMenu(ui.card('t1'), 'show-change');
  const change = ui.card('t1').locator('.minidiff');
  await expect(change).toContainText('reuse-detection grace window');
  await change.getByRole('button', { name: 'Hide the change' }).click();
  await expect(change).toHaveCount(0);

  // Record as decision (t2's menu): marks it done with the decision
  await ui.cardMenu(ui.card('t2'), 'decision');
  await ui.card('t2').getByLabel('Decision (one line, recorded when the thread is done)').fill('The store sits behind the auth service');
  await ui.card('t2').getByRole('button', { name: 'Record and mark done' }).click();
  await expect(toastWith(page, 't2 is done and recorded as a decision.')).toBeVisible();
  expect(mock.doc('kitchen-sink').thread('t2').decision?.text).toBe('The store sits behind the auth service');
  await expect(chip('t2')).toHaveText('Done');

  // A reply after the answer: with Claude again, and out of Your turn
  await ui.card('t7').getByRole('button', { name: 'Reply', exact: true }).click();
  await ui.card('t7').getByTestId(TESTID.replyTextarea).fill('Can the planned bar be green?');
  await ui.card('t7').getByTestId(TESTID.replyAdd).click();
  await expect(chip('t7')).toHaveText('With Claude');
  expect(ui.errors).toEqual([]);
});

test('Lost its place: the chip, Move here and Keep as general as the buttons, View on vN in the menu', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  const d = mock.doc('kitchen-sink');
  // v3 rewrites the TTL cell t3 (planned) is on: its anchor changed
  d.revise({ source: d.source(2).replace('| refresh_token | 30 d |', '| refresh_token | 14 d |'), summary: 'TTL' });
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('3');
  await filter(page, 'mine').click();
  const t3 = ui.card('t3');
  await expect(t3.locator('.status-chip')).toHaveText('Lost its place');
  expect(await buttons(t3)).toEqual(['move', 'general']);
  expect(await menuActions(page, t3)).toEqual(['view-on', 'reply', 'done']);
  // it is Your turn's, not a "problem": no problems chip
  await expect(page.getByTestId(TESTID.problems)).toHaveCount(0);
  await t3.getByRole('button', { name: 'Keep as general' }).click();
  await expect(toastWith(page, 't3 moved.')).toBeVisible();
  // it has a place again: back with Claude's planned changes
  await expect(filter(page, 'mine').locator('.count')).not.toHaveText('6');
  await filter(page, 'agent').click();
  await expect(t3.locator('.status-chip')).toHaveText('Will change');
  await expect(t3.locator('.card-target')).toHaveText('General comment');
  expect(ui.errors).toEqual([]);
});

test('Apply: Apply N sends the planned threads (draftIds [], edits now); drafts stay drafts; the threads go back to Claude', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  // a comment kept as a draft must not go out with the Apply
  await page.getByRole('button', { name: 'General comment' }).click();
  await page.getByTestId(TESTID.composerTextarea).fill('A draft that stays a draft');
  await page.getByTestId(TESTID.composerAdd).click();
  await expect(page.getByTestId(TESTID.composer)).toHaveCount(0);
  const d = mock.doc('kitchen-sink');
  expect(d.drafts.items).toHaveLength(1);

  await filter(page, 'agent').click();
  await page.getByTestId(TESTID.applyPlanned).click();
  // ("Saved … for Claude" while it is not connected; whether Claude still counts as working on rv2 depends on the clock)
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: /^(Sent 2 planned changes to Claude\.|Saved 2 planned changes for Claude\. It gets them when it connects\.)/ })).toBeVisible();
  const [body] = reviewPosts(mock);
  expect(body).toMatchObject({ verdict: 'comment', body: '', draftIds: [], edits: 'now', instant: true });
  expect([...body.apply].sort()).toEqual(['t3', 't8']);
  expect(d.drafts.items).toHaveLength(1);
  expect(d.reviews.at(-1)).toMatchObject({ apply: ['t3', 't8'], edits: 'now', newThreads: [] });
  // reopened, with the request as one compact line
  await expect(page.locator('.planned-group')).toHaveCount(0);
  await expect(ui.card('t3').locator('.status-chip')).toHaveText('With Claude');
  await expect(ui.card('t3').locator('.system-line')).toContainText('You asked Claude to make this change');
  await expect(ui.card('t3').locator('.comment.system')).toHaveCount(1);
  expect(ui.errors).toEqual([]);
});

test('Apply: a card\'s "Apply this now", the turn pill and the palette; a 409 says why and refreshes', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  const d = mock.doc('kitchen-sink');
  const sent = page.getByTestId(TESTID.toast).filter({ hasText: /^(Sent 1 planned change to Claude\.|Saved 1 planned change for Claude\. It gets it when it connects\.)/ });
  await filter(page, 'agent').click();
  await ui.cardMenu(ui.card('t8'), 'apply');
  await expect(sent).toHaveCount(1);
  expect(reviewPosts(mock).at(-1)).toMatchObject({ apply: ['t8'], draftIds: [], edits: 'now', verdict: 'comment' });
  await expect(page.getByTestId(TESTID.applyPlanned)).toHaveText('Apply 1');

  // a refused Apply (the thread is not planned any more, say): the server's words, and the state is fetched again
  mock.failNext('POST', /\/reviews$/, 409);
  const before = mock.requests.length;
  await page.getByTestId(TESTID.applyPlanned).click();
  await expect(toastWith(page, 'injected failure')).toBeVisible();
  await expect.poll(() => mock.requests.slice(before).some((/** @type {any} */ r) => r.method === 'GET' && /\/kitchen-sink$/.test(r.path))).toBe(true);
  expect(d.thread('t3').status).toBe('planned');

  // the turn pill offers it
  await page.getByTestId(TESTID.turnPill).click();
  const apply = page.locator('[data-apply-planned]');
  await expect(apply).toHaveText('Apply 1 planned');
  await expect(page.locator('.turn-planned')).toContainText('Claude planned 1 change');
  await apply.click();
  await expect.poll(() => reviewPosts(mock).length).toBe(3);
  await expect(sent.last()).toBeVisible();
  expect(reviewPosts(mock).at(-1)).toMatchObject({ apply: ['t3'], draftIds: [] });

  // the palette: nothing left to apply
  await focusUi(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId(TESTID.commandPaletteInput).fill('apply planned');
  const cmd = page.locator(`[data-testid="${TESTID.commandItem}"][data-command-id="apply-planned"]`);
  await expect(cmd).toContainText('Claude has no planned changes');
  await page.keyboard.press('Escape');
  // ... and with one planned again
  d.agentReply('t3', { status: 'planned', body: 'I will make it 7 d after all.' });
  await expect(page.getByTestId(TESTID.applyPlanned)).toHaveText('Apply 1');
  await focusUi(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId(TESTID.commandPaletteInput).fill('apply planned');
  await expect(page.getByTestId(TESTID.commandItem).first()).toHaveAttribute('data-command-id', 'apply-planned');
  await page.keyboard.press('Enter');
  await expect.poll(() => reviewPosts(mock).length).toBe(4);
  await expect(sent.last()).toBeVisible();
  expect(reviewPosts(mock).at(-1)).toMatchObject({ apply: ['t3'], draftIds: [], edits: 'now' });
  // (the browser logs the refused request itself)
  expect(ui.errors.filter((e) => !/status of 409/.test(e))).toEqual([]);
});

test('rich replies: a thumbnail opens full size; the HTML preview runs sandboxed; Open large; Use in doc sends a reply with use', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  // All: t7 stays listed once it is with Claude again
  await filter(page, 'all').click();
  const t7 = ui.card('t7');
  await expect(t7.locator('.comment.by-agent').last()).toContainText('Here are the lifetimes');

  // the picture: a thumbnail, full size on a click
  const thumb = t7.locator('.agent-thumb img');
  await expect(thumb).toHaveAttribute('alt', 'lifetimes.png');
  await expect.poll(() => thumb.evaluate((img) => /** @type {HTMLImageElement} */ (img).naturalWidth)).toBe(240);
  expect((await thumb.boundingBox())?.height).toBeLessThanOrEqual(160);
  await t7.locator('.agent-thumb').click();
  await expect(page.getByTestId('lightbox').locator('img')).toHaveAttribute('src', /\/__att\/a1\.png$/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('lightbox')).toHaveCount(0);

  // the live chart: allow-scripts only, no same origin, no referrer
  const frame = t7.locator('iframe.preview-frame');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(await frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  expect((await frame.boundingBox())?.height).toBe(260);
  const chart = await (await frame.elementHandle())?.contentFrame();
  if (!chart) throw new Error('no preview frame');
  await expect.poll(() => chart.evaluate(() => document.body?.dataset.drawn)).toBe('4');
  expect(await chart.evaluate(() => ({ ...document.body.dataset }))).toMatchObject({ storage: 'blocked', parent: 'blocked', cookie: 'blocked' });
  expect(await chart.evaluate(() => origin)).toBe('null');
  // served with the preview's own CSP
  const res = await page.request.get(String(await frame.getAttribute('src')));
  expect(res.headers()['content-type']).toBe('text/html; charset=utf-8');
  expect(res.headers()['content-security-policy']).toContain('sandbox allow-scripts');
  expect(res.headers()['referrer-policy']).toBe('no-referrer');

  // Open large: the same frame in an overlay; Esc closes it and the focus goes back
  const open = t7.getByRole('button', { name: 'Open large' });
  await open.click();
  const overlay = page.getByTestId('attachment-preview');
  await expect(overlay.locator('iframe.preview-frame')).toHaveAttribute('sandbox', 'allow-scripts');
  const box = await overlay.boundingBox();
  const vp = page.viewportSize();
  expect(box && vp ? box.width / vp.width : 0).toBeGreaterThan(0.85);
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
  await expect(open).toBeFocused();

  // Use in doc (sent right away by default): a reply with use and the default words, then a one-item review
  await t7.locator('.preview-card').getByTestId(TESTID.useAttachment).click();
  await expect(toastWith(page, 'Asked Claude to put chart.html in the document.')).toBeVisible();
  const draft = mock.requests.find((/** @type {any} */ r) => r.method === 'POST' && /\/drafts$/.test(r.path))?.body;
  expect(draft).toEqual({ kind: 'reply', thread: 't7', body: 'Put this in the doc.', reopen: false, use: ['attachments/a2.html'] });
  const review = reviewPosts(mock).at(-1);
  expect(review).toMatchObject({ verdict: 'comment', body: '', edits: 'now' });
  expect(review.draftIds).toHaveLength(1);
  const last = mock.doc('kitchen-sink').thread('t7').comments.at(-1);
  expect(last).toMatchObject({ body: 'Put this in the doc.', use: ['attachments/a2.html'] });
  await expect(t7.locator('.system-line').last()).toContainText('You asked Claude to put chart.html in the document');
  await expect(t7.locator('.status-chip')).toHaveText('With Claude');
  expect(ui.errors).toEqual([]);
});

test('Use in doc: a draft when sending is batched (it keeps use), and a resolved thread is reopened for it', async ({ page, ui, mock }) => {
  await page.addInitScript(() => {
    if (window.top === window && localStorage.getItem('suiko.sendMode') == null) localStorage.setItem('suiko.sendMode', 'batch');
  });
  await ui.open('kitchen-sink');
  await filter(page, 'all').click();
  const t7 = ui.card('t7');
  await t7.locator('.agent-image').getByTestId(TESTID.useAttachment).click();
  await expect(toastWith(page, 'Added to your review')).toBeVisible();
  expect(reviewPosts(mock)).toHaveLength(0);
  const d = mock.doc('kitchen-sink');
  expect(d.drafts.items).toEqual([expect.objectContaining({ kind: 'reply', thread: 't7', use: ['attachments/a1.png'] })]);
  await expect(t7.locator('.pending-reply')).toContainText('Put lifetimes.png in the document');
  await expect(page.getByTestId(TESTID.submitReviewOpen).locator('.drafts-count')).toHaveText('1');
  // editing the reply draft keeps its use
  await t7.locator('.pending-reply').getByRole('button', { name: 'Edit' }).click();
  await expect(t7.locator('.reply-box .system-line')).toContainText('Asks Claude to put lifetimes.png in the document');
  await t7.getByTestId(TESTID.replyTextarea).fill('Put this one in, under section 3.');
  await t7.getByTestId(TESTID.replyAdd).click();
  await expect.poll(() => d.drafts.items[0]?.body).toBe('Put this one in, under section 3.');
  expect(d.drafts.items[0].use).toEqual(['attachments/a1.png']);
  // sent with the review: the comment keeps it
  await page.getByTestId(TESTID.submitReviewOpen).click();
  await page.getByTestId(TESTID.submitConfirm).click();
  await expect.poll(() => d.thread('t7').comments.at(-1)?.use).toEqual(['attachments/a1.png']);
  expect(reviewPosts(mock).at(-1)).toMatchObject({ verdict: 'comment', edits: 'now' });
  await expect(t7.locator('.system-line').last()).toContainText('You asked Claude to put lifetimes.png in the document');
  await expect(t7.locator('.comment.system .comment-body')).toContainText('under section 3');

  // a resolved thread with an attachment: Use in doc reopens it (right away, from the Done filter)
  await page.evaluate(() => localStorage.setItem('suiko.sendMode', 'now'));
  d.resolve('t7');
  await page.reload();
  await ui.ready();
  await filter(page, 'done').click();
  await ui.card('t7').locator('.preview-card').getByTestId(TESTID.useAttachment).click();
  await expect.poll(() => d.thread('t7').status).toBe('open');
  expect(d.reviews.at(-1).reopened).toEqual(['t7']);
  expect(ui.errors).toEqual([]);
});
