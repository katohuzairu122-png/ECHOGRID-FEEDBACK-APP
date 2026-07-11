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
  retries: 0,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: 'pnpm --filter @echo-grid-feedback/api dev',
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
