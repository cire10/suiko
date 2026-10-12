// @ts-check
// Lazy loader for the review engine (WP3: src/core/review/{ops,context,packet}.js).
//
// The CLI and the MCP server never import the engine at module load time: `hook`, `install`, `serve`, `stop` and
// `--help` must work (and start fast) without it, and tests inject a stub engine instead (main(argv, { ops,
// createContext, format })). The text formatters come from packet.js when it exports them; any missing one falls
// back to the CLI's own formatter in format.js (so a partial engine still prints something sensible).

import { SuikoError } from '../core/store/errors.js';
import { EXIT } from '../shared/protocol.js';
import { FALLBACK_FORMATTERS } from './format.js';

/**
 * @typedef {object} Formatters
 * @property {(packet: any) => string} formatPacket
 * @property {(report: any) => string} formatReviseReport
 * @property {(status: any) => string} formatStatus
 * @property {(log: any) => string} formatLog
 * @property {(changes: any) => string} formatDiffStat
 * @property {(thread: any) => string} formatThread
 */

/**
 * @typedef {object} Engine
 * @property {Record<string, any>} ops the ops module (design 4.4 "src/core/review/ops.js")
 * @property {(opts: Record<string, any>) => Promise<any>} createContext
 * @property {Formatters} format
 */

/**
 * Builds an Engine from injected parts (tests) or by importing the real modules.
 * @param {{ ops?: Record<string, any>, createContext?: Function, format?: Partial<Formatters> }} [injected]
 * @returns {Promise<Engine>}
 */
export async function loadEngine(injected = {}) {
  let ops = injected.ops;
  if (!ops) ops = await importEngineModule('ops.js');
  let createContext = injected.createContext ?? ops.createContext;
  if (typeof createContext !== 'function') {
    const mod = await importEngineModule('context.js');
    createContext = mod.createContext;
  }
  if (typeof createContext !== 'function') {
    throw new SuikoError('the review engine does not export createContext()', { exit: EXIT.ERROR });
  }
  let packet = injected.format ?? null;
  if (!packet && !injected.ops) packet = await importEngineModule('packet.js').catch(() => null);
  return {
    ops,
    createContext: /** @type {any} */ (createContext),
    format: mergeFormatters(packet ?? {}),
  };
}

/**
 * The formatters in `preferred` win over the fallbacks (only functions are taken).
 * @param {Record<string, any>} preferred
 * @returns {Formatters}
 */
export function mergeFormatters(preferred) {
  /** @type {Record<string, any>} */
  const out = { ...FALLBACK_FORMATTERS };
  for (const [name, fn] of Object.entries(preferred ?? {})) {
    if (typeof fn === 'function') out[name] = fn;
  }
  return /** @type {Formatters} */ (out);
}

/**
 * Formats an op result with the engine's formatter `name` (packet.js: formatApply, formatEdit, formatThreads...)
 * when it exists and succeeds; otherwise uses `fallback()`. Trailing newlines are removed (output adds one).
 * @param {Engine} engine
 * @param {string} name
 * @param {unknown} value
 * @param {() => string} fallback
 * @returns {string}
 */
export function formatWith(engine, name, value, fallback) {
  const fn = /** @type {Record<string, any>} */ (engine.format)[name];
  if (typeof fn === 'function') {
    try {
      const text = fn(value);
      if (typeof text === 'string') return text.replace(/\n+$/, '');
    } catch {
      // an unexpected result shape: fall back to the CLI's own rendering
    }
  }
  return fallback().replace(/\n+$/, '');
}

/**
 * @param {string} file module under src/core/review/
 * @returns {Promise<Record<string, any>>}
 */
async function importEngineModule(file) {
  try {
    return await import(`../core/review/${file}`);
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    const missing = e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes(`review/${file}`);
    throw new SuikoError(
      missing
        ? `the review engine is not installed (src/core/review/${file} is missing)`
        : `the review engine failed to load (src/core/review/${file}): ${e.message}`,
      { exit: EXIT.ERROR, cause: err },
    );
  }
}
