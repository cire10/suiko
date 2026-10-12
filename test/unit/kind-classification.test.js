// @ts-check
// Every snapshot check in src/ is classified (design 2.9): src/core/review/kinds.js SNAPSHOT_SITES lists each file
// that still tests `isSnapshot(` / `kind === 'snapshot'` / `kind !== 'snapshot'` with its count, and the header
// comment of kinds.js says why (snapshot-only behaviour, or a kind dispatch). A new, unclassified use fails here:
// decide whether a code doc takes that path too (isVirtual), dispatches on its kind (isCode / kindOf), or really is
// snapshot-only, then update SNAPSHOT_SITES and the comment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_SITES } from '../../src/core/review/kinds.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const PATTERN = /isSnapshot\(|kind\s*[!=]==\s*'snapshot'/g;
/** The definitions themselves and the classification's own comment. */
const EXCLUDED = new Set(['core/store/snapshot.js', 'core/review/kinds.js']);

/**
 * @param {string} dir
 * @returns {string[]} paths relative to src/, POSIX
 */
function jsFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(abs));
    else if (/\.(m?js)$/.test(e.name)) out.push(path.relative(SRC, abs).split(path.sep).join('/'));
  }
  return out;
}

test('every snapshot check in src/ is listed in SNAPSHOT_SITES with its count', () => {
  /** @type {Record<string, number>} */
  const found = {};
  for (const rel of jsFiles(SRC)) {
    if (EXCLUDED.has(rel)) continue;
    const n = (fs.readFileSync(path.join(SRC, rel), 'utf8').match(PATTERN) || []).length;
    if (n) found[rel] = n;
  }
  assert.deepEqual(found, { ...SNAPSHOT_SITES }, 'classify the new snapshot check in src/core/review/kinds.js (SNAPSHOT_SITES and its header comment)');
});

test('each listed file is named in the classification comment', () => {
  const header = fs.readFileSync(path.join(SRC, 'core', 'review', 'kinds.js'), 'utf8').split('\nimport ')[0];
  for (const rel of Object.keys(SNAPSHOT_SITES)) assert.ok(header.includes(rel), `${rel} is classified in the kinds.js header`);
});
