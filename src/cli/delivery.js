// @ts-check
// Packet delivery shared by `wait` and `feedback` (design 5.4 "Delivery", amendments 2.4).
//
// The engine builds the packet under the doc lock, calls our `write(...)` callback, and records the review as
// delivered only after that promise resolves. In the CLI the callback prints the packet and resolves once the
// stdout write callback fired, so a process killed before the flush re-delivers next time. In MCP mode it only
// captures the packet (the tool result carries it). Once the command has given up (timeout, signal, supersede) or
// finished, writes are refused, so a late delivery is never recorded.
//
// Call shapes accepted from the engine: write(text) (WP3 passes the formatted packet text), write(text, packet),
// write(packet), write(packet[]), write({ packets }). Each call carries one doc's packet (`wait --all` calls it
// once per doc).
//
// --json: every packet is printed as one compact JSON line (JSON Lines; a single doc gives exactly one line).
// When the engine passed only text, `packetFor(text)` (supplied by the command) rebuilds the packet object inside
// the same doc-lock critical section, so the JSON still reaches stdout before the delivery is recorded. If it
// cannot, the write is not printed (`deferred`) and the command prints the packets the engine returned instead.

import { formatWith } from './engine.js';
import { FALLBACK_FORMATTERS } from './format.js';
import { withNewline, writeAll } from './io.js';

/**
 * @typedef {object} Delivery
 * @property {(payload: unknown, packet?: unknown) => Promise<void>} write the callback handed to the engine
 * @property {() => Promise<void>} settle waits for a write that is still in flight
 * @property {() => boolean} written whether every packet seen so far reached stdout (CLI) / was captured (MCP)
 * @property {() => any[]} packets packet objects seen so far (may lag behind texts when only text was given)
 * @property {() => string | null} text packet texts seen so far, joined by a blank line (null when none)
 * @property {(packets: any[]) => Promise<void>} emit prints packets the engine returned (nothing was written)
 * @property {() => void} close makes later writes reject
 */

/**
 * @param {import('./runtime.js').Runtime} rt
 * @param {import('./engine.js').Engine} engine
 * @param {{ signal?: AbortSignal, packetFor?: (text: string) => Promise<any | null> }} [opts]
 *   signal: once aborted, writes are refused (the wait gave up: superseded, interrupted, timed out);
 *   packetFor: rebuilds the packet object of a text-only write (--json)
 * @returns {Delivery}
 */
export function createDelivery(rt, engine, { signal, packetFor } = {}) {
  let closed = false;
  let printed = 0;
  let deferred = 0;
  /** @type {Set<string>} docs whose packet already reached stdout */
  const printedDocs = new Set();
  /** @type {any[]} */
  const packets = [];
  /** @type {string[]} */
  const texts = [];
  /** @type {Promise<void> | null} */
  let inflight = null;

  /**
   * @param {unknown} payload
   * @param {unknown} packetArg
   */
  const doWrite = async (payload, packetArg) => {
    /** @type {string} */
    let text;
    /** @type {any[]} */
    let list;
    if (typeof payload === 'string') {
      text = payload;
      list = packetArg && typeof packetArg === 'object' ? normalizePackets(packetArg) : [];
      if (!list.length && rt.mode === 'cli' && rt.json && packetFor) {
        const rebuilt = await packetFor(text).catch(() => null);
        if (rebuilt) list = [rebuilt];
      }
    } else {
      list = normalizePackets(payload);
      text = packetsText(engine, list);
    }
    if (rt.mode === 'cli') {
      if (rt.json && !list.length) {
        deferred++;
        texts.push(text);
        return; // printed from the engine's return value (see header)
      }
      await writeAll(rt.stdout, rt.json ? jsonLines(list) : withNewline(text));
    }
    for (const p of list) if (typeof p?.doc === 'string') printedDocs.add(p.doc);
    packets.push(...list);
    texts.push(text);
    printed++;
  };

  return {
    write: (payload, packetArg) => {
      if (closed || signal?.aborted) {
        return Promise.reject(new Error('suiko: the waiting command has finished; not delivering'));
      }
      const p = doWrite(payload, packetArg);
      inflight = p;
      return p;
    },
    settle: async () => {
      if (inflight) await inflight.catch(() => {});
    },
    written: () => printed > 0 && deferred === 0,
    packets: () => packets,
    text: () => (texts.length ? texts.map((t) => t.replace(/\n+$/, '')).join('\n\n') : null),
    emit: async (list) => {
      // a packet already printed by write() (wait --all, mixed) is not printed twice
      const rest = list.filter((p) => !(typeof p?.doc === 'string' && printedDocs.has(p.doc)));
      packets.splice(0, packets.length, ...list);
      texts.splice(0, texts.length, packetsText(engine, list));
      if (rt.mode === 'cli' && rest.length) await writeAll(rt.stdout, rt.json ? jsonLines(rest) : withNewline(packetsText(engine, rest)));
      printed = Math.max(1, printed);
      deferred = 0;
    },
    close: () => {
      closed = true;
    },
  };
}

/**
 * Packets of an engine payload or op result: an array, { packets }, { packet }, or a single packet object.
 * @param {unknown} payload
 * @returns {any[]}
 */
export function normalizePackets(payload) {
  if (Array.isArray(payload)) return payload.filter((p) => p && typeof p === 'object');
  const p = /** @type {any} */ (payload);
  if (!p || typeof p !== 'object') return [];
  if (Array.isArray(p.packets)) return p.packets;
  if (p.packet && typeof p.packet === 'object') return [p.packet];
  return [p];
}

/**
 * One compact JSON document per line.
 * @param {any[]} list
 * @returns {string}
 */
function jsonLines(list) {
  return list.map((p) => `${JSON.stringify(p)}\n`).join('');
}

/**
 * Text of one or more packets (separated by a blank line).
 * @param {import('./engine.js').Engine} engine
 * @param {any[]} packets
 * @returns {string}
 */
export function packetsText(engine, packets) {
  return packets.map((p) => formatWith(engine, 'formatPacket', p, () => FALLBACK_FORMATTERS.formatPacket(p))).join('\n\n');
}

/**
 * Structured form (--json value, MCP structuredContent): the packet itself for one doc;
 * { status: 'delivered', packets } for several (wait --all).
 * @param {any[]} packets
 * @returns {any}
 */
export function packetsJson(packets) {
  return packets.length === 1 ? packets[0] : { status: 'delivered', packets };
}
