// @ts-check
// Installers for agent integrations (design 3.0 / 9.10, amendments 5, integration notes WP8 -> WP4).
//
// planClaude({ scope, withHooks, withMcp, ... }) / planAgentsMd({ target, ... }) compute a list of file actions
// without touching the disk; applyPlan(plan) writes them (mkdir -p + atomic write). The `install` command prints
// the plan (dry run, the default) or applies it with --apply.
//
// install claude:
//   - copies every file of integrations/claude-code/skills/spec-review/ to <base>/skills/spec-review/ and
//     integrations/claude-code/commands/review-spec.md to <base>/commands/review-spec.md, where <base> is
//     $CLAUDE_CONFIG_DIR or ~/.claude (--user, default) or <project>/.claude (--project);
//   - --with-hooks merges the hooks of integrations/claude-code/hooks/hooks.json into <base>/settings.json, with
//     ABSOLUTE commands `"<process.execPath>" "<abs>/bin/specreview.js" hook <name>`; earlier specreview hook
//     entries are replaced, every other setting is preserved;
//   - --with-mcp: --project merges {"mcpServers":{"specreview":{command, args}}} into <project>/.mcp.json;
//     --user prints the `claude mcp add --scope user ...` command (Claude Code's user config is not edited).
// install agents-md: inserts integrations/agents-md/AGENTS.snippet.md into <project>/AGENTS.md, replacing an
//   existing `<!-- specreview:begin ... <!-- specreview:end -->` block (idempotent) or appending it.
// The integration files are WP8's; they are read at run time.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotFoundError } from '../core/store/errors.js';
import { BIN_PATH, PACKAGE_ROOT } from './daemon-client.js';

export const INTEGRATIONS_DIR = path.join(PACKAGE_ROOT, 'integrations');
const SKILL_DIR = path.join(INTEGRATIONS_DIR, 'claude-code', 'skills', 'spec-review');
const COMMAND_FILE = path.join(INTEGRATIONS_DIR, 'claude-code', 'commands', 'review-spec.md');
const HOOKS_FILE = path.join(INTEGRATIONS_DIR, 'claude-code', 'hooks', 'hooks.json');
const AGENTS_SNIPPET = path.join(INTEGRATIONS_DIR, 'agents-md', 'AGENTS.snippet.md');

const BEGIN_MARKER = '<!-- specreview:begin';
const END_MARKER = '<!-- specreview:end -->';

/**
 * @typedef {object} FileAction
 * @property {string} path absolute target path
 * @property {'create' | 'update' | 'unchanged'} action
 * @property {string} content full new content
 * @property {string} [source] where the content comes from (for the dry-run listing)
 * @property {string} [note] what changes (for settings merges)
 */

/**
 * @typedef {object} Plan
 * @property {FileAction[]} files
 * @property {string[]} notes extra instructions to print (e.g. the `claude mcp add` command)
 */

/**
 * The shell command a hook entry runs: "<node>" "<abs bin>" hook <name> (quoted for paths with spaces).
 * @param {string} name 'pre-write' | 'prompt'
 * @param {{ execPath?: string, binPath?: string }} [o]
 * @returns {string}
 */
export function hookCommand(name, o = {}) {
  return `${shellQuote(o.execPath ?? process.execPath)} ${shellQuote(o.binPath ?? BIN_PATH)} hook ${name}`;
}

/**
 * Whether an executable named `name` is on $PATH.
 * @param {string} name
 * @param {string} [pathEnv]
 * @returns {boolean}
 */
export function isOnPath(name, pathEnv = process.env.PATH ?? '') {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      // not here
    }
  }
  return false;
}

/**
 * Inserts a note after the YAML front matter (or at the top) telling the agent how to invoke the CLI on this machine.
 * @param {string} text markdown file content
 * @param {string} invocation e.g. "/path/node" "/path/bin/specreview.js"
 * @returns {string}
 */
export function withInvocationNote(text, invocation) {
  const note =
    `> **On this machine \`specreview\` is not on PATH.** Wherever these instructions (or SpecReview's own output) say\n` +
    `> \`specreview <args>\`, run \`${invocation} <args>\` instead, e.g. \`${invocation} wait <doc>\`.\n`;
  const fm = /^---\n[\s\S]*?\n---\n/.exec(text);
  if (!fm) return `${note}\n${text}`;
  return `${fm[0]}\n${note}${text.slice(fm[0].length)}`;
}

/**
 * @param {string} s
 * @returns {string}
 */
