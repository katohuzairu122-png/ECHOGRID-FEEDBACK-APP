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
  },
});
