// @ts-check
// Docs stay in sync with the real CLI (integration): every `specreview <command> ...` written in a code span or code
// block of README.md, docs/agent-protocol.md, docs/user-guide.md and integrations/**/*.md must name a real command
// (or `hook` / `install` subcommand) and only flags that command's parseArgs spec accepts (plus the global ones).
// Also checks that relative Markdown links in those files resolve. Ported from WP8's checker, but the allowlist is
// read from src/cli/commands/* instead of being hard-coded, so renaming a flag fails here until the docs follow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.SPECREVIEW_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), 'sr-home-docs-'));
const { COMMANDS } = await import('../../src/cli/commands/index.js');
const { GLOBAL_OPTIONS } = await import('../../src/cli/args.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SUBCOMMANDS = { hook: ['pre-write', 'prompt'], install: ['claude', 'agents-md'] };
/** Commands whose subcommand is optional: `specreview install --apply` runs the agent installer. */
const OPTIONAL_SUB = new Set(['install']);
/** Words that end a documented command (prose or shell glue after it). */
const STOP = new Set(['or', '->', '|', 'then', '&&', 'and', '·', '/', ';']);

/** @param {string} dir @param {string[]} [out] */
function markdownFiles(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) markdownFiles(p, out);
    else if (p.endsWith('.md')) out.push(p);
  }
  return out;
}

const FILES = [
  path.join(ROOT, 'README.md'),
  path.join(ROOT, 'docs', 'agent-protocol.md'),
  path.join(ROOT, 'docs', 'user-guide.md'),
  ...markdownFiles(path.join(ROOT, 'integrations')),
];

/**
 * Flags accepted by a command: `--name` for every option and `-x` for short aliases (global options included).
 * @param {Record<string, { short?: string }>} options
 */
function flagsOf(options) {
  const out = new Set();
  for (const [name, o] of Object.entries({ ...GLOBAL_OPTIONS, ...options })) {
    out.add(`--${name}`);
    if (o.short) out.add(`-${o.short}`);
  }
  return out;
}

/** Fenced code lines plus inline code spans of a Markdown text. @param {string} text */
function codeSnippets(text) {
  /** @type {string[]} */
  const out = [];
  const rest = text.replace(/^(```|~~~)[^\n]*\n([\s\S]*?)^\1\s*$/gm, (_, __, body) => {
    out.push(...body.split('\n'));
    return '';
  });
  for (const m of rest.matchAll(/`([^`\n]+)`/g)) out.push(m[1]);
  return out;
}

test('every documented specreview command and flag exists in the CLI', async () => {
  /** @type {Record<string, Set<string>>} */
  const allowed = {};
  for (const [name, c] of Object.entries(COMMANDS)) allowed[name] = flagsOf((await c.load()).spec.options ?? {});
  /** @type {string[]} */
  const errors = [];
  let checked = 0;
  for (const file of FILES) {
    const rel = path.relative(ROOT, file);
    for (const snip of codeSnippets(fs.readFileSync(file, 'utf8'))) {
      for (const m of snip.matchAll(/(?:^|[\s$(`"'])specreview\s+([a-z][a-z-]*)([^`\n]*)/g)) {
        const cmd = m[1];
        const toks = m[2].trim().split(/\s+/).filter(Boolean);
        if (!allowed[cmd]) {
          errors.push(`${rel}: unknown command "specreview ${cmd}" in: ${snip.trim().slice(0, 100)}`);
          continue;
        }
        let i = 0;
        const subs = /** @type {Record<string, string[]>} */ (SUBCOMMANDS)[cmd];
        if (subs) {
          const sub = (toks[0] ?? '').replace(/[\\|].*$/, '');
          if (subs.includes(sub)) i = 1;
          else if (OPTIONAL_SUB.has(cmd) && (sub === '' || /^[-[]/.test(sub) || STOP.has(sub) || sub.startsWith('#'))) i = 0;
          else {
            errors.push(`${rel}: unknown subcommand "specreview ${cmd} ${sub}"`);
            continue;
          }
        }
        checked++;
        for (; i < toks.length; i++) {
          const t = toks[i];
          if (STOP.has(t) || t.startsWith('#')) break;
          const f = t.replace(/^[[(]+/, '').match(/^(--?[a-zA-Z][\w-]*)/);
          if (f && !allowed[cmd].has(f[1])) errors.push(`${rel}: flag ${f[1]} is not accepted by "specreview ${cmd}" in: ${snip.trim().slice(0, 120)}`);
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  assert.ok(checked > 100, `checked ${checked} documented commands`);
});

test('relative links in the docs resolve', () => {
  /** @type {string[]} */
  const errors = [];
  for (const file of FILES) {
    const text = fs.readFileSync(file, 'utf8').replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1\s*$/gm, '').replace(/`[^`\n]*`/g, '');
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue;
      const p = target.split('#')[0];
      if (!fs.existsSync(path.resolve(path.dirname(file), p))) errors.push(`${path.relative(ROOT, file)}: broken link ${target}`);
    }
  }
  assert.deepEqual(errors, []);
});
