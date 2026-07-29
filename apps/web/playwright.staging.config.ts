import { defineConfig, devices } from '@playwright/test';

/**
 * Runs the same e2e/ specs as playwright.config.ts, but against the live
 * deployed site instead of a local dev server -- no `webServer` block (the
 * deployed Worker is already running), a real domain for `baseURL`, and
 * longer timeouts to account for real network latency instead of
 * localhost's near-zero round trip.
 *
 * There is no separate staging environment for this project -- "staging"
 * here is the same live Cloudflare Workers deployment and the same Neon
 * database production uses. Running these specs creates real signup/
 * business/branch/feedback rows, not throwaway data in an isolated
 * environment. Run deliberately, not as part of routine CI.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.STAGING_BASE_URL ?? 'https://echo-grid.uk',
    trace: 'on-first-retry',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
