import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createDirectPbkdf2Worker } from '../../src/auth/pbkdf2-worker';
import { CustomerSessionService } from '../../src/customer-auth/customer-session.service';
import {
  CustomerPasswordAuthService,
  type VerifiedPhoneProof,
} from '../../src/customer-auth/customer-password-auth.service';
import { createCustomerRecoveryCodeService } from '../../src/customer-auth/customer-recovery-code.service';
import {
  createCustomerRecoveryService,
  type RecoveryLimiter,
  type RecoveryNotifier,
} from '../../src/customer-auth/customer-recovery-attempt.service';
import { createCustomerRecoveryRoutes } from '../../src/customer-auth/customer-recovery.routes';
import { appDbOf } from '../helpers/runtime-db';

/**
 * CUSTOMER-AUTH-S4-03: the recovery HTTP surface, the phone-OTP binding and the delivery
 * contract against REAL Postgres. The routes are the production factory with an injected gate,
 * trusted source and dependencies; the OTP provider is a fake that behaves like Twilio Verify
 * (a code is keyed by PHONE ALONE and consumed when approved).
 */
describe.skipIf(!process.env.DATABASE_URL)('customer recovery routes (integration)', () => {
  const RUN = Date.now().toString().slice(-8);
  const PHONE = (i: number) => `+1560${RUN}${i}`;
  const GOOD = 'correct horse battery staple';
  const NEW = 'a brand new long passphrase 42';
  const SECRET = 'synthetic-customer-recovery-hmac-secret-0123456789';
  const SRC = 'trusted-source-0123456789abcdef';
  let client: Client;
  let client2: Client;

  const q = <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    client.query(text, values).then((r) => r.rows as T[]);

  const build = (c: Client) => {
    const db = buildDb(c);
    const sessions = new CustomerSessionService(appDbOf(db), {
      sessionSigningSecret: 'integration-session-secret-not-for-production',
      legacySigningSecret: 'integration-legacy-secret-not-for-production',
      legacyAccepted: () => true,
      accessTtlSeconds: 900,
      refreshTtlSeconds: 30 * 86400,
      absoluteTtlSeconds: 30 * 86400,
      idleTtlSeconds: 7 * 86400,
      stepUpWindowSeconds: 300,
    });
    const auth = new CustomerPasswordAuthService(
      appDbOf(db),
      sessions,
      createDirectPbkdf2Worker(),
      {
        passwordMinLength: 10,
        phoneProofMaxAgeSeconds: 300,
        passwordIterations: 1000,
      },
    );
    return {
      db,
      sessions,
      auth,
      codes: createCustomerRecoveryCodeService({
        db,
        hmacSecret: SECRET,
        stepUpWindowSeconds: 300,
      }),
    };
  };
  let a: ReturnType<typeof build>;

  /** A provider that keys a code by phone alone, like Twilio Verify. */
  const makeOtp = () => {
    const otp = {
      sent: [] as string[],
      checks: 0,
      codes: new Map<string, string>(),
      send: async (phone: string) => {
        otp.sent.push(phone);
        otp.codes.set(phone, '123456');
      },
      check: async (phone: string, code: string) => {
        otp.checks += 1;
        if (otp.codes.get(phone) === code) {
          otp.codes.delete(phone);
          return true;
        }
        return false;
      },
    };
    return otp;
  };
  type Notice = Parameters<RecoveryNotifier>[0];

  type Setup = {
    enabled?: boolean;
    trusted?: boolean;
    open?: boolean;
    limiter?: RecoveryLimiter | null;
    notifier?: RecoveryNotifier | null;
    connection?: Client;
  };
  const setup = (over: Setup = {}) => {
    const notices: Notice[] = [];
    const challenges: Array<{ recipient: string; challengeId: string; proof: string }> = [];
    const otp = makeOtp();
    const notifier =
      over.notifier === null
        ? undefined
        : (over.notifier ??
          (async (n: Notice) => {
            notices.push(n);
            return {
              email: 'accepted' as const,
              phone: n.recipients.phone ? ('accepted' as const) : ('skipped' as const),
            };
          }));
    const limiter = over.limiter === null ? undefined : (over.limiter ?? (async () => true));
    const connection = over.connection ?? client;
    const service = createCustomerRecoveryService({
      db: buildDb(connection),
      hmacSecret: SECRET,
      hasher: createDirectPbkdf2Worker(),
      passwordPolicy: { minLength: 10 },
      passwordIterations: 1000,
      phoneProofMaxAgeSeconds: 300,
      phoneOtp: otp,
      ...(notifier ? { notifier } : {}),
      ...(limiter ? { limiter } : {}),
      deliverEmailChallenge: async (m) => {
        challenges.push(m);
      },
    });
    const routes = createCustomerRecoveryRoutes({
      isEnabled: () => over.enabled !== false,
      resolveTrustedSource: async () => (over.trusted === false ? null : SRC),
      open: async () =>
        over.open === false
          ? null
          : {
              deps: {
                service,
                findCustomerIdByLoginEmail: async (email) =>
                  (
                    await connection.query(
                      'SELECT customer_id FROM customer_credentials WHERE login_email=$1 AND login_email_verified_at IS NOT NULL',
                      [email],
                    )
                  ).rows[0]?.customer_id ?? null,
                findCustomerIdByVerifiedPhone: async (phone) =>
                  (
                    await connection.query(
                      'SELECT id FROM customers WHERE phone=$1 AND phone_verified_at IS NOT NULL AND is_deleted=false',
                      [phone],
                    )
                  ).rows[0]?.id ?? null,
              },
              close: async () => {},
            },
    });
    const app = new Hono();
    app.route('/recovery', routes);
    const post = (path: string, body: unknown, raw?: string) =>
      app.request(`/recovery/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw ?? JSON.stringify(body),
      });
    return { app, post, notices, challenges, otp, service };
  };

  const proof = (phone: string): VerifiedPhoneProof => ({
    phone,
    verifiedAt: new Date(),
    source: 'local_otp',
  });
  const customer = async (i: number, o: { email?: boolean; phoneDaysAgo?: number | null } = {}) => {
    const phone = PHONE(i);
    expect((await a.auth.registerWithPassword(proof(phone), GOOD)).ok).toBe(true);
    const [row] = await q<{ id: string }>('SELECT id FROM customers WHERE phone=$1', [phone]);
    const id = row!.id;
    const days = o.phoneDaysAgo === undefined ? 30 : o.phoneDaysAgo;
    await q(
      `UPDATE customers SET phone_verified_at = ${days === null ? 'NULL' : `now() - interval '${days} days'`} WHERE id=$1`,
      [id],
    );
    const email = `rr-${i}-${RUN}@example.test`;
    if (o.email !== false)
      await q(
        'UPDATE customer_credentials SET login_email=$2, login_email_verified_at=now() WHERE customer_id=$1',
        [id, email],
      );
    return { id, phone, email };
  };
  const issueCode = async (customerId: string) => {
    const s = await a.sessions.establishSession({ customerId, authMethod: 'password' });
    if (!s.ok) throw new Error('Expected a session');
    await a.sessions.recordStepUp({ customerId, sessionId: s.session.sessionId });
    const r = await a.codes.issue({ customerId, sessionId: s.session.sessionId });
    if (!r.ok) throw new Error('Expected codes');
    return r.codes[0]!;
  };
  const attempt = async (id: string) =>
    (
      await q<Record<string, unknown>>('SELECT * FROM customer_recovery_attempts WHERE id=$1', [id])
    )[0]!;
  const credential = async (id: string) =>
    (await q('SELECT * FROM customer_credentials WHERE customer_id=$1', [id]))[0];
  const body = async (r: Response) => (await r.json()) as Record<string, unknown>;
  const setHoldIn = (id: string, seconds: number) =>
    q(
      `UPDATE customer_recovery_attempts SET hold_started_at = LEAST(hold_started_at, now() - interval '25 hours'), hold_until = now() + make_interval(secs => $2) WHERE id=$1`,
      [id, seconds],
    );

  type S = ReturnType<typeof setup>;
  const begin = async (s: S, c: { email: string }) => {
    const r = await s.post('initiate', { email: c.email });
    expect(r.status).toBe(202);
    return (await body(r)).attemptId as string;
  };
  const emailStep = async (s: S, attemptId: string) => {
    expect((await s.post('email-challenge', { attemptId })).status).toBe(202);
    const m = s.challenges.at(-1)!;
    return s.post('email-verify', { attemptId, challengeId: m.challengeId, proof: m.proof });
  };
  const phoneStep = async (s: S, attemptId: string) => {
    expect((await s.post('phone-otp', { attemptId })).status).toBe(202);
    return s.post('phone-verify', { attemptId, code: '123456' });
  };

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    client2 = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([client.connect(), client2.connect()]);
    a = build(client);
  });
  afterAll(async () => {
    await client.query('DELETE FROM customers WHERE phone LIKE $1', [`+1560${RUN}%`]);
    await Promise.all([client.end(), client2.end()]);
  });

  describe('gate, source and body handling', () => {
    it('is a generic 404 when disabled, 503 for an untrusted source or missing dependencies, and creates nothing', async () => {
      const c = await customer(1);
      const off = setup({ enabled: false });
      for (const path of [
        'initiate',
        'email-challenge',
        'email-verify',
        'phone-otp',
        'phone-verify',
        'code-verify',
        'cancel',
        'complete',
      ]) {
        const r = await off.post(path, { email: c.email });
        expect(r.status).toBe(404);
        expect(await body(r)).toEqual({ error: 'Not Found' });
      }
      const untrusted = setup({ trusted: false });
      expect((await untrusted.post('initiate', { email: c.email })).status).toBe(503);
      expect((await setup({ open: false }).post('initiate', { email: c.email })).status).toBe(503);
      expect(
        (
          await q<{ n: number }>(
            'SELECT count(*)::int n FROM customer_recovery_attempts WHERE customer_id=$1',
            [c.id],
          )
        )[0]!.n,
      ).toBe(0);
      const other = setup();
      expect((await other.app.request('/recovery/nowhere', { method: 'POST' })).status).toBe(404);
      expect((await other.app.request('/recovery/initiate', { method: 'GET' })).status).toBe(404);
    });

    it('rejects unknown keys, caller-supplied phones and proofs, bad ids and oversized or non-JSON bodies', async () => {
      const s = setup();
      const id = crypto.randomUUID();
      const bad: Array<[string, unknown, number]> = [
        ['initiate', { email: 'a@example.test', extra: 1 }, 400],
        ['initiate', { email: 'not-an-email' }, 400],
        ['phone-otp', { attemptId: id, phone: '+15550000001' }, 400],
        ['phone-verify', { attemptId: id, code: '123456', phone: '+15550000001' }, 400],
        ['phone-verify', { attemptId: id, code: '12ab56' }, 400],
        [
          'phone-verify',
          { attemptId: id, proof: { phone: '+15550000001', purpose: 'account_recovery' } },
          400,
        ],
        ['email-verify', { attemptId: 'x', challengeId: id, proof: 'abcdef' }, 400],
        ['cancel', { credential: 'nope' }, 400],
        ['complete', { attemptId: id }, 400],
      ];
      for (const [path, payload, status] of bad)
        expect((await s.post(path, payload)).status).toBe(status);
      expect((await s.post('initiate', null, 'not json')).status).toBe(400);
      expect(
        (
          await s.post(
            'initiate',
            null,
            JSON.stringify({ email: 'a@example.test', pad: 'x'.repeat(9000) }),
          )
        ).status,
      ).toBe(413);
    });
  });

  describe('complete recoveries over HTTP', () => {
    it('email + phone OTP resets the password, revokes sessions and issues no session, cookie or token', async () => {
      const c = await customer(2);
      const live = await a.sessions.establishSession({ customerId: c.id, authMethod: 'password' });
      if (!live.ok) throw new Error('session');
      const s = setup();
      const attemptId = await begin(s, c);
      expect(await body(await emailStep(s, attemptId))).toEqual({ status: 'awaiting_factors' });
      expect(s.otp.sent).toEqual([]);
      expect(await body(await phoneStep(s, attemptId))).toMatchObject({ status: 'security_hold' });
      expect(s.otp.sent).toEqual([c.phone]);
      await setHoldIn(attemptId, -1);
      const before = await credential(c.id);
      const done = await s.post('complete', { attemptId, newPassword: NEW });
      expect(done.status).toBe(204);
      expect(done.headers.get('set-cookie')).toBeNull();
      expect(await done.text()).toBe('');
      expect(((await credential(c.id)) as { password_hash: string }).password_hash).not.toBe(
        (before as { password_hash: string }).password_hash,
      );
      expect(await a.sessions.authenticateSessionToken(live.session.accessToken)).toBeNull();
      expect(
        await a.auth.loginWithVerifiedEmailPassword({ email: c.email, password: NEW }),
      ).toMatchObject({ ok: true });
      expect(
        (
          await q<{ n: number }>(
            `SELECT count(*)::int n FROM customer_sessions WHERE customer_id=$1 AND auth_method='recovery'`,
            [c.id],
          )
        )[0]!.n,
      ).toBe(0);
      expect(s.notices.map((n) => n.kind)).toEqual(['initiated', 'hold_started', 'completed']);
      expect(s.notices.every((n) => n.attemptId === attemptId)).toBe(true);
      expect(s.notices[1]!.cancelToken).toBeUndefined();
    });

    it('lost email (phone OTP + recovery code) is held 24 hours, can be cancelled by the emailed credential, and otherwise completes only after the deadline', async () => {
      const c = await customer(3);
      const code = await issueCode(c.id);
      const s = setup();
      const attemptId = await begin(s, c);
      expect((await s.post('code-verify', { attemptId, code })).status).toBe(200);
      const held = await body(await phoneStep(s, attemptId));
      expect(held.status).toBe('security_hold');
      expect(typeof held.holdUntil).toBe('string');
      expect((await s.post('complete', { attemptId, newPassword: NEW })).status).toBe(401);
      const holdNotice = s.notices.find((n) => n.kind === 'hold_started')!;
      expect(holdNotice.cancelToken).toMatch(/^[0-9a-f]{64}$/);
      await setHoldIn(attemptId, -1);
      expect((await s.post('complete', { attemptId, newPassword: NEW })).status).toBe(204);

      // a second customer: cancel during the hold prevents completion for good
      const c2 = await customer(4);
      const code2 = await issueCode(c2.id);
      const s2 = setup();
      const id2 = await begin(s2, c2);
      await s2.post('code-verify', { attemptId: id2, code: code2 });
      await phoneStep(s2, id2);
      const credential2 = `${id2}.${s2.notices.find((n) => n.kind === 'hold_started')!.cancelToken!}`;
      expect((await s2.post('cancel', { credential: `${id2}.${'0'.repeat(64)}` })).status).toBe(
        401,
      );
      expect((await s2.post('cancel', { credential: credential2 })).status).toBe(204);
      expect((await s2.post('cancel', { credential: credential2 })).status).toBe(401); // single use
      await setHoldIn(id2, -1).catch(() => undefined);
      expect((await s2.post('complete', { attemptId: id2, newPassword: NEW })).status).toBe(401);
      expect((await attempt(id2)).status).toBe('cancelled');
    });

    it('lost phone (email challenge + recovery code) is held, and no single factor ever completes', async () => {
      const c = await customer(5);
      const code = await issueCode(c.id);
      const s = setup();
      const id = await begin(s, c);
      await emailStep(s, id);
      expect(await body(await s.post('code-verify', { attemptId: id, code }))).toMatchObject({
        status: 'security_hold',
      });

      for (const [i, step] of [
        [6, 'email'],
        [7, 'phone'],
        [8, 'code'],
      ] as const) {
        const cc = await customer(i);
        const cCode = await issueCode(cc.id);
        const ss = setup();
        const aid = await begin(ss, cc);
        if (step === 'email') await emailStep(ss, aid);
        if (step === 'phone') await phoneStep(ss, aid);
        if (step === 'code') await ss.post('code-verify', { attemptId: aid, code: cCode });
        const before = await credential(cc.id);
        expect((await ss.post('complete', { attemptId: aid, newPassword: NEW })).status).toBe(401);
        expect(await credential(cc.id)).toEqual(before);
      }
    });

    it('answers two concurrent completions with exactly one success', async () => {
      const c = await customer(9);
      const s = setup();
      const s2 = setup({ connection: client2 });
      const id = await begin(s, c);
      await emailStep(s, id);
      await phoneStep(s, id);
      await setHoldIn(id, -1);
      const results = await Promise.all([
        s.post('complete', { attemptId: id, newPassword: NEW }),
        s2.post('complete', { attemptId: id, newPassword: `${NEW} other` }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 401]);
    });

    it('refuses a weak new password without changing anything', async () => {
      const c = await customer(10);
      const s = setup();
      const id = await begin(s, c);
      await emailStep(s, id);
      await phoneStep(s, id);
      await setHoldIn(id, -1);
      const before = await credential(c.id);
      expect((await s.post('complete', { attemptId: id, newPassword: 'short' })).status).toBe(401);
      expect(await credential(c.id)).toEqual(before);
      expect((await attempt(id)).status).toBe('security_hold');
    });
  });

  describe('recovery phone OTP (purpose binding)', () => {
    it('only checks a code for an attempt that asked for one, so a sign-in code cannot satisfy recovery', async () => {
      const c = await customer(11);
      const s = setup();
      const id = await begin(s, c);
      s.otp.codes.set(c.phone, '654321'); // a code the provider issued for ordinary sign-in
      expect((await s.post('phone-verify', { attemptId: id, code: '654321' })).status).toBe(401);
      expect(s.otp.checks).toBe(0); // the provider was never even asked
      expect((await attempt(id)).phone_factor_at).toBeNull();
    });

    it('rejects a wrong code (spending budget), accepts the right one once, and refuses a replay', async () => {
      const c = await customer(12);
      const s = setup();
      const id = await begin(s, c);
      await s.post('phone-otp', { attemptId: id });
      expect((await s.post('phone-verify', { attemptId: id, code: '000000' })).status).toBe(401);
      expect((await attempt(id)).factor_failures).toBe(1);
      expect((await s.post('phone-verify', { attemptId: id, code: '123456' })).status).toBe(200);
      expect((await s.post('phone-verify', { attemptId: id, code: '123456' })).status).toBe(401);
      expect((await attempt(id)).phone_factor_at).not.toBeNull();
    });

    it('sends at most three codes per attempt and never to an unverified phone', async () => {
      const c = await customer(13);
      const s = setup();
      const id = await begin(s, c);
      for (let i = 0; i < 5; i += 1)
        expect((await s.post('phone-otp', { attemptId: id })).status).toBe(202);
      expect(s.otp.sent).toHaveLength(3);
      expect((await attempt(id)).phone_otp_request_count).toBe(3);

      const unverified = await customer(14, { phoneDaysAgo: null });
      const s2 = setup();
      const id2 = await begin(s2, unverified);
      expect((await s2.post('phone-otp', { attemptId: id2 })).status).toBe(202);
      expect(s2.otp.sent).toEqual([]);
      expect((await s2.post('phone-verify', { attemptId: id2, code: '123456' })).status).toBe(401);
    });

    it('expires a requested code after ten minutes, without asking the provider', async () => {
      const c = await customer(15);
      const s = setup();
      const id = await begin(s, c);
      await s.post('phone-otp', { attemptId: id });
      await q(
        `UPDATE customer_recovery_attempts SET phone_otp_requested_at = now() - interval '11 minutes' WHERE id=$1`,
        [id],
      );
      expect((await s.post('phone-verify', { attemptId: id, code: '123456' })).status).toBe(401);
      expect(s.otp.checks).toBe(0);
    });

    it("keeps customers apart: one customer's code and attempt can never satisfy another's", async () => {
      const x = await customer(16);
      const y = await customer(17);
      const s = setup();
      const idX = await begin(s, x);
      const idY = await begin(s, y);
      await s.post('phone-otp', { attemptId: idY }); // only Y asked for a code, sent to Y's phone
      expect(s.otp.sent).toEqual([y.phone]);
      expect((await s.post('phone-verify', { attemptId: idX, code: '123456' })).status).toBe(401);
      expect(s.otp.checks).toBe(0);
      await s.post('phone-otp', { attemptId: idX }); // now X asked, so the provider is consulted, with X's phone
      expect(s.otp.sent).toEqual([y.phone, x.phone]);
      s.otp.codes.set(x.phone, '999999');
      expect((await s.post('phone-verify', { attemptId: idX, code: '123456' })).status).toBe(401); // Y's code is not X's
      expect((await attempt(idX)).phone_factor_at).toBeNull();
      expect((await attempt(idY)).phone_factor_at).toBeNull();
    });

    it('exhausts the attempt after five wrong factor attempts', async () => {
      const c = await customer(18);
      const s = setup();
      const id = await begin(s, c);
      await s.post('phone-otp', { attemptId: id });
      for (let i = 0; i < 5; i += 1)
        expect((await s.post('phone-verify', { attemptId: id, code: '000000' })).status).toBe(401);
      expect(await attempt(id)).toMatchObject({
        status: 'rejected',
        ended_reason: 'factor_budget_exhausted',
      });
      expect((await s.post('phone-verify', { attemptId: id, code: '123456' })).status).toBe(401);
    });
  });

  describe('initiation, notifications and rate limits', () => {
    it('answers identically for a known customer, an unknown email and a phone-only customer, so accounts cannot be enumerated', async () => {
      const known = await customer(19);
      const phoneOnly = await customer(20, { email: false });
      const s = setup();
      const shape = async (r: Response) => ({ status: r.status, keys: Object.keys(await body(r)) });
      const responses = [
        await s.post('initiate', { email: known.email }),
        await s.post('initiate', { email: `nobody-${RUN}@example.test` }),
        await s.post('initiate', { email: `rr-20-${RUN}@example.test` }), // the phone-only customer's would-be email
      ];
      const shapes = await Promise.all(responses.map(shape));
      expect(new Set(shapes.map((x) => JSON.stringify(x))).size).toBe(1);
      expect(shapes[0]).toEqual({ status: 202, keys: ['attemptId'] });
      expect(
        (
          await q<{ n: number }>(
            'SELECT count(*)::int n FROM customer_recovery_attempts WHERE customer_id=ANY($1)',
            [[known.id, phoneOnly.id]],
          )
        )[0]!.n,
      ).toBe(1);
      expect(s.notices).toHaveLength(1);
    });

    it('fails closed (decoy response, no progress) when the notice is not accepted or the notifier or limiter is missing', async () => {
      const c = await customer(21);
      const failing = setup({ notifier: async () => ({ email: 'failed' }) });
      const r = await failing.post('initiate', { email: c.email });
      expect(r.status).toBe(202);
      const id = (await body(r)).attemptId as string; // a decoy: the real attempt was rejected and is never revealed
      expect(
        (
          await q<Record<string, unknown>>(
            'SELECT * FROM customer_recovery_attempts WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1',
            [c.id],
          )
        )[0],
      ).toMatchObject({ status: 'rejected', ended_reason: 'notification_failed' });
      expect(
        (
          await q<{ n: number }>(
            'SELECT count(*)::int n FROM customer_recovery_attempts WHERE id=$1',
            [id],
          )
        )[0]!.n,
      ).toBe(0);
      expect((await failing.post('email-challenge', { attemptId: id })).status).toBe(202);
      expect(failing.challenges).toHaveLength(0);

      const c2 = await customer(22);
      for (const over of [{ notifier: null }, { limiter: null }] as Setup[]) {
        const s = setup(over);
        const resp = await s.post('initiate', { email: c2.email });
        expect(resp.status).toBe(202);
        expect(
          (
            await q<{ n: number }>(
              'SELECT count(*)::int n FROM customer_recovery_attempts WHERE customer_id=$1',
              [c2.id],
            )
          )[0]!.n,
        ).toBe(0);
      }
      const noLimiter = setup({ limiter: null });
      expect(
        (await noLimiter.post('complete', { attemptId: crypto.randomUUID(), newPassword: NEW }))
          .status,
      ).toBe(401);
      expect((await noLimiter.post('phone-otp', { attemptId: crypto.randomUUID() })).status).toBe(
        202,
      );
      expect(noLimiter.otp.sent).toEqual([]);
    });

    it('enforces the budgets with opaque keys and denies once a budget is spent', async () => {
      const counts = new Map<string, number>();
      const keys: string[] = [];
      const limiter: RecoveryLimiter = async ({ key, limit }) => {
        keys.push(key);
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return n <= limit;
      };
      const c = await customer(23);
      const s = setup({ limiter });
      const id = await begin(s, c);
      for (let i = 0; i < 6; i += 1) await s.post('phone-otp', { attemptId: id });
      expect(s.otp.sent.length).toBeLessThanOrEqual(3);
      for (const key of keys) {
        expect(key).toMatch(
          /^customer-recovery:[a-z_]+:(source|customer|attempt_source):[0-9a-f]{64}$/,
        );
        for (const raw of [c.id, c.phone, c.email, SRC, id]) expect(key).not.toContain(raw);
      }
      // a spent initiation budget (3 per customer per hour) answers with a decoy and creates nothing more
      const c2 = await customer(24);
      const spent = setup({ limiter });
      for (let i = 0; i < 6; i += 1)
        expect((await spent.post('initiate', { email: c2.email })).status).toBe(202);
      expect(
        (
          await q<{ n: number }>(
            'SELECT count(*)::int n FROM customer_recovery_attempts WHERE customer_id=$1',
            [c2.id],
          )
        )[0]!.n,
      ).toBeLessThanOrEqual(3);
    });
  });

  describe('audit, secrecy and E10', () => {
    it('audits the whole flow without leaving any secret, code, OTP, proof or token behind', async () => {
      const c = await customer(25);
      const code = await issueCode(c.id);
      const s = setup();
      const id = await begin(s, c);
      const initiateToken = s.notices[0]!.cancelToken!;
      expect((await phoneStep(s, id)).status).toBe(200); // phone OTP first, so the recovery code that follows starts the hold
      expect((await s.post('code-verify', { attemptId: id, code })).status).toBe(200);
      const holdToken = s.notices.find((n) => n.kind === 'hold_started')!.cancelToken!;
      await setHoldIn(id, -1);
      expect((await s.post('complete', { attemptId: id, newPassword: NEW })).status).toBe(204);
      const types = await q<{ event_type: string; reason_code: string | null }>(
        `SELECT event_type, reason_code FROM customer_auth_events WHERE customer_id=$1 AND (event_type LIKE 'recovery%' OR (event_type='otp_requested'))`,
        [c.id],
      );
      expect(types.map((t) => t.event_type)).toEqual(
        expect.arrayContaining([
          'recovery_started',
          'recovery_factor_verified',
          'recovery_hold_started',
          'recovery_completed',
          'otp_requested',
        ]),
      );
      expect(types.find((t) => t.event_type === 'otp_requested')!.reason_code).toBe(
        'recovery_phone_otp',
      );
      const dump = JSON.stringify([
        await attempt(id),
        await q('SELECT * FROM customer_auth_events WHERE customer_id=$1', [c.id]),
        await q('SELECT * FROM customer_auth_challenges WHERE customer_id=$1', [c.id]),
        await q('SELECT * FROM customer_recovery_codes WHERE customer_id=$1', [c.id]),
      ]);
      for (const secret of [
        initiateToken,
        holdToken,
        code,
        code.replace(/-/g, ''),
        '123456',
        NEW,
        GOOD,
      ])
        expect(dump).not.toContain(secret);
      const text = JSON.stringify(s.notices);
      for (const secret of [code, '123456', NEW]) expect(text).not.toContain(secret);
    });

    it('keeps the E10 guard: phone-only recovery stays impossible for an email-linked customer', async () => {
      const c = await customer(26);
      const before = await credential(c.id);
      expect(await a.auth.recoverPassword(proof(c.phone), NEW)).toEqual({
        ok: false,
        reason: 'customer_inactive',
      });
      expect(await credential(c.id)).toEqual(before);
    });
  });
});
