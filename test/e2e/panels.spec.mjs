// @ts-check
// The reviewer's panels and overlays, calm and in plain words, against the mock daemon:
//   - the Changes panel: its header stays at the top while the list scrolls; an HTML doc's changes read as the text
//     they render to (Source shows the markup; "Only the markup changed"); the change's id and lines are in its
//     tooltip; "Also changed: ..." for the agent's word on a change no thread asked for; no "unlinked" chip;
//     "Results" (and "between versions" in a code review);
//   - the tool dock never hides the doc for good: fades almost away while the doc scrolls (clicks go through it),
//     comes back about a second later, at once when the pointer comes near the bottom edge, and stays while text is
//     selected; the last line of the doc scrolls clear of it;
//   - the narrow drawer names its panel once ("Threads" / the Changes | Threads tabs);
//   - an agent's picture opens in a viewer that fits it (a small one scaled up, at most 2x) with "From t7 · Reply ·
//     Use in doc"; in "Open large" a click in the sandboxed preview does not cost Esc: the focus comes back as soon
//     as the pointer leaves the frame, and "Close (Esc)" is always there;
//   - a system line's time stays on one line; the code review's file filter is inset like the rail;
//   - contrast: thread ids, times, version tags and menu keys at 4.5:1 or more; the dark count badges too.

import { TESTID } from '../../src/shared/protocol.js';
import { expect, test } from './fixtures.mjs';

/** @typedef {import('@playwright/test').Page} Page */

