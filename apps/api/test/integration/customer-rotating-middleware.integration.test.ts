import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import { sql } from 'drizzle-orm';
import { buildDb } from '../../src/db/client';
import type { Bindings } from '../../src/config/env';
import { createDirectPbkdf2Worker } from '../../src/auth/pbkdf2-worker';
import { resolveEmailAuthConfig } from '../../src/customer-auth/customer-email-auth.config';
import { createEmailAuthDependencies } from '../../src/customer-auth/customer-email-auth.composition';
import { CustomerSessionService } from '../../src/customer-auth/customer-session.service';
import { signCustomerAccessToken } from '../../src/customer-auth/customer-jwt';
import { createRepositories } from '../../src/repositories';
import { CustomerCredentialRepository } from '../../src/repositories/customer-credential.repository';
import { errorHandler } from '../../src/lib/error-handler';
import { createFlagAwareCustomerAuthenticate } from '../../src/middleware/customer-authenticate';
import { appDbOf } from '../helpers/runtime-db';

/**
 * CUSTOMER-AUTH-S5-02 against real Postgres: rotating sessions are accepted beside the legacy 90-day token, a session is
 * proven against the database on every request (revocation is immediate), and existing legacy customers keep working
 * except in the documented fail-closed cases (verified email, or a credential whose legacy cutoff is unset/in the future).
 */
