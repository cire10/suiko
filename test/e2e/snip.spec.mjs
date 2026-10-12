// @ts-check
// Snips and the send-now key (feature: "very simple hot keys to invoke comments, reviews, selecting part of the
// images or screens and giving them to Claude"):
//   - b snips an area of the doc: a box over anything, then a composer with the crop (TESTID.composerAttachment);
//   - Cmd/Ctrl+Shift+Enter in the composer is Send now (this comment alone); outside it, and f, open Submit review;
//     Cmd/Ctrl+Enter still adds to the review;
//   - Shift+B snips anywhere on screen through the daemon's macOS picker (POST .../snip/screen): a hint while it
//     waits, then a composer with the screenshot (a general comment, or on the selection); cancelled / busy /
//     unsupported (the button disappears);
//   - stored screenshots show as thumbnails on drafts / threads (DocState.attachmentBase) and open full size;
//   - `suiko snip` from a terminal: the draft appears with a toast whose [Edit] opens it;
//   - the help overlay groups the keys and lists them.
// Most tests run against the mock daemon (its fake picker is set with mock.setScreenSnip). The UI side of a doc snip
// is also driven directly through the guest bridge, so it is covered independently of the guest's drawing code; the
// last test runs Shift+B end to end against the REAL daemon with a fake `screencapture` (never the real picker).

import path from 'node:path';
import { TESTID } from '../../src/shared/protocol.js';
import { createFakeCapture } from '../fixtures/snip/capture.js';
import { expect, test, Ui } from './fixtures.mjs';
import { makePng } from './mock-data.mjs';
import { startRealDaemon } from './real-daemon.mjs';

/** @typedef {import('@playwright/test').Page} Page */

test.use({ scenario: 'fresh' });

/** Moves keyboard focus into the UI document (not the doc iframe) without pressing a control. @param {Page} page */
async function focusUi(page) {
  await page.evaluate(() => {
    /** @type {HTMLElement|null} */ (document.activeElement)?.blur?.();
    document.body.focus();
  });
}

/** @param {Page} page @param {string|RegExp} text */
const toastWith = (page, text) => page.getByTestId(TESTID.toast).filter({ hasText: text });

