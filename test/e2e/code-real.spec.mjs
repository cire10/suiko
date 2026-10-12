// @ts-check
// The whole code-review loop against the REAL daemon, engine and CLI (test/e2e/real-daemon.mjs
// startRealCodeDaemon): a scripted repository (the design 4.10 example, test/helpers/git-repo.js designRepo), then
//   `specreview review --json`          the agent opens the review; the URL is the in-process daemon's
//   the UI                              the reviewer comments on new-side lines, suggests a line (prefilled from
//                                       the working file), asks about removed lines (old side), comments on a
//                                       binary file, and submits
//   `specreview wait <doc>`             (started before the submit, as the agent runs it in the background) prints
//                                       the packet: repo-relative path:L.. items, src> lines, was> lines, apply
//   `specreview apply <doc> t2`         the suggestion lands in the real file
//   an Edit with the src> lines         the UI shows "Files changed since v1" (the working-tree poller)
//   `specreview revise --replies -`     records round v2
//   the UI                              v2 arrives live: Changes shows the interdiff with thread chips, Verify
//                                       (round results and the Threads tab) accepts and shows the thread's change,
//                                       Files shows the review diff at v2
// No network: git runs on temp repositories with the hermetic env; the daemon listens on random 127.0.0.1 ports.

import { test as base, expect } from '@playwright/test';
import { CODE_TESTID, TESTID } from '../../src/shared/protocol.js';
import { designRepo } from '../helpers/git-repo.js';
import { Ui } from './fixtures.mjs';
import { startRealCodeDaemon } from './real-daemon.mjs';

/** @typedef {Awaited<ReturnType<typeof startRealCodeDaemon>>} Real */
/** @typedef {import('@playwright/test').Page} Page */

const test = base.extend(/** @type {any} */ ({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here
  real: async ({}, /** @type {(r: Real) => Promise<void>} */ use) => {
    const repo = await designRepo();
    repo.git('config', 'user.name', 'Eric'); // the reviewer's name in the daemon (git user.name of the workspace)
    repo.write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    const real = await startRealCodeDaemon(repo);
    await use(real);
    await real.close();
  },
  ui: async (/** @type {any} */ { page, real }, /** @type {(u: Ui) => Promise<void>} */ use) => {
    await use(new Ui(page, /** @type {any} */ (real)));
  },
}));

/** @param {Page} page @param {string} mode */
const modeTab = (page, mode) => page.locator(`[data-testid="${TESTID.modeTab}"][data-mode="${mode}"]`);
/** @param {Page} page @param {string} path */
const card = (page, path) => page.locator(`[data-testid="${CODE_TESTID.fileDiff}"][data-path="${path}"]`);
/** @param {Page} page @param {string} path @param {'new'|'old'} side @param {number} line */
const lineBtn = (page, path, side, line) => card(page, path).locator(`[data-testid="${CODE_TESTID.lineBtn}"][data-side="${side}"][data-line="${line}"]`);

