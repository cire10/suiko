// @ts-check
// The multi-agent installer behind `suiko install` (no target) and `suiko uninstall`:
//   1. detect every agent of AGENTS (config dirs, binaries on PATH);
//   2. select: --only <list> (configured even when not detected), else the detected agents (uninstall: every agent,
//      since removal only touches what Suiko wrote); --skip <list> removes agents;
//   3. plan each selected agent (Planner), deduplicate files written for several agents (the shared skill in
//      ~/.agents/skills, a project AGENTS.md), and on uninstall keep a shared file while an agent left out of the
//      uninstall still uses it (stillUsesShared);
//   4. dry run: describe; --apply: applyPlan with one-time backups and the install manifest.
// Per-file refusals (invalid JSON...) and write failures do not stop the other agents; they make the exit code 1.
// The node path written into agent configs is the unresolved one on PATH when it is this same node (Homebrew's
// /opt/homebrew/bin/node survives `brew upgrade`; process.execPath, the versioned Cellar path, does not).

import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from '../../shared/protocol.js';
import { UsageError } from '../../core/store/errors.js';
import { homeDir } from '../../core/store/home.js';
import { BIN_PATH, PACKAGE_ROOT } from '../daemon-client.js';
import { applyPlan, cliInvocation, isOnPath, projectRoot } from '../install.js';
import { AGENTS, Planner, UNVERIFIED, claudeDoubleInstall, claudePlugin } from './agents.js';
import { loadManifest } from './files.js';

/** @typedef {import('./agents.js').Ctx} Ctx */
/** @typedef {import('../install.js').FileAction} FileAction */

export const MANIFEST_FILE = 'install-manifest.json';

/**
 * @typedef {object} AgentReport
 * @property {string} id
 * @property {string} name
 * @property {boolean} detected
 * @property {string[]} evidence
 * @property {boolean} selected
 * @property {'not-detected' | 'skipped' | 'planned' | 'up-to-date' | 'configured' | 'removed' | 'nothing-to-remove' | 'failed'} status
 * @property {string} [reason] why it was skipped
 * @property {FileAction[]} files
 * @property {string[]} notes
 * @property {Array<{ file: string, message: string, fix?: string, failed?: boolean }>} refusals `failed`: a write error
 */

/**
 * @typedef {object} Report
 * @property {'install' | 'uninstall'} mode
 * @property {boolean} applied
 * @property {'user' | 'project'} scope
 * @property {AgentReport[]} agents
 * @property {Array<{ id: string, name: string, detected: boolean, evidence: string[], reason: string }>} unverified
 * @property {FileAction[]} changes deduplicated actions (what applyPlan gets)
 * @property {Map<string, string[]>} owners path -> agent ids that planned it
 * @property {string[]} written
 * @property {string[]} notes global notes
 * @property {Ctx} ctx
 */

/**
 * Builds the installer context from the runtime. HOME must be known (deps.home, $HOME or $USERPROFILE): the
 * installer never guesses which home directory to write into.
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ scope: 'user' | 'project', planGate?: boolean }} o
 * @returns {Ctx}
 */
export function buildContext(rt, o) {
  const env = rt.env;
  const home = rt.deps.home ?? env.HOME ?? env.USERPROFILE;
  if (!home) throw new Error('cannot tell your home directory: HOME is not set');
  const execPath = rt.deps.execPath ?? stableNodePath(env, process.execPath);
  const binPath = rt.deps.binPath ?? BIN_PATH;
  const pathEnv = env.PATH ?? '';
  return {
    home: path.resolve(home),
    env,
    platform: rt.deps.platform ?? process.platform,
    scope: o.scope,
    cwd: rt.cwd,
    root: projectRoot(rt.cwd),
    execPath,
    binPath,
    cliOnPath: isOnPath('suiko', pathEnv),
    invocation: cliInvocation({ execPath, binPath }),
    pathEnv,
    manifest: loadManifest(manifestPath(env)),
    ...(rt.deps.claudeHome ? { claudeHome: rt.deps.claudeHome } : {}),
    ...(o.planGate ? { planGate: true } : {}),
  };
}

/**
 * The node to write into agent configs: $SPECREVIEW_NODE (install.sh passes the `node` it found on PATH) or the
 * first `node` on PATH, when it resolves to the node running now; else `execPath`. process.execPath has its symlinks
 * resolved, so on Homebrew it is /opt/homebrew/Cellar/node/<version>/bin/node, which `brew upgrade` deletes; the PATH
 * entry /opt/homebrew/bin/node keeps working. Version-pinned installs (nvm, asdf, Volta) still change path when you
 * switch versions: re-run `suiko install --apply` then.
 * @param {Record<string, string | undefined>} env
 * @param {string} execPath
 * @returns {string}
 */
