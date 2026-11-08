// @ts-check
// Are the Suiko instructions an agent reads older than the CLI it runs? `npm install -g` (or `git pull`) updates the
// CLI but not the copies `suiko install` made (the Claude Code skill and commands in ~/.claude, the protocol blocks in
// AGENTS.md / GEMINI.md / ..., the shared skill in ~/.agents/skills): an agent then keeps following the old protocol.
//
// staleInstructions(ctx, version): a dry run of every agent's installer for the context's scope (agents.js; nothing is
//   written), keeping the instruction files Suiko wrote that exist and are stale:
//     - a whole-file copy (skill, command, steering file) that install would change, whose install mark names an older
//       version, or that has no install mark at all (written before marks existed);
//     - a protocol block (between the specreview markers) whose mark names an older version, or that has no mark
//       and differs from the block install writes now.
//   A file whose mark names this version or a newer one is current, edited or not (an edit is the user's business).
//   MCP and hook entries carry no instructions and are not checked. Never throws: a file that cannot be read or
//   planned is skipped.
//   Each stale file names the command that updates it, and nothing else (`suiko install` alone would also configure
//   every other agent it detects):
//     - `agent`: the agent whose install writes it (`suiko install --only <agent> --apply`). A file several agents
//       share (the shared skill in ~/.agents/skills, a project's AGENTS.md) goes to an agent already named for
//       another stale file, else to the one whose install would write the least besides the stale files, a detected
//       agent first, then one with Suiko files of its own here, then the display order; only agents in use here
//       (detected, or with other Suiko files here) are considered while there is one;
//     - `via: 'agents-md'`: a project's AGENTS.md block that no agent's install accounts for (no other Suiko file of
//       an agent that writes it is in the project, and the block has no not-on-PATH note, which only `suiko install`
//       writes) is the one `suiko install agents-md` wrote: that command updates it.
// freshnessLine(stale): one line about them. Only the Claude Code skill / commands: "Your Suiko skill for Claude Code is
//   from 0.3.1; run `suiko install --only claude --apply` to update it."; otherwise "Your Suiko instructions (Claude
//   Code skill, Codex CLI, AGENTS.md) are from 0.3.1; run ... to update them." (a file several agents share is named
//   by its place). The version is the oldest one named, or "an earlier Suiko version" when a file has no mark; the
//   commands (installCommands): `suiko install --only <ids> --apply` for user-scope files, `suiko install --project
//   --only <ids> --apply` for the project's, `suiko install agents-md --apply` for a block that command wrote.
// freshnessNotes(rt): what `suiko open` prints (stderr): that line for the user's and the current project's installs,
//   or nothing.
// staleByAgent(ctx, version): agent id -> its stale files, for `suiko doctor`'s per-agent lines (the same commands).
// olderThan(a, b): SemVer precedence (prereleases compared per identifier, as SemVer 2.0.0 section 11 says).

import path from 'node:path';
import { packageVersion } from '../daemon-client.js';
import { AGENTS, Planner } from './agents.js';
import { MD_MARKERS, findBlock, installedVersion, readTextOrNull, stripInstallMarks, stripInvocationNote } from './files.js';

/**
 * @typedef {import('./agents.js').Ctx} Ctx
 * @typedef {import('./agents.js').AgentDef} AgentDef
 * @typedef {import('../install.js').FileAction} FileAction
 * @typedef {{ agent: string, label: string, scope: 'user' | 'project', file: string, version: string | null,
 *   via?: 'agents-md' }} Stale
 *   `agent`: the agent whose install updates it (see the header); `label`: how the line names it (the agent, or the
 *   place of a file several agents share); `version`: the version its install mark names, null: no mark (older than
 *   install marks); `via: 'agents-md'`: a project AGENTS.md block `suiko install agents-md` wrote
 */

/**
 * Stale instruction files of one scope (see the header).
 * @param {Ctx} ctx
 * @param {string} [version] the running CLI's version
 * @returns {Stale[]}
 */
