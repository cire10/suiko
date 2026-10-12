// @ts-check
// The repository never tracks node_modules: not the folder, and not a symlink to another checkout's (a worktree that
// shares one), which `node_modules/` in .gitignore did not ignore and which broke `git pull` in clones that had a
// real node_modules folder. Skipped outside a git checkout (an npm install).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (/** @type {string[]} */ ...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

test('node_modules is neither tracked nor trackable, as a folder or as a symlink', { skip: !fs.existsSync(path.join(ROOT, '.git')) }, () => {
  assert.equal(git('ls-files', '--', 'node_modules').trim(), '', 'nothing under node_modules is tracked');
  assert.equal(git('check-ignore', '--no-index', 'node_modules').trim(), 'node_modules', 'a file or symlink named node_modules is ignored');
});
