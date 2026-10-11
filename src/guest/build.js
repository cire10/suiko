// @ts-check
// Builds the guest bundle: the plain classic-script parts listed (in order) in src/guest/parts.json, concatenated
// inside one strict-mode IIFE:  "(function(){'use strict';\n" + parts + "\n})();"
// The output is deterministic (same files -> same bytes): line endings are normalised to \n, trailing whitespace at
// the end of each part is trimmed, and each part is preceded by a "// ---- <name> ----" marker line.
// The daemon (WP5) serves the result at /__sr/<RENDERER_VERSION>/guest.js; it should build once at startup (or
// cache by mtime) since this function reads the parts from disk synchronously.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the directory holding parts.json and the guest parts. */
export const GUEST_PARTS_DIR = dirname(fileURLToPath(import.meta.url));

const PART_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.js$/;

/**
 * The ordered, validated list of part file names from parts.json.
 * @param {string} [dir]
 * @returns {string[]}
 */
export function guestParts(dir = GUEST_PARTS_DIR) {
  const list = JSON.parse(readFileSync(join(dir, 'parts.json'), 'utf8'));
  if (!Array.isArray(list) || list.length === 0) throw new Error('guest parts.json must be a non-empty array');
  const seen = new Set();
  for (const name of list) {
    if (typeof name !== 'string' || !PART_NAME.test(name)) throw new Error(`invalid guest part name: ${JSON.stringify(name)}`);
    if (seen.has(name)) throw new Error(`duplicate guest part: ${name}`);
    seen.add(name);
  }
  return list;
}

/**
 * Concatenates the guest parts into the bundle served to documents.
 * @param {{ dir?: string }} [opts]
 * @returns {string}
 */
export function buildGuestBundle(opts = {}) {
  const dir = opts.dir || GUEST_PARTS_DIR;
  const body = guestParts(dir)
    .map((name) => {
      const text = readFileSync(join(dir, name), 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trimEnd();
      return `// ---- ${name} ----\n${text}\n`;
    })
    .join('\n');
  return "(function(){'use strict';\n" + body + '\n})();';
}