export function staleInstructions(ctx, version = packageVersion()) {
  const plans = AGENTS.map((def) => ({ def, files: planOf(def, ctx, 'install') }));
  /** @type {Map<string, { f: FileAction, current: string, version: string | null, writers: AgentDef[] }>} */
  const found = new Map();
  /** @type {Set<string>} files checked and current */
  const fresh = new Set();
  for (const { def, files } of plans) {
    for (const f of files) {
      const hit = found.get(f.path);
      if (hit) {
        if (!hit.writers.includes(def)) hit.writers.push(def);
        continue;
      }
      if (fresh.has(f.path)) continue;
      const current = f.action === 'update' ? readTextOrNull(f.path) : null;
      const v = current === null ? undefined : staleVersion(f, current, version);
      if (current === null || v === undefined) {
        fresh.add(f.path);
        continue;
      }
      found.set(f.path, { f, current, version: v, writers: [def] });
    }
  }
  if (!found.size) return [];
  const owner = ownerOf(ctx, plans, new Set(found.keys()));
  /** @type {Stale[]} */
  const out = [];
  // files one agent writes first: an agent named for them takes the shared files it writes too
  const entries = [...found.values()].sort((a, b) => Number(a.writers.length > 1) - Number(b.writers.length > 1));
  for (const s of entries) {
    const o = owner(s.f, s.current, s.writers);
    out.push({
      agent: o.def.id,
      label: labelOf(o.def, s.f, ctx),
      scope: ctx.scope,
      file: s.f.path,
      version: s.version,
      ...(o.agentsMd ? { via: /** @type {const} */ ('agents-md') } : {}),
    });
  }
  // back in the order the installer plans them (agents, then their files)
  const order = [...found.keys()];
  return out.sort((a, b) => order.indexOf(a.file) - order.indexOf(b.file));
}

/**
 * An agent's install or uninstall plan in this scope ([] when it cannot be planned or has no such scope).
 * @param {AgentDef} def
 * @param {Ctx} ctx
 * @param {'install' | 'uninstall'} mode
 * @returns {FileAction[]}
 */
function planOf(def, ctx, mode) {
  if (!def.scopes.includes(ctx.scope)) return [];
  const p = new Planner();
  try {
    def[mode](ctx, p);
  } catch {
    return [];
  }
  return p.skipped ? [] : p.files;
}

/**
 * Picks who updates each stale file (see the header): returns, for a stale file and the agents whose install writes
 * it, the agent to name and whether the file is a project AGENTS.md block of `suiko install agents-md`.
 * @param {Ctx} ctx
 * @param {Array<{ def: AgentDef, files: FileAction[] }>} plans install plans of every agent
 * @param {Set<string>} stale paths of the stale files
 * @returns {(f: FileAction, current: string, writers: AgentDef[]) => { def: AgentDef, agentsMd: boolean }}
 */
function ownerOf(ctx, plans, stale) {
  /** @type {Set<string>} agent ids named so far */
  const named = new Set();
  /** @type {Map<string, string[]>} */
  const present = new Map();
  /** @type {Map<string, boolean>} */
  const detected = new Map();
  // the agent's Suiko files that exist here (its uninstall plan: what it would remove or keep)
  const presentOf = (/** @type {AgentDef} */ d) => {
    if (!present.has(d.id)) present.set(d.id, planOf(d, ctx, 'uninstall').filter((x) => x.action !== 'unchanged' || x.kept).map((x) => x.path));
    return /** @type {string[]} */ (present.get(d.id));
  };
  const isDetected = (/** @type {AgentDef} */ d) => {
    if (!detected.has(d.id)) {
      let hit = false;
      try {
        hit = d.detect(ctx).detected;
      } catch {
        hit = false;
      }
      detected.set(d.id, hit);
    }
    return /** @type {boolean} */ (detected.get(d.id));
  };
  // what its install would write besides the stale files
  const extra = (/** @type {AgentDef} */ d) =>
    (plans.find((x) => x.def === d)?.files ?? []).filter((x) => x.action !== 'unchanged' && !stale.has(x.path)).length;
  const order = (/** @type {AgentDef} */ d) => AGENTS.indexOf(d);

  return (f, current, writers) => {
    const others = (/** @type {AgentDef} */ d) => presentOf(d).some((p) => p !== f.path);
    if (ctx.scope === 'project' && f.share === 'agents-md' && !hasInvocationNote(current) && !writers.some(others)) {
      return { def: writers[0], agentsMd: true };
    }
    let pick = writers[0];
    if (writers.length > 1) {
      const inUse = writers.filter((d) => isDetected(d) || others(d));
      const ranked = (inUse.length ? inUse : writers).map((d) => ({
        d,
        key: [named.has(d.id) ? 0 : 1, extra(d), isDetected(d) ? 0 : 1, others(d) ? 0 : 1, order(d)],
      }));
      ranked.sort((a, b) => {
        for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
        return 0;
      });
      pick = ranked[0].d;
    }
    named.add(pick.id);
    return { def: pick, agentsMd: false };
  };
}

