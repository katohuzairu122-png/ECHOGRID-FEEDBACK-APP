import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/gate2/b403*.test.ts'], environment: 'node', fileParallelism: false, testTimeout: 30000, hookTimeout: 30000 } });
