// @ts-check
// `suiko mcp`: runs the stdio MCP server (src/mcp/server.js). stdout carries only JSON-RPC; logs go to stderr.
// The process keeps running until the client closes stdin.

import { EXIT } from '../../shared/protocol.js';
import { expectPositionals } from '../args.js';

export const spec = {
  name: 'mcp',
  usage: 'mcp [--as <agent>]',
  summary: 'Run the stdio MCP server (tools: suiko_open, suiko_wait, suiko_revise, ...).',
  options: {},
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ positionals }) {
  expectPositionals('mcp', positionals, 0, 0, spec.usage);
  return {};
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt) {
  const start = rt.deps.startMcp ?? (await import('../../mcp/server.js')).startMcp;
  await start({ ...rt.deps, agent: rt.agent, workspace: rt.workspace });
  return { exit: EXIT.OK, printed: true };
}
