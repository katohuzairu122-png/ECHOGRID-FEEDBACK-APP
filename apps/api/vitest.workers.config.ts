import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/**
 * Run with `pnpm test:workers`. Runs tests inside a simulated Workers
 * runtime (Miniflare) using this project's own wrangler.toml for bindings --
 * needed for anything that touches Hono's Context, Cloudflare bindings, or
 * the exported `fetch` handler directly, none of which exist in plain Node.
 *
 * Least likely of the three test configs to run cleanly out of the box:
 * wrangler.toml still has placeholder Hyperdrive/KV/R2 IDs until real
 * Cloudflare resources are provisioned (see README "Provisioning Cloudflare
 * resources"). Tests that never reach a binding at runtime (like the 401
 * check in test/workers/health.test.ts) should still pass regardless.
 */
export default defineWorkersConfig({
  test: {
    include: ['test/workers/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
      },
    },
  },
});
