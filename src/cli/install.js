// @ts-check
// Installers for agent integrations (design 3.0 / 9.10, amendments 5, integration notes WP8 -> WP4).
//
// planClaude({ scope, withHooks, withPlanGate, withMcp, ... }) / planAgentsMd({ target, ... }) compute a list of file
// actions without touching the disk; applyPlan(plan) writes them (mkdir -p + atomic write). The `install` command
// prints the plan (dry run, the default) or applies it with --apply. The multi-agent installer (`specreview install`
// with no target, `specreview uninstall`) lives in src/cli/install/ and reuses planClaude, the hook helpers and
// applyPlan.
//
// install claude:
//   - copies every file of integrations/claude-code/skills/spec-review/ to <base>/skills/spec-review/ and every
//     integrations/claude-code/commands/*.md to <base>/commands/, where <base> is $CLAUDE_CONFIG_DIR or ~/.claude
//     (--user, default) or <project>/.claude (--project);
//   - --with-hooks merges the hooks of integrations/claude-code/hooks/hooks.json into <base>/settings.json, with
//     ABSOLUTE commands `"<process.execPath>" "<abs>/bin/specreview.js" hook <name>`; earlier specreview hook
//     entries are replaced, every other setting is preserved;
//   - --with-plan-gate also registers the plan-mode gate: PermissionRequest, matcher ExitPlanMode,
//     `"<node>" "<abs bin>" plan-gate`, timeout 345600 s (the review may take days; the terminal dialog stays usable);
//   - --with-mcp: --project merges {"mcpServers":{"specreview":{command, args}}} into <project>/.mcp.json;
//     --user prints the `claude mcp add --scope user ...` command (Claude Code's user config is not edited).
// install agents-md: inserts integrations/agents-md/AGENTS.snippet.md into <project>/AGENTS.md, replacing an
//   existing `<!-- specreview:begin ... <!-- specreview:end -->` block (idempotent) or appending it.
// The integration files are WP8's; they are read at run time.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { NotFoundError } from '../core/store/errors.js';
import { BIN_PATH, PACKAGE_ROOT } from './daemon-client.js';
import { BACKUP_SUFFIX, copyAction, readJsonFile, stringifyLike, updateManifest, writeAtomic } from './install/files.js';

export const INTEGRATIONS_DIR = path.join(PACKAGE_ROOT, 'integrations');
const SKILL_DIR = path.join(INTEGRATIONS_DIR, 'claude-code', 'skills', 'spec-review');
const COMMANDS_DIR = path.join(INTEGRATIONS_DIR, 'claude-code', 'commands');
const HOOKS_FILE = path.join(INTEGRATIONS_DIR, 'claude-code', 'hooks', 'hooks.json');
export const AGENTS_SNIPPET = path.join(INTEGRATIONS_DIR, 'agents-md', 'AGENTS.snippet.md');

const BEGIN_MARKER = '<!-- specreview:begin';
const END_MARKER = '<!-- specreview:end -->';

/** Timeout (seconds) of the plan-mode gate hook: the reviewer may take days; Claude Code's default is 600 s. */
export const PLAN_GATE_TIMEOUT = 345600;

/**
 * @typedef {object} FileAction
 * @property {string} path absolute target path
 * @property {'create' | 'update' | 'unchanged' | 'delete'} action
 * @property {string} content full new content ('' for delete)
 * @property {string} [source] where the content comes from (for the dry-run listing)
 * @property {string} [note] what changes (for settings merges)
 * @property {string} [detail] the entry/block added, printed by the multi-agent dry run
 * @property {boolean} [backup] modifying an existing file: keep a one-time <file>.specreview-backup (multi-agent install)
 * @property {boolean} [record] a whole-file copy: record its sha256 in the install manifest
 * @property {boolean} [kept] uninstall left this file alone (edited since install)
 * @property {string} [share] tag of a file written for several agents (deduplicated, kept while another agent uses it)
 * @property {string[]} [rmdirs] after a delete: remove these directories when they are empty
 */

/**
 * @typedef {object} Plan
 * @property {FileAction[]} files
 * @property {string[]} notes extra instructions to print (e.g. the `claude mcp add` command)
 */

/**
 * The CLI invocation with absolute paths: "<node>" "<abs bin>" (quoted for paths with spaces).
 * @param {{ execPath?: string, binPath?: string }} [o]
 * @returns {string}
 */
export function cliInvocation(o = {}) {
  return `${shellQuote(o.execPath ?? process.execPath)} ${shellQuote(o.binPath ?? BIN_PATH)}`;
}

