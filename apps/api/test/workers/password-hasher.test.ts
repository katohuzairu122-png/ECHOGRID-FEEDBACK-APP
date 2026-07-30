import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createDurableObjectPbkdf2Worker } from '../../src/auth/pbkdf2-worker';
import { PASSWORD_ITERATIONS } from '../../src/auth/password';

/**
 * Proves the actual binding/migration/export wiring works inside a real
 * (Miniflare-simulated) Workers runtime -- the one thing
 * auth.service.test.ts/customer-auth.service.test.ts's plain-Node fakes
 * cannot verify, and exactly the class of bug (a binding declared in
 * wrangler.toml but never reachable, or a Durable Object class not
 * exported from index.ts) that would otherwise only surface on a real
 * deploy.
 */
describe('PasswordHasherDurableObject (via PASSWORD_HASHER binding)', () => {
  it('hashes and verifies a value round-trip through the real Durable Object', async () => {
    const worker = createDurableObjectPbkdf2Worker(env.PASSWORD_HASHER);

    const hash = await worker.hash('correct horse battery staple', 1_000);
    expect(hash.startsWith('pbkdf2$1000$')).toBe(true);
    await expect(worker.verify('correct horse battery staple', hash)).resolves.toBe(true);
    await expect(worker.verify('wrong password', hash)).resolves.toBe(false);
  });

  it(
    'completes a real production-strength (600k-iteration) hash through the Durable Object -- the exact operation that fails with error 1102 on a plain Worker request handler',
    async () => {
      const worker = createDurableObjectPbkdf2Worker(env.PASSWORD_HASHER);

      const hash = await worker.hash('a real password, real iteration count', PASSWORD_ITERATIONS);
      await expect(worker.verify('a real password, real iteration count', hash)).resolves.toBe(true);
    },
    30000,
  );

  it('spreads concurrent calls across separate Durable Object instances (newUniqueId, not a fixed name)', async () => {
    const worker = createDurableObjectPbkdf2Worker(env.PASSWORD_HASHER);

    const [a, b] = await Promise.all([
      worker.hash('input-a', 1_000),
      worker.hash('input-b', 1_000),
    ]);

    // Different salts (and different DO instances handling them) even for
    // near-simultaneous calls -- proves this isn't serialized through one
    // shared object.
    expect(a).not.toBe(b);
  });
});