function shellQuote(s) {
  return `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * Project root for --project / agents-md: the nearest ancestor with .git, else the directory itself.
 * @param {string} cwd
 * @returns {string}
 */
export function projectRoot(cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return path.resolve(cwd);
  }
}

/**
 * Plan for `install claude`.
 * @param {{ scope: 'user' | 'project', withHooks?: boolean, withMcp?: boolean, cwd: string,
 *   claudeHome?: string, execPath?: string, binPath?: string, cliOnPath?: boolean }} o
 * @returns {Plan}
 */
export function planClaude(o) {
  const project = projectRoot(o.cwd);
  const base = o.scope === 'project' ? path.join(project, '.claude') : (o.claudeHome ?? path.join(os.homedir(), '.claude'));
  /** @type {FileAction[]} */
  const files = [];
  /** @type {string[]} */
  const notes = [];

  // Without `npm link`, `specreview` is not on PATH: tell the installed skill/command how to invoke the CLI here.
  const onPath = o.cliOnPath ?? isOnPath('specreview');
  const invocation = `${shellQuote(o.execPath ?? process.execPath)} ${shellQuote(o.binPath ?? BIN_PATH)}`;
  const localize = (/** @type {string} */ text) => (onPath ? text : withInvocationNote(text, invocation));

  if (!fs.existsSync(SKILL_DIR)) throw new NotFoundError(`integration files missing: ${SKILL_DIR}`);
  for (const rel of listFiles(SKILL_DIR)) {
    const text = readText(path.join(SKILL_DIR, rel));
    files.push(fileAction(path.join(base, 'skills', 'spec-review', rel), rel === 'SKILL.md' ? localize(text) : text, path.join(SKILL_DIR, rel)));
  }
  if (fs.existsSync(COMMAND_FILE)) {
    files.push(fileAction(path.join(base, 'commands', 'review-spec.md'), localize(readText(COMMAND_FILE)), COMMAND_FILE));
  }
  if (!onPath) {
    notes.push(`\`specreview\` is not on PATH, so the installed skill and /review-spec tell Claude to run ${invocation} instead.` +
      ` Run \`npm link\` in ${PACKAGE_ROOT} (then re-run this install) to use the short command.`);
  }

  if (o.withHooks) {
    const settingsPath = path.join(base, 'settings.json');
    const current = readJsonObject(settingsPath);
    const merged = mergeHooks(current, hookEntries({ execPath: o.execPath, binPath: o.binPath }));
    const action = fileAction(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
    action.note = 'hooks: PreToolUse(Write) -> hook pre-write, UserPromptSubmit -> hook prompt (other settings kept)';
    files.push(action);
    notes.push('Use either the Claude Code plugin or `install claude --with-hooks`, not both: the hooks would run twice.');
  }

  if (o.withMcp) {
    const command = o.execPath ?? process.execPath;
    const args = [o.binPath ?? BIN_PATH, 'mcp'];
    if (o.scope === 'project') {
      const mcpPath = path.join(project, '.mcp.json');
      const current = readJsonObject(mcpPath);
      const servers = current.mcpServers && typeof current.mcpServers === 'object' ? current.mcpServers : {};
      const merged = { ...current, mcpServers: { ...servers, specreview: { command, args } } };
      const action = fileAction(mcpPath, `${JSON.stringify(merged, null, 2)}\n`);
      action.note = 'mcpServers.specreview (other servers kept)';
      files.push(action);
    } else {
      notes.push(`MCP: run  claude mcp add --scope user specreview -- ${shellQuote(command)} ${args.map(shellQuote).join(' ')}`);
    }
    notes.push('In Claude Code the CLI (`specreview wait` in the background) is the primary loop; MCP is optional.');
  }
  return { files, notes };
}

/**
 * Plan for `install agents-md`.
 * @param {{ cwd: string, file?: string }} o
 * @returns {Plan}
 */
export function planAgentsMd(o) {
  if (!fs.existsSync(AGENTS_SNIPPET)) throw new NotFoundError(`integration files missing: ${AGENTS_SNIPPET}`);
  const snippet = readText(AGENTS_SNIPPET).replace(/\s+$/, '');
  const target = o.file ? path.resolve(o.cwd, o.file) : path.join(projectRoot(o.cwd), 'AGENTS.md');
  const current = fs.existsSync(target) ? readText(target) : null;
  const content = insertSnippet(current, snippet);
  const action = fileAction(target, content, AGENTS_SNIPPET);
  action.note = current === null ? 'new file with the SpecReview protocol' : current.includes(BEGIN_MARKER) ? 'replaces the existing specreview block' : 'appends the SpecReview protocol block';
  return { files: [action], notes: [] };
}

/**
 * Inserts/replaces the marked snippet block in an AGENTS.md text.
 * @param {string | null} current
 * @param {string} snippet starts with BEGIN_MARKER and ends with END_MARKER
 * @returns {string}
 */
export function insertSnippet(current, snippet) {
  if (current === null || current.trim() === '') return `${snippet}\n`;
  const start = current.indexOf(BEGIN_MARKER);
  if (start >= 0) {
    const endAt = current.indexOf(END_MARKER, start);
    if (endAt >= 0) {
      const end = endAt + END_MARKER.length;
      return `${current.slice(0, start)}${snippet}${current.slice(end)}`;
    }
  }
  return `${current.replace(/\s+$/, '')}\n\n${snippet}\n`;
}

