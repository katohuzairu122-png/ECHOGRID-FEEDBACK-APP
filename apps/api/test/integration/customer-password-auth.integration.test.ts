import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Client } from 'pg';
import { sign } from 'hono/jwt';
import { buildDb } from '../../src/db/client';
import { createDirectPbkdf2Worker, type Pbkdf2Worker } from '../../src/auth/pbkdf2-worker';
import { CustomerRepository } from '../../src/repositories/customer.repository';
import { CustomerAuthEventRepository } from '../../src/repositories/customer-auth-event.repository';
import { CustomerSessionService } from '../../src/customer-auth/customer-session.service';
import {
  CustomerPasswordAuthService,
  type VerifiedPhoneProof,
} from '../../src/customer-auth/customer-password-auth.service';

/**
 * CUSTOMER-AUTH-01D-4a: password registration, sign-in, recovery, enrollment and
 * change against REAL Postgres. Domain layer only; nothing here is an HTTP route.
 * Rows use unique per-run phone numbers and are deleted in afterAll.
 * PBKDF2 runs at 1000 iterations so the suite is fast; production uses 600,000.
 */
describe.skipIf(!process.env.DATABASE_URL)('customer password auth (integration)', () => {
  const SESSION_SECRET = 'integration-session-secret-not-for-production';
  const LEGACY_SECRET = 'integration-legacy-secret-not-for-production';
  const RUN = Date.now().toString().slice(-8);
  const PHONE = (i: number) => `+1557${RUN}${i}`;
  const GOOD = 'correct horse battery staple';
  const GOOD2 = 'another long passphrase here';

  let client: Client;
  let client2: Client;
  let clockMs = Date.now();
  let verifyCalls = 0;
  let hashCalls = 0;

  const countingHasher = (): Pbkdf2Worker => {
    const real = createDirectPbkdf2Worker();
    return {
      hash: (i, n) => {
        hashCalls += 1;
        return real.hash(i, n);
      },
      verify: (i, h) => {
        verifyCalls += 1;
        return real.verify(i, h);
      },
    };
  };

  const build = (c: Client) => {
    const db = buildDb(c);
    const sessions = new CustomerSessionService(db, {
      sessionSigningSecret: SESSION_SECRET,
      legacySigningSecret: LEGACY_SECRET,
      legacyAccepted: () => true,
      accessTtlSeconds: 900,
      refreshTtlSeconds: 30 * 86400,
      absoluteTtlSeconds: 30 * 86400,
      idleTtlSeconds: 7 * 86400,
      stepUpWindowSeconds: 300,
      now: () => new Date(clockMs),
    });
    const auth = new CustomerPasswordAuthService(db, sessions, countingHasher(), {
      passwordMinLength: 10,
      phoneProofMaxAgeSeconds: 300,
      passwordIterations: 1000,
      now: () => new Date(clockMs),
    });
    return { sessions, auth, customers: new CustomerRepository(db) };
  };
  let a: ReturnType<typeof build>;
  let b: ReturnType<typeof build>;

  const proof = (phone: string, over: Partial<VerifiedPhoneProof> = {}): VerifiedPhoneProof => ({
    phone,
    verifiedAt: new Date(clockMs),
    source: 'local_otp',
    ...over,
  });
  const q = <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    client.query(text, values).then((r) => r.rows as T[]);
  const customerByPhone = async (phone: string) =>
    (
      await q<{ id: string; status: string }>('SELECT id, status FROM customers WHERE phone=$1', [
        phone,
      ])
    )[0];
  const legacyToken = (customerId: string, iat: number) =>
    sign(
      { sub: customerId, type: 'customer_access', iat, exp: iat + 90 * 86400 },
      LEGACY_SECRET,
      'HS256',
    );

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    client2 = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([client.connect(), client2.connect()]);
    a = build(client);
    b = build(client2);
  });
  afterEach(() => {
    clockMs = Date.now();
    verifyCalls = 0;
    hashCalls = 0;
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await client.query(`DELETE FROM customers WHERE phone LIKE $1`, [`+1557${RUN}%`]);
    await Promise.all([client.end(), client2.end()]);
  });

  describe('construction', () => {
    it('refuses to invent the owner-decided values', () => {
      const db = buildDb(client);
      const mk = (over: object) => () =>
        new CustomerPasswordAuthService(db, a.sessions, countingHasher(), {
          passwordMinLength: 10,
          phoneProofMaxAgeSeconds: 300,
          ...over,
        } as never);
      expect(mk({ passwordMinLength: 0 })).toThrow();
      expect(mk({ passwordMinLength: undefined })).toThrow();
      expect(mk({ phoneProofMaxAgeSeconds: 0 })).toThrow();
      expect(mk({})).not.toThrow();
    });
  });

  describe('phone proof', () => {
    it('refuses a stale, a future-dated and a malformed proof in every flow, and creates nothing', async () => {
      const bad = [
        proof(PHONE(1), { verifiedAt: new Date(clockMs - 301_000) }),
        proof(PHONE(1), { verifiedAt: new Date(clockMs + 60_000) }),
        proof('5551234567'),
        proof('+0123'),
      ];
      for (const p of bad) {
        expect(await a.auth.signInWithVerifiedPhone(p)).toEqual({
          ok: false,
          reason: 'proof_invalid',
        });
        expect(await a.auth.registerWithPassword(p, GOOD)).toEqual({
          ok: false,
          reason: 'proof_invalid',
        });
        expect(await a.auth.recoverPassword(p, GOOD)).toEqual({
          ok: false,
          reason: 'proof_invalid',
        });
      }
      expect(await customerByPhone(PHONE(1))).toBeUndefined();
      expect(hashCalls).toBe(0);
    });
  });

  describe('signInWithVerifiedPhone', () => {
    it('creates a customer once, even for two simultaneous first verifications (the 01C race)', async () => {
      const [r1, r2] = await Promise.all([
        a.auth.signInWithVerifiedPhone(proof(PHONE(2))),
        b.auth.signInWithVerifiedPhone(proof(PHONE(2))),
      ]);
      expect(r1.ok && r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect([r1.isNewCustomer, r2.isNewCustomer].filter(Boolean)).toHaveLength(1);
        expect(r1.customerId).toBe(r2.customerId);
        expect(r1.hasPassword).toBe(false);
      }
      expect(await q('SELECT 1 FROM customers WHERE phone=$1', [PHONE(2)])).toHaveLength(1);
    });

    it('keeps the existing identity for a returning customer and reports hasPassword', async () => {
      const first = await a.auth.registerWithPassword(proof(PHONE(3)), GOOD);
      expect(first.ok).toBe(true);
      const again = await a.auth.signInWithVerifiedPhone(proof(PHONE(3)));
      expect(again.ok && again.hasPassword && !again.isNewCustomer).toBe(true);
      expect(first.ok && again.ok && first.customerId === again.customerId).toBe(true);
    });

    it('marks a previously unverified customer verified, and refuses suspended and soft-deleted-phone customers cleanly', async () => {
      await q(`INSERT INTO customers (phone, phone_verified_at) VALUES ($1, NULL)`, [PHONE(4)]);
      expect((await a.auth.signInWithVerifiedPhone(proof(PHONE(4)))).ok).toBe(true);
      expect(
        (
          await q<{ phone_verified_at: Date | null }>(
            'SELECT phone_verified_at FROM customers WHERE phone=$1',
            [PHONE(4)],
          )
        )[0]!.phone_verified_at,
      ).not.toBeNull();

      await q(
        `INSERT INTO customers (phone, phone_verified_at, status) VALUES ($1, now(), 'suspended')`,
        [PHONE(5)],
      );
      expect(await a.auth.signInWithVerifiedPhone(proof(PHONE(5)))).toEqual({
        ok: false,
        reason: 'customer_inactive',
      });

      await q(
        `INSERT INTO customers (phone, phone_verified_at, is_deleted) VALUES ($1, now(), true)`,
        [PHONE(6)],
      );
      expect(await a.auth.signInWithVerifiedPhone(proof(PHONE(6)))).toEqual({
        ok: false,
        reason: 'phone_unavailable',
      });
      expect(await a.auth.registerWithPassword(proof(PHONE(6)), GOOD)).toEqual({
        ok: false,
        reason: 'phone_unavailable',
      });
    });
  });

  describe('registerWithPassword', () => {
    it('creates the customer, stores only a hash that verifies, sets the legacy cutoff and opens a session', async () => {
      const r = await a.auth.registerWithPassword(proof(PHONE(10)), GOOD);
      expect(r.ok && r.isNewCustomer).toBe(true);
      const c = (await customerByPhone(PHONE(10)))!;
      const [cred] = await q<{ password_hash: string; legacy_tokens_invalid_before: Date | null }>(
        'SELECT password_hash, legacy_tokens_invalid_before FROM customer_credentials WHERE customer_id=$1',
        [c.id],
      );
      expect(cred!.password_hash).toMatch(/^pbkdf2\$1000\$/);
      expect(cred!.password_hash).not.toContain(GOOD);
      expect(cred!.legacy_tokens_invalid_before).not.toBeNull();
      expect(await createDirectPbkdf2Worker().verify(GOOD, cred!.password_hash)).toBe(true);
      // The plaintext is in no table at all.
      for (const t of [
        'customers',
        'customer_credentials',
        'customer_sessions',
        'customer_refresh_tokens',
        'customer_auth_events',
      ]) {
        expect(await q(`SELECT 1 FROM ${t} x WHERE x::text LIKE $1`, [`%${GOOD}%`])).toHaveLength(
          0,
        );
      }
      if (r.ok)
        expect(await a.sessions.authenticateSessionToken(r.session.accessToken)).toMatchObject({
          customerId: c.id,
        });
    });

    it('returns every policy violation and changes nothing, hashing nothing', async () => {
      const r = await a.auth.registerWithPassword(proof(PHONE(11)), 'aaa');
      expect(r).toMatchObject({ ok: false, reason: 'policy' });
      if (!r.ok && r.reason === 'policy')
        expect(r.violations).toEqual(expect.arrayContaining(['too_short', 'repetitive']));
      expect(await customerByPhone(PHONE(11))).toBeUndefined();
      expect(hashCalls).toBe(0);
    });

    it('refuses a phone that already has a password and changes nothing', async () => {
      await a.auth.registerWithPassword(proof(PHONE(12)), GOOD);
      const c = (await customerByPhone(PHONE(12)))!;
      const [before] = await q<{ password_hash: string }>(
        'SELECT password_hash FROM customer_credentials WHERE customer_id=$1',
        [c.id],
      );
      expect(await a.auth.registerWithPassword(proof(PHONE(12)), GOOD2)).toEqual({
        ok: false,
        reason: 'already_registered',
      });
      const [after] = await q<{ password_hash: string }>(
        'SELECT password_hash FROM customer_credentials WHERE customer_id=$1',
        [c.id],
      );
      expect(after).toEqual(before);
    });

    it('attaches the first password to an EXISTING OTP-only customer: same identity, no duplicate', async () => {
      const otp = await a.auth.signInWithVerifiedPhone(proof(PHONE(13)));
      expect(otp.ok).toBe(true);
      const r = await a.auth.registerWithPassword(proof(PHONE(13)), GOOD);
      expect(r.ok && !r.isNewCustomer).toBe(true);
      expect(otp.ok && r.ok && otp.customerId === r.customerId).toBe(true);
      expect(await q('SELECT 1 FROM customers WHERE phone=$1', [PHONE(13)])).toHaveLength(1);
    });

    it('two simultaneous registrations of one phone: one wins, one is told already_registered, one customer, one credential', async () => {
      const [r1, r2] = await Promise.all([
        a.auth.registerWithPassword(proof(PHONE(14)), GOOD),
        b.auth.registerWithPassword(proof(PHONE(14)), GOOD2),
      ]);
      expect([r1, r2].filter((r) => r.ok)).toHaveLength(1);
      expect([r1, r2].filter((r) => !r.ok && r.reason === 'already_registered')).toHaveLength(1);
      const c = (await customerByPhone(PHONE(14)))!;
      expect(await q('SELECT 1 FROM customers WHERE phone=$1', [PHONE(14)])).toHaveLength(1);
      expect(
        await q('SELECT 1 FROM customer_credentials WHERE customer_id=$1', [c.id]),
      ).toHaveLength(1);
    });

    it('normalizes the password (NFKC): the fullwidth and ASCII forms are the same password', async () => {
      await a.auth.registerWithPassword(
        proof(PHONE(15)),
        'ｃｏｒｒｅｃｔ ｈｏｒｓｅ ｂａｔｔｅｒｙ',
      );
      const r = await a.auth.loginWithPassword({
        phone: PHONE(15),
        password: 'correct horse battery',
      });
      expect(r.ok).toBe(true);
    });
  });

  describe('loginWithPassword', () => {
    it('signs in with the right password, opens a password-method session and records the verification', async () => {
      await a.auth.registerWithPassword(proof(PHONE(20)), GOOD);
      const r = await a.auth.loginWithPassword({
        phone: PHONE(20),
        password: GOOD,
        deviceLabel: 'Test phone',
      });
      expect(r.ok).toBe(true);
      const c = (await customerByPhone(PHONE(20)))!;
      const rows = await q<{ auth_method: string; step_up_verified_at: Date | null }>(
        `SELECT auth_method, step_up_verified_at FROM customer_sessions WHERE customer_id=$1 AND auth_method='password'`,
        [c.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.step_up_verified_at).toBeNull(); // a password sign-in is NOT a fresh phone proof
      expect(
        (
          await q<{ last_verified_at: Date | null }>(
            'SELECT last_verified_at FROM customer_credentials WHERE customer_id=$1',
            [c.id],
          )
        )[0]!.last_verified_at,
      ).not.toBeNull();
    });

    it('returns the IDENTICAL generic failure for wrong password, unknown phone, no password, suspended and malformed input', async () => {
      await a.auth.registerWithPassword(proof(PHONE(21)), GOOD);
      await a.auth.signInWithVerifiedPhone(proof(PHONE(22))); // exists, no password
      await a.auth.registerWithPassword(proof(PHONE(23)), GOOD);
      await q(`UPDATE customers SET status='suspended' WHERE phone=$1`, [PHONE(23)]);
      const cases = [
        { phone: PHONE(21), password: 'wrong password entirely' },
        { phone: PHONE(29), password: GOOD }, // unknown phone
        { phone: PHONE(22), password: GOOD }, // customer without a password
        { phone: PHONE(23), password: GOOD }, // suspended, with the CORRECT password
        { phone: 'not-a-phone', password: GOOD },
        { phone: PHONE(21), password: '' },
      ];
      const results = [];
      for (const c of cases) results.push(await a.auth.loginWithPassword(c));
      for (const r of results) expect(r).toEqual({ ok: false, kind: 'invalid' });
      expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
      // Two independent layers refuse a suspended customer (this check, and establishSession). The
      // caller sees nothing different, but the audit trail must say WHY, so the explicit check is pinned here.
      const suspended = (await customerByPhone(PHONE(23)))!;
      const events = await new CustomerAuthEventRepository(buildDb(client)).listForCustomer(
        suspended.id,
        10,
      );
      expect(
        events.some(
          (e) =>
            e.eventType === 'password_login_failed' &&
            e.outcome === 'blocked' &&
            e.reasonCode === 'customer_inactive',
        ),
      ).toBe(true);
      // Registration opened an OTP session earlier; the suspended password attempt must not have opened a password one.
      expect(
        await q(`SELECT 1 FROM customer_sessions WHERE customer_id=$1 AND auth_method='password'`, [
          suspended.id,
        ]),
      ).toHaveLength(0);
    });

    it('performs exactly ONE hash verification on every path that reaches the check, so timing does not reveal which failure it was', async () => {
      await a.auth.registerWithPassword(proof(PHONE(24)), GOOD);
      await a.auth.signInWithVerifiedPhone(proof(PHONE(25)));
      verifyCalls = 0;
      const paths: Array<[string, { phone: string; password: string }]> = [
        ['wrong password', { phone: PHONE(24), password: 'wrong password entirely' }],
        ['unknown phone', { phone: PHONE(28), password: GOOD }],
        ['no password set', { phone: PHONE(25), password: GOOD }],
        ['success', { phone: PHONE(24), password: GOOD }],
      ];
      for (const [, input] of paths) {
        verifyCalls = 0;
        await a.auth.loginWithPassword(input);
        expect(verifyCalls).toBe(1);
      }
    });

    it('does NO hashing at all for malformed or oversized input (a request cannot force unbounded PBKDF2 work)', async () => {
      verifyCalls = 0;
      expect(
        await a.auth.loginWithPassword({ phone: PHONE(24), password: 'x'.repeat(5_000_000) }),
      ).toEqual({ ok: false, kind: 'invalid' });
      expect(await a.auth.loginWithPassword({ phone: 'bad', password: GOOD })).toEqual({
        ok: false,
        kind: 'invalid',
      });
      expect(
        await a.auth.loginWithPassword({ phone: PHONE(24), password: undefined as never }),
      ).toEqual({ ok: false, kind: 'invalid' });
      expect(verifyCalls).toBe(0);
    });

    it('audits failures only for a KNOWN customer; an unknown phone writes nothing (no unbounded log growth)', async () => {
      await a.auth.registerWithPassword(proof(PHONE(26)), GOOD);
      const c = (await customerByPhone(PHONE(26)))!;
      const before = (await q<{ n: string }>('SELECT count(*) n FROM customer_auth_events'))[0]!.n;
      for (let i = 0; i < 4; i += 1)
        await a.auth.loginWithPassword({ phone: PHONE(27), password: GOOD });
      expect((await q<{ n: string }>('SELECT count(*) n FROM customer_auth_events'))[0]!.n).toBe(
        before,
      );
      await a.auth.loginWithPassword({ phone: PHONE(26), password: 'wrong password entirely' });
      const events = await new CustomerAuthEventRepository(buildDb(client)).listForCustomer(
        c.id,
        10,
      );
      expect(
        events.some(
          (e) => e.eventType === 'password_login_failed' && e.reasonCode === 'bad_password',
        ),
      ).toBe(true);
    });
  });

  describe('recoverPassword', () => {
    it('replaces the password, revokes EVERY old session, opens a recovery session and kills older legacy tokens', async () => {
      clockMs = Date.now() - 400_000;
      await a.auth.registerWithPassword(proof(PHONE(30)), GOOD);
      const c = (await customerByPhone(PHONE(30)))!;
      const s1 = await a.sessions.establishSession({ customerId: c.id, authMethod: 'otp' });
      const s2 = await a.sessions.establishSession({ customerId: c.id, authMethod: 'otp' });
      const legacy = await legacyToken(c.id, Math.floor(Date.now() / 1000) - 100);
      expect(await a.sessions.authenticateLegacyToken(legacy)).not.toBeNull();
      clockMs = Date.now();

      const r = await a.auth.recoverPassword(proof(PHONE(30)), GOOD2);
      expect(r.ok).toBe(true);
      expect(await a.auth.loginWithPassword({ phone: PHONE(30), password: GOOD })).toEqual({
        ok: false,
        kind: 'invalid',
      });
      expect((await a.auth.loginWithPassword({ phone: PHONE(30), password: GOOD2 })).ok).toBe(true);
      for (const s of [s1, s2]) {
        expect(
          s.ok && (await a.sessions.authenticateSessionToken(s.session.accessToken)),
        ).toBeNull();
      }
      const reasons = await q<{ revoked_reason: string }>(
        `SELECT revoked_reason FROM customer_sessions WHERE id = ANY($1) `,
        [[s1, s2].map((s) => (s.ok ? s.session.sessionId : ''))],
      );
      expect(reasons.every((x) => x.revoked_reason === 'recovery')).toBe(true);
      if (r.ok)
        expect(await a.sessions.authenticateSessionToken(r.session.accessToken)).toMatchObject({
          authMethod: 'recovery',
        });
      expect(await a.sessions.authenticateLegacyToken(legacy)).toBeNull();
    });

    it('is ATOMIC: if the audit write fails, the hash, the cutoff and every revocation roll back', async () => {
      await a.auth.registerWithPassword(proof(PHONE(31)), GOOD);
      const c = (await customerByPhone(PHONE(31)))!;
      const keep = await a.sessions.establishSession({ customerId: c.id, authMethod: 'otp' });
      const [before] = await q<{ password_hash: string; legacy_tokens_invalid_before: Date }>(
        'SELECT password_hash, legacy_tokens_invalid_before FROM customer_credentials WHERE customer_id=$1',
        [c.id],
      );
      vi.spyOn(CustomerAuthEventRepository.prototype, 'append').mockRejectedValue(
        new Error('audit store down'),
      );
      await expect(a.auth.recoverPassword(proof(PHONE(31)), GOOD2)).rejects.toThrow(
        'audit store down',
      );
      vi.restoreAllMocks();
      const [after] = await q<{ password_hash: string; legacy_tokens_invalid_before: Date }>(
        'SELECT password_hash, legacy_tokens_invalid_before FROM customer_credentials WHERE customer_id=$1',
        [c.id],
      );
      expect(after).toEqual(before);
      expect(
        keep.ok && (await a.sessions.authenticateSessionToken(keep.session.accessToken)),
      ).not.toBeNull();
    });

    it('an unknown phone that was just verified becomes a new customer; a policy failure changes nothing', async () => {
      const r = await a.auth.recoverPassword(proof(PHONE(32)), GOOD);
      expect(r.ok && r.isNewCustomer).toBe(true);
      const bad = await a.auth.recoverPassword(proof(PHONE(33)), 'short');
      expect(bad).toMatchObject({ ok: false, reason: 'policy' });
      expect(await customerByPhone(PHONE(33))).toBeUndefined();
    });

    it('refuses a suspended customer and changes nothing', async () => {
      await a.auth.registerWithPassword(proof(PHONE(34)), GOOD);
      await q(`UPDATE customers SET status='suspended' WHERE phone=$1`, [PHONE(34)]);
      const c = (await customerByPhone(PHONE(34)))!;
      const [before] = await q<{ password_hash: string }>(
        'SELECT password_hash FROM customer_credentials WHERE customer_id=$1',
        [c.id],
      );
      expect(await a.auth.recoverPassword(proof(PHONE(34)), GOOD2)).toEqual({
        ok: false,
        reason: 'customer_inactive',
      });
      expect(
        (
          await q<{ password_hash: string }>(
            'SELECT password_hash FROM customer_credentials WHERE customer_id=$1',
            [c.id],
          )
        )[0],
      ).toEqual(before);
    });
  });

  describe('enrollPassword and changePassword (inside a session)', () => {
    it('enrolls a first password from a fresh-OTP session, applies the policy, and never from a stale one', async () => {
      const si = await a.auth.signInWithVerifiedPhone(proof(PHONE(40)));
      if (!si.ok) throw new Error('setup');
      expect(
        await a.auth.enrollPassword({
          customerId: si.customerId,
          sessionId: si.session.sessionId,
          password: 'short',
        }),
      ).toMatchObject({ ok: false, reason: 'policy' });
      expect(
        await a.auth.enrollPassword({
          customerId: si.customerId,
          sessionId: si.session.sessionId,
          password: GOOD,
        }),
      ).toEqual({ ok: true });
      expect(
        await a.auth.enrollPassword({
          customerId: si.customerId,
          sessionId: si.session.sessionId,
          password: GOOD2,
        }),
      ).toEqual({ ok: false, reason: 'already_set' });

      const si2 = await a.auth.signInWithVerifiedPhone(proof(PHONE(41)));
      if (!si2.ok) throw new Error('setup');
      clockMs += 10 * 60 * 1000;
      expect(
        await a.auth.enrollPassword({
          customerId: si2.customerId,
          sessionId: si2.session.sessionId,
          password: GOOD,
        }),
      ).toEqual({ ok: false, reason: 'step_up_required' });
    });

    it('changePassword needs the CURRENT password; a wrong one changes nothing; a right one revokes every other session and keeps this one', async () => {
      await a.auth.registerWithPassword(proof(PHONE(42)), GOOD);
      const login = await a.auth.loginWithPassword({ phone: PHONE(42), password: GOOD });
      const other = await a.auth.loginWithPassword({ phone: PHONE(42), password: GOOD });
      if (!login.ok || !other.ok) throw new Error('setup');
      const c = (await customerByPhone(PHONE(42)))!;
      const ids = { customerId: c.id, sessionId: login.session.sessionId };
      expect(
        await a.auth.changePassword({
          ...ids,
          currentPassword: 'wrong password entirely',
          newPassword: GOOD2,
        }),
      ).toEqual({ ok: false, reason: 'invalid_current' });
      expect((await a.auth.loginWithPassword({ phone: PHONE(42), password: GOOD })).ok).toBe(true); // unchanged
      expect(
        await a.auth.changePassword({ ...ids, currentPassword: GOOD, newPassword: 'short' }),
      ).toMatchObject({ ok: false, reason: 'policy' });
      expect(
        await a.auth.changePassword({ ...ids, currentPassword: GOOD, newPassword: GOOD2 }),
      ).toEqual({ ok: true });
      expect(await a.sessions.authenticateSessionToken(login.session.accessToken)).not.toBeNull();
      expect(await a.sessions.authenticateSessionToken(other.session.accessToken)).toBeNull();
      expect(await a.auth.loginWithPassword({ phone: PHONE(42), password: GOOD })).toEqual({
        ok: false,
        kind: 'invalid',
      });
      expect((await a.auth.loginWithPassword({ phone: PHONE(42), password: GOOD2 })).ok).toBe(true);
    });

    it("changePassword without a credential, or from another customer's session, is refused", async () => {
      const si = await a.auth.signInWithVerifiedPhone(proof(PHONE(43)));
      if (!si.ok) throw new Error('setup');
      expect(
        await a.auth.changePassword({
          customerId: si.customerId,
          sessionId: si.session.sessionId,
          currentPassword: GOOD,
          newPassword: GOOD2,
        }),
      ).toEqual({ ok: false, reason: 'no_credential' });
      await a.auth.registerWithPassword(proof(PHONE(44)), GOOD);
      const victim = (await customerByPhone(PHONE(44)))!;
      expect(
        await a.auth.changePassword({
          customerId: victim.id,
          sessionId: si.session.sessionId,
          currentPassword: GOOD,
          newPassword: GOOD2,
        }),
      ).toEqual({ ok: false, reason: 'not_authorized' });
    });
  });
});
