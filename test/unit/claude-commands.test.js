// @ts-check
// The Claude Code command files (integrations/claude-code/commands/*.md): every one has a description in its front
// matter, and /review-code (design 4.15) runs `suiko review` so that an error exit (nothing to review, gh not
// signed in) does not abort the command, cannot be invoked by the model on its own, and is installed by
// `suiko install claude` like the others.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeCommandFiles } from '../../src/cli/install.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'integrations', 'claude-code', 'commands');

/** @param {string} name */
function frontMatter(name) {
  const text = fs.readFileSync(path.join(DIR, name), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, `${name} starts with front matter`);
  /** @type {Record<string, string>} */
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2];
  }
  return { fm, text };
}

test('every command file has a description', () => {
  for (const name of claudeCommandFiles()) assert.ok(frontMatter(name).fm.description, name);
});

test('/review-code: installed, model cannot invoke it, and an error from suiko review does not abort it', () => {
  assert.ok(claudeCommandFiles().includes('review-code.md'));
  const { fm, text } = frontMatter('review-code.md');
  assert.equal(fm['disable-model-invocation'], 'true');
  assert.equal(fm['allowed-tools'], 'Bash(suiko *)');
  assert.match(text, /^!`suiko review \$ARGUMENTS 2>&1 \|\| true`$/m);
  assert.match(text, /run_in_background: true/);
  assert.match(text, /section 9/);
});
