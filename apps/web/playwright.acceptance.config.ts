import { defineConfig, devices } from '@playwright/test';
import { resolveTargets } from './e2e/acceptance/targets';

/**
 * CASHIER-AUTH-02E E2-C browser acceptance. Opt-in: set E2E_ACCEPTANCE_MODE=local (a running local stack) or =staging (refused until the
 * owner approves the staging hostnames in apps/api/scripts/acceptance/cashier-02/staging-targets.json). No webServer is started, nothing is cleaned up.
 * The JSON report (E2E_REPORT_FILE) is what the API harness ingests with --browser-results.
 */
const targets = resolveTargets(process.env);

export default defineConfig({
  testDir: './e2e/acceptance',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: process.env.E2E_REPORT_FILE ?? 'test-results/cashier-02-report.json' }]],
  use: { baseURL: targets.web, trace: 'off', actionTimeout: 15_000, navigationTimeout: 30_000 },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Optional: a pre-installed Chromium when the browser build Playwright expects is not available (for example in a container).
        ...(process.env.E2E_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM_PATH, args: ['--no-sandbox'] } } : {}),
      },
    },
  ],
});
