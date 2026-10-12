// @ts-check
// What the multi-agent installer writes, built from the integration files at run time:
//   - the protocol block (integrations/agents-md/AGENTS.snippet.md) for global instruction files (AGENTS.md, GEMINI.md,
//     copilot-instructions.md, ...), with the "not on PATH" invocation note after its begin marker when needed;
//   - the agent-neutral skill (integrations/agent-skills/suiko-review/SKILL.md + the protocol);
//   - per-agent command files (Gemini CLI TOML, OpenCode Markdown) and the Kiro steering file;
//   - the Codex config.toml block registering the MCP server.
// Every builder returns { template, content }: `template` is the text without the invocation note (used to recognise
// our own copies whatever node/script path they mention), `content` is what gets written on this machine.

import path from 'node:path';
import { AGENTS_SNIPPET, INTEGRATIONS_DIR, invocationNote, readText, withInvocationNote } from '../install.js';
import { TOML_BEGIN, TOML_END } from './files.js';

export const SKILL_NAME = 'suiko-review';
export const SKILL_TEMPLATE = path.join(INTEGRATIONS_DIR, 'agent-skills', SKILL_NAME, 'SKILL.md');
export const GEMINI_COMMAND = path.join(INTEGRATIONS_DIR, 'gemini', 'commands', `${SKILL_NAME}.toml`);
export const OPENCODE_COMMAND = path.join(INTEGRATIONS_DIR, 'opencode', 'commands', `${SKILL_NAME}.md`);
export { AGENTS_SNIPPET };

/** Seconds Codex may spend in one MCP tool call: suiko_wait's maximum (600 s) plus a margin. */
export const CODEX_TOOL_TIMEOUT_SEC = 660;

/**
 * @typedef {{ cliOnPath: boolean, invocation: string, execPath: string, binPath: string }} ContentCtx
 * @typedef {{ template: string, content: string }} Built
 */

/** @returns {string} the snippet, from its begin marker line to its end marker */
export function protocolSnippet() {
  return readText(AGENTS_SNIPPET).replace(/\s+$/, '');
}

/**
 * The protocol block for a global instructions file; when `suiko` is not on PATH, the invocation note follows
 * the begin marker (inside the block, so reinstall/uninstall handle it too).
 * @param {ContentCtx} c
 * @returns {Built}
 */
export function protocolBlock(c) {
  const template = protocolSnippet();
  if (c.cliOnPath) return { template, content: template };
  const nl = template.indexOf('\n');
  return { template, content: `${template.slice(0, nl + 1)}${invocationNote(c.invocation)}\n${template.slice(nl + 1)}` };
}

/** @returns {string} the protocol without its marker lines (for files we own entirely) */
export function protocolBody() {
  const lines = protocolSnippet().split('\n');
  return lines.slice(1, lines[lines.length - 1].startsWith('<!-- specreview:end') ? -1 : undefined).join('\n').trim();
}

/**
 * The agent-neutral skill: the template with the protocol in place of its `<!-- specreview:protocol -->` line.
 * @param {ContentCtx} c
 * @returns {Built}
 */
export function agentSkill(c) {
  const template = readText(SKILL_TEMPLATE).replace(/^<!-- specreview:protocol[^\n]*-->[^\n]*$/m, () => protocolBody());
  return { template, content: c.cliOnPath ? template : withInvocationNote(template, c.invocation) };
}

/**
 * Gemini CLI custom command (TOML); the invocation note goes at the top of the prompt.
 * @param {ContentCtx} c
 * @returns {Built}
 */
export function geminiCommand(c) {
  const template = readText(GEMINI_COMMAND);
  if (c.cliOnPath) return { template, content: template };
  return { template, content: template.replace(/^prompt = '''\n/m, (m) => `${m}${invocationNote(c.invocation)}\n`) };
}

/**
 * OpenCode command (Markdown with front matter).
 * @param {ContentCtx} c
 * @returns {Built}
 */
export function opencodeCommand(c) {
  const template = readText(OPENCODE_COMMAND);
  return { template, content: c.cliOnPath ? template : withInvocationNote(template, c.invocation) };
}

/**
 * Kiro steering file (always included) carrying the protocol.
 * @param {ContentCtx} c
 * @returns {Built}
 */
export function kiroSteering(c) {
  const head = '---\ninclusion: always\n---\n\n';
  const block = protocolBlock(c);
  return { template: `${head}${block.template}\n`, content: `${head}${block.content}\n` };
}

/**
 * The Codex config.toml block registering the stdio MCP server with absolute paths.
 * @param {ContentCtx} c
 * @returns {string}
 */
export function codexTomlBlock(c) {
  return [
    `${TOML_BEGIN} (managed by \`suiko install\`; edits inside this block are replaced on reinstall)`,
    '[mcp_servers.suiko]',
    `command = ${tomlString(c.execPath)}`,
    `args = [${tomlString(c.binPath)}, "mcp"]`,
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`,
    TOML_END,
  ].join('\n');
}

/**
 * A TOML basic string (JSON string escapes are valid TOML escapes).
 * @param {string} s
 * @returns {string}
 */
export function tomlString(s) {
  return JSON.stringify(s);
}
