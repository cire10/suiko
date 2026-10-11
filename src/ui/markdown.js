// @ts-check
// Safe rich text for the UI. Comment and reply bodies are Markdown rendered with `marked` and ALWAYS sanitised
// with DOMPurify before they reach the DOM (design 12.4). Server-provided HTML fragments (the suggestion preview
// from /fragment, deleted-content previews) go through the same sanitiser. Nothing else in the UI uses innerHTML.

import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { html } from 'preact-htm';

const md = new Marked({ gfm: true, breaks: true, async: false });

const PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'svg', 'math'],
  FORBID_ATTR: ['style', 'id', 'name'],
  ALLOW_DATA_ATTR: false,
};

// Links in bodies open outside the SPA; never leak the UI URL (which can carry the token) through Referer.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  if (node.tagName === 'IMG') node.setAttribute('referrerpolicy', 'no-referrer');
});

/** @type {Map<string, string>} */
const cache = new Map();
const CACHE_MAX = 300;

/**
 * Markdown -> sanitised HTML string.
 * @param {unknown} source
 * @returns {string}
 */
export function markdownToSafeHtml(source) {
  const text = String(source ?? '');
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out;
  try {
    out = DOMPurify.sanitize(/** @type {string} */ (md.parse(text)), PURIFY);
  } catch {
    out = DOMPurify.sanitize(text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] || c), PURIFY);
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value ?? '');
  cache.set(text, String(out));
  return String(out);
}

/**
 * Sanitises an HTML fragment produced by the server (it is never trusted).
 * @param {unknown} fragment
 */
export function sanitizeHtml(fragment) {
  return String(DOMPurify.sanitize(String(fragment ?? ''), PURIFY));
}

/**
 * Rendered Markdown body.
 * @param {{ text: string, class?: string }} props
 */
export function Markdown({ text, class: cls = '' }) {
  return html`<div class=${`md ${cls}`.trim()} dangerouslySetInnerHTML=${{ __html: markdownToSafeHtml(text) }}></div>`;
}

/**
 * Sanitised server HTML.
 * @param {{ fragment: string, class?: string }} props
 */
export function SafeHtml({ fragment, class: cls = '' }) {
  return html`<div class=${`md ${cls}`.trim()} dangerouslySetInnerHTML=${{ __html: sanitizeHtml(fragment) }}></div>`;
}
