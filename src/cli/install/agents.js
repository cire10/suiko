// @ts-check
// Agent definitions for `specreview install` (no target) and `specreview uninstall`. Each agent detects itself
// (config dir and/or binary on PATH, honouring CLAUDE_CONFIG_DIR, CODEX_HOME, GEMINI_CLI_HOME, XDG_CONFIG_HOME and
// COPILOT_HOME) and plans FileActions for install and uninstall through a Planner. Only surfaces verified in the
// agent's official docs are written (sources below); everything else is listed as unverified and never touched.
//
//   claude          skill + every command file + hooks (PreToolUse Write, UserPromptSubmit) + plan-mode gate
//                   (PermissionRequest/ExitPlanMode) in settings.json, absolute node/script paths; refuses when the
//                   SpecReview plugin is installed (the hooks would run twice)
//   codex           protocol block in $CODEX_HOME/AGENTS.md (AGENTS.override.md when that is in use), the shared skill
//                   in ~/.agents/skills, [mcp_servers.specreview] in a marked block of config.toml
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

import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT } from '../daemon-client.js';
import { AGENTS_SNIPPET, claudeCopies, describeHookEntries, hookEntries, isOnPath, mergeHooks, removeOurHooks } from '../install.js';
import {
  GEMINI_COMMAND, OPENCODE_COMMAND, SKILL_NAME, SKILL_TEMPLATE, agentSkill, codexTomlBlock, geminiCommand, kiroSteering,
  opencodeCommand, protocolBlock,
} from './content.js';
import {
  InstallRefusal, MD_MARKERS, TOML_MARKERS, blockAction, copyAction, deleteEntry, jsonAction, readTextOrNull,
  removeBlock, removeBlockAction, removeCopyAction, setEntry,
} from './files.js';

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
 * Lenient JSON read for detection only (never throws).
 * @param {string} file
 * @returns {any}
 */
