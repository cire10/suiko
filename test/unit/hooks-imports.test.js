// @ts-check
// src/cli/hooks.js runs before anything else for every Claude Code prompt and Write, so it may import only node:*
// builtins (fast, and it cannot fail on a broken module); the doc kinds it knows are a copy of DOC_KINDS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOC_KINDS } from '../../src/shared/protocol.js';
import { HOOK_DOC_KINDS } from '../../src/cli/hooks.js';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'hooks.js');

test('hooks.js imports only node:* builtins', () => {
  const text = fs.readFileSync(HOOKS, 'utf8');
  const specs = [...text.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm), ...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(specs.length > 0);
  assert.deepEqual(specs.filter((s) => !s.startsWith('node:')), []);
});

test('its doc kinds are DOC_KINDS', () => {
  assert.deepEqual([...HOOK_DOC_KINDS], [...DOC_KINDS]);
});
