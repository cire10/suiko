// @ts-check
// core/util/build.js: the code identity a daemon reports, so the CLI can tell a daemon running other code (another
// checkout of the same version, or code that changed since it started) from its own.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codeIdentity } from '../../src/core/util/build.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-build-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** A minimal package folder with the files the fingerprint covers (and some it ignores). */
function makePackage(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'cli'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"specreview","version":"0.1.0"}\n');
  fs.writeFileSync(path.join(root, 'bin', 'specreview.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(root, 'src', 'cli', 'main.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# readme\n');
  const t = new Date('2026-01-01T00:00:00Z');
  for (const rel of ['package.json', 'bin/specreview.js', 'src/cli/main.js', 'node_modules/dep/index.js', 'README.md']) {
    fs.utimesSync(path.join(root, rel), t, t);
  }
  return root;
}

test('the same code in the same folder has the same build; root is the real path', () => {
  const root = makePackage('a');
  const one = codeIdentity(root);
  assert.match(one.build, /^[0-9a-f]{16}$/);
  assert.deepEqual(codeIdentity(root), one);
  assert.equal(one.root, fs.realpathSync(root));
  const link = path.join(TMP, 'a-link');
  fs.symlinkSync(root, link);
  assert.deepEqual(codeIdentity(link), one, 'an npm link (symlink) to the folder is the same code');
});

test('another checkout of identical code has another build', () => {
  assert.notEqual(codeIdentity(makePackage('b')).build, codeIdentity(makePackage('c')).build);
});

test('editing, adding or removing a code file changes the build; other files do not', () => {
  const root = makePackage('d');
  const base = codeIdentity(root).build;

  fs.writeFileSync(path.join(root, 'README.md'), '# changed readme\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 2;\n');
  assert.equal(codeIdentity(root).build, base, 'README and node_modules are not code identity');

  const main = path.join(root, 'src', 'cli', 'main.js');
  fs.writeFileSync(main, 'export const x = 2;\n');
  const t = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(main, t, t);
  assert.equal(codeIdentity(root).build, base, 'same size and mtime: a stat-only fingerprint cannot see it');
  fs.utimesSync(main, new Date(), new Date());
  const edited = codeIdentity(root).build;
  assert.notEqual(edited, base, 'an edit (new mtime) changes the build');

  fs.writeFileSync(path.join(root, 'src', 'cli', 'extra.js'), '');
  const added = codeIdentity(root).build;
  assert.notEqual(added, edited, 'a new file changes the build');
  fs.rmSync(path.join(root, 'src', 'cli', 'extra.js'));
  assert.equal(codeIdentity(root).build, edited, 'removing it again restores the build');
});
