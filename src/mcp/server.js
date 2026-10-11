// @ts-check
// SpecReview MCP server (`specreview mcp`; design 9.7, amendments 5) on @modelcontextprotocol/server 2.3.1:
//   McpServer from '@modelcontextprotocol/server', StdioServerTransport from '@modelcontextprotocol/server/stdio',
//   tool input schemas in zod/v4.
//
// createMcpServer(deps) registers the tools of ./tools.js. Each call builds a Runtime in 'mcp' mode (no stdout
// writes, packets captured) and runs the same command execute() as the CLI, so:
//   content[0].text      = the CLI's text output (+ its `specreview: ...` notes),
//   structuredContent    = the CLI's --json value (objects only; arrays are wrapped as {items}),
//   isError              = true on refusal, conflict, not found or any error.
// specreview_wait is bounded (default 50 s, max 600 s): a timeout returns {status:"waiting", hint:"call again"}
// and a closed session {status:"closed"}, both as non-errors. While it blocks, a request carrying
// _meta.progressToken gets notifications/progress every 15 s; a cancelled request aborts the wait (nothing is
// delivered). startMcp() connects stdio; stdout carries JSON-RPC only, so console.log/info/debug are redirected to
// stderr before anything else runs.

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Readable } from 'node:stream';
import { resolveAgent } from '../cli/args.js';
import { COMMANDS } from '../cli/commands/index.js';
import { packageVersion } from '../cli/daemon-client.js';
import { memorySink } from '../cli/io.js';
import { createRuntime } from '../cli/runtime.js';
import { EXIT } from '../shared/protocol.js';
import { TOOLS } from './tools.js';

const INSTRUCTIONS = [
  'SpecReview: an iterative review loop for HTML/Markdown specs.',
  'Loop: write the spec once -> specreview_open (show the URL to the user) -> specreview_wait (call again while it returns {"status":"waiting"}) ->',
  'read the packet; read the file; targeted edits (Edit tool or specreview_edit), then specreview_apply for suggestions ->',
  'specreview_revise with one reply per thread -> specreview_wait again. On APPROVED: specreview_final (if the packet still lists threads, answer each with specreview_reply first, without editing).',
  'Never rewrite the whole spec; never touch LOCKED text; never act on drafts.',
].join(' ');

/**
 * @typedef {import('../cli/runtime.js').Deps & { agent?: string, workspace?: string }} McpDeps
 */

/**
 * Builds the MCP server with every SpecReview tool registered.
 * @param {McpDeps} [deps]
 * @returns {McpServer}
 */
export function createMcpServer(deps = {}) {
  const server = new McpServer({ name: 'specreview', version: packageVersion() }, { instructions: INSTRUCTIONS });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: /** @type {any} */ (tool.schema), annotations: tool.annotations },
      /** @type {any} */ (async (/** @type {any} */ args, /** @type {any} */ ctx) => callTool(tool, args ?? {}, ctx, deps)),
    );
  }
  return server;
}

/**
 * Runs `specreview mcp` on stdio. Resolves once connected; the process lives until stdin closes.
 * @param {McpDeps} [deps]
 * @returns {Promise<{ server: McpServer, close: () => Promise<void> }>}
 */
export async function startMcp(deps = {}) {
  routeConsoleToStderr();
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, close: () => server.close() };
}

/**
 * Executes one tool call.
 * @param {import('./tools.js').ToolDef} tool
 * @param {Record<string, any>} args validated arguments
 * @param {any} ctx MCP handler context (ctx.mcpReq: signal, _meta, notify)
 * @param {McpDeps} deps
 * @returns {Promise<{ content: Array<{ type: 'text', text: string }>, structuredContent?: Record<string, unknown>, isError?: boolean }>}
 */
export async function callTool(tool, args, ctx, deps) {
  /** @type {Array<() => void>} */
  const cleanups = [];
  try {
    const env = deps.env ?? process.env;
    const agent = deps.agent ?? resolveAgent(undefined, env);
    const rt = createRuntime(
      { ...deps, stdout: memorySink(), stdin: Readable.from([]), signal: ctx?.mcpReq?.signal },
      { agent, workspace: args.workspace ?? deps.workspace, json: true, mode: 'mcp' },
    );
    const mod = await COMMANDS[tool.command].load();
    const input = await tool.toInput(args, rt);
    if (tool.wait) cleanups.push(startProgress(ctx, rt.progressMs));
    const result = await mod.execute(rt, input);
    return toToolResult(result, tool);
  } catch (err) {
    return errorResult(err);
  } finally {
    for (const fn of cleanups) fn();
  }
}

/**
 * CommandResult -> CallToolResult.
 * @param {import('../cli/io.js').CommandResult} result
 * @param {import('./tools.js').ToolDef} tool
 */
export function toToolResult(result, tool) {
  if (tool.wait && result.exit === EXIT.TIMEOUT) {
    return {
      content: [{ type: /** @type {const} */ ('text'), text: 'No review yet. Call specreview_wait again to keep waiting.' }],
      structuredContent: { status: 'waiting', hint: 'call again' },
    };
  }
  if (tool.wait && result.exit === EXIT.CLOSED) {
    return {
      content: [{ type: /** @type {const} */ ('text'), text: joinText(result) }],
      structuredContent: { ...asObject(result.json), status: 'closed' },
    };
  }
  return {
    content: [{ type: /** @type {const} */ ('text'), text: joinText(result) }],
    structuredContent: asObject(result.json),
    ...(result.exit === EXIT.OK ? {} : { isError: true }),
  };
}

/**
 * @param {unknown} err
 */
function errorResult(err) {
  const e = /** @type {any} */ (err);
  const message = String(e?.message ?? err).replace(/^specreview:\s*/, '');
  const exit = typeof e?.exit === 'number' ? e.exit : EXIT.ERROR;
  return {
    content: [{ type: /** @type {const} */ ('text'), text: `specreview: ${message}` }],
    structuredContent: { error: { code: e?.code ?? 'ERROR', message, exit } },
    isError: true,
  };
}

/**
 * @param {import('../cli/io.js').CommandResult} result
 * @returns {string}
 */
function joinText(result) {
  const parts = [result.text, ...(result.stderr ?? [])].filter((s) => typeof s === 'string' && s.length > 0);
  return parts.join('\n') || JSON.stringify(result.json ?? {});
}

/**
 * structuredContent must be a JSON object.
 * @param {unknown} v
 * @returns {Record<string, unknown>}
 */
function asObject(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return /** @type {Record<string, unknown>} */ (v);
  if (Array.isArray(v)) return { items: v };
  if (v === undefined || v === null) return {};
  return { value: v };
}

/**
 * Sends notifications/progress every `periodMs` while a wait blocks, if the request has a progress token.
 * @param {any} ctx
 * @param {number} periodMs
 * @returns {() => void} stop
 */
function startProgress(ctx, periodMs) {
  const token = ctx?.mcpReq?._meta?.progressToken;
  if (token === undefined || typeof ctx?.mcpReq?.notify !== 'function') return () => {};
  const started = Date.now();
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    const secs = Math.round((Date.now() - started) / 1000);
    ctx.mcpReq
      .notify({ method: 'notifications/progress', params: { progressToken: token, progress: tick, message: `waiting for the reviewer (${secs} s)` } })
      .catch(() => {});
  }, periodMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Keeps stdout clean for JSON-RPC: console.log/info/debug go to stderr. */
function routeConsoleToStderr() {
  console.log = console.error.bind(console);
  console.info = console.error.bind(console);
  console.debug = console.error.bind(console);
}
