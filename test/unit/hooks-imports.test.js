// @ts-check
// src/cli/hooks.js runs before anything else for every Claude Code prompt and Write, so it may import only node:*
// builtins and src/shared/visible-text.js (the measure it shares with the revision guards), which itself imports
// nothing (fast, and it cannot fail on a broken module); the doc kinds it knows are a copy of DOC_KINDS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOC_KINDS } from '../../src/shared/protocol.js';
import { HOOK_DOC_KINDS } from '../../src/cli/hooks.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** @param {string} file */
function importsOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm), ...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
}

test('hooks.js imports only node:* builtins and the dependency-free visible-text measure', () => {
  const specs = importsOf(path.join(SRC, 'cli', 'hooks.js'));
  assert.ok(specs.length > 0);
  assert.deepEqual(specs.filter((s) => !s.startsWith('node:')), ['../shared/visible-text.js']);
  assert.deepEqual(importsOf(path.join(SRC, 'shared', 'visible-text.js')), [], 'visible-text.js imports nothing');
});

test('its doc kinds are DOC_KINDS', () => {
  assert.deepEqual([...HOOK_DOC_KINDS], [...DOC_KINDS]);
});
