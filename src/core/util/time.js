// @ts-check
// Wall-clock access for timestamps written into SpecReview files, with an injectable clock for deterministic tests.
//
// - `now()` / `nowIso()` honour, in order: a clock installed with `setClock()`, then the `SPECREVIEW_NOW`
//   environment variable (an ISO-8601 instant that pins the clock, useful for golden tests run through the CLI),
//   then `Date.now()`.
// - Timestamps are ISO-8601 UTC with millisecond precision (`Date.prototype.toISOString`), so they sort
//   lexicographically.
// - Liveness checks (file locks, waiter heartbeats) must NOT use this clock: they compare against other
//   processes' real time and use `Date.now()` directly.

/** @type {(() => number) | null} */
let clock = null;

/**
 * Current time in epoch milliseconds.
 * @returns {number}
 */
export function now() {
  if (clock) return clock();
  const pinned = process.env.SPECREVIEW_NOW;
  if (pinned) {
    const ms = Date.parse(pinned);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}

/**
 * Current time as ISO-8601 UTC, e.g. '2026-10-10T14:02:11.123Z'.
 * @returns {string}
 */
export function nowIso() {
  return new Date(now()).toISOString();
}

/**
 * Installs a clock. Accepts a function returning epoch ms, a fixed epoch ms number, an ISO string, or null to
 * restore the default. Returns a function that restores the previously installed clock.
 * @param {(() => number) | number | string | null} source
 * @returns {() => void}
 */
export function setClock(source) {
  const previous = clock;
  if (source === null || source === undefined) {
    clock = null;
  } else if (typeof source === 'function') {
    clock = source;
  } else {
    const ms = typeof source === 'number' ? source : Date.parse(source);
    if (!Number.isFinite(ms)) throw new TypeError(`setClock: invalid time ${String(source)}`);
    clock = () => ms;
  }
  return () => {
    clock = previous;
  };
}

/**
 * Formats epoch ms or a Date as ISO-8601 UTC.
 * @param {number | Date} t
 * @returns {string}
 */
export function toIso(t) {
  return new Date(t).toISOString();
}

/**
 * Parses an ISO timestamp to epoch ms; NaN when missing or invalid.
 * @param {string | null | undefined} iso
 * @returns {number}
 */
export function parseIso(iso) {
  return typeof iso === 'string' ? Date.parse(iso) : NaN;
}

/**
 * Promise-based delay (real time).
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