describe.skipIf(!process.env.DATABASE_URL)('Rotating customer sessions in the customer middleware (real Postgres)', () => {
  let client: Client;
  let db: ReturnType<typeof buildDb>;
  let repos: ReturnType<typeof createRepositories>;
  let sessions: CustomerSessionService;
  let app: Hono<{ Bindings: Bindings }>;
  let appLegacyOff: Hono<{ Bindings: Bindings }>;
  let loginDeps: ReturnType<typeof createEmailAuthDependencies>;
  const delivered: Array<{ recipient: string; challengeId: string; proof: string }> = [];
  const LEGACY_SECRET = 'legacy-jwt-secret-value-0123456789abcdef';
  const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;
  const me = (a: Hono<{ Bindings: Bindings }>, token: string) =>
    a.fetch(new Request('https://api.test/me', { headers: { Authorization: `Bearer ${token}` } }), {} as Bindings, ctx());
  const password = 'correct horse battery staple 42';
  const phone = () => `+1557${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  const phoneCustomer = async () => (await repos.customers.create({ phone: phone(), phoneVerifiedAt: new Date() })).id;

  /** Registers an email customer through the real flow and logs in, returning their rotating session credentials. */
  async function emailSession() {
    const email = `mw-${crypto.randomUUID()}@example.test`;
    delivered.length = 0;
    await loginDeps.requestProof(email);
    const message = delivered.find((d) => d.recipient === email)!;
    const registered = await loginDeps.completeRegistration({ email, challengeId: message.challengeId, proof: message.proof, name: 'Synthetic Customer', password });
    if (!registered.ok) throw new Error('registration failed');
    const login = await loginDeps.login({ email, password });
    if (!login.ok) throw new Error('login failed');
    return { customerId: registered.customerId, session: login.session };
  }

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    db = buildDb(client);
    repos = createRepositories(db);
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
      CUSTOMER_JWT_SECRET: LEGACY_SECRET,
      CLIENT_ATTRIBUTION_SECRET: 'attribution-secret-value-0123456789',
      WEB_BASE_URL: 'https://app.example.test',
      HYPERDRIVE: {}, PASSWORD_HASHER: {}, CUSTOMER_AUTH_RATE_LIMIT: {},
    } as unknown as Bindings;
    const resolved = resolveEmailAuthConfig(env);
    if (!resolved.ok) throw new Error(`test config invalid: ${resolved.missing.join(', ')}`);
    sessions = new CustomerSessionService(appDbOf(db), resolved.config.session);
    loginDeps = createEmailAuthDependencies(resolved.config, {
      withDb: (fn) => fn(db),
      hasher: createDirectPbkdf2Worker(),
      deliver: async (m) => { delivered.push(m); },
      limit: async () => true,
      resolveTrustedSource: async () => 'trusted',
    });
    const build = (service: CustomerSessionService) => {
      const a = new Hono<{ Bindings: Bindings }>();
      a.onError(errorHandler);
      a.get('/me', createFlagAwareCustomerAuthenticate({
        isEnabled: () => true,
        open: async () => ({ sessions: service, close: async () => {} }),
      }), (c) => c.json({ customerId: c.get('customerId') }));
      return a;
    };
    app = build(sessions);
    // The legacy kill switch (KS-2) off: sessions still work, legacy tokens do not.
    appLegacyOff = build(new CustomerSessionService(appDbOf(db), { ...resolved.config.session, legacyAccepted: () => false }));
  });
  afterAll(async () => {
    await client.end();
  });

  it('a rotating access token authenticates the customer', async () => {
    const { customerId, session } = await emailSession();
    const response = await me(app, session.accessToken);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ customerId });
  });

  it('revoking the session takes effect IMMEDIATELY, not at token expiry', async () => {
    const { customerId, session } = await emailSession();
    expect((await me(app, session.accessToken)).status).toBe(200);
    expect(await sessions.revokeSession({ customerId, sessionId: session.sessionId })).toBe(true);
    expect((await me(app, session.accessToken)).status).toBe(401);
  });

  it('a suspended customer loses access at once, session token included', async () => {
    const { customerId, session } = await emailSession();
    await db.execute(sql`update customers set status = 'suspended' where id = ${customerId}`);
    expect((await me(app, session.accessToken)).status).toBe(401);
  });

  it('a token signed with the wrong key, or a tampered one, is refused', async () => {
    const { session } = await emailSession();
    const [h, p, s] = session.accessToken.split('.');
    expect((await me(app, `${h}.${p}.${s!.slice(0, -2)}${s!.endsWith('AA') ? 'BB' : 'AA'}`)).status).toBe(401);
    expect((await me(app, await signCustomerAccessToken(crypto.randomUUID(), 'a-different-secret-value-0123456789abcdef'))).status).toBe(401);
  });

  it('EXISTING customers keep working: a legacy 90-day token for a phone customer with no credential is accepted', async () => {
    const id = await phoneCustomer();
    const response = await me(app, await signCustomerAccessToken(id, LEGACY_SECRET));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ customerId: id });
  });

  it('a legacy token for a customer with a VERIFIED EMAIL is refused (low-assurance policy: use the rotating session)', async () => {
    const { customerId } = await emailSession();
    expect((await me(app, await signCustomerAccessToken(customerId, LEGACY_SECRET))).status).toBe(401);
  });

  it('legacy tokens vs a credential cutoff: unset or in the future is refused (fail closed), a past cutoff is accepted', async () => {
    const id = await phoneCustomer();
    await new CustomerCredentialRepository(db).create({ customerId: id, passwordHash: 'pbkdf2$1$c2FsdA$aGFzaA', now: new Date() });
    const token = await signCustomerAccessToken(id, LEGACY_SECRET);
    // Enrolling a password sets the cutoff to "now": a token issued in the same instant or earlier does not survive a future cutoff.
    await db.execute(sql`update customer_credentials set legacy_tokens_invalid_before = now() + interval '1 hour' where customer_id = ${id}`);
    expect((await me(app, token)).status).toBe(401);
    // READINESS RISK (see the S5-01 record): an existing credential row whose cutoff is NULL locks that customer's legacy token out.
    await db.execute(sql`update customer_credentials set legacy_tokens_invalid_before = null where customer_id = ${id}`);
    expect((await me(app, token)).status).toBe(401);
    await db.execute(sql`update customer_credentials set legacy_tokens_invalid_before = now() - interval '1 day' where customer_id = ${id}`);
    expect((await me(app, token)).status).toBe(200);
  });

  it('the legacy kill switch (KS-2) refuses every legacy token while rotating sessions keep working', async () => {
    const id = await phoneCustomer();
    expect((await me(appLegacyOff, await signCustomerAccessToken(id, LEGACY_SECRET))).status).toBe(401);
    const { session } = await emailSession();
    expect((await me(appLegacyOff, session.accessToken)).status).toBe(200);
  });

  it('a suspended phone customer with a legacy token is refused', async () => {
    const id = await phoneCustomer();
    await db.execute(sql`update customers set status = 'suspended' where id = ${id}`);
    expect((await me(app, await signCustomerAccessToken(id, LEGACY_SECRET))).status).toBe(401);
  });
  // --- STAGING ACCEPTANCE CLOSURE: legacy-token compatibility, expiry, deletion and session isolation (real Postgres) ---
  const rawLegacy = (claims: Record<string, unknown>, secret = LEGACY_SECRET) => {
    const iat = Math.floor(Date.now() / 1000);
    return sign({ type: 'customer_access', iat, exp: iat + 900, ...claims }, secret, 'HS256');
  };

  it('an EXPIRED legacy token is refused even for an otherwise valid phone customer', async () => {
    const id = await phoneCustomer();
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect((await me(app, await rawLegacy({ sub: id, iat: past - 900, exp: past }))).status).toBe(401);
    expect((await me(app, await rawLegacy({ sub: id }))).status).toBe(200); // the same customer with a live token still works
  });

  it('a legacy token of the wrong type, or for a customer that does not exist, is refused', async () => {
    const id = await phoneCustomer();
    expect((await me(app, await rawLegacy({ sub: id, type: 'customer_refresh' }))).status).toBe(401);
    expect((await me(app, await rawLegacy({ sub: crypto.randomUUID() }))).status).toBe(401);
  });

  it('a legacy token for a soft-deleted customer is refused', async () => {
    const id = await phoneCustomer();
    expect((await me(app, await rawLegacy({ sub: id }))).status).toBe(200);
    await db.execute(sql`update customers set is_deleted = true, deleted_at = now() where id = ${id}`);
    expect((await me(app, await rawLegacy({ sub: id }))).status).toBe(401);
  });

  it('session isolation: each token resolves to its own customer only, and revoking one customer changes nothing for another', async () => {
    const legacyId = await phoneCustomer();
    const { customerId: emailId, session } = await emailSession();
    const legacyToken = await signCustomerAccessToken(legacyId, LEGACY_SECRET);
    const legacyResponse = await me(app, legacyToken);
    const emailResponse = await me(app, session.accessToken);
    expect(await legacyResponse.json()).toEqual({ customerId: legacyId });
    expect(await emailResponse.json()).toEqual({ customerId: emailId });
    expect(legacyId).not.toBe(emailId);
    // Revoke the email customer's session: it dies at once; the other customer's legacy token is untouched.
    expect(await sessions.revokeSession({ customerId: emailId, sessionId: session.sessionId })).toBe(true);
    expect((await me(app, session.accessToken)).status).toBe(401);
    expect((await me(app, legacyToken)).status).toBe(200);
  });

  it('a token signed with the rotating key is not accepted as a legacy token and vice versa (the two keyspaces stay separate)', async () => {
    const id = await phoneCustomer();
    expect((await me(app, await rawLegacy({ sub: id }, 's'.repeat(40)))).status).toBe(401);
  });
});
