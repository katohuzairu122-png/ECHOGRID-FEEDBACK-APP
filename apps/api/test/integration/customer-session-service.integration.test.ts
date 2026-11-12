import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Client } from 'pg';
import { sign } from 'hono/jwt';
import { buildDb } from '../../src/db/client';
import { CustomerRepository } from '../../src/repositories/customer.repository';
import { CustomerAuthEventRepository } from '../../src/repositories/customer-auth-event.repository';
import {
  CustomerSessionService,
  type CustomerSessionServiceConfig,
} from '../../src/customer-auth/customer-session.service';
import { signCustomerAccessToken } from '../../src/customer-auth/customer-jwt';
import { signCustomerSessionAccessToken } from '../../src/customer-auth/session-tokens';

/**
 * CUSTOMER-AUTH-01D-3: the session service against REAL Postgres. Not wired to
 * any route. Rows use unique per-run phone numbers and are deleted in afterAll.
 * Never point DATABASE_URL at production.
 *
 * Time: the service clock is injectable. JWT verification inside
 * hono uses the REAL clock, so tests that call authenticate* keep the service
 * clock at real time, and only refresh/grace tests move it.
 */
describe.skipIf(!process.env.DATABASE_URL)('customer session service (integration)', () => {
  const SESSION_SECRET = 'integration-session-secret-not-for-production';
  const LEGACY_SECRET = 'integration-legacy-secret-not-for-production';
  const RUN = Date.now().toString().slice(-8);
  const PHONE = (i: number) => `+1556${RUN}${i}`;
  const MIN = 60 * 1000;

  let client: Client;
  let client2: Client;
  let customers: CustomerRepository;
  let clockMs = Date.now();
  let legacyOn = true;

  const config = (): CustomerSessionServiceConfig => ({
    sessionSigningSecret: SESSION_SECRET,
    legacySigningSecret: LEGACY_SECRET,
    legacyAccepted: () => legacyOn,
    accessTtlSeconds: 900,
    refreshTtlSeconds: 30 * 86400,
    absoluteTtlSeconds: 30 * 86400,
    idleTtlSeconds: 7 * 86400,
    stepUpWindowSeconds: 300,
    now: () => new Date(clockMs),
  });
  let svc: CustomerSessionService;
  let svc2: CustomerSessionService; // a second connection, for genuine races

  async function customer(i: number, status: 'active' | 'suspended' = 'active') {
    return customers.create({ phone: PHONE(i), phoneVerifiedAt: new Date(), status });
  }
  async function session(customerId: string, authMethod: 'otp' | 'password' | 'recovery' = 'otp') {
    const r = await svc.establishSession({ customerId, authMethod });
    if (!r.ok) throw new Error('establish failed');
    return r.session;
  }
  const legacyToken = (customerId: string, iatSeconds: number) =>
    sign(
      { sub: customerId, type: 'customer_access', iat: iatSeconds, exp: iatSeconds + 90 * 86400 },
      LEGACY_SECRET,
      'HS256',
    );
  const q = <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    client.query(text, values).then((r) => r.rows as T[]);

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    client2 = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([client.connect(), client2.connect()]);
    customers = new CustomerRepository(buildDb(client));
    svc = new CustomerSessionService(buildDb(client), config());
    svc2 = new CustomerSessionService(buildDb(client2), config());
  });

  afterEach(() => {
    clockMs = Date.now();
    legacyOn = true;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await client.query(`DELETE FROM customers WHERE phone LIKE $1`, [`+1556${RUN}%`]);
    await Promise.all([client.end(), client2.end()]);
  });

  describe('construction', () => {
    it('refuses missing lifetimes, a missing secret, or identical secrets', () => {
      const db = buildDb(client);
      expect(() => new CustomerSessionService(db, { ...config(), idleTtlSeconds: 0 })).toThrow();
      expect(
        () => new CustomerSessionService(db, { ...config(), stepUpWindowSeconds: 1.5 }),
      ).toThrow();
      expect(
        () => new CustomerSessionService(db, { ...config(), sessionSigningSecret: '' }),
      ).toThrow();
      expect(
        () => new CustomerSessionService(db, { ...config(), legacySigningSecret: SESSION_SECRET }),
      ).toThrow(/differ/);
    });
  });

  describe('establishSession', () => {
    it('issues a session, stores only the hash of the refresh credential, and audits it', async () => {
      const c = await customer(1);
      const s = await session(c.id);
      expect(s.refreshCredential).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const tokens = await q<{ token_hash: string }>(
        'SELECT token_hash FROM customer_refresh_tokens WHERE session_id = $1',
        [s.sessionId],
      );
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(tokens[0]!.token_hash).not.toContain(s.refreshCredential);
      // The raw credential appears nowhere in any new table.
      for (const table of [
        'customer_sessions',
        'customer_refresh_tokens',
        'customer_credentials',
        'customer_auth_events',
      ]) {
        const hit = await q(`SELECT 1 FROM ${table} t WHERE t::text LIKE $1`, [
          `%${s.refreshCredential}%`,
        ]);
        expect(hit).toHaveLength(0);
      }
      const events = await new CustomerAuthEventRepository(buildDb(client)).listForCustomer(
        c.id,
        5,
      );
      expect(events.some((e) => e.eventType === 'session_created')).toBe(true);
      expect(s.refreshExpiresAt.getTime()).toBeLessThanOrEqual(
        s.sessionAbsoluteExpiresAt.getTime(),
      );
    });

    it('records a fresh step-up for otp and recovery sessions but not password sessions', async () => {
      const c = await customer(2);
      const otp = await session(c.id, 'otp');
      const pw = await session(c.id, 'password');
      const rows = await q<{ id: string; step_up_verified_at: Date | null }>(
        'SELECT id, step_up_verified_at FROM customer_sessions WHERE customer_id = $1',
        [c.id],
      );
      expect(rows.find((r) => r.id === otp.sessionId)!.step_up_verified_at).not.toBeNull();
      expect(rows.find((r) => r.id === pw.sessionId)!.step_up_verified_at).toBeNull();
    });

    it('refuses a suspended or unknown customer and creates nothing', async () => {
      const c = await customer(3, 'suspended');
      expect(await svc.establishSession({ customerId: c.id, authMethod: 'otp' })).toEqual({
        ok: false,
        reason: 'customer_inactive',
      });
      expect(
        await svc.establishSession({
          customerId: '00000000-0000-4000-8000-000000000000',
          authMethod: 'otp',
        }),
      ).toEqual({ ok: false, reason: 'customer_inactive' });
      expect(
        await q('SELECT 1 FROM customer_sessions WHERE customer_id = $1', [c.id]),
      ).toHaveLength(0);
    });
  });

  describe('authenticateSessionToken', () => {
    it('accepts a live session and returns identity from the database, not the token', async () => {
      const c = await customer(4);
      const s = await session(c.id);
      const who = await svc.authenticateSessionToken(s.accessToken);
      expect(who).toMatchObject({
        assurance: 'session',
        customerId: c.id,
        sessionId: s.sessionId,
        authMethod: 'otp',
      });
    });

    it('takes effect IMMEDIATELY on revocation, even though the access token has not expired', async () => {
      const c = await customer(5);
      const s = await session(c.id);
      expect(await svc.authenticateSessionToken(s.accessToken)).not.toBeNull();
      expect(await svc.revokeSession({ customerId: c.id, sessionId: s.sessionId })).toBe(true);
      expect(await svc.authenticateSessionToken(s.accessToken)).toBeNull();
    });

    it('rejects a suspended customer and an expired session', async () => {
      const c = await customer(6);
      const s = await session(c.id);
      await q(`UPDATE customers SET status='suspended' WHERE id=$1`, [c.id]);
      expect(await svc.authenticateSessionToken(s.accessToken)).toBeNull();
      await q(`UPDATE customers SET status='active' WHERE id=$1`, [c.id]);
      expect(await svc.authenticateSessionToken(s.accessToken)).not.toBeNull();
      await q(
        `UPDATE customer_sessions SET idle_expires_at = now() - interval '1 second' WHERE id=$1`,
        [s.sessionId],
      );
      expect(await svc.authenticateSessionToken(s.accessToken)).toBeNull();
    });

    it('rejects a validly signed token whose sub does not own the session (I11)', async () => {
      const a = await customer(7);
      const b = await customer(8);
      const sa = await session(a.id);
      const forged = await signCustomerSessionAccessToken(b.id, sa.sessionId, SESSION_SECRET);
      expect(await svc.authenticateSessionToken(forged)).toBeNull();
    });

    it('rejects a legacy token, a wrong-secret token and garbage', async () => {
      const c = await customer(9);
      const s = await session(c.id);
      expect(
        await svc.authenticateSessionToken(await signCustomerAccessToken(c.id, SESSION_SECRET)),
      ).toBeNull();
      expect(
        await svc.authenticateSessionToken(
          await signCustomerSessionAccessToken(c.id, s.sessionId, 'other-secret'),
        ),
      ).toBeNull();
      expect(await svc.authenticateSessionToken('not.a.token')).toBeNull();
    });
  });

  describe('refresh', () => {
    it('rotates once, returns a NEW credential, keeps the same session, and stores only hashes', async () => {
      const c = await customer(1 + 10);
      const s = await session(c.id);
      clockMs += MIN;
      const r = await svc.refresh(s.refreshCredential);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.session.sessionId).toBe(s.sessionId);
      expect(r.session.refreshCredential).not.toBe(s.refreshCredential);
      const rows = await q<{ rotated_at: Date | null }>(
        'SELECT rotated_at FROM customer_refresh_tokens WHERE session_id = $1 ORDER BY issued_at',
        [s.sessionId],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]!.rotated_at).not.toBeNull();
      expect(rows[1]!.rotated_at).toBeNull();
      const leaked = await q(`SELECT 1 FROM customer_refresh_tokens t WHERE t::text LIKE $1`, [
        `%${r.session.refreshCredential}%`,
      ]);
      expect(leaked).toHaveLength(0);
    });

    it('moves the idle window forward but never past the absolute cap', async () => {
      const c = await customer(2 + 10);
      const s = await session(c.id);
      clockMs += 3 * 86400 * 1000;
      const r = await svc.refresh(s.refreshCredential);
      expect(r.ok).toBe(true);
      const [row] = await q<{ idle_expires_at: Date; absolute_expires_at: Date }>(
        'SELECT idle_expires_at, absolute_expires_at FROM customer_sessions WHERE id=$1',
        [s.sessionId],
      );
      expect(row!.idle_expires_at.getTime()).toBeLessThanOrEqual(
        row!.absolute_expires_at.getTime(),
      );
      expect(row!.idle_expires_at.getTime()).toBe(clockMs + 7 * 86400 * 1000);
    });

    it('inside the grace window the stale credential gets a retryable CONFLICT: nothing issued, nothing revoked', async () => {
      const c = await customer(3 + 10);
      const s = await session(c.id);
      const first = await svc.refresh(s.refreshCredential);
      expect(first.ok).toBe(true);
      clockMs += 2000;
      const second = await svc.refresh(s.refreshCredential);
      expect(second).toEqual({ ok: false, kind: 'conflict' });
      const [sess] = await q<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM customer_sessions WHERE id=$1',
        [s.sessionId],
      );
      expect(sess!.revoked_at).toBeNull();
      expect(
        await q('SELECT 1 FROM customer_refresh_tokens WHERE session_id=$1', [s.sessionId]),
      ).toHaveLength(2); // no third token
      // The legitimate successor still works.
      if (first.ok) {
        clockMs += 60 * 1000;
        expect((await svc.refresh(first.session.refreshCredential)).ok).toBe(true);
      }
    });

    it('REPLAY outside grace revokes ONLY the compromised session and its whole chain, not the other device', async () => {
      const c = await customer(4 + 10);
      const stolen = await session(c.id);
      const other = await session(c.id);
      const legit = await svc.refresh(stolen.refreshCredential);
      expect(legit.ok).toBe(true);
      clockMs += MIN; // well outside the 10 second grace
      const replay = await svc.refresh(stolen.refreshCredential);
      expect(replay).toEqual({ ok: false, kind: 'invalid' });
      const sessions = await q<{
        id: string;
        revoked_at: Date | null;
        revoked_reason: string | null;
      }>('SELECT id, revoked_at, revoked_reason FROM customer_sessions WHERE customer_id=$1', [
        c.id,
      ]);
      expect(sessions.find((x) => x.id === stolen.sessionId)).toMatchObject({
        revoked_reason: 'replay_detected',
      });
      expect(sessions.find((x) => x.id === other.sessionId)!.revoked_at).toBeNull();
      // Every token of the compromised chain is dead, including the legitimate successor.
      const live = await q(
        'SELECT 1 FROM customer_refresh_tokens WHERE session_id=$1 AND revoked_at IS NULL',
        [stolen.sessionId],
      );
      expect(live).toHaveLength(0);
      if (legit.ok)
        expect(await svc.refresh(legit.session.refreshCredential)).toEqual({
          ok: false,
          kind: 'invalid',
        });
      const events = await new CustomerAuthEventRepository(buildDb(client)).listForCustomer(
        c.id,
        20,
      );
      expect(events.filter((e) => e.eventType === 'session_replay_detected')).toHaveLength(1);
    });

    it('rejects after logout, for a suspended customer (and ends that session), for malformed and for unknown credentials', async () => {
      const c = await customer(5 + 10);
      const s = await session(c.id);
      await svc.revokeSession({ customerId: c.id, sessionId: s.sessionId });
      expect(await svc.refresh(s.refreshCredential)).toEqual({ ok: false, kind: 'invalid' });

      const s2 = await session(c.id);
      await q(`UPDATE customers SET status='suspended' WHERE id=$1`, [c.id]);
      expect(await svc.refresh(s2.refreshCredential)).toEqual({ ok: false, kind: 'invalid' });
      const [row] = await q<{ revoked_reason: string | null }>(
        'SELECT revoked_reason FROM customer_sessions WHERE id=$1',
        [s2.sessionId],
      );
      expect(row!.revoked_reason).toBe('suspended');
      await q(`UPDATE customers SET status='active' WHERE id=$1`, [c.id]);

      expect(await svc.refresh('short')).toEqual({ ok: false, kind: 'invalid' });
      expect(await svc.refresh('A'.repeat(43))).toEqual({ ok: false, kind: 'invalid' });
    });

    it('an unknown credential writes NO audit row (an anonymous caller cannot grow the table)', async () => {
      const before = (await q<{ n: string }>('SELECT count(*) n FROM customer_auth_events'))[0]!.n;
      for (let i = 0; i < 5; i += 1) await svc.refresh('B'.repeat(43));
      expect((await q<{ n: string }>('SELECT count(*) n FROM customer_auth_events'))[0]!.n).toBe(
        before,
      );
    });

    it('two truly concurrent refreshes of one credential: exactly one succeeds, the other is a conflict, one successor exists', async () => {
      const c = await customer(6 + 10);
      const s = await session(c.id);
      clockMs += MIN;
      const [a, b] = await Promise.all([
        svc.refresh(s.refreshCredential),
        svc2.refresh(s.refreshCredential),
      ]);
      const outcomes = [a, b];
      expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
      expect(outcomes.filter((o) => !o.ok && o.kind === 'conflict')).toHaveLength(1);
      expect(
        await q('SELECT 1 FROM customer_refresh_tokens WHERE session_id=$1', [s.sessionId]),
      ).toHaveLength(2);
    });

    it('REFRESH versus REVOCATION race: no unrevoked token may survive on a revoked session (regression for the PG18 finding)', async () => {
      const c = await customer(7 + 10);
      for (let i = 0; i < 25; i += 1) {
        const s = await session(c.id);
        clockMs += MIN;
        await Promise.all([
          svc.refresh(s.refreshCredential),
          svc2.revokeSession({ customerId: c.id, sessionId: s.sessionId }),
        ]);
        const [sess] = await q<{ revoked_at: Date | null }>(
          'SELECT revoked_at FROM customer_sessions WHERE id=$1',
          [s.sessionId],
        );
        expect(sess!.revoked_at).not.toBeNull();
        const survivors = await q(
          'SELECT 1 FROM customer_refresh_tokens WHERE session_id=$1 AND revoked_at IS NULL',
          [s.sessionId],
        );
        expect(survivors).toHaveLength(0);
      }
    });
  });

  describe('legacy 90-day tokens (cutoff, kill switch, assurance)', () => {
    it('an OTP-only customer (no credential) keeps working: compatibility is preserved', async () => {
      const c = await customer(20);
      const t = await signCustomerAccessToken(c.id, LEGACY_SECRET);
      expect(await svc.authenticateLegacyToken(t)).toEqual({
        assurance: 'legacy',
        customerId: c.id,
      });
    });

    it('the global kill switch rejects every legacy token', async () => {
      const c = await customer(21);
      const t = await signCustomerAccessToken(c.id, LEGACY_SECRET);
      legacyOn = false;
      expect(await svc.authenticateLegacyToken(t)).toBeNull();
    });

    it('rejects a suspended customer and a wrong-secret or session-type token', async () => {
      const c = await customer(22, 'suspended');
      expect(
        await svc.authenticateLegacyToken(await signCustomerAccessToken(c.id, LEGACY_SECRET)),
      ).toBeNull();
      const ok = await customer(23);
      expect(
        await svc.authenticateLegacyToken(await signCustomerAccessToken(ok.id, 'wrong-secret')),
      ).toBeNull();
      expect(
        await svc.authenticateLegacyToken(
          await signCustomerSessionAccessToken(
            ok.id,
            '00000000-0000-4000-8000-000000000000',
            SESSION_SECRET,
          ),
        ),
      ).toBeNull();
    });

    it('enrolling a password kills older legacy tokens and keeps newer ones; other customers are unaffected', async () => {
      const c = await customer(24);
      const other = await customer(25);
      // Enroll "200 seconds ago" so the cutoff sits between an older and a newer token,
      // both of which have a valid (non-future) iat for JWT verification.
      clockMs = Date.now() - 200_000;
      const s = await session(c.id, 'otp'); // otp session has a fresh step-up
      const nowSec = Math.floor(Date.now() / 1000);
      const older = await legacyToken(c.id, nowSec - 300); // issued before the cutoff
      const newer = await legacyToken(c.id, nowSec - 50); // issued after the cutoff
      expect(await svc.authenticateLegacyToken(older)).not.toBeNull(); // still fine: no credential yet
      expect(
        await svc.enrollPassword({
          customerId: c.id,
          sessionId: s.sessionId,
          passwordHash: 'pbkdf2$600000$c2FsdA==$aGFzaA==',
        }),
      ).toEqual({ ok: true });
      expect(await svc.authenticateLegacyToken(older)).toBeNull();
      expect(await svc.authenticateLegacyToken(newer)).not.toBeNull();
      expect(
        await svc.authenticateLegacyToken(await signCustomerAccessToken(other.id, LEGACY_SECRET)),
      ).not.toBeNull();
    });

    it('FAILS CLOSED for a credentialed customer whose cutoff is null', async () => {
      const c = await customer(26);
      await q(
        `INSERT INTO customer_credentials (customer_id, password_hash, password_set_at, password_changed_at, legacy_tokens_invalid_before) VALUES ($1,'h',now(),now(),NULL)`,
        [c.id],
      );
      expect(
        await svc.authenticateLegacyToken(await signCustomerAccessToken(c.id, LEGACY_SECRET)),
      ).toBeNull();
    });
  });

  describe('password enrollment and change (one protected transaction)', () => {
    const HASH = 'pbkdf2$600000$c2FsdA==$aGFzaA==';

    it('needs a LIVE session with a FRESH step-up; a password-method session must step up first', async () => {
      const c = await customer(30);
      const s = await session(c.id, 'password'); // no step-up yet
      expect(
        await svc.enrollPassword({ customerId: c.id, sessionId: s.sessionId, passwordHash: HASH }),
      ).toEqual({ ok: false, reason: 'step_up_required' });
      expect(await svc.recordStepUp({ customerId: c.id, sessionId: s.sessionId })).toBe(true);
      expect(
        await svc.enrollPassword({ customerId: c.id, sessionId: s.sessionId, passwordHash: HASH }),
      ).toEqual({ ok: true });
      expect(
        await svc.enrollPassword({ customerId: c.id, sessionId: s.sessionId, passwordHash: HASH }),
      ).toEqual({ ok: false, reason: 'already_set' });
    });

    it('a stale step-up is refused', async () => {
      const c = await customer(31);
      const s = await session(c.id, 'otp');
      clockMs += 6 * MIN; // window is 5 minutes
      expect(
        await svc.enrollPassword({ customerId: c.id, sessionId: s.sessionId, passwordHash: HASH }),
      ).toEqual({ ok: false, reason: 'step_up_required' });
    });

    it('rejects an unknown session, a session of another customer, and a revoked session', async () => {
      const a = await customer(32);
      const b = await customer(33);
      const sa = await session(a.id);
      expect(
        await svc.enrollPassword({ customerId: b.id, sessionId: sa.sessionId, passwordHash: HASH }),
      ).toEqual({ ok: false, reason: 'not_authorized' });
      expect(
        await svc.enrollPassword({
          customerId: a.id,
          sessionId: '00000000-0000-4000-8000-000000000000',
          passwordHash: HASH,
        }),
      ).toEqual({ ok: false, reason: 'not_authorized' });
      await svc.revokeSession({ customerId: a.id, sessionId: sa.sessionId });
      expect(
        await svc.enrollPassword({ customerId: a.id, sessionId: sa.sessionId, passwordHash: HASH }),
      ).toEqual({ ok: false, reason: 'not_authorized' });
    });

    it('two devices enrolling at once: exactly one credential, one winner, no duplicate customer', async () => {
      const c = await customer(34);
      const s1 = await session(c.id, 'otp');
      const s2 = await session(c.id, 'otp');
      const [a, b] = await Promise.all([
        svc.enrollPassword({ customerId: c.id, sessionId: s1.sessionId, passwordHash: HASH }),
        svc2.enrollPassword({
          customerId: c.id,
          sessionId: s2.sessionId,
          passwordHash: HASH + 'x',
        }),
      ]);
      expect([a, b].filter((r) => r.ok)).toHaveLength(1);
      expect([a, b].filter((r) => !r.ok && r.reason === 'already_set')).toHaveLength(1);
      expect(
        await q('SELECT 1 FROM customer_credentials WHERE customer_id=$1', [c.id]),
      ).toHaveLength(1);
      expect(await q('SELECT 1 FROM customers WHERE phone=$1', [PHONE(34)])).toHaveLength(1);
    });

    it('changePassword replaces the hash, advances the cutoff and revokes every OTHER session, keeping the current one', async () => {
      const c = await customer(35);
      const keep = await session(c.id, 'otp');
      const other1 = await session(c.id, 'otp');
      const other2 = await session(c.id, 'password');
      await svc.enrollPassword({ customerId: c.id, sessionId: keep.sessionId, passwordHash: HASH });
      const [{ legacy_tokens_invalid_before: cut1 }] = (await q<{
        legacy_tokens_invalid_before: Date;
      }>('SELECT legacy_tokens_invalid_before FROM customer_credentials WHERE customer_id=$1', [
        c.id,
      ])) as [{ legacy_tokens_invalid_before: Date }];
      clockMs += 60 * 1000;
      await svc.recordStepUp({ customerId: c.id, sessionId: keep.sessionId });
      expect(
        await svc.changePassword({
          customerId: c.id,
          sessionId: keep.sessionId,
          passwordHash: 'NEW',
        }),
      ).toEqual({ ok: true });
      const sessions = await q<{
        id: string;
        revoked_at: Date | null;
        revoked_reason: string | null;
      }>('SELECT id, revoked_at, revoked_reason FROM customer_sessions WHERE customer_id=$1', [
        c.id,
      ]);
      expect(sessions.find((x) => x.id === keep.sessionId)!.revoked_at).toBeNull();
      for (const gone of [other1, other2])
        expect(sessions.find((x) => x.id === gone.sessionId)).toMatchObject({
          revoked_reason: 'password_changed',
        });
      const [cred] = await q<{ password_hash: string; legacy_tokens_invalid_before: Date }>(
        'SELECT password_hash, legacy_tokens_invalid_before FROM customer_credentials WHERE customer_id=$1',
        [c.id],
      );
      expect(cred!.password_hash).toBe('NEW');
      expect(cred!.legacy_tokens_invalid_before.getTime()).toBeGreaterThan(cut1.getTime());
    });

    it('changePassword without a credential, or without a fresh step-up, changes nothing', async () => {
      const c = await customer(36);
      const s = await session(c.id, 'otp');
      expect(
        await svc.changePassword({ customerId: c.id, sessionId: s.sessionId, passwordHash: 'X' }),
      ).toEqual({ ok: false, reason: 'no_credential' });
      await svc.enrollPassword({ customerId: c.id, sessionId: s.sessionId, passwordHash: HASH });
      const other = await session(c.id, 'otp');
      clockMs += 10 * MIN;
      expect(
        await svc.changePassword({ customerId: c.id, sessionId: s.sessionId, passwordHash: 'X' }),
      ).toEqual({ ok: false, reason: 'step_up_required' });
      const [cred] = await q<{ password_hash: string }>(
        'SELECT password_hash FROM customer_credentials WHERE customer_id=$1',
        [c.id],
      );
      expect(cred!.password_hash).toBe(HASH);
      const [o] = await q<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM customer_sessions WHERE id=$1',
        [other.sessionId],
      );
      expect(o!.revoked_at).toBeNull();
    });

    it('is ATOMIC: if the audit write fails, the password change, the cutoff and the revocations all roll back', async () => {
      const c = await customer(37);
      const keep = await session(c.id, 'otp');
      const other = await session(c.id, 'otp');
      await svc.enrollPassword({ customerId: c.id, sessionId: keep.sessionId, passwordHash: HASH });
      const [before] = await q<{ password_hash: string; legacy_tokens_invalid_before: Date }>(
        'SELECT password_hash, legacy_tokens_invalid_before FROM customer_credentials WHERE customer_id=$1',
        [c.id],
      );
      clockMs += 30 * 1000;
      await svc.recordStepUp({ customerId: c.id, sessionId: keep.sessionId });
      const spy = vi
        .spyOn(CustomerAuthEventRepository.prototype, 'append')
        .mockRejectedValue(new Error('audit store down'));
      await expect(
        svc.changePassword({ customerId: c.id, sessionId: keep.sessionId, passwordHash: 'NEW' }),
      ).rejects.toThrow('audit store down');
      spy.mockRestore();
      const [after] = await q<{ password_hash: string; legacy_tokens_invalid_before: Date }>(
        'SELECT password_hash, legacy_tokens_invalid_before FROM customer_credentials WHERE customer_id=$1',
        [c.id],
      );
      expect(after).toEqual(before);
      const [o] = await q<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM customer_sessions WHERE id=$1',
        [other.sessionId],
      );
      expect(o!.revoked_at).toBeNull();
    });
  });

  describe('logout', () => {
    it('logoutAll revokes every session and kills older legacy tokens for a credentialed customer', async () => {
      const c = await customer(40);
      clockMs = Date.now() - 1_000_000; // enroll long ago, so the cutoff is well before the token below
      const s1 = await session(c.id, 'otp');
      const s2 = await session(c.id, 'otp');
      await svc.enrollPassword({ customerId: c.id, sessionId: s1.sessionId, passwordHash: 'h' });
      const legacy = await legacyToken(c.id, Math.floor(Date.now() / 1000) - 100);
      expect(await svc.authenticateLegacyToken(legacy)).not.toBeNull(); // issued after enrollment: valid
      clockMs = Date.now(); // now the user logs out everywhere
      const res = await svc.logoutAll({ customerId: c.id });
      expect(res.revoked).toBe(2);
      expect(await svc.authenticateSessionToken(s1.accessToken)).toBeNull();
      expect(await svc.authenticateSessionToken(s2.accessToken)).toBeNull();
      expect(await svc.authenticateLegacyToken(legacy)).toBeNull(); // cutoff advanced past its iat
    });

    it('logoutAll can keep the current device', async () => {
      const c = await customer(41);
      const keep = await session(c.id);
      await session(c.id);
      expect(
        (await svc.logoutAll({ customerId: c.id, exceptSessionId: keep.sessionId })).revoked,
      ).toBe(1);
      expect(await svc.authenticateSessionToken(keep.accessToken)).not.toBeNull();
    });

    it('logoutAll for an OTP-only customer revokes sessions but creates no credential and leaves legacy tokens valid', async () => {
      const c = await customer(42);
      await session(c.id);
      await svc.logoutAll({ customerId: c.id });
      expect(
        await q('SELECT 1 FROM customer_credentials WHERE customer_id=$1', [c.id]),
      ).toHaveLength(0);
      expect(
        await svc.authenticateLegacyToken(await signCustomerAccessToken(c.id, LEGACY_SECRET)),
      ).not.toBeNull();
    });

    it('revokeSession is idempotent and scoped to the owner', async () => {
      const a = await customer(43);
      const b = await customer(44);
      const s = await session(a.id);
      expect(await svc.revokeSession({ customerId: b.id, sessionId: s.sessionId })).toBe(false);
      expect(await svc.revokeSession({ customerId: a.id, sessionId: s.sessionId })).toBe(true);
      expect(await svc.revokeSession({ customerId: a.id, sessionId: s.sessionId })).toBe(false);
    });
  });
});
