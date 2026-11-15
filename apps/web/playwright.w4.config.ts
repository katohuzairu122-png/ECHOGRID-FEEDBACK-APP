import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const database = new URL(process.env.DATABASE_URL ?? 'postgresql://localhost/unknown');
if (!['localhost', '127.0.0.1'].includes(database.hostname) || database.pathname !== '/echogrid_w4_test') {
  throw new Error('W4 requires the disposable local echogrid_w4_test database.');
}

const servers = Array.isArray(base.webServer) ? base.webServer : [];
const api = servers[0]!;
export default defineConfig({
  ...base,
  testDir: './w4-acceptance',
  timeout: 120_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { ...base.use, trace: 'on', screenshot: 'only-on-failure' },
  webServer: [
    ...(process.env.CI === 'true' ? [{
      command: 'pnpm --filter @echo-grid-feedback/api exec tsx scripts/customer-session-browser-fixture.ts',
      url: 'http://127.0.0.1:8792/health', reuseExistingServer: false, timeout: 60_000,
    }] : []),
    { ...api, reuseExistingServer: false, timeout: 60_000 },
    { command: 'node w4-acceptance/local-proxy.mjs', url: 'http://127.0.0.1:8788/health', reuseExistingServer: false },
    {
      // Exercise the built Web surface so the Next.js development overlay
      // cannot intercept taps on bottom navigation in either direction.
      command: 'pnpm exec next start',
      url: 'http://localhost:3000',
      env: { API_BASE_URL: 'http://127.0.0.1:8788' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
