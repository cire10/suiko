// @ts-check
// CLI entry point: `main(argv, deps) -> exit code` (design 9.1 / 9.2).
//
// - Dispatches to the command modules in ./commands (lazy imports), parsing argv with node:util parseArgs
//   (strict; global options --json, --as <agent>, --workspace <dir>, -h/--help may appear anywhere).
// - Resolves the agent name: --as, else $SPECREVIEW_AGENT, else 'claude' when $CLAUDECODE is set, else 'agent'.
// - Prints the CommandResult: text (or JSON with --json) on stdout, `specreview: ...` notes on stderr.
// - Errors print `specreview: <message>` on stderr (and {"error":{...}} on stdout with --json) and map to the EXIT
//   codes of src/shared/protocol.js via the error's `exit` (SpecReviewError subclasses), else 1.
// - `wait` gets an AbortSignal wired to SIGINT/SIGTERM so an interrupted wait cleans up and delivers nothing.
// All collaborators are injectable (deps) so tests run the real argument handling against a stub engine.

import { SpecReviewError } from '../core/store/errors.js';
import { EXIT } from '../shared/protocol.js';
import { GLOBAL_OPTIONS, parseCommandArgs, resolveAgent } from './args.js';
import { COMMANDS, commandHelp, topLevelHelp } from './commands/index.js';
import { packageVersion } from './daemon-client.js';
import { toJson, withNewline, writeAll } from './io.js';
import { createRuntime } from './runtime.js';

/** Commands that run until interrupted and therefore handle SIGINT/SIGTERM themselves. */
const SIGNAL_AWARE = new Set(['wait']);

/**
 * @param {string[]} argv arguments after `specreview`
 * @param {import('./runtime.js').Deps} [deps]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  if (!deps.stdout) stdout.on?.('error', () => {}); // EPIPE when the reader went away: nothing useful to do
  const env = deps.env ?? process.env;
  const args = hoistCommand(argv);
  const [name, ...rest] = args;

  if (!name) {
    await writeAll(stdout, withNewline(topLevelHelp(packageVersion())));
    return EXIT.ERROR;
  }
  if (name === '--version' || name === '-v' || name === 'version') {
    await writeAll(stdout, `${packageVersion()}\n`);
    return EXIT.OK;
  }
  if (name === '--help' || name === '-h' || name === 'help') {
    const sub = rest[0] && COMMANDS[rest[0]];
    const text = sub ? commandHelp((await sub.load()).spec) : topLevelHelp(packageVersion());
    await writeAll(stdout, withNewline(text));
    return EXIT.OK;
  }
  const entry = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
  if (!entry) {
    await writeAll(stderr, `specreview: unknown command "${name}" (run \`specreview --help\`)\n`);
    return EXIT.ERROR;
  }

  let json = rest.includes('--json');
  /** @type {AbortController | null} */
  let controller = null;
  /** @type {Array<() => void>} */
  const cleanups = [];
  try {
    const mod = await entry.load();
    const parsed = mod.spec.raw ? { values: {}, positionals: rest } : parseCommandArgs(name, rest, mod.spec.options ?? {});
    json = Boolean(parsed.values.json);
    if (parsed.values.help) {
      await writeAll(stdout, withNewline(commandHelp(mod.spec)));
      return EXIT.OK;
    }
    const agent = resolveAgent(parsed.values.as, env);
    let signal = deps.signal;
    if (!signal && SIGNAL_AWARE.has(name)) {
      controller = new AbortController();
      signal = controller.signal;
      const source = deps.signals ?? process;
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        const handler = () => controller?.abort(sig);
        source.on(sig, handler);
        cleanups.push(() => source.removeListener(sig, handler));
      }
    }
    const rt = createRuntime({ ...deps, signal }, { agent, workspace: parsed.values.workspace, json, mode: 'cli' });
    const input = await mod.parse(parsed, rt);
    const result = await mod.execute(rt, input);
    for (const line of result.stderr ?? []) await writeAll(stderr, withNewline(line));
    if (!result.printed) {
      if (json) await writeAll(stdout, toJson(result.json ?? null));
      else if (result.text) await writeAll(stdout, withNewline(result.text));
    }
    return result.exit;
  } catch (err) {
    return reportError(err, { stdout, stderr, json, env });
  } finally {
    for (const fn of cleanups) fn();
  }
}

/**
 * Moves global options that precede the command name after it: `--json status` -> `status --json`.
 * @param {string[]} argv
 * @returns {string[]}
 */
export function hoistCommand(argv) {
  /** @type {string[]} */
  const lead = [];
  let i = 0;
  while (i < argv.length && argv[i].startsWith('--') && argv[i] !== '--help' && argv[i] !== '--version') {
    const [flag] = argv[i].slice(2).split('=');
    const specOpt = GLOBAL_OPTIONS[flag];
    if (!specOpt) break;
    lead.push(argv[i]);
    if (specOpt.type === 'string' && !argv[i].includes('=') && i + 1 < argv.length) lead.push(argv[++i]);
    i++;
  }
  if (!lead.length || i >= argv.length) return argv;
  return [argv[i], ...lead, ...argv.slice(i + 1)];
}

/**
 * Prints an error and returns its exit code.
 * @param {unknown} err
 * @param {{ stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream, json: boolean, env: Record<string, string | undefined> }} o
 * @returns {Promise<number>}
 */
async function reportError(err, o) {
  const e = /** @type {any} */ (err);
  const exit = errorExit(err);
  const message = String(e?.message ?? err).replace(/^specreview:\s*/, '');
  await writeAll(o.stderr, `specreview: ${message}\n`).catch(() => {});
  const known = err instanceof SpecReviewError || typeof e?.exit === 'number';
  if (!known && (o.env.SPECREVIEW_DEBUG || o.env.SPECREVIEW_LOG_LEVEL === 'debug') && e?.stack) {
    await writeAll(o.stderr, `${e.stack}\n`).catch(() => {});
  }
  if (o.json) {
    await writeAll(o.stdout, toJson({ error: { code: e?.code ?? 'ERROR', message, exit, ...(e?.details ? { details: e.details } : {}) } })).catch(() => {});
  }
  return exit;
}

/**
 * Exit code of an error: its numeric `exit` when it is one of EXIT's values, else 1.
 * @param {unknown} err
 * @returns {number}
 */
export function errorExit(err) {
  const exit = /** @type {any} */ (err)?.exit;
  return typeof exit === 'number' && Object.values(EXIT).includes(exit) ? exit : EXIT.ERROR;
}
