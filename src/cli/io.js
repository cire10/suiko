// @ts-check
// Output/input helpers shared by the CLI commands and the MCP server.
//
// - writeAll(stream, text): resolves once the chunk has been handed to the OS (the write callback fired). `wait`
//   and `feedback` await it before the engine records a review as delivered (design 5.4 "Delivery").
// - readAll(stream): reads a whole input stream (stdin for `revise --replies -` and `edit --stdin`).
// - toJson(value): the canonical --json rendering (2-space indent, trailing newline).
// - CommandResult: what every command returns; main() prints it, the MCP server maps it to a tool result.

/**
 * @typedef {object} CommandResult
 * @property {number} exit process exit code (EXIT in src/shared/protocol.js)
 * @property {string} [text] human text for stdout (without trailing newline handling: printed as is + '\n')
 * @property {unknown} [json] structured form (printed with --json; MCP structuredContent)
 * @property {string[]} [stderr] extra 'specreview: ...' lines for stderr (warnings, waiting notes)
 * @property {boolean} [printed] true when the command already wrote its stdout output itself (wait/feedback)
 */

/**
 * Writes `text` and resolves when the write callback fires (data flushed to the OS / consumer).
 * Rejects on a stream error (EPIPE...), so callers can refuse to record a delivery that never reached stdout.
 * @param {NodeJS.WritableStream} stream
 * @param {string} text
 * @returns {Promise<void>}
 */
export function writeAll(stream, text) {
  return new Promise((resolve, reject) => {
    if (!text) {
      resolve();
      return;
    }
    let done = false;
    /** @param {unknown} err */
    const onError = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };
    stream.once?.('error', onError);
    try {
      stream.write(text, (err) => {
        stream.removeListener?.('error', onError);
        if (done) return;
        done = true;
        if (err) reject(err);
        else resolve();
      });
    } catch (err) {
      stream.removeListener?.('error', onError);
      onError(err);
    }
  });
}

/**
 * Reads a stream to the end as UTF-8 (BOM stripped). `maxBytes` guards against unbounded input.
 * @param {NodeJS.ReadableStream} stream
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function readAll(stream, { maxBytes = 64 * 1024 * 1024 } = {}) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(/** @type {Uint8Array} */ (chunk));
    size += buf.length;
    if (size > maxBytes) throw new RangeError(`input larger than ${maxBytes} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
}

/**
 * Canonical JSON output for --json.
 * @param {unknown} value
 * @returns {string}
 */
export function toJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Ensures a trailing newline (output lines are always newline-terminated).
 * @param {string} text
 * @returns {string}
 */
export function withNewline(text) {
  if (!text) return '';
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * A writable sink that keeps what is written (MCP mode and tests).
 * @returns {NodeJS.WritableStream & { text: () => string }}
 */
export function memorySink() {
  /** @type {string[]} */
  const parts = [];
  const sink = {
    /**
     * @param {string | Uint8Array} chunk
     * @param {any} [encOrCb]
     * @param {any} [cb]
     */
    write(chunk, encOrCb, cb) {
      parts.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      const callback = typeof encOrCb === 'function' ? encOrCb : cb;
      if (typeof callback === 'function') queueMicrotask(() => callback());
      return true;
    },
    once() {
      return sink;
    },
    on() {
      return sink;
    },
    removeListener() {
      return sink;
    },
    end() {
      return sink;
    },
    text: () => parts.join(''),
  };
  return /** @type {any} */ (sink);
}
