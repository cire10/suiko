// @ts-check
// Argument parsing for the CLI (node:util parseArgs) plus the small value parsers shared with the MCP server:
// durations (`--timeout 30m`), version refs (`v3`, `live`), diff ranges (`v1..v2`), single line ranges
// (`--lines 42-46`), `--break-lock L1="why"` pairs, comma/repeat thread lists, and agent-name resolution
// (design 9.1: --as, else $SPECREVIEW_AGENT, else 'claude' when $CLAUDECODE is set, else 'agent').
// Every parse failure throws UsageError (exit 1) with a message that names the offending flag.

import { parseArgs } from 'node:util';
import { UsageError } from '../core/store/errors.js';
import { parseLinesArg } from '../core/util/lines-arg.js';
import { formatCodeAt, isCodeAt, parseCodeAt } from '../core/util/code-at.js';

/**
 * @typedef {{ type: 'string' | 'boolean', short?: string, multiple?: boolean, default?: string | boolean }} OptionSpec
 * @typedef {Record<string, OptionSpec>} OptionSpecs
 * @typedef {{ values: Record<string, any>, positionals: string[] }} ParsedArgs
 */

/** Options accepted by every command. */
export const GLOBAL_OPTIONS = /** @type {OptionSpecs} */ ({
  as: { type: 'string' },
  json: { type: 'boolean' },
  workspace: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
});

const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Parses argv for one command (strict: unknown flags are errors).
 * @param {string} command for messages
 * @param {string[]} argv arguments after the command name
 * @param {OptionSpecs} options command-specific options (merged with GLOBAL_OPTIONS)
 * @returns {ParsedArgs}
 */
export function parseCommandArgs(command, argv, options = {}) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: /** @type {any} */ ({ ...GLOBAL_OPTIONS, ...options }),
      allowPositionals: true,
      strict: true,
    });
    return { values: /** @type {Record<string, any>} */ (values), positionals };
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    if (typeof e.code === 'string' && e.code.startsWith('ERR_PARSE_ARGS')) {
      throw new UsageError(`${command}: ${e.message.replace(/\.$/, '')} (see: specreview ${command} --help)`);
    }
    throw err;
  }
}

/**
 * Checks the positional count.
 * @param {string} command
 * @param {string[]} positionals
 * @param {number} min
 * @param {number} max Infinity for variadic
 * @param {string} usage
 */
export function expectPositionals(command, positionals, min, max, usage) {
  if (positionals.length < min) throw new UsageError(`${command}: missing argument (usage: specreview ${usage})`);
  if (positionals.length > max) {
    throw new UsageError(`${command}: unexpected argument "${positionals[max]}" (usage: specreview ${usage})`);
  }
}

/**
 * Agent name per design 9.1.
 * @param {string | undefined} flag value of --as
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function resolveAgent(flag, env) {
  const name = flag || env.SPECREVIEW_AGENT || (env.CLAUDECODE ? 'claude' : 'agent');
  if (!AGENT_RE.test(name)) {
    throw new UsageError(`invalid agent name "${name}": use letters, digits, '.', '_' or '-' (at most 64)`);
  }
  return name;
}

const DURATION_PART = /(\d+(?:\.\d+)?)(ms|s|m|h|d)?/gy;
const UNIT_MS = /** @type {Record<string, number>} */ ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 });

/**
 * Parses a duration: '0' (= no limit), '90' (seconds), '500ms', '45s', '30m', '2h', '1h30m'. Returns milliseconds.
 * @param {string | number} input
 * @param {string} [flag] for messages
 * @returns {number}
 */
export function parseDuration(input, flag = '--timeout') {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new UsageError(`${flag}: invalid duration ${input}`);
    return Math.round(input * 1000);
  }
  const s = String(input).trim().toLowerCase();
  if (!s) throw new UsageError(`${flag}: empty duration`);
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  let total = 0;
  DURATION_PART.lastIndex = 0;
  let pos = 0;
  while (pos < s.length) {
    DURATION_PART.lastIndex = pos;
    const m = DURATION_PART.exec(s);
    if (!m || !m[2]) throw new UsageError(`${flag}: invalid duration "${input}" (examples: 0, 90s, 30m, 2h, 1h30m)`);
    total += Number(m[1]) * UNIT_MS[m[2]];
    pos = DURATION_PART.lastIndex;
  }
  return Math.round(total);
}

/**
 * Human form of a duration in ms ('30m', '90s', '1h30m').
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  let s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return [h ? `${h}h` : '', m ? `${m}m` : '', s ? `${s}s` : ''].join('') || '0s';
}

/**
 * Version reference: 'v3' | '3' -> 3, 'live' | 'working' -> 'live', 'head' -> 'head'.
 * @param {string | number} input
 * @param {string} [flag]
 * @returns {number | 'live' | 'head'}
 */
