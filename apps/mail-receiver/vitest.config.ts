import { defineConfig } from 'vitest/config';

/** Pure-logic tests that need no Workers runtime. The Durable Object and Worker tests run under vitest.workers.config.ts. */
export default defineConfig({ test: { include: ['test/unit/**/*.test.ts'], environment: 'node' } });
