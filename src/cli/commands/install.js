// @ts-check
// `specreview install [--only a,b] [--skip a,b] [--user|--project] [--apply]`   detect agents, configure each
// `specreview install claude [--user|--project] [--with-hooks] [--with-plan-gate] [--with-mcp] [--apply]`
// `specreview install agents-md [--file AGENTS.md] [--apply]`
// Without --apply nothing is written: the exact files, entries and blocks that would change are printed (design 3.0,
// amendments 5). The single-target plan/apply logic lives in src/cli/install.js, the multi-agent installer in
// src/cli/install/ (agents.js: what each agent gets; multi.js: detection, selection, dedup, report).

import path from 'node:path';
import { UsageError } from '../../core/store/errors.js';
import { EXIT } from '../../shared/protocol.js';
import { expectPositionals } from '../args.js';
import { applyPlan, describePlan, isOnPath, planAgentsMd, planClaude } from '../install.js';
import { AGENTS, resolveAgentId } from '../install/agents.js';
import { loadManifest } from '../install/files.js';
import { buildContext, describeReport, manifestPath, parseAgentList, reportExit, reportJson, runInstaller } from '../install/multi.js';

export const spec = {
  name: 'install',
  usage:
    'install [--only a,b] [--skip a,b] [--user|--project] [--apply] | install claude [--user|--project] [--with-hooks] [--with-plan-gate] [--with-mcp] [--apply] | install agents-md [--file F] [--apply]',
  summary: 'Configure SpecReview for the coding agents found on this machine. Prints the changes unless --apply.',
  options: {
    user: { type: 'boolean' },
    project: { type: 'boolean' },
    only: { type: 'string', multiple: true },
    skip: { type: 'string', multiple: true },
    'with-hooks': { type: 'boolean' },
    'with-plan-gate': { type: 'boolean' },
    'with-mcp': { type: 'boolean' },
    apply: { type: 'boolean' },
    file: { type: 'string' },
  },
  details: [
    `No target: detects ${AGENTS.map((a) => a.id).join(', ')} and prints, per agent, the files, entries and blocks it`,
    'would write. --apply writes them (one-time <file>.specreview-backup of any existing file it modifies).',
    '--only claude,codex configures those agents even when they are not detected; --skip leaves agents out.',
    '--user (default) writes the user-level config; --project writes the project-level files where an agent has them.',
    'Undo with `specreview uninstall`. Re-running is idempotent.',
    '',
    'claude --user (default): ~/.claude/skills/spec-review/ and ~/.claude/commands/ ($CLAUDE_CONFIG_DIR is honoured)',
    'claude --project: <project>/.claude/...; --with-mcp then writes <project>/.mcp.json',
    '--with-hooks: PreToolUse(Write) and UserPromptSubmit hooks with absolute paths in settings.json',
    '--with-plan-gate: the plan-mode gate (PermissionRequest on ExitPlanMode) in settings.json',
    'Use either the Claude Code plugin or `install claude --with-hooks`, not both.',
  ],
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ values, positionals }) {
  expectPositionals('install', positionals, 0, 1, spec.usage);
  if (values.user && values.project) throw new UsageError('install: pass either --user or --project');
  const scope = values.project ? 'project' : 'user';
  const target = positionals[0];
  if (target === undefined) {
    for (const flag of ['with-hooks', 'with-plan-gate', 'with-mcp', 'file']) {
      if (values[flag] !== undefined) throw new UsageError(`install: --${flag} applies to \`install claude\`/\`install agents-md\` only (the agent installer configures everything)`);
    }
    return {
      target: 'agents',
      scope,
      apply: Boolean(values.apply),
      only: parseAgentList(values.only, '--only', resolveAgentId),
      skip: parseAgentList(values.skip, '--skip', resolveAgentId) ?? new Set(),
    };
  }
  if (target !== 'claude' && target !== 'agents-md') {
    throw new UsageError(`install: unknown target "${target}" (expected claude or agents-md, or no target to configure every detected agent; pick agents with --only)`);
  }
  if (values.only || values.skip) throw new UsageError(`install ${target}: --only/--skip apply to the agent installer (\`specreview install\` with no target)`);
  if (target === 'agents-md' && (values.user || values.project || values['with-hooks'] || values['with-plan-gate'] || values['with-mcp'])) {
    throw new UsageError('install agents-md: only --file and --apply apply');
  }
  if (target === 'claude' && values.file !== undefined) throw new UsageError('install claude: --file applies to agents-md only');
  return {
    target,
    scope,
    withHooks: Boolean(values['with-hooks']),
    withPlanGate: Boolean(values['with-plan-gate']),
    withMcp: Boolean(values['with-mcp']),
    apply: Boolean(values.apply),
    file: values.file,
  };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {any} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  if (input.target === 'agents') {
    const ctx = buildContext(rt, { scope: input.scope });
    const report = runInstaller(ctx, { mode: 'install', only: input.only, skip: input.skip, apply: input.apply });
    const refused = report.agents.flatMap((a) => a.refusals.map((x) => `specreview: refused ${x.file}: ${x.message}`));
    return { exit: reportExit(report), text: describeReport(report), json: reportJson(report), stderr: refused };
  }
  const claudeHome = rt.deps.claudeHome ?? (rt.env.CLAUDE_CONFIG_DIR ? path.resolve(rt.env.CLAUDE_CONFIG_DIR) : undefined);
  const manifest = manifestPath(rt.env);
  const plan =
    input.target === 'claude'
      ? planClaude({
          scope: input.scope, withHooks: input.withHooks, withPlanGate: input.withPlanGate, withMcp: input.withMcp, cwd: rt.cwd, claudeHome,
          cliOnPath: isOnPath('specreview', rt.env.PATH ?? ''), manifest: loadManifest(manifest),
        })
      : planAgentsMd({ cwd: rt.cwd, file: input.file });
  const written = input.apply ? applyPlan(plan, { manifest }) : [];
  return {
    exit: EXIT.OK,
    text: describePlan(plan, { applied: input.apply, written }),
    json: {
      target: input.target,
      applied: input.apply,
      files: plan.files.map((f) => ({ path: f.path, action: f.action })),
      written,
      notes: plan.notes,
    },
  };
}
