// @ts-check
// Helpers shared by the guest browser tests: open a fixture inside the two-origin harness, talk to the guest over
// the harness port, wait for messages, inspect the overlay and drive selections / the mouse.

/** @typedef {import('playwright-core').Page} Page */
/** @typedef {import('playwright-core').Frame} Frame */

/**
 * Opens /parent.html?doc=<doc>, waits for `ready` and (by default) sends `init`.
 * @param {import('playwright-core').Browser} browser
 * @param {{ parentUrl: (doc: string) => string, contentOrigin: string }} harness
 * @param {string} doc
 * @param {{ init?: boolean, initPayload?: Record<string, any>, contextOptions?: Record<string, any>, initScript?: () => void }} [opts]
 */
export async function openDoc(browser, harness, doc, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, ...(opts.contextOptions || {}) });
  if (opts.initScript) await context.addInitScript(opts.initScript);
  const page = await context.newPage();
  /** @type {Error[]} */
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  await page.goto(harness.parentUrl(doc));
  await page.waitForFunction(() => /** @type {any} */ (window).__msgs.some((/** @type {any} */ m) => m.type === 'ready'),
    null, { timeout: 10000 });
  const frame = page.frames().find((f) => f.url().startsWith(harness.contentOrigin));
  if (!frame) throw new Error('doc frame not found');
  if (opts.init !== false) {
    await send(page, 'init', { mode: 'review', theme: 'light', targets: [], changes: null, activeId: null, hidden: false,
      ...(opts.initPayload || {}) });
    await settle(frame);
  }
  return { page, frame, context, pageErrors, close: () => context.close() };
}

/** Sends a UI -> guest message over the harness port. @param {Page} page @param {string} type @param {any} [payload] */
export async function send(page, type, payload = {}) {
  await page.evaluate(([t, p]) => /** @type {any} */ (window).__send(t, p), /** @type {[string, any]} */ ([type, payload]));
}

/** Number of messages received so far (use as `from` for waitMsg). @param {Page} page */
export async function mark(page) {
  return page.evaluate(() => /** @type {any} */ (window).__msgs.length);
}

/**
 * Waits for the first message of `type` received at or after index `from` that satisfies `pred` (a function that is
 * serialised and evaluated in the page).
 * @param {Page} page @param {string} type @param {number} [from] @param {((m: any) => boolean)|null} [pred]
 * @param {number} [timeout]
 */
export async function waitMsg(page, type, from = 0, pred = null, timeout = 5000) {
  const handle = await page.waitForFunction(([t, f, src]) => {
    const fn = src ? (0, eval)('(' + src + ')') : null;
    return /** @type {any} */ (window).__msgs.slice(f).find((/** @type {any} */ m) => m.type === t && (!fn || fn(m))) || null;
  }, /** @type {[string, number, string|null]} */ ([type, from, pred ? pred.toString() : null]), { timeout });
  return handle.jsonValue();
}

/** All messages of a type at or after `from`. @param {Page} page @param {string} type @param {number} [from] */
export async function msgsOf(page, type, from = 0) {
  return page.evaluate(([t, f]) => /** @type {any} */ (window).__msgs.slice(f).filter((/** @type {any} */ m) => m.type === t),
    /** @type {[string, number]} */ ([type, from]));
}

/** @param {Frame} frame */
export async function inspect(frame) {
  return frame.evaluate(() => /** @type {any} */ (window).__specreviewGuest.inspect());
}

/** Waits for two animation frames plus a short pause inside the doc. @param {Frame} frame @param {number} [ms] */
export async function settle(frame, ms = 30) {
  await frame.evaluate((wait) => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, wait)));
  }), ms);
}

/**
 * Selects `text` inside the element with data-srid=srid (may span child nodes) via the Selection API.
 * @param {Frame} frame @param {number} srid @param {string} text
 */
export async function selectText(frame, srid, text) {
  await frame.evaluate(({ srid: s, text: t }) => {
    const el = document.querySelector(`[data-srid="${s}"]`);
    if (!el) throw new Error('no element ' + s);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    /** @type {Array<[Text, number]>} */
    const nodes = [];
    let all = '';
    while (walker.nextNode()) {
      const n = /** @type {Text} */ (walker.currentNode);
      nodes.push([n, all.length]);
      all += n.data;
    }
    const i = all.indexOf(t);
    if (i < 0) throw new Error('text not found: ' + t);
    /** @param {number} off @param {boolean} end */
    const point = (off, end) => {
      for (const [n, start] of nodes) {
        if (off < start + n.data.length || (end && off === start + n.data.length)) return /** @type {[Text, number]} */ ([n, off - start]);
      }
      throw new Error('offset out of range');
    };
    const [sn, so] = point(i, false);
    const [en, eo] = point(i + t.length, true);
    const r = document.createRange();
    r.setStart(sn, so);
    r.setEnd(en, eo);
    const sel = /** @type {Selection} */ (getSelection());
    sel.removeAllRanges();
    sel.addRange(r);
  }, { srid, text });
}

/**
 * Viewport rect (= page coordinates; the harness iframe sits at 0,0 without border) of an element or of a text
 * substring inside an element.
 * @param {Frame} frame @param {string} selector @param {string} [text]
 */
export async function rectOf(frame, selector, text) {
  return frame.evaluate(({ selector: sel, text: t }) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('no element ' + sel);
    let r;
    if (t) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = /** @type {Text} */ (walker.currentNode);
        const i = n.data.indexOf(t);
        if (i >= 0) {
          const range = document.createRange();
          range.setStart(n, i);
          range.setEnd(n, i + t.length);
          r = range.getBoundingClientRect();
          break;
        }
      }
      if (!r) throw new Error('text not found ' + t);
    } else {
      r = el.getBoundingClientRect();
    }
    return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  }, { selector, text });
}

/** Width/height of a base64 PNG data URL. @param {string} dataUrl */
export function pngSize(dataUrl) {
  const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  if (buf.toString('ascii', 1, 4) !== 'PNG') throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