test('review -> UI comments and submit -> wait prints the packet -> apply + edit -> revise -> v2 in Changes, Verify and Files', async (/** @type {any} */ { page, ui, real }) => {
  /** @type {Real} */
  const r = real;
  const repo = r.repo;

  // ---- the agent opens the review (the CLI reuses the running daemon)
  const opened = await r.cli(['review', '--json']);
  expect(opened.code, opened.stderr).toBe(0);
  const rv = JSON.parse(opened.stdout);
  expect(rv).toMatchObject({ doc: 'cr-feat-token-refresh', kind: 'code', created: true, version: 1, mode: 'since-base', base: 'origin/main', worktree: true });
  expect(rv.files.map((/** @type {any} */ f) => `${f.status} ${f.path}`)).toEqual(['A assets/logo.png', 'M src/auth/refresh.js', 'M src/auth/store.js', 'A test/refresh.test.js']);
  expect(rv.url.startsWith(`${r.uiOrigin}/d/${rv.wsId}/cr-feat-token-refresh?k=`)).toBe(true);
  const DOC = rv.doc;

  // ---- the reviewer opens it: file tree, cards, the binary as a stub
  await page.goto(rv.url);
  await expect(page.locator('[data-view="code"][data-mode="files"][data-ready]')).toBeAttached({ timeout: 15000 });
  await expect(page.getByTestId(CODE_TESTID.fileRow)).toHaveCount(4);
  await expect(page.locator(`[data-testid="${CODE_TESTID.fileRow}"][data-path="src/auth/refresh.js"]`)).toContainText('+5');
  await expect(card(page, 'assets/logo.png').getByTestId(CODE_TESTID.stub)).toContainText('Binary file not shown.');
  // the binary is a file of the review (the engine also lists it under skipped): nothing is "not in the review"
  await expect(page.getByTestId(CODE_TESTID.fileTree)).not.toContainText('not in the review');
  await expect(page.locator('.code-skipped')).toHaveCount(0);
  await expect(lineBtn(page, 'src/auth/refresh.js', 'new', 41)).toBeVisible();

  const composer = page.getByTestId(TESTID.composer);
  // a blocking comment on new-side lines 41-44 (the added reuse check)
  await lineBtn(page, 'src/auth/refresh.js', 'new', 41).click();
  await lineBtn(page, 'src/auth/refresh.js', 'new', 44).click({ modifiers: ['Shift'] });
  await page.keyboard.press('c');
  await expect(composer).toContainText('Agent will see: src/auth/refresh.js:L41-44');
  await composer.getByRole('radio', { name: 'Blocking' }).check();
  await page.getByTestId(TESTID.composerTextarea).fill('Two tabs refreshing at once will trip this. Allow reuse within 30 s.');
  await page.getByTestId(TESTID.composerAdd).click();
  await expect(composer).toHaveCount(0);

  // a suggestion on L88, prefilled from the working file
  await lineBtn(page, 'src/auth/refresh.js', 'new', 88).click();
  await page.keyboard.press('s');
  const box = page.getByTestId(TESTID.composerSuggestion);
  await expect(box).toHaveValue('const ttlSec = 30 * 24 * 3600;');
  await box.fill('const ttlSec = config.refreshTtlSec;');
  await page.getByTestId(TESTID.composerTextarea).fill('Read it from config.');
  await page.getByTestId(TESTID.composerAdd).click();
  await expect(composer).toHaveCount(0);

  // a question on removed lines (old side of store.js, base L12-14)
  await lineBtn(page, 'src/auth/store.js', 'old', 12).click();
  await lineBtn(page, 'src/auth/store.js', 'old', 14).click({ modifiers: ['Shift'] });
  await page.keyboard.press('q');
  await expect(composer).toContainText('Agent will see: src/auth/store.js (old side) base L12-14');
  await page.getByTestId(TESTID.composerTextarea).fill('scripts/migrate.js still calls legacyLookup. Was removing it intended?');
  await page.getByTestId(TESTID.composerAdd).click();
  await expect(composer).toHaveCount(0);

  // a comment on the binary file
  await card(page, 'assets/logo.png').getByRole('button', { name: 'Comment on file' }).click();
  await expect(composer).toContainText('assets/logo.png');
  await page.getByTestId(TESTID.composerTextarea).fill('Is this the final logo?');
  await page.getByTestId(TESTID.composerAdd).click();
  await expect(composer).toHaveCount(0);
  await expect(card(page, 'src/auth/refresh.js').locator('[data-inline-id]')).toHaveCount(2);

  // ---- the agent waits in the background; the reviewer submits
  const wait = r.spawn(['wait', DOC]);
  await expect.poll(() => repo.exists(`.specreview/docs/${DOC}/doc.json`)).toBe(true);
  await page.getByTestId(TESTID.submitReviewOpen).click();
  await expect(page.getByTestId(TESTID.submitReviewDialog)).toBeVisible();
  await page.getByTestId(TESTID.submitConfirm).click();
  await expect(page.getByTestId(TESTID.submitReviewDialog)).toHaveCount(0);
  const waited = await wait.done;
  expect(waited.code, waited.stderr).toBe(0);
  const packet = waited.stdout;
  expect(packet).toContain(`SPECREVIEW FEEDBACK · ${DOC} (code review: since-base origin/main, merge-base ${repo.mergeBase.slice(0, 7)})`);
  expect(packet).toContain('CHANGES REQUESTED');
  expect(packet).toContain(`Repo root: ${repo.root} (paths below are relative to it)`);
  expect(packet).toContain('[t1] blocking · comment · src/auth/refresh.js:L41-44');
  expect(packet).toContain('  src> if (stored.used) {\n  src>   await revokeFamily(stored.family);\n  src>   throw new TokenReuseError();\n  src> }');
  expect(packet).toContain(`[t2] suggestion · src/auth/refresh.js:L88 · apply verbatim: specreview apply ${DOC} t2`);
  expect(packet).toContain('  - const ttlSec = 30 * 24 * 3600;\n  + const ttlSec = config.refreshTtlSec;');
  expect(packet).toMatch(/\[t3\] question · src\/auth\/store\.js \(old side\) base L12-14, now between L11-12/);
  expect(packet).toContain('  was> export function legacyLookup(id) {');
  expect(packet).toContain('[t4] comment · assets/logo.png (whole file)');
  expect(packet).toContain('Eric: Two tabs refreshing at once');
  expect(packet).toContain(`NEXT: edit the files -> specreview revise ${DOC} --replies - (records round v2 from your working tree) -> specreview wait ${DOC} (background)`);

  // ---- the agent applies the suggestion and edits with the src> lines
  const applied = await r.cli(['apply', DOC, 't2']);
  expect(applied.code, applied.stderr).toBe(0);
  expect(repo.read('src/auth/refresh.js')).toContain('const ttlSec = config.refreshTtlSec;\n');
  const src = 'if (stored.used) {\n  await revokeFamily(stored.family);';
  const text = repo.read('src/auth/refresh.js');
  expect(text.split(src).length).toBe(2); // unique: usable as an Edit old_string
  repo.write('src/auth/refresh.js', text.replace(src, 'if (stored.used && Date.now() - stored.usedAt > 30_000) {\n  await revokeFamily(stored.family);'));
  // the poller tells the reviewer the working tree moved on
  await expect(page.getByTestId(CODE_TESTID.resnapshot)).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.code-banner, .banner').filter({ hasText: 'Files changed since v1' })).toContainText('src/auth/refresh.js');

  // ---- the agent records round 2 with its replies
  const replies = {
    summary: 'reuse grace window, TTL from config',
    threads: {
      t1: { status: 'addressed', reply: 'Added a 30 s reuse grace window.', at: 'src/auth/refresh.js:L41' },
      t2: { status: 'addressed', reply: 'Applied.' },
      t3: { status: 'answered', reply: 'Yes: migrate.js goes away in the next PR.' },
      t4: { status: 'answered', reply: 'Yes, it is final.' },
    },
  };
  const revised = await r.cli(['revise', DOC, '--replies', '-'], { input: JSON.stringify(replies) });
  expect(revised.code, revised.stderr).toBe(0);
  expect(revised.stdout).toContain(`recorded v2 for ${DOC}`);
  expect(revised.stdout).toMatch(/src\/auth\/refresh\.js#h\d+ +L41 +-> t1 addressed/);
  expect(revised.stdout).toMatch(/src\/auth\/refresh\.js#h\d+ +L88 +-> t2 addressed +\(tagged: apply\)/);

  // ---- v2 arrives live
  const toast = page.getByTestId(TESTID.toast).filter({ hasText: 'v2 ready' });
  await expect(toast).toContainText('from claude');
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
  await expect(page.getByTestId(CODE_TESTID.resnapshot)).toHaveCount(0);

  // Changes: the interdiff v1 -> v2 of the one changed file, with the thread chips on its hunks
  await toast.getByRole('button', { name: 'Review changes' }).click();
  await expect(modeTab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#sr-base')).toHaveValue('1');
  await expect(page.locator('[data-view="code"][data-mode="changes"][data-ready]')).toBeAttached();
  await expect(page.getByTestId(CODE_TESTID.fileDiff)).toHaveCount(1);
  const changed = card(page, 'src/auth/refresh.js');
  await expect(changed.locator('tr.op-del').first()).toContainText('if (stored.used) {');
  await expect(changed.locator('tr.op-ins').filter({ hasText: 'Date.now()' })).toHaveCount(1);
  await expect(changed.locator('tr.op-ins').filter({ hasText: 'config.refreshTtlSec' })).toHaveCount(1);
  await expect(changed.locator('.cd-hunk-chips').getByRole('button', { name: 't1' })).toBeVisible();
  await expect(changed.locator('.cd-hunk-chips').getByRole('button', { name: 't2' })).toBeVisible();
  // the side list: the changed file's hunks, and the round results
  await expect(page.getByTestId(TESTID.changeItem)).toHaveCount(2);

  // Verify (round results): accept t1, which the engine resolves
  const r1 = page.locator('.round-results .result[data-thread-id="t1"]');
  await expect(r1).toContainText('Added a 30 s reuse grace window.');
  await r1.getByTestId(TESTID.verifyAccept).click();
  await expect(r1).toContainText('Resolved');
  await expect.poll(async () => {
    const st = await r.cli(['threads', DOC, '--status', 'all', '--json']);
    return JSON.parse(st.stdout).threads.find((/** @type {any} */ t) => t.id === 't1')?.status;
  }).toBe('resolved');

  // Verify (Threads tab): t2's change between the rounds
  await page.locator('.side-tabs').getByRole('tab', { name: 'Threads' }).click();
  await page.locator('.thread-panel [data-filter="verify"]').click();
  const t2 = ui.card('t2');
  await expect(t2).toContainText('Applied.');
  await t2.locator('summary').filter({ hasText: 'Show change' }).click();
  await expect(t2.locator('.minidiff')).toContainText('config.refreshTtlSec');

  // Files: the review diff at v2, with t1 inline on its moved lines
  await modeTab(page, 'review').click();
  await expect(page.locator('[data-view="code"][data-mode="files"][data-ready]')).toBeAttached();
  await expect(card(page, 'src/auth/refresh.js').locator('tr.op-ins').filter({ hasText: 'Date.now()' })).toHaveCount(1);
  await expect(card(page, 'src/auth/store.js').locator('[data-inline-id="t3"]')).toContainText('migrate.js goes away');
  expect(ui.errors).toEqual([]);
});

test('the reviewer applies a suggestion (a ui-apply round) and re-snapshots edits (a ui-record round); wait refuses a dirty tree', async (/** @type {any} */ { page, ui, real }) => {
  /** @type {Real} */
  const r = real;
  const repo = r.repo;
  const opened = await r.cli(['review', '--json']);
  expect(opened.code, opened.stderr).toBe(0);
  const rv = JSON.parse(opened.stdout);
  const DOC = rv.doc;
  await page.goto(rv.url);
  await expect(page.locator('[data-view="code"][data-mode="files"][data-ready]')).toBeAttached({ timeout: 15000 });

  // a suggestion on the new test file, sent at once
  await lineBtn(page, 'test/refresh.test.js', 'new', 3).click();
  await page.keyboard.press('s');
  const box = page.getByTestId(TESTID.composerSuggestion);
  await expect(box).toHaveValue("test('refresh', () => {});");
  await box.fill("test('refresh', async () => {});");
  await page.getByTestId(TESTID.composerTextarea).fill('Make it async.');
  await page.getByTestId(TESTID.composerAdd).click();
  await page.getByTestId(TESTID.submitReviewOpen).click();
  await page.getByTestId(TESTID.submitConfirm).click();
  await expect(page.getByTestId(TESTID.submitReviewDialog)).toHaveCount(0);

  // Apply now: the file is written and recorded as v2 by the reviewer
  const t1 = ui.card('t1');
  await t1.getByRole('button', { name: 'Apply now' }).click();
  await expect(page.getByTestId(TESTID.toast).filter({ hasText: 'Suggestion applied as v2' })).toBeVisible();
  expect(repo.read('test/refresh.test.js')).toBe("import { test } from 'node:test';\n\ntest('refresh', async () => {});\n");
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('2');
  // the reviewer's own apply resolves the thread, as for specs
  await page.locator('.thread-panel [data-filter="resolved"]').click();
  await expect(t1).toContainText('Applied in v2');

  // the agent edits a reviewed file: `wait` refuses until the round is recorded, the UI offers Re-snapshot
  repo.write('src/auth/store.js', `${repo.read('src/auth/store.js')}// tail\n`);
  const dirty = await r.cli(['wait', DOC, '--timeout', '5s']);
  expect(dirty.code).toBe(3);
  expect(dirty.stderr + dirty.stdout).toContain('src/auth/store.js');
  const resnap = page.getByTestId(CODE_TESTID.resnapshot);
  await expect(resnap).toBeVisible({ timeout: 10000 });
  await resnap.click();
  await expect(page.getByTestId(TESTID.versionPicker)).toHaveValue('3');
  await expect(resnap).toHaveCount(0);
  const log = await r.cli(['log', DOC, '--json']);
  expect(log.code, log.stderr).toBe(0);
  expect(log.stdout).toContain('ui-apply');
  expect(log.stdout).toContain('ui-record');

  // History lists the three rounds
  await modeTab(page, 'history').click();
  await expect(page.getByTestId(TESTID.historyRow)).toHaveCount(3);
  expect(ui.errors).toEqual([]);
});
