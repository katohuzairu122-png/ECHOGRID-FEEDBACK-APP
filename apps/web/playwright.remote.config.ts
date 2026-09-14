import { defineConfig, devices } from '@playwright/test';
import { resolveRemoteBaseUrl } from './e2e/base-url';

/**
 * Runs the same e2e/ specs as playwright.config.ts, but against an
 * already-deployed site instead of a local dev server -- no `webServer`
 * block (the Worker is already running) and longer timeouts for real
 * network latency instead of localhost's near-zero round trip.
 *
 * RENAMED FROM playwright.staging.config.ts (audit P3-5). The old name was
 * the more dangerous half of the bug: it promised an isolated environment
 * that does not exist. Its own header admitted as much -- "staging" was the
 * same Cloudflare Workers deployment and the same Neon database as
 * production -- and yet `baseURL` defaulted to `https://echo-grid.uk`. One
 * command, no prompt, no warning, and three specs wrote a real signup, a
 * real business on a real public slug, a real QR code and real billable
 * feedback straight into production.
 *
 * The audit's note was that this was safe only because nothing invoked the
 * file. A file staying un-invoked is not a control, so the control now
 * lives in e2e/base-url.ts, which has no default and refuses the
 * production hosts outright. See that file for what a run actually costs;
 * the sharpest part is that submitted feedback bills Anthropic against a
 * PLATFORM-WIDE spend limit, so a test run can exhaust budget real
 * businesses' summaries are then refused for.
 *
 * THE REAL FIX IS STILL OUTSTANDING: a staging environment -- a second
 * Neon branch plus [env.staging] in both wrangler.toml files. Until that
 * exists, the only safe target here is a local stack, which is what
 * playwright.config.ts already does better. This config's honest purpose
 * today is smoke-testing a deployment you are willing to dirty.
 *
 * TWO KNOWN GAPS, deliberately not closed in this change:
 *  - The specs clean nothing up. They do tag their data (`e2e-`,
 *    `loyalty-e2e-`, `qr-e2e-` slugs and @example.test emails), so a purge
 *    is writable, but every table here is soft-delete-only by design.
 *  - They are not isolated from each other (`fullyParallel: false` below is
 *    load-bearing, same as in playwright.config.ts).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    // Throws at config load if E2E_BASE_URL is unset or names a production
    // host without the explicit acknowledgement. Playwright reports that as
    // a config error before any spec runs, which is the point: there is no
    // window in which a partially-completed run has already written.
    baseURL: resolveRemoteBaseUrl({
      baseUrl: process.env.E2E_BASE_URL,
      ack: process.env.E2E_ALLOW_PRODUCTION,
    }),
    trace: 'on-first-retry',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