/**
 * The shell command a hook entry runs: "<node>" "<abs bin>" hook <name> (quoted for paths with spaces).
 * @param {string} name 'pre-write' | 'prompt'
 * @param {{ execPath?: string, binPath?: string }} [o]
 * @returns {string}
 */
export function hookCommand(name, o = {}) {
  return `${cliInvocation(o)} hook ${name}`;
}

/**
 * The plan-mode gate's command: "<node>" "<abs bin>" plan-gate.
 * @param {{ execPath?: string, binPath?: string }} [o]
 * @returns {string}
 */
export function planGateCommand(o = {}) {
  return `${cliInvocation(o)} plan-gate`;
}

/** A hook command that runs SpecReview: `specreview hook <name>` or `... plan-gate`, PATH-relative or absolute. */
const OUR_HOOK_RE = /(?:^|[\s"'/\\])specreview(?:\.js)?["']?\s+(?:hook\s+[a-z][a-z-]*|plan-gate)\b/;
const PLAN_GATE_RE = /(?:^|[\s"'/\\])specreview(?:\.js)?["']?\s+plan-gate\b/;

/**
 * @param {any} hook a hook handler ({type, command, ...})
 * @returns {boolean}
 */
export function isOurHook(hook) {
  return OUR_HOOK_RE.test(String(hook?.command ?? ''));
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
      const p = path.join(dir, name);
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return true;
    } catch {
      // not here
    }
  }
  return false;
}

/**
 * The two-line note telling an agent how to invoke the CLI when `specreview` is not on PATH.
 * @param {string} invocation e.g. "/path/node" "/path/bin/specreview.js"
 * @returns {string}
 */
export function invocationNote(invocation) {
  return (
    `> **On this machine \`specreview\` is not on PATH.** Wherever these instructions (or SpecReview's own output) say\n` +
    `> \`specreview <args>\`, run \`${invocation} <args>\` instead, e.g. \`${invocation} wait <doc>\`.\n`
  );
}

/**
 * Inserts a note after the YAML front matter (or at the top) telling the agent how to invoke the CLI on this machine.
 * @param {string} text markdown file content
 * @param {string} invocation e.g. "/path/node" "/path/bin/specreview.js"
 * @returns {string}
 */
export function withInvocationNote(text, invocation) {
  const note = invocationNote(invocation);
  const fm = /^---\n[\s\S]*?\n---\n/.exec(text);
  if (!fm) return `${note}\n${text}`;
  return `${fm[0]}\n${note}${text.slice(fm[0].length)}`;
}

/**
 * @param {string} s
 * @returns {string}
 */
export function shellQuote(s) {
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
 * The Claude Code command files SpecReview ships (integrations/claude-code/commands/*.md), sorted.
 * @returns {string[]} file names
 */
export function claudeCommandFiles() {
  try {
    return fs.readdirSync(COMMANDS_DIR).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort();
  } catch {
    return [];
  }
}

/**
 * Every file SpecReview copies into a Claude Code config dir, with its template text and localised content.
 * @param {string} base <claude home> or <project>/.claude
 * @param {{ cliOnPath: boolean, invocation: string }} o
 * @returns {Array<{ target: string, source: string, template: string, content: string, dir: string }>}
 */
export function claudeCopies(base, o) {
  if (!fs.existsSync(SKILL_DIR)) throw new NotFoundError(`integration files missing: ${SKILL_DIR}`);
  const localize = (/** @type {string} */ text) => (o.cliOnPath ? text : withInvocationNote(text, o.invocation));
  const out = [];
  const skillTarget = path.join(base, 'skills', 'spec-review');
  for (const rel of listFiles(SKILL_DIR)) {
    const source = path.join(SKILL_DIR, rel);
    const template = readText(source);
    out.push({ target: path.join(skillTarget, rel), source, template, content: rel === 'SKILL.md' ? localize(template) : template, dir: skillTarget });
  }
  for (const name of claudeCommandFiles()) {
    const source = path.join(COMMANDS_DIR, name);
    const template = readText(source);
    out.push({ target: path.join(base, 'commands', name), source, template, content: localize(template), dir: path.join(base, 'commands') });
  }
  return out;
}

/**
 * Plan for `install claude`.
 * @param {{ scope: 'user' | 'project', withHooks?: boolean, withPlanGate?: boolean, withMcp?: boolean, cwd: string,
 *   claudeHome?: string, execPath?: string, binPath?: string, cliOnPath?: boolean,
 *   manifest?: import('./install/files.js').Manifest }} o
 * @returns {Plan}
 */
export function planClaude(o) {
  const project = projectRoot(o.cwd);
  const base = o.scope === 'project' ? path.join(project, '.claude') : (o.claudeHome ?? path.join(os.homedir(), '.claude'));
  /** @type {FileAction[]} */
  const files = [];
  /** @type {string[]} */
  const notes = [];

  // Without `npm link`, `specreview` is not on PATH: tell the installed skill/commands how to invoke the CLI here.
  const onPath = o.cliOnPath ?? isOnPath('specreview');
  const invocation = cliInvocation(o);
  for (const c of claudeCopies(base, { cliOnPath: onPath, invocation })) {
    files.push(copyAction(c.target, c.content, { source: c.source, template: c.template, manifest: o.manifest }));
  }
  if (!onPath) {
    notes.push(`\`specreview\` is not on PATH, so the installed skill and commands tell Claude to run ${invocation} instead.` +
      ` Run \`npm link\` in ${PACKAGE_ROOT} (then re-run this install) to use the short command.`);
  }

  if (o.withHooks || o.withPlanGate) {
    const settingsPath = path.join(base, 'settings.json');
    const entries = hookEntries({ execPath: o.execPath, binPath: o.binPath, planGate: Boolean(o.withPlanGate), hooks: Boolean(o.withHooks) });
    const action = jsonFileAction(settingsPath, (current) => mergeHooks(current, entries));
    action.note = `hooks: ${describeHookEntries(entries)} (other settings kept)`;
    action.detail = JSON.stringify(entries, null, 2);
    files.push(action);
    notes.push('Use either the Claude Code plugin or `install claude --with-hooks`, not both: the hooks would run twice.');
  }

  if (o.withMcp) {
    const command = o.execPath ?? process.execPath;
    const args = [o.binPath ?? BIN_PATH, 'mcp'];
    if (o.scope === 'project') {
      const mcpPath = path.join(project, '.mcp.json');
      const action = jsonFileAction(mcpPath, (current) => {
        const servers = current.mcpServers && typeof current.mcpServers === 'object' ? current.mcpServers : {};
        return { ...current, mcpServers: { ...servers, specreview: { command, args } } };
      });
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
 * A merge into a JSON settings file: unchanged when the merged object equals the file's (whatever its formatting);
 * otherwise the file's indentation is kept. Throws on invalid JSON, so a user's settings file is never clobbered.
 * @param {string} file
 * @param {(current: Record<string, any>) => Record<string, any>} merge
 * @returns {FileAction}
 */
function jsonFileAction(file, merge) {
  const parsed = readJsonFile(file, undefined);
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    raw = null;
  }
  const current = parsed?.value ?? {};
  const merged = merge(structuredClone(current));
  if (raw !== null && parsed && isDeepStrictEqual(merged, current)) return { path: file, action: 'unchanged', content: raw };
  return { path: file, action: raw === null ? 'create' : 'update', content: stringifyLike(merged, parsed?.text ?? null), ...(raw !== null && raw.trim() ? { backup: true } : {}) };
}

/**
 * One-line summary of hook entries: "PreToolUse(Write) -> hook pre-write, ...".
 * @param {Record<string, any[]>} entries
 * @returns {string}
 */
export function describeHookEntries(entries) {
  const out = [];
  for (const [event, groups] of Object.entries(entries)) {
    for (const g of groups) {
      for (const h of g.hooks ?? []) {
        const what = String(h.command ?? '').replace(/^.*specreview(?:\.js)?["']?\s+/, '');
        out.push(`${event}${g.matcher ? `(${g.matcher})` : ''} -> ${what}`);
      }
    }
  }
  return out.join(', ');
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
 * Hook entries with absolute commands, shaped like integrations/claude-code/hooks/hooks.json: every template
 * command that starts with `specreview` runs "<node>" "<abs bin>" instead. `planGate` adds (or keeps) the
 * PermissionRequest/ExitPlanMode gate; without it a gate in the template is left out. `hooks: false` keeps only the
 * gate.
 * @param {{ execPath?: string, binPath?: string, planGate?: boolean, hooks?: boolean }} [o]
 * @returns {Record<string, any[]>}
 */
export function hookEntries(o = {}) {
  /** @type {any} */
  let template;
  try {
    template = readJsonFile(HOOKS_FILE)?.value.hooks;
  } catch {
    template = undefined;
  }
  template ??= {
    PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'specreview hook pre-write', timeout: 5 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'specreview hook prompt', timeout: 5 }] }],
  };
  const invocation = cliInvocation(o);
  /** @type {Record<string, any[]>} */
  const out = {};
  let hasGate = false;
  for (const [event, groups] of Object.entries(template)) {
    const kept = [];
    for (const g of Array.isArray(groups) ? groups : []) {
      const hooks = [];
      for (const h of Array.isArray(g.hooks) ? g.hooks : []) {
        const command = String(h.command ?? '').replace(/^specreview(?=\s)/, invocation);
        const gate = PLAN_GATE_RE.test(command);
        if (gate ? !o.planGate : o.hooks === false) continue;
        if (gate) hasGate = true;
        hooks.push({ ...h, command });
      }
      if (hooks.length) kept.push({ ...g, hooks });
    }
    if (kept.length) out[event] = kept;
  }
  if (o.planGate && !hasGate) {
    out.PermissionRequest = [
      ...(out.PermissionRequest ?? []),
      { matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: planGateCommand(o), timeout: PLAN_GATE_TIMEOUT }] },
    ];
  }
  return out;
}

/**
 * Merges hook entries into a settings object: removes earlier specreview hooks (any command that runs
 * `specreview ... hook <name>` or `... plan-gate`) from the events being written, drops groups left empty, then
 * appends ours. Other keys and events are kept.
 * @param {Record<string, any>} settings
 * @param {Record<string, any[]>} entries
 * @returns {Record<string, any>}
 */
export function mergeHooks(settings, entries) {
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? { ...settings.hooks } : {};
  for (const [event, groups] of Object.entries(entries)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...withoutOurHooks(existing), ...groups];
  }
  return { ...settings, hooks };
}

/**
 * Removes every specreview hook from a settings object (uninstall): emptied groups and events go too, and the
 * `hooks` key when nothing is left in it.
 * @param {Record<string, any>} settings
 * @returns {Record<string, any>}
 */
export function removeOurHooks(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) return settings;
  /** @type {Record<string, any>} */
  const hooks = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept = withoutOurHooks(groups);
    if (kept.length || !groups.length) hooks[event] = kept;
  }
  const out = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

/**
 * @param {any[]} groups
 * @returns {any[]}
 */
function withoutOurHooks(groups) {
  return groups
    .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((/** @type {any} */ h) => !isOurHook(h)) } : g))
    .filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
}

