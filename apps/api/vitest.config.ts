import { defineConfig } from 'vitest/config';

/**
 * Default `pnpm test` run: fast, no external dependencies. Covers
 * framework-agnostic business logic only (password hashing, JWT,
 * AuthService against in-memory fakes) -- nothing here touches a real
 * database or the Workers runtime. See vitest.integration.config.ts and
 * vitest.workers.config.ts for those.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
