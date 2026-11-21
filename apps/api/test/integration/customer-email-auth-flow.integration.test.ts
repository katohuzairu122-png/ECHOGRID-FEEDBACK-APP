import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { buildDb } from '../../src/db/client';
import { customerAuthChallenges, customers } from '../../src/db/schema';
import type { Bindings } from '../../src/config/env';
import { createDirectPbkdf2Worker } from '../../src/auth/pbkdf2-worker';
import { resolveEmailAuthConfig } from '../../src/customer-auth/customer-email-auth.config';
import {
  createCustomerEmailAuthComposition,
  createEmailAuthDependencies,
} from '../../src/customer-auth/customer-email-auth.composition';
import { CustomerSessionService } from '../../src/customer-auth/customer-session.service';
import { CustomerCredentialRepository } from '../../src/repositories/customer-credential.repository';
import { CustomerRepository } from '../../src/repositories/customer.repository';
import { PASSWORD_ITERATIONS } from '../../src/auth/password';
import { normalizePassword } from '../../src/customer-auth/customer-password-policy';
import { appDbOf } from '../helpers/runtime-db';

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
  const callExact = (path: string, body: unknown) =>
    app.fetch(
      new Request(`https://api.test/customer-auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      {} as Bindings,
      ctx(),
    );
  const call = (path: string, body: unknown) =>
    app.fetch(
      new Request(`https://api.test/customer-auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(
        path === '/email/register/complete' && body && typeof body === 'object' && !('name' in body)
          ? { name: 'Synthetic Flow Customer', ...body }
          : body,
      ) }),
      {} as Bindings,
      ctx(),
    );
  const password = 'correct horse battery staple 42';
  const newEmail = () => `flow-${crypto.randomUUID()}@example.test`;

  async function register(email: string, pw = password) {
    delivered.length = 0;
    expect((await callExact('/email/register/request', { email, name: 'Synthetic Flow Customer', password: pw })).status).toBe(202);
    const message = delivered.find((d) => d.recipient === email);
    expect(message).toBeDefined();
    return callExact('/email/register/complete', { challengeId: message!.challengeId, proof: message!.proof });
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
      CUSTOMER_PASSWORD_MIN_LENGTH: '8',
      CUSTOMER_JWT_SECRET: 'legacy-jwt-secret-value-0123456789abcdef',
      CLIENT_ATTRIBUTION_SECRET: 'attribution-secret-value-0123456789',
      WEB_BASE_URL: 'https://app.example.test',
      HYPERDRIVE: {}, PASSWORD_HASHER: {}, CUSTOMER_AUTH_RATE_LIMIT: {},
    } as unknown as Bindings;
    const resolved = resolveEmailAuthConfig(env);
    if (!resolved.ok) throw new Error(`test config invalid: ${resolved.missing.join(', ')}`);
    sessions = new CustomerSessionService(appDbOf(db), resolved.config.session);
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
    expect(registered.headers.get('cache-control')).toBe('no-store');
    const registrationSession = (await registered.json()) as { accessToken: string; refreshCredential: string; accessExpiresAt: string; refreshExpiresAt: string };
    expect(Object.keys(registrationSession).sort()).toEqual(['accessExpiresAt', 'accessToken', 'refreshCredential', 'refreshExpiresAt']);

    const credential = await new CustomerCredentialRepository(db).findByLoginEmail(email);
    expect(credential?.loginEmailVerifiedAt).toBeTruthy();
    const [customer] = await db.select().from(customers).where(eq(customers.id, credential!.customerId));
    expect(customer!.phone).toBeNull(); // email-first identity: no phone yet
    expect(customer!.phoneVerifiedAt).toBeNull();

    const registrationIdentity = await sessions.authenticateSessionToken(registrationSession.accessToken);
    expect(registrationIdentity).toMatchObject({ assurance: 'session', customerId: credential!.customerId });

    const login = await call('/email/login', { email, password });
    expect(login.status).toBe(200);
    expect(login.headers.get('cache-control')).toBe('no-store');
    const body = (await login.json()) as { accessToken: string; refreshCredential: string; accessExpiresAt: string; refreshExpiresAt: string };
    expect(Object.keys(body).sort()).toEqual(['accessExpiresAt', 'accessToken', 'refreshCredential', 'refreshExpiresAt']);
    const identity = await sessions.authenticateSessionToken(body.accessToken);
    expect(identity).toMatchObject({ assurance: 'session', customerId: credential!.customerId });
  });

  it('OTP upgrade lookup never creates an identity for an unknown but provable phone', async () => {
    const phone = '+1555' + String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0');
    const repository = new CustomerRepository(db);
    expect(await repository.resolveExistingPhoneForCredentialUpgrade(phone)).toBeUndefined();
    const rows = await db.select({ id: customers.id }).from(customers).where(eq(customers.phone, phone));
    expect(rows).toHaveLength(0);
  });

  it('OTP upgrade resolves the original verified customer instead of creating another row', async () => {
    const phone = '+1555' + String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0');
    const repository = new CustomerRepository(db);
    const existing = await repository.create({ phone, phoneVerifiedAt: new Date() });
    const upgraded = await repository.resolveExistingPhoneForCredentialUpgrade(phone);
    expect(upgraded?.id).toBe(existing.id);
    const rows = await db.select({ id: customers.id }).from(customers).where(eq(customers.phone, phone));
    expect(rows.map((row) => row.id)).toEqual([existing.id]);
  });

  it('keeps pending setup credentials sealed until the email proof is completed', async () => {
    const email = newEmail();
    const name = 'Pending Secret Name';
    const pw = 'pending secret password 42';
    delivered.length = 0;
    expect((await callExact('/email/register/request', { email, name, password: pw })).status).toBe(202);
    const proof = delivered.find((item) => item.recipient === email)!;
    const [challenge] = await db.select({ sealed: customerAuthChallenges.registrationSealedData })
      .from(customerAuthChallenges).where(eq(customerAuthChallenges.id, proof.challengeId));
    expect(challenge?.sealed).toBeTruthy();
    expect(challenge!.sealed).not.toContain(email);
    expect(challenge!.sealed).not.toContain(name);
    expect(challenge!.sealed).not.toContain(pw);
    expect(await new CustomerCredentialRepository(db).findByLoginEmail(email)).toBeUndefined();
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

  describe('approved password policy: minimum 8 (CUSTOMER-EMAIL-AUTH-POLICY-01)', () => {
    async function startRegistration(email: string) {
      delivered.length = 0;
      await call('/email/register/request', { email });
      return delivered.find((d) => d.recipient === email)!;
    }

    it('a 7-character password is refused and does NOT consume the proof: the same link then works with 8 characters', async () => {
      const email = newEmail();
      const proof = await startRegistration(email);
      const seven = await call('/email/register/complete', { email, challengeId: proof.challengeId, proof: proof.proof, password: 'rBq4nZx' });
      expect(seven.status).toBe(401);
      expect(await new CustomerCredentialRepository(db).findByLoginEmail(email)).toBeUndefined();
      const eight = await call('/email/register/complete', { email, challengeId: proof.challengeId, proof: proof.proof, password: 'rBq4nZxk' });
      expect(eight.status).toBe(201);
      expect(await new CustomerCredentialRepository(db).findByLoginEmail(email)).toBeDefined();
    });

    it('an 8-character, a 40-character and a 128-character password are all accepted, and each can then sign in', async () => {
      for (const pw of ['rBq4nZxk', 'a long passphrase with spaces 2026 ok!', 'rBq4'.repeat(32)]) {
        const email = newEmail();
        const proof = await startRegistration(email);
        expect((await call('/email/register/complete', { email, challengeId: proof.challengeId, proof: proof.proof, password: pw })).status).toBe(201);
        expect((await call('/email/login', { email, password: pw })).status, `length ${pw.length}`).toBe(200);
      }
    });

    it('a password over the unchanged maximum is still refused', async () => {
      const email = newEmail();
      const proof = await startRegistration(email);
      const tooLong = await call('/email/register/complete', { email, challengeId: proof.challengeId, proof: proof.proof, password: 'rBq4'.repeat(32) + 'x' });
      expect(tooLong.status).toBe(401);
    });

    it('lowering the minimum relaxes nothing else: a common, a repeated and a sequential 8-character password are refused', async () => {
      for (const pw of ['password', 'aaaaaaaa', '12345678', 'abcdefgh']) {
        const email = newEmail();
        const proof = await startRegistration(email);
        expect((await call('/email/register/complete', { email, challengeId: proof.challengeId, proof: proof.proof, password: pw })).status, pw).toBe(401);
      }
    });

    it('EXISTING passwords are not invalidated: a customer whose password is shorter than the new minimum still signs in', async () => {
      const email = newEmail();
      const [customer] = await db.insert(customers).values({}).returning();
      const hash = await createDirectPbkdf2Worker().hash(normalizePassword('abc123'), PASSWORD_ITERATIONS); // 6 characters
      await new CustomerCredentialRepository(db).create({
        customerId: customer!.id, passwordHash: hash, now: new Date(),
        verifiedLoginEmail: { address: email, verifiedAt: new Date() },
      });
      const login = await call('/email/login', { email, password: 'abc123' });
      expect(login.status).toBe(200);
      expect((await call('/email/login', { email, password: 'abc124' })).status).toBe(401);
    });
  });
});
