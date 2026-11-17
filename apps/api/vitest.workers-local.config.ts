import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/** Offline Workers-runtime tests (no remote bindings): `vitest run --config vitest.workers-local.config.ts`. */
export default defineWorkersConfig({
  test: {
    include: ['test/workers-local/**/*.test.ts'],
    poolOptions: { workers: { singleWorker: true, wrangler: { configPath: './wrangler.workers-local.toml' } } },
  },
});
