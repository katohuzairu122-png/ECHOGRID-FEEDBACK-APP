import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { evaluateLegacyToken } from '../../src/customer-auth/session-policy';
import {
  generateRefreshCredential,
  hashRefreshCredential,
} from '../../src/customer-auth/session-tokens';

/**
 * CUSTOMER-AUTH-01D-2: the four customer-auth tables against REAL Postgres.
 * Covers what a fake cannot: the migration actually landed, the CHECK and
 * UNIQUE constraints reject bad rows, cascades and SET NULL behave, and the
 * guarded single-statement updates really are atomic under concurrency
 * (a second pg connection is used so the two exchanges truly race).
 *
 * Rows are keyed on unique per-run phone numbers and deleted in afterAll.
 * Never point DATABASE_URL at production: these tests create and delete rows.
 */
describe.skipIf(!process.env.DATABASE_URL)('customer auth storage (integration)', () => {
  let client: Client;
  let client2: Client;
  let repos: ReturnType<typeof createRepositories>;
  let repos2: ReturnType<typeof createRepositories>;

  const RUN = Date.now().toString().slice(-8);
  const PHONES = [`+1555${RUN}1`, `+1555${RUN}2`, `+1555${RUN}3`, `+1555${RUN}4`, `+1555${RUN}5`];
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const NOW = () => new Date();
  const hash = async () => hashRefreshCredential(generateRefreshCredential());

  async function newCustomer(i: number, status: 'active' | 'suspended' = 'active') {
    const customer = await repos.customers.create({
      phone: PHONES[i]!,
      phoneVerifiedAt: NOW(),
      status,
    });
    return customer;
  }

  async function newSession(customerId: string, now = NOW()) {
    return repos.customerSessions.create({
      customerId,
      authMethod: 'otp',
      now,
      absoluteExpiresAt: new Date(now.getTime() + 30 * DAY),
      idleExpiresAt: new Date(now.getTime() + 7 * DAY),
      stepUpVerifiedAt: now,
    });
  }

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    client2 = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([client.connect(), client2.connect()]);
    repos = createRepositories(buildDb(client));
    repos2 = createRepositories(buildDb(client2));
  });

  afterAll(async () => {
    // customers delete cascades credentials and sessions (and their tokens),
    // and sets customer_id NULL on events, which are removed separately.
    await client.query('DELETE FROM customer_auth_events WHERE subject_key LIKE $1', [
      `test-${RUN}%`,
    ]);
    await client.query('DELETE FROM customers WHERE phone = ANY($1)', [PHONES]);
    await Promise.all([client.end(), client2.end()]);
  });

  describe('schema', () => {
    it('created the four tables and added no credential column to customers', async () => {
      const tables = await client.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
        [
          [
            'customer_credentials',
            'customer_sessions',
            'customer_refresh_tokens',
            'customer_auth_events',
          ],
        ],
      );
      expect(tables.rowCount).toBe(4);
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='customers'`,
      );
      const names = cols.rows.map((r) => r.column_name as string);
      expect(names.filter((n) => /pass|hash|secret|token/i.test(n))).toEqual([]);
    });

    it('has a unique index on the refresh token hash', async () => {
      const r = await client.query(
        `SELECT indexdef FROM pg_indexes WHERE tablename='customer_refresh_tokens' AND indexname='customer_refresh_tokens_token_hash_key'`,
      );
      expect(r.rows[0]?.indexdef).toMatch(/UNIQUE/);
    });

    it('stores no plaintext-capable column on the new tables (invariant I10)', async () => {
      const r = await client.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name = ANY($1)
            AND data_type IN ('text', 'character varying', 'jsonb', 'bytea')
            AND column_name ~* '(password|secret|otp|code|refresh|raw|phone|user_agent)'`,
        [
          [
            'customer_credentials',
            'customer_sessions',
            'customer_refresh_tokens',
            'customer_auth_events',
          ],
        ],
      );
      // password_hash and token_hash are hashes; reason_code is a closed machine code.
      const flagged = r.rows.map((x) => `${x.table_name}.${x.column_name}`).sort();
      expect(flagged).toEqual(
        ['customer_credentials.password_hash', 'customer_auth_events.reason_code'].sort(),
      );
    });
  });

  describe('constraints reject bad rows', () => {
    let customerId: string;
    let sessionId: string;
    beforeAll(async () => {
      const c = await newCustomer(0);
      customerId = c.id;
      sessionId = (await newSession(customerId)).id;
    });

    it('rejects an unknown auth method', async () => {
      await expect(
        client.query(
          `INSERT INTO customer_sessions (customer_id, auth_method, absolute_expires_at, idle_expires_at) VALUES ($1,'magic', now()+interval '1 day', now()+interval '1 day')`,
          [customerId],
        ),
      ).rejects.toThrow(/customer_sessions_auth_method_check/);
    });

    it('rejects revoked_at without a reason and a reason without revoked_at (I8)', async () => {
      await expect(
        client.query(`UPDATE customer_sessions SET revoked_at = now() WHERE id = $1`, [sessionId]),
      ).rejects.toThrow(/customer_sessions_revoked_pair_check/);
      await expect(
        client.query(`UPDATE customer_sessions SET revoked_reason = 'logout' WHERE id = $1`, [
          sessionId,
        ]),
      ).rejects.toThrow(/customer_sessions_revoked_pair_check/);
    });

    it('rejects an unknown revoke reason and an over-long device label', async () => {
      await expect(
        client.query(
          `UPDATE customer_sessions SET revoked_at = now(), revoked_reason = 'because' WHERE id = $1`,
          [sessionId],
        ),
      ).rejects.toThrow(/customer_sessions_revoked_reason_check/);
      await expect(
        client.query(`UPDATE customer_sessions SET device_label = $2 WHERE id = $1`, [
          sessionId,
          'x'.repeat(81),
        ]),
      ).rejects.toThrow(/customer_sessions_device_label_length_check/);
    });

    it('rejects a refresh token value that is not a SHA-256 hex hash (I10)', async () => {
      for (const bad of [
        '',
        'abc',
        generateRefreshCredential(),
        'G'.repeat(64),
        'a'.repeat(63),
        'a'.repeat(65),
      ]) {
        await expect(
          client.query(
            `INSERT INTO customer_refresh_tokens (session_id, token_hash, expires_at) VALUES ($1,$2, now()+interval '1 day')`,
            [sessionId, bad],
          ),
        ).rejects.toThrow(/customer_refresh_tokens_hash_shape_check/);
      }
    });

    it('rejects a duplicate token hash', async () => {
      const h = await hash();
      await repos.customerRefreshTokens.issue({
        sessionId,
        tokenHash: h,
        expiresAt: new Date(Date.now() + DAY),
        now: NOW(),
      });
      await expect(
        repos.customerRefreshTokens.issue({
          sessionId,
          tokenHash: h,
          expiresAt: new Date(Date.now() + DAY),
          now: NOW(),
        }),
      ).rejects.toThrow();
    });

    it('rejects unknown event types, outcomes and malformed reason codes', async () => {
      const ins = (type: string, outcome: string, reason: string | null) =>
        client.query(
          `INSERT INTO customer_auth_events (event_type, outcome, reason_code) VALUES ($1,$2,$3)`,
          [type, outcome, reason],
        );
      await expect(ins('hacked', 'success', null)).rejects.toThrow(
        /customer_auth_events_event_type_check/,
      );
      await expect(ins('otp_failed', 'maybe', null)).rejects.toThrow(
        /customer_auth_events_outcome_check/,
      );
      await expect(ins('otp_failed', 'failure', 'Has Spaces')).rejects.toThrow(
        /customer_auth_events_reason_code_check/,
      );
      await expect(ins('otp_failed', 'failure', '1starts_with_digit')).rejects.toThrow(
        /customer_auth_events_reason_code_check/,
      );
    });
  });

  describe('credentials', () => {
    it('creates exactly one credential, idempotently and race-safely (I1)', async () => {
      const c = await newCustomer(1);
      const now = NOW();
      const results = await Promise.all([
        repos.customerCredentials.create({
          customerId: c.id,
          passwordHash: 'pbkdf2$600000$c2FsdA==$aGFzaDE=',
          now,
        }),
        repos2.customerCredentials.create({
          customerId: c.id,
          passwordHash: 'pbkdf2$600000$c2FsdA==$aGFzaDI=',
          now,
        }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const rows = await client.query(
        'SELECT count(*)::int n FROM customer_credentials WHERE customer_id = $1',
        [c.id],
      );
      expect(rows.rows[0].n).toBe(1);
      // A later create is a no-op, never an overwrite.
      const winner = (await repos.customerCredentials.findByCustomerId(c.id))!.passwordHash;
      expect(
        await repos.customerCredentials.create({
          customerId: c.id,
          passwordHash: 'pbkdf2$600000$c2FsdA==$b3RoZXI=',
          now,
        }),
      ).toBe(false);
      expect((await repos.customerCredentials.findByCustomerId(c.id))!.passwordHash).toBe(winner);
    });

    it('sets the legacy cutoff atomically with first password enrollment and preserves OTP-only accounts', async () => {
      const c = await newCustomer(3);
      const firstTime = new Date('2026-11-12T12:00:00.350Z');

      // An OTP-only customer has no credential or cutoff row.
      expect(await repos.customerCredentials.exists(c.id)).toBe(false);
      expect(await repos.customerCredentials.findLegacyTokenCutoff(c.id)).toBeUndefined();
      expect(await repos.customerCredentials.advanceLegacyTokenCutoff(c.id, firstTime)).toBe(false);
      expect(await repos.customerCredentials.exists(c.id)).toBe(false);

      expect(
        await repos.customerCredentials.create({
          customerId: c.id,
          passwordHash: 'test-hash-only',
          now: firstTime,
        }),
      ).toBe(true);
      const record = (await repos.customerCredentials.findByCustomerId(c.id))!;
      expect(record.legacyTokensInvalidBefore?.getTime()).toBe(firstTime.getTime());
      expect(await repos.customerCredentials.findLegacyTokenCutoff(c.id)).toEqual({
        legacyTokensInvalidBefore: firstTime,
      });

      // Second-precision legacy JWT iat at the cutoff is deliberately rejected.
      expect(
        evaluateLegacyToken({
          iatSeconds: Math.floor(firstTime.getTime() / 1000),
          legacyAccepted: true,
          invalidBefore: record.legacyTokensInvalidBefore,
        }),
      ).toMatchObject({ accept: false, reason: 'before_cutoff' });
      expect(
        evaluateLegacyToken({
          iatSeconds: Math.floor(firstTime.getTime() / 1000) + 1,
          legacyAccepted: true,
          invalidBefore: record.legacyTokensInvalidBefore,
        }),
      ).toEqual({ accept: true });
    });

    it('keeps legacy cutoff monotonic across password changes and logout-all', async () => {
      const c = await newCustomer(4);
      const first = new Date('2026-11-12T13:00:00.500Z');
      const later = new Date('2026-11-12T13:05:00.600Z');
      const earlier = new Date('2026-11-12T13:01:00.000Z');
      const final = new Date('2026-11-12T13:10:00.700Z');
      await repos.customerCredentials.create({ customerId: c.id, passwordHash: 'first', now: first });

      await repos.customerCredentials.change({
        customerId: c.id,
        passwordHash: 'second',
        now: later,
      });
      let record = (await repos.customerCredentials.findByCustomerId(c.id))!;
      expect(record.legacyTokensInvalidBefore?.getTime()).toBe(later.getTime());
      expect(record.passwordChangedAt.getTime()).toBe(later.getTime());
      expect(record.updatedAt.getTime()).toBe(later.getTime());

      // A skewed timestamp cannot resurrect a previously invalidated token.
      await repos.customerCredentials.change({
        customerId: c.id,
        passwordHash: 'third',
        now: earlier,
      });
      record = (await repos.customerCredentials.findByCustomerId(c.id))!;
      expect(record.passwordHash).toBe('third');
      expect(record.legacyTokensInvalidBefore?.getTime()).toBe(later.getTime());
      expect(record.passwordChangedAt.getTime()).toBe(later.getTime());
      expect(record.updatedAt.getTime()).toBe(later.getTime());

      expect(await repos.customerCredentials.advanceLegacyTokenCutoff(c.id, final)).toBe(true);
      expect(await repos.customerCredentials.advanceLegacyTokenCutoff(c.id, first)).toBe(true);
      record = (await repos.customerCredentials.findByCustomerId(c.id))!;
      expect(record.legacyTokensInvalidBefore?.getTime()).toBe(final.getTime());
      expect(record.updatedAt.getTime()).toBe(final.getTime());

      // No per-customer data may be changed using an unrelated customer ID.
      const other = await repos.customers.findByPhone(PHONES[3]!);
      expect(await repos.customerCredentials.advanceLegacyTokenCutoff(other!.id, final)).toBe(true);
      expect(
        (await repos.customerCredentials.findByCustomerId(c.id))!.legacyTokensInvalidBefore?.getTime(),
      ).toBe(final.getTime());
    });

    it('changes the hash and records verification; reports false when there is no credential', async () => {
      const c = await newCustomer(2);
      expect(await repos.customerCredentials.exists(c.id)).toBe(false);
      expect(
        await repos.customerCredentials.change({ customerId: c.id, passwordHash: 'x', now: NOW() }),
      ).toBe(false);
      expect(await repos.customerCredentials.markVerified(c.id, NOW())).toBe(false);
      await repos.customerCredentials.create({
        customerId: c.id,
        passwordHash: 'h1',
        now: new Date(Date.now() - HOUR),
      });
      expect(await repos.customerCredentials.exists(c.id)).toBe(true);
      const before = (await repos.customerCredentials.findByCustomerId(c.id))!;
      expect(
        await repos.customerCredentials.change({
          customerId: c.id,
          passwordHash: 'h2',
          now: NOW(),
        }),
      ).toBe(true);
      const after = (await repos.customerCredentials.findByCustomerId(c.id))!;
      expect(after.passwordHash).toBe('h2');
      expect(after.passwordSetAt.getTime()).toBe(before.passwordSetAt.getTime());
      expect(after.passwordChangedAt.getTime()).toBeGreaterThan(before.passwordChangedAt.getTime());
      expect(await repos.customerCredentials.markVerified(c.id, NOW())).toBe(true);
      expect(
        (await repos.customerCredentials.findByCustomerId(c.id))!.lastVerifiedAt,
      ).not.toBeNull();
    });
  });

  describe('sessions', () => {
    it('reads session and customer status in one query, scoped to the customer (I11)', async () => {
      const c = await repos.customers.findByPhone(PHONES[0]!);
      const s = await newSession(c!.id);
      const hit = await repos.customerSessions.findWithCustomer(s.id, c!.id);
      expect(hit?.session.id).toBe(s.id);
      expect(hit?.customer).toEqual({ id: c!.id, status: 'active', isDeleted: false });
      // The wrong customer id never matches, even with a real session id.
      const other = await repos.customers.findByPhone(PHONES[1]!);
      expect(await repos.customerSessions.findWithCustomer(s.id, other!.id)).toBeUndefined();
    });

    it('lists only live sessions and orders by recent activity', async () => {
      const c = await repos.customers.findByPhone(PHONES[1]!);
      const now = NOW();
      const live = await newSession(c!.id, now);
      const expiredIdle = await repos.customerSessions.create({
        customerId: c!.id,
        authMethod: 'password',
        now,
        absoluteExpiresAt: new Date(now.getTime() + DAY),
        idleExpiresAt: new Date(now.getTime() - 1000),
      });
      const revoked = await newSession(c!.id, now);
      await repos.customerSessions.revoke({
        sessionId: revoked.id,
        customerId: c!.id,
        reason: 'logout',
        now,
      });
      const ids = (await repos.customerSessions.listLiveForCustomer(c!.id, now)).map((x) => x.id);
      expect(ids).toContain(live.id);
      expect(ids).not.toContain(expiredIdle.id);
      expect(ids).not.toContain(revoked.id);
    });

    it('revokes a session and its tokens atomically, finally, and only for the owner', async () => {
      const c = await repos.customers.findByPhone(PHONES[2]!);
      const owner = c!;
      const s = await newSession(owner.id);
      const t = await repos.customerRefreshTokens.issue({
        sessionId: s.id,
        tokenHash: await hash(),
        expiresAt: new Date(Date.now() + DAY),
        now: NOW(),
      });
      const stranger = (await repos.customers.findByPhone(PHONES[0]!))!;
      expect(
        await repos.customerSessions.revoke({
          sessionId: s.id,
          customerId: stranger.id,
          reason: 'logout',
          now: NOW(),
        }),
      ).toBe(false);
      expect(
        await repos.customerSessions.revoke({
          sessionId: s.id,
          customerId: owner.id,
          reason: 'logout',
          now: NOW(),
        }),
      ).toBe(true);
      expect(
        await repos.customerSessions.revoke({
          sessionId: s.id,
          customerId: owner.id,
          reason: 'admin',
          now: NOW(),
        }),
      ).toBe(false);
      const after = (await repos.customerSessions.findById(s.id))!;
      expect(after.revokedReason).toBe('logout'); // the second call did not overwrite the reason
      const token = await client.query(
        'SELECT revoked_at FROM customer_refresh_tokens WHERE id = $1',
        [t.id],
      );
      expect(token.rows[0].revoked_at).not.toBeNull();
      // Touch and step-up do nothing on a revoked session.
      expect(
        await repos.customerSessions.touch({
          sessionId: s.id,
          customerId: owner.id,
          now: NOW(),
          idleExpiresAt: new Date(Date.now() + DAY),
        }),
      ).toBe(false);
      expect(
        await repos.customerSessions.recordStepUp({
          sessionId: s.id,
          customerId: owner.id,
          now: NOW(),
        }),
      ).toBe(false);
    });

    it('revokes every other session in one call and can keep the current one (I6)', async () => {
      const c = (await repos.customers.findByPhone(PHONES[0]!))!;
      const keep = await newSession(c.id);
      const a = await newSession(c.id);
      const b = await newSession(c.id);
      const tokenOfA = await repos.customerRefreshTokens.issue({
        sessionId: a.id,
        tokenHash: await hash(),
        expiresAt: new Date(Date.now() + DAY),
        now: NOW(),
      });
      const n = await repos.customerSessions.revokeAllForCustomer({
        customerId: c.id,
        reason: 'password_changed',
        now: NOW(),
        exceptSessionId: keep.id,
      });
      expect(n).toBeGreaterThanOrEqual(2);
      expect((await repos.customerSessions.findById(keep.id))!.revokedAt).toBeNull();
      expect((await repos.customerSessions.findById(a.id))!.revokedReason).toBe('password_changed');
      expect((await repos.customerSessions.findById(b.id))!.revokedAt).not.toBeNull();
      const t = await client.query('SELECT revoked_at FROM customer_refresh_tokens WHERE id = $1', [
        tokenOfA.id,
      ]);
      expect(t.rows[0].revoked_at).not.toBeNull();
    });

    it('replay-induced revocation affects the compromised session, not the other device', async () => {
      const c = (await repos.customers.findByPhone(PHONES[2]!))!;
      const compromised = await newSession(c.id);
      const otherDevice = await newSession(c.id);
      const badToken = await repos.customerRefreshTokens.issue({
        sessionId: compromised.id,
        tokenHash: await hash(),
        expiresAt: new Date(Date.now() + DAY),
        now: NOW(),
      });
      const goodToken = await repos.customerRefreshTokens.issue({
        sessionId: otherDevice.id,
        tokenHash: await hash(),
        expiresAt: new Date(Date.now() + DAY),
        now: NOW(),
      });

      expect(
        await repos.customerSessions.revoke({
          sessionId: compromised.id,
          customerId: c.id,
          reason: 'replay_detected',
          now: NOW(),
        }),
      ).toBe(true);
      expect((await repos.customerSessions.findById(compromised.id))!.revokedReason).toBe(
        'replay_detected',
      );
      expect((await repos.customerSessions.findById(otherDevice.id))!.revokedAt).toBeNull();
      const tokens = await client.query(
        'SELECT id, revoked_at FROM customer_refresh_tokens WHERE id = ANY($1)',
        [[badToken.id, goodToken.id]],
      );
      expect(tokens.rows.find((row) => row.id === badToken.id)!.revoked_at).not.toBeNull();
      expect(tokens.rows.find((row) => row.id === goodToken.id)!.revoked_at).toBeNull();
    });

    it('surfaces a suspended customer through the joined read so the policy can deny it (I7)', async () => {
      await client.query(`UPDATE customers SET status='suspended' WHERE phone=$1`, [PHONES[1]!]);
      const c = (await repos.customers.findByPhone(PHONES[1]!))!;
      const s = await newSession(c.id);
      expect((await repos.customerSessions.findWithCustomer(s.id, c.id))?.customer.status).toBe(
        'suspended',
      );
      await client.query(`UPDATE customers SET status='active' WHERE phone=$1`, [PHONES[1]!]);
    });

    it('purges ended sessions and cascades their tokens', async () => {
      const c = (await repos.customers.findByPhone(PHONES[2]!))!;
      const old = new Date(Date.now() - 100 * DAY);
      const s = await repos.customerSessions.create({
        customerId: c.id,
        authMethod: 'otp',
        now: old,
        absoluteExpiresAt: new Date(old.getTime() + DAY),
        idleExpiresAt: new Date(old.getTime() + HOUR),
      });
      const t = await repos.customerRefreshTokens.issue({
        sessionId: s.id,
        tokenHash: await hash(),
        expiresAt: new Date(old.getTime() + DAY),
        now: old,
      });
      const removed = await repos.customerSessions.deleteEndedBefore(
        new Date(Date.now() - 30 * DAY),
      );
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(await repos.customerSessions.findById(s.id)).toBeUndefined();
      const left = await client.query('SELECT 1 FROM customer_refresh_tokens WHERE id = $1', [
        t.id,
      ]);
      expect(left.rowCount).toBe(0);
    });
  });

  describe('refresh token exchange (I3)', () => {
    it('lets exactly one of two truly concurrent exchanges win, and creates exactly one successor', async () => {
      const c = (await repos.customers.findByPhone(PHONES[0]!))!;
      const s = await newSession(c.id);
      const first = await repos.customerRefreshTokens.issue({
        sessionId: s.id,
        tokenHash: await hash(),
        expiresAt: new Date(Date.now() + DAY),
        now: NOW(),
      });
      const [r1, r2] = await Promise.all([
        repos.customerRefreshTokens.exchange({
          oldTokenId: first.id,
          successor: { tokenHash: await hash(), expiresAt: new Date(Date.now() + DAY) },
          now: NOW(),
        }),
        repos2.customerRefreshTokens.exchange({
          oldTokenId: first.id,
          successor: { tokenHash: await hash(), expiresAt: new Date(Date.now() + DAY) },
          now: NOW(),
        }),
      ]);
      expect([r1.rotated, r2.rotated].filter(Boolean)).toHaveLength(1);
      const rows = await client.query(
        'SELECT id, rotated_at, replaced_by_token_id FROM customer_refresh_tokens WHERE session_id = $1 ORDER BY issued_at',
        [s.id],
      );
      expect(rows.rowCount).toBe(2); // the original plus exactly one successor, never a second live token
      const old = rows.rows.find((r) => r.id === first.id)!;
      expect(old.rotated_at).not.toBeNull();
      const winner = r1.rotated ? r1 : r2;
      expect(winner.rotated && old.replaced_by_token_id === winner.successor.id).toBe(true);
    });

    it('concurrent session revocation and exchange leaves no usable token behind', async () => {
      const c = (await repos.customers.findByPhone(PHONES[0]!))!;
      const session = await newSession(c.id);
      const predecessor = await repos.customerRefreshTokens.issue({
        sessionId: session.id,
        tokenHash: await hash(),
        expiresAt: new Date(Date.now() + DAY),
        now: NOW(),
      });
      const [exchange, revoke] = await Promise.all([
        repos.customerRefreshTokens.exchange({
          oldTokenId: predecessor.id,
          successor: { tokenHash: await hash(), expiresAt: new Date(Date.now() + DAY) },
          now: NOW(),
        }),
        repos2.customerSessions.revoke({
          sessionId: session.id,
          customerId: c.id,
          reason: 'replay_detected',
          now: NOW(),
        }),
      ]);
      expect(revoke).toBe(true);
      expect([true, false]).toContain(exchange.rotated);
      const active = await client.query(
        'SELECT id FROM customer_refresh_tokens WHERE session_id=$1 AND revoked_at IS NULL',
        [session.id],
      );
      expect(active.rowCount).toBe(0);
      expect((await repos.customerSessions.findById(session.id))!.revokedAt).not.toBeNull();
    });

    it('refuses to exchange an already rotated, a revoked, or an unknown token and inserts nothing', async () => {
      const c = (await repos.customers.findByPhone(PHONES[0]!))!;
      const s = await newSession(c.id);
      const tok = await repos.customerRefreshTokens.issue({
        sessionId: s.id,
        tokenHash: await hash(),
        expiresAt: new Date(Date.now() + DAY),
        now: NOW(),
      });
      const step = {
        successor: { tokenHash: await hash(), expiresAt: new Date(Date.now() + DAY) },
        now: NOW(),
      };
      expect(
        (await repos.customerRefreshTokens.exchange({ oldTokenId: tok.id, ...step })).rotated,
      ).toBe(true);
      expect(
        (
          await repos.customerRefreshTokens.exchange({
            oldTokenId: tok.id,
            successor: { tokenHash: await hash(), expiresAt: step.successor.expiresAt },
            now: NOW(),
          })
        ).rotated,
      ).toBe(false);
      expect(
        (
          await repos.customerRefreshTokens.exchange({
            oldTokenId: '00000000-0000-4000-8000-000000000000',
            successor: { tokenHash: await hash(), expiresAt: step.successor.expiresAt },
            now: NOW(),
          })
        ).rotated,
      ).toBe(false);
      await repos.customerSessions.revoke({
        sessionId: s.id,
        customerId: c.id,
        reason: 'logout',
        now: NOW(),
      });
      const live = await client.query(
        'SELECT id FROM customer_refresh_tokens WHERE session_id = $1 AND rotated_at IS NULL',
        [s.id],
      );
      const res = await repos.customerRefreshTokens.exchange({
        oldTokenId: live.rows[0].id,
        successor: { tokenHash: await hash(), expiresAt: step.successor.expiresAt },
        now: NOW(),
      });
      expect(res.rotated).toBe(false);
      const count = await client.query(
        'SELECT count(*)::int n FROM customer_refresh_tokens WHERE session_id = $1',
        [s.id],
      );
      expect(count.rows[0].n).toBe(2); // original + the one legitimate successor only
    });

    it('finds a token by its hash', async () => {
      const c = (await repos.customers.findByPhone(PHONES[0]!))!;
      const s = await newSession(c.id);
      const h = await hash();
      const tok = await repos.customerRefreshTokens.issue({
        sessionId: s.id,
        tokenHash: h,
        expiresAt: new Date(Date.now() + DAY),
        now: NOW(),
      });
      expect((await repos.customerRefreshTokens.findByHash(h))?.id).toBe(tok.id);
      expect(await repos.customerRefreshTokens.findByHash(await hash())).toBeUndefined();
    });
  });

  describe('events', () => {
    it('appends an event with allow-listed metadata and lists it for the customer', async () => {
      const c = (await repos.customers.findByPhone(PHONES[0]!))!;
      await repos.customerAuthEvents.append({
        customerId: c.id,
        eventType: 'session_created',
        outcome: 'success',
        reasonCode: 'otp_login',
        metadata: { auth_method: 'otp', attempt: 1 },
      });
      const list = await repos.customerAuthEvents.listForCustomer(c.id, 5);
      expect(list[0]).toMatchObject({
        eventType: 'session_created',
        outcome: 'success',
        reasonCode: 'otp_login',
        metadata: { auth_method: 'otp', attempt: 1 },
      });
    });

    it('records an unknown-phone attempt with no customer and never a phone', async () => {
      await repos.customerAuthEvents.append({
        eventType: 'password_login_failed',
        outcome: 'failure',
        subjectKey: `test-${RUN}-unknown`,
      });
      const r = await client.query(
        'SELECT customer_id, subject_key FROM customer_auth_events WHERE subject_key = $1',
        [`test-${RUN}-unknown`],
      );
      expect(r.rows[0].customer_id).toBeNull();
    });

    it('survives a customer purge with customer_id set to NULL', async () => {
      const phone = `+1555${RUN}9`;
      const c = await repos.customers.create({ phone, phoneVerifiedAt: NOW() });
      await repos.customerAuthEvents.append({
        customerId: c.id,
        eventType: 'otp_verified',
        outcome: 'success',
        subjectKey: `test-${RUN}-purge`,
      });
      await client.query('DELETE FROM customers WHERE id = $1', [c.id]);
      const r = await client.query(
        'SELECT customer_id FROM customer_auth_events WHERE subject_key = $1',
        [`test-${RUN}-purge`],
      );
      expect(r.rowCount).toBe(1);
      expect(r.rows[0].customer_id).toBeNull();
    });

    it('purges events by retention cutoff', async () => {
      await repos.customerAuthEvents.append({
        eventType: 'rate_limited',
        outcome: 'blocked',
        subjectKey: `test-${RUN}-old`,
        now: new Date(Date.now() - 400 * DAY),
      });
      const removed = await repos.customerAuthEvents.deleteCreatedBefore(
        new Date(Date.now() - 365 * DAY),
      );
      expect(removed).toBeGreaterThanOrEqual(1);
      const r = await client.query('SELECT 1 FROM customer_auth_events WHERE subject_key = $1', [
        `test-${RUN}-old`,
      ]);
      expect(r.rowCount).toBe(0);
    });
  });

  describe('cascades', () => {
    it('deleting a customer removes credentials, sessions and tokens', async () => {
      const phone = `+1555${RUN}8`;
      const c = await repos.customers.create({ phone, phoneVerifiedAt: NOW() });
      await repos.customerCredentials.create({ customerId: c.id, passwordHash: 'h', now: NOW() });
      const s = await newSession(c.id);
      await repos.customerRefreshTokens.issue({
        sessionId: s.id,
        tokenHash: await hash(),
        expiresAt: new Date(Date.now() + DAY),
        now: NOW(),
      });
      await client.query('DELETE FROM customers WHERE id = $1', [c.id]);
      for (const [table, col, val] of [
        ['customer_credentials', 'customer_id', c.id],
        ['customer_sessions', 'customer_id', c.id],
        ['customer_refresh_tokens', 'session_id', s.id],
      ] as const) {
        const r = await client.query(`SELECT 1 FROM ${table} WHERE ${col} = $1`, [val]);
        expect(r.rowCount).toBe(0);
      }
    });
  });
});
