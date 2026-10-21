import { vi } from 'vitest';

/**
 * Runtime parity for HETA-01-F1 Blocks D/E. The G-track's keyring review and remediation suites target the pinned
 * test-only copy test/fixtures/heta-f1-keyring-remediated.ts. This file redirects exactly that import to the RUNTIME
 * module (./keyring) and re-runs both suites unchanged, so the E1-E6 corrections are proven for the code that ships and
 * the two cannot drift apart silently. Their provenance (source-hash) tests still read the fixture files and still pass.
 */
vi.mock('../../../test/fixtures/heta-f1-keyring-remediated', async () => {
  const runtime = await import('./keyring');
  return { ...runtime };
});

await import('./keyring-review.test');
await import('./keyring-remediation.test');
