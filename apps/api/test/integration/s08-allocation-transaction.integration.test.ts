import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeInvoiceBenefit } from '../../src/billing/invoice-benefit.calculator';
import { AGGREGATE_ALLOCATION_POLICY } from '../../src/billing/aggregate-benefit-allocation';
import { freezeAllocationTransaction } from '../../src/billing/allocation-freeze.transaction';
import { buildDb } from '../../src/db/client';
import { BenefitApplicationSagaService } from '../../src/billing/benefit-application.saga.service';

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

  const fresh = async (tag: string, tenant = businessId) => {
    const ref = `intent_${tag}_${randomBytes(5).toString('hex')}`;
    let id = '';
    await fixtureOnly(async () => {
      id = (await fixture.query<{ id: string }>(`INSERT INTO partner_credit_reservations
        (business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at,state)
        VALUES ($1,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),$2,$2,clock_timestamp()+interval '1 day','reserved') RETURNING id`,
      [tenant, ref])).rows[0]!.id;
    });
    const data = input(`in_${ref}`, id);
    data.invoice.businessId = tenant;
    data.reservations[0]!.businessId = tenant;
    data.reservations[0]!.invoiceIntentRef = ref;
    return data;
  };
  const sagaFor = (c: Client) => new BenefitApplicationSagaService(buildDb(c));
  const intentFor = (saga: BenefitApplicationSagaService, data: ReturnType<typeof input>, overrides = {}) => saga.createIntent({
    reservationId: data.reservations[0]!.id, invoiceRef: data.invoice.invoiceRef,
    expectedBenefitMinor: data.benefit.benefitMinor, currency: data.invoice.currency,
    policyVersion: data.benefit.policyVersion, ...overrides,
  });
  const enableScratchSaga = async () => {
    for (const table of ['benefit_application_intents', 'benefit_provider_attempts', 'benefit_provider_observations', 'benefit_application_compensations', 'benefit_application_transitions'])
      await fixture.query(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_inert_guard`);
  };
  const pid = async (c: Client) => (await c.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
  const blockedBy = async (waiting: number, holder: number) => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const row = (await fixture.query<{ blocked: boolean }>('SELECT $2::int=ANY(pg_blocking_pids($1::int)) blocked', [waiting, holder])).rows[0];
      if (row?.blocked) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Expected PostgreSQL lock barrier was not reached');
  };
  // Instrument the real driver, not the service: pause after a selected real
  // query has completed while its transaction/row locks remain held.
  const holdQuery = (c: Client, matches: (text: string) => boolean) => {
    let resume!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const ready = new Promise<void>(resolve => { reached = resolve; });
    let held = false;
    const proxy = new Proxy(c, {
      get(target, property) {
        if (property === 'query') return async (config: string | { text: string }, values?: unknown[]) => {
          const result = await target.query(config as string, values);
          if (!held && matches(typeof config === 'string' ? config : config.text)) {
            held = true; reached(); await gate;
          }
          return result;
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { proxy, ready, resume };
  };
  const expireSoon = async (id: string) => fixtureOnly(async () => {
    await fixture.query("UPDATE partner_credit_reservations SET expires_at=clock_timestamp()+interval '3 seconds' WHERE id=$1", [id]);
  });
  const waitForExpiry = async (id: string) => {
    await fixture.query(`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (expires_at-clock_timestamp()))+0.05))
      FROM partner_credit_reservations WHERE id=$1`, [id]);
  };
  const backendGone = async (backend: number) => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      if ((await fixture.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [backend])).rowCount === 0) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Disposable backend did not exit');
  };
  const terminateScratchBackend = async (backend: number) => {
    // The PID is obtained from a connection opened by this suite. Also require
    // its exact unique scratch database before terminating a PostgreSQL backend.
    const result = await fixture.query<{ terminated: boolean }>(`SELECT pg_terminate_backend(pid) terminated
      FROM pg_stat_activity WHERE pid=$1 AND datname=$2 AND pid<>pg_backend_pid()`, [backend, name]);
    expect(result.rows).toEqual([{ terminated: true }]);
    await backendGone(backend);
  };
  const loseCommitAcknowledgement = (c: Client, boundary: 'before' | 'after') => {
    let interrupted = false;
    return new Proxy(c, {
      get(target, property) {
        if (property === 'query') return async (config: string | { text: string }, values?: unknown[]) => {
          const text = typeof config === 'string' ? config : config.text;
          if (!interrupted && text.trim().toLowerCase() === 'commit') {
            interrupted = true;
            if (boundary === 'before') await target.end();
            else await target.query(config as string, values);
            throw new Error('Simulated lost commit acknowledgement');
          }
          return target.query(config as string, values);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
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

  it.each([['currency', 'eur'], ['aggregate_benefit_minor', '999']])('rejects persisted parent %s disagreement without rewriting it', async (column, value) => {
    const data = await fresh(column);
    const c = await connect();
    const saved = await freezeAllocationTransaction(c, data);
    // Fixed allow-list from it.each, no caller-controlled SQL identifier.
    await fixture.query(`UPDATE s08_allocation_freezes SET ${column}=$1 WHERE id=$2`, [value, saved.id]);
    await expect(freezeAllocationTransaction(c, data)).rejects.toMatchObject({ reason: 'VERIFICATION_FAILED' });
    expect((await fixture.query(`SELECT ${column}::text value FROM s08_allocation_freezes WHERE id=$1`, [saved.id])).rows[0]?.value).toBe(value);
    expect((await fixture.query('SELECT count(*)::int n FROM s08_allocation_freeze_items WHERE freeze_id=$1', [saved.id])).rows[0]?.n).toBe(1);
    await enableScratchSaga();
    const saga = sagaFor(await connect()); const intent = await intentFor(saga, data);
    expect(await saga.beginApply(intent.id, 'tampered-parent')).toMatchObject({ ok: false, code: 'ALLOCATION_MISMATCH' });
    expect((await fixture.query('SELECT id FROM benefit_provider_attempts WHERE intent_id=$1', [intent.id])).rowCount).toBe(0);
  });

  it('rejects a child monetary mismatch against an otherwise valid parent', async () => {
    const data = await fresh('child_money');
    const c = await connect();
    const saved = await freezeAllocationTransaction(c, data);
    await fixture.query('UPDATE s08_allocation_freeze_items SET benefit_minor=999 WHERE freeze_id=$1', [saved.id]);
    await expect(freezeAllocationTransaction(c, data)).rejects.toMatchObject({ reason: 'VERIFICATION_FAILED' });
  });

  it('serializes freeze first: a real saga attempt waits and then uses the committed allocation', async () => {
    await enableScratchSaga();
    const data = await fresh('freeze_first');
    const a = await connect(); const b = await connect();
    const apid = await pid(a); const bpid = await pid(b);
    const saga = sagaFor(b); const intent = await intentFor(saga, data);
    const hold = holdQuery(a, text => text.includes('JOIN benefit_provider_attempts'));
    const freezing = freezeAllocationTransaction(hold.proxy, data);
    let attempting: ReturnType<typeof saga.beginApply> | undefined;
    try {
      await hold.ready;
      attempting = saga.beginApply(intent.id, 'freeze-first');
      await blockedBy(bpid, apid);
    } finally { hold.resume(); }
    const frozen = await freezing;
    expect((await attempting)?.ok).toBe(true);
    expect((await fixture.query('SELECT count(*)::int n FROM benefit_provider_attempts WHERE intent_id=$1', [intent.id])).rows[0]?.n).toBe(1);
    expect((await fixture.query('SELECT count(*)::int n FROM s08_allocation_freeze_items WHERE freeze_id=$1', [frozen.id])).rows[0]?.n).toBe(1);
  });

  it('serializes attempt first: no missing freeze is accepted, and retry after freeze is safe', async () => {
    const data = await fresh('attempt_first');
    const a = await connect(); const b = await connect();
    const apid = await pid(a); const bpid = await pid(b);
    const hold = holdQuery(a, text => text.includes('partner_credit_reservations') && text.toLowerCase().includes('for update'));
    const saga = sagaFor(hold.proxy); const intent = await intentFor(saga, data);
    const attempting = saga.beginApply(intent.id, 'attempt-first');
    let freezing: ReturnType<typeof freezeAllocationTransaction> | undefined;
    try {
      await hold.ready;
      freezing = freezeAllocationTransaction(b, data);
      await blockedBy(bpid, apid);
    } finally { hold.resume(); }
    expect(await attempting).toMatchObject({ ok: false, code: 'ALLOCATION_REQUIRED' });
    expect((await fixture.query('SELECT count(*)::int n FROM benefit_provider_attempts WHERE intent_id=$1', [intent.id])).rows[0]?.n).toBe(0);
    expect(await freezing).toMatchObject({ replay: false, providerVerified: false, consumptionAuthorized: false });
    expect(await saga.beginApply(intent.id, 'attempt-first')).toMatchObject({ ok: true, replay: false });
    expect(await saga.beginApply(intent.id, 'attempt-first')).toMatchObject({ ok: true, replay: true });
  });

  it('rejects a competing freeze after a real saga attempt obtains the reservation and commits first', async () => {
    const data = await fresh('attempt_commits_first');
    const frozen = await freezeAllocationTransaction(await connect(), data);
    const a = await connect(); const b = await connect();
    const apid = await pid(a); const bpid = await pid(b);
    const hold = holdQuery(a, text => text.toLowerCase().includes('insert into "benefit_provider_attempts"'));
    const saga = sagaFor(hold.proxy); const intent = await intentFor(saga, data);
    const attempting = saga.beginApply(intent.id, 'commits-first');
    let denied: Promise<void> | undefined;
    try {
      await hold.ready;
      denied = expect(freezeAllocationTransaction(b, data)).rejects.toMatchObject({ reason: 'RESERVATION_MISMATCH' });
      await blockedBy(bpid, apid);
    } finally { hold.resume(); }
    expect(await attempting).toMatchObject({ ok: true, replay: false });
    await denied;
    expect((await fixture.query('SELECT id FROM benefit_provider_attempts WHERE intent_id=$1', [intent.id])).rowCount).toBe(1);
    expect((await fixture.query('SELECT allocation_digest FROM s08_allocation_freezes WHERE id=$1', [frozen.id])).rows[0]?.allocation_digest).toBe(frozen.artifact.allocationDigest);
  });

  it.each([
    { invoiceRef: 'in_other' }, { currency: 'eur' }, { expectedBenefitMinor: 999 }, { policyVersion: 'unsupported' },
  ])('refuses an attempt whose intent disagrees with the frozen terms: %j', async overrides => {
    const data = await fresh('wrong_terms');
    await freezeAllocationTransaction(await connect(), data);
    const saga = sagaFor(await connect());
    const intent = await intentFor(saga, data, overrides);
    expect(await saga.beginApply(intent.id, 'wrong-terms')).toMatchObject({ ok: false, code: 'ALLOCATION_MISMATCH' });
    expect((await fixture.query('SELECT count(*)::int n FROM benefit_provider_attempts WHERE intent_id=$1', [intent.id])).rows[0]?.n).toBe(0);
    expect((await saga.get(intent.id))?.state).toBe('reserved');
  });

  it('rolls back a full freeze if expiry passes after children have been read', async () => {
    const data = await fresh('expires_at_end');
    const id = data.reservations[0]!.id;
    await expireSoon(id);
    const hold = holdQuery(await connect(), text => text.includes('FROM s08_allocation_freeze_items'));
    const freezing = freezeAllocationTransaction(hold.proxy, data);
    const denied = expect(freezing).rejects.toMatchObject({ reason: 'RESERVATION_MISMATCH' });
    try { await hold.ready; await waitForExpiry(id); } finally { hold.resume(); }
    await denied;
    expect((await fixture.query('SELECT id FROM s08_allocation_freezes WHERE invoice_ref=$1', [data.invoice.invoiceRef])).rowCount).toBe(0);
    expect((await fixture.query('SELECT freeze_id FROM s08_allocation_freeze_items WHERE reservation_id=$1', [id])).rowCount).toBe(0);
  });

  it('rejects expiry while waiting to acquire the reservation lock', async () => {
    const data = await fresh('expires_waiting'); const id = data.reservations[0]!.id;
    await expireSoon(id);
    const blocker = await connect(); const c = await connect();
    const holder = await pid(blocker); const waiting = await pid(c);
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM partner_credit_reservations WHERE id=$1 FOR UPDATE', [id]);
    const freezing = freezeAllocationTransaction(c, data);
    const denied = expect(freezing).rejects.toMatchObject({ reason: 'RESERVATION_MISMATCH' });
    try { await blockedBy(waiting, holder); await waitForExpiry(id); } finally { await blocker.query('ROLLBACK'); }
    await denied;
    expect((await fixture.query('SELECT id FROM s08_allocation_freezes WHERE invoice_ref=$1', [data.invoice.invoiceRef])).rowCount).toBe(0);
  });

  it('rolls back a new saga attempt and transition if expiry passes before its final check', async () => {
    const data = await fresh('attempt_expires'); const id = data.reservations[0]!.id;
    await freezeAllocationTransaction(await connect(), data);
    const hold = holdQuery(await connect(), text => text.toLowerCase().includes('insert into "benefit_provider_attempts"'));
    const saga = sagaFor(hold.proxy); const intent = await intentFor(saga, data);
    await expireSoon(id);
    const attempting = saga.beginApply(intent.id, 'expires');
    const denied = expect(attempting).rejects.toMatchObject({ code: 'RESERVATION_EXPIRED' });
    try { await hold.ready; await waitForExpiry(id); } finally { hold.resume(); }
    await denied;
    expect((await fixture.query('SELECT id FROM benefit_provider_attempts WHERE intent_id=$1', [intent.id])).rowCount).toBe(0);
    expect((await fixture.query('SELECT id FROM benefit_application_transitions WHERE intent_id=$1', [intent.id])).rowCount).toBe(0);
    expect((await saga.get(intent.id))?.state).toBe('reserved');
  });

  it('rejects real cross-business reservation substitution before persistence', async () => {
    const data = await fresh('tenant_substitution');
    const other = (await fixture.query<{ id: string }>("INSERT INTO businesses(name,slug,status) VALUES('Other tenant',$1,'active') RETURNING id", [randomBytes(8).toString('hex')])).rows[0]!.id;
    data.invoice.businessId = other; data.reservations[0]!.businessId = other;
    await expect(freezeAllocationTransaction(await connect(), data)).rejects.toMatchObject({ reason: 'RESERVATION_MISMATCH' });
    expect((await fixture.query('SELECT id FROM s08_allocation_freezes WHERE invoice_ref=$1', [data.invoice.invoiceRef])).rowCount).toBe(0);
  });

  it('replays and reconciles an existing attempt after expiry without originating another attempt', async () => {
    await enableScratchSaga();
    const data = await fresh('expired_obligation'); const id = data.reservations[0]!.id;
    await freezeAllocationTransaction(await connect(), data);
    const original = sagaFor(await connect()); const intent = await intentFor(original, data);
    expect(await original.beginApply(intent.id, 'original-key')).toMatchObject({ ok: true, replay: false });
    const before = (await fixture.query('SELECT * FROM benefit_provider_attempts WHERE intent_id=$1', [intent.id])).rows;
    await fixtureOnly(async () => {
      await fixture.query("UPDATE partner_credit_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    });
    const recovered = sagaFor(await connect());
    expect(await recovered.beginApply(intent.id, 'original-key')).toMatchObject({ ok: true, replay: true });
    expect(await recovered.beginApply(intent.id, 'replacement-key')).toMatchObject({ ok: false, code: 'ATTEMPT_CONFLICT' });
    expect(await recovered.recordObservation(intent.id, 'original-key', { status: 'unreachable' })).toMatchObject({
      ok: true, intent: { state: 'retained', outcome: 'unresolved' },
    });
    expect(await recovered.beginApply(intent.id, 'original-key')).toMatchObject({ ok: true, replay: true });
    expect((await fixture.query('SELECT * FROM benefit_provider_attempts WHERE intent_id=$1', [intent.id])).rows).toEqual(before);
    expect((await fixture.query("SELECT id FROM benefit_application_transitions WHERE intent_id=$1 AND event_type='begin_apply' AND replay=false", [intent.id])).rowCount).toBe(1);
  });

  it.each(['parent', 'child'] as const)('backend termination after %s insertion rolls back the entire allocation', async phase => {
    const data = await fresh(`terminated_${phase}`);
    const c = await connect(); c.on('error', () => undefined);
    const backend = await pid(c);
    const hold = holdQuery(c, text => phase === 'parent'
      ? text.includes('INSERT INTO s08_allocation_freezes')
      : text.includes('INSERT INTO s08_allocation_freeze_items'));
    const failed = expect(freezeAllocationTransaction(hold.proxy, data)).rejects.toThrow();
    try { await hold.ready; await terminateScratchBackend(backend); } finally { hold.resume(); }
    await failed;
    expect((await fixture.query('SELECT id FROM s08_allocation_freezes WHERE invoice_ref=$1', [data.invoice.invoiceRef])).rowCount).toBe(0);
    expect((await fixture.query('SELECT freeze_id FROM s08_allocation_freeze_items WHERE reservation_id=$1', [data.reservations[0]!.id])).rowCount).toBe(0);
    const retried = await freezeAllocationTransaction(await connect(), data);
    expect(retried).toMatchObject({ replay: false, providerVerified: false, consumptionAuthorized: false });
    expect((await fixture.query('SELECT freeze_id FROM s08_allocation_freeze_items WHERE reservation_id=$1', [data.reservations[0]!.id])).rows).toEqual([{ freeze_id: retried.id }]);
  });

  it('backend termination after attempt insertion preserves the freeze and rolls back the saga transaction', async () => {
    await enableScratchSaga();
    const data = await fresh('terminated_attempt');
    const frozen = await freezeAllocationTransaction(await connect(), data);
    const c = await connect(); c.on('error', () => undefined); const backend = await pid(c);
    const hold = holdQuery(c, text => text.toLowerCase().includes('insert into "benefit_provider_attempts"'));
    const saga = sagaFor(hold.proxy); const intent = await intentFor(saga, data);
    const failed = expect(saga.beginApply(intent.id, 'original-key')).rejects.toThrow();
    try { await hold.ready; await terminateScratchBackend(backend); } finally { hold.resume(); }
    await failed;
    expect((await fixture.query('SELECT id FROM benefit_provider_attempts WHERE intent_id=$1', [intent.id])).rowCount).toBe(0);
    expect((await fixture.query('SELECT id FROM benefit_application_transitions WHERE intent_id=$1', [intent.id])).rowCount).toBe(0);
    const recovered = sagaFor(await connect());
    expect((await recovered.get(intent.id))?.state).toBe('reserved');
    expect(await recovered.beginApply(intent.id, 'original-key')).toMatchObject({ ok: true, replay: false });
    expect((await fixture.query('SELECT id FROM benefit_provider_attempts WHERE intent_id=$1', [intent.id])).rowCount).toBe(1);
    expect((await fixture.query('SELECT allocation_digest FROM s08_allocation_freezes WHERE id=$1', [frozen.id])).rows[0]?.allocation_digest).toBe(frozen.artifact.allocationDigest);
  });

  it.each(['before', 'after'] as const)('reconnect resolves an unknown freeze commit when transport fails %s server COMMIT', async boundary => {
    const data = await fresh(`unknown_${boundary}`); const c = await connect(); const backend = await pid(c);
    await expect(freezeAllocationTransaction(loseCommitAcknowledgement(c, boundary), data)).rejects.toThrow();
    if (boundary === 'before') await backendGone(backend);
    else await c.end();
    const persisted = (await fixture.query('SELECT id,allocation_digest FROM s08_allocation_freezes WHERE invoice_ref=$1', [data.invoice.invoiceRef])).rows;
    expect(persisted).toHaveLength(boundary === 'after' ? 1 : 0);
    const result = await freezeAllocationTransaction(await connect(), data);
    expect(result.replay).toBe(boundary === 'after');
    expect(result.providerVerified).toBe(false); expect(result.consumptionAuthorized).toBe(false);
    if (boundary === 'after') {
      expect(result.id).toBe(persisted[0]?.id);
      expect(result.artifact.allocationDigest).toBe(persisted[0]?.allocation_digest);
    }
    expect((await fixture.query('SELECT id FROM s08_allocation_freezes WHERE invoice_ref=$1', [data.invoice.invoiceRef])).rows).toEqual([{ id: result.id }]);
    expect((await fixture.query('SELECT freeze_id FROM s08_allocation_freeze_items WHERE reservation_id=$1', [data.reservations[0]!.id])).rows).toEqual([{ freeze_id: result.id }]);
  });

  it('lost attempt commit acknowledgement replays the original durable operation after reconnect', async () => {
    await enableScratchSaga();
    const data = await fresh('unknown_attempt');
    await freezeAllocationTransaction(await connect(), data);
    const c = await connect(); const original = sagaFor(loseCommitAcknowledgement(c, 'after'));
    const intent = await intentFor(sagaFor(c), data);
    await expect(original.beginApply(intent.id, 'original-key')).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'Simulated lost commit acknowledgement' }),
    });
    await c.end();
    const before = (await fixture.query('SELECT * FROM benefit_provider_attempts WHERE intent_id=$1', [intent.id])).rows;
    expect(before).toHaveLength(1);
    const recovered = sagaFor(await connect());
    expect(await recovered.beginApply(intent.id, 'original-key')).toMatchObject({ ok: true, replay: true });
    expect(await recovered.beginApply(intent.id, 'replacement-key')).toMatchObject({ ok: false, code: 'ATTEMPT_CONFLICT' });
    expect((await fixture.query('SELECT * FROM benefit_provider_attempts WHERE intent_id=$1', [intent.id])).rows).toEqual(before);
    expect((await fixture.query("SELECT id FROM benefit_application_transitions WHERE intent_id=$1 AND event_type='begin_apply' AND replay=false", [intent.id])).rowCount).toBe(1);
  });

  it('an unknown committed freeze does not authorize a new attempt after reservation expiry', async () => {
    await enableScratchSaga();
    const data = await fresh('unknown_expired'); const id = data.reservations[0]!.id;
    const original = await connect();
    await expect(freezeAllocationTransaction(loseCommitAcknowledgement(original, 'after'), data)).rejects.toThrow();
    await original.end();
    const saga = sagaFor(await connect()); const intent = await intentFor(saga, data);
    const before = (await fixture.query('SELECT * FROM s08_allocation_freezes WHERE invoice_ref=$1', [data.invoice.invoiceRef])).rows;
    expect(before).toHaveLength(1);
    await fixtureOnly(async () => {
      await fixture.query("UPDATE partner_credit_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    });
    await expect(freezeAllocationTransaction(await connect(), data)).rejects.toMatchObject({ reason: 'RESERVATION_MISMATCH' });
    await expect(saga.beginApply(intent.id, 'original-key')).rejects.toMatchObject({ code: 'RESERVATION_EXPIRED' });
    expect((await fixture.query('SELECT * FROM s08_allocation_freezes WHERE invoice_ref=$1', [data.invoice.invoiceRef])).rows).toEqual(before);
    expect((await fixture.query('SELECT id FROM benefit_provider_attempts WHERE intent_id=$1', [intent.id])).rowCount).toBe(0);
    expect((await saga.get(intent.id))?.state).toBe('reserved');
  });
});