/** @param {Page} page @param {string} mode */
const modeTab = (page, mode) => page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="${mode}"]`);
/** @param {Page} page @param {string} key */
const filter = (page, key) => page.locator(`.thread-panel .filter[data-filter="${key}"]`);

/**
 * WCAG contrast of an element's text on what is behind it (its own and its ancestors' backgrounds, over the page).
 * @param {import('@playwright/test').Locator} loc
 */
const contrastOf = (loc) => loc.evaluate((el) => {
  const parse = (/** @type {string} */ c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    const a = m ? m[1].split(/[ ,/]+/).filter(Boolean).map(Number) : [0, 0, 0, 0];
    return { r: a[0], g: a[1], b: a[2], a: a.length > 3 ? a[3] : 1 };
  };
  const lum = (/** @type {any} */ c) => {
    const f = (/** @type {number} */ v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const blend = (/** @type {any} */ t, /** @type {any} */ b) => ({ r: t.r * t.a + b.r * (1 - t.a), g: t.g * t.a + b.g * (1 - t.a), b: t.b * t.a + b.b * (1 - t.a), a: 1 });
  const layers = [];
  for (let n = /** @type {Element|null} */ (el); n; n = n.parentElement) {
    const bg = parse(getComputedStyle(n).backgroundColor);
    if (bg.a > 0) layers.push(bg);
    if (bg.a >= 1) break;
  }
  let bg = parse(getComputedStyle(document.documentElement).backgroundColor);
  if (bg.a < 1) bg = matchMedia('(prefers-color-scheme: dark)').matches ? { r: 15, g: 15, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  for (let i = layers.length - 1; i >= 0; i--) bg = blend(layers[i], bg);
  const fg = blend(parse(getComputedStyle(el).color), bg);
  const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
});

test.describe('the Changes panel', () => {
  test('the header stays while the list scrolls; ids and lines in tooltips; "Also changed"; no "unlinked"; Results', async ({ page, ui, mock }) => {
    // h3 is a change no thread asked for, h2 one nothing links (linkedBy null): neither gets a jargon chip
    mock.doc('kitchen-sink').versions[1].manifest.hunks.forEach((/** @type {any} */ h) => { if (h.id === 'h2') { h.threads = []; h.linkedBy = null; } });
    await ui.open('kitchen-sink');
    await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
    const items = page.getByTestId(TESTID.changeItem);
    await expect(items).toHaveCount(3);
    const h1 = items.and(page.locator('[data-hunk-id="h1"]'));
    await expect(h1.locator('.change-main')).toHaveAttribute('title', /^h1 · L\d+(-\d+)?: show it in the document$/);
    expect(await h1.innerText()).not.toMatch(/h1 ·|L\d/);
    await expect(items.and(page.locator('[data-hunk-id="h3"]')).locator('.change-other')).toHaveText('Also changed: Bumped the "Last revised" date');
    await expect(page.locator('.changes-view')).not.toContainText(/unlinked|other:/);
    await expect(page.locator('.round-results .group-title')).toHaveText('Results');

    // the header stays put while the list scrolls under it
    const head = page.locator('.changes-head');
    const before = await head.boundingBox();
    const scroller = page.locator('#sr-side .rail-scroll');
    await scroller.evaluate((e) => { e.scrollTop = 400; });
    await expect.poll(() => scroller.evaluate((e) => e.scrollTop)).toBeGreaterThan(300);
    expect(await head.boundingBox()).toEqual(before);
    await expect(page.getByRole('button', { name: /^Next/ })).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId(TESTID.compareLayout)).toBeInViewport({ ratio: 1 });
    // a change stepped to stops below the header, never under it
    await scroller.evaluate((e) => { e.scrollTop = e.scrollHeight; });
    await page.getByRole('button', { name: /^Prev/ }).click();
    await page.getByRole('button', { name: /^Prev/ }).click();
    const active = page.locator('.change-item.active');
    await expect(active).toHaveAttribute('data-hunk-id', 'h2');
    await expect.poll(async () => ((await active.boundingBox())?.y ?? 0) >= ((await head.boundingBox())?.y ?? 0) + ((await head.boundingBox())?.height ?? 0) - 1).toBe(true);
    expect(ui.errors).toEqual([]);
  });

  test('an HTML doc\'s changes read as text, with the markup a Source toggle away', async ({ page, ui, mock }) => {
    const d = mock.doc('app-spec');
    const v1 = d.source(1);
    d.revise({
      summary: 'Four stages; the lede marked as an intro',
      source: v1.replace('are processed in three stages.', 'are processed in four stages.')
        .replace('<p class="lede">', '<p class="lede intro">'),
    });
    await ui.open('app-spec');
    await modeTab(page, 'changes').click();
    await ui.ready();
    const items = page.getByTestId(TESTID.changeItem);
    await expect(items).toHaveCount(2);
    const stages = items.filter({ hasText: 'stages' });
    const diff = stages.locator('[data-hunk-diff]');
    // the words as the reader reads them (a long unchanged run before the change is shortened: "…")
    await expect(diff).toContainText('arrive through the API gateway and are processed in threefour stages.');
    await expect(diff.locator('del')).toHaveText('three');
    await expect(diff.locator('ins')).toHaveText('four');
    expect(await diff.innerText()).not.toContain('<');
    // Source: the markup itself
    const source = stages.getByRole('button', { name: 'Source' });
    await expect(source).toHaveAttribute('aria-pressed', 'false');
    await source.click();
    await expect(source).toHaveAttribute('aria-pressed', 'true');
    await expect(diff).toContainText('stages.</p>');
    await expect(diff).toHaveClass(/\bis-source\b/);
    await source.click();
    await expect(diff).not.toContainText('<p>');
    // a change of markup only says so
    const lede = items.filter({ hasNot: page.getByText('stages') });
    await expect(lede.locator('[data-hunk-diff]')).toHaveText('Only the markup changed');
    expect(ui.errors).toEqual([]);
  });
});

test.describe('the tool dock', () => {
  test('fades almost away while the doc scrolls (clicks go through), comes back; at once near the bottom edge or with a selection', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await modeTab(page, 'review').click();
    const dock = page.getByTestId(TESTID.toolDock);
    const f = await ui.frame();
    await expect(dock).not.toHaveClass(/is-scrolling/);
    await expect.poll(() => dock.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');

    await f.evaluate(() => window.scrollBy(0, 300));
    await expect(dock).toHaveClass(/is-scrolling/);
    await expect.poll(() => dock.evaluate((e) => getComputedStyle(e).opacity)).toBe('0.15');
    expect(await dock.evaluate((e) => getComputedStyle(e).pointerEvents)).toBe('none');
    // back on its own about a second after the scrolling stops
    await expect(dock).not.toHaveClass(/is-scrolling/, { timeout: 3000 });

    // scrolling again, then the pointer comes near the bottom edge of the doc: back at once
    const frame = await page.getByTestId(TESTID.docFrame).boundingBox();
    if (!frame) throw new Error('no doc frame');
    await page.mouse.move(frame.x + frame.width / 2, frame.y + 200);
    await f.evaluate(() => window.scrollBy(0, 300));
    await expect(dock).toHaveClass(/is-scrolling/);
    await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height - 60, { steps: 4 });
    await expect(dock).not.toHaveClass(/is-scrolling/, { timeout: 600 });

    // with text selected (about to comment), scrolling leaves it where it is
    await page.mouse.move(frame.x + frame.width / 2, frame.y + 200, { steps: 2 });
    await ui.selectText('Prototype the issuer.');
    await expect(dock.locator('[data-selection-comment]')).toBeEnabled();
    await f.evaluate(() => window.scrollBy(0, 120));
    await page.waitForTimeout(250);
    await expect(dock).not.toHaveClass(/is-scrolling/);
    expect(ui.errors).toEqual([]);
  });

  test('the end of a raw HTML doc scrolls clear of it', async ({ page, ui }) => {
    await ui.open('app-spec');
    const f = await ui.frame();
    await f.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(1300); // the dock is back after the scroll
    const dock = await page.getByTestId(TESTID.toolDock).boundingBox();
    const frame = await page.getByTestId(TESTID.docFrame).boundingBox();
    if (!dock || !frame) throw new Error('no dock or frame');
    const last = await f.evaluate(() => {
      const ps = [...document.querySelectorAll('footer p, p')];
      const r = /** @type {Element} */ (ps[ps.length - 1]).getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    expect(frame.y + last.bottom).toBeLessThanOrEqual(dock.y);
    expect(ui.errors).toEqual([]);
  });
});

test.describe('the narrow drawer', () => {
  test('names its panel once: "Threads ×"; in Changes mode the Changes | Threads tabs are its title', async ({ page, ui }) => {
    await page.setViewportSize({ width: 600, height: 900 });
    await ui.open('kitchen-sink');
    await page.locator('#sr-mode').selectOption('review');
    await ui.selectText('Remove the legacy session store.');
    await page.getByTestId(TESTID.toolDock).locator('[data-selection-comment]').click();
    const side = page.locator('#sr-side');
    await expect(page.getByTestId(TESTID.composer)).toBeVisible();
    await expect(side.locator('.drawer-head')).toHaveText('Threads');
    await expect(side.getByText('Threads', { exact: true }).filter({ visible: true })).toHaveCount(1);
    await expect(side.locator('.thread-panel .new-comment')).toBeVisible();
    // the filter and "+" share one row
    const f = await side.locator('.thread-panel .filters').boundingBox();
    const plus = await side.locator('.thread-panel .new-comment').boundingBox();
    expect(Math.abs((f?.y ?? 0) + (f?.height ?? 0) / 2 - ((plus?.y ?? 0) + (plus?.height ?? 0) / 2))).toBeLessThan(4);
    await page.getByRole('button', { name: 'Cancel' }).first().click();

    await page.locator('#sr-mode').selectOption('changes');
    await ui.ready();
    if (!(await page.locator('.doc-view.drawer-open').count())) await page.locator('.threads-toggle').click();
    await expect(side.locator('.drawer-head .side-tabs [role="tab"]')).toHaveText(['Changes', 'Threads']);
    await expect(side.getByText('Changes', { exact: true }).filter({ visible: true })).toHaveCount(1);
    await expect(side.locator('.drawer-head').getByRole('button', { name: 'Close panel' })).toBeVisible();
    await side.locator('.side-tabs [role="tab"]', { hasText: 'Threads' }).click();
    await expect(side.getByText('Threads', { exact: true }).filter({ visible: true })).toHaveCount(1);
    expect(ui.errors).toEqual([]);
  });
});

test.describe('rich replies', () => {
  test.use(/** @type {any} */ ({ scenario: 'rich', prefs: 'defaults' }));

  test('an agent\'s picture: a viewer that fits it, with From t7 · Reply · Use in doc', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await filter(page, 'all').click();
    const t7 = ui.card('t7');
    await t7.locator('.agent-thumb').click();
    const viewer = page.getByTestId('lightbox');
    const img = viewer.locator('img');
    await expect(img).toHaveAttribute('data-fit', 'yes');
    // 240 x 120: scaled up twice, no more
    const box = await img.boundingBox();
    expect([Math.round(box?.width ?? 0), Math.round(box?.height ?? 0)]).toEqual([480, 240]);
    // the dialog is as wide as the picture, 480 px at least
    const dlg = await viewer.boundingBox();
    expect(dlg?.width ?? 0).toBeGreaterThanOrEqual(480);
    expect(dlg?.width ?? 0).toBeLessThan(560);
    const foot = viewer.locator('.preview-foot');
    await expect(foot).toContainText('From t7');
    await expect(foot.getByRole('button', { name: 'Use in doc' })).toBeVisible();
    // Reply: the thread's reply box, about this picture
    await foot.getByRole('button', { name: 'Reply' }).click();
    await expect(viewer).toHaveCount(0);
    await expect(t7.getByTestId(TESTID.replyTextarea)).toHaveValue('About lifetimes.png: ');
    expect(ui.errors).toEqual([]);
  });

  test('Open large: Esc still closes it after a click in the sandboxed preview; Close (Esc) is always there', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await filter(page, 'all').click();
    const open = ui.card('t7').getByRole('button', { name: 'Open large' });
    await open.click();
    const overlay = page.getByTestId('attachment-preview');
    await expect(overlay.locator('.preview-foot')).toContainText('From t7');
    const close = overlay.getByRole('button', { name: 'Close Esc' });
    await expect(close).toBeVisible();
    await expect(close).toHaveAttribute('title', 'Close (Esc)');
    const preview = overlay.locator('iframe.preview-frame');
    const chart = await (await preview.elementHandle())?.contentFrame();
    if (!chart) throw new Error('no preview frame');
    await expect.poll(() => chart.evaluate(() => document.body?.dataset.drawn)).toBe('4');
    const frame = await preview.boundingBox();
    if (!frame) throw new Error('no preview');
    await page.mouse.click(frame.x + frame.width / 2, frame.y + frame.height / 2);
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
    // the pointer leaves the frame: the focus is back in the dialog, so Esc reaches the UI
    await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height + 24, { steps: 4 });
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
    await expect(open).toBeFocused();
    expect(ui.errors).toEqual([]);
  });

  test('a system line\'s time stays on one line', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await filter(page, 'all').click();
    const t7 = ui.card('t7');
    await t7.locator('.preview-card').getByTestId(TESTID.useAttachment).click();
    const time = t7.locator('.system-line').last().locator('time');
    await expect(time).toBeVisible();
    const lh = await time.evaluate((e) => parseFloat(getComputedStyle(e).lineHeight) || 16);
    expect((await time.boundingBox())?.height ?? 99).toBeLessThan(lh * 1.5);
    expect(await time.evaluate((e) => getComputedStyle(e).whiteSpace)).toBe('nowrap');
  });
});

test.describe('contrast', () => {
  test('thread ids, times, version tags and menu keys read at 4.5:1 or more', async ({ page, ui }) => {
    await ui.open('kitchen-sink');
    await modeTab(page, 'review').click();
    const card = ui.card('t2');
    for (const loc of [card.locator('.tid'), card.locator('.comment-head time').first(), card.locator('.vtag').first()]) {
      expect(await contrastOf(loc)).toBeGreaterThanOrEqual(4.5);
    }
    await page.getByTestId(TESTID.moreMenu).click();
    expect(await contrastOf(page.locator('.menu-key').first())).toBeGreaterThanOrEqual(4.5);
  });

  test.describe('dark', () => {
    test.use({ colorScheme: 'dark' });

    test('the count badges read at 4.5:1 or more', async ({ page, ui }) => {
      await ui.open('kitchen-sink');
      await modeTab(page, 'review').click();
      const badge = modeTab(page, 'changes').locator('.badge');
      await expect(badge).toHaveText('3');
      expect(await contrastOf(badge)).toBeGreaterThanOrEqual(4.5);
      const count = filter(page, 'mine').locator('.count');
      await filter(page, 'mine').click();
      expect(await contrastOf(count)).toBeGreaterThanOrEqual(4.5);
      expect(await contrastOf(ui.card('t2').locator('.tid'))).toBeGreaterThanOrEqual(4.5);
    });
  });
});

test.describe('code review', () => {
  test.use(/** @type {any} */ ({ scenario: 'code' }));

  test('the file filter is inset like the rail; Results and "between versions"', async ({ page, ui }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(ui.mock.url('cr-feat'));
    const rail = page.locator('#sr-nav');
    const input = page.locator('.cd-filter');
    await expect(input).toBeVisible();
    const r = await rail.boundingBox();
    const i = await input.boundingBox();
    const title = await page.locator('.code-tree .rail-title').first().boundingBox();
    expect((i?.x ?? 0) - (r?.x ?? 0)).toBeGreaterThanOrEqual(10);
    expect((r?.x ?? 0) + (r?.width ?? 0) - ((i?.x ?? 0) + (i?.width ?? 0))).toBeGreaterThanOrEqual(10);
    expect(Math.abs((i?.x ?? 0) - (title?.x ?? 0))).toBeLessThanOrEqual(16);
    // the rail's versions, by the agent's name
    await expect(page.locator('.mini-history .rail-title')).toHaveText('Versions');
    await expect(page.locator('.mini-history .mini-author').first()).toHaveText('Claude');

    await modeTab(page, 'changes').click();
    await expect(page.locator('.code-summary')).toContainText('changed between versions');
    await expect(page.locator('.round-results .group-title')).toHaveText('Results');
    await expect(page.locator('.changes-view')).not.toContainText(/other:|unlinked|Round results/);
    expect(ui.errors).toEqual([]);
  });
});
