// @ts-check
// Playwright configuration for the reviewer UI end-to-end tests (WP7).
// The tests run in-process against test/e2e/mock-server.mjs (an in-memory daemon + engine stand-in) and against the
// REAL daemon + engine (test/e2e/real-daemon.mjs). Both listen on random 127.0.0.1 ports (never 4777/4778) and use
// the system Chrome (channel 'chrome'; no browser downloads). SPECREVIEW_HOME points at a fresh temp dir, so nothing
// touches the real ~/.specreview (the real-daemon tests also give every test its own home).
// Run: npx playwright test   (or: npm run e2e)

import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set once in the runner process; workers inherit it (the config is re-evaluated there and keeps the value).
if (!process.env.SPECREVIEW_HOME) process.env.SPECREVIEW_HOME = mkdtempSync(join(tmpdir(), 'suiko-e2e-home-'));

export default defineConfig({
  testDir: './test/e2e',
  testMatch: /.*\.spec\.mjs$/,
  outputDir: join(tmpdir(), 'suiko-e2e-results'),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: process.env.CI ? 1 : 3,
  retries: 0,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1400, height: 900 },
    trace: 'off',
    screenshot: 'only-on-failure',
  },
});
