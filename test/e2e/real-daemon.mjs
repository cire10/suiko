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

/**
 * The REAL daemon serving a code review of a scripted git repository (test/helpers/git-repo.js), with the agent side
 * driven through the real CLI as child processes (`bin/specreview.js` with the repo's hermetic env): `review`,
 * `wait`, `apply`, `revise` reach this in-process daemon through its daemon.json in the repo's SPECREVIEW_HOME.
 *
 *   const repo = await designRepo();
 *   const real = await startRealCodeDaemon(repo);
 *   const opened = await real.cli(['review', '--json']);        // { code, stdout, stderr }
 *   const wait = real.spawn(['wait', 'cr-feat']);                // a background wait; await wait.done
 *   await real.close();                                          // also removes the repo
 *
 * @param {import('../helpers/git-repo.js').TestRepo} repo
 * @param {{ agent?: string, codePollMs?: number }} [opts]
 */
export async function startRealCodeDaemon(repo, opts = {}) {
  const { spawn } = await import('node:child_process');
  const { startDaemon } = await import('../../src/daemon/main.js');
  const bin = path.resolve(HERE, '..', '..', 'bin', 'specreview.js');
  const daemon = await startDaemon({ uiPort: 0, contentPort: 0, home: repo.home, logFile: false, idleMs: 0, timing: { codePollMs: opts.codePollMs ?? 250 } });
  const env = { ...repo.env, SPECREVIEW_HOME: repo.home, SPECREVIEW_AGENT: opts.agent ?? 'claude' };
  /** @type {Set<import('node:child_process').ChildProcess>} */
  const children = new Set();

  /**
   * Starts the CLI; `done` resolves when it exits.
   * @param {string[]} args @param {{ input?: string, cwd?: string }} [o]
   */
  const run = (args, o = {}) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: o.cwd ?? repo.root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(o.input ?? '');
    /** @type {Promise<{ code: number | null, stdout: string, stderr: string }>} */
    const done = new Promise((resolve) => {
      child.on('close', (code) => {
        children.delete(child);
        resolve({ code, stdout, stderr });
      });
    });
    return { child, done, output: () => ({ stdout, stderr }) };
  };

  return {
    repo,
    daemon,
    token: daemon.token,
    uiOrigin: daemon.uiOrigin,
    contentOrigin: daemon.contentOrigin,
    /** SPA URL of a doc (or the home page). @param {string} [docId] @param {string} [wsId] */
    url(docId, wsId) {
      return docId && wsId ? `${daemon.uiOrigin}/d/${encodeURIComponent(wsId)}/${encodeURIComponent(docId)}?k=${daemon.token}` : `${daemon.uiOrigin}/?k=${daemon.token}`;
    },
    /** Runs the CLI to completion. @param {string[]} args @param {{ input?: string, cwd?: string }} [o] */
    cli: (args, o) => run(args, o).done,
    /** Starts the CLI in the background (a `wait`). @param {string[]} args @param {{ input?: string, cwd?: string }} [o] */
    spawn: run,
    async close() {
      for (const c of children) c.kill('SIGTERM');
      await daemon.close('test');
      await repo.cleanup().catch(() => {});
    },
  };
}
