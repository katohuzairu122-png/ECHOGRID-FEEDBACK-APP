import { defineConfig } from 'vitest/config';

/**
 * Run with `pnpm test:integration`. Requires a real DATABASE_URL (same
 * connection drizzle-kit and the seed script use) -- deliberately separate
 * from the default `pnpm test` run so a missing/unconfigured database never
 * fails a routine test run. Suites use describe.skipIf(!process.env.DATABASE_URL)
 * so running this without a database configured skips cleanly instead of
 * erroring. Never point DATABASE_URL at production: these tests create and
 * delete real rows.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    // Serial for TWO independent reasons. The first is historical: each file
    // opens its own real Postgres connection in beforeAll, and running them
    // in parallel against Neon's serverless compute opened 6+ simultaneous
    // connections and reliably produced ETIMEDOUT/ENETUNREACH. A local or
    // CI-container Postgres removes that one entirely.
    //
    // The second survives the move and is the reason this must STAY false:
    // ai-usage-stale-pending.integration.test.ts asserts on PLATFORM-WIDE
    // queries -- abandonStalePending(cutoff) returns a count of every stale
    // row in the table regardless of business, and totalCostSince(since) is
    // likewise unscoped. Another file writing ai_usage_log rows concurrently
    // changes those numbers, so parallelism would make that suite flaky in a
    // way that looks like a real regression. Scoping those assertions to the
    // suite's own business is the prerequisite for re-enabling this; the
    // connection limit no longer is.
    //
    // Cold-start latency also exceeded the 5s/10s timeout defaults for the
    // first query in a file against Neon -- raised alongside it, and
    // harmless when the database is local.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
