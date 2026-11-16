import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createDirectPbkdf2Worker } from '../../src/auth/pbkdf2-worker';
import { CustomerAuthEventRepository, CUSTOMER_AUTH_EVENT_METADATA_KEYS } from '../../src/repositories/customer-auth-event.repository';
import { CustomerSessionService } from '../../src/customer-auth/customer-session.service';
import { CustomerPasswordAuthService, type VerifiedPhoneProof } from '../../src/customer-auth/customer-password-auth.service';
import { createCustomerRecoveryCodeService } from '../../src/customer-auth/customer-recovery-code.service';
import { normalizeRecoveryCode } from '../../src/customer-auth/customer-recovery-code';

/**
 * CUSTOMER-AUTH-S4-01 recovery-code foundation against REAL Postgres. Internal
 * services only: nothing here is a route. Rows use per-run phones and are removed
 * in afterAll. PBKDF2 runs at 1000 iterations; production uses 600,000.
 */
describe.skipIf(!process.env.DATABASE_URL)('customer recovery codes (integration)', () => {
  const RUN = Date.now().toString().slice(-8);
  const PHONE = (i: number) => `+1558${RUN}${i}`;
  const GOOD = 'correct horse battery staple';
  const GOOD2 = 'another long passphrase here';
  const HMAC = 'synthetic-recovery-code-hmac-with-enough-entropy';
  let client: Client;
  let client2: Client;
  let clockMs = Date.now();
  const businesses: string[] = [];

  const build = (c: Client) => {
    const db = buildDb(c);
    const sessions = new CustomerSessionService(db, {
      sessionSigningSecret: 'integration-session-secret-not-for-production',
      legacySigningSecret: 'integration-legacy-secret-not-for-production',
      legacyAccepted: () => true, accessTtlSeconds: 900, refreshTtlSeconds: 30 * 86400,
      absoluteTtlSeconds: 30 * 86400, idleTtlSeconds: 7 * 86400, stepUpWindowSeconds: 300,
      now: () => new Date(clockMs),
    });
    const auth = new CustomerPasswordAuthService(db, sessions, createDirectPbkdf2Worker(), {
      passwordMinLength: 10, phoneProofMaxAgeSeconds: 300, passwordIterations: 1000, now: () => new Date(clockMs),
    });
    const codes = createCustomerRecoveryCodeService({
      db, hmacSecret: HMAC, stepUpWindowSeconds: 300, now: () => new Date(clockMs),
    });
    return { sessions, auth, codes };
  };
  let a: ReturnType<typeof build>;
  let b: ReturnType<typeof build>;

  const q = <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    client.query(text, values).then((r) => r.rows as T[]);
  const proof = (phone: string): VerifiedPhoneProof => ({ phone, verifiedAt: new Date(clockMs), source: 'local_otp' });
  const core = (code: string) => normalizeRecoveryCode(code)!;

  /** Phone-only customer with a password; optionally given a verified login email directly in SQL. */
  const customer = async (i: number, withEmail = true) => {
    const phone = PHONE(i);
    expect((await a.auth.registerWithPassword(proof(phone), GOOD)).ok).toBe(true);
    const [row] = await q<{ id: string }>('SELECT id FROM customers WHERE phone=$1', [phone]);
    const id = row!.id;
    if (withEmail) {
      await q('UPDATE customer_credentials SET login_email=$2, login_email_verified_at=now() WHERE customer_id=$1',
        [id, `rc-${i}-${RUN}@example.test`]);
    }
    return { id, phone };
  };
  const linkEmail = (customerId: string, tag: string) => q(
    'UPDATE customer_credentials SET login_email=$2, login_email_verified_at=now() WHERE customer_id=$1', [customerId, `rc-${tag}-${RUN}@example.test`]);
  const session = async (customerId: string, authMethod: 'password' | 'otp' | 'recovery', stepUp: boolean) => {
    const s = await a.sessions.establishSession({ customerId, authMethod });
    if (!s.ok) throw new Error('Expected a synthetic session');
    if (stepUp) expect(await a.sessions.recordStepUp({ customerId, sessionId: s.session.sessionId })).toBe(true);
    return { customerId, sessionId: s.session.sessionId };
  };
  const issued = async (owner: { customerId: string; sessionId: string }) => {
    const r = await a.codes.issue(owner);
    if (!r.ok) throw new Error(`Expected issuance, got ${r.reason}`);
    return r;
  };
  const setCount = async (id: string) => (await q<{ n: number }>(
    'SELECT count(*)::int AS n FROM customer_recovery_code_sets WHERE customer_id=$1', [id]))[0]!.n;
  const activeSets = async (id: string) => (await q<{ n: number }>(
    'SELECT count(*)::int AS n FROM customer_recovery_code_sets WHERE customer_id=$1 AND revoked_at IS NULL', [id]))[0]!.n;
  const events = (id: string) => q<{ event_type: string; outcome: string; reason_code: string | null; metadata: Record<string, unknown> | null }>(
    'SELECT event_type, outcome, reason_code, metadata FROM customer_auth_events WHERE customer_id=$1 AND event_type LIKE $2 ORDER BY created_at, id', [id, 'recovery_code_%']);
  const credential = async (id: string) => (await q('SELECT * FROM customer_credentials WHERE customer_id=$1', [id]))[0];

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    client2 = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([client.connect(), client2.connect()]);
    a = build(client);
    b = build(client2);
  });
  afterEach(() => { clockMs = Date.now(); vi.restoreAllMocks(); });
  afterAll(async () => {
    for (const id of businesses) await client.query('DELETE FROM businesses WHERE id=$1', [id]);
    await client.query('DELETE FROM customers WHERE phone LIKE $1', [`+1558${RUN}%`]);
    await Promise.all([client.end(), client2.end()]);
  });

  it('issues one bounded set of well-formed, unique codes and stores only verifiers', async () => {
    const c = await customer(1);
    const owner = await session(c.id, 'password', true);
    const r = await issued(owner);
    expect(r.codes).toHaveLength(8);
    expect(new Set(r.codes.map(core)).size).toBe(8);
    for (const code of r.codes) expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
    const rows = await q<{ verifier: string; position: number; customer_id: string }>(
      'SELECT verifier, position, customer_id FROM customer_recovery_codes WHERE customer_id=$1 ORDER BY position', [c.id]);
    expect(rows.map((x) => x.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const dump = JSON.stringify([rows, await q('SELECT * FROM customer_recovery_code_sets WHERE customer_id=$1', [c.id]), await events(c.id)]);
    for (const code of r.codes) {
      expect(rows.some((x) => x.verifier === core(code))).toBe(false);
      expect(dump).not.toContain(core(code));
      expect(dump).not.toContain(code);
      expect(dump.toLowerCase()).not.toContain(core(code).toLowerCase());
    }
    for (const row of rows) expect(row.verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(await activeSets(c.id)).toBe(1);
  });

  it('rejects every unauthorized issuance and creates nothing', async () => {
    const linked = await customer(2, false);
    const unlinked = await customer(3, false);
    const other = await customer(4);
    const otpSession = await session(linked.id, 'otp', true); // OTP sessions can only exist before an email is linked
    await linkEmail(linked.id, 'unauth');
    const recoverySession = await session(linked.id, 'recovery', true);
    const noStepUp = await session(linked.id, 'password', false);
    const stale = await session(linked.id, 'password', true);
    const revoked = await session(linked.id, 'password', true);
    await q('UPDATE customer_sessions SET revoked_at=now(), revoked_reason=$2 WHERE id=$1', [revoked.sessionId, 'logout']);
    const otherSession = await session(other.id, 'password', true);
    const noEmail = await session(unlinked.id, 'password', true);

    expect(await a.codes.issue(otpSession)).toEqual({ ok: false, reason: 'not_authorized' });
    expect(await a.codes.issue(recoverySession)).toEqual({ ok: false, reason: 'not_authorized' });
    expect(await a.codes.issue(noStepUp)).toEqual({ ok: false, reason: 'step_up_required' });
    expect(await a.codes.issue(revoked)).toEqual({ ok: false, reason: 'not_authorized' });
    expect(await a.codes.issue({ customerId: linked.id, sessionId: otherSession.sessionId })).toEqual({ ok: false, reason: 'not_authorized' });
    expect(await a.codes.issue(noEmail)).toEqual({ ok: false, reason: 'not_authorized' });
    expect(await a.codes.issue({ customerId: 'not-a-uuid', sessionId: stale.sessionId })).toEqual({ ok: false, reason: 'not_authorized' });
    clockMs += 301_000; // the step-up of `stale` is now older than the 300 s window
    expect(await a.codes.issue({ ...stale })).toEqual({ ok: false, reason: 'step_up_required' });
    clockMs = Date.now();
    const live = await session(linked.id, 'password', true);
    await q(`UPDATE customers SET status='suspended' WHERE id=$1`, [linked.id]);
    expect(await a.codes.issue(live)).toEqual({ ok: false, reason: 'not_authorized' });
    for (const id of [linked.id, unlinked.id, other.id]) expect(await setCount(id)).toBe(0);
  });

  it('redeems a code once; replay and every other failure return the same generic result', async () => {
    const c = await customer(5);
    const owner = await session(c.id, 'password', true);
    const first = await issued(owner);
    const [code1, code2] = first.codes as [string, string];
    expect(await a.codes.redeem({ customerId: c.id, code: code1 })).toEqual({ ok: true });
    const failures = [
      await a.codes.redeem({ customerId: c.id, code: code1 }), // replay
      await a.codes.redeem({ customerId: c.id, code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA' }), // wrong
      await a.codes.redeem({ customerId: c.id, code: 'nope' }), // malformed
      await a.codes.redeem({ customerId: c.id, code: undefined }),
      await a.codes.redeem({ customerId: 'not-a-uuid', code: code2 }),
      await a.codes.redeem({ customerId: '00000000-0000-4000-8000-000000000000', code: code2 }), // unknown customer
    ];
    for (const f of failures) expect(f).toEqual({ ok: false });
    expect(Object.keys(failures[0]!)).toEqual(['ok']);
    const reasons = (await events(c.id)).filter((e) => e.event_type === 'recovery_code_failed').map((e) => e.reason_code);
    expect(reasons).toEqual(expect.arrayContaining(['code_replayed', 'invalid_code']));
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM customer_recovery_codes WHERE customer_id=$1 AND consumed_at IS NOT NULL', [c.id]))[0]!.n).toBe(1);
    expect(await a.codes.redeem({ customerId: c.id, code: code2.toLowerCase() })).toEqual({ ok: true });
  });

  it('two concurrent redemptions of one code yield exactly one success', async () => {
    const c = await customer(6);
    const owner = await session(c.id, 'password', true);
    const { codes } = await issued(owner);
    const results = await Promise.all([
      a.codes.redeem({ customerId: c.id, code: codes[0] }),
      b.codes.redeem({ customerId: c.id, code: codes[0] }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM customer_recovery_codes WHERE customer_id=$1 AND consumed_at IS NOT NULL', [c.id]))[0]!.n).toBe(1);
  });

  it('rotation atomically revokes the previous set; concurrent issuance leaves exactly one active set', async () => {
    const c = await customer(7);
    const owner = await session(c.id, 'password', true);
    const first = await issued(owner);
    const second = await issued(owner);
    expect(await activeSets(c.id)).toBe(1);
    expect(await setCount(c.id)).toBe(2);
    expect((await q<{ revoked_reason: string }>('SELECT revoked_reason FROM customer_recovery_code_sets WHERE id=$1', [first.setId]))[0]!.revoked_reason).toBe('rotated');
    expect(await a.codes.redeem({ customerId: c.id, code: first.codes[0] })).toEqual({ ok: false });
    expect((await events(c.id)).some((e) => e.reason_code === 'code_revoked')).toBe(true);
    expect(await a.codes.redeem({ customerId: c.id, code: second.codes[0] })).toEqual({ ok: true });

    const raced = await Promise.all([a.codes.issue(owner), b.codes.issue(owner)]);
    expect(raced.every((r) => r.ok)).toBe(true);
    expect(await activeSets(c.id)).toBe(1);
    const activeCodes = await q<{ n: number }>('SELECT count(*)::int AS n FROM customer_recovery_codes k JOIN customer_recovery_code_sets s ON s.id=k.set_id WHERE s.customer_id=$1 AND s.revoked_at IS NULL', [c.id]);
    expect(activeCodes[0]!.n).toBe(8);
  });

  it('a failed rotation rolls back completely and leaves the previous set valid', async () => {
    const c = await customer(8);
    const owner = await session(c.id, 'password', true);
    const first = await issued(owner);
    vi.spyOn(CustomerAuthEventRepository.prototype, 'append').mockRejectedValueOnce(new Error('audit store down'));
    await expect(a.codes.issue(owner)).rejects.toThrow('audit store down');
    expect(await setCount(c.id)).toBe(1);
    expect(await activeSets(c.id)).toBe(1);
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM customer_recovery_codes WHERE customer_id=$1', [c.id]))[0]!.n).toBe(8);
    expect(await a.codes.redeem({ customerId: c.id, code: first.codes[3] })).toEqual({ ok: true });
  });

  it('spends a bounded attempt budget, then blocks even the right code until the window passes', async () => {
    const c = await customer(9);
    const owner = await session(c.id, 'password', true);
    const { codes } = await issued(owner);
    for (let i = 0; i < 5; i += 1) {
      expect(await a.codes.redeem({ customerId: c.id, code: `AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAA${i}` })).toEqual({ ok: false });
    }
    const afterFive = await events(c.id);
    const failedByAttempt = afterFive.filter((e) => e.event_type === 'recovery_code_failed')
      .sort((x, y) => Number(x.metadata?.attempt) - Number(y.metadata?.attempt));
    expect(failedByAttempt.map((e) => e.outcome)).toEqual(['failure', 'failure', 'failure', 'failure', 'blocked']);
    expect(failedByAttempt.at(-1)!.reason_code).toBe('attempts_exhausted');
    expect(await a.codes.redeem({ customerId: c.id, code: codes[0] })).toEqual({ ok: false });
    expect(await a.codes.redeem({ customerId: c.id, code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAB' })).toEqual({ ok: false });
    expect((await events(c.id)).length).toBe(afterFive.length); // blocked attempts add no audit rows
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM customer_recovery_codes WHERE customer_id=$1 AND consumed_at IS NOT NULL', [c.id]))[0]!.n).toBe(0);
    clockMs += 16 * 60_000;
    expect(await a.codes.redeem({ customerId: c.id, code: codes[0] })).toEqual({ ok: true });
  });

  it('isolates customers: a code and its budget never cross to another customer', async () => {
    const x = await customer(10);
    const y = await customer(11);
    const xs = await session(x.id, 'password', true);
    const ys = await session(y.id, 'password', true);
    const xc = await issued(xs);
    const yc = await issued(ys);
    expect(await b.codes.redeem({ customerId: y.id, code: xc.codes[0] })).toEqual({ ok: false });
    expect(await b.codes.redeem({ customerId: x.id, code: yc.codes[0] })).toEqual({ ok: false });
    const budgets = await q<{ customer_id: string; failed_attempts: number }>(
      'SELECT customer_id, failed_attempts FROM customer_recovery_code_sets WHERE customer_id = ANY($1)', [[x.id, y.id]]);
    expect(budgets.map((r) => r.failed_attempts)).toEqual([1, 1]);
    expect(await a.codes.redeem({ customerId: x.id, code: xc.codes[0] })).toEqual({ ok: true });
    const none = await customer(12);
    expect(await a.codes.redeem({ customerId: none.id, code: xc.codes[1] })).toEqual({ ok: false });
    expect(await setCount(none.id)).toBe(0);
  });

  it('revokes the active set on authorized request and refuses unauthorized revocation', async () => {
    const c = await customer(13);
    const owner = await session(c.id, 'password', true);
    const { codes } = await issued(owner);
    expect(await a.codes.revoke(await session(c.id, 'recovery', true))).toEqual({ ok: false, reason: 'not_authorized' });
    expect(await a.codes.revoke(owner)).toEqual({ ok: true, revoked: true });
    expect(await a.codes.revoke(owner)).toEqual({ ok: true, revoked: false });
    expect(await a.codes.redeem({ customerId: c.id, code: codes[0] })).toEqual({ ok: false });
    expect((await events(c.id)).map((e) => e.event_type)).toEqual(expect.arrayContaining(['recovery_code_issued', 'recovery_code_revoked']));
  });

  it('never changes credentials, sessions, identity or loyalty data, and logs no secret', async () => {
    const c = await customer(14);
    const owner = await session(c.id, 'password', true);
    const [business] = await q<{ id: string }>('INSERT INTO businesses (name, slug) VALUES ($1,$2) RETURNING id', [`RC ${RUN}`, `rc-${RUN}`]);
    businesses.push(business!.id);
    await q('INSERT INTO loyalty_accounts (customer_id, business_id, points) VALUES ($1,$2,42)', [c.id, business!.id]);
    const before = { cred: await credential(c.id), cust: await q('SELECT * FROM customers WHERE id=$1', [c.id]), sess: await q('SELECT id, revoked_at FROM customer_sessions WHERE customer_id=$1 ORDER BY id', [c.id]) };
    const { codes } = await issued(owner);
    await a.codes.redeem({ customerId: c.id, code: codes[0] });
    await a.codes.redeem({ customerId: c.id, code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA' });
    await a.codes.revoke(owner);
    expect(await credential(c.id)).toEqual(before.cred);
    expect(await q('SELECT * FROM customers WHERE id=$1', [c.id])).toEqual(before.cust);
    expect(await q('SELECT id, revoked_at FROM customer_sessions WHERE customer_id=$1 ORDER BY id', [c.id])).toEqual(before.sess);
    expect((await q<{ points: number }>('SELECT points FROM loyalty_accounts WHERE customer_id=$1', [c.id]))[0]!.points).toBe(42);
    const log = await events(c.id);
    expect(log.length).toBeGreaterThanOrEqual(4);
    const allowed = new Set<string>(CUSTOMER_AUTH_EVENT_METADATA_KEYS);
    for (const e of log) for (const key of Object.keys(e.metadata ?? {})) expect(allowed.has(key)).toBe(true);
    for (const code of codes) expect(JSON.stringify(log)).not.toContain(core(code));
  });

  it('E10 stays enforced: holding a recovery code never enables phone-only password recovery', async () => {
    const c = await customer(15);
    const owner = await session(c.id, 'password', true);
    const { codes } = await issued(owner);
    expect(await a.codes.redeem({ customerId: c.id, code: codes[0] })).toEqual({ ok: true });
    const before = await credential(c.id);
    expect(await a.auth.recoverPassword(proof(c.phone), GOOD2)).toEqual({ ok: false, reason: 'customer_inactive' });
    expect(await a.sessions.completeRecovery({ customerId: c.id, passwordHash: 'pbkdf2$1000$AAAA$BBBB' })).toEqual({ ok: false, reason: 'recovery_not_permitted' });
    expect(await credential(c.id)).toEqual(before);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM customer_sessions WHERE customer_id=$1 AND auth_method='recovery'`, [c.id]))[0]!.n).toBe(0);
  });

  it('keeps phone-only recovery for a customer with no linked email', async () => {
    const c = await customer(16, false);
    expect((await a.auth.recoverPassword(proof(c.phone), GOOD2)).ok).toBe(true);
    expect((await a.auth.loginWithPassword({ phone: c.phone, password: GOOD2 })).ok).toBe(true);
  });

  it('the database itself bounds a set, one active set per customer and verifier format', async () => {
    const c = await customer(17);
    const owner = await session(c.id, 'password', true);
    const { setId } = await issued(owner);
    await expect(q('INSERT INTO customer_recovery_codes (set_id, customer_id, position, verifier) VALUES ($1,$2,9,$3)', [setId, c.id, 'a'.repeat(64)])).rejects.toThrow();
    await expect(q('INSERT INTO customer_recovery_codes (set_id, customer_id, position, verifier) VALUES ($1,$2,1,$3)', [setId, c.id, 'b'.repeat(64)])).rejects.toThrow();
    await expect(q('INSERT INTO customer_recovery_codes (set_id, customer_id, position, verifier) VALUES ($1,$2,0,$3)', [setId, c.id, 'c'.repeat(64)])).rejects.toThrow();
    await expect(q('INSERT INTO customer_recovery_codes (set_id, customer_id, position, verifier) VALUES ($1,$2,2,$3)', [setId, c.id, 'NOT-HEX'])).rejects.toThrow();
    await expect(q('INSERT INTO customer_recovery_code_sets (customer_id) VALUES ($1)', [c.id])).rejects.toThrow();
    expect(await activeSets(c.id)).toBe(1);
  });
});