export function stableNodePath(env, execPath) {
  let real;
  try {
    real = fs.realpathSync(execPath);
  } catch {
    return execPath;
  }
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [env.SPECREVIEW_NODE, ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe))];
  for (const cand of candidates) {
    if (!cand || !path.isAbsolute(cand)) continue;
    try {
      fs.accessSync(cand, fs.constants.X_OK);
      if (fs.realpathSync(cand) === real) return cand;
    } catch {
      // not this one
    }
  }
  return execPath;
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function manifestPath(env) {
  return path.join(env.SPECREVIEW_HOME ? path.resolve(env.SPECREVIEW_HOME) : homeDir(), MANIFEST_FILE);
}

/**
 * Plans (and with `apply`, performs) an install or uninstall.
 * @param {Ctx} ctx
 * @param {{ mode: 'install' | 'uninstall', only?: Set<string> | null, skip?: Set<string>, apply?: boolean }} o
 * @returns {Report}
 */
export function runInstaller(ctx, o) {
  const skip = o.skip ?? new Set();
  /** @type {AgentReport[]} */
  const agents = [];
  /** @type {Map<string, FileAction>} */
  const byPath = new Map();
  /** @type {Map<string, string[]>} */
  const owners = new Map();
  /** @type {Map<string, import('./agents.js').Detection>} */
  const detections = new Map();
  /** @type {string[]} */
  const notes = [];

  for (const def of AGENTS) {
    const det = def.detect(ctx);
    detections.set(def.id, det);
    /** @type {AgentReport} */
    const r = { id: def.id, name: def.name, detected: det.detected, evidence: det.evidence, selected: false, status: 'not-detected', files: [], notes: [], refusals: [] };
    agents.push(r);
    const wanted = o.only ? o.only.has(def.id) : o.mode === 'uninstall' || det.detected;
    if (!wanted) {
      if (o.only) {
        // Left out by --only, whether or not it is installed: not "not detected".
        r.status = 'skipped';
        r.reason = NOT_IN_ONLY;
      }
      continue;
    }
    if (skip.has(def.id)) {
      r.status = 'skipped';
      r.reason = 'skipped with --skip';
      continue;
    }
    if (!def.scopes.includes(ctx.scope)) {
      r.status = 'skipped';
      r.reason = `${def.name} has no ${ctx.scope}-level configuration`;
      continue;
    }
    r.selected = true;
    const p = new Planner();
    if (o.mode === 'install') def.install(ctx, p);
    else def.uninstall(ctx, p);
    r.notes = p.notes;
    r.refusals = p.refusals;
    for (const n of p.globalNotes) if (!notes.includes(n)) notes.push(n);
    if (p.skipped) {
      r.status = 'skipped';
      r.reason = p.skipped;
      r.selected = false;
      continue;
    }
    if (o.mode === 'install' && !det.detected) r.notes.unshift(`${def.name} was not detected; configuring it because --only names it.`);
    r.files = p.files;
  }

  // Shared files on uninstall: keep them while an agent left out of this uninstall still uses them.
  if (o.mode === 'uninstall') {
    /** @type {Map<string, boolean>} */
    const uses = new Map();
    const stillUses = (/** @type {import('./agents.js').AgentDef} */ d) => {
      if (!uses.has(d.id)) uses.set(d.id, stillUsesShared(ctx, d, Boolean(detections.get(d.id)?.detected)));
      return /** @type {boolean} */ (uses.get(d.id));
    };
    for (const r of agents) {
      r.files = r.files.map((f) => {
        if (!f.share || f.action === 'unchanged') return f;
        const users = AGENTS.filter((d) => d.shares.includes(/** @type {string} */ (f.share)) && d.scopes.includes(ctx.scope));
        const staying = users.filter((d) => !agents.find((a) => a.id === d.id)?.selected && stillUses(d));
        if (!staying.length) return f;
        return { ...f, action: /** @type {const} */ ('unchanged'), kept: true, note: `kept: still used by ${staying.map((d) => d.name).join(', ')}` };
      });
    }
  }

  for (const r of agents) {
    for (const f of r.files) {
      const seen = byPath.get(f.path);
      if (!seen) {
        byPath.set(f.path, f);
        owners.set(f.path, [r.id]);
        continue;
      }
      /** @type {string[]} */ (owners.get(f.path)).push(r.id);
      if (seen.action !== f.action || seen.content !== f.content) {
        // Two plans for one file disagree (cannot happen for identical shared content): keep the file as is.
        byPath.set(f.path, { ...seen, action: 'unchanged', note: `left as is: ${r.name} and another agent planned different contents` });
      }
    }
  }

  const changes = [...byPath.values()];
  /** @type {string[]} */
  let written = [];
  /** @type {Array<{ path: string, message: string }>} */
  const failures = [];
  if (o.apply) written = applyPlan({ files: changes, notes: [] }, { backups: true, manifest: manifestPath(ctx.env), failures });
  for (const fail of failures) {
    for (const id of owners.get(fail.path) ?? []) {
      agents.find((a) => a.id === id)?.refusals.push({ file: fail.path, message: `could not ${byPath.get(fail.path)?.action === 'delete' ? 'delete' : 'write'} it: ${fail.message}`, failed: true });
    }
  }

  for (const r of agents) {
    if (!r.selected) continue;
    const pending = r.files.some((f) => f.action !== 'unchanged');
    if (r.files.some((f) => failures.some((x) => x.path === f.path))) r.status = 'failed';
    else if (o.mode === 'install') r.status = !pending ? (r.refusals.length ? 'planned' : 'up-to-date') : o.apply ? 'configured' : 'planned';
    else r.status = pending ? (o.apply ? 'removed' : 'planned') : 'nothing-to-remove';
  }

  if (o.mode === 'install' && ctx.scope === 'project') {
    const local = changes.filter((f) => f.action !== 'delete' && f.content.includes(ctx.binPath)).map((f) => path.relative(ctx.root, f.path) || f.path);
    if (local.length) {
      notes.push(
        `These project files hold paths that exist only on this machine (${ctx.execPath}, ${ctx.binPath}): ${local.join(', ')}. ` +
          'Keep them out of version control (e.g. in .gitignore); each teammate runs `suiko install --project` on their own machine.',
      );
    }
  }

  if (o.mode === 'install' && !ctx.cliOnPath && agents.some((r) => r.selected && r.files.length)) {
    notes.push(
      `\`suiko\` is not on PATH, so the installed instructions tell agents to run ${ctx.invocation} instead. ` +
        `Run \`npm link\` in ${PACKAGE_ROOT} (then re-run this install) to use the short command.`,
    );
  }

  return {
    mode: o.mode,
    applied: Boolean(o.apply),
    scope: ctx.scope,
    agents,
    unverified: UNVERIFIED.map((u) => {
      const d = u.detect(ctx);
      return { id: u.id, name: u.name, detected: d.detected, evidence: d.evidence, reason: u.reason };
    }),
    changes,
    owners,
    written,
    notes,
    ctx,
  };
}

