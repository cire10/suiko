// @ts-check
// Command registry: name -> lazy module loader + one-line summary for `specreview --help`.
// Command modules export:
//   spec    { name, usage, summary, options }          options are node:util parseArgs specs (global ones added)
//   parse(parsed, rt) -> input                          argv -> normalised input (may read stdin)
//   execute(rt, input) -> CommandResult                 shared with the MCP server (same text, same JSON)
// Daemon/installer commands (serve, stop, doctor, mcp, install, uninstall) only implement parse + execute for the CLI.

/** @type {Record<string, { load: () => Promise<any>, summary: string, group: string }>} */
export const COMMANDS = {
  open: { load: () => import('./open.js'), summary: 'Track a spec (a file, a folder, or - for stdin), start the server, print the URL', group: 'loop' },
  review: { load: () => import('./review.js'), summary: 'Open a code review of your changes (since-base, uncommitted, staged, range, commit)', group: 'loop' },
  wait: { load: () => import('./wait.js'), summary: 'Block until the reviewer submits a review; print the feedback packet', group: 'loop' },
  feedback: { load: () => import('./feedback.js'), summary: 'Print the feedback packet now (marks it delivered unless --peek)', group: 'loop' },
  apply: { load: () => import('./apply.js'), summary: 'Apply suggestion threads verbatim to the working copy', group: 'loop' },
  edit: { load: () => import('./edit.js'), summary: 'Thread-tagged exact replace (or a JSON batch with --stdin)', group: 'loop' },
  reply: { load: () => import('./reply.js'), summary: 'Reply on a thread without recording a version', group: 'loop' },
  revise: { load: () => import('./revise.js'), summary: 'Record the working copy (or --source text) as a new version, with replies', group: 'loop' },
  revert: { load: () => import('./revert.js'), summary: 'Undo one unrecorded hunk, or restore a locked range', group: 'loop' },
  reanchor: { load: () => import('./reanchor.js'), summary: "Move a thread's anchor to other lines or text", group: 'loop' },
  ask: { load: () => import('./ask.js'), summary: 'Ask the reviewer a question anchored on the doc', group: 'loop' },
  snip: { load: () => import('./snip.js'), summary: 'Reviewer: snip the screen (macOS) into a draft comment, or --send it now', group: 'loop' },
  last: { load: () => import('./last.js'), summary: "Review the agent's last message (Claude Code transcript)", group: 'loop' },
  threads: { load: () => import('./threads.js'), summary: 'List threads, one line each', group: 'inspect' },
  show: { load: () => import('./show.js'), summary: 'Show a thread with its timeline, or old source lines', group: 'inspect' },
  diff: { load: () => import('./diff.js'), summary: 'What changed between versions (default: last reviewed..head)', group: 'inspect' },
  log: { load: () => import('./log.js'), summary: 'Timeline of versions and reviews', group: 'inspect' },
  status: { load: () => import('./status.js'), summary: 'Docs, heads, counts, undelivered reviews, listeners', group: 'inspect' },
  final: { load: () => import('./final.js'), summary: 'Check the final version and export decisions', group: 'inspect' },
  close: { load: () => import('./close.js'), summary: 'End the review session (running waits exit 5)', group: 'inspect' },
  serve: { load: () => import('./serve.js'), summary: 'Start the local review server', group: 'admin' },
  stop: { load: () => import('./stop.js'), summary: 'Stop the server (--rotate: new token and secret on next start)', group: 'admin' },
  doctor: { load: () => import('./doctor.js'), summary: 'Check the installation, server and stores (--fix repairs)', group: 'admin' },
  mcp: { load: () => import('./mcp.js'), summary: 'Run the stdio MCP server', group: 'admin' },
  hook: { load: () => import('./hook.js'), summary: 'Claude Code hook entry points: hook pre-write | hook prompt', group: 'admin' },
  'plan-gate': { load: () => import('./plan-gate.js'), summary: 'Claude Code plan-mode gate (PermissionRequest hook for ExitPlanMode)', group: 'admin' },
  install: { load: () => import('./install.js'), summary: 'Configure SpecReview for the agents found here (dry run; --apply writes). Also: install claude | agents-md', group: 'admin' },
  uninstall: { load: () => import('./uninstall.js'), summary: 'Remove what install added, per agent (dry run; --apply removes)', group: 'admin' },
};

/**
 * Top-level usage text.
 * @param {string} version
 * @returns {string}
 */
export function topLevelHelp(version) {
  const groups = /** @type {Record<string, string>} */ ({
    loop: 'Review loop',
    inspect: 'Inspect',
    admin: 'Server and integrations',
  });
  const out = [
    `specreview ${version}: iterative, commentable, versioned review of HTML/Markdown specs`,
    '',
    'Usage: specreview <command> [args] [--json] [--as <agent>] [--workspace <dir>]',
  ];
  for (const [group, title] of Object.entries(groups)) {
    out.push('', `${title}:`);
    for (const [name, c] of Object.entries(COMMANDS)) {
      if (c.group === group) out.push(`  ${name.padEnd(9)} ${c.summary}`);
    }
  }
  out.push(
    '',
    '<doc> is a doc id or a file path. Line numbers are 1-based lines of the file on disk.',
    'Exit codes: 0 ok · 1 error · 2 timeout · 3 refused · 4 not found · 5 closed · 6 superseded.',
    'Agent name: --as <name>, else $SPECREVIEW_AGENT, else "claude" when $CLAUDECODE is set, else "agent".',
    'Run `specreview <command> --help` for details.',
  );
  return out.join('\n');
}

/**
 * Per-command usage text.
 * @param {{ name: string, usage: string, summary: string, details?: string[] }} spec
 * @returns {string}
 */
export function commandHelp(spec) {
  return [`Usage: specreview ${spec.usage}`, '', spec.summary, ...(spec.details?.length ? ['', ...spec.details] : [])].join('\n');
}
