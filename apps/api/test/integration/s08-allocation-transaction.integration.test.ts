import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeInvoiceBenefit } from '../../src/billing/invoice-benefit.calculator';
import { AGGREGATE_ALLOCATION_POLICY } from '../../src/billing/aggregate-benefit-allocation';
import { freezeAllocationTransaction } from '../../src/billing/allocation-freeze.transaction';

/**
 * Disposable PostgreSQL only. Never use Neon/production/staging for this test.
 * CREATE/DROP DATABASE with a unique echogrid_s08_freeze_ prefix; candidate
 * guard triggers are disabled solely inside the disposable scratch database.
 */
describe.skipIf(!process.env.DATABASE_URL)('S08-DEV-06 transactional freeze durability', () => {
  const source = process.env.DATABASE_URL ?? '';
  const base = source ? new URL(source) : null;
  const name = `echogrid_s08_freeze_${randomBytes(5).toString('hex')}`;
  const url = (database: string) => {
    const u = new URL(base!.toString());
    u.pathname = '/' + database;
    return u.toString();
  };
  const api = resolve(__dirname, '../..');
  const clients: Client[] = [];
  let admin: Client;
  let fixture: Client;
  let businessId: string;
  let reservationId: string;
  let concurrentReservationId: string;
  let attemptedReservationId: string;
  const fixtureOnly = async (run: () => Promise<void>) => {
    await fixture.query('BEGIN');
    try {
      await fixture.query('SET LOCAL session_replication_role = replica');
      await run();
      await fixture.query('COMMIT');
    } catch (error) {
      await fixture.query('ROLLBACK');
      throw error;
    }
  };
  const connect = async () => {
    const c = new Client({ connectionString: url(name) });
    await c.connect();
    clients.push(c);
    return c;
  };
  const input = (invoiceRef = 'in_freeze', selectedReservationId = reservationId) => {
    const benefit = computeInvoiceBenefit(
      {
        invoiceId: invoiceRef,
        invoiceBusinessId: businessId,
        currency: 'usd',
        status: 'paid',
        amountDueMinor: 199,
        amountPaidMinor: 199,
        interval: 'month',
        trialOrFree: false,
        lines: [{ id: 'il_base', category: 'recurring_base', amountMinor: 199, currency: 'usd' }],
      },
      { creditBusinessId: businessId, requestedUnits: 1, availableUnits: 1 },
    );
    if (!benefit.eligible) throw new Error('fixture rejected');
    return {
      allocationPolicyVersion: AGGREGATE_ALLOCATION_POLICY,
      invoice: { businessId, invoiceRef, currency: 'usd' },
      benefit,
      eligibleCreditBalance: 1,
      reservations: [
        {
          id: selectedReservationId,
          businessId,
          invoiceIntentRef:
            selectedReservationId === concurrentReservationId
              ? 'intent_concurrent'
              : selectedReservationId === attemptedReservationId
                ? 'intent_attempt'
                : 'intent_freeze',
          invoiceRef,
          currency: 'usd',
          units: 1 as const,
          state: 'reserved' as const,
          providerAttemptStarted: false as const,
        },
      ],
    };
  };

  beforeAll(async () => {
    if (
      !base ||
      !/^echogrid_(test|ci_|scratch_)/.test(decodeURIComponent(base.pathname.slice(1))) ||
      !/^(localhost|127\.0\.0\.1|::1)$/.test(base.hostname)
    )
      throw new Error('Only local disposable PostgreSQL is permitted');
    admin = new Client({ connectionString: url('postgres') });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const migration = spawnSync(
      process.execPath,
      [resolve(api, 'node_modules/drizzle-kit/bin.cjs'), 'migrate'],
      {
        cwd: api,
        encoding: 'utf8',
        timeout: 240_000,
        env: { ...process.env, DATABASE_URL: url(name) },
      },
    );
    if (migration.status !== 0)
      throw new Error(
        'Disposable migration replay failed: ' +
          (migration.error?.message ?? migration.stderr ?? migration.stdout ?? '').slice(-500),
      );
    fixture = await connect();
    const sql = readFileSync(
      resolve(api, 'scripts/sql/s08-allocation-freeze.candidate.sql'),
      'utf8',
    );
    await fixture.query(sql);
    // Only the two proposed freeze table guards are disabled, in this unique test DB.
    for (const table of ['s08_allocation_freezes', 's08_allocation_freeze_items']) {
      await fixture.query(
        `ALTER TABLE ${table} DISABLE TRIGGER s08_allocation_${table === 's08_allocation_freezes' ? 'parent' : 'child'}_deny`,
      );
    }
    const row = await fixture.query<{ id: string }>(
      "INSERT INTO businesses(name, slug, status) VALUES ('Freeze fixture',$1,'active') RETURNING id",
      [name],
    );
    businessId = row.rows[0]!.id;
    // Fixture construction only, not a valid credit award; the writer never makes financial changes.
    await fixtureOnly(async () => {
      reservationId = (
        await fixture.query<{ id: string }>(
          `INSERT INTO partner_credit_reservations
       (business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at,state)
       VALUES ($1,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'intent_freeze',$2,now()+interval '1 day','reserved') RETURNING id`,
          [businessId, name],
        )
      ).rows[0]!.id;
      concurrentReservationId = (
        await fixture.query<{ id: string }>(
          `INSERT INTO partner_credit_reservations
       (business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at,state)
       VALUES ($1,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'intent_concurrent',$2,now()+interval '1 day','reserved') RETURNING id`,
          [businessId, name + '-concurrent'],
        )
      ).rows[0]!.id;
    });
  }, 300_000);

  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => undefined);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }, 120_000);

  it('survives reconnect, independently reads all rows, and replays idempotently', async () => {
    const firstClient = await connect();
    const first = await freezeAllocationTransaction(firstClient, input());
    expect(first.replay).toBe(false);
    await firstClient.end();
    const secondClient = await connect();
    const second = await freezeAllocationTransaction(secondClient, input());
    expect(second.replay).toBe(true);
    expect(second.id).toBe(first.id);
    const count = await secondClient.query<{ n: number }>(
      'SELECT count(*)::int n FROM s08_allocation_freeze_items WHERE freeze_id=$1',
      [first.id],
    );
    expect(count.rows[0]?.n).toBe(1);
    expect(second.consumptionAuthorized).toBe(false);
  });

  it('rejects a conflicting invoice allocation without mutating the saved artifact', async () => {
    const c = await connect();
    const original = await c.query<{ digest: string }>(
      "SELECT allocation_digest digest FROM s08_allocation_freezes WHERE business_id=$1 AND invoice_ref='in_freeze'",
      [businessId],
    );
    const changed = input();
    const forged = { ...changed, eligibleCreditBalance: 2 };
    await expect(freezeAllocationTransaction(c, forged)).rejects.toThrow();
    const afterwards = await c.query<{ digest: string }>(
      "SELECT allocation_digest digest FROM s08_allocation_freezes WHERE business_id=$1 AND invoice_ref='in_freeze'",
      [businessId],
    );
    expect(afterwards.rows).toEqual(original.rows);
  });

  it('concurrent duplicate submission converges to one parent and one child', async () => {
    const [a, b] = await Promise.all([connect(), connect()]);
    const results = await Promise.all([
      freezeAllocationTransaction(a, input('in_concurrent', concurrentReservationId)),
      freezeAllocationTransaction(b, input('in_concurrent', concurrentReservationId)),
    ]);
    expect(results[0]?.id).toBe(results[1]?.id);
    expect(results.filter((x) => !x.replay)).toHaveLength(1);
    const totals = await a.query<{ n: number; children: number }>(
      `SELECT count(*)::int n,
       (SELECT count(*)::int FROM s08_allocation_freeze_items i
        JOIN s08_allocation_freezes f ON f.id=i.freeze_id WHERE f.invoice_ref='in_concurrent') children
       FROM s08_allocation_freezes WHERE invoice_ref='in_concurrent'`,
    );
    expect(totals.rows[0]).toMatchObject({ n: 1, children: 1 });
  });

  it('rolls back a parent when the child reservation uniqueness check rejects reuse', async () => {
    const c = await connect();
    await expect(
      freezeAllocationTransaction(c, input('in_child_conflict', concurrentReservationId)),
    ).rejects.toMatchObject({ code: '23505' });
    expect(
      (await c.query("SELECT id FROM s08_allocation_freezes WHERE invoice_ref='in_child_conflict'"))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await c.query('SELECT freeze_id FROM s08_allocation_freeze_items WHERE reservation_id=$1', [
          concurrentReservationId,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it('rejects a real persisted provider attempt despite the caller claiming no attempt', async () => {
    await fixtureOnly(async () => {
      attemptedReservationId = (
        await fixture.query<{ id: string }>(
          `INSERT INTO partner_credit_reservations
         (business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at,state)
         VALUES ($1,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'intent_attempt',$2,now()+interval '1 day','reserved') RETURNING id`,
          [businessId, name + '-attempt'],
        )
      ).rows[0]!.id;
      const intentId = (
        await fixture.query<{ id: string }>(
          `INSERT INTO benefit_application_intents
         (business_id,reservation_id,invoice_ref,expected_benefit_minor,currency,policy_version)
         VALUES ($1,$2,'in_attempted',1,'usd','synthetic-only') RETURNING id`,
          [businessId, attemptedReservationId],
        )
      ).rows[0]!.id;
      await fixture.query(
        `INSERT INTO benefit_provider_attempts
         (intent_id,business_id,attempt_key,provider_idempotency_key,started_at)
         VALUES ($1,$2,'synthetic-attempt',$3,now())`,
        [intentId, businessId, name + '-provider-attempt'],
      );
    });
    const c = await connect();
    await expect(
      freezeAllocationTransaction(c, input('in_attempted', attemptedReservationId)),
    ).rejects.toMatchObject({ reason: 'RESERVATION_MISMATCH' });
    expect(
      (await c.query("SELECT id FROM s08_allocation_freezes WHERE invoice_ref='in_attempted'"))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await c.query('SELECT freeze_id FROM s08_allocation_freeze_items WHERE reservation_id=$1', [
          attemptedReservationId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (await fixture.query('SHOW session_replication_role')).rows[0]?.session_replication_role,
    ).toBe('origin');
  });

  it('rejects expired reservation before committing another invoice freeze', async () => {
    await fixtureOnly(async () => {
      await fixture.query(
        "UPDATE partner_credit_reservations SET expires_at=now()-interval '1 second' WHERE id=$1",
        [reservationId],
      );
    });
    const c = await connect();
    await expect(freezeAllocationTransaction(c, input('in_expired'))).rejects.toMatchObject({
      reason: 'RESERVATION_MISMATCH',
    });
    const count = await c.query<{ n: number }>(
      "SELECT count(*)::int n FROM s08_allocation_freezes WHERE invoice_ref='in_expired'",
    );
    expect(count.rows[0]?.n).toBe(0);
  });
});
