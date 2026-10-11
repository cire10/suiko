// @ts-check
// Typed errors raised by the store and the layers above it. Each carries the CLI `exit` code (EXIT in
// src/shared/protocol.js) and a stable string `code`, so CLI, MCP and the daemon can map failures uniformly
// (CLI: process.exitCode = err.exit; MCP: isError; daemon: NotFound -> 404, Conflict/Refused -> 409).

import { EXIT } from '../../shared/protocol.js';

/**
 * @typedef {object} ErrorOptions
 * @property {unknown} [cause]
 * @property {Record<string, unknown>} [details] machine-readable context (ids, paths, hashes)
 */

export class SpecReviewError extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions & { exit?: number, code?: string }} [opts]
   */
  constructor(message, opts = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    /** @type {number} */
    this.exit = opts.exit ?? EXIT.ERROR;
    /** @type {string} */
    this.code = opts.code ?? 'ERROR';
    /** @type {Record<string, unknown>} */
    this.details = opts.details ?? {};
  }
}

/** A doc, version, thread, review, lock or file does not exist (exit 4). */
export class NotFoundError extends SpecReviewError {
  /** @param {string} message @param {ErrorOptions} [opts] */
  constructor(message, opts = {}) {
    super(message, { ...opts, exit: EXIT.NOT_FOUND, code: 'NOT_FOUND' });
  }
}

/** Compare-and-swap failure or concurrent modification (exit 3). */
export class ConflictError extends SpecReviewError {
  /** @param {string} message @param {ErrorOptions} [opts] */
  constructor(message, opts = {}) {
    super(message, { ...opts, exit: EXIT.REFUSED, code: 'CONFLICT' });
  }
}

/** A policy refused the operation (guards, $HOME as workspace root, dirty working copy...) (exit 3). */
export class RefusedError extends SpecReviewError {
  /** @param {string} message @param {ErrorOptions} [opts] */
  constructor(message, opts = {}) {
    super(message, { ...opts, exit: EXIT.REFUSED, code: 'REFUSED' });
  }
}

/** A file lock could not be acquired before the timeout (exit 1). */
export class LockTimeoutError extends SpecReviewError {
  /** @param {string} message @param {ErrorOptions} [opts] */
  constructor(message, opts = {}) {
    super(message, { ...opts, exit: EXIT.ERROR, code: 'LOCK_TIMEOUT' });
  }
}

/** Bad input from a caller (malformed id, invalid argument) (exit 1). */
export class UsageError extends SpecReviewError {
  /** @param {string} message @param {ErrorOptions} [opts] */
  constructor(message, opts = {}) {
    super(message, { ...opts, exit: EXIT.ERROR, code: 'USAGE' });
  }
}

/**
 * Exit code for any thrown value (EXIT.ERROR for foreign errors).
 * @param {unknown} err
 * @returns {number}
 */
export function exitCodeOf(err) {
  return err instanceof SpecReviewError ? err.exit : EXIT.ERROR;
}
