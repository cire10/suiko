// @ts-check
// Agent definitions for `specreview install` (no target) and `specreview uninstall`. Each agent detects itself
// (config dir and/or binary on PATH, honouring CLAUDE_CONFIG_DIR, CODEX_HOME, GEMINI_CLI_HOME, XDG_CONFIG_HOME and
// COPILOT_HOME) and plans FileActions for install and uninstall through a Planner. Only surfaces verified in the
// agent's official docs are written (sources below); everything else is listed as unverified and never touched.
//
//   claude          skill + every command file + hooks (PreToolUse Write, UserPromptSubmit) in settings.json
//                   (--project: .claude/settings.local.json, which is not committed), absolute node/script paths; the
//                   plan-mode gate (PermissionRequest/ExitPlanMode) only with --with-plan-gate or when one is already
//                   there. Skipped when the SpecReview plugin is installed for this scope/project (the hooks would run
//                   twice), with a warning when settings hooks are left over
//   codex           protocol block in $CODEX_HOME/AGENTS.md (AGENTS.override.md when that is in use), the shared skill
//                   in ~/.agents/skills, [mcp_servers.specreview] in a marked block of config.toml (toml.js)
//   gemini          protocol block in ~/.gemini/GEMINI.md (or the configured context file), /specreview-review TOML
//   cursor          mcpServers.specreview in ~/.cursor/mcp.json, the shared skill (Cursor has no global rules file)
//   opencode        protocol block in ~/.config/opencode/AGENTS.md, /specreview-review command, mcp.specreview in
//                   opencode.json
//   copilot         protocol block in ~/.copilot/copilot-instructions.md, the shared skill
//   amp             protocol block in ~/.config/amp/AGENTS.md, the shared skill
//   droid           the shared skill
//   kiro            ~/.kiro/steering/specreview.md (always included), ~/.kiro/skills/specreview-review
//   claude-desktop  mcpServers.specreview in claude_desktop_config.json (macOS, Windows)
// --project writes the project-level equivalents (<root>/AGENTS.md, <root>/.agents/skills, <root>/.cursor/mcp.json, ...).
// The shared <root>/AGENTS.md is not created in a project that has only a CLAUDE.md: OpenCode and Amp read CLAUDE.md
// only while AGENTS.md does not exist.

import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT } from '../daemon-client.js';
import { AGENTS_SNIPPET, claudeCopies, describeHookEntries, hookEntries, installedHooks, isOnPath, isOurHook, isPlanGateHook, mergeHooks, removeOurHooks } from '../install.js';
import {
  GEMINI_COMMAND, OPENCODE_COMMAND, SKILL_NAME, SKILL_TEMPLATE, agentSkill, codexTomlBlock, geminiCommand, kiroSteering,
  opencodeCommand, protocolBlock,
} from './content.js';
import {
  InstallRefusal, MD_MARKERS, blockAction, copyAction, deleteEntry, jsonAction, readTextOrNull, removeBlockAction,
  removeCopyAction, removeTomlBlockAction, scanTomlFile, setEntry, tomlBlockAction,
} from './files.js';
import { definitionsOutside } from './toml.js';

/** @typedef {import('../install.js').FileAction} FileAction */

/**
 * @typedef {object} Ctx
 * @property {string} home the user's home directory
 * @property {Record<string, string | undefined>} env
 * @property {NodeJS.Platform} platform
 * @property {'user' | 'project'} scope
 * @property {string} cwd
 * @property {string} root project root (nearest .git ancestor of cwd)
 * @property {string} execPath absolute node
 * @property {string} binPath absolute bin/specreview.js
 * @property {boolean} cliOnPath whether `specreview` is on PATH
 * @property {string} invocation "<node>" "<bin>"
 * @property {string} pathEnv PATH used for detection
 * @property {import('./files.js').Manifest} manifest
 * @property {string} [claudeHome] override of the Claude Code config dir
 * @property {boolean} [planGate] --with-plan-gate: also install Claude Code's plan-mode gate (opt-in)
 */

/**
 * @typedef {object} Detection
 * @property {boolean} detected
 * @property {string[]} evidence e.g. ['~/.codex', 'codex on PATH']
 */

/**
 * @typedef {object} AgentDef
 * @property {string} id
 * @property {string} name
 * @property {string[]} [aliases]
 * @property {Array<'user' | 'project'>} scopes
 * @property {string[]} shares shared-file tags this agent writes ('agents-skill', 'agents-md')
 * @property {string[]} sources official docs that verified the surfaces written
 * @property {(c: Ctx) => Detection} detect
 * @property {(c: Ctx, p: Planner) => void} install
 * @property {(c: Ctx, p: Planner) => void} uninstall
 */

/** Collects one agent's actions, notes and per-file refusals. */
export class Planner {
  constructor() {
    /** @type {FileAction[]} */
    this.files = [];
    /** @type {string[]} */
    this.notes = [];
    /** @type {Array<{ file: string, message: string, fix?: string }>} */
    this.refusals = [];
    /** @type {string | undefined} */
    this.skipped = undefined;
    /** @type {string[]} notes about the whole run (printed once, whichever agents add them) */
    this.globalNotes = [];
  }

  /**
   * Plans one action; an InstallRefusal is recorded instead of aborting the agent.
   * @param {() => FileAction | null | undefined} fn
   */
  add(fn) {
    try {
      const a = fn();
      if (a) this.files.push(a);
    } catch (err) {
      if (!(err instanceof InstallRefusal)) throw err;
      this.refusals.push({ file: err.file, message: err.message, ...(err.fix ? { fix: err.fix } : {}) });
    }
  }

  /** @param {string} text */
  note(text) {
    this.notes.push(text);
  }

  /** @param {string} reason */
  skip(reason) {
    this.skipped = reason;
  }

