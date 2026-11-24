import { defineConfig, devices } from '@playwright/test';

const database = new URL(process.env.DATABASE_URL ?? 'postgresql://localhost/unknown');
if (
  process.env.CI !== 'true' ||
  process.env.CUSTOMER_AUTH_R5_TEST_ONLY !== 'true' ||
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  database.pathname !== '/echogrid_customer_auth_r5_test'
) {
  throw new Error('R5 customer-auth browser tests require the dedicated disposable CI database.');
}

const clientAttributionSecret = process.env.CLIENT_ATTRIBUTION_SECRET;
if (!clientAttributionSecret || Buffer.byteLength(clientAttributionSecret) < 32) {
  throw new Error('R5 customer-auth browser tests require a per-run attribution secret.');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: ['customer-auth-r5-provisional.spec.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  retries: 0,
  // Keep CI evidence in text-only logs; a failed-test DOM snapshot can contain
  // a synthetic password or a proof-bearing form value.
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:3000',
    extraHTTPHeaders: { 'cf-connecting-ip': '198.51.100.77' },
    trace: 'off',
    screenshot: 'off',
  },
  webServer: [
    {
      command:
        'pnpm --filter @echo-grid-feedback/api exec node --import tsx/esm scripts/customer-auth-r5-browser-fixture.ts',
      url: 'http://127.0.0.1:8792/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm dev',
      url: 'http://localhost:3000',
      env: {
        API_BASE_URL: 'http://127.0.0.1:8792',
        CUSTOMER_EMAIL_AUTH_ENABLED: 'true',
        CUSTOMER_LEGACY_UPGRADE_ENABLED: 'true',
        CUSTOMER_RECOVERY_ENABLED: 'true',
        CUSTOMER_PASSWORD_MIN_LENGTH: '8',
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
