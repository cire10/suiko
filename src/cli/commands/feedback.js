// @ts-check
// `specreview feedback <doc> [--peek] [--include-drafts] [--all-open] [--json]` (design 3.13 / 9.2).
// The same packet as `wait`, without blocking. Unless --peek, the engine acknowledges earlier deliveries and marks
// the pending reviews delivered; like `wait` it receives a write(text) callback, so the delivery is recorded only
// after the packet reached stdout (with --json the packet object is rebuilt for that write; see delivery.js).
// An engine that returns the packet without calling write() still works (the packet is printed afterwards).

import { EXIT } from '../../shared/protocol.js';
import { expectPositionals } from '../args.js';
import { createDelivery, normalizePackets, packetsJson, packetsText } from '../delivery.js';
import { callOp, docContext } from '../runtime.js';

export const spec = {
  name: 'feedback',
  usage: 'feedback <doc> [--peek] [--include-drafts] [--all-open] [--json]',
  summary: 'Print the feedback packet now, without blocking. Marks the reviews delivered unless --peek.',
  options: {
    peek: { type: 'boolean' },
    'include-drafts': { type: 'boolean' },
    'all-open': { type: 'boolean' },
  },
  details: [
    '--include-drafts  also list the reviewer\'s unsubmitted drafts (clearly labelled; do not act on them)',
    '--all-open        also list threads that are waiting on the reviewer',
  ],
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ values, positionals }) {
  expectPositionals('feedback', positionals, 1, 1, spec.usage);
  return {
    doc: positionals[0],
    peek: Boolean(values.peek),
    includeDrafts: Boolean(values['include-drafts']),
    allOpen: Boolean(values['all-open']),
  };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ doc: string, peek?: boolean, includeDrafts?: boolean, allOpen?: boolean }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const { ctx, engine, doc, docId } = await docContext(rt, input.doc);
  const opts = { includeDrafts: Boolean(input.includeDrafts), allOpen: Boolean(input.allOpen) };
  const packetFor =
    typeof engine.ops.buildDocPacket === 'function'
      ? async (/** @type {string} */ text) => {
          const built = await engine.ops.buildDocPacket(ctx, (await ctx.store?.getDoc?.(docId)) ?? doc, opts);
          return built?.text === text ? built.packet : null;
        }
      : undefined;
  const delivery = createDelivery(rt, engine, { packetFor });
  /** @type {any} */
  let result;
  try {
    result = await callOp(engine, 'feedback', ctx, docId, { peek: Boolean(input.peek), ...opts, write: delivery.write, agent: rt.agent });
  } finally {
    delivery.close();
    await delivery.settle();
  }
  // the engine's return value is authoritative for the structured form (a text-only write carries no object)
  const returned = normalizePackets(result);
  if (!delivery.written()) await delivery.emit(returned.length ? returned : delivery.packets());
  const list = returned.length ? returned : delivery.packets();
  return {
    exit: EXIT.OK,
    text: delivery.text() ?? packetsText(engine, list),
    json: packetsJson(list),
    printed: rt.mode === 'cli',
  };
}