  /** @param {string} text */
  globalNote(text) {
    if (!this.globalNotes.includes(text)) this.globalNotes.push(text);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Paths and detection helpers.

/** @param {string | undefined} v @param {string} fallback */
const absOr = (v, fallback) => (v && path.isAbsolute(v) ? v : v ? path.resolve(v) : fallback);

export const paths = {
  /** @param {Ctx} c */
  claude: (c) => c.claudeHome ?? absOr(c.env.CLAUDE_CONFIG_DIR, path.join(c.home, '.claude')),
  /** @param {Ctx} c */
  codex: (c) => absOr(c.env.CODEX_HOME, path.join(c.home, '.codex')),
  /** @param {Ctx} c */
  gemini: (c) => path.join(absOr(c.env.GEMINI_CLI_HOME, c.home), '.gemini'),
  /** @param {Ctx} c */
  xdgConfig: (c) => (c.env.XDG_CONFIG_HOME && path.isAbsolute(c.env.XDG_CONFIG_HOME) ? c.env.XDG_CONFIG_HOME : path.join(c.home, '.config')),
  /** @param {Ctx} c */
  opencode: (c) => path.join(paths.xdgConfig(c), 'opencode'),
  /** @param {Ctx} c */
  cursor: (c) => path.join(c.home, '.cursor'),
  /** @param {Ctx} c */
  copilot: (c) => absOr(c.env.COPILOT_HOME, path.join(c.home, '.copilot')),
  /** @param {Ctx} c */
  amp: (c) => path.join(c.home, '.config', 'amp'),
  /** @param {Ctx} c */
  factory: (c) => path.join(c.home, '.factory'),
  /** @param {Ctx} c */
  kiro: (c) => path.join(c.home, '.kiro'),
  /** @param {Ctx} c @returns {string | null} */
  claudeDesktop: (c) =>
    c.platform === 'darwin'
      ? path.join(c.home, 'Library', 'Application Support', 'Claude')
      : c.platform === 'win32' && c.env.APPDATA
        ? path.join(c.env.APPDATA, 'Claude')
        : null,
  /** The shared skill dir (user: ~/.agents/skills, project: <root>/.agents/skills). @param {Ctx} c */
  agentsSkill: (c) => path.join(c.scope === 'project' ? c.root : c.home, '.agents', 'skills', SKILL_NAME),
};

/**
 * `~/x` for paths under the home directory (display only).
 * @param {Ctx} c
 * @param {string} p
 * @returns {string}
 */
export function tilde(c, p) {
  const rel = path.relative(c.home, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join('/')}` : p;
}

/** @param {string} p */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} p */
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {Ctx} c
 * @param {Array<string | null | false | undefined>} hits
 * @returns {Detection}
 */
function detection(c, hits) {
  const evidence = /** @type {string[]} */ (hits.filter(Boolean));
  return { detected: evidence.length > 0, evidence };
}

/** @param {Ctx} c @param {string} dir */
const dirHit = (c, dir) => (isDir(dir) ? tilde(c, dir) : null);
/** @param {Ctx} c @param {string} file */
const fileHit = (c, file) => (isFile(file) ? tilde(c, file) : null);
/** @param {Ctx} c @param {...string} names */
const binHit = (c, ...names) => {
  for (const n of names) if (isOnPath(n, c.pathEnv)) return `${n} on PATH`;
  return null;
};

/** @param {string} source */
const rel = (source) => path.relative(PACKAGE_ROOT, source);

const PROTOCOL = 'the SpecReview protocol block';

/**
 * Lenient JSON read for detection only (never throws). `comments`: strip line and block comments first, as Gemini CLI
 * does for its settings.json.
 * @param {string} file
 * @param {{ comments?: boolean }} [o]
 * @returns {any}
 */
function readJsonLenient(file, o = {}) {
  const text = readTextOrNull(file);
  if (!text) return null;
  try {
    return JSON.parse(o.comments ? stripJsonComments(text) : text);
  } catch {
    return null;
  }
}

/**
 * Removes line (//) and block comments outside strings (whitespace stays, so positions in error messages still match).
 * @param {string} text
 * @returns {string}
 */
export function stripJsonComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const from = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(from, i + 1);
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else {
      out += ch;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Shared pieces.

/**
 * The protocol block in a global instructions file.
 * @param {Ctx} c
 * @param {string} file
 * @param {string} [share]
 * @returns {FileAction}
 */
function protocolAction(c, file, share) {
  return blockAction(file, protocolBlock(c).content, MD_MARKERS, { source: rel(AGENTS_SNIPPET), what: PROTOCOL, share });
}

/**
 * @param {Ctx} c
 * @param {string} file
 * @param {string} [share]
 * @returns {FileAction | null}
 */
function removeProtocolAction(c, file, share) {
  return removeBlockAction(file, MD_MARKERS, { what: PROTOCOL, share, manifest: c.manifest });
}

/**
 * The agent-neutral skill in ~/.agents/skills (or <root>/.agents/skills), shared by every agent that reads it.
 * @param {Ctx} c
 * @param {string} [dir]
 * @param {string} [share]
 * @returns {FileAction}
 */
function skillAction(c, dir = paths.agentsSkill(c), share = 'agents-skill') {
  const s = agentSkill(c);
  return copyAction(path.join(dir, 'SKILL.md'), s.content, { source: SKILL_TEMPLATE, template: s.template, manifest: c.manifest, share: share || undefined });
}

/**
 * @param {Ctx} c
 * @param {string} [dir]
 * @param {string} [share]
 * @returns {FileAction | null}
 */
function removeSkillAction(c, dir = paths.agentsSkill(c), share = 'agents-skill') {
  const s = agentSkill(c);
  return removeCopyAction(path.join(dir, 'SKILL.md'), s.content, { template: s.template, manifest: c.manifest, rmdirs: [dir], share: share || undefined });
}

/** The project's AGENTS.md (read by Codex, Cursor, OpenCode, Copilot CLI, Amp and Droid). @param {Ctx} c */
const projectAgentsMd = (c) => path.join(c.root, 'AGENTS.md');

/**
 * The protocol block in the project's shared AGENTS.md, except in a project that has CLAUDE.md and no AGENTS.md:
 * OpenCode and Amp read CLAUDE.md only while AGENTS.md does not exist (opencode.ai/docs/rules,
 * ampcode.com/docs/customize/agents-md), so creating AGENTS.md would silently drop the team's CLAUDE.md for them.
 * @param {Ctx} c
 * @param {Planner} p
 */
function projectProtocol(c, p) {
  const file = projectAgentsMd(c);
  const claudeMd = path.join(c.root, 'CLAUDE.md');
  if (readTextOrNull(file) === null && isFile(claudeMd)) {
    p.note(`Did not create ${file}: this project has only CLAUDE.md (see the note at the end).`);
    p.globalNote(
      `This project has CLAUDE.md and no AGENTS.md. OpenCode and Amp read CLAUDE.md only while AGENTS.md does not exist, so ` +
        `creating ${file} would make them stop reading it; SpecReview leaves it alone. The skills and commands it installs carry the ` +
        'protocol anyway. To add the protocol block too, create AGENTS.md yourself (for example move the rules from CLAUDE.md into it ' +
        'and put `@AGENTS.md` in CLAUDE.md, which Claude Code imports), then re-run `specreview install --project`.',
    );
    return;
  }
  p.add(() => protocolAction(c, file, 'agents-md'));
}

/**
 * An MCP server entry in a JSON config file.
 * @param {string} file
 * @param {string} container 'mcpServers' (Cursor, Claude Desktop) or 'mcp' (OpenCode)
 * @param {Record<string, unknown>} entry
 * @returns {FileAction}
 */
function mcpJsonAction(file, container, entry) {
  return jsonAction(file, (o) => setEntry(o, container, 'specreview', entry), {
    note: `${container}.specreview (other entries kept)`,
    detail: JSON.stringify({ [container]: { specreview: entry } }, null, 2),
    fix: `add "specreview": ${JSON.stringify(entry)} under "${container}" by hand`,
  });
}

/**
 * @param {Ctx} c
 * @param {string} file
 * @param {string} container
 * @returns {FileAction | null}
 */
function removeMcpJsonAction(c, file, container) {
  return jsonAction(file, (o) => deleteEntry(o, container, 'specreview'), {
    note: `removes ${container}.specreview; other entries kept`, deleteWhenEmpty: true, manifest: c.manifest, fix: `remove "specreview" from "${container}" by hand`,
  });
}

/** @param {Ctx} c */
function stdioCommand(c) {
  return { command: c.execPath, args: [c.binPath, 'mcp'] };
}

// ---------------------------------------------------------------------------------------------------------------
// Claude Code.

/**
 * @param {string} dir
 * @param {string | undefined} parent
 * @returns {boolean} whether dir is parent or inside it
 */
function within(dir, parent) {
  if (!parent) return false;
  const r = path.relative(path.resolve(parent), path.resolve(dir));
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

/**
 * The SpecReview Claude Code plugin, when it is active here and not disabled: installed at user scope, installed at
 * project/local scope for the project containing the working directory (installed_plugins.json records `scope` and
 * `projectPath`), or enabled in one of the settings files Claude Code reads here. An install for another project
 * does not count. `scope` is what `claude plugin uninstall --scope` needs.
 * @param {Ctx} c
 * @returns {{ id: string, where: string, scope: 'user' | 'project' | 'local' } | null}
 */
export function claudePlugin(c) {
  const home = paths.claude(c);
  const installedFile = path.join(home, 'plugins', 'installed_plugins.json');
  const installed = readJsonLenient(installedFile);
  /** @type {Map<string, 'user' | 'project' | 'local'>} */
  const ids = new Map();
  const registry = installed && typeof installed === 'object' ? (installed.plugins && typeof installed.plugins === 'object' ? installed.plugins : installed) : {};
  for (const [key, value] of Object.entries(registry)) {
    if (!/^specreview@/.test(key)) continue;
    // v2: an array of installs, one per scope (and project); v1: one object, user scope.
    const entries = Array.isArray(value) ? value : [value];
    for (const e of entries) {
      const scope = e && typeof e === 'object' && typeof e.scope === 'string' ? e.scope : 'user';
      if (scope === 'user' || ((scope === 'project' || scope === 'local') && within(c.cwd, e.projectPath))) {
        if (!ids.has(key)) ids.set(key, /** @type {'user' | 'project' | 'local'} */ (scope));
      }
    }
  }
  /** @type {Record<string, { value: unknown, file: string, scope: 'user' | 'project' | 'local' }>} */
  const enabled = {};
  /** @type {Array<[string, 'user' | 'project' | 'local']>} */
  const settingsFiles = [
    [path.join(home, 'settings.json'), 'user'],
    [path.join(c.root, '.claude', 'settings.json'), 'project'],
    [path.join(c.root, '.claude', 'settings.local.json'), 'local'],
  ];
  for (const [file, scope] of settingsFiles) {
    const s = readJsonLenient(file);
    const map = s && typeof s.enabledPlugins === 'object' && s.enabledPlugins ? s.enabledPlugins : {};
    for (const [k, v] of Object.entries(map)) if (/^specreview@/.test(k)) enabled[k] = { value: v, file, scope };
  }
  for (const [id, scope] of ids) if (enabled[id]?.value !== false) return { id, where: tilde(c, installedFile), scope };
  for (const [id, e] of Object.entries(enabled)) if (e.value) return { id, where: `enabledPlugins in ${tilde(c, e.file)}`, scope: e.scope };
  return null;
}

/**
 * @param {{ id: string, scope: string }} plugin
 * @returns {string}
 */
const pluginUninstall = (plugin) => `claude plugin uninstall ${plugin.id}${plugin.scope === 'user' ? '' : ` --scope ${plugin.scope}`}`;

/** @param {Ctx} c */
const claudeBase = (c) => (c.scope === 'project' ? path.join(c.root, '.claude') : paths.claude(c));

/**
 * Where the hooks go: ~/.claude/settings.json, or for --project the uncommitted .claude/settings.local.json (the
 * commands hold absolute paths that exist only on this machine).
 * @param {Ctx} c
 */
const claudeSettings = (c) => path.join(claudeBase(c), c.scope === 'project' ? 'settings.local.json' : 'settings.json');

/**
 * Settings files uninstall cleans: the one install writes, plus (project scope) .claude/settings.json, where
 * `install claude --project --with-hooks` puts them.
 * @param {Ctx} c
 * @returns {string[]}
 */
const claudeSettingsFiles = (c) => (c.scope === 'project' ? [claudeSettings(c), path.join(claudeBase(c), 'settings.json')] : [claudeSettings(c)]);

/**
 * SpecReview hook commands found in the settings files of this scope (an earlier settings install), except the
 * plan-mode gate: the plugin does not include it, so a gate in settings.json next to the plugin runs once.
 * @param {Ctx} c
 * @returns {Array<{ file: string, commands: string[] }>}
 */
function settingsHooks(c) {
  const out = [];
  for (const file of claudeSettingsFiles(c)) {
    const s = readJsonLenient(file);
    const hooks = s && typeof s.hooks === 'object' && s.hooks && !Array.isArray(s.hooks) ? s.hooks : {};
    const commands = [];
    for (const groups of Object.values(hooks)) {
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const h of Array.isArray(g?.hooks) ? g.hooks : []) if (isOurHook(h) && !isPlanGateHook(h)) commands.push(String(h.command));
      }
    }
    if (commands.length) out.push({ file, commands });
  }
  return out;
}

/**
 * Plugin and settings install both present: what to tell the user (null when only one of them is there).
 * @param {Ctx} c
 * @param {{ id: string, scope: string }} plugin
 * @returns {string | null}
 */
export function claudeDoubleInstall(c, plugin) {
  const found = settingsHooks(c);
  if (!found.length) return null;
  const n = found.reduce((k, f) => k + f.commands.length, 0);
  return (
    `${found.map((f) => tilde(c, f.file)).join(' and ')} also ${n === 1 ? 'has a SpecReview hook' : `has ${n} SpecReview hooks`} from an earlier ` +
    `\`specreview install\`, so ${n === 1 ? 'it runs' : 'they run'} twice next to the plugin's (${plugin.id}). Remove the settings install with ` +
    '`specreview uninstall --only claude --apply` (it leaves the plugin alone), or remove the plugin.'
  );
}

/** @type {AgentDef} */
const claude = {
  id: 'claude',
  name: 'Claude Code',
  aliases: ['claude-code'],
  scopes: ['user', 'project'],
  shares: [],
  sources: [
    'https://code.claude.com/docs/en/hooks (PermissionRequest, matcher ExitPlanMode, timeout)',
    'https://code.claude.com/docs/en/skills (commands and skills)',
    'https://code.claude.com/docs/en/settings (settings.local.json: personal project settings, not checked in)',
    'https://code.claude.com/docs/en/plugins/cli-reference (installed plugins: scope, projectPath; plugin uninstall --scope)',
  ],
  detect: (c) => detection(c, [dirHit(c, paths.claude(c)), binHit(c, 'claude')]),
  install(c, p) {
    const plugin = claudePlugin(c);
    if (plugin) {
      const twice = claudeDoubleInstall(c, plugin);
      p.skip(
        `the SpecReview Claude Code plugin is installed (${plugin.id}, ${plugin.where}). It already provides the skill, the commands and the hooks; ` +
          'installing them into settings.json as well would run every hook twice. To switch to the settings install (absolute paths, so it works when ' +
          `Claude Code does not see your shell PATH), run \`${pluginUninstall(plugin)}\`, then re-run this install.` +
          (twice ? ` WARNING: ${twice}` : ''),
      );
      return;
    }
    const base = claudeBase(c);
    for (const cp of claudeCopies(base, c)) {
      p.add(() => copyAction(cp.target, cp.content, { source: cp.source, template: cp.template, manifest: c.manifest }));
    }
    // The plan-mode gate is opt-in (--with-plan-gate): SpecReview is for the reviews you ask for, not every plan. A gate
    // already in the settings file (an earlier opt-in) is kept and re-pointed at this CLI like the other hooks.
    const planGate = Boolean(c.planGate) || installedHooks(claudeSettings(c)).planGate;
    const entries = hookEntries({ execPath: c.execPath, binPath: c.binPath, planGate, hooks: true });
    p.add(() =>
      jsonAction(claudeSettings(c), (s) => mergeHooks(s, entries), {
        note: `hooks: ${describeHookEntries(entries)}; other settings kept`,
        detail: JSON.stringify({ hooks: entries }, null, 2),
        fix: 'add the hooks shown above under "hooks" by hand',
      }),
    );
    if (planGate) p.note('Plan mode: when Claude calls ExitPlanMode, the plan opens in SpecReview; approving it there approves the plan, and the terminal dialog stays usable.');
    if (c.scope === 'project') p.note('The hooks go to .claude/settings.local.json, Claude Code\'s personal project settings: keep it out of git.');
  },
  uninstall(c, p) {
    const base = claudeBase(c);
    for (const cp of claudeCopies(base, c)) {
      p.add(() => removeCopyAction(cp.target, cp.content, { template: cp.template, manifest: c.manifest, rmdirs: cp.dir.endsWith('spec-review') ? [cp.dir] : [] }));
    }
    for (const file of claudeSettingsFiles(c)) {
      p.add(() => jsonAction(file, (s) => removeOurHooks(s), { note: 'removes the SpecReview hooks; other settings kept', deleteWhenEmpty: true, manifest: c.manifest }));
    }
    const plugin = claudePlugin(c);
    if (plugin) p.note(`The SpecReview plugin is still installed (${plugin.id}); remove it with \`${pluginUninstall(plugin)}\`.`);
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Codex CLI.

/**
 * Codex reads only AGENTS.override.md when it is non-empty, else AGENTS.md.
 * @param {Ctx} c
 * @returns {string}
 */
function codexInstructions(c) {
  const home = paths.codex(c);
  const override = path.join(home, 'AGENTS.override.md');
  return (readTextOrNull(override) ?? '').trim() ? override : path.join(home, 'AGENTS.md');
}

/** @param {Ctx} c */
const codexConfig = (c) => (c.scope === 'project' ? path.join(c.root, '.codex', 'config.toml') : path.join(paths.codex(c), 'config.toml'));

/** The table SpecReview owns in Codex's config.toml. */
const CODEX_TABLE = ['mcp_servers', 'specreview'];
const CODEX_WHAT = 'the [mcp_servers.specreview] table';

/**
 * The [mcp_servers.specreview] block in config.toml. A definition outside our block (from `codex mcp add`, or our
 * own table after Codex rewrote [mcp_servers] and dropped the begin marker) is left alone: adding ours would make the
 * TOML invalid. So is an inline `mcp_servers = {...}` or an array [[mcp_servers]], which cannot take a table.
 * @param {Ctx} c
 * @param {Planner} p
 */
function codexMcp(c, p) {
  const file = codexConfig(c);
  const fix = `add the table shown above to ${file} by hand`;
  p.add(() => {
    const current = readTextOrNull(file);
    const blk = scanTomlFile(file, current ?? '', CODEX_TABLE, fix);
    const defs = definitionsOutside(blk, CODEX_TABLE);
    if (defs.defined) {
      p.note(
        `${tilde(c, file)} already defines the specreview MCP server outside SpecReview's managed block; left as is.` +
          (blk.strayEnds.length
            ? ' (A leftover "# specreview:end" line suggests Codex rewrote [mcp_servers], e.g. on `codex mcp add`, and dropped the begin marker.' +
              ' To let SpecReview manage the entry again, run `codex mcp remove specreview` and re-run this install.)'
            : ''),
      );
      return null;
    }
    if (defs.container) {
      p.note(`${tilde(c, file)} defines mcp_servers inline (or as [[mcp_servers]]), so a [mcp_servers.specreview] table cannot be added safely; add it to that definition by hand.`);
      return null;
    }
    return tomlBlockAction(file, current, blk, codexTomlBlock(c), CODEX_TABLE, { what: CODEX_WHAT, fix });
  });
}

/**
 * Uninstall the block from config.toml; report a specreview server that is defined outside it.
 * @param {Ctx} c
 * @param {Planner} p
 */
function removeCodexMcp(c, p) {
  const file = codexConfig(c);
  p.add(() => {
    const current = readTextOrNull(file);
    if (current === null) return null;
    const blk = scanTomlFile(file, current, CODEX_TABLE, `remove the [mcp_servers.specreview] table and the specreview marker lines from ${file} by hand`);
    if (definitionsOutside(blk, CODEX_TABLE).defined) {
      p.note(
        `${tilde(c, file)} defines the specreview MCP server outside SpecReview's markers (Codex drops the begin marker when it rewrites [mcp_servers], ` +
          'e.g. on `codex mcp add`), so it is not removed; run `codex mcp remove specreview` if you no longer want it.',
      );
    }
    return removeTomlBlockAction(file, current, blk, { what: CODEX_WHAT, manifest: c.manifest });
  });
}

/** @type {AgentDef} */
const codex = {
  id: 'codex',
  name: 'Codex CLI',
  aliases: ['codex-cli'],
  scopes: ['user', 'project'],
  shares: ['agents-skill', 'agents-md'],
  sources: [
    'https://learn.chatgpt.com/docs/agent-configuration/agents-md (~/.codex/AGENTS.md, AGENTS.override.md, CODEX_HOME)',
    'https://learn.chatgpt.com/docs/build-skills (user skills in $HOME/.agents/skills)',
    'https://learn.chatgpt.com/docs/extend/mcp?surface=cli ([mcp_servers.<name>] in ~/.codex/config.toml, tool_timeout_sec)',
    'https://learn.chatgpt.com/docs/custom-prompts (deprecated in favour of skills, so no prompt file is written)',
  ],
  detect(c) {
    const home = paths.codex(c);
    let used = null;
    try {
      used = fs.readdirSync(home).some((n) => n !== 'skills' && n !== '.DS_Store') ? tilde(c, home) : null;
    } catch {
      used = null;
    }
    return detection(c, [used, binHit(c, 'codex')]);
  },
  install(c, p) {
    if (c.scope === 'project') {
      projectProtocol(c, p);
    } else {
      const target = codexInstructions(c);
      p.add(() => protocolAction(c, target));
      if (target.endsWith('AGENTS.override.md')) p.note(`Codex reads only ${tilde(c, target)} while it is non-empty, so the protocol goes there.`);
    }
    p.add(() => skillAction(c));
    codexMcp(c, p);
    p.note('Start a new Codex session to load the instructions; run the skill with $specreview-review (or pick it in /skills).');
    if (c.scope === 'project') p.note('Codex reads a project .codex/config.toml only in trusted projects.');
  },
  uninstall(c, p) {
    if (c.scope === 'project') {
      p.add(() => removeProtocolAction(c, projectAgentsMd(c), 'agents-md'));
    } else {
      p.add(() => removeProtocolAction(c, path.join(paths.codex(c), 'AGENTS.md')));
      p.add(() => removeProtocolAction(c, path.join(paths.codex(c), 'AGENTS.override.md')));
    }
    p.add(() => removeSkillAction(c));
    removeCodexMcp(c, p);
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Gemini CLI.

/**
 * The context file Gemini CLI loads: GEMINI.md unless settings.json names others (context.fileName). Gemini CLI
 * strips comments from settings.json before parsing it, so this read does too. `unreadable`: the file exists but
 * does not parse, so the default name is assumed.
 * @param {string} settingsFile
 * @returns {{ names: string[], unreadable: boolean }} the first name is where the block goes
 */
function geminiContextNames(settingsFile) {
  const s = readJsonLenient(settingsFile, { comments: true });
  const unreadable = s === null && (readTextOrNull(settingsFile) ?? '').trim() !== '';
  const raw = s?.context?.fileName ?? s?.contextFileName;
  const names = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).filter((n) => typeof n === 'string' && n && !n.includes('/'));
  if (!names.length || names.includes('GEMINI.md')) return { names: ['GEMINI.md', ...names.filter((n) => n !== 'GEMINI.md')], unreadable };
  return { names, unreadable };
}

/** @param {Ctx} c */
const geminiBase = (c) => (c.scope === 'project' ? c.root : paths.gemini(c));
/** @param {Ctx} c */
const geminiSettings = (c) => (c.scope === 'project' ? path.join(c.root, '.gemini', 'settings.json') : path.join(paths.gemini(c), 'settings.json'));
/** @param {Ctx} c */
const geminiCommandFile = (c) => path.join(c.scope === 'project' ? path.join(c.root, '.gemini') : paths.gemini(c), 'commands', `${SKILL_NAME}.toml`);

/** @type {AgentDef} */
const gemini = {
  id: 'gemini',
  name: 'Gemini CLI',
  aliases: ['gemini-cli'],
  scopes: ['user', 'project'],
  shares: [],
  sources: [
    'https://geminicli.com/docs/cli/gemini-md/ (~/.gemini/GEMINI.md, context.fileName)',
    'https://geminicli.com/docs/cli/custom-commands/ (~/.gemini/commands/<name>.toml: prompt, description, {{args}})',
    'https://geminicli.com/docs/reference/configuration.md (GEMINI_CLI_HOME)',
  ],
  // `~/.gemini` alone is not enough: Google Antigravity uses it too.
  detect: (c) => detection(c, [binHit(c, 'gemini'), fileHit(c, path.join(paths.gemini(c), 'settings.json'))]),
  install(c, p) {
    const ctxNames = geminiContextNames(geminiSettings(c));
    const [name] = ctxNames.names;
    p.add(() => protocolAction(c, path.join(geminiBase(c), name)));
    if (ctxNames.unreadable) p.note(`${tilde(c, geminiSettings(c))} could not be parsed, so the protocol goes to GEMINI.md, Gemini CLI's default context file; if you set context.fileName there, move the block.`);
    const cmd = geminiCommand(c);
    p.add(() => copyAction(geminiCommandFile(c), cmd.content, { source: GEMINI_COMMAND, template: cmd.template, manifest: c.manifest }));
    p.note('/specreview-review <file> starts a review round; in a running session, /memory reload and /commands reload pick up the changes.');
  },
  uninstall(c, p) {
    for (const name of geminiContextNames(geminiSettings(c)).names) p.add(() => removeProtocolAction(c, path.join(geminiBase(c), name)));
    const cmd = geminiCommand(c);
    p.add(() => removeCopyAction(geminiCommandFile(c), cmd.content, { template: cmd.template, manifest: c.manifest }));
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Cursor.

/** @param {Ctx} c */
const cursorMcp = (c) => path.join(c.scope === 'project' ? path.join(c.root, '.cursor') : paths.cursor(c), 'mcp.json');

/** @type {AgentDef} */
const cursor = {
  id: 'cursor',
  name: 'Cursor',
  scopes: ['user', 'project'],
  shares: ['agents-skill', 'agents-md'],
  sources: [
    'https://cursor.com/docs/context/mcp (~/.cursor/mcp.json, mcpServers, type "stdio")',
    'https://cursor.com/docs/context/skills (skills in ~/.agents/skills and ~/.cursor/skills, invoked as /skill-name)',
    'https://cursor.com/docs/context/rules (User Rules live in settings, no file; AGENTS.md in the project only)',
  ],
  detect: (c) => detection(c, [dirHit(c, paths.cursor(c)), binHit(c, 'cursor', 'cursor-agent')]),
  install(c, p) {
    p.add(() => mcpJsonAction(cursorMcp(c), 'mcpServers', { type: 'stdio', ...stdioCommand(c) }));
    p.add(() => skillAction(c));
    if (c.scope === 'project') projectProtocol(c, p);
    else p.note("Cursor's global User Rules live in its settings, not in a file, so the protocol comes with the /specreview-review skill and the MCP tools.");
    p.note('Reload Cursor (or toggle specreview in Settings > MCP) to start the MCP server.');
  },
  uninstall(c, p) {
    p.add(() => removeMcpJsonAction(c, cursorMcp(c), 'mcpServers'));
    p.add(() => removeSkillAction(c));
    if (c.scope === 'project') p.add(() => removeProtocolAction(c, projectAgentsMd(c), 'agents-md'));
  },
};

// ---------------------------------------------------------------------------------------------------------------
// OpenCode.

/** @param {Ctx} c */
const opencodeDir = (c) => (c.scope === 'project' ? c.root : paths.opencode(c));
/** @param {Ctx} c */
const opencodeCommandFile = (c) => path.join(c.scope === 'project' ? path.join(c.root, '.opencode') : paths.opencode(c), 'commands', `${SKILL_NAME}.md`);

/**
 * opencode.json, or opencode.jsonc when only that exists.
 * @param {Ctx} c
 * @returns {string[]} existing config files (or the one to create)
 */
function opencodeConfigs(c) {
  const dir = opencodeDir(c);
  const existing = ['opencode.json', 'opencode.jsonc'].map((n) => path.join(dir, n)).filter(isFile);
  return existing.length ? existing : [path.join(dir, 'opencode.json')];
}

/** @type {AgentDef} */
const opencode = {
  id: 'opencode',
  name: 'OpenCode',
  scopes: ['user', 'project'],
  shares: ['agents-md'],
  sources: [
    'https://opencode.ai/docs/rules/ (~/.config/opencode/AGENTS.md; ~/.claude/CLAUDE.md fallback)',
    'https://opencode.ai/docs/commands/ (~/.config/opencode/commands/<name>.md, $ARGUMENTS)',
    'https://opencode.ai/docs/mcp-servers/ and https://opencode.ai/docs/config/ ("mcp": {type "local", command array})',
  ],
  detect: (c) => detection(c, [dirHit(c, paths.opencode(c)), binHit(c, 'opencode', 'opencode2')]),
  install(c, p) {
    if (c.scope === 'project') {
      projectProtocol(c, p);
    } else {
      const agentsMd = path.join(paths.opencode(c), 'AGENTS.md');
      const claudeMd = path.join(c.home, '.claude', 'CLAUDE.md');
      const fallbackOff = c.env.OPENCODE_DISABLE_CLAUDE_CODE || c.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT;
      if (readTextOrNull(agentsMd) === null && isFile(claudeMd) && !fallbackOff) {
        p.note(
          `Skipped ${PROTOCOL}: OpenCode reads ${tilde(c, claudeMd)} as its rules only while ${tilde(c, agentsMd)} does not exist, and creating it would ` +
            `turn that off. /specreview-review still carries the steps; to add the protocol, create ${tilde(c, agentsMd)} yourself and re-run.`,
        );
      } else {
        p.add(() => protocolAction(c, agentsMd));
      }
    }
    const cmd = opencodeCommand(c);
    p.add(() => copyAction(opencodeCommandFile(c), cmd.content, { source: OPENCODE_COMMAND, template: cmd.template, manifest: c.manifest }));
    const [config] = opencodeConfigs(c);
    p.add(() => mcpJsonAction(config, 'mcp', { type: 'local', command: [c.execPath, c.binPath, 'mcp'] }));
    p.note('Restart OpenCode to load the MCP server; /specreview-review <file> starts a review round.');
  },
  uninstall(c, p) {
    const agentsMd = c.scope === 'project' ? projectAgentsMd(c) : path.join(paths.opencode(c), 'AGENTS.md');
    p.add(() => removeProtocolAction(c, agentsMd, c.scope === 'project' ? 'agents-md' : undefined));
    const cmd = opencodeCommand(c);
    p.add(() => removeCopyAction(opencodeCommandFile(c), cmd.content, { template: cmd.template, manifest: c.manifest }));
    for (const config of opencodeConfigs(c)) p.add(() => removeMcpJsonAction(c, config, 'mcp'));
  },
};

// ---------------------------------------------------------------------------------------------------------------
// GitHub Copilot CLI, Amp, Factory Droid, Kiro CLI.

/** @type {AgentDef} */
const copilot = {
  id: 'copilot',
  name: 'GitHub Copilot CLI',
  aliases: ['copilot-cli'],
  scopes: ['user', 'project'],
  shares: ['agents-skill', 'agents-md'],
  sources: [
    'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions ($HOME/.copilot/copilot-instructions.md, COPILOT_HOME, AGENTS.md)',
    'github/docs content/copilot/reference (skills in ~/.agents/skills), per research-other-agents.md 2.6',
  ],
  detect: (c) => detection(c, [dirHit(c, paths.copilot(c)), binHit(c, 'copilot')]),
  install(c, p) {
    if (c.scope === 'project') projectProtocol(c, p);
    else p.add(() => protocolAction(c, path.join(paths.copilot(c), 'copilot-instructions.md')));
    p.add(() => skillAction(c));
    p.note('Run the skill with /specreview-review.');
  },
  uninstall(c, p) {
    if (c.scope === 'project') p.add(() => removeProtocolAction(c, projectAgentsMd(c), 'agents-md'));
    else p.add(() => removeProtocolAction(c, path.join(paths.copilot(c), 'copilot-instructions.md')));
    p.add(() => removeSkillAction(c));
  },
};

/** @type {AgentDef} */
const amp = {
  id: 'amp',
  name: 'Amp',
  scopes: ['user', 'project'],
  shares: ['agents-skill', 'agents-md'],
  sources: [
    'https://ampcode.com/docs/customize/agents-md (~/.config/amp/AGENTS.md)',
    'https://ampcode.com/docs/customize/skills (~/.agents/skills)',
  ],
  detect: (c) => detection(c, [dirHit(c, paths.amp(c)), binHit(c, 'amp')]),
  install(c, p) {
    if (c.scope === 'project') projectProtocol(c, p);
    else p.add(() => protocolAction(c, path.join(paths.amp(c), 'AGENTS.md')));
    p.add(() => skillAction(c));
  },
  uninstall(c, p) {
    if (c.scope === 'project') p.add(() => removeProtocolAction(c, projectAgentsMd(c), 'agents-md'));
    else p.add(() => removeProtocolAction(c, path.join(paths.amp(c), 'AGENTS.md')));
    p.add(() => removeSkillAction(c));
  },
};

/** @type {AgentDef} */
const droid = {
  id: 'droid',
  name: 'Factory Droid',
  aliases: ['factory'],
  scopes: ['user', 'project'],
  shares: ['agents-skill', 'agents-md'],
  sources: [
    'https://docs.factory.com/harness/skills (~/.agents/skills, invoked as /skill-name)',
    'https://docs.factory.com/harness/agents-md (AGENTS.md from the cwd up to the git root; no documented global file)',
  ],
  detect: (c) => detection(c, [dirHit(c, paths.factory(c)), binHit(c, 'droid')]),
  install(c, p) {
    if (c.scope === 'project') projectProtocol(c, p);
    else p.note('Droid documents no global instructions file, so only the skill is installed: run it with /specreview-review.');
    p.add(() => skillAction(c));
  },
  uninstall(c, p) {
    if (c.scope === 'project') p.add(() => removeProtocolAction(c, projectAgentsMd(c), 'agents-md'));
    p.add(() => removeSkillAction(c));
  },
};

/** @param {Ctx} c */
const kiroBase = (c) => (c.scope === 'project' ? path.join(c.root, '.kiro') : paths.kiro(c));

/** @type {AgentDef} */
const kiro = {
  id: 'kiro',
  name: 'Kiro CLI',
  aliases: ['kiro-cli'],
  scopes: ['user', 'project'],
  shares: [],
  sources: [
    'https://kiro.dev/docs/steering/ (~/.kiro/steering/*.md, front matter inclusion: always, CLI support)',
    'https://kiro.dev/docs/skills/ (~/.kiro/skills/<name>/SKILL.md; ~/.agents/skills is not read)',
  ],
  detect: (c) => detection(c, [dirHit(c, paths.kiro(c)), binHit(c, 'kiro-cli')]),
  install(c, p) {
    const steer = kiroSteering(c);
    p.add(() =>
      copyAction(path.join(kiroBase(c), 'steering', 'specreview.md'), steer.content, {
        source: AGENTS_SNIPPET, template: steer.template, manifest: c.manifest, note: `steering file (inclusion: always) with the protocol from ${rel(AGENTS_SNIPPET)}`,
      }),
    );
    p.add(() => skillAction(c, path.join(kiroBase(c), 'skills', SKILL_NAME), ''));
    p.note('Custom Kiro agents load steering and skills only when their resources list them; the default agent loads both.');
  },
  uninstall(c, p) {
    const steer = kiroSteering(c);
    p.add(() => removeCopyAction(path.join(kiroBase(c), 'steering', 'specreview.md'), steer.content, { template: steer.template, manifest: c.manifest }));
    p.add(() => removeSkillAction(c, path.join(kiroBase(c), 'skills', SKILL_NAME), ''));
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Claude Desktop (no shell: MCP only).

/** @type {AgentDef} */
const claudeDesktop = {
  id: 'claude-desktop',
  name: 'Claude Desktop',
  aliases: ['desktop'],
  scopes: ['user'],
  shares: [],
  sources: ['https://modelcontextprotocol.io/docs/develop/connect-local-servers (claude_desktop_config.json on macOS and Windows)'],
  detect(c) {
    const dir = paths.claudeDesktop(c);
    return detection(c, [dir ? dirHit(c, dir) : null]);
  },
  install(c, p) {
    const dir = paths.claudeDesktop(c);
    if (!dir) {
      p.skip('Claude Desktop keeps its config in a documented place only on macOS and Windows');
      return;
    }
    p.add(() => mcpJsonAction(path.join(dir, 'claude_desktop_config.json'), 'mcpServers', stdioCommand(c)));
    p.note('Quit and reopen Claude Desktop to start the MCP server.');
  },
  uninstall(c, p) {
    const dir = paths.claudeDesktop(c);
    if (dir) p.add(() => removeMcpJsonAction(c, path.join(dir, 'claude_desktop_config.json'), 'mcpServers'));
  },
};

/** Every agent the installer configures, in display order. */
export const AGENTS = [claude, codex, gemini, cursor, opencode, copilot, amp, droid, kiro, claudeDesktop];

/**
 * Agents researched but not configured: their file-based surfaces are not verified well enough to write.
 * @type {Array<{ id: string, name: string, aliases?: string[], reason: string, detect: (c: Ctx) => Detection }>}
 */
export const UNVERIFIED = [
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    aliases: ['agy'],
    reason:
      'its skills and MCP config live in different places for the desktop app/IDE (~/.gemini/config/) and the agy CLI (~/.gemini/antigravity-cli/), ' +
      'and the docs disagree about the CLI. It does read ~/.gemini/GEMINI.md, which the Gemini CLI target writes.',
    detect: (c) => detection(c, [binHit(c, 'agy', 'antigravity'), dirHit(c, path.join(c.home, '.gemini', 'config')), dirHit(c, path.join(c.home, '.gemini', 'antigravity-cli'))]),
  },
  {
    id: 'devin',
    name: 'Devin Desktop (Windsurf)',
    aliases: ['windsurf'],
    reason:
      'its binary names are unverified and its only global rules file (~/.codeium/windsurf/memories/global_rules.md) is capped at 6,000 characters. ' +
      'It reads ~/.agents/skills, which the Codex, Cursor, Copilot, Amp and Droid targets write.',
    detect: (c) => detection(c, [binHit(c, 'windsurf', 'devin'), dirHit(c, path.join(c.home, '.codeium', 'windsurf')), dirHit(c, path.join(c.home, '.config', 'devin'))]),
  },
];

/**
 * Resolves an agent name or alias.
 * @param {string} name
 * @returns {{ id: string, unverified: boolean } | null}
 */
export function resolveAgentId(name) {
  const n = name.trim().toLowerCase();
  for (const a of AGENTS) if (a.id === n || a.aliases?.includes(n)) return { id: a.id, unverified: false };
  for (const a of UNVERIFIED) if (a.id === n || a.aliases?.includes(n)) return { id: a.id, unverified: true };
  return null;
}
