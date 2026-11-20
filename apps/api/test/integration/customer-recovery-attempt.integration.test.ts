import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createDirectPbkdf2Worker } from '../../src/auth/pbkdf2-worker';
import { CustomerAuthEventRepository } from '../../src/repositories/customer-auth-event.repository';
import { CustomerSessionService } from '../../src/customer-auth/customer-session.service';
import { CustomerPasswordAuthService, type VerifiedPhoneProof } from '../../src/customer-auth/customer-password-auth.service';
import { createCustomerRecoveryCodeService } from '../../src/customer-auth/customer-recovery-code.service';
import {
  createCustomerRecoveryService,
  type RecoveryLimiter,
  type RecoveryNotifier,
  type RecoveryPhoneProof,
} from '../../src/customer-auth/customer-recovery-attempt.service';
import { appDbOf } from '../helpers/runtime-db';

/**
 * CUSTOMER-AUTH-S4-02 recovery orchestration against REAL Postgres. Internal
 * services only; nothing here is a route. Every security timestamp is the
 * database's own clock, so hold tests move the stored deadline with SQL rather
 * than with a fake clock. PBKDF2 runs at 1000 iterations.
 */
describe.skipIf(!process.env.DATABASE_URL)('customer recovery orchestration (integration)', () => {
  const RUN = Date.now().toString().slice(-8);
  const PHONE = (i: number) => `+1559${RUN}${i}`;
  const GOOD = 'correct horse battery staple';
  const NEW = 'a brand new long passphrase 42';
  const SECRET = 'synthetic-customer-recovery-hmac-secret-0123456789';
  const SRC = 'source-key-0123456789abcdef';
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let client: Client;
  let client2: Client;
  const businesses: string[] = [];

  const build = (c: Client) => {
    const db = buildDb(c);
    const sessions = new CustomerSessionService(appDbOf(db), {
      sessionSigningSecret: 'integration-session-secret-not-for-production',
      legacySigningSecret: 'integration-legacy-secret-not-for-production',
      legacyAccepted: () => true, accessTtlSeconds: 900, refreshTtlSeconds: 30 * 86400,
      absoluteTtlSeconds: 30 * 86400, idleTtlSeconds: 7 * 86400, stepUpWindowSeconds: 300,
    });
    const auth = new CustomerPasswordAuthService(appDbOf(db), sessions, createDirectPbkdf2Worker(), {
      passwordMinLength: 10, phoneProofMaxAgeSeconds: 300, passwordIterations: 1000,
    });
    const codes = createCustomerRecoveryCodeService({ db, hmacSecret: SECRET, stepUpWindowSeconds: 300 });
    return { db, sessions, auth, codes };
  };
  let a: ReturnType<typeof build>;

  type Notice = Parameters<RecoveryNotifier>[0];
  type Over = Partial<{
    notifier: RecoveryNotifier | null;
    limiter: RecoveryLimiter | null;
    deliver: boolean;
    now: () => Date;
  }>;
  const harness = (c: Client, over: Over = {}) => {
    const notices: Notice[] = [];
    const challenges: Array<{ recipient: string; challengeId: string; proof: string }> = [];
    const limits: Array<{ key: string; limit: number; windowSeconds: number }> = [];
    const notifier: RecoveryNotifier | undefined = over.notifier === null ? undefined : over.notifier ?? (async (n) => {
      notices.push(n);
      return { email: 'accepted', phone: n.recipients.phone ? 'accepted' : 'skipped' };
    });
    const limiter: RecoveryLimiter | undefined = over.limiter === null ? undefined : over.limiter ?? (async (input) => {
      limits.push(input);
      return true;
    });
    const svc = createCustomerRecoveryService({
      db: buildDb(c), hmacSecret: SECRET, hasher: createDirectPbkdf2Worker(),
      passwordPolicy: { minLength: 10 }, passwordIterations: 1000, phoneProofMaxAgeSeconds: 300,
      ...(notifier ? { notifier } : {}), ...(limiter ? { limiter } : {}),
      ...(over.deliver === false ? {} : { deliverEmailChallenge: async (m) => { challenges.push(m); } }),
      ...(over.now ? { now: over.now } : {}),
    });
    return { svc, notices, challenges, limits };
  };
  let h: ReturnType<typeof harness>;

  const q = <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    client.query(text, values).then((r) => r.rows as T[]);
  const proof = (phone: string): VerifiedPhoneProof => ({ phone, verifiedAt: new Date(), source: 'local_otp' });

  /** An email-linked customer. `phoneDaysAgo` null leaves the phone UNVERIFIED. */
  const customer = async (i: number, o: { email?: boolean; phoneDaysAgo?: number | null } = {}) => {
    const phone = PHONE(i);
    expect((await a.auth.registerWithPassword(proof(phone), GOOD)).ok).toBe(true);
    const [row] = await q<{ id: string }>('SELECT id FROM customers WHERE phone=$1', [phone]);
    const id = row!.id;
    const days = o.phoneDaysAgo === undefined ? 30 : o.phoneDaysAgo;
    await q(`UPDATE customers SET phone_verified_at = ${days === null ? 'NULL' : `now() - interval '${days} days'`} WHERE id=$1`, [id]);
    if (o.email !== false) {
      await q('UPDATE customer_credentials SET login_email=$2, login_email_verified_at=now() WHERE customer_id=$1', [id, `rec-${i}-${RUN}@example.test`]);
    }
    return { id, phone };
  };
  const passwordSession = async (customerId: string) => {
    const s = await a.sessions.establishSession({ customerId, authMethod: 'password' });
    if (!s.ok) throw new Error('Expected a synthetic session');
    expect(await a.sessions.recordStepUp({ customerId, sessionId: s.session.sessionId })).toBe(true);
    return { owner: { customerId, sessionId: s.session.sessionId }, accessToken: s.session.accessToken };
  };
  const issueCodes = async (customerId: string) => {
    const { owner } = await passwordSession(customerId);
    const r = await a.codes.issue(owner);
    if (!r.ok) throw new Error('Expected recovery codes');
    return r.codes;
  };
  const phoneProof = (phone: string, over: Partial<RecoveryPhoneProof> = {}): RecoveryPhoneProof =>
    ({ phone, verifiedAt: new Date(), source: 'local_otp', purpose: 'account_recovery', ...over });

  const start = async (c: { id: string }, harnessUnderTest = h) => {
    const r = await harnessUnderTest.svc.initiate({ customerId: c.id, sourceKey: SRC });
    if (!r.ok) throw new Error('Expected an initiated attempt');
    return r.attemptId;
  };
  const emailFactor = async (attemptId: string, harnessUnderTest = h) => {
    expect(await harnessUnderTest.svc.requestEmailChallenge({ attemptId, sourceKey: SRC })).toEqual({ ok: true });
    const m = harnessUnderTest.challenges.at(-1)!;
    return harnessUnderTest.svc.verifyEmailFactor({ attemptId, sourceKey: SRC, challengeId: m.challengeId, proof: m.proof });
  };
  const attempt = async (id: string) => (await q<Record<string, unknown>>('SELECT * FROM customer_recovery_attempts WHERE id=$1', [id]))[0]!;
  const credential = async (id: string) => (await q('SELECT * FROM customer_credentials WHERE customer_id=$1', [id]))[0];
  const eventTypes = async (id: string) => (await q<{ event_type: string }>(
    `SELECT event_type FROM customer_auth_events WHERE customer_id=$1 AND event_type LIKE 'recovery%' ORDER BY created_at, id`, [id])).map((e) => e.event_type);
  /** Moves the stored hold deadline (the database is the only clock the service trusts). */
  const setHoldIn = (attemptId: string, seconds: number) =>
    q(`UPDATE customer_recovery_attempts SET hold_started_at = LEAST(hold_started_at, now() - interval '25 hours'),
       hold_until = now() + make_interval(secs => $2) WHERE id=$1`, [attemptId, seconds]);
  const finish = (attemptId: string, harnessUnderTest = h, password = NEW) =>
    harnessUnderTest.svc.complete({ attemptId, newPassword: password, sourceKey: SRC });

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    client2 = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([client.connect(), client2.connect()]);
    a = build(client);
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    for (const id of businesses) await client.query('DELETE FROM businesses WHERE id=$1', [id]);
    await client.query('DELETE FROM customers WHERE phone LIKE $1', [`+1559${RUN}%`]);
    await Promise.all([client.end(), client2.end()]);
  });
  const fresh = () => { h = harness(client); };

  describe('authentication matrix (D1, D3, D5, D6)', () => {
    it('email + phone (both available, old verified phone): standard path, no hold, resets the password and issues NO session', async () => {
      fresh();
      const c = await customer(1);
      const live = await passwordSession(c.id);
      const before = await credential(c.id) as { legacy_tokens_invalid_before: Date; password_hash: string };
      const [business] = await q<{ id: string }>('INSERT INTO businesses (name, slug) VALUES ($1,$2) RETURNING id', [`RA ${RUN}`, `ra-${RUN}`]);
      businesses.push(business!.id);
      await q('INSERT INTO loyalty_accounts (customer_id, business_id, points) VALUES ($1,$2,42)', [c.id, business!.id]);
      const sessionsBefore = (await q<{ n: number }>('SELECT count(*)::int n FROM customer_sessions WHERE customer_id=$1', [c.id]))[0]!.n;
      const customerBefore = await q('SELECT * FROM customers WHERE id=$1', [c.id]);

      const id = await start(c);
      expect(await emailFactor(id)).toEqual({ ok: true, status: 'awaiting_factors' });
      expect(await h.svc.verifyPhoneFactor({ attemptId: id, sourceKey: SRC, proof: phoneProof(c.phone) })).toEqual({ ok: true, status: 'factors_verified' });
      expect(await attempt(id)).toMatchObject({ status: 'factors_verified', risk: 'standard', risk_reason: 'both_factors', hold_until: null });
      expect(await finish(id)).toEqual({ ok: true });

      expect(await attempt(id)).toMatchObject({ status: 'completed', ended_reason: 'completed' });
      const after = await credential(c.id) as { legacy_tokens_invalid_before: Date; password_hash: string };
      expect(after.password_hash).not.toBe(before.password_hash);
      expect(after.legacy_tokens_invalid_before.getTime()).toBeGreaterThan(before.legacy_tokens_invalid_before.getTime());
      expect(await a.auth.loginWithVerifiedEmailPassword({ email: `rec-1-${RUN}@example.test`, password: NEW })).toMatchObject({ ok: true });
      expect(await a.auth.loginWithVerifiedEmailPassword({ email: `rec-1-${RUN}@example.test`, password: GOOD })).toMatchObject({ ok: false });
      expect(await a.sessions.authenticateSessionToken(live.accessToken)).toBeNull();
      // identity, memberships and balances untouched; only the login above created a session
      expect(await q('SELECT * FROM customers WHERE id=$1', [c.id])).toEqual(customerBefore);
      expect((await q<{ points: number }>('SELECT points FROM loyalty_accounts WHERE customer_id=$1', [c.id]))[0]!.points).toBe(42);
      expect((await q<{ n: number }>('SELECT count(*)::int n FROM customer_sessions WHERE customer_id=$1', [c.id]))[0]!.n).toBe(sessionsBefore + 1);
      expect((await q<{ n: number }>(`SELECT count(*)::int n FROM customer_sessions WHERE customer_id=$1 AND auth_method='recovery'`, [c.id]))[0]!.n).toBe(0);
      expect(await eventTypes(c.id)).toEqual(expect.arrayContaining(['recovery_started', 'recovery_factor_verified', 'recovery_completed']));
      expect(h.notices.map((n) => n.kind)).toEqual(['initiated', 'completed']);
    });

    it('lost email: phone + recovery code is HIGH risk and holds 24 hours before it can complete', async () => {
      fresh();
      const c = await customer(2);
      const code = (await issueCodes(c.id))[0]!;
      const id = await start(c);
      expect(await h.svc.verifyCodeFactor({ attemptId: id, sourceKey: SRC, code })).toEqual({ ok: true, status: 'awaiting_factors' });
      const held = await h.svc.verifyPhoneFactor({ attemptId: id, sourceKey: SRC, proof: phoneProof(c.phone) });
      expect(held).toMatchObject({ ok: true, status: 'security_hold' });
      const row = await attempt(id);
      expect(row).toMatchObject({ status: 'security_hold', risk: 'high', risk_reason: 'recovery_code_path' });
      expect((row.hold_until as Date).getTime() - (row.hold_started_at as Date).getTime()).toBe(86_400_000);
      expect(row.hold_notice_accepted_at).not.toBeNull();
      expect(await finish(id)).toEqual({ ok: false }); // premature
      expect((await credential(c.id) as { password_hash: string }).password_hash).toBeTruthy();
      await setHoldIn(id, -1);
      expect(await finish(id)).toEqual({ ok: true });
      expect(h.notices.map((n) => n.kind)).toEqual(['initiated', 'hold_started', 'completed']);
    });

    it('lost phone: email challenge + recovery code is HIGH risk and holds', async () => {
      fresh();
      const c = await customer(3);
      const code = (await issueCodes(c.id))[0]!;
      const id = await start(c);
      expect(await emailFactor(id)).toEqual({ ok: true, status: 'awaiting_factors' });
      expect(await h.svc.verifyCodeFactor({ attemptId: id, sourceKey: SRC, code })).toMatchObject({ ok: true, status: 'security_hold' });
      expect(await attempt(id)).toMatchObject({ status: 'security_hold', risk: 'high', risk_reason: 'recovery_code_path' });
      await setHoldIn(id, -1);
      expect(await finish(id)).toEqual({ ok: true });
    });

    it('both factors lost, or any SINGLE factor, can never complete (no self-service)', async () => {
      for (const [i, factor] of [[4, 'none'], [5, 'email'], [6, 'phone'], [7, 'code']] as const) {
        fresh();
        const c = await customer(i);
        const codes = await issueCodes(c.id);
        const id = await start(c);
        if (factor === 'email') await emailFactor(id);
        if (factor === 'phone') await h.svc.verifyPhoneFactor({ attemptId: id, sourceKey: SRC, proof: phoneProof(c.phone) });
        if (factor === 'code') await h.svc.verifyCodeFactor({ attemptId: id, sourceKey: SRC, code: codes[0] });
        const before = await credential(c.id);
        expect(await finish(id)).toEqual({ ok: false });
        expect(await credential(c.id)).toEqual(before);
        expect((await attempt(id)).status).toBe('awaiting_factors');
        // the database refuses even a forced single-factor verified state
        await expect(q(`UPDATE customer_recovery_attempts SET status='factors_verified', risk='standard' WHERE id=$1`, [id])).rejects.toThrow();
      }
    });

    it('a recently verified phone escalates even email + phone to HIGH risk (D5)', async () => {
      fresh();
      const c = await customer(8, { phoneDaysAgo: 1 });
      const id = await start(c);
      await emailFactor(id);
      expect(await h.svc.verifyPhoneFactor({ attemptId: id, sourceKey: SRC, proof: phoneProof(c.phone) })).toMatchObject({ ok: true, status: 'security_hold' });
      expect(await attempt(id)).toMatchObject({ risk: 'high', risk_reason: 'recent_phone_verification' });
    });

    it('an UNVERIFIED phone, a foreign number, a non-recovery proof, a stale or pre-attempt proof are never factors (D6)', async () => {
      fresh();
      const unverified = await customer(9, { phoneDaysAgo: null });
      const idU = await start(unverified);
      expect(await h.svc.verifyPhoneFactor({ attemptId: idU, sourceKey: SRC, proof: phoneProof(unverified.phone) })).toEqual({ ok: false });
      expect((await attempt(idU)).phone_factor_at).toBeNull();

      const c = await customer(10);
      const id = await start(c);
      const bad: Array<RecoveryPhoneProof | unknown> = [
        phoneProof('+15550000001'),
        { ...phoneProof(c.phone), purpose: 'sign_in' },
        { phone: c.phone, verifiedAt: new Date(), source: 'local_otp' },
        phoneProof(c.phone, { verifiedAt: new Date(Date.now() - 400_000) }),
        phoneProof(c.phone, { verifiedAt: new Date(Date.now() + 60_000) }),
        phoneProof(c.phone, { verifiedAt: new Date(Date.now() - 200_000) }), // fresh, but obtained BEFORE this attempt began
        phoneProof('not-a-phone'),
        undefined,
      ];
      for (const p of bad) expect(await h.svc.verifyPhoneFactor({ attemptId: id, sourceKey: SRC, proof: p as RecoveryPhoneProof })).toEqual({ ok: false });
      expect((await attempt(id)).phone_factor_at).toBeNull();
    });

    it('a phone proof cannot be reused across attempts', async () => {
      fresh();
      const c = await customer(11);
      const first = await start(c);
      const p = phoneProof(c.phone);
      expect(await h.svc.verifyPhoneFactor({ attemptId: first, sourceKey: SRC, proof: p })).toEqual({ ok: true, status: 'awaiting_factors' });
      await q(`UPDATE customer_recovery_attempts SET status='cancelled', ended_at=now(), ended_reason='cancelled_by_customer' WHERE id=$1`, [first]);
      const second = await start(c);
      await sleep(5);
      expect(await h.svc.verifyPhoneFactor({ attemptId: second, sourceKey: SRC, proof: p })).toEqual({ ok: false });
      expect(await h.svc.verifyPhoneFactor({ attemptId: second, sourceKey: SRC, proof: phoneProof(c.phone, { verifiedAt: new Date() }) })).toEqual({ ok: true, status: 'awaiting_factors' });
    });
  });

  describe('state machine and security hold', () => {
    it('expires on the database clock, refuses replay of a finished attempt and of a spent challenge', async () => {
      fresh();
      const c = await customer(12);
      const id = await start(c);
      await q(`UPDATE customer_recovery_attempts SET expires_at = now() - interval '1 second', created_at = now() - interval '1 hour' WHERE id=$1`, [id]);
      expect(await h.svc.requestEmailChallenge({ attemptId: id, sourceKey: SRC })).toEqual({ ok: false });
      expect(await attempt(id)).toMatchObject({ status: 'expired', ended_reason: 'expired' });
      expect(await h.svc.verifyCodeFactor({ attemptId: id, sourceKey: SRC, code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA' })).toEqual({ ok: false });

      const c2 = await customer(13);
      const live = await start(c2);
      expect(await emailFactor(live)).toEqual({ ok: true, status: 'awaiting_factors' });
      const m = h.challenges.at(-1)!;
      expect(await h.svc.verifyEmailFactor({ attemptId: live, sourceKey: SRC, challengeId: m.challengeId, proof: m.proof })).toEqual({ ok: false });
    });

    it('persists across worker restarts: a fresh service instance on another connection continues and completes the attempt', async () => {
      fresh();
      const c = await customer(14);
      const code = (await issueCodes(c.id))[0]!;
      const id = await start(c);
      await emailFactor(id);
      expect(await h.svc.verifyCodeFactor({ attemptId: id, sourceKey: SRC, code })).toMatchObject({ status: 'security_hold' });
      const restarted = harness(client2); // a brand-new service and database connection
      expect(await finish(id, restarted)).toEqual({ ok: false });
      await setHoldIn(id, -1);
      expect(await finish(id, restarted)).toEqual({ ok: true });
    });

    it('rejects completion before the deadline and accepts it after, on the database clock only (not a client clock)', async () => {
      const manipulated = harness(client, { now: () => new Date('2100-01-01T00:00:00Z') });
      const c = await customer(15);
      const code = (await issueCodes(c.id))[0]!;
      const id = await start(c, manipulated);
      await emailFactor(id, manipulated);
      expect(await manipulated.svc.verifyCodeFactor({ attemptId: id, sourceKey: SRC, code })).toMatchObject({ status: 'security_hold' });
      expect(await finish(id, manipulated)).toEqual({ ok: false }); // service clock says 2100; the hold still stands
      await setHoldIn(id, 2);
      expect(await finish(id, manipulated)).toEqual({ ok: false });
      await sleep(2300);
      expect(await finish(id, manipulated)).toEqual({ ok: true });
    });

    it('the database itself refuses a premature or unannounced completion', async () => {
      fresh();
      const c = await customer(16);
      const code = (await issueCodes(c.id))[0]!;
      const id = await start(c);
      await emailFactor(id);
      await h.svc.verifyCodeFactor({ attemptId: id, sourceKey: SRC, code });
      await expect(q(`UPDATE customer_recovery_attempts SET status='completed', ended_at=now(), ended_reason='completed' WHERE id=$1`, [id])).rejects.toThrow();
      await q(`UPDATE customer_recovery_attempts SET hold_notice_accepted_at = NULL WHERE id=$1`, [id]);
      await setHoldIn(id, -1);
      expect(await finish(id)).toEqual({ ok: false }); // hold elapsed but the hold notice was never accepted
      expect((await attempt(id)).status).toBe('security_hold');
    });

    it('an attempt whose initiation notice was never accepted cannot complete, in the service or the database', async () => {
      fresh();
      const c = await customer(40);
      const id = await start(c);
      await emailFactor(id);
      await h.svc.verifyPhoneFactor({ attemptId: id, sourceKey: SRC, proof: phoneProof(c.phone) });
      expect((await attempt(id)).status).toBe('factors_verified');
      await q('UPDATE customer_recovery_attempts SET notice_accepted_at = NULL WHERE id=$1', [id]);
      const before = await credential(c.id);
      expect(await finish(id)).toEqual({ ok: false });
      expect(await credential(c.id)).toEqual(before);
      await expect(q(`UPDATE customer_recovery_attempts SET status='completed', ended_at=now(), ended_reason='completed' WHERE id=$1`, [id])).rejects.toThrow();
    });

    it('two concurrent completions yield exactly one password replacement', async () => {
      fresh();
      const other = harness(client2);
      const c = await customer(17);
      const id = await start(c);
      await emailFactor(id);
      await h.svc.verifyPhoneFactor({ attemptId: id, sourceKey: SRC, proof: phoneProof(c.phone) });
      const results = await Promise.all([finish(id, h, NEW), finish(id, other, `${NEW} other`)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect((await q<{ n: number }>(`SELECT count(*)::int n FROM customer_auth_events WHERE customer_id=$1 AND event_type='recovery_completed'`, [c.id]))[0]!.n).toBe(1);
      expect(await finish(id)).toEqual({ ok: false }); // replay
    });

    it('cancels with a single-use, attempt-bound, expiring token; cancel-after-complete and bad tokens fail', async () => {
      fresh();
      const c = await customer(18);
      const id = await start(c);
      const token = h.notices.at(-1)!.cancelToken!;
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(await h.svc.cancel({ attemptId: id, token: 'f'.repeat(64), sourceKey: SRC })).toEqual({ ok: false });
      expect(await h.svc.cancel({ attemptId: id, token, sourceKey: SRC })).toEqual({ ok: true });
      expect(await attempt(id)).toMatchObject({ status: 'cancelled', ended_reason: 'cancelled_by_customer' });
      expect(await h.svc.cancel({ attemptId: id, token, sourceKey: SRC })).toEqual({ ok: false }); // single use
      expect(await h.svc.verifyCodeFactor({ attemptId: id, sourceKey: SRC, code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA' })).toEqual({ ok: false });
      expect(await finish(id)).toEqual({ ok: false });
      expect(await eventTypes(c.id)).toContain('recovery_cancelled');
      expect(h.notices.map((n) => n.kind)).toEqual(['initiated', 'cancelled']);
      expect(h.notices.at(-1)!.cancelToken).toBeUndefined();

      // after completion
      const c2 = await customer(19);
      const done = await start(c2);
      const doneToken = h.notices.at(-1)!.cancelToken!;
      await emailFactor(done);
      await h.svc.verifyPhoneFactor({ attemptId: done, sourceKey: SRC, proof: phoneProof(c2.phone) });
      expect(await finish(done)).toEqual({ ok: true });
      expect(await h.svc.cancel({ attemptId: done, token: doneToken, sourceKey: SRC })).toEqual({ ok: false });

      // a token only works on its own attempt, and only before it expires
      const c3 = await customer(20);
      const c4 = await customer(21);
      const a3 = await start(c3);
      const t3 = h.notices.at(-1)!.cancelToken!;
      const a4 = await start(c4);
      expect(await h.svc.cancel({ attemptId: a4, token: t3, sourceKey: SRC })).toEqual({ ok: false });
      await q(`UPDATE customer_recovery_attempts SET cancel_expires_at = now() - interval '1 second', created_at = now() - interval '1 day' WHERE id=$1`, [a3]);
      expect(await h.svc.cancel({ attemptId: a3, token: t3, sourceKey: SRC })).toEqual({ ok: false });
    });

    it('a cancellation link cannot be locked out by someone who only knows the attempt id (budget is per attempt AND source)', async () => {
      const counts = new Map<string, number>();
      const counting: RecoveryLimiter = async ({ key, limit }) => {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return n <= limit;
      };
      const hh = harness(client, { limiter: counting });
      const c = await customer(41);
      const id = await start(c, hh);
      const token = hh.notices.at(-1)!.cancelToken!;
      for (let i = 0; i < 20; i += 1) {
        expect(await hh.svc.cancel({ attemptId: id, token: '0'.repeat(64), sourceKey: 'attacker-source-0123456789' })).toEqual({ ok: false });
      }
      // the attacker's own budget is spent, so even the right token from that source is refused ...
      expect(await hh.svc.cancel({ attemptId: id, token, sourceKey: 'attacker-source-0123456789' })).toEqual({ ok: false });
      // ... but the real owner, on another source, can still cancel
      expect(await hh.svc.cancel({ attemptId: id, token, sourceKey: 'victim-source-0123456789ab' })).toEqual({ ok: true });
      expect((await attempt(id)).status).toBe('cancelled');
    });

    it('a cancelled hold cannot be completed even after the deadline passes', async () => {
      fresh();
      const c = await customer(22);
      const code = (await issueCodes(c.id))[0]!;
      const id = await start(c);
      await emailFactor(id);
      await h.svc.verifyCodeFactor({ attemptId: id, sourceKey: SRC, code });
      const holdToken = h.notices.find((n) => n.kind === 'hold_started')!.cancelToken!;
      expect(await h.svc.cancel({ attemptId: id, token: holdToken, sourceKey: SRC })).toEqual({ ok: true });
      await setHoldIn(id, -1).catch(() => undefined);
      expect(await finish(id)).toEqual({ ok: false });
      const row = await attempt(id);
      expect(row.status).toBe('cancelled');
      expect(row.email_factor_at).not.toBeNull(); // factor evidence stays on the row
      expect(row.code_factor_at).not.toBeNull();
    });
  });

  describe('credential integrity', () => {
    it('is atomic: a failure while completing rolls back the password, the revocations, the code set and the attempt', async () => {
      fresh();
      const c = await customer(23);
      await issueCodes(c.id);
      const live = await passwordSession(c.id);
      const id = await start(c);
      await emailFactor(id);
      await h.svc.verifyPhoneFactor({ attemptId: id, sourceKey: SRC, proof: phoneProof(c.phone) });
      const before = await credential(c.id);
      const original = CustomerAuthEventRepository.prototype.append;
      vi.spyOn(CustomerAuthEventRepository.prototype, 'append').mockImplementation(function (this: CustomerAuthEventRepository, event) {
        if (event.eventType === 'recovery_completed') throw new Error('audit store down');
        return original.call(this, event);
      });
      await expect(finish(id)).rejects.toThrow('audit store down');
      vi.restoreAllMocks();
      expect(await credential(c.id)).toEqual(before);
      expect(await a.sessions.authenticateSessionToken(live.accessToken)).not.toBeNull();
      expect((await q<{ n: number }>('SELECT count(*)::int n FROM customer_recovery_code_sets WHERE customer_id=$1 AND revoked_at IS NULL', [c.id]))[0]!.n).toBe(1);
      expect((await attempt(id)).status).toBe('factors_verified');
      expect(await finish(id)).toEqual({ ok: true }); // and it can still be completed afterwards
    });

    it('revokes every session with reason recovery and retires the active recovery-code set', async () => {
      fresh();
      const c = await customer(24);
      await issueCodes(c.id);
      const s1 = await passwordSession(c.id);
      const s2 = await passwordSession(c.id);
      const id = await start(c);
      await emailFactor(id);
      await h.svc.verifyPhoneFactor({ attemptId: id, sourceKey: SRC, proof: phoneProof(c.phone) });
      expect(await finish(id)).toEqual({ ok: true });
      for (const s of [s1, s2]) expect(await a.sessions.authenticateSessionToken(s.accessToken)).toBeNull();
      const reasons = await q<{ revoked_reason: string }>(`SELECT DISTINCT revoked_reason FROM customer_sessions WHERE customer_id=$1`, [c.id]);
      expect(reasons.map((r) => r.revoked_reason)).toEqual(['recovery']);
      expect((await q<{ revoked_reason: string }>('SELECT revoked_reason FROM customer_recovery_code_sets WHERE customer_id=$1', [c.id]))[0]!.revoked_reason).toBe('security');
    });

    it('refuses a weak new password without changing anything or spending the attempt', async () => {
      fresh();
      const c = await customer(25);
      const id = await start(c);
      await emailFactor(id);
      await h.svc.verifyPhoneFactor({ attemptId: id, sourceKey: SRC, proof: phoneProof(c.phone) });
      const before = await credential(c.id);
      expect(await finish(id, h, 'short')).toEqual({ ok: false });
      expect(await credential(c.id)).toEqual(before);
      expect((await attempt(id)).status).toBe('factors_verified');
    });
  });

  describe('abuse resistance', () => {
    it('exhausts after five failed factor attempts and then rejects the attempt', async () => {
      fresh();
      const c = await customer(26);
      await issueCodes(c.id);
      const id = await start(c);
      for (let i = 0; i < 5; i += 1) expect(await h.svc.verifyCodeFactor({ attemptId: id, sourceKey: SRC, code: `AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAA${i}` })).toEqual({ ok: false });
      expect(await attempt(id)).toMatchObject({ status: 'rejected', ended_reason: 'factor_budget_exhausted', factor_failures: 5 });
      expect(await emailFactor(id).catch(() => ({ ok: false }))).toMatchObject({ ok: false });
    });

    it('fails closed without a limiter, a source key, or when a budget is spent; keys are opaque and budgets come from the approved set', async () => {
      const c = await customer(27);
      const noLimiter = harness(client, { limiter: null });
      expect(await noLimiter.svc.initiate({ customerId: c.id, sourceKey: SRC })).toEqual({ ok: false });
      fresh();
      expect(await h.svc.initiate({ customerId: c.id })).toEqual({ ok: false });
      expect(await h.svc.initiate({ customerId: c.id, sourceKey: 'x' })).toEqual({ ok: false });
      const denied = harness(client, { limiter: async () => false });
      expect(await denied.svc.initiate({ customerId: c.id, sourceKey: SRC })).toEqual({ ok: false });
      const throwing = harness(client, { limiter: async () => { throw new Error('limiter down'); } });
      expect(await throwing.svc.initiate({ customerId: c.id, sourceKey: SRC })).toEqual({ ok: false });
      expect((await q<{ n: number }>('SELECT count(*)::int n FROM customer_recovery_attempts WHERE customer_id=$1', [c.id]))[0]!.n).toBe(0);

      const id = await start(c);
      await emailFactor(id);
      await h.svc.cancel({ attemptId: id, token: h.notices[0]!.cancelToken!, sourceKey: SRC });
      expect(h.limits.length).toBeGreaterThan(0);
      for (const l of h.limits) {
        expect(l.key).toMatch(/^customer-recovery:[a-z_]+:(source|customer|attempt_source):[0-9a-f]{64}$/);
        for (const raw of [c.id, c.phone, `rec-27-${RUN}`, SRC, id]) expect(l.key).not.toContain(raw);
        expect([`${l.limit}/${l.windowSeconds}`]).toEqual(expect.arrayContaining([expect.stringMatching(/^(5\/900|3\/3600|10\/3600)$/)]));
      }
    });

    it('every attempt-scoped operation is denied by the limiter without any state change', async () => {
      fresh();
      const c = await customer(28);
      const id = await start(c);
      const denied = harness(client, { limiter: async () => false });
      const before = await attempt(id);
      const challenge = await denied.svc.requestEmailChallenge({ attemptId: id, sourceKey: SRC });
      const email = await denied.svc.verifyEmailFactor({ attemptId: id, sourceKey: SRC, challengeId: crypto.randomUUID(), proof: 'abcdef' });
      const phone = await denied.svc.verifyPhoneFactor({ attemptId: id, sourceKey: SRC, proof: phoneProof(c.phone) });
      const code = await denied.svc.verifyCodeFactor({ attemptId: id, sourceKey: SRC, code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA' });
      const cancel = await denied.svc.cancel({ attemptId: id, token: h.notices[0]!.cancelToken!, sourceKey: SRC });
      const complete = await finish(id, denied);
      for (const r of [challenge, email, phone, code, cancel, complete]) expect(r).toEqual({ ok: false });
      expect(await attempt(id)).toEqual(before);
    });

    it('does not let one customer\'s evidence satisfy another customer\'s attempt', async () => {
      fresh();
      const x = await customer(29);
      const y = await customer(30);
      const yCodes = await issueCodes(y.id);
      const idX = await start(x);
      const idY = await start(y);
      await emailFactor(idY);
      const yChallenge = h.challenges.at(-1)!;
      expect(await h.svc.verifyEmailFactor({ attemptId: idX, sourceKey: SRC, challengeId: yChallenge.challengeId, proof: yChallenge.proof })).toEqual({ ok: false });
      expect(await h.svc.verifyPhoneFactor({ attemptId: idX, sourceKey: SRC, proof: phoneProof(y.phone) })).toEqual({ ok: false });
      expect(await h.svc.verifyCodeFactor({ attemptId: idX, sourceKey: SRC, code: yCodes[0] })).toEqual({ ok: false });
      const row = await attempt(idX);
      expect([row.email_factor_at, row.phone_factor_at, row.code_factor_at]).toEqual([null, null, null]);
      expect(await finish(idX)).toEqual({ ok: false });
      expect((await q<{ n: number }>('SELECT count(*)::int n FROM customer_recovery_codes WHERE customer_id=$1 AND consumed_at IS NOT NULL', [y.id]))[0]!.n).toBe(0);
    });

    it('answers identically for unknown, phone-only, suspended and unverified-email customers (no enumeration) and never notifies them', async () => {
      fresh();
      const phoneOnly = await customer(31, { email: false });
      const suspended = await customer(32);
      await q(`UPDATE customers SET status='suspended' WHERE id=$1`, [suspended.id]);
      const results = [
        await h.svc.initiate({ customerId: '00000000-0000-4000-8000-000000000000', sourceKey: SRC }),
        await h.svc.initiate({ customerId: 'nope', sourceKey: SRC }),
        await h.svc.initiate({ customerId: phoneOnly.id, sourceKey: SRC }),
        await h.svc.initiate({ customerId: suspended.id, sourceKey: SRC }),
      ];
      for (const r of results) expect(r).toEqual({ ok: false });
      expect(h.notices).toHaveLength(0);
      expect(await h.svc.verifyCodeFactor({ attemptId: crypto.randomUUID(), sourceKey: SRC, code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA' })).toEqual({ ok: false });
    });

    it('fails closed when the notifier or the email-delivery adapter is missing, rejects, or throws; nothing proceeds unannounced', async () => {
      const c = await customer(33);
      const none = harness(client, { notifier: null });
      expect(await none.svc.initiate({ customerId: c.id, sourceKey: SRC })).toEqual({ ok: false });
      expect((await q<{ n: number }>('SELECT count(*)::int n FROM customer_recovery_attempts WHERE customer_id=$1', [c.id]))[0]!.n).toBe(0);

      for (const notifier of [
        (async () => ({ email: 'failed' as const })) satisfies RecoveryNotifier,
        (async () => { throw new Error('provider down'); }) satisfies RecoveryNotifier,
      ]) {
        const failing = harness(client, { notifier });
        expect(await failing.svc.initiate({ customerId: c.id, sourceKey: SRC })).toEqual({ ok: false });
        expect((await q<{ status: string; ended_reason: string }>(`SELECT status, ended_reason FROM customer_recovery_attempts WHERE customer_id=$1 ORDER BY created_at DESC`, [c.id]))[0]).toEqual({ status: 'rejected', ended_reason: 'notification_failed' });
      }
      // an attempt that was never announced cannot take a factor
      fresh();
      const id = await start(c);
      await q('UPDATE customer_recovery_attempts SET notice_accepted_at = NULL WHERE id=$1', [id]);
      expect(await h.svc.requestEmailChallenge({ attemptId: id, sourceKey: SRC })).toEqual({ ok: false });
      expect(await h.svc.verifyPhoneFactor({ attemptId: id, sourceKey: SRC, proof: phoneProof(c.phone) })).toEqual({ ok: false });

      const c2 = await customer(34);
      const noMail = harness(client, { deliver: false });
      const id2 = await start(c2, noMail);
      expect(await noMail.svc.requestEmailChallenge({ attemptId: id2, sourceKey: SRC })).toEqual({ ok: false });
    });

    it('rejects the attempt (and never holds) when the HOLD notice is not accepted', async () => {
      const c = await customer(35);
      const code = (await issueCodes(c.id))[0]!;
      let calls = 0;
      const flaky = harness(client, { notifier: async (n) => { calls += 1; return n.kind === 'hold_started' ? { email: 'failed' } : { email: 'accepted' }; } });
      const id = await start(c, flaky);
      await emailFactor(id, flaky);
      expect(await flaky.svc.verifyCodeFactor({ attemptId: id, sourceKey: SRC, code })).toEqual({ ok: false });
      expect(await attempt(id)).toMatchObject({ status: 'rejected', ended_reason: 'notification_failed' });
      expect(calls).toBe(2);
      expect(await finish(id, flaky)).toEqual({ ok: false });
    });

    it('keeps audit rows and persisted evidence free of secrets and tokens', async () => {
      fresh();
      const c = await customer(36);
      const code = (await issueCodes(c.id))[0]!;
      const id = await start(c);
      const cancelToken = h.notices[0]!.cancelToken!;
      await emailFactor(id);
      const challenge = h.challenges.at(-1)!;
      await h.svc.verifyCodeFactor({ attemptId: id, sourceKey: SRC, code });
      await setHoldIn(id, -1);
      await finish(id);
      const dump = JSON.stringify([
        await attempt(id),
        await q('SELECT * FROM customer_auth_events WHERE customer_id=$1', [c.id]),
        await q('SELECT * FROM customer_auth_challenges WHERE customer_id=$1', [c.id]),
        await q('SELECT * FROM customer_recovery_codes WHERE customer_id=$1', [c.id]),
      ]);
      const holdToken = h.notices.find((n) => n.kind === 'hold_started')!.cancelToken!;
      for (const secret of [cancelToken, holdToken, challenge.proof, code.replace(/-/g, ''), code, NEW, GOOD]) expect(dump).not.toContain(secret);
      expect(cancelToken).not.toBe(holdToken);
      const kinds = h.notices.map((n) => n.kind);
      expect(kinds).toEqual(['initiated', 'hold_started', 'completed']);
      for (const n of h.notices) {
        const text = JSON.stringify(n);
        for (const secret of [code, code.replace(/-/g, ''), challenge.proof, NEW, GOOD]) expect(text).not.toContain(secret);
        expect('cancelToken' in n).toBe(n.kind === 'initiated' || n.kind === 'hold_started');
      }
    });

    it('allows one active attempt per customer, replaces an empty one, and protects one that holds evidence', async () => {
      fresh();
      const c = await customer(37);
      const first = await start(c);
      const second = await start(c);
      expect(second).not.toBe(first);
      expect(await attempt(first)).toMatchObject({ status: 'rejected', ended_reason: 'superseded' });
      await emailFactor(second);
      expect(await h.svc.initiate({ customerId: c.id, sourceKey: SRC })).toEqual({ ok: false });
      expect((await attempt(second)).status).toBe('awaiting_factors');
    });
  });

  describe('configuration and database invariants', () => {
    it('never writes a secret, code, proof or token to any console channel, across a full recovery', async () => {
      const calls: string[] = [];
      for (const channel of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        vi.spyOn(console, channel).mockImplementation((...args: unknown[]) => { calls.push(args.map(String).join(' ')); });
      }
      fresh();
      const c = await customer(42);
      const code = (await issueCodes(c.id))[0]!;
      const id = await start(c);
      await emailFactor(id);
      await h.svc.verifyCodeFactor({ attemptId: id, sourceKey: SRC, code });
      await h.svc.verifyCodeFactor({ attemptId: id, sourceKey: SRC, code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA' });
      await h.svc.cancel({ attemptId: id, token: h.notices[0]!.cancelToken!, sourceKey: SRC });
      const sensitive = [SECRET, code, code.replace(/-/g, ''), NEW, GOOD, h.challenges.at(-1)!.proof, h.notices[0]!.cancelToken!];
      for (const line of calls) for (const secret of sensitive) expect(line).not.toContain(secret);
    });

    it('the database rejects every illegal attempt state or ownership, whoever writes it', async () => {
      const c = await customer(43);
      const base = (digest: string, extra = '', customerId = c.id) => q(
        `INSERT INTO customer_recovery_attempts (customer_id, status, expires_at, cancel_digest, cancel_expires_at ${extra ? `, ${extra.split('=')[0]}` : ''})
         VALUES ($1, $3, now() + interval '1 hour', $2, now() + interval '1 hour' ${extra ? `, ${extra.split('=')[1]}` : ''})`,
        [customerId, digest, 'awaiting_factors'],
      );
      const hex = (n: number) => n.toString(16).padStart(64, '0');
      const bad: Array<[string, () => Promise<unknown>]> = [
        ['terminal_check', () => q(`INSERT INTO customer_recovery_attempts (customer_id, status, expires_at, cancel_digest, cancel_expires_at) VALUES ($1,'cancelled', now() + interval '1 hour', $2, now() + interval '1 hour')`, [c.id, hex(1)])], // terminal without ended_at
        ['ended_reason_presence_check', () => q(`INSERT INTO customer_recovery_attempts (customer_id, status, expires_at, cancel_digest, cancel_expires_at, ended_reason) VALUES ($1,'awaiting_factors', now() + interval '1 hour', $2, now() + interval '1 hour', 'expired')`, [c.id, hex(2)])], // a reason with no end time
        ['risk_required_check', () => q(`INSERT INTO customer_recovery_attempts (customer_id, status, expires_at, cancel_digest, cancel_expires_at, email_factor_at, code_factor_at) VALUES ($1,'factors_verified', now() + interval '1 hour', $2, now() + interval '1 hour', now(), now())`, [c.id, hex(3)])], // verified without a risk class
        ['two_factor_check', () => q(`INSERT INTO customer_recovery_attempts (customer_id, status, risk, expires_at, cancel_digest, cancel_expires_at, email_factor_at) VALUES ($1,'factors_verified','standard', now() + interval '1 hour', $2, now() + interval '1 hour', now())`, [c.id, hex(4)])], // one factor only
        ['hold_check', () => q(`INSERT INTO customer_recovery_attempts (customer_id, status, risk, expires_at, cancel_digest, cancel_expires_at, email_factor_at, code_factor_at, hold_started_at, hold_until) VALUES ($1,'security_hold','high', now() + interval '1 hour', $2, now() + interval '1 hour', now(), now(), now(), now() - interval '1 hour')`, [c.id, hex(5)])], // hold ends before it starts
        ['hold_check', () => q(`INSERT INTO customer_recovery_attempts (customer_id, status, risk, expires_at, cancel_digest, cancel_expires_at, email_factor_at, code_factor_at) VALUES ($1,'security_hold','high', now() + interval '1 hour', $2, now() + interval '1 hour', now(), now())`, [c.id, hex(6)])], // hold without a deadline
        ['hold_check', () => q(`INSERT INTO customer_recovery_attempts (customer_id, status, risk, expires_at, cancel_digest, cancel_expires_at, email_factor_at, code_factor_at, hold_started_at, hold_until) VALUES ($1,'factors_verified','standard', now() + interval '1 hour', $2, now() + interval '1 hour', now(), now(), now(), now() + interval '1 day')`, [c.id, hex(7)])], // a standard attempt cannot carry a hold
        ['failures_check', () => q(`INSERT INTO customer_recovery_attempts (customer_id, status, expires_at, cancel_digest, cancel_expires_at, factor_failures) VALUES ($1,'awaiting_factors', now() + interval '1 hour', $2, now() + interval '1 hour', 6)`, [c.id, hex(8)])],
        ['phone_evidence_check', () => q(`INSERT INTO customer_recovery_attempts (customer_id, status, expires_at, cancel_digest, cancel_expires_at, phone_factor_at) VALUES ($1,'awaiting_factors', now() + interval '1 hour', $2, now() + interval '1 hour', now())`, [c.id, hex(9)])], // phone evidence without its proof timestamp
        ['digest_check', () => q(`INSERT INTO customer_recovery_attempts (customer_id, status, expires_at, cancel_digest, cancel_expires_at) VALUES ($1,'awaiting_factors', now() + interval '1 hour', 'not-a-digest', now() + interval '1 hour')`, [c.id])],
        ['expiry_check', () => q(`INSERT INTO customer_recovery_attempts (customer_id, status, expires_at, cancel_digest, cancel_expires_at) VALUES ($1,'awaiting_factors', now() - interval '1 hour', $2, now() + interval '1 hour')`, [c.id, hex(10)])], // expires before created
        ['customers_id_fk', () => q(`INSERT INTO customer_recovery_attempts (customer_id, status, expires_at, cancel_digest, cancel_expires_at) VALUES ('00000000-0000-4000-8000-000000000000','awaiting_factors', now() + interval '1 hour', $1, now() + interval '1 hour')`, [hex(11)])], // no such customer
      ];
      void base;
      for (const [constraint, attemptInsert] of bad) {
        // each illegal row is refused by the INTENDED constraint, not by an incidental one
        await expect(attemptInsert()).rejects.toThrow(new RegExp(constraint));
      }
      // one active attempt per customer, and a digest is never shared
      await q(`INSERT INTO customer_recovery_attempts (customer_id, status, expires_at, cancel_digest, cancel_expires_at) VALUES ($1,'awaiting_factors', now() + interval '1 hour', $2, now() + interval '1 hour')`, [c.id, hex(12)]);
      await expect(q(`INSERT INTO customer_recovery_attempts (customer_id, status, expires_at, cancel_digest, cancel_expires_at) VALUES ($1,'awaiting_factors', now() + interval '1 hour', $2, now() + interval '1 hour')`, [c.id, hex(13)])).rejects.toThrow();
      const c2 = await customer(44);
      await expect(q(`INSERT INTO customer_recovery_attempts (customer_id, status, expires_at, cancel_digest, cancel_expires_at) VALUES ($1,'awaiting_factors', now() + interval '1 hour', $2, now() + interval '1 hour')`, [c2.id, hex(12)])).rejects.toThrow();
      // deleting the customer removes the attempts with it (ownership)
      await q('DELETE FROM customers WHERE id=$1', [c.id]);
      expect((await q<{ n: number }>('SELECT count(*)::int n FROM customer_recovery_attempts WHERE customer_id=$1', [c.id]))[0]!.n).toBe(0);
    });
  });

  describe('E10 and unreachability', () => {
    it('phone-only password recovery stays blocked for an email-linked customer, even holding a recovery code', async () => {
      fresh();
      const c = await customer(38);
      const code = (await issueCodes(c.id))[0]!;
      expect(await a.codes.redeem({ customerId: c.id, code })).toEqual({ ok: true });
      const before = await credential(c.id);
      expect(await a.auth.recoverPassword(proof(c.phone), NEW)).toEqual({ ok: false, reason: 'customer_inactive' });
      expect(await a.sessions.completeRecovery({ customerId: c.id, passwordHash: 'pbkdf2$1000$AAAA$BBBB' })).toEqual({ ok: false, reason: 'recovery_not_permitted' });
      expect(await credential(c.id)).toEqual(before);
    });
  });
});
