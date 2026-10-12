// @ts-check
// Unit tests for the guest bundle builder (src/guest/build.js) and the guest's inlined protocol constants.
// Run: node --test "test/guest/**/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { buildGuestBundle, guestParts, GUEST_PARTS_DIR } from '../../src/guest/build.js';
import * as protocol from '../../src/shared/protocol.js';

test('bundle is deterministic and wrapped in one strict IIFE', () => {
  const a = buildGuestBundle();
  const b = buildGuestBundle();
  assert.equal(a, b);
  assert.ok(a.startsWith("(function(){'use strict';\n"));
  assert.ok(a.endsWith('\n})();'));
  assert.ok(!a.includes('\r'));
  // Parses as a classic script (no ES module syntax anywhere).
  assert.doesNotThrow(() => new vm.Script(a, { filename: 'guest.js' }));
});

test('parts.json lists every part exactly once, in order, and the parts are classic scripts', () => {
  const parts = guestParts();
  const onDisk = readdirSync(GUEST_PARTS_DIR).filter((f) => /^\d\d-.*\.js$/.test(f)).sort();
  assert.deepEqual(parts, onDisk, 'parts.json order matches the numeric prefixes and covers every part');
  const bundle = buildGuestBundle();
  let last = -1;
  for (const name of parts) {
    const src = readFileSync(join(GUEST_PARTS_DIR, name), 'utf8');
    assert.doesNotMatch(src, /^\s*(import|export)\s/m, `${name} must not use module syntax`);
    assert.match(src, /^\/\/ Suiko guest, part \d\d: /, `${name} starts with its header comment`);
    const at = bundle.indexOf(`// ---- ${name} ----\n`);
    assert.ok(at > last, `${name} appears in order`);
    last = at;
  }
});

test('guestParts rejects malformed parts.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-guest-parts-'));
  try {
    writeFileSync(join(dir, 'parts.json'), JSON.stringify(['a.js', 'a.js']));
    assert.throws(() => guestParts(dir), /duplicate/);
    writeFileSync(join(dir, 'parts.json'), JSON.stringify(['../evil.js']));
    assert.throws(() => guestParts(dir), /invalid/);
    writeFileSync(join(dir, 'parts.json'), JSON.stringify([]));
    assert.throws(() => guestParts(dir), /non-empty/);
    writeFileSync(join(dir, 'parts.json'), JSON.stringify(['x.js', 'y.js']));
    writeFileSync(join(dir, 'x.js'), 'const X = 1;\r\n');
    writeFileSync(join(dir, 'y.js'), 'const Y = X + 1;\n\n\n');
    assert.equal(buildGuestBundle({ dir }), "(function(){'use strict';\n// ---- x.js ----\nconst X = 1;\n\n// ---- y.js ----\nconst Y = X + 1;\n\n})();");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the constants inlined in 00-protocol.js equal src/shared/protocol.js', () => {
  const src = readFileSync(join(GUEST_PARTS_DIR, '00-protocol.js'), 'utf8');
  const inlined = vm.runInNewContext(`${src}\n;({ CONTEXT_CHARS, TEXT_EXCLUDE, BLOCK_TAGS, PICKABLE_TAGS, MSG, SNIP })`);
  const plain = (/** @type {unknown} */ v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(inlined), plain({
    CONTEXT_CHARS: protocol.CONTEXT_CHARS,
    TEXT_EXCLUDE: protocol.TEXT_EXCLUDE,
    BLOCK_TAGS: protocol.BLOCK_TAGS,
    PICKABLE_TAGS: protocol.PICKABLE_TAGS,
    MSG: protocol.MSG,
    SNIP: protocol.SNIP,
  }));
});
