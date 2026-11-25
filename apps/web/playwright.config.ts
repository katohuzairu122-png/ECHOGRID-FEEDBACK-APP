import { defineConfig, devices } from '@playwright/test';

/**
 * E2E layer: the only tier that exercises this app's async Server
 * Components, real Server Actions, and the actual BFF httpOnly-cookie flow
 * end to end -- none of which vitest.config.ts's jsdom layer can touch.
 *
 * Least likely of this project's test tiers to run cleanly out of the box,
 * same caveat apps/api's test:workers carries: `webServer` below starts
 * both dev servers automatically, but neither migrations nor
 * `pnpm db:seed` are run for you, and DATABASE_URL/Hyperdrive must already
 * point at a real, reachable Postgres. Unverified this session -- see
 * README's testing section before trusting it.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // signup/business/branch data isn't isolated per test yet
  workers: 1,
  timeout: 60_000,
  // Hosted CI shares one source address with every spec, so the API's per-minute rate limits (e.g. 10 authentication and 20 public requests) can
  // reject a request that has nothing to do with what a spec verifies. A rejected request creates nothing and the window clears within a minute,
  // so a failed spec is retried (twice) in CI only; a retried pass is reported as FLAKY by Playwright, never hidden. Local runs never retry.
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: 'pnpm --filter @echo-grid-feedback/api exec wrangler dev --local',
      url: 'http://localhost:8787/health',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'pnpm dev',
      url: 'http://localhost:3000',
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