/**
 * Hook entries with absolute commands, shaped like integrations/claude-code/hooks/hooks.json.
 * @param {{ execPath?: string, binPath?: string }} [o]
 * @returns {Record<string, any[]>}
 */
export function hookEntries(o = {}) {
  /** @type {any} */
  const template = readJsonObject(HOOKS_FILE).hooks ?? {
    PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'specreview hook pre-write', timeout: 5 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'specreview hook prompt', timeout: 5 }] }],
  };
  /** @type {Record<string, any[]>} */
  const out = {};
  for (const [event, groups] of Object.entries(template)) {
    out[event] = (Array.isArray(groups) ? groups : []).map((g) => ({
      ...g,
      hooks: (Array.isArray(g.hooks) ? g.hooks : []).map((/** @type {any} */ h) => {
        const m = /\bhook\s+(pre-write|prompt)\b/.exec(String(h.command ?? ''));
        return m ? { ...h, command: hookCommand(m[1], o) } : h;
      }),
    }));
  }
  return out;
}

/**
 * Merges hook entries into a settings object: removes earlier specreview hooks (any command that runs
 * `specreview ... hook pre-write|prompt`), drops groups left empty, then appends ours. Other keys are kept.
 * @param {Record<string, any>} settings
 * @param {Record<string, any[]>} entries
 * @returns {Record<string, any>}
 */
export function mergeHooks(settings, entries) {
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? { ...settings.hooks } : {};
  const ours = (/** @type {any} */ h) => /specreview(\.js)?["']?\s+hook\s+(pre-write|prompt)\b/.test(String(h?.command ?? ''));
  for (const [event, groups] of Object.entries(entries)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = existing
      .map((/** @type {any} */ g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((/** @type {any} */ h) => !ours(h)) } : g))
      .filter((/** @type {any} */ g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
    hooks[event] = [...kept, ...groups];
  }
  return { ...settings, hooks };
}

/**
 * Writes the plan's changed files (mkdir -p, write to a temp file, rename).
 * @param {Plan} plan
 * @returns {string[]} written paths
 */
export function applyPlan(plan) {
  const written = [];
  for (const f of plan.files) {
    if (f.action === 'unchanged') continue;
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    const tmp = `${f.path}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, f.content);
    fs.renameSync(tmp, f.path);
    written.push(f.path);
  }
  return written;
}

/**
 * Human listing of a plan. Dry run: full content of merged JSON/markdown targets, a one-line summary for copies.
 * @param {Plan} plan
 * @param {{ applied: boolean, written?: string[] }} o
 * @returns {string}
 */
export function describePlan(plan, o) {
  const out = [];
  for (const f of plan.files) {
    const verb = o.applied
      ? f.action === 'unchanged' ? 'unchanged' : f.action === 'create' ? 'created  ' : 'updated  '
      : f.action === 'unchanged' ? 'unchanged' : f.action === 'create' ? 'would create' : 'would update';
    const extra = f.note ? `  (${f.note})` : f.source ? `  (copy of ${path.relative(PACKAGE_ROOT, f.source)}, ${Buffer.byteLength(f.content)} bytes)` : '';
    out.push(`${verb} ${f.path}${extra}`);
    if (!o.applied && f.action !== 'unchanged' && (f.note || !f.source || f.path.endsWith('AGENTS.md'))) {
      out.push(`--- ${f.path} (new content) ---`, f.content.replace(/\n$/, ''), '--- end ---');
    }
  }
  out.push(...plan.notes);
  if (!o.applied) {
    const pending = plan.files.filter((f) => f.action !== 'unchanged').length;
    out.push(pending ? 'dry run: nothing written. Re-run with --apply to write these files.' : 'everything is already installed.');
  }
  return out.join('\n');
}

/**
 * @param {string} target
 * @param {string} content
 * @param {string} [source]
 * @returns {FileAction}
 */
function fileAction(target, content, source) {
  let current = null;
  try {
    current = fs.readFileSync(target, 'utf8');
  } catch {
    current = null;
  }
  return { path: target, action: current === null ? 'create' : current === content ? 'unchanged' : 'update', content, ...(source ? { source } : {}) };
}

/**
 * Regular files under a directory (relative POSIX paths, sorted), skipping dotfiles.
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  const walk = (rel) => {
    for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(r);
      else if (ent.isFile()) out.push(r);
    }
  };
  walk('');
  return out.sort();
}

/**
 * @param {string} file
 * @returns {string}
 */
function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

/**
 * A JSON object file ({} when missing). Throws on invalid JSON so a user's settings file is never clobbered.
 * @param {string} file
 * @returns {Record<string, any>}
 */
function readJsonObject(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  if (!text.trim()) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${/** @type {Error} */ (err).message}); fix it before installing`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} does not contain a JSON object`);
  return value;
}
