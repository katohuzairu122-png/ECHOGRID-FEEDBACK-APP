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
    // The password tests exercise PBKDF2 at the real production work factor
    // (600k iterations, OWASP's 2026 minimum) -- a single hash is ~1-3s, and
    // a test that hashes several times can exceed Vitest's 5s default on a
    // loaded machine. Give the deliberately-expensive crypto headroom; fast
    // tests are unaffected since the timeout is per-test.
    testTimeout: 30000,
  },
});
