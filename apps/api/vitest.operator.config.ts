import { defineConfig } from 'vitest/config';
/** Real native operator tests. Requires a supported filesystem/kernel, not mocked file writes. */
export default defineConfig({ test: { include: ['test/operator/**/*.test.ts'], environment: 'node', testTimeout: 30000 } });