export function parseVersionRef(input, flag = 'version') {
  if (typeof input === 'number' && Number.isSafeInteger(input) && input >= 1) return input;
  const s = String(input).trim().toLowerCase();
  if (s === 'live' || s === 'working') return 'live';
  if (s === 'head') return 'head';
  const m = /^v?(\d+)$/.exec(s);
  if (m && Number(m[1]) >= 1) return Number(m[1]);
  throw new UsageError(`${flag}: invalid version "${input}" (expected vN, N, head or live)`);
}

/**
 * Diff range: 'v1..v2', '1..live', 'v2' (= v2..head), '..v3' (default..v3), 'v2..' (v2..head).
 * Missing ends are undefined (the engine applies its defaults: lastReviewed..head).
 * @param {string | undefined} input
 * @returns {{ from: number | 'live' | 'head' | undefined, to: number | 'live' | 'head' | undefined }}
 */
export function parseDiffRange(input) {
  if (input === undefined || input === '') return { from: undefined, to: undefined };
  const parts = String(input).split('..');
  if (parts.length > 2) throw new UsageError(`diff: invalid range "${input}" (expected vA..vB)`);
  if (parts.length === 1) return { from: parseVersionRef(parts[0], 'diff'), to: 'head' };
  const [a, b] = parts;
  return {
    from: a ? parseVersionRef(a, 'diff') : undefined,
    to: b ? parseVersionRef(b, 'diff') : 'head',
  };
}

/**
 * One inclusive line range for --lines ('42-46', 'L42-46', '42').
 * @param {string | number} input
 * @param {string} [flag]
 * @returns {[number, number]}
 */
export function parseSingleRange(input, flag = '--lines') {
  let ranges;
  try {
    ranges = parseLinesArg(input);
  } catch (err) {
    throw new UsageError(`${flag}: ${/** @type {Error} */ (err).message}`);
  }
  if (ranges.length !== 1) throw new UsageError(`${flag}: expected one range like 42-46, got "${input}"`);
  return ranges[0];
}

/**
 * Validates a line-list argument such as --at 'L12,L90-91' and returns it normalised ('L12,L90-91'); a code review's
 * repo-file form ('src/a.js:L12-L14, L20') comes back canonical too ('src/a.js:L12-14,L20').
 * @param {string} input
 * @param {string} [flag]
 * @returns {string}
 */
export function normalizeAt(input, flag = '--at') {
  try {
    return parseLinesArg(input)
      .map(([a, b]) => (a === b ? `L${a}` : `L${a}-${b}`))
      .join(',');
  } catch (err) {
    // code reviews: repo-file forms ('src/a.js:L42-46,L50'), canonicalised; the engine checks them against the doc
    if (isCodeAt(input)) return formatCodeAt(parseCodeAt(input));
    throw new UsageError(`${flag}: ${/** @type {Error} */ (err).message}`);
  }
}

/**
 * `--break-lock L1="reason"` values (repeatable) -> { L1: 'reason' }.
 * @param {string[] | undefined} values
 * @returns {Record<string, string>}
 */
export function parseBreakLocks(values) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const raw of values ?? []) {
    const eq = raw.indexOf('=');
    const id = (eq < 0 ? raw : raw.slice(0, eq)).trim();
    let reason = eq < 0 ? '' : raw.slice(eq + 1).trim();
    if (/^(["']).*\1$/s.test(reason)) reason = reason.slice(1, -1);
    if (!/^L\d+$/.test(id)) throw new UsageError(`--break-lock: expected L<n>="reason", got "${raw}"`);
    if (!reason) throw new UsageError(`--break-lock ${id}: a reason is required (--break-lock ${id}="why")`);
    out[id] = reason;
  }
  return out;
}

/**
 * Thread ids from repeatable / comma-separated flags ('t1,t2' 't3') -> ['t1','t2','t3'] (deduplicated, in order).
 * @param {Array<string> | string | undefined} values
 * @param {string} [flag]
 * @returns {string[]}
 */
export function parseThreadList(values, flag = '--thread') {
  const list = Array.isArray(values) ? values : values === undefined ? [] : [values];
  /** @type {string[]} */
  const out = [];
  for (const v of list) {
    for (const part of String(v).split(/[\s,]+/)) {
      if (!part) continue;
      assertThreadId(part, flag);
      if (!out.includes(part)) out.push(part);
    }
  }
  return out;
}

/**
 * @param {string} id
 * @param {string} [what]
 */
export function assertThreadId(id, what = 'thread') {
  if (!/^t\d+$/.test(id)) throw new UsageError(`${what}: invalid thread id "${id}" (expected t<n>, e.g. t3)`);
}
