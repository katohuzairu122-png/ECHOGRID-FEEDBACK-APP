import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';

if (process.env.CI !== 'true' || !process.env.GITHUB_ENV) {
  throw new Error('Customer-auth R5 secrets may only be prepared inside isolated GitHub Actions.');
}

const values = {
  CUSTOMER_AUTH_R5_TEST_ONLY: 'true',
  CUSTOMER_AUTH_R5_MAILBOX_TOKEN: randomBytes(32).toString('base64url'),
  CLIENT_ATTRIBUTION_SECRET: randomBytes(32).toString('base64url'),
  CUSTOMER_EMAIL_AUTH_HMAC_SECRET: randomBytes(32).toString('base64url'),
  CUSTOMER_SESSION_SIGNING_SECRET: randomBytes(32).toString('base64url'),
  CUSTOMER_JWT_SECRET: randomBytes(32).toString('base64url'),
  E2E_CUSTOMER_EMAIL: `r5-${randomBytes(8).toString('hex')}@example.test`,
  E2E_CUSTOMER_PASSWORD: randomBytes(24).toString('base64url'),
};

appendFileSync(
  process.env.GITHUB_ENV,
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n') + '\n',
  {
    encoding: 'utf8',
    mode: 0o600,
  },
);
