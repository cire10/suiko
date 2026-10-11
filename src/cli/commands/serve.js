// @ts-check
// `specreview serve [--foreground] [--port N]` (design 9.2 / 10.1).
// --foreground runs the daemon in this process (src/daemon/main.js startDaemon; this is what ensureDaemon spawns)
// and returns only when it has closed.
// Without it, the daemon is started in the background if needed and its address is printed.
// --port N sets the UI port (content port = N + 1); in the background mode it is passed as SPECREVIEW_PORT.

import { SpecReviewError, UsageError } from '../../core/store/errors.js';
import { EXIT } from '../../shared/protocol.js';
import { expectPositionals } from '../args.js';

export const spec = {
  name: 'serve',
  usage: 'serve [--foreground] [--port N]',
  summary: 'Start the local review server (in the background unless --foreground).',
  options: { foreground: { type: 'boolean' }, port: { type: 'string' } },
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ values, positionals }) {
  expectPositionals('serve', positionals, 0, 0, spec.usage);
  /** @type {number | undefined} */
  let port;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65534) throw new UsageError(`serve: invalid --port ${values.port}`);
  }
  return { foreground: Boolean(values.foreground), port };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ foreground: boolean, port?: number }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  if (input.foreground) {
    const start = rt.deps.startDaemon ?? (await loadDaemon()).startDaemon;
    const daemon = await start({ foreground: true, uiPort: input.port, contentPort: input.port ? input.port + 1 : undefined });
    // startDaemon resolves once listening; the process lives until the daemon closes (shutdown, idle, signal; in
    // foreground mode the daemon exits the process itself after a graceful shutdown)
    if (daemon?.closed && typeof daemon.closed.then === 'function') await daemon.closed;
    return { exit: EXIT.OK, printed: true };
  }
  const env = { ...rt.env };
  if (input.port) env.SPECREVIEW_PORT = String(input.port);
  const info = await rt.ensureDaemon({ env });
  return {
    exit: EXIT.OK,
    text: `specreview: review server running at http://127.0.0.1:${info.uiPort} (content port ${info.contentPort}, pid ${info.pid})`,
    json: { uiPort: info.uiPort, contentPort: info.contentPort, pid: info.pid, version: info.version },
  };
}

/** @returns {Promise<{ startDaemon: (opts: object) => Promise<any> }>} */
async function loadDaemon() {
  try {
    return await import('../../daemon/main.js');
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    const missing = e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes('daemon/main.js');
    throw new SpecReviewError(
      missing ? 'the review server is not installed (src/daemon/main.js is missing)' : `the review server failed to load: ${e.message}`,
      { cause: err },
    );
  }
}
