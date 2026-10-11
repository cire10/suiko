// @ts-check
// Content types for everything the daemon serves (both origins). Text types always carry `charset=utf-8` so
// browsers never sniff an encoding; unknown extensions are served as application/octet-stream, which together
// with `X-Content-Type-Options: nosniff` means they are never interpreted as script or markup.

import { extOf } from '../core/util/paths.js';

/** @type {Readonly<Record<string, string>>} lowercase extension (no dot) -> Content-Type */
const TYPES = Object.freeze({
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xhtml: 'application/xhtml+xml; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  markdown: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  vtt: 'text/vtt; charset=utf-8',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
});

export const OCTET_STREAM = 'application/octet-stream';

/**
 * Content-Type for a file path (by extension).
 * @param {string} filePath
 * @returns {string}
 */
export function contentTypeOf(filePath) {
  return TYPES[extOf(filePath)] ?? OCTET_STREAM;
}

/**
 * True for content types whose bytes are text (used to decide whether a charset applies).
 * @param {string} type
 * @returns {boolean}
 */
export function isTextType(type) {
  return /^text\/|^application\/(json|xml|xhtml\+xml)|^image\/svg\+xml/.test(type);
}

/**
 * True for content types a browser renders as a document that can run script when navigated to or framed (HTML,
 * XHTML, SVG, XML). Static-file routes that only serve subresources (the UI origin's /ui/* and /vendor/*) refuse
 * them.
 * @param {string} type
 * @returns {boolean}
 */
export function isDocumentType(type) {
  return /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|application\/xml|text\/xml|text\/xsl|application\/xslt\+xml)\s*(;|$)/i.test(
    String(type).trim(),
  );
}
