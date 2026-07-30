import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Component/logic tests only -- fast, no server, no browser. Covers Client
 * Components (forms, dialogs) and pure functions.
 *
 * Deliberately CANNOT cover this app's Server Components: every page.tsx/
 * layout.tsx here is an async function, and Vitest + React Testing Library
 * does not support rendering async Server Components (confirmed current as
 * of mid-2026 via Next.js's own testing docs) -- that gap is exactly what
 * playwright.config.ts's E2E layer exists for, mirroring how apps/api
 * splits unit tests (fakes) from integration tests (real Postgres) by what
 * each tier can and can't actually verify.
 */
export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // userEvent-driven interaction tests (typing, clicking through a dialog)
    // are legitimately slower than plain unit tests -- the 5s default leaves
    // too little margin under concurrent load (e.g. running alongside the
    // api package's PBKDF2 suite). Raise it; fast tests are unaffected since
    // the timeout is per-test.
    testTimeout: 20000,
  },
});
