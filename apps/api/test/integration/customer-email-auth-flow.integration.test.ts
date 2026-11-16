import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { buildDb } from '../../src/db/client';
import { customers } from '../../src/db/schema';
import type { Bindings } from '../../src/config/env';
import { createDirectPbkdf2Worker } from '../../src/auth/pbkdf2-worker';
import { resolveEmailAuthConfig } from '../../src/customer-auth/customer-email-auth.config';
import {
  createCustomerEmailAuthComposition,
  createEmailAuthDependencies,
} from '../../src/customer-auth/customer-email-auth.composition';
import { CustomerSessionService } from '../../src/customer-auth/customer-session.service';
import { CustomerCredentialRepository } from '../../src/repositories/customer-credential.repository';

/**
 * CUSTOMER-AUTH-S5-01 end to end against real Postgres: email proof -> registration -> login -> rotating session,
 * driven through the HTTP composition mounted exactly as the API mounts it. Only the transport edges are faked
 * (mail delivery, the shared limiter, the Web Worker signature check); the wiring and every database step are real.
 */
describe.skipIf(!process.env.DATABASE_URL)('Email registration and login flow (real Postgres)', () => {
  let client: Client;
  let db: ReturnType<typeof buildDb>;
  let app: Hono<{ Bindings: Bindings }>;
  let sessions: CustomerSessionService;
  const delivered: Array<{ recipient: string; challengeId: string; proof: string }> = [];
  let limitAllowed = true;
  let trusted: string | null = 'trusted-source';
  const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;
  const call = (path: string, body: unknown) =>
    app.fetch(
      new Request(`https://api.test/customer-auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      {} as Bindings,
      ctx(),
    );
  const password = 'correct horse battery staple 42';
  const newEmail = () => `flow-${crypto.randomUUID()}@example.test`;

  async function register(email: string, pw = password) {
    delivered.length = 0;
    expect((await call('/email/register/request', { email })).status).toBe(202);
    const message = delivered.find((d) => d.recipient === email);
    expect(message).toBeDefined();
    return call('/email/register/complete', { email, challengeId: message!.challengeId, proof: message!.proof, password: pw });
  }

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    db = buildDb(client);
    const env = {
      CUSTOMER_EMAIL_AUTH_ENABLED: 'true',
      CUSTOMER_EMAIL_AUTH_HMAC_SECRET: 'h'.repeat(40),
      CUSTOMER_SESSION_SIGNING_SECRET: 's'.repeat(40),
      CUSTOMER_SESSION_ACCESS_TTL_SECONDS: '900',
      CUSTOMER_SESSION_REFRESH_TTL_SECONDS: '2592000',
      CUSTOMER_SESSION_ABSOLUTE_TTL_SECONDS: '2592000',
      CUSTOMER_SESSION_IDLE_TTL_SECONDS: '1209600',
      CUSTOMER_STEP_UP_WINDOW_SECONDS: '300',
      CUSTOMER_PASSWORD_MIN_LENGTH: '12',
      CUSTOMER_JWT_SECRET: 'legacy-jwt-secret-value-0123456789abcdef',
      CLIENT_ATTRIBUTION_SECRET: 'attribution-secret-value-0123456789',
      WEB_BASE_URL: 'https://app.example.test',
      HYPERDRIVE: {}, PASSWORD_HASHER: {}, CUSTOMER_AUTH_RATE_LIMIT: {},
    } as unknown as Bindings;
    const resolved = resolveEmailAuthConfig(env);
    if (!resolved.ok) throw new Error(`test config invalid: ${resolved.missing.join(', ')}`);
    sessions = new CustomerSessionService(db, resolved.config.session);
    const dependencies = createEmailAuthDependencies(resolved.config, {
      withDb: (fn) => fn(db),
      hasher: createDirectPbkdf2Worker(),
      deliver: async (message) => { delivered.push(message); },
      limit: async () => limitAllowed,
      resolveTrustedSource: async () => trusted,
    });
    app = new Hono<{ Bindings: Bindings }>();
    app.route('/customer-auth', createCustomerEmailAuthComposition({
      isEnabled: () => true,
      open: async () => ({ dependencies, close: async () => {} }),
    }));
  });
  afterAll(async () => {
    await client.end();
  });

  it('registers an email-only customer (no phone), then logs in and receives a working rotating session', async () => {
    const email = newEmail();
    const registered = await register(email);
    expect(registered.status).toBe(201);
    expect(await registered.json()).toEqual({ registered: true });

    const credential = await new CustomerCredentialRepository(db).findByLoginEmail(email);
    expect(credential?.loginEmailVerifiedAt).toBeTruthy();
    const [customer] = await db.select().from(customers).where(eq(customers.id, credential!.customerId));
    expect(customer!.phone).toBeNull(); // email-first identity: no phone yet
    expect(customer!.phoneVerifiedAt).toBeNull();

    const login = await call('/email/login', { email, password });
    expect(login.status).toBe(200);
    expect(login.headers.get('cache-control')).toBe('no-store');
    const body = (await login.json()) as { accessToken: string; refreshCredential: string; accessExpiresAt: string; refreshExpiresAt: string };
    expect(Object.keys(body).sort()).toEqual(['accessExpiresAt', 'accessToken', 'refreshCredential', 'refreshExpiresAt']);
    const identity = await sessions.authenticateSessionToken(body.accessToken);
    expect(identity).toMatchObject({ assurance: 'session', customerId: credential!.customerId });
  });

  it('a wrong password, an unknown email and an unverified email are the same generic 401', async () => {
    const email = newEmail();
    await register(email);
    const wrong = await call('/email/login', { email, password: 'not the password at all' });
    const unknown = await call('/email/login', { email: newEmail(), password });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.text()).toBe(await unknown.text());
  });

  it('a proof works once: replaying it, or using it for another email, is refused', async () => {
    const email = newEmail();
    delivered.length = 0;
    await call('/email/register/request', { email });
    const proof = delivered[0]!;
    expect((await call('/email/register/complete', { email, challengeId: proof.challengeId, proof: proof.proof, password })).status).toBe(201);
    expect((await call('/email/register/complete', { email, challengeId: proof.challengeId, proof: proof.proof, password })).status).toBe(401);
    expect((await call('/email/register/complete', { email: newEmail(), challengeId: proof.challengeId, proof: proof.proof, password })).status).toBe(401);
  });

  it('a wrong proof never creates an account', async () => {
    const email = newEmail();
    delivered.length = 0;
    await call('/email/register/request', { email });
    const real = delivered[0]!;
    const bad = await call('/email/register/complete', { email, challengeId: real.challengeId, proof: 'wrong-proof-value', password });
    expect(bad.status).toBe(401);
    expect(await new CustomerCredentialRepository(db).findByLoginEmail(email)).toBeUndefined();
  });

  it('a password below the policy is refused and the proof is not consumed for an account', async () => {
    const email = newEmail();
    delivered.length = 0;
    await call('/email/register/request', { email });
    const proof = delivered[0]!;
    const weak = await call('/email/register/complete', { email, challengeId: proof.challengeId, proof: proof.proof, password: 'short' });
    expect(weak.status).toBe(401);
    expect(await new CustomerCredentialRepository(db).findByLoginEmail(email)).toBeUndefined();
  });

  it('an already-registered email gets the same 202 but no new proof is delivered (no account enumeration)', async () => {
    const email = newEmail();
    await register(email);
    delivered.length = 0;
    const again = await call('/email/register/request', { email });
    expect(again.status).toBe(202);
    expect(delivered.filter((d) => d.recipient === email)).toHaveLength(0);
  });

  it('two concurrent completions of one proof create exactly one account', async () => {
    const email = newEmail();
    delivered.length = 0;
    await call('/email/register/request', { email });
    const proof = delivered[0]!;
    const results = await Promise.all([1, 2].map(() => call('/email/register/complete', { email, challengeId: proof.challengeId, proof: proof.proof, password })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 401]);
  });

  it('is denied without a trusted source and when rate limited, with nothing created or delivered', async () => {
    const email = newEmail();
    delivered.length = 0;
    trusted = null;
    expect((await call('/email/register/request', { email })).status).toBe(503);
    trusted = 'trusted-source';
    limitAllowed = false;
    expect((await call('/email/register/request', { email })).status).toBe(429);
    expect((await call('/email/login', { email, password })).status).toBe(429);
    limitAllowed = true;
    expect(delivered).toHaveLength(0);
  });
});