/**
 * Exit code of a report: 1 when a file was refused, else 0.
 * @param {Report} report
 * @returns {number}
 */
export function reportExit(report) {
  return report.agents.some((a) => a.refusals.length) ? EXIT.ERROR : EXIT.OK;
}

const AGENT_IDS = AGENTS.map((a) => a.id).join(', ');

/** Reason of an agent that --only leaves out (not listed in the text report: the user picked other agents). */
const NOT_IN_ONLY = 'not named with --only';

/**
 * Human text of a report.
 * @param {Report} report
 * @returns {string}
 */
export function describeReport(report) {
  const { ctx } = report;
  const install = report.mode === 'install';
  const out = [];
  out.push(
    `Suiko ${report.mode}: ${report.applied ? 'applied' : 'dry run'} (${report.scope} scope${report.scope === 'project' ? `, ${ctx.root}` : ''})` +
      (report.applied ? '' : '. Nothing is written without --apply.'),
  );
  /** @type {Map<string, string>} path -> name of the agent it was listed under */
  const listed = new Map();
  for (const r of report.agents) {
    const where = r.evidence.length ? ` (${r.evidence.join(', ')})` : '';
    if (!r.selected) {
      if (r.status === 'not-detected') {
        if (install) out.push('', `${r.name}: not detected`);
        continue;
      }
      if (r.reason === NOT_IN_ONLY) continue;
      out.push('', `${r.name}: ${r.detected ? `detected${where}; ` : ''}skipped: ${r.reason}`);
      continue;
    }
    if (!install && r.status === 'nothing-to-remove') continue;
    out.push('', `${r.name}: ${r.detected ? `detected${where}` : 'not detected (named with --only)'}`);
    for (const f of r.files) {
      const names = (report.owners.get(f.path) ?? []).map((id) => report.agents.find((a) => a.id === id)?.name ?? id);
      const firstOwner = listed.get(f.path);
      if (firstOwner) {
        out.push(`  ${verb(f, report.applied, report.written)} ${f.path}  (shared; listed under ${firstOwner})`);
        continue;
      }
      listed.set(f.path, r.name);
      const sharedWith = names.filter((n) => n !== r.name);
      out.push(`  ${verb(f, report.applied, report.written)} ${f.path}${describeFile(f, report.applied)}${sharedWith.length ? `  [shared with ${sharedWith.join(', ')}]` : ''}`);
      if (!report.applied && f.detail && f.action !== 'unchanged' && f.action !== 'delete') {
        for (const line of f.detail.split('\n')) out.push(`      | ${line}`);
      }
      if (report.applied && f.backedUp) out.push(`      backup: ${f.backedUp}`);
    }
    for (const x of r.refusals) {
      out.push(`  ${x.failed ? 'FAILED' : 'REFUSED'} ${x.file}: ${x.message}`);
      if (x.fix) out.push(`      fix: ${x.fix}`);
    }
    for (const n of r.notes) out.push(`  note: ${n}`);
  }

  const detectedAny = report.agents.some((r) => r.detected);
  if (install && !report.agents.some((r) => r.selected) && !detectedAny) {
    out.push('', `No supported agent detected. Name one with --only to configure it anyway (agents: ${AGENT_IDS}).`);
  }

  if (install && report.unverified.length) {
    out.push('', 'Not configured (unverified integration surface):');
    for (const u of report.unverified) out.push(`  ${u.name}${u.detected ? ` (detected: ${u.evidence.join(', ')})` : ''}: ${u.reason}`);
  }

  for (const n of report.notes) out.push('', n);

  const pending = report.changes.filter((f) => f.action !== 'unchanged').length;
  const refused = new Set(report.agents.flatMap((a) => a.refusals.filter((x) => !x.failed).map((x) => x.file))).size;
  const failed = new Set(report.agents.flatMap((a) => a.refusals.filter((x) => x.failed).map((x) => x.file))).size;
  out.push('');
  if (report.applied) {
    const removed = report.changes.filter((f) => f.action === 'delete' && report.written.includes(f.path)).length;
    const changed = report.written.length - removed;
    const parts = [...(changed ? [`${changed} file${changed === 1 ? '' : 's'} ${install ? 'written' : 'updated'}`] : []), ...(removed ? [`${removed} removed`] : [])];
    out.push(report.written.length ? `Done: ${parts.join(', ')}.` : install ? 'Everything was already installed; nothing written.' : 'Nothing to remove.');
  } else if (pending) {
    out.push(install ? 'Run with --apply to write these changes.' : 'Run with --apply to remove these.');
  } else if (report.agents.some((r) => r.selected)) {
    out.push(install ? 'Everything is already installed; nothing to write.' : 'Nothing to remove: Suiko is not configured for the selected agents.');
  } else if (!install) {
    out.push('Nothing to remove.');
  }
  if (refused) out.push(`${refused} file${refused === 1 ? ' was' : 's were'} refused (see REFUSED above); fix ${refused === 1 ? 'it' : 'them'} and re-run.`);
  if (failed) out.push(`${failed} file${failed === 1 ? '' : 's'} could not be written (see FAILED above); the others were. Fix the cause and re-run.`);
  return out.join('\n').replace(/^\n+/, '');
}

