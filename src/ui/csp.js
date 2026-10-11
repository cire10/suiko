// @ts-check
// Node-only helper for the server that hosts the reviewer UI (the daemon, WP5, and the e2e mock server).
// The browser never loads this file.
//
// The SPA's index.html has exactly one inline script: the import map. The UI origin's Content-Security-Policy
// (design 12.4) allows it by hash. Compute the hash from the file on disk with `uiIndex()`, so the hash can never
// drift from the markup:
//
//   const { html, csp } = uiIndex({ contentOrigins: ['http://127.0.0.1:4778'] });
//   res.setHeader('Content-Security-Policy', csp);
//
// All other UI code is loaded from 'self' (/ui/*, /vendor/*, /ui-shared/protocol.js). Inline styles are allowed:
// Preact sets `style` properties, and the CSP permits them.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute directory of the UI sources (serve `/ui/*` from here). */
export const UI_DIR = dirname(fileURLToPath(import.meta.url));

/** Absolute path of the SPA entry page (serve it for `/` and `/d/:ws/:doc`). */
export const UI_INDEX = join(UI_DIR, 'index.html');

/**
 * CSP source expressions ('sha256-<base64>') for every inline <script> (one without src) in an HTML string.
 * @param {string} html
 * @returns {string[]}
 */
export function inlineScriptHashes(html) {
  /** @type {string[]} */
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    out.push(`'sha256-${createHash('sha256').update(m[2], 'utf8').digest('base64')}'`);
  }
  return out;
}

/**
 * The UI Content-Security-Policy of design 12.4.
 * @param {{ contentOrigins: string[], scriptHashes: string[] }} opts
 * @returns {string}
 */
export function uiCsp({ contentOrigins, scriptHashes }) {
  const content = contentOrigins.join(' ');
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${content}`.trim(),
    `frame-src ${content}`.trim(),
    `media-src 'self' data: blob: ${content}`.trim(),
    "connect-src 'self'",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * Reads index.html and returns it with the matching CSP header value.
 * @param {{ contentOrigins: string[] }} opts content origins the doc iframe and images may come from
 * @returns {{ html: string, csp: string, scriptHashes: string[] }}
 */
export function uiIndex({ contentOrigins }) {
  const html = readFileSync(UI_INDEX, 'utf8');
  const scriptHashes = inlineScriptHashes(html);
  return { html, csp: uiCsp({ contentOrigins, scriptHashes }), scriptHashes };
}
