// @ts-check
// `suiko close <doc> [--json]` (design 9.2): ends the review session; running waits exit 5.

import { EXIT } from '../../shared/protocol.js';
import { expectPositionals } from '../args.js';
import { callOp, docContext } from '../runtime.js';

export const spec = {
  name: 'close',
  usage: 'close <doc> [--json]',
  summary: 'End the review session for a doc; any running `wait` exits 5.',
  options: {},
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ positionals }) {
  expectPositionals('close', positionals, 1, 1, spec.usage);
  return { doc: positionals[0] };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ doc: string }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const { ctx, engine, docId } = await docContext(rt, input.doc);
  const res = await callOp(engine, 'closeSession', ctx, docId);
  return {
    exit: EXIT.OK,
    text: `suiko: closed the review session for ${docId}; running waits exit 5`,
    json: { doc: docId, closed: true, ...(res && typeof res === 'object' ? res : {}) },
  };
}