/**
 * Whether the Suiko block in a file carries the not-on-PATH note (only `suiko install` writes it, never
 * `suiko install agents-md`).
 * @param {string} text
 * @returns {boolean}
 */
function hasInvocationNote(text) {
  const at = findBlock(text, MD_MARKERS);
  const block = at ? text.slice(at.start, at.end) : text;
  return stripInvocationNote(block) !== block;
}

/**
 * Stale files by the agent whose install updates them (doctor).
 * @param {Ctx} ctx
 * @param {string} [version]
 * @returns {Map<string, Stale[]>}
 */
export function staleByAgent(ctx, version = packageVersion()) {
  /** @type {Map<string, Stale[]>} */
  const out = new Map();
  for (const s of staleInstructions(ctx, version)) out.set(s.agent, [...(out.get(s.agent) ?? []), s]);
  return out;
}

/**
 * Whether a planned update of an existing file replaces stale Suiko instructions: the version the old ones name (null:
 * no mark), or undefined when they are current or not Suiko's instructions at all.
 * @param {FileAction} f
 * @param {string} current
 * @param {string} version
 * @returns {string | null | undefined}
 */
function staleVersion(f, current, version) {
  if (f.record) {
    // a whole-file copy (copyAction): Suiko's by its place
    const v = installedVersion(current);
    if (v === null) return stripInstallMarks(current) === stripInstallMarks(f.content) ? undefined : null;
    return olderThan(v, version) ? v : undefined;
  }
  const old = findBlock(current, MD_MARKERS);
  const neu = findBlock(f.content, MD_MARKERS);
  if (!old || !neu) return undefined; // JSON / TOML entries, or no Suiko block yet
  const oldBlock = current.slice(old.start, old.end);
  const v = installedVersion(oldBlock);
  if (v === null) return stripInstallMarks(oldBlock) === stripInstallMarks(f.content.slice(neu.start, neu.end)) ? undefined : null;
  return olderThan(v, version) ? v : undefined;
}

/**
 * Whether semantic version `a` is older than `b` (SemVer precedence: a prerelease is older than its release, and
 * prereleases compare per identifier). Unparsable: false.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function olderThan(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i];
  return comparePrerelease(pa.pre, pb.pre) < 0;
}

/**
 * SemVer 2.0.0 precedence of two prerelease strings ('' = none: the release, which ranks above any prerelease of
 * it): their dot-separated identifiers from left to right, numeric ones compared numerically and ranking below
 * alphanumeric ones, alphanumeric ones in ASCII order; when every identifier is equal, the shorter list ranks lower
 * (1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0).
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when `a` ranks lower, 0 when equal, positive when higher
 */
function comparePrerelease(a, b) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const x = a.split('.');
  const y = b.split('.');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = compareIdentifier(x[i], y[i]);
    if (c) return c;
  }
  return x.length - y.length;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareIdentifier(a, b) {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) {
    // numerically, without a precision limit: by length once leading zeros are gone, then digit by digit
    const da = a.replace(/^0+(?=\d)/, '');
    const db = b.replace(/^0+(?=\d)/, '');
    return da.length - db.length || (da < db ? -1 : da > db ? 1 : 0);
  }
  if (na !== nb) return na ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * @param {string} v
 * @returns {{ nums: number[], pre: string } | null}
 */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim());
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' } : null;
}

