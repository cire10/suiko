// @ts-check
// The reviewer UI against the REAL daemon (WP5) and review engine (WP3), in-process (test/e2e/real-daemon.mjs):
// the contract that matters. Each test gets a fresh workspace, SPECREVIEW_HOME and daemon on random ports; the
// agent side is driven through the same engine ops the CLI uses (feedback = delivery, revise).

import { test as base, expect } from '@playwright/test';
import { TESTID } from '../../src/shared/protocol.js';
import { Ui } from './fixtures.mjs';
import { makePng } from './mock-data.mjs';
import { startRealDaemon } from './real-daemon.mjs';

/** @typedef {Awaited<ReturnType<typeof startRealDaemon>>} Real */

const test = base.extend(/** @type {any} */ ({
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

/** @param {import('@playwright/test').Page} page @param {string} mode */
const modeTab = (page, mode) => page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="${mode}"]`);

/** @param {import('@playwright/test').Page} page */
async function focusUi(page) {
  await page.evaluate(() => /** @type {HTMLElement|null} */ (document.activeElement)?.blur?.());
}

/** A redrawn architecture image (different bytes and size than the fixture). */
const REDRAWN_PNG = makePng(240, 160, (x) => (x < 120 ? [120, 70, 200, 255] : [20, 160, 150, 255]));

test('a full round: comment, pick, suggestion, submit, delivery, revision, Changes, Verify', async (/** @type {any} */ { page, ui, real }) => {
  /** @type {Real} */
  const r = real;
  await ui.open('kitchen-sink');
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('1');
  await expect(page.locator('.outline-link')).toHaveCount(7);
  await expect(page.getByTestId(TESTID.threadPanel)).toContainText('No threads yet');
  await expect(page.getByTestId(TESTID.presence)).toHaveText(/No agent listening/);
  await expect(page).toHaveTitle(/Token Service Implementation Spec/);

  // 1. Select text with the mouse inside the doc; the guest forwards `c`.
  const sel = await ui.pointIn('p', 'rotated on every use');
  await page.mouse.move(sel.x + 1, sel.cy);
  await page.mouse.down();
  await page.mouse.move(sel.x + sel.w / 2, sel.cy, { steps: 4 });
  await page.mouse.move(sel.x + sel.w - 1, sel.cy, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('[data-selection-comment]')).toBeEnabled();
  await page.keyboard.press('c');
  const composer = page.getByTestId(TESTID.composer);
  await expect(composer.locator('.agent-sees')).toContainText('Agent will see: L51');
  await expect(composer.locator('.agent-sees')).toContainText('"rotated on every use"');
  await page.getByTestId(TESTID.composerTextarea).fill('Rotation on **every** use breaks concurrent clients.');
  await composer.getByRole('radio', { name: 'Blocking' }).click();
  await page.getByTestId(TESTID.composerAdd).click();
  await expect(composer).toBeHidden();
  await expect(page.locator(`[data-testid="${TESTID.threadCard}"][data-draft-id]`)).toHaveCount(1);
  let st = await r.state('kitchen-sink');
  expect(st.drafts.items[0]).toMatchObject({
    kind: 'thread', type: 'comment', severity: 'blocking', version: 1,
    anchor: { kind: 'text', src: { startLine: 51, text: 'rotated on every use' } },
  });
  await expect.poll(async () => (await ui.inspect()).highlights['sr-draft'] || 0).toBeGreaterThan(0);

  // 2. Pick the image: an element comment (a question).
  await page.getByTestId(TESTID.pickTool).click();
  await expect.poll(async () => (await ui.inspect()).picker.active).toBe(true);
  const img = await ui.pointIn('img');
  await page.mouse.move(img.cx - 10, img.cy - 10);
  await page.mouse.move(img.cx, img.cy, { steps: 3 });
  await page.mouse.click(img.cx, img.cy);
  await expect(composer.locator('.agent-sees')).toContainText('L29');
  await composer.getByRole('radio', { name: 'Question' }).click();
  await page.getByTestId(TESTID.composerTextarea).fill('Is the token store really behind the auth service?');
  await page.getByTestId(TESTID.composerAdd).click();
  await expect(composer).toBeHidden();

  // 3. A text-mode suggestion with a live word diff.
  await ui.selectText('Ship rotation behind a flag.');
  await focusUi(page);
  await page.keyboard.press('s');
  const input = page.getByTestId(TESTID.composerSuggestion);
  await expect(input).toHaveValue('Ship rotation behind a flag.');
  await input.fill('Ship rotation behind the token-rotation flag.');
  await expect(page.locator('.live-diff')).toContainText('token-rotation');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(composer).toBeHidden();
  await expect(page.locator(`[data-testid="${TESTID.threadCard}"][data-draft-id]`)).toHaveCount(3);
  st = await r.state('kitchen-sink');
  expect(st.drafts.items.map((/** @type {any} */ d) => [d.type, d.anchor.kind])).toEqual([['comment', 'text'], ['question', 'element'], ['suggestion', 'text']]);
  expect(st.drafts.items[2].suggestion).toMatchObject({ mode: 'text', old: 'Ship rotation behind a flag.', new: 'Ship rotation behind the token-rotation flag.' });

  // 4. Submit with "Request changes".
  await page.getByTestId(TESTID.submitReviewOpen).click();
  const dialog = page.getByTestId(TESTID.submitReviewDialog);
  await expect(dialog).toContainText('No agent is listening');
  await expect(dialog.locator('.draft-list li')).toHaveCount(3);
  await dialog.locator(`[data-testid="${TESTID.submitVerdict}"] input[value="changes_requested"]`).check();
  await dialog.getByLabel('Summary').fill('Good start; see the comments.');
  await page.getByTestId(TESTID.submitConfirm).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'Changes requested (rv1)' })).toBeVisible();
  for (const id of ['t1', 't2', 't3']) await expect(ui.card(id)).toBeVisible();
  await expect(page.locator('.drafts-count')).toContainText('0');
  await expect(page.locator('.review-progress')).toContainText('Submitted');
  st = await r.state('kitchen-sink');
  expect(st.reviews).toMatchObject([{ id: 'rv1', verdict: 'changes_requested', newThreads: ['t1', 't2', 't3'] }]);

  // 5. The agent fetches the feedback (delivery), then edits the spec and redraws the image.
  await r.agentFeedback('kitchen-sink');
  await expect(page.locator('.review-progress')).toContainText('Delivered to claude');
  await expect(page.getByTestId(TESTID.presence)).toHaveText(/claude is revising/);
  r.write('docs/kitchen-sink.md', r.read('docs/kitchen-sink.md')
    .replace('rotated on every use, and', 'rotated on every use with a 30 s reuse-detection grace window, and'));
  await expect(page.locator('.banner-warn')).toContainText('Unrecorded changes on disk', { timeout: 15000 });
  await expect(page.getByTestId(TESTID.presence)).toHaveText(/claude is editing \(unrecorded\)/);
  r.write('docs/img/arch.png', /** @type {any} */ (REDRAWN_PNG));

  // 6. `specreview revise`: v2 answers rv1.
  const res = await r.revise('kitchen-sink', {
    summary: 'Grace window and a redrawn diagram',
    threads: {
      t1: { status: 'addressed', reply: 'Added a **30 s** reuse-detection grace window.' },
      t2: { status: 'answered', reply: 'Yes. I redrew the diagram to make that clear.' },
      t3: { status: 'declined', reply: 'Keeping the flag name generic.' },
    },
  });
  expect(res.refused).toBe(false);
  expect(res.version).toBe(2);
  const toast = page.getByTestId(TESTID.toast).filter({ hasText: 'v2 ready' });
  await expect(toast).toContainText('from claude');
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
  await expect(page.locator('.banner-warn')).toHaveCount(0);
  await toast.getByRole('button', { name: 'Review changes' }).click();
  await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#sr-base')).toHaveValue('1');
  const change = page.getByTestId(TESTID.changeItem);
  await expect(change).toHaveCount(1);
  await expect(change).toContainText('reuse-detection grace window');
  await expect(change.getByRole('button', { name: 't1' })).toBeVisible();
  // The redrawn image: the engine's relative asset URLs resolve on the content origin.
  const pair = page.locator('.asset-change img');
  await expect(pair).toHaveCount(2);
  await expect(pair.nth(0)).toHaveAttribute('src', new RegExp(`^${r.contentOrigin}/c/[0-9a-f]+/v1/docs/img/arch\\.png$`));
  await expect(pair.nth(1)).toHaveAttribute('src', new RegExp(`^${r.contentOrigin}/c/[0-9a-f]+/v2/docs/img/arch\\.png$`));
  await pair.nth(1).scrollIntoViewIfNeeded();
  await expect.poll(() => pair.nth(0).evaluate((/** @type {HTMLImageElement} */ i) => i.naturalWidth)).toBe(160);
  await expect.poll(() => pair.nth(1).evaluate((/** @type {HTMLImageElement} */ i) => i.naturalWidth)).toBe(240);
  // Round results: accept t1.
  const r1 = page.locator('.round-results .result[data-thread-id="t1"]');
  await expect(r1).toContainText('30 s');
  await r1.getByTestId(TESTID.verifyAccept).click();
  await expect(r1).toContainText('Resolved');
  st = await r.state('kitchen-sink');
  expect(st.threads.find((/** @type {any} */ t) => t.id === 't1').status).toBe('resolved');

  // 7. Verify queue: t2 shows the image pair; reopen it with a reply.
  await focusUi(page);
  await page.keyboard.press('v');
  await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId(TESTID.threadPanel).getByTestId(TESTID.threadCard)).toHaveCount(2);
  const t2 = ui.card('t2');
  await t2.locator('.minidiff summary').click();
  await expect(t2.locator('.minidiff img')).toHaveCount(2);
  await expect.poll(() => t2.locator('.minidiff img').nth(1).evaluate((/** @type {HTMLImageElement} */ i) => i.naturalWidth)).toBe(240);
  await t2.getByTestId(TESTID.verifyReopen).click();
  await t2.getByTestId(TESTID.replyTextarea).fill('The store should sit behind the auth service, not next to it.');
  await t2.getByTestId(TESTID.replyAdd).click();
  await expect.poll(async () => (await r.state('kitchen-sink')).drafts.items).toMatchObject([{ kind: 'reply', thread: 't2', reopen: true }]);
  await expect(page.locator('.drafts-count')).toContainText('1');
  expect(ui.errors).toEqual([]);
});

test('section comment, Mark agreed and Apply now against the real engine', async (/** @type {any} */ { page, ui, real }) => {
  /** @type {Real} */
  const r = real;
  await ui.open('kitchen-sink');

  // Comment on a section from the outline menu.
  await page.getByRole('button', { name: 'Actions for section 3 Tokens' }).click();
  await page.getByRole('menuitem', { name: 'Comment on section' }).click();
  const composer = page.getByTestId(TESTID.composer);
  await expect(composer.locator('.agent-sees')).toContainText('3 Tokens');
  await expect(composer.getByRole('radio', { name: 'Suggestion' })).toBeDisabled();
  await page.getByTestId(TESTID.composerTextarea).fill('Add the id_token rotation policy.');
  await page.getByTestId(TESTID.composerAdd).click();
  await expect(composer).toBeHidden();
  await expect.poll(async () => (await r.state('kitchen-sink')).drafts.items.map((/** @type {any} */ d) => d.anchor.kind)).toEqual(['section']);

  // `a` on a selection asks for confirmation, then locks the text.
  await ui.selectText('Prototype the issuer.');
  await focusUi(page);
  await page.keyboard.press('a');
  await expect(composer).toContainText('Mark this part as agreed?');
  await composer.getByRole('button', { name: 'Mark agreed' }).click();
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'Marked agreed (L1)' })).toBeVisible();
  const locks = (await r.state('kitchen-sink')).locks;
  expect(locks).toMatchObject([{ id: 'L1', active: true }]);
  await expect(page.locator('.outline-item', { hasText: '1.1 Milestones' }).locator('.badge.tone-lock')).toBeVisible();
  await expect.poll(async () => (await ui.inspect()).highlights['sr-lock'] || 0).toBeGreaterThan(0);

  // A suggestion sent right away, then applied by the reviewer: a new version, thread resolved.
  await ui.selectText('Remove the legacy session store.');
  await focusUi(page);
  await page.keyboard.press('s');
  await page.getByTestId(TESTID.composerSuggestion).fill('Remove the legacy session store after the rollout.');
  await page.getByTestId(TESTID.composerSendNow).click();
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'Sent to the agent' })).toBeVisible();
  // Send now submits only this comment; the pending section draft stays a draft.
  const st = await r.state('kitchen-sink');
  expect(st.reviews).toMatchObject([{ verdict: 'comment', newThreads: ['t1'] }]);
  expect(st.drafts.items).toHaveLength(1);
  const card = ui.card('t1');
  await expect(card.locator('.suggestion-block')).toContainText('Pending');
  await card.getByRole('button', { name: 'Apply now' }).click();
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'Suggestion applied as v2' })).toBeVisible();
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
  expect(r.read('docs/kitchen-sink.md')).toContain('Remove the legacy session store after the rollout.');
  await page.locator('.filter[data-filter="all"]').click();
  await expect(card.locator('.status-chip')).toHaveText('Resolved');
  await expect(card.locator('.suggestion-block')).toContainText('Applied in v2');
  expect(ui.errors).toEqual([]);
});

test('an HTML spec: its own scripts run, the outline comes from the guest, a table cell can be picked', async (/** @type {any} */ { page, ui, real }) => {
  /** @type {Real} */
  const r = real;
  await ui.open('app-spec');
  await expect(page).toHaveTitle(/Checkout Service/);
  await expect(page.locator('.outline-link').first()).toHaveText('Checkout Service');
  await expect(page.locator('.outline-link', { hasText: '3. Pricing rules' })).toBeVisible();

  await focusUi(page);
  await page.keyboard.press('e');
  await expect(page.getByTestId(TESTID.pickTool)).toHaveAttribute('aria-pressed', 'true');
  const cell = await ui.pointIn('#pricing-table td', 'members only');
  await page.mouse.move(cell.cx - 5, cell.cy);
  await page.mouse.move(cell.cx, cell.cy, { steps: 3 });
  await page.mouse.click(cell.cx, cell.cy);
  // The guest's Cell / Row / Column / Table chooser: Enter picks the cell.
  await expect.poll(async () => !!(await ui.inspect()).chooser).toBe(true);
  await page.keyboard.press('Enter');
  const composer = page.getByTestId(TESTID.composer);
  await expect(composer.locator('.agent-sees')).toContainText('Agent will see:');
  await page.getByTestId(TESTID.composerTextarea).fill('Members only? What about trials?');
  await page.getByTestId(TESTID.composerAdd).click();
  await expect(composer).toBeHidden();
  const [d] = (await r.state('app-spec')).drafts.items;
  expect(d.anchor.kind).toBe('cell');
  expect(d.anchor.cell).toMatchObject({ rowKey: 'loyalty', text: 'members only' });
  expect(ui.errors).toEqual([]);
});

test('a source-mode suggestion when the selection spans Markdown markup, with a rendered preview', async (/** @type {any} */ { page, ui, real }) => {
  /** @type {Real} */
  const r = real;
  await ui.open('kitchen-sink');
  await ui.selectText('issues and rotates');
  // Extend the selection backwards over the bold "token service" so the source slice carries ** markup.
  const f = await ui.frame();
  await f.evaluate(() => {
    const p = /** @type {HTMLElement} */ (document.querySelector('p strong'));
    const sel = /** @type {Selection} */ (getSelection());
    const end = sel.getRangeAt(0);
    const range = document.createRange();
    range.setStart(/** @type {Node} */ (p.firstChild), 0);
    range.setEnd(end.endContainer, end.endOffset);
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await expect.poll(async () => (await ui.inspect()).selection?.capture?.exact).toBe('token service that issues and rotates');
  await focusUi(page);
  await page.keyboard.press('s');
  const editor = page.getByTestId(TESTID.composerSuggestion);
  await expect(editor).toHaveJSProperty('tagName', 'TEXTAREA');
  await expect(page.locator('.suggestion-editor')).toContainText('source mode');
  await expect(editor).toHaveValue(/This spec describes the \*\*token service\*\* that issues and rotates/);
  const before = await editor.inputValue();
  await editor.fill(before.replace('issues and rotates', 'mints and rotates'));
  await expect(page.locator('.live-diff ins')).toContainText('mints');
  await page.getByRole('button', { name: 'Preview rendered' }).click();
  await expect(page.locator('.fragment-preview strong')).toHaveText('token service');
  await page.getByTestId(TESTID.composerAdd).click();
  await expect(page.getByTestId(TESTID.composer)).toBeHidden();
  const [d] = (await r.state('kitchen-sink')).drafts.items;
  expect(d.type).toBe('suggestion');
  expect(d.suggestion).toMatchObject({ mode: 'source', startLine: 9 });
  expect(d.suggestion.old).toContain('**token service** that issues and rotates');
  expect(d.suggestion.new).toContain('**token service** that mints and rotates');
  expect(ui.errors).toEqual([]);
});

test('home lists the docs of the registered workspace', async (/** @type {any} */ { page, real }) => {
  /** @type {Real} */
  const r = real;
  await page.goto(r.url());
  const list = page.getByTestId(TESTID.docList);
  await expect(list.locator('li')).toHaveCount(2);
  await expect(list.locator('li', { hasText: 'docs/kitchen-sink.md' })).toContainText('Token Service Implementation Spec');
  await expect(list.locator('li', { hasText: 'docs/app-spec.html' })).toContainText('v1');
  await list.getByRole('link', { name: /Checkout Service/ }).click();
  await expect(page.getByTestId(TESTID.docFrame)).toBeVisible();
  await expect(page.locator('.frame-wrap[data-guest="ready"]')).toBeAttached({ timeout: 15000 });
});
