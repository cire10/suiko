// @ts-check
// The product as a user runs it (integration): the daemon is started by `specreview open` (a real CLI process that
// spawns the detached `serve --foreground` daemon on a test port), the reviewer works in the real UI in Chrome, and
// the agent side is the real CLI (`wait` in the background, a file edit, `revise --replies -`) as subprocesses.
// Checks: the UI and the doc iframe load with the guest handshake and no console errors, a mouse selection ->
// `c` -> composer -> Add to review -> Submit review reaches `wait`, and the threads render (cards + guest
// highlights) after the agent's revision. Same for the HTML fixture (its own scripts run).
//
// Isolation: temp workspace, SPECREVIEW_HOME and HOME for the subprocesses, a free port pair in 5850-5899
// (SPECREVIEW_PORT, never 4777/4778); `specreview stop` (and a pid kill as a fallback) in afterAll.

import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TESTID } from '../../src/shared/protocol.js';
import { Ui } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'bin', 'specreview.js');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'docs');

test.describe.configure({ mode: 'serial' });

/** @type {{ base: string, ws: string, home: string, env: Record<string, string>, port: number, urls: Record<string, string> }} */
const S = { base: '', ws: '', home: '', env: {}, port: 0, urls: {} };

/** @param {number} port */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function freePortPair() {
  const start = Math.floor(Math.random() * 24);
  for (let i = 0; i < 24; i++) {
    const p = 5850 + ((start + i) % 24) * 2;
    if ((await portFree(p)) && (await portFree(p + 1))) return p;
  }
  throw new Error('no free port pair in 5850-5899');
}

/**
 * Runs the real CLI (cwd = the workspace). With `background`, returns the child and a promise of its result.
 * @param {string[]} args
 * @param {{ stdin?: string }} [opts]
 */
function cli(args, { stdin } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: S.ws, env: S.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const res = { code: /** @type {number | null} */ (null), stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (d) => (res.stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d) => (res.stderr += d));
  child.stdin.end(stdin ?? '');
  const done = new Promise((resolve) => child.on('close', (code) => resolve(Object.assign(res, { code }))));
  return { child, done: /** @type {Promise<typeof res>} */ (done) };
}

/** @param {string[]} args @param {{ stdin?: string }} [opts] */
async function ok(args, opts) {
  const r = await cli(args, opts).done;
  expect(r.code, `specreview ${args.join(' ')}\n${r.stdout}\n${r.stderr}`).toBe(0);
  return r;
}

function daemonPid() {
  try {
    return JSON.parse(fs.readFileSync(path.join(S.home, 'daemon.json'), 'utf8')).pid;
  } catch {
    return null;
  }
}

