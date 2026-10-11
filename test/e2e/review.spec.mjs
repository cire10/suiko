// @ts-check
// Review flow on a fresh doc (kitchen-sink.md v1, no threads): loading, commenting on selected text (mouse drag
// in the iframe + forwarded key), suggestions, picking an image, Send now, and submitting a review with
// "Request changes".

import { expect, test } from './fixtures.mjs';

test.use({ scenario: 'fresh' });

test('loads the doc in Review mode with an empty thread panel', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  await expect(page.getByTestId('doc-frame')).toBeVisible();
  await expect(page.locator('[data-testid="mode-tab"][data-mode="review"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('version-picker')).toHaveValue('1');
  await expect(page.getByTestId('thread-panel')).toContainText('No threads yet');
  await expect(page.getByTestId('presence')).toHaveText(/No agent listening/);
  await expect(page.locator('.outline-link')).toHaveCount(7);
  await expect(page).toHaveTitle(/Token Service Implementation Spec/);
  const g = await ui.inspect();
  expect(g.mode).toBe('review');
  expect(ui.errors).toEqual([]);
});

test('select text in the iframe -> composer with anchor preview -> Add to review -> draft listed', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  const r = await ui.pointIn('[data-srid]:is(p)', 'rotated on every use');
  await page.mouse.move(r.x + 1, r.cy);
  await page.mouse.down();
  await page.mouse.move(r.x + r.w / 2, r.cy, { steps: 4 });
  await page.mouse.move(r.x + r.w - 1, r.cy, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('[data-selection-comment]')).toBeEnabled();
  // The focus is inside the doc iframe: the guest forwards the key to the UI.
  await page.keyboard.press('c');
  const composer = page.getByTestId('composer');
  await expect(composer).toBeVisible();
  await expect(composer.locator('.agent-sees')).toContainText('Agent will see: L51');
  await expect(composer.locator('.agent-sees')).toContainText('rotated on every use');
  await expect(page.getByTestId('composer-textarea')).toBeFocused();
  await page.getByTestId('composer-textarea').fill('Rotation on **every** use breaks concurrent clients.');
  await composer.getByRole('radio', { name: 'Blocking' }).click();
  await page.getByTestId('composer-add').click();

  await expect(composer).toBeHidden();
  const draft = page.locator('[data-testid="thread-card"][data-draft-id]');
  await expect(draft).toHaveCount(1);
  await expect(draft).toContainText('Rotation on every use breaks concurrent clients.');
  await expect(draft.locator('strong')).toHaveText('every');
  await expect(page.locator('.drafts-count')).toContainText('1');
  const items = mock.doc('kitchen-sink').drafts.items;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: 'thread', type: 'comment', severity: 'blocking', version: 1 });
  expect(items[0].anchor.src.text).toBe('rotated on every use');
  expect(items[0].anchor.src.startLine).toBe(51);
  // The guest paints the draft.
  await expect.poll(async () => (await ui.inspect()).highlights['sr-draft'] || 0).toBeGreaterThan(0);
  expect(ui.errors).toEqual([]);
});

test('suggestion in text mode with a live word diff', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await ui.selectText('Ship rotation behind a flag.');
  await page.keyboard.press('s');
  const input = page.getByTestId('composer-suggestion');
  await expect(input).toHaveValue('Ship rotation behind a flag.');
  await input.fill('Ship rotation behind the token-rotation flag.');
  await expect(page.locator('.live-diff')).toContainText('token-rotation');
  await expect(page.locator('.live-diff ins').last()).toContainText('token-rotation');
  await expect(page.locator('.live-diff del')).toHaveText(['a']);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByTestId('composer')).toBeHidden();
  const [item] = mock.doc('kitchen-sink').drafts.items;
  expect(item.type).toBe('suggestion');
  expect(item.suggestion).toMatchObject({ mode: 'text', old: 'Ship rotation behind a flag.', new: 'Ship rotation behind the token-rotation flag.', startLine: 24 });
  await expect(page.locator('[data-testid="thread-card"][data-draft-id] .worddiff ins').last()).toContainText('token-rotation');
});

test('pick an image -> element comment', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  const tool = page.getByTestId('pick-tool');
  await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await ui.inspect()).picker?.active ?? (await ui.inspect()).picker).toBeTruthy();
  const img = await ui.pointIn('img');
  await page.mouse.move(img.cx - 10, img.cy - 10);
  await page.mouse.move(img.cx, img.cy, { steps: 3 });
  await page.mouse.click(img.cx, img.cy);
  const composer = page.getByTestId('composer');
  await expect(composer).toBeVisible();
  await expect(composer.locator('.agent-sees')).toContainText('System overview');
  await expect(tool).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('composer-textarea').fill('Label the arrows.');
  await page.getByTestId('composer-add').click();
  await expect(page.locator('[data-testid="thread-card"][data-draft-id]')).toContainText('System overview');
  const [item] = mock.doc('kitchen-sink').drafts.items;
  expect(item.anchor.kind).toBe('element');
  expect(item.anchor.element.tag).toBe('img');
});

test('Send now submits a one-item review with verdict comment', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await ui.selectText('Remove the legacy session store.');
  await page.locator('[data-selection-comment]').click();
  await page.getByTestId('composer-textarea').fill('When?');
  await page.getByTestId('composer-send-now').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Sent to the agent' })).toBeVisible();
  const d = mock.doc('kitchen-sink');
  expect(d.reviews).toHaveLength(1);
  expect(d.reviews[0]).toMatchObject({ verdict: 'comment', newThreads: ['t1'] });
  expect(d.drafts.items).toHaveLength(0);
  await expect(ui.card('t1')).toBeVisible();
  await expect(ui.card('t1')).toContainText('When?');
});