function readJsonLenient(file) {
  const text = readTextOrNull(file);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
 * @param {string} file
 * @param {string} [share]
 * @returns {FileAction | null}
 */
function removeProtocolAction(file, share) {
  return removeBlockAction(file, MD_MARKERS, { what: PROTOCOL, share });
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
 * @param {string} file
 * @param {string} container
 * @returns {FileAction | null}
 */
function removeMcpJsonAction(file, container) {
  return jsonAction(file, (o) => deleteEntry(o, container, 'specreview'), { note: `removes ${container}.specreview; other entries kept`, deleteWhenEmpty: true, fix: `remove "specreview" from "${container}" by hand` });
}

/** @param {Ctx} c */
function stdioCommand(c) {
  return { command: c.execPath, args: [c.binPath, 'mcp'] };
}

// ---------------------------------------------------------------------------------------------------------------
// Claude Code.

/**
 * The SpecReview Claude Code plugin, when installed and not disabled (user plugins or the project's settings).
 * @param {Ctx} c
 * @returns {{ id: string, where: string } | null}
 */
export function claudePlugin(c) {
  const home = paths.claude(c);
  const installedFile = path.join(home, 'plugins', 'installed_plugins.json');
  const installed = readJsonLenient(installedFile);
  const ids = new Set();
  const registry = installed && typeof installed === 'object' ? (installed.plugins && typeof installed.plugins === 'object' ? installed.plugins : installed) : {};
  for (const key of Object.keys(registry)) if (/^specreview@/.test(key)) ids.add(key);
  /** @type {Record<string, { value: unknown, file: string }>} */
  const enabled = {};
  const settingsFiles = [path.join(home, 'settings.json'), path.join(c.root, '.claude', 'settings.json'), path.join(c.root, '.claude', 'settings.local.json')];
  for (const file of settingsFiles) {
    const s = readJsonLenient(file);
    const map = s && typeof s.enabledPlugins === 'object' && s.enabledPlugins ? s.enabledPlugins : {};
    for (const [k, v] of Object.entries(map)) if (/^specreview@/.test(k)) enabled[k] = { value: v, file };
  }
  for (const id of ids) if (enabled[id]?.value !== false) return { id, where: tilde(c, installedFile) };
  for (const [id, e] of Object.entries(enabled)) if (e.value) return { id, where: `enabledPlugins in ${tilde(c, e.file)}` };
  return null;
}

/** @param {Ctx} c */
const claudeBase = (c) => (c.scope === 'project' ? path.join(c.root, '.claude') : paths.claude(c));

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
    'https://code.claude.com/docs/en/settings',
  ],
  detect: (c) => detection(c, [dirHit(c, paths.claude(c)), binHit(c, 'claude')]),
  install(c, p) {
    const plugin = claudePlugin(c);
    if (plugin) {
      p.skip(
        `the SpecReview Claude Code plugin is installed (${plugin.id}, ${plugin.where}). It already provides the skill, the commands and the hooks; ` +
          'installing them into settings.json as well would run every hook twice. To switch to the settings install (absolute paths, so it works when ' +
          `Claude Code does not see your shell PATH), run \`claude plugin uninstall ${plugin.id}\`, then re-run this install.`,
      );
      return;
    }
    const base = claudeBase(c);
    for (const cp of claudeCopies(base, c)) {
      p.add(() => copyAction(cp.target, cp.content, { source: cp.source, template: cp.template, manifest: c.manifest }));
    }
    const entries = hookEntries({ execPath: c.execPath, binPath: c.binPath, planGate: true, hooks: true });
    p.add(() =>
      jsonAction(path.join(base, 'settings.json'), (s) => mergeHooks(s, entries), {
        note: `hooks: ${describeHookEntries(entries)}; other settings kept`,
        detail: JSON.stringify({ hooks: entries }, null, 2),
        fix: 'add the hooks shown above under "hooks" by hand',
      }),
    );
    p.note('Plan mode: when Claude calls ExitPlanMode, the plan opens in SpecReview; approving it there approves the plan, and the terminal dialog stays usable.');
  },
  uninstall(c, p) {
    const base = claudeBase(c);
    for (const cp of claudeCopies(base, c)) {
      p.add(() => removeCopyAction(cp.target, cp.content, { template: cp.template, manifest: c.manifest, rmdirs: cp.dir.endsWith('spec-review') ? [cp.dir] : [] }));
    }
    p.add(() => jsonAction(path.join(base, 'settings.json'), (s) => removeOurHooks(s), { note: 'removes the SpecReview hooks; other settings kept', deleteWhenEmpty: true }));
    const plugin = claudePlugin(c);
    if (plugin) p.note(`The SpecReview plugin is still installed (${plugin.id}); remove it with \`claude plugin uninstall ${plugin.id}\`.`);
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

/**
 * The [mcp_servers.specreview] block in config.toml. A definition outside our markers (e.g. from `codex mcp add`)
 * is left alone: adding ours would make the TOML invalid.
 * @param {Ctx} c
 * @param {Planner} p
 */
function codexMcp(c, p) {
  const file = codexConfig(c);
  const current = readTextOrNull(file) ?? '';
  const outside = removeBlock(current, TOML_MARKERS) ?? current;
  if (/^\s*\[\s*mcp_servers\s*\.\s*(?:"specreview"|'specreview'|specreview)\s*[\].]/m.test(outside) || /^\s*mcp_servers\s*\.\s*specreview\b/m.test(outside)) {
    p.note(`${tilde(c, file)} already defines the specreview MCP server outside SpecReview's managed block; left as is.`);
    return;
  }
  if (/^\s*mcp_servers\s*=/m.test(outside)) {
    p.note(`${tilde(c, file)} defines mcp_servers inline, so a [mcp_servers.specreview] table cannot be added safely; add it to that inline table by hand.`);
    return;
  }
  p.add(() => blockAction(file, codexTomlBlock(c), TOML_MARKERS, { what: 'the [mcp_servers.specreview] table', showBlock: true }));
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
      p.add(() => protocolAction(c, projectAgentsMd(c), 'agents-md'));
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
      p.add(() => removeProtocolAction(projectAgentsMd(c), 'agents-md'));
    } else {
      p.add(() => removeProtocolAction(path.join(paths.codex(c), 'AGENTS.md')));
      p.add(() => removeProtocolAction(path.join(paths.codex(c), 'AGENTS.override.md')));
    }
    p.add(() => removeSkillAction(c));
    p.add(() => removeBlockAction(codexConfig(c), TOML_MARKERS, { what: 'the [mcp_servers.specreview] table' }));
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Gemini CLI.

/**
 * The context file Gemini CLI loads: GEMINI.md unless settings.json names others (context.fileName).
 * @param {string} settingsFile
 * @returns {string[]} file names; the first is where the block goes
 */
function geminiContextNames(settingsFile) {
  const s = readJsonLenient(settingsFile);
  const raw = s?.context?.fileName ?? s?.contextFileName;
  const names = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).filter((n) => typeof n === 'string' && n && !n.includes('/'));
  if (!names.length || names.includes('GEMINI.md')) return ['GEMINI.md', ...names.filter((n) => n !== 'GEMINI.md')];
  return names;
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
    const [name] = geminiContextNames(geminiSettings(c));
    p.add(() => protocolAction(c, path.join(geminiBase(c), name)));
    const cmd = geminiCommand(c);
    p.add(() => copyAction(geminiCommandFile(c), cmd.content, { source: GEMINI_COMMAND, template: cmd.template, manifest: c.manifest }));
    p.note('/specreview-review <file> starts a review round; in a running session, /memory reload and /commands reload pick up the changes.');
  },
  uninstall(c, p) {
    for (const name of geminiContextNames(geminiSettings(c))) p.add(() => removeProtocolAction(path.join(geminiBase(c), name)));
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
    if (c.scope === 'project') p.add(() => protocolAction(c, projectAgentsMd(c), 'agents-md'));
    else p.note("Cursor's global User Rules live in its settings, not in a file, so the protocol comes with the /specreview-review skill and the MCP tools.");
    p.note('Reload Cursor (or toggle specreview in Settings > MCP) to start the MCP server.');
  },
  uninstall(c, p) {
    p.add(() => removeMcpJsonAction(cursorMcp(c), 'mcpServers'));
    p.add(() => removeSkillAction(c));
    if (c.scope === 'project') p.add(() => removeProtocolAction(projectAgentsMd(c), 'agents-md'));
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
    const agentsMd = c.scope === 'project' ? projectAgentsMd(c) : path.join(paths.opencode(c), 'AGENTS.md');
    const claudeMd = c.scope === 'project' ? path.join(c.root, 'CLAUDE.md') : path.join(c.home, '.claude', 'CLAUDE.md');
    const fallbackOff = c.env.OPENCODE_DISABLE_CLAUDE_CODE || (c.scope === 'user' && c.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT);
    if (readTextOrNull(agentsMd) === null && isFile(claudeMd) && !fallbackOff) {
      p.note(
        `Skipped ${PROTOCOL}: OpenCode reads ${tilde(c, claudeMd)} as its rules only while ${tilde(c, agentsMd)} does not exist, and creating it would ` +
          `turn that off. /specreview-review still carries the steps; to add the protocol, create ${tilde(c, agentsMd)} yourself and re-run.`,
      );
    } else {
      p.add(() => protocolAction(c, agentsMd, c.scope === 'project' ? 'agents-md' : undefined));
    }
    const cmd = opencodeCommand(c);
    p.add(() => copyAction(opencodeCommandFile(c), cmd.content, { source: OPENCODE_COMMAND, template: cmd.template, manifest: c.manifest }));
    const [config] = opencodeConfigs(c);
    p.add(() => mcpJsonAction(config, 'mcp', { type: 'local', command: [c.execPath, c.binPath, 'mcp'] }));
    p.note('Restart OpenCode to load the MCP server; /specreview-review <file> starts a review round.');
  },
  uninstall(c, p) {
    const agentsMd = c.scope === 'project' ? projectAgentsMd(c) : path.join(paths.opencode(c), 'AGENTS.md');
    p.add(() => removeProtocolAction(agentsMd, c.scope === 'project' ? 'agents-md' : undefined));
    const cmd = opencodeCommand(c);
    p.add(() => removeCopyAction(opencodeCommandFile(c), cmd.content, { template: cmd.template, manifest: c.manifest }));
    for (const config of opencodeConfigs(c)) p.add(() => removeMcpJsonAction(config, 'mcp'));
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
    if (c.scope === 'project') p.add(() => protocolAction(c, projectAgentsMd(c), 'agents-md'));
    else p.add(() => protocolAction(c, path.join(paths.copilot(c), 'copilot-instructions.md')));
    p.add(() => skillAction(c));
    p.note('Run the skill with /specreview-review.');
  },
  uninstall(c, p) {
    if (c.scope === 'project') p.add(() => removeProtocolAction(projectAgentsMd(c), 'agents-md'));
    else p.add(() => removeProtocolAction(path.join(paths.copilot(c), 'copilot-instructions.md')));
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
    if (c.scope === 'project') p.add(() => protocolAction(c, projectAgentsMd(c), 'agents-md'));
    else p.add(() => protocolAction(c, path.join(paths.amp(c), 'AGENTS.md')));
    p.add(() => skillAction(c));
  },
  uninstall(c, p) {
    if (c.scope === 'project') p.add(() => removeProtocolAction(projectAgentsMd(c), 'agents-md'));
    else p.add(() => removeProtocolAction(path.join(paths.amp(c), 'AGENTS.md')));
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
    if (c.scope === 'project') p.add(() => protocolAction(c, projectAgentsMd(c), 'agents-md'));
    else p.note('Droid documents no global instructions file, so only the skill is installed: run it with /specreview-review.');
    p.add(() => skillAction(c));
  },
  uninstall(c, p) {
    if (c.scope === 'project') p.add(() => removeProtocolAction(projectAgentsMd(c), 'agents-md'));
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
    if (dir) p.add(() => removeMcpJsonAction(path.join(dir, 'claude_desktop_config.json'), 'mcpServers'));
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