test.beforeAll(async () => {
  S.base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-cli-')));
  S.ws = path.join(S.base, 'ws');
  S.home = path.join(S.base, 'home');
  fs.mkdirSync(path.join(S.ws, '.git'), { recursive: true });
  fs.mkdirSync(path.join(S.ws, 'docs', 'img'), { recursive: true });
  fs.mkdirSync(path.join(S.base, 'user-home'), { recursive: true });
  for (const f of ['kitchen-sink.md', 'app-spec.html', 'img/arch.png']) fs.copyFileSync(path.join(FIXTURES, f), path.join(S.ws, 'docs', f));
  S.port = await freePortPair();
  S.env = {
    PATH: /** @type {string} */ (process.env.PATH),
    HOME: path.join(S.base, 'user-home'),
    SPECREVIEW_BROWSER: 'none', SPECREVIEW_HOME: S.home,
    SPECREVIEW_PORT: String(S.port),
    SPECREVIEW_AGENT: 'claude',
  };
  for (const [doc, file] of [['kitchen-sink', 'docs/kitchen-sink.md'], ['app-spec', 'docs/app-spec.html']]) {
    const r = await ok(['open', file]);
    const m = /^review UI: (\S+)$/m.exec(r.stdout);
    expect(m, r.stdout).toBeTruthy();
    S.urls[doc] = /** @type {RegExpExecArray} */ (m)[1];
  }
  expect(S.urls['kitchen-sink']).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${S.port}/d/[0-9a-f]{8}/kitchen-sink\\?k=[0-9a-f]+$`));
});

test.afterAll(async () => {
  const pid = daemonPid();
  if (S.ws) await cli(['stop']).done.catch(() => null);
  if (pid) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already stopped
    }
  }
  if (S.base) fs.rmSync(S.base, { recursive: true, force: true });
});

/** The Ui helper over the CLI-started daemon. @param {import('@playwright/test').Page} page */
function uiFor(page) {
  return new Ui(page, /** @type {any} */ ({ url: (/** @type {string} */ id) => S.urls[id], contentOrigin: `http://127.0.0.1:${S.port + 1}` }));
}

/**
 * Selects `text` inside `selector` in the doc with the mouse (a real drag in the iframe).
 * @param {Ui} ui @param {import('@playwright/test').Page} page @param {string} selector @param {string} text
 */
async function dragSelect(ui, page, selector, text) {
  const r = await ui.pointIn(selector, text);
  await page.mouse.move(r.x + 1, r.cy);
  await page.mouse.down();
  await page.mouse.move(r.x + r.w / 2, r.cy, { steps: 4 });
  await page.mouse.move(r.x + r.w - 1, r.cy, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('[data-selection-comment]')).toBeEnabled();
}

test('Markdown: the CLI-started daemon serves the UI; comment -> submit -> wait -> revise -> threads render', async ({ page }) => {
  const ui = uiFor(page);
  /** @type {string[]} */
  const failed = [];
  page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
  await ui.open('kitchen-sink');
  await expect(page).toHaveTitle(/Token Service Implementation Spec/);
  const frame = await ui.frame();
  expect(frame.url()).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${S.port + 1}/c/[0-9a-f]{24}/v1/docs/kitchen-sink\\.md$`));
  await expect(frame.locator('h1')).toHaveText('Token Service Implementation Spec');
  await expect(frame.locator('pre.mermaid svg, [data-sr-kind="mermaid"] svg').first()).toBeAttached({ timeout: 15000 });
  await expect.poll(() => frame.evaluate(() => /** @type {HTMLImageElement} */ (document.querySelector('img')).naturalWidth)).toBe(160);
  await expect(page.getByTestId(TESTID.presence)).toHaveText(/No agent listening/);

  // the agent starts listening (a real background `wait`)
  const wait = cli(['wait', 'kitchen-sink']);
  await expect(page.getByTestId(TESTID.presence)).toHaveText(/claude is listening/, { timeout: 15000 });

  // select a phrase with the mouse, press c (forwarded by the guest), write, Add to review
  await dragSelect(ui, page, 'p', 'rotated on every use');
  await page.keyboard.press('c');
  const composer = page.getByTestId(TESTID.composer);
  await expect(composer.locator('.agent-sees')).toContainText('Agent will see: L51');
  await page.getByTestId(TESTID.composerTextarea).fill('What happens to requests in flight?');
  await page.getByTestId(TESTID.composerAdd).click();
  await expect(composer).toBeHidden();
  await expect(page.locator(`[data-testid="${TESTID.threadCard}"][data-draft-id]`)).toHaveCount(1);

  // Submit review: Request changes
  await page.getByTestId(TESTID.submitReviewOpen).click();
  const dialog = page.getByTestId(TESTID.submitReviewDialog);
  await dialog.locator(`[data-testid="${TESTID.submitVerdict}"] input[value="changes_requested"]`).check();
  await page.getByTestId(TESTID.submitConfirm).click();
  await expect(dialog).toBeHidden();
  const delivered = await wait.done;
  expect(delivered.code, delivered.stderr).toBe(0);
  expect(delivered.stdout).toContain('review rv1 on v1 · CHANGES REQUESTED');
  expect(delivered.stdout).toMatch(/^\[t1\] comment · L51 · /m);
  await expect(page.locator('.review-progress')).toContainText('Delivered to claude');

  // the agent edits the file (Edit tool) and records v2 with a reply
  const file = path.join(S.ws, 'docs', 'kitchen-sink.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('rotated on every use, and', 'rotated on every use (in-flight requests keep a 30 s grace window), and'));
  const revised = await ok(['revise', 'kitchen-sink', '--replies', '-'], {
    stdin: JSON.stringify({ summary: 'Grace window', threads: { t1: { status: 'addressed', reply: 'Added a 30 s grace window.' } } }),
  });
  expect(revised.stdout).toMatch(/recorded v2 for kitchen-sink .*-> t1 addressed/s);

  // the UI follows: toast, v2 in the picker, the thread card and its highlight in the doc
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'v2 ready' })).toContainText('from claude');
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
  const card = ui.card('t1');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Added a 30 s grace window.');
  await expect.poll(async () => {
    const g = await ui.inspect();
    return (g.highlights?.['sr-open'] ?? 0) + (g.highlights?.['sr-resolved'] ?? 0);
  }).toBeGreaterThan(0);
  const v2frame = await ui.frame();
  expect(v2frame.url()).toMatch(/\/v2\/docs\/kitchen-sink\.md$/);
  await expect(v2frame.locator('body')).toContainText('in-flight requests keep a 30 s grace window');
  expect(ui.errors).toEqual([]);
  expect(failed).toEqual([]);
});

test('HTML: the author scripts run in the doc, a comment reaches wait', async ({ page }) => {
  const ui = uiFor(page);
  await ui.open('app-spec');
  const frame = await ui.frame();
  await expect(frame.locator('#generated li')).toHaveCount(3);
  await expect(frame.locator('pre.mermaid svg')).toBeAttached({ timeout: 15000 });
  const wait = cli(['wait', 'app-spec']);
  await expect(page.getByTestId(TESTID.presence)).toHaveText(/claude is listening/, { timeout: 15000 });
  await dragSelect(ui, page, 'p', 'processed in three stages');
  await page.keyboard.press('c');
  const composer = page.getByTestId(TESTID.composer);
  await expect(composer.locator('.agent-sees')).toContainText('L27');
  await page.getByTestId(TESTID.composerTextarea).fill('Name the stages.');
  await page.getByTestId(TESTID.composerSendNow).click();
  await expect(composer).toBeHidden();
  const delivered = await wait.done;
  expect(delivered.code, delivered.stderr).toBe(0);
  expect(delivered.stdout).toContain('review rv1 on v1 · COMMENT');
  expect(delivered.stdout).toMatch(/src> {3}<p>Requests arrive through the API gateway and are processed in three stages\.<\/p>/);
  await expect(ui.card('t1')).toBeVisible();
  expect(ui.errors).toEqual([]);
});
