import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

/** Renders the CONTAINED components to static HTML fixtures for the real-Chromium spec (see playwright.components.config.ts). Not part of `pnpm test`. */
export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: { environment: 'node', include: ['e2e/components/render-fixtures.vitest.ts'], testTimeout: 60000 },
});