/**
 * @param {FileAction} f
 * @param {boolean} applied
 * @param {string[]} [written]
 * @returns {string}
 */
function verb(f, applied, written = []) {
  if (f.kept) return 'kept';
  if (f.action === 'unchanged') return 'unchanged';
  if (applied && !written.includes(f.path)) return f.action === 'delete' ? 'NOT deleted:' : 'NOT written:';
  if (applied) return { create: 'created', update: 'updated', delete: 'deleted' }[f.action];
  return { create: 'would create', update: 'would update', delete: 'would delete' }[f.action];
}

/**
 * @param {FileAction} f
 * @param {boolean} applied
 * @returns {string}
 */
function describeFile(f, applied) {
  if (f.note) return `  (${f.note})`;
  if (f.source && f.action !== 'delete' && !applied) return `  (copy of ${path.relative(PACKAGE_ROOT, f.source)}, ${Buffer.byteLength(f.content)} bytes)`;
  return '';
}

/**
 * JSON form of a report (--json).
 * @param {Report} report
 * @returns {object}
 */
export function reportJson(report) {
  return {
    mode: report.mode,
    applied: report.applied,
    scope: report.scope,
    agents: report.agents.map((r) => ({
      id: r.id,
      name: r.name,
      detected: r.detected,
      evidence: r.evidence,
      selected: r.selected,
      status: r.status,
      ...(r.reason ? { reason: r.reason } : {}),
      files: r.files.map((f) => ({
        path: f.path,
        action: f.kept ? 'kept' : f.action,
        ...(f.note ? { note: f.note } : {}),
        ...(f.backedUp ? { backup: f.backedUp } : {}),
        ...(f.source ? { source: path.relative(PACKAGE_ROOT, f.source) } : {}),
        ...((report.owners.get(f.path) ?? []).length > 1 ? { sharedWith: (report.owners.get(f.path) ?? []).filter((id) => id !== r.id) } : {}),
      })),
      notes: r.notes,
      refusals: r.refusals,
    })),
    unverified: report.unverified.map((u) => ({ id: u.id, name: u.name, detected: u.detected, reason: u.reason })),
    written: report.written,
    notes: report.notes,
  };
}

