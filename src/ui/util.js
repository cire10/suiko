// @ts-check
// Small browser helpers shared by the UI: platform (for shortcut labels), editable-focus detection, clipboard, image
// paste handling (re-encoded through a canvas, design 12.9), debouncing, scroll-into-view respecting reduced motion,
// and word diffs.

import { diffWordsWithSpace } from 'diff';

/** Apple platforms show ⌘ / ⇧ shortcuts; everything else Ctrl / Shift (Cmd and Ctrl both work everywhere). */
export const IS_MAC = typeof navigator !== 'undefined'
  && /mac|iphone|ipad|ipod/i.test(String(/** @type {any} */ (navigator).userAgentData?.platform || navigator.platform || navigator.userAgent || ''));

/** @param {EventTarget|null|undefined} el */
export function isEditable(el) {
  const e = /** @type {HTMLElement|null} */ (el && /** @type {any} */ (el).nodeType === 1 ? el : null);
  if (!e) return false;
  const tag = e.localName;
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = (/** @type {HTMLInputElement} */ (e).type || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'].includes(type);
  }
  return !!e.isContentEditable;
}

/**
 * Copies text to the clipboard (async Clipboard API, with a textarea fallback).
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * Re-encodes a pasted / dropped image file as a PNG (or JPEG when the PNG would be too large) data URL, scaled
 * to at most 2048 px. Rejects non-images and results above 5 MB.
 * @param {Blob} file
 * @returns {Promise<string>}
 */
export async function imageFileToDataUrl(file) {
  if (!/^image\//.test(file.type)) throw new Error('Only images can be attached');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  let url = canvas.toDataURL('image/png');
  if (dataUrlBytes(url) > MAX_ATTACHMENT_BYTES) url = canvas.toDataURL('image/jpeg', 0.85);
  if (dataUrlBytes(url) > MAX_ATTACHMENT_BYTES) throw new Error('Image is larger than 5 MB');
  return url;
}

/** Decoded size of a base64 data URL. @param {string} url */
export function dataUrlBytes(url) {
  const i = url.indexOf(',');
  const b64 = i >= 0 ? url.slice(i + 1) : url;
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
}

/**
 * Trailing debounce with cancel / flush.
 * @template {any[]} A
 * @param {(...args: A) => void} fn
 * @param {number} ms
 */
export function debounce(fn, ms) {
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  /** @type {A|null} */
  let pending = null;
  const run = () => {
    timer = null;
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };
  /** @param {A} args */
  const call = (...args) => {
    pending = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  call.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  call.flush = () => {
    if (timer) clearTimeout(timer);
    run();
  };
  return call;
}

export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** @param {Element|null|undefined} el @param {ScrollLogicalPosition} [block] */
export function scrollIntoViewSoft(el, block = 'nearest') {
  if (!el) return;
  el.scrollIntoView({ block, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

/**
 * Word diff (jsdiff diffWordsWithSpace) as display parts.
 * @param {string} a
 * @param {string} b
 * @returns {Array<{ op: 'eq'|'ins'|'del', text: string }>}
 */
export function wordParts(a, b) {
  try {
    return diffWordsWithSpace(String(a ?? ''), String(b ?? '')).map((p) => ({
      op: p.added ? 'ins' : p.removed ? 'del' : 'eq',
      text: p.value,
    }));
  } catch {
    return [{ op: 'del', text: String(a ?? '') }, { op: 'ins', text: String(b ?? '') }];
  }
}

/**
 * URL of a doc version on the content origin (`${contentBase}/${ver}/${doc.path}`, amendments 6).
 * @param {string} contentBase
 * @param {number|'live'} version
 * @param {string} docPath
 */
export function docUrl(contentBase, version, docPath) {
  const ver = version === 'live' ? 'live' : `v${version}`;
  const path = String(docPath || '').split('/').map(encodeURIComponent).join('/');
  return `${String(contentBase).replace(/\/+$/, '')}/${ver}/${path}`;
}

/**
 * URL of a content-origin asset named by the API: the engine returns asset URLs relative to DocState.contentBase
 * (`v2/docs/img/arch.png`, amendments 4.5); absolute URLs are accepted only on the content origin itself.
 * Returns null for anything else, so the UI never loads images from an unexpected host.
 * @param {string} contentBase
 * @param {unknown} url
 * @returns {string|null}
 */
export function contentUrl(contentBase, url) {
  if (typeof url !== 'string' || !url) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return originOf(url) && originOf(url) === originOf(contentBase) ? url : null;
  }
  // The path part is a raw workspace-relative path: percent-encode each segment ('#', '?', spaces).
  const rel = url.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  return `${String(contentBase).replace(/\/+$/, '')}/${rel}`;
}

/** @param {string} url */
export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
