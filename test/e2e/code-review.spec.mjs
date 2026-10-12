// @ts-check
// The code-review UI (doc kind 'code', WP4) against the mock daemon's 'code' scenario (test/e2e/mock-code.mjs):
// review 'cr-feat' after one round of review (v2 answers rv1; t1 new side, t2 old side, t3 suggestion, t4 on a binary
// file, t5 general). It covers the file tree (status letters, counts, stub badges, filter), line selection on both
// sides and the composer, a submitted draft's line capture (the mock request log), the suggestion prefill, Changes
// (the interdiff with thread chips), Verify, Re-snapshot, the split / unified toggle, "Comment on file" on a binary,
// the absent pick / snip / hide tools, "Show all" past 3000 rows, the keys, a narrow window and both themes.

import { CODE_TESTID, TESTID } from '../../src/shared/protocol.js';
import { A_V2, GENERATED_LINES } from './mock-code.mjs';
import { expect, test } from './fixtures.mjs';

test.use(/** @type {any} */ ({ scenario: 'code' }));

/** @typedef {import('@playwright/test').Page} Page */

const DOC = 'cr-feat';

/** @param {Page} page @param {string} mode */
const modeTab = (page, mode) => page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="${mode}"]`);
/** @param {Page} page @param {string} path */
const card = (page, path) => page.locator(`[data-testid="${CODE_TESTID.fileDiff}"][data-path="${path}"]`);
/** @param {Page} page @param {string} path @param {'new'|'old'} side @param {number} line */
const lineBtn = (page, path, side, line) => card(page, path).locator(`[data-testid="${CODE_TESTID.lineBtn}"][data-side="${side}"][data-line="${line}"]`);
/** @param {Page} page @param {string} path */
const treeRow = (page, path) => page.locator(`[data-testid="${CODE_TESTID.fileRow}"][data-path="${path}"]`);

/**
 * Opens the review and waits for the code view's ready marker; 'files' switches to the Files mode first (the review
 * opens on Changes, as v2 is newer than the last review).
 * @param {any} ui @param {'files'|'changes'} [mode]
 */
async function openReview(ui, mode = 'files') {
  const page = /** @type {Page} */ (ui.page);
  await page.goto(ui.mock.url(DOC));
  await expect(page.locator('[data-view="code"][data-ready]')).toBeAttached({ timeout: 15000 });
  if (mode === 'files') {
    // a narrow window has a mode menu in place of the tabs
    if (await page.locator('#sr-mode').isVisible()) await page.locator('#sr-mode').selectOption('review');
    else await modeTab(page, 'review').click();
    await expect(page.locator('[data-view="code"][data-mode="files"][data-ready]')).toBeAttached();
  } else {
    await expect(page.locator('[data-view="code"][data-mode="changes"][data-ready]')).toBeAttached();
  }
}

/**
 * The mock requests matching a method and a path fragment.
 * @param {any} mock @param {string} method @param {string|RegExp} path
 */
const requests = (mock, method, path) => mock.requests.filter((/** @type {any} */ r) => r.method === method
  && (typeof path === 'string' ? r.path.includes(path) : path.test(r.path)));

test('the file tree lists the files with status letters, counts and stub badges; the filter narrows tree and cards', async ({ page, ui, mock }) => {
  await openReview(ui);
  const tree = page.getByTestId(CODE_TESTID.fileTree);
  await expect(tree.getByRole('heading', { name: /Files/ })).toBeVisible();
  const files = mock.doc(DOC).files({ v: 2 }).files.map((/** @type {any} */ f) => f.path);
  await expect(page.getByTestId(CODE_TESTID.fileRow)).toHaveCount(files.length);
  for (const f of files) await expect(treeRow(page, f)).toBeVisible();
  // the modified, the new and the binary file: letter, counts, stub badge, open threads
  await expect(treeRow(page, 'src/a.js').locator('.cd-status')).toHaveText('M');
  await expect(treeRow(page, 'src/a.js')).toContainText('+4');
  await expect(treeRow(page, 'src/a.js')).toContainText('−4');
  await expect(treeRow(page, 'src/a.js').locator('.badge')).toHaveText('2');
  await expect(treeRow(page, 'src/util/strings.js').locator('.cd-status')).toHaveText('A');
  await expect(treeRow(page, 'assets/logo.png').locator('.cd-status')).toHaveText('A');
  await expect(treeRow(page, 'assets/logo.png').locator('.cd-stub-badge')).toBeVisible();
  await expect(treeRow(page, 'docs/old-notes.md').locator('.cd-status')).toHaveText('D');
  await expect(treeRow(page, 'src/new-name.js').locator('.cd-status')).toHaveText('R');
  await expect(treeRow(page, 'data/fixtures.json').locator('.cd-stub-badge')).toBeVisible();
  await expect(tree).toContainText('1 file not in the review');
  // one card per file, the binary and the too-large file as placeholders (never fetched)
  await expect(page.getByTestId(CODE_TESTID.fileDiff)).toHaveCount(files.length);
  await expect(card(page, 'assets/logo.png').getByTestId(CODE_TESTID.stub)).toContainText('Binary file not shown.');
  await expect(card(page, 'data/fixtures.json').getByTestId(CODE_TESTID.stub)).toContainText('File too large to show (6.0 MB)');
  expect(requests(mock, 'GET', 'files/diff?path=assets')).toHaveLength(0);
  // a rename shows both paths
  await expect(card(page, 'src/new-name.js').locator('.cd-path')).toContainText('src/old-name.js → src/new-name.js');

  // the filter narrows the tree and the cards
  await tree.getByRole('searchbox', { name: 'Filter files' }).fill('util');
  await expect(page.getByTestId(CODE_TESTID.fileRow)).toHaveCount(1);
  await expect(page.getByTestId(CODE_TESTID.fileDiff)).toHaveCount(1);
  await expect(card(page, 'src/util/strings.js')).toBeVisible();
  await tree.getByRole('searchbox', { name: 'Filter files' }).press('Escape');
  await expect(page.getByTestId(CODE_TESTID.fileDiff)).toHaveCount(files.length);

  // a row scrolls the centre to its card
  await treeRow(page, 'src/new-name.js').click();
  await expect(card(page, 'src/new-name.js')).toBeInViewport();
  await expect(treeRow(page, 'src/new-name.js')).toHaveAttribute('aria-current', 'true');
  expect(ui.errors).toEqual([]);
});

test('shift-click on new-side and old-side line numbers opens the composer; the draft posts a line capture', async ({ page, ui, mock }) => {
  await openReview(ui);
  const composer = page.getByTestId(TESTID.composer);

  // new side: L3-4 of src/a.js (unchanged lines, shown on both sides)
  await lineBtn(page, 'src/a.js', 'new', 3).click();
  await lineBtn(page, 'src/a.js', 'new', 4).click({ modifiers: ['Shift'] });
  await expect(card(page, 'src/a.js').locator('tr.sel')).toHaveCount(2);
  await expect(page.locator('.code-selbar')).toContainText('src/a.js:L3-4');
  await page.keyboard.press('c');
  await expect(composer).toContainText('Agent will see: src/a.js:L3-4');
  const resolve = requests(mock, 'POST', '/anchors/resolve').at(-1);
  expect(resolve.body.capture).toEqual({ kind: 'line', file: 'src/a.js', side: 'new', startLine: 3, endLine: 4 });
  expect(resolve.body.version).toBe(2);
  await page.getByTestId(TESTID.composerTextarea).fill('Explain the discount in the doc comment.');
  await page.getByTestId(TESTID.composerAdd).click();
  await expect(composer).toHaveCount(0);
  const draft = requests(mock, 'POST', /\/drafts$/).at(-1);
  expect(draft.body.kind).toBe('thread');
  expect(draft.body.anchor.file).toEqual({ path: 'src/a.js', side: 'new' });
  expect([draft.body.anchor.src.startLine, draft.body.anchor.src.endLine]).toEqual([3, 4]);
  // the draft shows inline under its last line
  const saved = mock.doc(DOC).drafts.items.at(-1);
  await expect(card(page, 'src/a.js').locator(`[data-inline-id="${saved.id}"]`)).toContainText('Explain the discount');

  // old side: the removed lines of the base
  await lineBtn(page, 'src/a.js', 'old', 5).click();
  await lineBtn(page, 'src/a.js', 'old', 6).click({ modifiers: ['Shift'] });
  await expect(page.locator('.code-selbar')).toContainText('src/a.js (old side) L5-6');
  await page.locator('.code-selbar').getByRole('button', { name: 'Comment' }).click();
  await expect(composer).toContainText('Agent will see: src/a.js (old side) L5-6');
  expect(requests(mock, 'POST', '/anchors/resolve').at(-1).body.capture).toEqual({ kind: 'line', file: 'src/a.js', side: 'old', startLine: 5, endLine: 6 });
  await page.getByTestId(TESTID.composerTextarea).fill('Keep the old signature as a wrapper.');
  await page.getByTestId(TESTID.composerAdd).click();
  await expect(composer).toHaveCount(0);
  expect(requests(mock, 'POST', /\/drafts$/).at(-1).body.anchor.file).toEqual({ path: 'src/a.js', side: 'old' });

  // submitting the review turns both drafts into threads on their sides
  await page.getByTestId(TESTID.submitReviewOpen).click();
  await page.getByTestId(TESTID.submitConfirm).click();
  await expect(page.getByTestId(TESTID.submitReviewDialog)).toHaveCount(0);
  const threads = mock.doc(DOC).threads.slice(-2);
  expect(threads.map((/** @type {any} */ t) => t.anchors['2'].file.side)).toEqual(['new', 'old']);
  await expect(card(page, 'src/a.js').locator(`[data-inline-id="${threads[1].id}"]`)).toContainText('Keep the old signature');
  // gutter markers keyed file:side:line
  await expect(card(page, 'src/a.js').locator('[data-marker="src/a.js:old:5"]')).toHaveCount(1);
  await expect(card(page, 'src/a.js').locator('[data-marker="src/a.js:new:3"]')).toHaveCount(1);
  expect(ui.errors).toEqual([]);
});

test('threads show inline on both sides; a click in the panel scrolls to them, opening collapsed lines', async ({ page, ui, mock }) => {
  // a thread on a line between the two hunks of src/a.js (hidden until expanded)
  const d = mock.doc(DOC);
  const gapDraft = d.saveDraft({ kind: 'thread', type: 'comment', severity: 'normal', version: 2, body: 'Filler should go.', capture: { kind: 'line', file: 'src/a.js', side: 'new', startLine: 20, endLine: 20 } });
  d.submitReview({ verdict: 'comment', draftIds: [gapDraft.id] });
  const gapThread = d.threads.at(-1).id;
  await openReview(ui);
  // t1 on the new side, t2 on the old side (the removed guard), t4 on the whole binary file
  await expect(card(page, 'src/a.js').locator('[data-inline-id="t1"]')).toContainText('Clamp the discount');
  await expect(card(page, 'src/a.js').locator('[data-inline-id="t2"]')).toContainText('Why remove the negative-rate guard?');
  await expect(card(page, 'src/a.js').locator('[data-marker="src/a.js:old:13"]')).toHaveCount(1);
  await expect(card(page, 'assets/logo.png').locator('[data-inline-id="t4"]')).toContainText('Is this the final logo?');
  // the thread in the gap is listed at the top of the card until its line is shown
  await expect(card(page, 'src/a.js').locator('.cd-outside')).toContainText('Filler should go.');

  // clicking its panel card expands the gap and scrolls to it inline
  await ui.card(gapThread).click();
  const inline = card(page, 'src/a.js').locator(`.cd-inline [data-inline-id="${gapThread}"]`);
  await expect(inline).toBeVisible();
  await expect(inline).toBeInViewport();
  await expect(inline).toHaveClass(/is-focused/);
  await expect(card(page, 'src/a.js').locator('.cd-outside')).toHaveCount(0);
  await expect(lineBtn(page, 'src/a.js', 'new', 20)).toBeVisible();
  expect(requests(mock, 'GET', 'files/source?path=src%2Fa.js&v=2&side=new')).toHaveLength(1);

  // and t3 (another file) the same way
  await ui.card('t3').click();
  await expect(card(page, 'src/util/strings.js').locator('[data-inline-id="t3"]')).toBeInViewport();
  // the inline Reply focuses the panel card's reply box
  await card(page, 'src/util/strings.js').locator('[data-inline-id="t3"]').getByRole('button', { name: 'Reply' }).click();
  await expect(ui.card('t3').getByTestId(TESTID.replyTextarea)).toBeVisible();
  expect(ui.errors).toEqual([]);
});

test('a suggestion on new-side lines is prefilled from files/source; the old side cannot suggest', async ({ page, ui, mock }) => {
  await openReview(ui);
  const line5 = A_V2.split('\n')[4];
  await lineBtn(page, 'src/a.js', 'new', 5).click();
  await page.keyboard.press('s');
  const box = page.getByTestId(TESTID.composerSuggestion);
  await expect(box).toHaveValue(line5);
  expect(requests(mock, 'GET', 'files/source?path=src%2Fa.js&v=2&side=new').length).toBeGreaterThan(0);
  expect(requests(mock, 'GET', '/source?v=')).toHaveLength(0);
  await box.fill('export function total(items, discount = 0, coupon = null) {');
  await page.getByTestId(TESTID.composerTextarea).fill('Room for coupons.');
  await page.getByTestId(TESTID.composerAdd).click();
  await expect(page.getByTestId(TESTID.composer)).toHaveCount(0);
  const d = mock.doc(DOC).drafts.items.at(-1);
  expect(d.type).toBe('suggestion');
  expect(d.suggestion).toMatchObject({ mode: 'lines', file: 'src/a.js', startLine: 5, endLine: 5, old: line5, new: 'export function total(items, discount = 0, coupon = null) {' });
  await expect(card(page, 'src/a.js').locator(`[data-inline-id="${d.id}"] .cd-sug-ins`)).toContainText('coupon = null');

  // old side: Suggest is off, and s says why
  await lineBtn(page, 'src/a.js', 'old', 5).click();
  await expect(page.locator('.code-selbar').getByRole('button', { name: 'Suggest' })).toBeDisabled();
  await page.keyboard.press('s');
  await expect(page.getByTestId(TESTID.toast).last()).toContainText('Suggestions replace lines of the new side');
  await expect(page.getByTestId(TESTID.composer)).toHaveCount(0);
  expect(ui.errors).toEqual([]);
});

test('Changes shows the interdiff per file with thread chips; n / p and the side list follow the hunks', async ({ page, ui, mock }) => {
  await openReview(ui, 'changes');
  // only the files that changed between v1 and v2
  await expect(page.getByTestId(CODE_TESTID.fileDiff)).toHaveCount(2);
  await expect(page.getByTestId(CODE_TESTID.fileRow)).toHaveCount(2);
  await expect(treeRow(page, 'src/b.js').locator('.cd-status')).toHaveText('A');
  expect(requests(mock, 'GET', 'files?from=1&to=2').length).toBeGreaterThan(0);
  expect(requests(mock, 'GET', 'files/diff?path=src%2Fa.js&from=1&to=2').length).toBeGreaterThan(0);
  // the interdiff of src/a.js: the clamped discount, with t1's chip on the hunk header
  const a = card(page, 'src/a.js');
  await expect(a.locator('tr.op-del td.code')).toContainText('let sum = -discount;');
  await expect(a.locator('tr.op-ins td.code')).toContainText('Math.max(0, Math.min(discount, 100))');
  await expect(a.locator('.cd-hunk-row .chip-btn')).toHaveText(['t1']);
  // only the new round's lines are selectable
  await expect(a.locator(`[data-testid="${CODE_TESTID.lineBtn}"][data-side="old"]`)).toHaveCount(0);
  await expect(lineBtn(page, 'src/a.js', 'new', 6)).toBeVisible();

  // the side list: changes by file with chips and Round results
  const items = page.getByTestId(TESTID.changeItem);
  await expect(items).toHaveCount(2);
  await expect(items.first()).toHaveAttribute('data-hunk-id', 'src/a.js#h1');
  await expect(items.first().locator('.chip-btn')).toHaveText('t1');
  await expect(page.locator('.round-results')).toContainText('The discount is now clamped');

  // n goes to the next hunk (b.js), p back; the centre follows
  await page.keyboard.press('n');
  await expect(a.locator('.cd-hunk-row.active')).toHaveCount(1);
  await page.keyboard.press('n');
  await expect(card(page, 'src/b.js').locator('.cd-hunk-row.active')).toHaveCount(1);
  await expect(card(page, 'src/b.js').locator('.cd-hunk-row.active')).toBeInViewport();
  await page.keyboard.press('p');
  await expect(a.locator('.cd-hunk-row.active')).toHaveCount(1);
  // a click in the side list too
  await items.last().locator('.change-main').click();
  await expect(card(page, 'src/b.js').locator('.cd-hunk-row.active')).toHaveCount(1);

  // a hunk chip opens the thread in the panel
  await a.locator('.cd-hunk-row .chip-btn', { hasText: 't1' }).click();
  await expect(ui.card('t1')).toBeVisible();
  await expect(ui.card('t1')).toHaveAttribute('aria-current', 'true');
  expect(ui.errors).toEqual([]);
});

test('Verify: an addressed code thread shows its mini-diff, and Accept resolves it', async ({ page, ui, mock }) => {
  await openReview(ui, 'changes');
  await page.getByRole('tablist', { name: 'Side panel' }).getByRole('tab', { name: 'Threads' }).click();
  await page.locator('[data-filter="verify"]').click();
  const t1 = ui.card('t1');
  await expect(t1).toBeVisible();
  await expect(ui.card('t2')).toBeVisible();
  await t1.locator('summary', { hasText: 'Show change' }).click();
  await expect(t1.locator('.minidiff')).toContainText('Math.max(0, Math.min(');
  expect(requests(mock, 'GET', '/threads/t1/minidiff')).toHaveLength(1);
  // "View in Changes" goes to the linked hunk
  await t1.getByRole('button', { name: 'View in Changes' }).click();
  await expect(card(page, 'src/a.js').locator('.cd-hunk-row.active')).toHaveCount(1);
  await page.getByRole('tablist', { name: 'Side panel' }).getByRole('tab', { name: 'Threads' }).click();
  await page.locator('[data-filter="verify"]').click();
  await ui.card('t1').getByTestId(TESTID.verifyAccept).click();
  await expect.poll(() => mock.doc(DOC).thread('t1').status).toBe('resolved');
  expect(requests(mock, 'POST', '/threads/t1/resolve')).toHaveLength(1);
  // Round results in the Changes list accept too
  await page.getByRole('tablist', { name: 'Side panel' }).getByRole('tab', { name: 'Changes' }).click();
  await page.locator('.round-results [data-thread-id="t2"]').getByTestId(TESTID.verifyAccept).click();
  await expect.poll(() => mock.doc(DOC).thread('t2').status).toBe('resolved');
  expect(ui.errors).toEqual([]);
});

test('Re-snapshot: changed files show a banner; Re-snapshot posts D/record and shows the new round', async ({ page, ui, mock }) => {
  await openReview(ui);
  await expect(page.getByTestId(CODE_TESTID.resnapshot)).toHaveCount(0);
  const d = mock.doc(DOC);
  d.setWorking({ 'src/a.js': `${A_V2}export const extra = 1;\n`, 'src/c.js': 'export const c = 1;\n' });
  const banner = page.locator('[data-code-dirty]');
  await expect(banner).toContainText('Files changed since v2');
  await expect(banner).toContainText('src/a.js, src/c.js');
  await page.getByTestId(CODE_TESTID.resnapshot).click();
  await expect(page.getByTestId(TESTID.toast).last()).toContainText('Recorded as v3');
  expect(requests(mock, 'POST', '/record')).toHaveLength(1);
  expect(d.head).toBe(3);
  await expect(banner).toHaveCount(0);
  // the new round is shown with the new file
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('3');
  await expect(treeRow(page, 'src/c.js')).toBeVisible();
  await expect(page.locator('[data-view="code"][data-ready]')).toBeAttached();
  expect(ui.errors).toEqual([]);
});

test('split and unified layouts; selection works on either side in split', async ({ page, ui }) => {
  await openReview(ui);
  const a = card(page, 'src/a.js');
  await expect(a.locator('table.cd-table')).toHaveClass(/unified/);
  await page.locator('.code-toolbar .seg').getByRole('button', { name: 'Split' }).click();
  await expect(a.locator('table.cd-table')).toHaveClass(/split/);
  // a replaced line pairs old and new in one row
  const row = a.locator('tr.cd-split-row', { has: page.locator('[data-side="old"][data-line="6"]') });
  await expect(row.locator('[data-side="new"]')).toHaveAttribute('data-line', '6');
  await expect(row.locator('td.code').first()).toContainText('let sum = 0;');
  await expect(row.locator('td.code').last()).toContainText('let sum = -Math.max');
  // old-side items on the left, new-side items on the right
  await expect(a.locator('.cd-inline-row td.cd-inline').nth(0).locator('[data-inline-id]')).toHaveCount(0);
  await expect(a.locator('.cd-inline-row td.cd-inline:nth-child(2) [data-inline-id="t1"]')).toHaveCount(1);
  await expect(a.locator('.cd-inline-row td.cd-inline:nth-child(1) [data-inline-id="t2"]')).toHaveCount(1);
  await lineBtn(page, 'src/a.js', 'old', 5).click();
  await lineBtn(page, 'src/a.js', 'old', 6).click({ modifiers: ['Shift'] });
  await expect(a.locator('td.cd-sel')).toHaveCount(4);
  await expect(page.locator('.code-selbar')).toContainText('src/a.js (old side) L5-6');
  // the choice is remembered
  await page.reload();
  await expect(page.locator('[data-view="code"][data-ready]')).toBeAttached();
  await expect(card(page, 'src/a.js').locator('table.cd-table')).toHaveClass(/split/);
  await page.locator('.code-toolbar .seg').getByRole('button', { name: 'Unified' }).click();
  await expect(card(page, 'src/a.js').locator('table.cd-table')).toHaveClass(/unified/);
  expect(ui.errors).toEqual([]);
});

test('"Comment on file" on the binary file captures the whole file', async ({ page, ui, mock }) => {
  await openReview(ui);
  await card(page, 'assets/logo.png').getByRole('button', { name: 'Comment on file' }).click();
  await expect(page.getByTestId(TESTID.composer)).toContainText('Agent will see: assets/logo.png (whole file)');
  expect(requests(mock, 'POST', '/anchors/resolve').at(-1).body.capture).toEqual({ kind: 'file', file: 'assets/logo.png' });
  // a whole-file comment has no suggestion
  await expect(page.getByTestId(TESTID.composer).getByRole('radio', { name: 'Suggestion' })).toBeDisabled();
  await page.getByTestId(TESTID.composerTextarea).fill('Use the SVG instead.');
  await page.getByTestId(TESTID.composerAdd).click();
  const d = mock.doc(DOC).drafts.items.at(-1);
  expect(d.anchor).toMatchObject({ kind: 'doc', file: { path: 'assets/logo.png' } });
  await expect(card(page, 'assets/logo.png').locator(`[data-inline-id="${d.id}"]`)).toContainText('Use the SVG instead.');
  expect(ui.errors).toEqual([]);
});

test('pick, snip and hide are absent, and there is no Source mode', async ({ page, ui }) => {
  await openReview(ui);
  await expect(page.getByTestId(TESTID.pickTool)).toHaveCount(0);
  await expect(page.getByTestId(TESTID.snipTool)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Hide annotations' })).toHaveCount(0);
  await expect(page.getByTestId(TESTID.docFrame)).toHaveCount(0);
  await expect(modeTab(page, 'source')).toHaveCount(0);
  await expect(modeTab(page, 'review')).toHaveText(/Files/);
  // History hides the code view
  await modeTab(page, 'history').click();
  await expect(page.getByTestId(CODE_TESTID.view)).toBeHidden();
  await modeTab(page, 'review').click();
  await expect(page.getByTestId(CODE_TESTID.view)).toBeVisible();
  expect(ui.errors).toEqual([]);
});

test('"Show all" renders a diff past the first 3000 rows', async ({ page, ui }) => {
  await openReview(ui);
  await treeRow(page, 'vendor/generated.js').click();
  const g = card(page, 'vendor/generated.js');
  await expect(g.locator('.cd-capped')).toContainText(`${GENERATED_LINES - 3000} more lines not shown.`);
  await expect(lineBtn(page, 'vendor/generated.js', 'new', 3000)).toHaveCount(1);
  await expect(lineBtn(page, 'vendor/generated.js', 'new', 3001)).toHaveCount(0);
  await g.getByRole('button', { name: 'Show all' }).click();
  await expect(lineBtn(page, 'vendor/generated.js', 'new', GENERATED_LINES)).toHaveCount(1);
  await expect(g.locator('.cd-capped')).toHaveCount(0);
  expect(ui.errors).toEqual([]);
});

test('a file picked in the tree stays highlighted while its card shows; scrolling it away moves the highlight on', async ({ page, ui }) => {
  await openReview(ui);
  const order = await page.getByTestId(CODE_TESTID.fileDiff).evaluateAll((els) => els.map((e) => /** @type {HTMLElement} */ (e).dataset.path));
  const last = order[order.length - 1];
  await treeRow(page, last).click();
  await expect(card(page, last)).toBeInViewport();
  await expect(treeRow(page, last)).toHaveAttribute('aria-current', 'true');
  // cards loading around it must not take the highlight; scrolling it out of view by hand does
  await page.waitForTimeout(300);
  await expect(treeRow(page, last)).toHaveAttribute('aria-current', 'true');
  await page.locator('.code-view').evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(treeRow(page, order[0])).toHaveAttribute('aria-current', 'true');
  await expect(treeRow(page, last)).not.toHaveAttribute('aria-current', 'true');
  expect(ui.errors).toEqual([]);
});

test('keys: j / k move between files, n / p between hunks, c comments the selection, Esc clears it', async ({ page, ui }) => {
  await openReview(ui);
  const top = async () => page.locator('.code-file').evaluateAll((els) => {
    const root = /** @type {HTMLElement} */ (document.querySelector('.code-view'));
    const y = root.getBoundingClientRect().top + 60;
    const hit = els.filter((e) => e.getBoundingClientRect().top <= y).pop();
    return hit ? /** @type {HTMLElement} */ (hit).dataset.path : null;
  });
  const order = await page.getByTestId(CODE_TESTID.fileDiff).evaluateAll((els) => els.map((e) => /** @type {HTMLElement} */ (e).dataset.path));
  await page.keyboard.press('j');
  await expect.poll(top).toBe(order[1]);
  await page.keyboard.press('j');
  await expect.poll(top).toBe(order[2]);
  await page.keyboard.press('k');
  await expect.poll(top).toBe(order[1]);
  await expect(treeRow(page, order[1])).toHaveAttribute('aria-current', 'true');

  // n / p: hunk headers, across files
  await treeRow(page, 'src/a.js').click();
  await expect.poll(top).toBe('src/a.js');
  const hunkTop = async () => page.locator('.cd-hunk-row').evaluateAll((els) => {
    const root = /** @type {HTMLElement} */ (document.querySelector('.code-view'));
    const y = root.getBoundingClientRect().top + 140;
    const hit = els.filter((e) => e.getBoundingClientRect().top <= y).pop();
    return hit ? `${/** @type {HTMLElement} */ (hit.closest('.code-file')).dataset.path}|${/** @type {HTMLElement} */ (hit).dataset.hunkId}` : null;
  });
  await page.keyboard.press('n');
  await expect.poll(hunkTop).toBe('src/a.js|src/a.js#h1');
  await page.keyboard.press('n');
  await expect.poll(hunkTop).toBe('src/a.js|src/a.js#h3');
  await page.keyboard.press('p');
  await expect.poll(hunkTop).toBe('src/a.js|src/a.js#h1');

  // c with a selection opens the composer; without one it says how
  await page.keyboard.press('c');
  await expect(page.getByTestId(TESTID.toast).last()).toContainText('Click a line number');
  await lineBtn(page, 'src/a.js', 'new', 8).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.code-selbar')).not.toContainText('src/a.js:L8');
  await lineBtn(page, 'src/a.js', 'new', 8).click();
  await page.keyboard.press('c');
  await expect(page.getByTestId(TESTID.composer)).toContainText('Agent will see: src/a.js:L8');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(TESTID.composer)).toHaveCount(0);

  // the shortcuts overlay names what j / k do here
  await page.keyboard.press('?');
  const help = page.getByTestId(TESTID.helpOverlay);
  await expect(help.locator('[data-key-row="threads"]')).toContainText('Next / previous file');
  expect(ui.errors).toEqual([]);
});

test('narrow window: the file tree is a drawer, the diff is unified and nothing scrolls sideways', async ({ page, ui }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await openReview(ui);
  await expect(page.getByTestId(CODE_TESTID.fileTree)).toBeHidden();
  await expect(page.locator('.code-toolbar .seg').getByRole('button', { name: 'Split' })).toBeDisabled();
  await page.locator('.code-toolbar').getByRole('button', { name: 'Show the file tree' }).click();
  await expect(page.getByTestId(CODE_TESTID.fileTree)).toBeVisible();
  await treeRow(page, 'src/new-name.js').click();
  await expect(page.getByTestId(CODE_TESTID.fileTree)).toBeHidden();
  await expect(card(page, 'src/new-name.js')).toBeInViewport();
  const overflow = await page.evaluate(() => {
    const view = /** @type {HTMLElement} */ (document.querySelector('.code-view'));
    return { doc: document.documentElement.scrollWidth - window.innerWidth, view: view.scrollWidth - view.clientWidth };
  });
  expect(overflow.doc).toBeLessThanOrEqual(0);
  expect(overflow.view).toBeLessThanOrEqual(0);
  // lines can still be selected and commented
  await lineBtn(page, 'src/new-name.js', 'new', 5).click();
  await page.locator('.code-selbar').getByRole('button', { name: 'Comment' }).click();
  await expect(page.getByTestId(TESTID.composer)).toContainText('Agent will see: src/new-name.js:L5');
  expect(ui.errors).toEqual([]);
});

test('light and dark themes use the tokens', async ({ page, ui }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openReview(ui);
  const colors = () => page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    const a = /** @type {HTMLElement} */ (document.querySelector('.code-file[data-path="src/a.js"]'));
    const ins = /** @type {HTMLElement} */ (a.querySelector('tr.op-ins td.code'));
    const head = /** @type {HTMLElement} */ (a.querySelector('.code-file-head'));
    const probe = document.createElement('div');
    document.body.append(probe);
    /** @param {string} v */
    const resolve = (v) => {
      probe.style.backgroundColor = css.getPropertyValue(v).trim();
      return getComputedStyle(probe).backgroundColor;
    };
    const out = {
      card: getComputedStyle(a).backgroundColor, bg: resolve('--bg'),
      ins: getComputedStyle(ins).backgroundColor, insBg: resolve('--ins-bg'),
      head: getComputedStyle(head).backgroundColor, header: resolve('--header'),
      text: getComputedStyle(ins).color,
    };
    probe.remove();
    return out;
  });
  const light = await colors();
  expect(light.card).toBe(light.bg);
  expect(light.card).toBe('rgb(255, 255, 255)');
  expect(light.ins).toBe(light.insBg);
  expect(light.head).toBe(light.header);
  await page.emulateMedia({ colorScheme: 'dark' });
  const dark = await colors();
  expect(dark.card).toBe(dark.bg);
  expect(dark.card).toBe('rgb(13, 17, 23)');
  expect(dark.ins).toBe(dark.insBg);
  expect(dark.head).toBe(dark.header);
  expect(dark.ins).not.toBe(light.ins);
  expect(dark.text).not.toBe(light.text);
  expect(ui.errors).toEqual([]);
});