/**
 * Parses a comma/space separated agent list (--only/--skip, repeatable) into agent ids.
 * @param {string[] | string | undefined} values
 * @param {string} flag for messages
 * @param {(name: string) => { id: string, unverified: boolean } | null} resolve
 * @returns {Set<string> | null} null when the flag was not given
 */
export function parseAgentList(values, flag, resolve) {
  if (values === undefined) return null;
  const list = (Array.isArray(values) ? values : [values]).flatMap((v) => v.split(/[\s,]+/)).filter(Boolean);
  const out = new Set();
  for (const name of list) {
    const hit = resolve(name);
    if (!hit) throw new UsageError(`${flag}: unknown agent "${name}" (agents: ${AGENT_IDS})`);
    if (hit.unverified) {
      const u = UNVERIFIED.find((x) => x.id === hit.id);
      throw new UsageError(`${flag}: ${u?.name ?? name} is not supported yet: ${u?.reason ?? 'its integration surface is unverified'}`);
    }
    out.add(hit.id);
  }
  return out;
}

/**
 * Does an agent left out of an uninstall still use Suiko's shared files? Yes while its own (unshared) Suiko
 * config is still there, or a file of it cannot be read; and, for an agent detected here whose whole configuration is
 * shared files (Factory Droid reads only ~/.agents/skills), as long as it is detected.
 * @param {Ctx} ctx
 * @param {import('./agents.js').AgentDef} d
 * @param {boolean} detected
 * @returns {boolean}
 */
function stillUsesShared(ctx, d, detected) {
  const un = new Planner();
  d.uninstall(ctx, un);
  if (un.refusals.length || un.files.some((f) => !f.share && (f.action !== 'unchanged' || f.kept))) return true;
  if (!detected) return false;
  const ins = new Planner();
  d.install(ctx, ins);
  return ins.files.length > 0 && ins.files.every((f) => f.share);
}

/**
 * Per agent: is Suiko configured (user scope), and is it up to date? Used by `suiko doctor`.
 * Agents that are neither detected nor configured are left out. An agent counts as configured by its own files; the
 * shared ones (~/.agents/skills) count only for a detected agent whose whole configuration is shared (Droid).
 * @param {Ctx} ctx
 * @returns {Array<{ id: string, name: string, detected: boolean, configured: boolean, upToDate: boolean, plugin?: string, problem?: string }>}
 */
export function integrationStatus(ctx) {
  const out = [];
  for (const def of AGENTS) {
    const det = def.detect(ctx);
    const inst = new Planner();
    const un = new Planner();
    def.install(ctx, inst);
    def.uninstall(ctx, un);
    const present = (/** @type {FileAction} */ f) => f.action !== 'unchanged' || Boolean(f.kept);
    const allShared = inst.files.length > 0 && inst.files.every((f) => f.share);
    const configured = un.files.some((f) => !f.share && present(f)) || (det.detected && allShared && un.files.some(present));
    const pluginInfo = def.id === 'claude' && inst.skipped ? claudePlugin(ctx) : null;
    const plugin = pluginInfo?.id;
    if (!det.detected && !configured && !plugin) continue;
    const twice = pluginInfo ? claudeDoubleInstall(ctx, pluginInfo) : null;
    const problem = twice ? `Suiko plugin installed (${pluginInfo?.id}), and ${twice}` : [...inst.refusals, ...un.refusals][0]?.message;
    out.push({
      id: def.id,
      name: def.name,
      detected: det.detected,
      configured,
      upToDate: !inst.skipped && inst.refusals.length === 0 && inst.files.every((f) => f.action === 'unchanged'),
      ...(plugin ? { plugin } : {}),
      ...(problem ? { problem } : {}),
    });
  }
  return out;
}
