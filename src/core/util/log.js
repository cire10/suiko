// @ts-check
// Leveled logger that writes to stderr only (stdout is reserved for CLI output, packets and the MCP stdio
// transport).
//
// Level selection, first match wins:
//   1. `configureLogger({ level })`
//   2. SPECREVIEW_LOG_LEVEL = debug | info | warn | error | silent
//   3. SPECREVIEW_DEBUG = 1 | true | * | all          -> debug for every scope
//      SPECREVIEW_DEBUG = store,lock                   -> debug for those scopes (prefix match), warn elsewhere
//   4. default: warn
// Line format: `specreview <level> [<scope>] <message> <json data>`; prefixed by an ISO timestamp when
// `configureLogger({ time: true })` or SPECREVIEW_LOG_TIME=1 (the daemon enables it for daemon.log).

/** @typedef {'debug' | 'info' | 'warn' | 'error' | 'silent'} LogLevel */
/** @typedef {{ debug: LogFn, info: LogFn, warn: LogFn, error: LogFn, child: (sub: string) => Logger, enabled: (level: LogLevel) => boolean }} Logger */
/** @typedef {(message: string, data?: unknown) => void} LogFn */

/** @type {Record<LogLevel, number>} */
const RANK = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** @type {{ level: LogLevel | null, time: boolean | null, sink: ((line: string) => void) | null }} */
const settings = { level: null, time: null, sink: null };

/**
 * Overrides logger settings for this process. Pass `null` for a field to return it to the env/default.
 * @param {{ level?: LogLevel | null, time?: boolean | null, sink?: ((line: string) => void) | null }} opts
 */
export function configureLogger(opts) {
  if ('level' in opts) {
    if (opts.level != null && !(opts.level in RANK)) throw new TypeError(`unknown log level ${opts.level}`);
    settings.level = opts.level ?? null;
  }
  if ('time' in opts) settings.time = opts.time ?? null;
  if ('sink' in opts) settings.sink = opts.sink ?? null;
}

/**
 * Effective level for a scope.
 * @param {string} scope
 * @returns {LogLevel}
 */
export function levelFor(scope) {
  if (settings.level) return settings.level;
  const envLevel = (process.env.SPECREVIEW_LOG_LEVEL || '').toLowerCase();
  if (envLevel in RANK) return /** @type {LogLevel} */ (envLevel);
  const dbg = (process.env.SPECREVIEW_DEBUG || '').trim();
  if (dbg && dbg !== '0' && dbg.toLowerCase() !== 'false') {
    if (['1', 'true', '*', 'all'].includes(dbg.toLowerCase())) return 'debug';
    const scopes = dbg.split(',').map((s) => s.trim()).filter(Boolean);
    if (scopes.some((s) => scope === s || scope.startsWith(`${s}.`) || scope.startsWith(`${s}:`))) return 'debug';
  }
  return 'warn';
}

/**
 * @param {unknown} data
 * @param {boolean} verbose include error stacks
 * @returns {string}
 */
function formatData(data, verbose) {
  if (data === undefined) return '';
  if (data instanceof Error) {
    return ` ${verbose && data.stack ? data.stack : `${data.name}: ${data.message}`}`;
  }
  try {
    return ` ${JSON.stringify(data, (_k, v) => (v instanceof Error ? `${v.name}: ${v.message}` : v))}`;
  } catch {
    return ` ${String(data)}`;
  }
}

/**
 * @param {string} line
 */
function emit(line) {
  if (settings.sink) {
    settings.sink(line);
    return;
  }
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // stderr closed: nothing sensible to do
  }
}

/**
 * Creates a scoped logger, e.g. createLogger('store').
 * @param {string} scope
 * @returns {Logger}
 */
export function createLogger(scope) {
  /** @param {Exclude<LogLevel, 'silent'>} level */
  const make = (level) => /** @type {LogFn} */ ((message, data) => {
    const effective = levelFor(scope);
    if (RANK[level] < RANK[effective]) return;
    const withTime = settings.time ?? /^(1|true)$/i.test(process.env.SPECREVIEW_LOG_TIME || '');
    const prefix = withTime ? `${new Date().toISOString()} ` : '';
    emit(`${prefix}specreview ${level} [${scope}] ${message}${formatData(data, effective === 'debug')}`);
  });
  return {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    child: (sub) => createLogger(`${scope}.${sub}`),
    enabled: (level) => RANK[level] >= RANK[levelFor(scope)],
  };
}
