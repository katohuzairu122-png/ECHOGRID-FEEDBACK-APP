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
    // Each file opens its own real Postgres connection in beforeAll; running
    // all 6 files in parallel (Vitest's default) opened 6+ simultaneous
    // connections to Neon's serverless compute and reliably produced
    // ETIMEDOUT/ENETUNREACH errors. Serial execution avoids the connection
    // storm. Cold-start latency on top of that also exceeded the 5s/10s
    // defaults for the first query in a file -- raised alongside it.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