test('submit review with Request changes', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await ui.selectText('Prototype the issuer.');
  await page.keyboard.press('q');
  await expect(page.getByTestId('composer')).toBeVisible();
  await expect(page.getByTestId('composer').getByRole('radio', { name: 'Question' })).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('composer-textarea').fill('Which language?');
  await page.getByTestId('composer-add').click();
  await expect(page.locator('[data-testid="thread-card"][data-draft-id]')).toHaveCount(1);

  await page.getByTestId('submit-review-open').click();
  const dialog = page.getByTestId('submit-review-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('No agent is listening');
  await expect(dialog).toContainText('Which language?');
  await expect(dialog.getByRole('button', { name: 'Copy prompt' })).toBeVisible();
  await dialog.locator('[data-testid="submit-verdict"] input[value="changes_requested"]').check();
  await dialog.getByLabel('Summary').fill('Please answer before we continue.');
  await page.getByTestId('submit-confirm').click();

  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('toast').filter({ hasText: 'Changes requested (rv1)' })).toBeVisible();
  const d = mock.doc('kitchen-sink');
  expect(d.reviews[0]).toMatchObject({ id: 'rv1', verdict: 'changes_requested', body: 'Please answer before we continue.', newThreads: ['t1'] });
  expect(d.drafts.items).toHaveLength(0);
  await expect(ui.card('t1')).toContainText('Which language?');
  await expect(page.locator('.drafts-count')).toContainText('0');
  await expect(page.locator('.review-progress')).toContainText('Submitted');

  // Delivery (a background `wait` picking the review up) moves the chip and the presence along.
  d.deliver('rv1', 'claude');
  await expect(page.locator('.review-progress')).toContainText('Delivered to claude');
  await expect(page.getByTestId('presence')).toHaveText(/claude is revising/);
});

test('approve with the final options', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await page.keyboard.press('f');
  const dialog = page.getByTestId('submit-review-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('submit-confirm')).toBeDisabled();
  await dialog.locator('input[value="approved"]').check();
  await expect(dialog.getByLabel('Mark v1 final')).toBeChecked();
  await page.getByTestId('submit-confirm').click();
  await expect(page.locator('.banner-ok')).toContainText('Approved at v1');
  expect(mock.doc('kitchen-sink').doc.final).toMatchObject({ version: 1 });
  await expect(page.locator('.statusbar')).toContainText('FINAL: v1');
});

test('pasting an image into the comment attaches it', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await page.getByRole('button', { name: 'General comment' }).click();
  const ta = page.getByTestId('composer-textarea');
  await expect(ta).toBeFocused();
  await expect(page.getByTestId('composer').locator('.agent-sees')).toContainText('GENERAL');
  // A paste event carrying a PNG file (what the browser produces for a pasted screenshot).
  await ta.evaluate(async (el) => {
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 20;
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    ctx.fillStyle = '#c33';
    ctx.fillRect(0, 0, 40, 20);
    const blob = /** @type {Blob} */ (await new Promise((ok) => canvas.toBlob(ok, 'image/png')));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const list = page.getByTestId('composer').locator('.attach-list li');
  await expect(list).toHaveCount(1);
  await expect(list).toContainText('a1.png');
  await expect(list.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await ta.fill('See the screenshot.');
  await page.getByTestId('composer-add').click();
  await expect(page.getByTestId('composer')).toBeHidden();
  const [item] = mock.doc('kitchen-sink').drafts.items;
  expect(item.attachments).toEqual(['attachments/a1.png']);
  expect(item.anchor.kind).toBe('doc');
  await expect(page.locator('[data-testid="thread-card"][data-draft-id]')).toContainText('1 attachment');
});

test('a draft can be edited (autosaved through PATCH) and deleted', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await ui.selectText('Prototype the issuer.');
  await page.locator('[data-selection-comment]').click();
  await page.getByTestId('composer-textarea').fill('First thought.');
  await page.getByTestId('composer-add').click();
  const draft = page.locator('[data-testid="thread-card"][data-draft-id="d1"]');
  await expect(draft).toContainText('First thought.');

  await draft.getByRole('button', { name: 'Edit' }).click();
  const composer = page.getByTestId('composer');
  await expect(composer).toContainText('Edit draft d1');
  await expect(page.getByTestId('composer-send-now')).toHaveCount(0);
  await expect(page.getByTestId('composer-textarea')).toHaveValue('First thought.');
  await page.getByTestId('composer-textarea').fill('Second thought.');
  // Typing in an existing draft autosaves it (debounced) before the explicit save.
  await expect.poll(() => mock.doc('kitchen-sink').drafts.items[0]?.body, { timeout: 5000 }).toBe('Second thought.');
  await composer.getByRole('radio', { name: 'Nit' }).click();
  await page.getByTestId('composer-add').click();
  await expect(composer).toBeHidden();
  await expect(draft).toContainText('Second thought.');
  expect(mock.doc('kitchen-sink').drafts.items).toMatchObject([{ id: 'd1', body: 'Second thought.', severity: 'nit' }]);
  expect(mock.requests.filter((r) => r.method === 'PATCH').length).toBeGreaterThanOrEqual(2);

  await draft.getByRole('button', { name: 'Delete' }).click();
  await expect(draft).toHaveCount(0);
  expect(mock.doc('kitchen-sink').drafts.items).toEqual([]);
  await expect(page.locator('.drafts-count')).toContainText('0');
});
