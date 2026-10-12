// @ts-check
// `suiko stop [--rotate]` (design 10.1, amendments 2.5): POST /api/shutdown to the running daemon.
// --rotate also deletes daemon.json, so the next start generates a new API token and content secret
// (outstanding review URLs stop working; ports fall back to the defaults).

import { EXIT } from '../../shared/protocol.js';
import { expectPositionals } from '../args.js';
import { stopDaemon } from '../daemon-client.js';

export const spec = {
  name: 'stop',
  usage: 'stop [--rotate] [--json]',
  summary: 'Stop the review server. --rotate: generate a new token and secret on the next start.',
  options: { rotate: { type: 'boolean' } },
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ values, positionals }) {
  expectPositionals('stop', positionals, 0, 0, spec.usage);
  return { rotate: Boolean(values.rotate) };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ rotate?: boolean }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const res = await (rt.deps.stopDaemon ?? stopDaemon)({ rotate: Boolean(input.rotate) });
  const lines = [];
  if (!res.wasRunning) lines.push('suiko: the review server is not running');
  else if (res.stopped) lines.push(`suiko: stopped the review server (pid ${res.pid})`);
  else lines.push(`suiko: asked the review server (pid ${res.pid}) to stop, but it is still running`);
  if (res.rotated) lines.push('suiko: token and content secret will be regenerated on the next start (old review URLs stop working)');
  return { exit: res.wasRunning && !res.stopped ? EXIT.ERROR : EXIT.OK, text: lines.join('\n'), json: res };
}