/**
 * Writes the plan's changed files (mkdir -p, write to a temp file, rename) and deletes `delete` actions.
 * With `backups`, an existing file that a `backup` action modifies is first copied to <file>.specreview-backup
 * (once: an existing backup is never overwritten). With `manifest`, written copies (`record`) are recorded there.
 * @param {Plan} plan
 * @param {{ backups?: boolean, manifest?: string }} [o]
 * @returns {string[]} written (or deleted) paths
 */
export function applyPlan(plan, o = {}) {
  const written = [];
  /** @type {Array<{ path: string, content: string }>} */
  const recorded = [];
  /** @type {string[]} */
  const deleted = [];
  for (const f of plan.files) {
    if (f.action === 'unchanged') continue;
    if (o.backups && f.backup) backupOnce(f.path);
    if (f.action === 'delete') {
      fs.rmSync(f.path, { force: true });
      deleted.push(f.path);
      for (const dir of f.rmdirs ?? []) removeEmptyDir(dir);
    } else {
      writeAtomic(f.path, f.content);
      if (f.record) recorded.push({ path: f.path, content: f.content });
    }
    written.push(f.path);
  }
  if (o.manifest && (recorded.length || deleted.length)) {
    try {
      updateManifest(o.manifest, { written: recorded, deleted });
    } catch {
      // the manifest only helps recognise our older copies later
    }
  }
  return written;
}

