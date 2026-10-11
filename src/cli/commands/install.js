// @ts-check
// `specreview install claude [--user|--project] [--with-hooks] [--with-mcp] [--apply]`
// `specreview install agents-md [--file AGENTS.md] [--apply]`
// Without --apply nothing is written: the exact files and contents that would change are printed (design 3.0,
// amendments 5). The plan/apply logic lives in src/cli/install.js.

import path from 'node:path';
import { UsageError } from '../../core/store/errors.js';
import { EXIT } from '../../shared/protocol.js';
import { expectPositionals } from '../args.js';
import { applyPlan, describePlan, isOnPath, planAgentsMd, planClaude } from '../install.js';

export const spec = {
  name: 'install',
  usage: 'install claude [--user|--project] [--with-hooks] [--with-mcp] [--apply] | install agents-md [--file F] [--apply]',
  summary: 'Install the Claude Code skill (+ hooks, MCP) or the AGENTS.md protocol. Prints the changes unless --apply.',
  options: {
    user: { type: 'boolean' },
    project: { type: 'boolean' },
    'with-hooks': { type: 'boolean' },
    'with-mcp': { type: 'boolean' },
    apply: { type: 'boolean' },
    file: { type: 'string' },
  },
  details: [
    'claude --user (default): ~/.claude/skills/spec-review/ and ~/.claude/commands/ ($CLAUDE_CONFIG_DIR is honoured)',
    'claude --project: <project>/.claude/...; --with-mcp then writes <project>/.mcp.json',
    '--with-hooks: PreToolUse(Write) and UserPromptSubmit hooks with absolute paths in settings.json',
    'Use either the Claude Code plugin or `install claude --with-hooks`, not both.',
  ],
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ values, positionals }) {
  expectPositionals('install', positionals, 1, 1, spec.usage);
  const target = positionals[0];
  if (target !== 'claude' && target !== 'agents-md') throw new UsageError(`install: unknown target "${target}" (expected claude or agents-md)`);
  if (values.user && values.project) throw new UsageError('install claude: pass either --user or --project');
  if (target === 'agents-md' && (values.user || values.project || values['with-hooks'] || values['with-mcp'])) {
    throw new UsageError('install agents-md: only --file and --apply apply');
  }
  if (target === 'claude' && values.file !== undefined) throw new UsageError('install claude: --file applies to agents-md only');
  return {
    target,
    scope: values.project ? 'project' : 'user',
    withHooks: Boolean(values['with-hooks']),
    withMcp: Boolean(values['with-mcp']),
    apply: Boolean(values.apply),
    file: values.file,
  };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ target: 'claude' | 'agents-md', scope: 'user' | 'project', withHooks: boolean, withMcp: boolean, apply: boolean, file?: string }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const claudeHome = rt.deps.claudeHome ?? (rt.env.CLAUDE_CONFIG_DIR ? path.resolve(rt.env.CLAUDE_CONFIG_DIR) : undefined);
  const plan =
    input.target === 'claude'
      ? planClaude({
          scope: input.scope, withHooks: input.withHooks, withMcp: input.withMcp, cwd: rt.cwd, claudeHome,
          cliOnPath: isOnPath('specreview', rt.env.PATH ?? ''),
        })
      : planAgentsMd({ cwd: rt.cwd, file: input.file });
  const written = input.apply ? applyPlan(plan) : [];
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