/**
 * The line about stale instructions (see the header), or null when there are none.
 * @param {Stale[]} stale
 * @returns {string | null}
 */
export function freshnessLine(stale) {
  if (!stale.length) return null;
  const labels = [...new Set(stale.map((s) => s.label))];
  const claudeOnly = labels.length === 1 && labels[0] === CLAUDE_LABEL;
  const versions = stale.map((s) => s.version);
  const oldest = versions.includes(null) ? null : /** @type {string[]} */ (versions).reduce((a, b) => (olderThan(b, a) ? b : a));
  const from = oldest ?? 'an earlier Suiko version';
  const run = installCommands(stale).map((c) => `\`${c}\``).join(' and ');
  if (claudeOnly) return `Your Suiko skill for Claude Code is from ${from}; run ${run} to update it.`;
  return `Your Suiko instructions (${labels.join(', ')}) are from ${from}; run ${run} to update them.`;
}

/**
 * The commands that update the stale files and nothing else (see the header): `suiko install --only <ids> --apply`
 * for user-scope files, `suiko install --project --only <ids> --apply` for the project's (ids in display order),
 * `suiko install agents-md --apply` for a project AGENTS.md block that command wrote.
 * @param {Stale[]} stale
 * @returns {string[]}
 */
export function installCommands(stale) {
  const ids = (/** @type {'user' | 'project'} */ scope) =>
    [...new Set(stale.filter((s) => s.scope === scope && s.via !== 'agents-md').map((s) => s.agent))].sort((a, b) => agentOrder(a) - agentOrder(b));
  /** @type {string[]} */
  const out = [];
  const user = ids('user');
  if (user.length) out.push(`suiko install --only ${user.join(',')} --apply`);
  const project = ids('project');
  if (project.length) out.push(`suiko install --project --only ${project.join(',')} --apply`);
  if (stale.some((s) => s.via === 'agents-md')) out.push('suiko install agents-md --apply');
  return out;
}

/**
 * @param {string} id
 * @returns {number} display order of an agent id (unknown ids last)
 */
function agentOrder(id) {
  const i = AGENTS.findIndex((d) => d.id === id);
  return i < 0 ? AGENTS.length : i;
}

const CLAUDE_LABEL = 'Claude Code skill';

/**
 * How the line names a stale file: the Claude Code skill (its commands too), the agent that reads it, or for a file
 * several agents share, its place.
 * @param {AgentDef} def
 * @param {FileAction} f
 * @param {Ctx} ctx
 * @returns {string}
 */
function labelOf(def, f, ctx) {
  if (def.id === 'claude') return CLAUDE_LABEL;
  if (f.share === 'agents-md') return 'AGENTS.md';
  if (f.share === 'agents-skill') return ctx.scope === 'project' ? '.agents/skills' : '~/.agents/skills';
  return def.name;
}

/**
 * The notes `suiko open` prints: the freshness line for the user's and the current project's installs (at most one
 * line; [] when everything is current, the home directory is unknown, or anything goes wrong).
 * @param {import('../runtime.js').Runtime} rt
 * @returns {Promise<string[]>}
 */
export async function freshnessNotes(rt) {
  try {
    if (!(rt.deps.home ?? rt.env.HOME ?? rt.env.USERPROFILE)) return [];
    const { buildContext } = await import('./multi.js');
    const user = buildContext(rt, { scope: 'user' });
    const stale = staleInstructions(user);
    // the project's own installs (`suiko install --project`, `suiko install agents-md`), unless the project is the
    // home directory itself
    const project = buildContext(rt, { scope: 'project' });
    if (path.resolve(project.root) !== path.resolve(project.home)) stale.push(...staleInstructions(project).filter((s) => !stale.some((u) => u.file === s.file)));
    const line = freshnessLine(stale);
    return line ? [line] : [];
  } catch {
    return [];
  }
}
