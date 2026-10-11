// @ts-check
// `specreview hook pre-write | hook prompt` routed through main() (tests, `node src/cli/main.js`). The real entry
// point (bin/specreview.js) dispatches `hook` to src/cli/hooks.js before importing anything else, for speed.
// Hooks always exit 0 and print nothing on error.

import { EXIT } from '../../shared/protocol.js';
import { runHook } from '../hooks.js';

export const spec = {
  name: 'hook',
  usage: 'hook pre-write | hook prompt   (JSON on stdin; for Claude Code hooks)',
  summary: 'Claude Code hook entry points. Always exit 0.',
  options: {},
  raw: true,
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ positionals }) {
  return { name: positionals[0] ?? '' };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ name: string }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  await runHook(input.name, { stdin: rt.stdin, stdout: rt.stdout, env: rt.env, cwd: rt.cwd });
  return { exit: EXIT.OK, printed: true };
}
