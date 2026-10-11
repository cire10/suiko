// @ts-check
// The REAL daemon (WP5) and review engine (WP3) for UI e2e tests, in-process.
//
// `startRealDaemon()` builds a throwaway workspace (copies of test/fixtures/docs under <tmp>/ws/docs), points
// SPECREVIEW_HOME at <tmp>/home, opens the docs through the engine (`specreview open`), and starts the daemon on
// random ports (never 4777/4778; nothing is logged to disk). The returned handle drives the agent side through the
// same engine ops the CLI uses (feedback = delivery, revise, ask), so the UI is exercised against the real routes,
// payloads and SSE stream.
//
//   const real = await startRealDaemon();
//   await page.goto(real.url('kitchen-sink'));
//   ...
//   await real.agentFeedback('kitchen-sink');                 // `specreview feedback`: delivers submitted reviews
//   real.write('docs/kitchen-sink.md', text);                 // the agent edits the file
//   await real.revise('kitchen-sink', { summary, threads });  // `specreview revise`
//   await real.close();

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(HERE, '..', 'fixtures', 'docs');

/**
 * @param {{ files?: string[], open?: string[], reviewer?: string, agent?: string }} [opts]
 *   files: fixture paths (relative to test/fixtures/docs) copied to <ws>/docs; open: of those, the docs to track
 */
export async function startRealDaemon(opts = {}) {
  const files = opts.files ?? ['kitchen-sink.md', 'app-spec.html', 'img/arch.png'];
  const open = opts.open ?? files.filter((f) => /\.(md|html?)$/i.test(f));
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'sr-e2e-real-')));
  const root = path.join(base, 'ws');
  const home = path.join(base, 'home');
  await fsp.mkdir(path.join(root, 'docs'), { recursive: true });
  await fsp.mkdir(home, { recursive: true });
  // The engine and the daemon resolve SPECREVIEW_HOME at call time; this process only ever runs one daemon.
  process.env.SPECREVIEW_HOME = home;
  for (const f of files) {
    const dest = path.join(root, 'docs', f);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(path.join(FIXTURES, f), dest);
  }

  const ops = await import('../../src/core/review/ops.js');
  const { startDaemon } = await import('../../src/daemon/main.js');
  const { clearRenderMemoryCache } = await import('../../src/core/render/index.js');
  clearRenderMemoryCache();

  const agent = opts.agent ?? 'claude';
  const ctx = await ops.createContext({ root, cwd: root, agent, reviewer: opts.reviewer ?? 'Eric', createStore: true });
  /** @type {Record<string, string>} file name -> doc id */
  const docIds = {};
  for (const f of open) {
    const res = /** @type {any} */ (await ops.openDoc(ctx, { path: path.join('docs', f) }));
    const doc = res.doc ?? res;
    docIds[path.basename(f).replace(/\.[^.]+$/, '')] = doc.id;
  }

  const daemon = await startDaemon({ uiPort: 0, contentPort: 0, home, logFile: false, idleMs: 0 });

  /** @param {string} name fixture base name ('kitchen-sink') or doc id */
  const idOf = (name) => docIds[name] ?? name;

  return {
    root,
    home,
    ctx,
    ops,
    daemon,
    token: daemon.token,
    uiOrigin: daemon.uiOrigin,
    contentOrigin: daemon.contentOrigin,
    wsId: ctx.wsId,
    /** @param {string} name */
    docId: idOf,
    /** SPA URL of a doc (or the home page) with the ?k= token. @param {string} [name] */
    url(name) {
      return name
        ? `${daemon.uiOrigin}/d/${encodeURIComponent(ctx.wsId)}/${encodeURIComponent(idOf(name))}?k=${daemon.token}`
        : `${daemon.uiOrigin}/?k=${daemon.token}`;
    },
    /** @param {string} rel workspace-relative path */
    file: (rel) => path.join(root, rel),
    /** @param {string} rel */
    read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
    /** @param {string} rel @param {string} text */
    write: (rel, text) => fs.writeFileSync(path.join(root, rel), text),
    /** DocState as the engine sees it. @param {string} name */
    state: (name) => ops.docState(ctx, idOf(name)),
    /** The agent fetches feedback (`specreview feedback`): delivers every submitted review. @param {string} name */
    agentFeedback: (name) => ops.feedback(ctx, idOf(name)),
    /** `specreview revise` with a ReviseInput. @param {string} name @param {any} input */
    revise: (name, input) => ops.revise(ctx, idOf(name), input),
    /** `specreview ask`. @param {string} name @param {any} input */
    ask: (name, input) => ops.ask(ctx, idOf(name), input),
    async close() {
      await daemon.close('test');
      await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
    },
  };
}
