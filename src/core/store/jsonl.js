// @ts-check
// Append-only JSON-lines files (runtime events feed and pending edits).
// Appends are single O_APPEND writes of one complete line. Readers skip blank and malformed lines, so a line torn
// by a crash is ignored; the next append first terminates such a partial line so it cannot corrupt the new record.

import fs from 'node:fs/promises';
import path from 'node:path';

const TAIL_CHUNK = 8192;

/**
 * Appends one JSON record as a line.
 * @param {string} file
 * @param {unknown} record
 */
export async function appendJsonLine(file, record) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const prefix = (await endsWithPartialLine(file)) ? '\n' : '';
  await fs.appendFile(file, `${prefix}${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * True when the file exists, is non-empty and does not end with '\n'.
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function endsWithPartialLine(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    if (size === 0) return false;
    const one = Buffer.alloc(1);
    await handle.read(one, 0, 1, size - 1);
    return one[0] !== 0x0a;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return false;
    throw err;
  } finally {
    await handle?.close();
  }
}

/**
 * Parses every well-formed line; [] when the file does not exist.
 * @template [T=any]
 * @param {string} file
 * @returns {Promise<T[]>}
 */
export async function readJsonLines(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return [];
    throw err;
  }
  /** @type {T[]} */
  const out = [];
  for (const line of text.split('\n')) {
    const parsed = parseLine(line);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

/**
 * The last well-formed record of the file (reads backwards in chunks), or null.
 * @template [T=any]
 * @param {string} file
 * @returns {Promise<T | null>}
 */
export async function readLastJsonLine(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const { size } = await handle.stat();
    let end = size;
    // `carry` holds the bytes before the first newline seen so far: a line that may start in an earlier chunk.
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - TAIL_CHUNK);
      const chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      carry = Buffer.concat([chunk, carry]);
      end = start;
      const firstNl = end === 0 ? -1 : carry.indexOf(0x0a);
      if (end > 0 && firstNl === -1) continue;
      const lines = carry.subarray(firstNl + 1).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const parsed = parseLine(lines[i]);
        if (parsed !== undefined) return parsed;
      }
      carry = carry.subarray(0, Math.max(0, firstNl));
    }
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * @param {string} line
 * @returns {any} undefined when blank or malformed
 */
function parseLine(line) {
  const t = line.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}
