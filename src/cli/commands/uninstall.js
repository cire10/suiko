// @ts-check
// `suiko uninstall [--only a,b] [--skip a,b] [--user|--project] [--apply]`
// Removes exactly what `suiko install` (and `install claude` / `install agents-md`) added: the marked blocks
// (<!-- specreview:begin --> .. <!-- specreview:end -->, # specreview:begin .. # specreview:end), our JSON entries
// (mcpServers.suiko, mcp.suiko), the hooks whose command runs suiko, and copied skill/command files
// that still match what was installed (an edited copy is kept and reported). Dry run unless --apply. A file shared by
// several agents (~/.agents/skills/suiko-review) stays while an agent left out with --only/--skip still uses it.

import { UsageError } from '../../core/store/errors.js';
import { expectPositionals } from '../args.js';
import { resolveAgentId } from '../install/agents.js';
import { buildContext, describeReport, parseAgentList, reportExit, reportJson, runInstaller } from '../install/multi.js';

export const spec = {
  name: 'uninstall',
  usage: 'uninstall [--only a,b] [--skip a,b] [--user|--project] [--apply]',
  summary: 'Remove what `suiko install` added for each agent. Prints the removals unless --apply.',
  options: {
    user: { type: 'boolean' },
    project: { type: 'boolean' },
    only: { type: 'string', multiple: true },
    skip: { type: 'string', multiple: true },
    apply: { type: 'boolean' },
  },
  details: [
    'Removes the Suiko blocks, entries, hooks and copied files of every agent (or the --only list).',
    'Copies you edited after installing are kept and listed. Other config is never touched.',
    'One-time <file>.specreview-backup files made by install are left in place.',
  ],
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ values, positionals }) {
  expectPositionals('uninstall', positionals, 0, 0, spec.usage);
  if (values.user && values.project) throw new UsageError('uninstall: pass either --user or --project');
  return {
    scope: values.project ? 'project' : 'user',
    apply: Boolean(values.apply),
    only: parseAgentList(values.only, '--only', resolveAgentId),
    skip: parseAgentList(values.skip, '--skip', resolveAgentId) ?? new Set(),
  };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ scope: 'user' | 'project', apply: boolean, only: Set<string> | null, skip: Set<string> }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const ctx = buildContext(rt, { scope: input.scope });
  const report = runInstaller(ctx, { mode: 'uninstall', only: input.only, skip: input.skip, apply: input.apply });
  const refused = report.agents.flatMap((a) => a.refusals.map((x) => `suiko: refused ${x.file}: ${x.message}`));
  return { exit: reportExit(report), text: describeReport(report), json: reportJson(report), stderr: refused };
}