/** @param {Page} page @param {string} mode */
const modeTab = (page, mode) => page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="${mode}"]`);

/**
 * Delivers a message to the UI as if the guest had posted it (through the app's own guest bridge module).
 * @param {Page} page @param {string} type @param {Record<string, any>} [payload]
 */
async function fromGuest(page, type, payload = {}) {
  await page.evaluate(async ({ t, p }) => {
    const { guest } = await import(/** @type {any} */ ('/ui/frame.js'));
    guest.onMessage(t, { ...p, sr: 1, type: t });
  }, { t: type, p: payload });
}

/** A small PNG data URL (the crop a snip would carry). */
const CROP = `data:image/png;base64,${makePng(48, 32, (x) => (x < 24 ? [220, 60, 60, 255] : [60, 60, 220, 255])).toString('base64')}`;

/** Natural width of an <img> once it has loaded (0 while loading or broken). @param {import('@playwright/test').Locator} img */
const naturalWidth = (img) => img.evaluate((el) => /** @type {HTMLImageElement} */ (el).naturalWidth);

test('b snips an area of the doc: drag a box, the composer shows the crop, Cmd/Ctrl+Shift+Enter sends just that comment', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  await focusUi(page);
  await page.keyboard.press('b');
  const snipTool = page.getByTestId(TESTID.snipTool);
  await expect(snipTool).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.frame-wrap')).toHaveAttribute('data-tool', 'snip');
  await ui.settle();

  // A box over the architecture image and a bit below it (image + diagram).
  const img = await ui.pointIn('img');
  await page.mouse.move(img.x - 8, img.y - 8);
  await page.mouse.down();
  await page.mouse.move(img.cx, img.cy, { steps: 4 });
  await page.mouse.move(img.x + img.w + 8, img.y + img.h + 40, { steps: 6 });
  await page.mouse.up();

  const composer = page.getByTestId(TESTID.composer);
  await expect(composer).toBeVisible();
  await expect(composer.getByTestId(TESTID.composerAttachment)).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(composer.locator('.agent-sees')).toContainText('L29');
  // One snip per press: back to select.
  await expect(snipTool).toHaveAttribute('aria-pressed', 'false');

  await page.getByTestId(TESTID.composerTextarea).fill('The diagram does not show the token cache.');
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  await expect(toastWith(page, 'Sent to the agent')).toBeVisible();
  await expect(composer).toBeHidden();
  const d = mock.doc('kitchen-sink');
  expect(d.reviews).toHaveLength(1);
  expect(d.reviews[0]).toMatchObject({ verdict: 'comment', newThreads: ['t1'] });
  expect(d.drafts.items).toHaveLength(0);
  expect(d.threads[0].attachments).toEqual(['attachments/a1.png']);
  expect(d.threads[0].anchors['1'].src.startLine).toBeLessThanOrEqual(29);

  // The thread shows the stored crop.
  const thumb = ui.card('t1').locator('.card-attachments img');
  await expect(thumb).toHaveAttribute('src', /\/__att\/a1\.png$/);
  await expect.poll(() => naturalWidth(thumb)).toBeGreaterThan(0);
});

test('the UI side of a doc snip: the guest enters snip mode, its action opens the composer with the crop, Cmd/Ctrl+Enter adds it', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  const f = await ui.frame();
  const capture = await f.evaluate(() => {
    const img = /** @type {Element} */ (document.querySelector('img[data-srid]'));
    const block = /** @type {Element} */ (img.closest('p') || img);
    const next = /** @type {Element} */ (block.nextElementSibling?.closest('[data-srid]') || block.nextElementSibling);
    const sr = (/** @type {Element} */ el) => Number(el.getAttribute('data-srid'));
    return {
      kind: 'snip', srids: [sr(img), sr(next)], startSrid: sr(img), endSrid: sr(next), containerSrid: null,
      region: { x: 0, y: 0.2, w: 1, h: 0.3 }, text: 'Client app API Gateway', label: 'area over "2 Architecture" (image + diagram)',
    };
  });
  // b pressed inside the doc: the guest switches itself to snip and says so.
  await fromGuest(page, 'toolChanged', { tool: 'snip' });
  await expect(page.getByTestId(TESTID.snipTool)).toHaveAttribute('aria-pressed', 'true');
  await fromGuest(page, 'action', { action: 'comment', capture, rect: { x: 10, y: 10, w: 200, h: 120 }, crop: CROP });
  await fromGuest(page, 'toolChanged', { tool: 'select' });

  const composer = page.getByTestId(TESTID.composer);
  await expect(composer.getByTestId(TESTID.composerAttachment)).toHaveAttribute('src', CROP);
  await expect(composer.getByTestId(TESTID.composerAttachment)).toHaveAttribute('alt', /area over "2 Architecture"/);
  await expect(composer.locator('.agent-sees')).toContainText('L29');
  await expect(composer.locator('.agent-sees')).toContainText('snip (2 blocks)');
  await expect(page.getByTestId(TESTID.snipTool)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId(TESTID.composerTextarea)).toBeFocused();

  // The crop opens full size.
  await composer.getByTestId(TESTID.composerAttachment).click();
  await expect(page.getByTestId('lightbox').locator('img')).toHaveAttribute('src', CROP);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('lightbox')).toHaveCount(0);

  // A screenshot speaks for itself: Cmd/Ctrl+Enter adds it to the review without text (no review is sent).
  await page.getByTestId(TESTID.composerTextarea).focus();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(composer).toBeHidden();
  const d = mock.doc('kitchen-sink');
  expect(d.reviews).toHaveLength(0);
  expect(d.drafts.items).toHaveLength(1);
  expect(d.drafts.items[0]).toMatchObject({
    attachments: ['attachments/a1.png'], anchor: { kind: 'snip', snip: { label: 'area over "2 Architecture" (image + diagram)' } },
  });
  // The draft card names the snip, quotes the text inside the box, and shows the uploaded crop.
  const card = page.locator('[data-draft-id="d1"]');
  await expect(card.locator('.target-label')).toHaveText('area over "2 Architecture" (image + diagram)');
  await expect(card.locator('[data-anchor-quote]')).toContainText('Client app API Gateway');
  await expect.poll(() => naturalWidth(card.locator('.card-attachments img'))).toBe(48);
  // The doc paints the draft: the covered blocks are outlined (the box has no container here).
  await expect.poll(async () => (await ui.inspect()).layers.marks?.some((/** @type {any} */ m) => m.key === 'outline:d1')).toBe(true);
});

test('b toggles snip mode and Esc cancels it; f and Cmd/Ctrl+Shift+Enter outside the composer open Submit review', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  const snipTool = page.getByTestId(TESTID.snipTool);
  await focusUi(page);
  await page.keyboard.press('b');
  await expect(snipTool).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(snipTool).toHaveAttribute('aria-pressed', 'false');
  // The button, then b again, toggles it off.
  await snipTool.click();
  await expect(snipTool).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('b');
  await expect(snipTool).toHaveAttribute('aria-pressed', 'false');
  // From Source mode, b goes back to the rendered doc to snip it.
  await modeTab(page, 'source').click();
  await focusUi(page);
  await page.keyboard.press('b');
  await expect(modeTab(page, 'review')).toHaveAttribute('aria-selected', 'true');
  await expect(snipTool).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');

  const dialog = page.getByTestId(TESTID.submitReviewDialog);
  await focusUi(page);
  await page.keyboard.press('f');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await focusUi(page);
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('in the composer Cmd/Ctrl+Enter adds to the review and Cmd/Ctrl+Shift+Enter sends only that comment', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  const composer = page.getByTestId(TESTID.composer);
  await ui.selectText('Prototype the issuer.');
  await focusUi(page);
  await page.keyboard.press('c');
  await page.getByTestId(TESTID.composerTextarea).fill('Which issuer?');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(composer).toBeHidden();
  const d = mock.doc('kitchen-sink');
  expect(d.drafts.items.map((x) => x.id)).toEqual(['d1']);
  expect(d.reviews).toHaveLength(0);

  await ui.selectText('Remove the legacy session store.');
  await focusUi(page);
  await page.keyboard.press('c');
  await page.getByTestId(TESTID.composerTextarea).fill('When?');
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  await expect(toastWith(page, 'Sent to the agent')).toBeVisible();
  await expect(page.getByTestId(TESTID.submitReviewDialog)).toHaveCount(0);
  expect(d.reviews).toHaveLength(1);
  expect(d.reviews[0]).toMatchObject({ verdict: 'comment', newThreads: ['t1'] });
  // The earlier draft stays in the pending review.
  expect(d.drafts.items.map((x) => x.id)).toEqual(['d1']);
  expect(mock.requests.find((r) => r.method === 'POST' && r.path.endsWith('/reviews'))?.body).toMatchObject({ draftIds: ['d2'] });

  // A draft being edited has no Send now: the keys submit the whole review instead.
  await page.locator('[data-draft-id="d1"]').getByRole('button', { name: 'Edit' }).click();
  await expect(composer).toContainText('Edit draft d1');
  await expect(page.getByTestId(TESTID.composerSendNow)).toHaveCount(0);
  await page.getByTestId(TESTID.composerTextarea).press('ControlOrMeta+Shift+Enter');
  await expect(page.getByTestId(TESTID.submitReviewDialog)).toBeVisible();
});

test('Shift+B snips the screen: a hint while the picker waits, then a composer with the screenshot (general, or on the selection)', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  const d = mock.doc('kitchen-sink');
  mock.setScreenSnip({ delayMs: 700 });
  await focusUi(page);
  await page.keyboard.press('Shift+B');
  const hint = page.locator('[data-screen-snip]');
  await expect(hint).toContainText('Select an area anywhere on your screen');
  await expect(hint).toContainText('Esc to cancel');
  await expect(page.getByTestId(TESTID.snipScreen)).toBeDisabled();

  const composer = page.getByTestId(TESTID.composer);
  await expect(composer).toBeVisible();
  await expect(hint).toHaveCount(0);
  await expect(composer.getByTestId(TESTID.composerAttachment)).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(composer.locator('.agent-sees')).toContainText('GENERAL');
  await expect(page.getByTestId(TESTID.composerTextarea)).toBeFocused();
  // A screenshot alone is a comment.
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(composer).toBeHidden();
  expect(d.drafts.items).toHaveLength(1);
  expect(d.drafts.items[0]).toMatchObject({ attachments: ['attachments/a1.png'], anchor: { kind: 'doc' } });

  // The draft card shows the stored screenshot, which opens full size.
  const thumb = page.locator('[data-draft-id="d1"] .card-attachments img');
  await expect(thumb).toHaveAttribute('src', /\/__att\/a1\.png$/);
  await expect.poll(() => naturalWidth(thumb)).toBe(320);
  await thumb.click();
  const lightbox = page.getByTestId('lightbox');
  await expect(lightbox.locator('img')).toHaveAttribute('src', /\/__att\/a1\.png$/);
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);

  // With text selected in the doc, the screenshot is about the selection (here from the button).
  mock.setScreenSnip({ delayMs: 0 });
  await ui.selectText('rotated on every use');
  await page.getByTestId(TESTID.snipScreen).click();
  await expect(composer.locator('.agent-sees')).toContainText('"rotated on every use"');
  await expect(composer.getByTestId(TESTID.composerAttachment)).toHaveCount(1);
  // Another screen snip while the comment is open is added to it.
  await page.getByTestId(TESTID.composerTextarea).fill('Compare these two.');
  await page.getByTestId(TESTID.snipScreen).click();
  await expect(composer.getByTestId(TESTID.composerAttachment)).toHaveCount(2);
  await expect(toastWith(page, 'Screenshot attached to the open comment')).toBeVisible();
  await page.getByTestId(TESTID.composerAdd).click();
  await expect(composer).toBeHidden();
  expect(d.drafts.items[1]).toMatchObject({ attachments: ['attachments/a2.png', 'attachments/a3.png'], anchor: { kind: 'text' } });
});

test('Shift+B: Esc in the picker cancels quietly, a busy picker says so, and without macOS the button goes away', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  const d = mock.doc('kitchen-sink');
  const screenRequests = () => mock.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/snip/screen')).length;

  mock.setScreenSnip({ mode: 'cancelled' });
  await focusUi(page);
  await page.keyboard.press('Shift+B');
  await expect(toastWith(page, 'Screen snip cancelled')).toBeVisible();
  await expect(page.getByTestId(TESTID.composer)).toHaveCount(0);

  // Another client (e.g. a second tab) holds the picker: the daemon answers 409 busy.
  mock.setScreenSnip({ mode: 'ok', delayMs: 2000 });
  const held = fetch(`${mock.uiOrigin}/api/docs/${d.ws}/${d.id}/snip/screen`, {
    method: 'POST',
    headers: { authorization: `Bearer ${mock.token}`, origin: mock.uiOrigin, 'content-type': 'application/json' },
    body: '{}',
  });
  await expect.poll(screenRequests).toBe(2);
  await focusUi(page);
  await page.keyboard.press('Shift+B');
  await expect(toastWith(page, 'already running on your Mac')).toBeVisible();
  expect((await held).status).toBe(200);
  expect(screenRequests()).toBe(3);

  mock.setScreenSnip({ mode: 'unsupported', delayMs: 0 });
  await page.getByTestId(TESTID.snipScreen).click();
  await expect(toastWith(page, 'Snipping the screen needs macOS')).toBeVisible();
  await expect(page.getByTestId(TESTID.snipScreen)).toHaveCount(0);
  // The key says so again without asking the daemon.
  await focusUi(page);
  await page.keyboard.press('Shift+B');
  await expect(toastWith(page, 'Snipping the screen needs macOS')).toHaveCount(2);
  expect(screenRequests()).toBe(4);
});

test('the help overlay groups the keys and lists b, Shift+B and Send now; buttons show their keys', async ({ page, ui }) => {
  await ui.open('kitchen-sink');
  await focusUi(page);
  await page.keyboard.press('?');
  const help = page.getByTestId('help-overlay');
  await expect(help.locator('.keymap-group th')).toHaveText(['Comment', 'Review', 'Navigate', 'View', 'App']);
  await expect(help.locator('[data-key-row="snip"]')).toContainText('Snip an area of the document');
  await expect(help.locator('[data-key-row="snip"] kbd')).toHaveText('b');
  await expect(help.locator('[data-key-row="snip-screen"]')).toContainText('Snip anywhere on your screen');
  await expect(help.locator('[data-key-row="snip-screen"] kbd')).toHaveText(/^(⇧B|Shift\+B)$/);
  await expect(help.locator('[data-key-row="send-now"]')).toContainText('Send now');
  await expect(help.locator('[data-key-row="send-now"] kbd')).toHaveText(/^(⌘⇧↵|Ctrl\+Shift\+Enter)$/);
  await expect(help.locator('[data-key-row="add"] kbd')).toHaveText(/^(⌘↵|Ctrl\+Enter)$/);
  await expect(help.locator('[data-key-row="submit"] kbd').first()).toHaveText('f');
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);

  await expect(page.getByTestId(TESTID.snipTool)).toHaveAttribute('title', /\(b\)$/);
  await expect(page.getByTestId(TESTID.snipTool).locator('kbd')).toHaveText('b');
  await expect(page.getByTestId(TESTID.snipScreen)).toHaveAttribute('title', /\((⇧B|Shift\+B)\)$/);
  await expect(page.getByTestId(TESTID.pickTool)).toHaveAttribute('title', /\(e\)$/);
  await expect(page.getByTestId(TESTID.submitReviewOpen)).toHaveAttribute('title', /\(f, or (⌘⇧↵|Ctrl\+Shift\+Enter) when no comment is open\)/);
  await page.getByRole('button', { name: 'General comment' }).click();
  await expect(page.getByTestId(TESTID.composerAdd).locator('kbd')).toHaveText(/^(⌘↵|Ctrl\+↵)$/);
  await expect(page.getByTestId(TESTID.composerSendNow).locator('kbd')).toHaveText(/^(⌘⇧↵|Ctrl\+⇧\+↵)$/);
  await expect(page.getByTestId(TESTID.composerSendNow)).toHaveAttribute('title', /Send just this comment/);
});

test('`suiko snip` from a terminal: the draft appears with a toast, [Edit] opens it; with --send it goes straight out', async ({ page, ui, mock }) => {
  await ui.open('kitchen-sink');
  const d = mock.doc('kitchen-sink');
  const shot = `data:image/png;base64,${makePng(64, 40, (x, y) => [x * 4, y * 6, 120, 255]).toString('base64')}`;
  d.addSnipDraft({ dataUrl: shot });
  const toast = toastWith(page, 'Screenshot added from your Mac');
  await expect(toast).toBeVisible();
  const card = page.locator('[data-draft-id="d1"]');
  await expect.poll(() => naturalWidth(card.locator('.card-attachments img'))).toBe(64);
  await toast.getByRole('button', { name: 'Edit' }).click();
  const composer = page.getByTestId(TESTID.composer);
  await expect(composer).toContainText('Edit draft d1');
  await expect(card).toHaveAttribute('aria-current', 'true');
  const att = composer.getByTestId(TESTID.composerAttachment);
  await expect(att).toHaveAttribute('src', /\/__att\/a1\.png$/);
  await page.getByTestId(TESTID.composerTextarea).fill('The legend overlaps the chart.');
  await page.getByTestId(TESTID.composerAdd).click();
  await expect(composer).toBeHidden();
  expect(d.drafts.items[0]).toMatchObject({ id: 'd1', body: 'The legend overlaps the chart.', attachments: ['attachments/a1.png'] });

  // --send: the screenshot went out at once; the toast has nothing to edit.
  d.addSnipDraft({ dataUrl: shot, send: true });
  const sent = toastWith(page, 'Screenshot added from your Mac');
  await expect(sent).toHaveCount(1);
  await expect(sent.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  expect(d.reviews).toHaveLength(1);
  await expect.poll(() => naturalWidth(ui.card('t1').locator('.card-attachments img'))).toBe(64);
  expect(d.drafts.items.map((x) => x.id)).toEqual(['d1']);
});

test('b against the REAL daemon and engine: the snip becomes a snip anchor with its crop, sent now to the agent', async ({ page }) => {
  const real = await startRealDaemon();
  try {
    const ui = new Ui(page, /** @type {any} */ (real));
    await ui.open('kitchen-sink');
    await focusUi(page);
    await page.keyboard.press('b');
    await expect(page.getByTestId(TESTID.snipTool)).toHaveAttribute('aria-pressed', 'true');
    await ui.settle();
    const img = await ui.pointIn('img');
    await page.mouse.move(img.x - 8, img.y - 8);
    await page.mouse.down();
    await page.mouse.move(img.cx, img.cy, { steps: 4 });
    await page.mouse.move(img.x + img.w + 8, img.y + img.h + 40, { steps: 6 });
    await page.mouse.up();
    const composer = page.getByTestId(TESTID.composer);
    await expect(composer.getByTestId(TESTID.composerAttachment)).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(composer.locator('.agent-sees')).toContainText('L29');
    await page.keyboard.press('ControlOrMeta+Shift+Enter'); // no text: the snip speaks for itself
    await expect(toastWith(page, 'Sent to the agent')).toBeVisible();

    const st = /** @type {any} */ (await real.state('kitchen-sink'));
    expect(st.reviews).toHaveLength(1);
    const t = st.threads[0];
    expect(t.attachments).toEqual(['attachments/a1.png']);
    const a = t.anchors[String(t.createdIn)];
    expect(a.kind).toBe('snip');
    expect(a.src.startLine).toBeLessThanOrEqual(29);
    expect(JSON.stringify(await real.agentFeedback('kitchen-sink'))).toContain('a1.png');
    const card = ui.card(t.id);
    await expect(card.locator('.target-label')).toContainText(/area|snip/);
    await expect.poll(() => naturalWidth(card.locator('.card-attachments img'))).toBeGreaterThan(0);
  } finally {
    await real.close();
  }
});

test('Shift+B against the REAL daemon with a fake screencapture: the screenshot is stored, sent now and shown; Esc cancels', async ({ page }) => {
  const real = await startRealDaemon();
  const fake = createFakeCapture(path.join(path.dirname(real.home), 'fake-capture'));
  const prev = process.env.SPECREVIEW_SCREENCAPTURE;
  try {
    process.env.SPECREVIEW_SCREENCAPTURE = fake.command('ok');
    const ui = new Ui(page, /** @type {any} */ (real));
    await ui.open('kitchen-sink');
    await focusUi(page);
    await page.keyboard.press('Shift+B');
    const composer = page.getByTestId(TESTID.composer);
    await expect(composer.getByTestId(TESTID.composerAttachment)).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(composer.locator('.agent-sees')).not.toContainText('Locating');
    await page.getByTestId(TESTID.composerTextarea).fill('This is what I see on my screen.');
    await page.keyboard.press('ControlOrMeta+Shift+Enter');
    await expect(toastWith(page, 'Sent to the agent')).toBeVisible();

    const st = /** @type {any} */ (await real.state('kitchen-sink'));
    expect(st.reviews).toHaveLength(1);
    expect(st.reviews[0].verdict).toBe('comment');
    expect(st.threads).toHaveLength(1);
    expect(st.threads[0].attachments).toEqual(['attachments/a1.png']);
    // The agent gets the screenshot with the review.
    expect(JSON.stringify(await real.agentFeedback('kitchen-sink'))).toContain('a1.png');
    // The daemon serves it to the UI (content origin, DocState.attachmentBase).
    const thumb = ui.card(st.threads[0].id).locator('.card-attachments img');
    await expect(thumb).toHaveAttribute('src', new RegExp(`^${real.contentOrigin.replace(/[.]/g, '\\.')}/c/[^/]+/__att/a1\\.png$`));
    await expect.poll(() => naturalWidth(thumb)).toBe(40);

    // Esc in the picker: nothing is stored, a quiet toast.
    process.env.SPECREVIEW_SCREENCAPTURE = fake.command('cancel');
    await focusUi(page);
    await page.keyboard.press('Shift+B');
    await expect(toastWith(page, 'Screen snip cancelled')).toBeVisible();
    await expect(composer).toHaveCount(0);
    const calls = fake.calls();
    expect(calls.map((c) => c.mode)).toEqual(['ok', 'cancel']);
    expect(calls[0].args.slice(0, 2)).toEqual(['-i', '-x']);
  } finally {
    if (prev === undefined) delete process.env.SPECREVIEW_SCREENCAPTURE;
    else process.env.SPECREVIEW_SCREENCAPTURE = prev;
    await real.close();
  }
});