/**
 * @param {string} file
 * @returns {string | null} the backup path when one was made
 */
function backupOnce(file) {
  const backup = `${file}${BACKUP_SUFFIX}`;
  if (fs.existsSync(backup) || !fs.existsSync(file)) return null;
  fs.copyFileSync(file, backup);
  return backup;
}

/**
 * @param {string} dir
 */
function removeEmptyDir(dir) {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // not there or not empty
  }
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
      ? f.action === 'unchanged' ? 'unchanged' : f.action === 'create' ? 'created  ' : f.action === 'delete' ? 'deleted  ' : 'updated  '
      : f.action === 'unchanged' ? 'unchanged' : f.action === 'create' ? 'would create' : f.action === 'delete' ? 'would delete' : 'would update';
    const extra = f.note ? `  (${f.note})` : f.source ? `  (copy of ${path.relative(PACKAGE_ROOT, f.source)}, ${Buffer.byteLength(f.content)} bytes)` : '';
    out.push(`${verb} ${f.path}${extra}`);
    if (!o.applied && f.action !== 'unchanged' && f.action !== 'delete' && (!f.source || f.path.endsWith('AGENTS.md'))) {
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
export function listFiles(dir) {
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
export function readText(file) {
  return fs.readFileSync(file, 'utf8');
}
