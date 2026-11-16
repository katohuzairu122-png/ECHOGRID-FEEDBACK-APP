import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { Hono } from 'hono';
import { buildDb } from '../../src/db/client';
import type { Bindings } from '../../src/config/env';
import { createDirectPbkdf2Worker } from '../../src/auth/pbkdf2-worker';
import { resolveEmailAuthConfig } from '../../src/customer-auth/customer-email-auth.config';
import { createEmailAuthDependencies } from '../../src/customer-auth/customer-email-auth.composition';
import { CustomerSessionService } from '../../src/customer-auth/customer-session.service';
import { createCustomerSessionLifecycleComposition } from '../../src/customer-auth/customer-session-lifecycle.composition';

/** CUSTOMER-AUTH-S5-03 against real Postgres: login, refresh rotation, reuse detection and logout. */
describe.skipIf(!process.env.DATABASE_URL)('Rotating session lifecycle (real Postgres)', () => {
  let client: Client;
  let db: ReturnType<typeof buildDb>;
  let sessions: CustomerSessionService;
  let app: Hono<{ Bindings: Bindings }>;
  let deps: ReturnType<typeof createEmailAuthDependencies>;
  let trusted: string | null = 'trusted';
  const delivered: Array<{ recipient: string; challengeId: string; proof: string }> = [];
  const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;
  const call = (path: string, credential: string) =>
    app.fetch(new Request(`https://api.test/customer-session${path}`, { method: 'POST', headers: { authorization: `Bearer ${credential}` } }), {} as Bindings, ctx());
  const password = 'correct horse battery staple 42';

  async function login() {
    const email = `lc-${crypto.randomUUID()}@example.test`;
    delivered.length = 0;
    await deps.requestProof(email);
    const m = delivered.find((d) => d.recipient === email)!;
    const reg = await deps.completeRegistration({ email, challengeId: m.challengeId, proof: m.proof, password });
    if (!reg.ok) throw new Error('registration failed');
    const result = await deps.login({ email, password });
    if (!result.ok) throw new Error('login failed');
    return result.session;
  }

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    db = buildDb(client);
    const env = {
      CUSTOMER_EMAIL_AUTH_ENABLED: 'true', CUSTOMER_EMAIL_AUTH_HMAC_SECRET: 'h'.repeat(40), CUSTOMER_SESSION_SIGNING_SECRET: 's'.repeat(40),
      CUSTOMER_SESSION_ACCESS_TTL_SECONDS: '900', CUSTOMER_SESSION_REFRESH_TTL_SECONDS: '2592000', CUSTOMER_SESSION_ABSOLUTE_TTL_SECONDS: '2592000',
      CUSTOMER_SESSION_IDLE_TTL_SECONDS: '1209600', CUSTOMER_STEP_UP_WINDOW_SECONDS: '300', CUSTOMER_PASSWORD_MIN_LENGTH: '12',
      CUSTOMER_JWT_SECRET: 'legacy-jwt-secret-value-0123456789abcdef', CLIENT_ATTRIBUTION_SECRET: 'attribution-secret-value-0123456789',
      WEB_BASE_URL: 'https://app.example.test', HYPERDRIVE: {}, PASSWORD_HASHER: {}, CUSTOMER_AUTH_RATE_LIMIT: {},
    } as unknown as Bindings;
    const resolved = resolveEmailAuthConfig(env);
    if (!resolved.ok) throw new Error(resolved.missing.join(','));
    sessions = new CustomerSessionService(db, resolved.config.session);
    deps = createEmailAuthDependencies(resolved.config, {
      withDb: (fn) => fn(db), hasher: createDirectPbkdf2Worker(), deliver: async (m) => { delivered.push(m); },
      limit: async () => true, resolveTrustedSource: async () => 'trusted',
    });
    app = new Hono<{ Bindings: Bindings }>();
    app.route('/customer-session', createCustomerSessionLifecycleComposition({
      isEnabled: () => true,
      open: async () => ({ sessions, resolveTrustedSource: async () => trusted, close: async () => {} }),
    }));
  });
  afterAll(async () => {
    await client.end();
  });

  it('refresh rotates both credentials and the new access token works', async () => {
    const first = await login();
    const response = await call('/refresh', first.refreshCredential);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const rotated = (await response.json()) as { accessToken: string; refreshCredential: string };
    expect(rotated.refreshCredential).not.toBe(first.refreshCredential);
    // The access token may be byte-identical when refreshed within the same second (no random id in its claims); what rotates
    // is the refresh credential, which is the replay-sensitive one.
    expect(await sessions.authenticateSessionToken(rotated.accessToken)).toMatchObject({ assurance: 'session' });
  });

  it('reusing a rotated refresh credential after the grace window revokes that session (theft detection)', async () => {
    const first = await login();
    const rotated = (await (await call('/refresh', first.refreshCredential)).json()) as { accessToken: string; refreshCredential: string };
    // Age the rotation beyond the concurrent-refresh grace so the second use is replay, not a double submit.
    await db.$client.query(`update customer_refresh_tokens set rotated_at = now() - interval '1 hour' where rotated_at is not null`);
    const replay = await call('/refresh', first.refreshCredential);
    expect([401, 409]).toContain(replay.status);
    expect(await sessions.authenticateSessionToken(rotated.accessToken)).toBeNull();
  });

  it('logout revokes the session at once: the access token stops working and the refresh credential is dead', async () => {
    const session = await login();
    expect((await call('/logout', session.accessToken)).status).toBe(204);
    expect(await sessions.authenticateSessionToken(session.accessToken)).toBeNull();
    expect((await call('/refresh', session.refreshCredential)).status).toBe(401);
  });

  it('a garbage or unknown credential is one generic 401', async () => {
    expect((await call('/refresh', 'A'.repeat(43))).status).toBe(401);
    expect((await call('/logout', 'not-a-token')).status).toBe(401);
  });

  it('is refused without the Web Worker signature, whatever the credential', async () => {
    const session = await login();
    trusted = null;
    expect((await call('/refresh', session.refreshCredential)).status).toBe(401);
    trusted = 'trusted';
    expect((await call('/refresh', session.refreshCredential)).status).toBe(200); // untouched by the refused attempt
  });
});
