// @ts-check
// Room to write a comment, and formatting it:
//   the side panel's width: dragged (also across the doc iframe), arrow keys, double-click for the default, remembered
//   in the browser; the doc keeps its minimum;
//   the comment box: the toolbar and its keys in the composer, the reply box and the Submit dialog, lists that continue
//   on Enter, undo, the box growing with the text, what the card shows.
// md-edit.test.mjs has the text edits themselves.

import { TESTID } from '../../src/shared/protocol.js';
import { expect, test } from './fixtures.mjs';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** @param {import('@playwright/test').Page} page */
const resizer = (page) => page.getByRole('separator', { name: 'Resize the review panel' });

/** @param {import('@playwright/test').Page} page */
const panelWidth = async (page) => /** @type {{ width: number }} */ (await page.locator('#sr-side').boundingBox()).width;

/** @param {import('@playwright/test').Page} page */
const docWidth = async (page) => /** @type {{ width: number }} */ (await page.getByTestId(TESTID.docFrame).boundingBox()).width;

/** Drags the panel's handle this far (negative: to the left, over the doc iframe). @param {import('@playwright/test').Page} page @param {number} dx */
async function dragBy(page, dx) {
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await resizer(page).boundingBox());
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 6 });
  await page.mouse.up();
}

/** @param {import('@playwright/test').Page} page */
async function openGeneralComment(page) {
  await page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="review"]`).click();
  await page.getByRole('button', { name: 'General comment' }).click();
  const ta = page.getByTestId(TESTID.composerTextarea);
  await expect(ta).toBeFocused();
  return ta;
}

test.describe('the side panel width', () => {
  test('the handle drags it over the doc iframe, it is remembered, and a double-click goes back', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    const before = await panelWidth(page);
    const doc = await docWidth(page);
    expect(before).toBe(384);

    await dragBy(page, -200);
    expect(await panelWidth(page)).toBe(584);
    expect(await docWidth(page)).toBe(doc - 200);
    await expect(page.locator('html.is-resizing-panel')).toHaveCount(0);

    await page.reload();
    await ui.ready();
    expect(await panelWidth(page)).toBe(584);

    await resizer(page).dblclick();
    expect(await panelWidth(page)).toBe(384);
    await page.reload();
    await ui.ready();
    expect(await panelWidth(page)).toBe(384);
    expect(ui.errors).toEqual([]);
  });

  test('a drag leaves the focus in the comment box, ready to go on typing', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    const ta = await openGeneralComment(page);
    await page.keyboard.type('Before');
    await dragBy(page, -100);
    await expect(ta).toBeFocused();
    await page.keyboard.type(' and after');
    await expect(ta).toHaveValue('Before and after');
    expect(ui.errors).toEqual([]);
  });

  test('the doc keeps its minimum, also when the window gets smaller, and the panel its own', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await dragBy(page, -1000);
    expect(await docWidth(page)).toBe(360);
    const wide = await panelWidth(page);
    expect(wide).toBe(800);

    // Between 900 and 1199 px: the panel gives way, and comes back with the room.
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect.poll(() => docWidth(page)).toBe(360);
    expect(await panelWidth(page)).toBe(640);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect.poll(() => panelWidth(page)).toBe(wide);

    await dragBy(page, 1000);
    expect(await panelWidth(page)).toBe(280);
    expect(ui.errors).toEqual([]);
  });

  test('arrow keys move the handle, which says the width to assistive technology', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    const handle = resizer(page);
    await handle.focus();
    await expect(handle).toHaveAttribute('aria-valuenow', '384');
    await page.keyboard.press('ArrowLeft');
    expect(await panelWidth(page)).toBe(416);
    await expect(handle).toHaveAttribute('aria-valuenow', '416');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(await panelWidth(page)).toBe(352);
    await expect(handle).toHaveAttribute('aria-valuemin', '280');
    await expect(handle).toHaveAttribute('aria-valuemax', '800');
    expect(ui.errors).toEqual([]);
  });

  test('between 900 and 1199 px it starts at that layout\'s width and resizes too', async ({ page, ui }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await ui.open('kitchen-sink');
    expect(await panelWidth(page)).toBe(312);
    await resizer(page).focus();
    await page.keyboard.press('ArrowLeft');
    expect(await panelWidth(page)).toBe(344);
    expect(ui.errors).toEqual([]);
  });

  test('the handle goes away with the panel', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await expect(resizer(page)).toBeVisible();
    await page.keyboard.press('\\');
    await expect(page.locator('#sr-side')).toBeHidden();
    await expect(resizer(page)).toBeHidden();
    expect(ui.errors).toEqual([]);
  });

  test.describe('below 900 px', () => {
    test.use({ viewport: { width: 700, height: 860 } });

    test('the drawer has no handle, and no width from a wider layout', async ({ page, ui }) => {
      await ui.open('kitchen-sink');
      await page.evaluate(() => localStorage.setItem('suiko.panelWidth', '600'));
      await page.reload();
      await ui.ready();
      await page.keyboard.press('\\');
      await expect(page.locator('#sr-side')).toBeVisible();
      await expect(resizer(page)).toHaveCount(0);
      await expect.poll(() => panelWidth(page)).toBe(440);
      expect(ui.errors).toEqual([]);
    });
  });
});

test.describe('the comment box', () => {
  test('the toolbar formats the text, keeps the focus there, and the card shows the result', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    const ta = await openGeneralComment(page);
    const composer = page.getByTestId(TESTID.composer);
    const tools = composer.getByRole('toolbar', { name: 'Formatting' });

    await page.keyboard.type('Before shipping:');
    await page.keyboard.press('Enter');
    await tools.getByRole('button', { name: 'Numbered list' }).click();
    await expect(ta).toBeFocused();
    await page.keyboard.type('Rotate tokens');
    await page.keyboard.press('Enter');
    await tools.getByRole('button', { name: 'Bold' }).click();
    await page.keyboard.type('Blocking:');
    await tools.getByRole('button', { name: 'Bold' }).click();
    await page.keyboard.type(' name the owner');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Also:');
    await page.keyboard.press('Enter');
    await tools.getByRole('button', { name: 'Bulleted list' }).click();
    await page.keyboard.type('sessions');
    await page.keyboard.press('Enter');
    await page.keyboard.type('the gateway');
    const body = 'Before shipping:\n1. Rotate tokens\n2. **Blocking:** name the owner\n\nAlso:\n- sessions\n- the gateway';
    await expect(ta).toHaveValue(body);

    await page.getByTestId(TESTID.composerAdd).click();
    await expect(composer).toBeHidden();
    const card = page.locator(`[data-testid="${TESTID.threadCard}"][data-draft-id]`);
    await expect(card.locator('.comment-body strong')).toHaveText('Blocking:');
    await expect(card.locator('.comment-body ol li')).toHaveCount(2);
    await expect(card.locator('.comment-body ul li')).toHaveText(['sessions', 'the gateway']);
    // Markers, not just tags: a list style reset would hide them.
    expect(await card.locator('.comment-body ol').evaluate((el) => getComputedStyle(el).listStyleType)).toBe('decimal');
    expect(await card.locator('.comment-body ul').evaluate((el) => getComputedStyle(el).listStyleType)).toBe('disc');
    // What is stored is the text as written.
    expect(mock.doc('kitchen-sink').drafts.items[0].body).toBe(body);
    expect(ui.errors).toEqual([]);
  });

  test('the keys do the same and the selection survives a toolbar click', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    const ta = await openGeneralComment(page);
    await page.keyboard.type('hello world');
    await ta.evaluate((/** @type {HTMLTextAreaElement} */ el) => el.setSelectionRange(0, 5));
    await page.getByRole('button', { name: 'Bold' }).click();
    await expect(ta).toHaveValue('**hello** world');
    expect(await ta.evaluate((/** @type {HTMLTextAreaElement} */ el) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe('hello');
    await page.keyboard.press(`${MOD}+b`);
    await expect(ta).toHaveValue('hello world');

    await page.keyboard.press(`${MOD}+Shift+Digit8`);
    await expect(ta).toHaveValue('- hello world');
    await page.keyboard.press(`${MOD}+Shift+Digit7`);
    await expect(ta).toHaveValue('1. hello world');
    // Add to review stays on its keys.
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(page.getByTestId(TESTID.composer)).toBeHidden();
    expect(ui.errors).toEqual([]);
  });

  test('Shift+Enter is a plain line break inside a list', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    const ta = await openGeneralComment(page);
    await page.keyboard.type('- one');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('more');
    await expect(ta).toHaveValue('- one\nmore');
    expect(ui.errors).toEqual([]);
  });

  test('formatting is one step of the undo history, and the store follows it', async ({ page, ui, mock }) => {
    await ui.open('kitchen-sink');
    const ta = await openGeneralComment(page);
    await page.keyboard.type('word');
    await page.getByRole('button', { name: 'Bulleted list' }).click();
    await expect(ta).toHaveValue('- word');
    await page.evaluate(() => document.execCommand('undo'));
    await expect(ta).toHaveValue('word');
    await page.getByTestId(TESTID.composerAdd).click();
    await expect(page.getByTestId(TESTID.composer)).toBeHidden();
    expect(mock.doc('kitchen-sink').drafts.items[0].body).toBe('word');
    expect(ui.errors).toEqual([]);
  });

  test('the box grows with the text up to its limit, and keeps a height it was dragged to', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    const ta = await openGeneralComment(page);
    const size = () => ta.evaluate((/** @type {HTMLTextAreaElement} */ el) => ({ height: el.offsetHeight, inner: el.clientHeight, content: el.scrollHeight }));
    const start = await size();
    expect(start.height).toBeGreaterThanOrEqual(120);

    await ta.fill(Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n'));
    await expect.poll(async () => (await size()).height).toBeGreaterThan(start.height);
    const grown = await size();
    expect(grown.content).toBeLessThanOrEqual(grown.inner);

    // Past 60% of the 900 px window it scrolls instead.
    await ta.fill(Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n'));
    await expect.poll(async () => (await size()).height).toBe(540);
    const capped = await size();
    expect(capped.content).toBeGreaterThan(capped.inner);

    // A height set by its resize corner holds while typing a little.
    await ta.fill('short');
    await ta.evaluate((/** @type {HTMLTextAreaElement} */ el) => { el.style.height = '300px'; });
    await page.keyboard.type(' text');
    expect((await size()).height).toBe(300);
    expect(ui.errors).toEqual([]);
  });

  test('a long draft opens at its full height for editing', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    const ta = await openGeneralComment(page);
    await ta.fill(Array.from({ length: 14 }, (_, i) => `- item ${i + 1}`).join('\n'));
    await page.getByTestId(TESTID.composerAdd).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    const edit = page.getByTestId(TESTID.composerTextarea);
    await expect(edit).toBeVisible();
    await expect.poll(() => edit.evaluate((/** @type {HTMLTextAreaElement} */ el) => el.scrollHeight <= el.clientHeight)).toBe(true);
    expect(ui.errors).toEqual([]);
  });

  test('a narrower panel makes the box taller for the same text', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    const ta = await openGeneralComment(page);
    await ta.fill('A long sentence that wraps over several lines of the comment box. '.repeat(8));
    await dragBy(page, 80);
    await expect.poll(() => ta.evaluate((/** @type {HTMLTextAreaElement} */ el) => el.scrollHeight <= el.clientHeight)).toBe(true);
    expect(ui.errors).toEqual([]);
  });

  test('the reply box and the Submit dialog have the same tools', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="review"]`).click();
    const card = ui.card('t3');
    await card.getByRole('button', { name: 'Reply', exact: true }).click();
    const reply = page.getByTestId(TESTID.replyTextarea);
    await expect(reply).toBeFocused();
    await card.getByRole('button', { name: 'Bulleted list' }).click();
    await page.keyboard.type('one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    await expect(reply).toHaveValue('- one\n- two');
    // Esc and Cmd+Enter stay with the reply box.
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(reply).toBeHidden();
    await expect(card.locator('.pending-reply li')).toHaveText(['one', 'two']);

    await page.keyboard.press(`${MOD}+Shift+Enter`);
    const dialog = page.getByTestId(TESTID.submitReviewDialog);
    await expect(dialog).toBeVisible();
    const summary = dialog.getByLabel('Summary');
    await expect(summary).toBeFocused();
    await page.keyboard.type('good');
    await dialog.getByRole('button', { name: 'Bold' }).click();
    await expect(summary).toHaveValue('good****');
    await page.keyboard.press(`${MOD}+b`);
    await expect(summary).toHaveValue('good');
    expect(ui.errors).toEqual([]);
  });

  test('the Submit dialog\'s one-line preview of a draft has no Markdown markers', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    const ta = await openGeneralComment(page);
    await ta.fill('**Fix** this:\n- first\n1. second');
    await page.getByTestId(TESTID.composerAdd).click();
    await page.getByTestId(TESTID.submitReviewOpen).click();
    await expect(page.getByTestId(TESTID.submitReviewDialog).locator('.draft-list li')).toContainText('Fix this: first second');
    expect(ui.errors).toEqual([]);
  });

  test('the shortcuts overlay lists the keys', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await page.keyboard.press(`${MOD}+/`);
    const row = page.getByTestId(TESTID.helpOverlay).locator('[data-key-row="format"]');
    await expect(row).toContainText('Bold / bulleted list / numbered list');
    await expect(row.locator('kbd')).toHaveCount(3);
    expect(ui.errors).toEqual([]);
  });
});

test.describe('a code review', () => {
  test.use({ scenario: 'code' });

  test('the panel resizes and the composer has the tools', async ({ page, ui, mock }) => {
    await page.goto(mock.url('cr-feat'));
    await expect(page.locator('[data-view="code"][data-ready]')).toBeAttached({ timeout: 15000 });
    const before = await panelWidth(page);
    await dragBy(page, -150);
    expect(await panelWidth(page)).toBe(before + 150);

    await page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="review"]`).click();
    await page.getByRole('button', { name: 'General comment' }).click();
    const ta = page.getByTestId(TESTID.composerTextarea);
    await expect(ta).toBeFocused();
    await page.getByTestId(TESTID.composer).getByRole('button', { name: 'Numbered list' }).click();
    await page.keyboard.type('one');
    await page.keyboard.press('Enter');
    await expect(ta).toHaveValue('1. one\n2. ');
    expect(ui.errors).toEqual([]);
  });
});
