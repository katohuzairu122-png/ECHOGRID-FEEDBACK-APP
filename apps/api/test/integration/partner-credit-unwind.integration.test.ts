import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { buildDb } from '../../src/db/client';
import { unwindCredit, type UnwindCause } from '../../src/partner-credits/partner-credit-unwind';
import { PartnerProvisionalReversalCompensator } from '../../src/partner-credits/partner-provisional-reversal.compensator';
import { PartnerCreditDeferredReversalReader } from '../../src/partner-credits/partner-credit-deferred-reversal.reader';
import { PartnerCreditProjectionAudit } from '../../src/partner-credits/partner-credit-projection.audit';

/**
 * R10 (Block 1): the shared unwind routine, the new ledger evidence, the extended lot rules and the obligation guard, on a real PostgreSQL SCRATCH database created and
 * dropped here on the disposable server named by DATABASE_URL (every migration applied). Fixtures are forged on one connection with foreign keys and triggers bypassed
 * (session_replication_role = replica); every unwind runs on its own connection with ALL constraints and triggers active. Only the inert write guards are disabled, and
 * only after the "inert by default" test proves they deny. No provider, Stripe, Neon or production resource.
 */
describe.skipIf(!process.env.DATABASE_URL)('R10 shared unwind routine (integration, scratch database)', () => {
  const base = new URL(process.env.DATABASE_URL!);
  const api = resolve(__dirname, '../..');
  const dbName = `echogrid_s08_unwind_${randomBytes(4).toString('hex')}`;
  const urlFor = (name: string) => { const u = new URL(base.toString()); u.pathname = `/${name}`; return u.toString(); };
  const clients: Client[] = [];
  let admin: Client; let fx: Client;
  const connect = async () => { const c = new Client({ connectionString: urlFor(dbName) }); await c.connect(); clients.push(c); return c; };
  const rows = async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await admin.query<T>(sql, params)).rows;
  const fxq = async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await fx.query<T>(sql, params)).rows;
  const GUARDS: Array<[string, string]> = [
    ['partner_credit_award_decisions', 'partner_credit_awards_insert_disabled'], ['partner_credit_lots', 'partner_credit_lots_inert_guard'], ['partner_credit_accounts', 'partner_credit_accounts_inert_guard'],
    ['partner_credit_reservations', 'partner_credit_reservations_inert_guard'], ['partner_credit_ledger', 'partner_credit_ledger_insert_disabled'],
    ['partner_credit_recovery_obligations', 'partner_credit_recovery_insert_disabled'],
  ];
  const errText = (e: unknown) => String((e as { cause?: { message?: string } })?.cause?.message ?? (e as Error)?.message ?? e);
  const rejects = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e) { return errText(e); } };

  let seq = 0;
  let dbApp: ReturnType<typeof buildDb>;
  const compensator = new PartnerProvisionalReversalCompensator();
  const audit = async (businessId: string) => new PartnerCreditProjectionAudit(dbApp).inspect({ businessId });
  const codes = async (businessId: string) => { const r = await audit(businessId); return r.status === 'inconsistent' ? [...new Set(r.violations.map(v => v.code))].sort() : r.status; };

  type Kind = 'provisional' | 'available' | 'reserved' | 'expired' | 'offset_consumed';
  interface Cred { businessId: string; accountId: string; settlementId: string; decisionId: string; lotId: string; obligationId?: string; reversalRef?: string }

  /** One credit of the given kind, with exactly the ledger entries, buckets and rows the real services leave behind. */
  async function credit(kind: Kind): Promise<Cred> {
    const n = ++seq;
    const businessId = (await rows<{ id: string }>("insert into businesses(name,slug,status) values($1,$2,'active') returning id", [`R10 ${n}`, `r10-${dbName}-${n}`]))[0]!.id;
    const buckets = { provisional: kind === 'provisional' ? 1 : 0, available: kind === 'available' ? 1 : 0, reserved: kind === 'reserved' ? 1 : 0 };
    const accountId = (await fxq<{ id: string }>('insert into partner_credit_accounts(business_id,provisional,available,reserved) values($1,$2,$3,$4) returning id', [businessId, buckets.provisional, buckets.available, buckets.reserved]))[0]!.id;
    const claimId = (await fxq<{ id: string }>(
      `insert into orphan_reward_claims(customer_id,origin_business_id,origin_loyalty_account_id,origin_loyalty_transaction_id,orphan_reason,source_reward_type,source_reward_snapshot,status,settled_at)
       values($1,$2,$3,$4,'origin_business_archived','voucher','{}'::jsonb,'settled',now()) returning id`, [randomUUID(), randomUUID(), randomUUID(), randomUUID()]))[0]!.id;
    const user = randomUUID();
    const settlementId = (await fxq<{ id: string }>(
      `insert into orphan_settlements(claim_id,customer_id,receiving_business_id,status,access_authorization_id,accepted_by_user_id,accepted_at,completion_authorization_id,completion_authorized_at,
         fulfilled_by_user_id,fulfilled_at,fulfillment_policy_version,fulfillment_snapshot,expires_at,idempotency_key)
       values($1,$2,$3,'fulfilled',$4,$5,now(),$6,now(),$5,now(),'v1','{}'::jsonb,now()+interval '30 days',$7) returning id`,
      [claimId, randomUUID(), businessId, randomUUID(), user, randomUUID(), `r10-settle-${dbName}-${n}`]))[0]!.id;
    const decisionState = kind === 'provisional' ? 'provisional' : 'vested';
    const decisionId = (await fxq<{ id: string }>(
      `insert into partner_credit_award_decisions(settlement_ref,business_id,policy_id,state,award_units,earning_month_utc,fulfilled_at,vest_at,idempotency_key)
       values($1,$2,$3,$4,1,'2026-10',now(),now(),$5) returning id`, [settlementId, businessId, randomUUID(), decisionState, `r10-dec-${dbName}-${n}`]))[0]!.id;
    const lotStatus = kind === 'offset_consumed' ? 'consumed' : kind;
    const lotId = (await fxq<{ id: string }>(
      `insert into partner_credit_lots(decision_id,account_id,units,available_units,status,vest_at,expires_at) values($1,$2,1,$3,$4,now(),now()+interval '1 year') returning id`,
      [decisionId, accountId, kind === 'available' ? 1 : 0, lotStatus]))[0]!.id;
    const led = (type: string, units: number, key: string, meta: unknown = null) =>
      fxq('insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key,metadata) values($1,$2,$3,$4,$5,$6::jsonb)', [accountId, decisionId, type, units, key, meta === null ? null : JSON.stringify(meta)]);
    await led('provisional', 1, `r10-prov-${dbName}-${n}`);
    const cred: Cred = { businessId, accountId, settlementId, decisionId, lotId };
    if (kind !== 'provisional') await led('vest', 1, `r10-vest-${dbName}-${n}`);
    if (kind === 'expired') await led('expire', -1, `r10-expire-${dbName}-${n}`);
    if (kind === 'reserved')
      await fxq(`insert into partner_credit_reservations(business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at) values($1,$2,$3,$4,$5,$6,now()+interval '1 day')`,
        [businessId, decisionId, lotId, accountId, `r10-intent-${n}`, `r10-res-${dbName}-${n}`]);
    if (kind === 'offset_consumed') {
      cred.reversalRef = randomUUID();
      cred.obligationId = (await fxq<{ id: string }>('insert into partner_credit_recovery_obligations(account_id,reversal_ref,units_due,units_outstanding) values($1,$2,1,0) returning id', [accountId, cred.reversalRef]))[0]!.id;
      await led('recovery_offset', -1, `partner-recovery-offset:v1:${settlementId}:${cred.obligationId}`, { obligationId: cred.obligationId, reversalRef: cred.reversalRef, offsetUnits: 1 });
    }
    return cred;
  }

  /** Runs the shared routine the way the caller does: settlement locked first, own transaction, own connection. */
  const unwindOn = (db: typeof dbApp, c: Cred, cause: UnwindCause) => db.transaction(async tx => {
    await tx.execute(sql`select id from orphan_settlements where id = ${c.settlementId} for update`);
    return unwindCredit(tx, { settlementRef: c.settlementId, businessId: c.businessId, cause });
  });
  const unwind = (c: Cred, cause: UnwindCause) => unwindOn(dbApp, c, cause);
  const reversalCause = (): UnwindCause => ({ source: 'settlement_reversal', reversalEventId: randomUUID() });
  const revocationCause = (): UnwindCause => ({ source: 'revocation', correctionId: randomUUID() });
  const state = async (c: Cred) => (await rows(
    `select d.state decision, l.status lot, a.provisional, a.available, a.reserved, a.recovery_due,
            (select count(*)::int from partner_credit_ledger g where g.decision_id=d.id) ledger,
            (select count(*)::int from partner_credit_ledger g where g.decision_id=d.id and g.entry_type in ('reverse','consumed_reversal','reversal_noop','recovery_restored')) reversal_entries
       from partner_credit_award_decisions d join partner_credit_lots l on l.decision_id=d.id join partner_credit_accounts a on a.id=l.account_id where d.id=$1`, [c.decisionId]))[0]!;

  beforeAll(async () => {
    const root = new Client({ connectionString: urlFor('postgres') });
    await root.connect(); await root.query(`create database ${dbName}`); await root.end();
    const m = spawnSync(process.execPath, [resolve(api, 'node_modules/drizzle-kit/bin.cjs'), 'migrate'], { cwd: api, encoding: 'utf8', timeout: 240_000, env: { ...process.env, DATABASE_URL: urlFor(dbName) } });
    if (m.status !== 0) throw new Error('scratch migrate failed');
    admin = await connect(); fx = await connect();
    await fx.query('SET session_replication_role = replica');
    dbApp = buildDb(await connect());
  }, 300_000);

  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => undefined);
    const root = new Client({ connectionString: urlFor('postgres') });
    await root.connect(); await root.query(`drop database if exists ${dbName} with (force)`); await root.end();
  });

  describe('inert by default', () => {
    it('with the shipped guards the unwind writes nothing (the guard denies the ledger write)', async () => {
      const c = await credit('provisional');
      expect(await rejects(unwind(c, reversalCause()))).toMatch(/disabled|guard|inert/i);
      expect(await state(c)).toMatchObject({ decision: 'provisional', lot: 'provisional', reversal_entries: 0 });
      for (const [t, g] of GUARDS) await admin.query(`ALTER TABLE ${t} DISABLE TRIGGER ${g}`);
    });
  });

  describe('G1: an expired credit closes with no balance effect', () => {
    it('writes one reversal_noop entry, reverses the lot and decision, moves no bucket, keeps the audit consistent, and is exactly-once', async () => {
      const c = await credit('expired');
      const before = await state(c);
      expect(await unwind(c, reversalCause())).toBe('closed_no_effect');
      expect(await state(c)).toMatchObject({ decision: 'reversed', lot: 'reversed', provisional: before.provisional, available: before.available, reserved: before.reserved, reversal_entries: 1 });
      const [e] = await rows<{ entry_type: string; units: number; idempotency_key: string }>("select entry_type, units, idempotency_key from partner_credit_ledger where decision_id=$1 and entry_type='reversal_noop'", [c.decisionId]);
      expect(e).toMatchObject({ entry_type: 'reversal_noop', units: 1, idempotency_key: `partner-reversal:v1:${c.settlementId}` });
      expect(await audit(c.businessId)).toMatchObject({ status: 'consistent' });
      const after = await state(c);
      expect(await unwind(c, reversalCause())).toBe('already_reversed');
      expect(await state(c)).toEqual(after);
    });
    it('refuses (and writes nothing) when the credit had any other effect: a reservation, or an unrelated ledger entry', async () => {
      const withEntry = await credit('expired');
      await fxq("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'admin_adjustment',-1,$3)", [withEntry.accountId, withEntry.decisionId, `adj-${randomUUID()}`]);
      expect(await rejects(unwind(withEntry, reversalCause()))).toMatch(/PARTNER_REVERSAL_CLOSE_NOT_PROVABLE/);
      expect(await state(withEntry)).toMatchObject({ decision: 'vested', lot: 'expired', reversal_entries: 0 });
      const withReservation = await credit('expired');
      await fxq(`insert into partner_credit_reservations(business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at,state,terminal_at) values($1,$2,$3,$4,$5,$6,now(),'released',now())`,
        [withReservation.businessId, withReservation.decisionId, withReservation.lotId, withReservation.accountId, `r-${randomUUID()}`, `r-${randomUUID()}`]);
      expect(await rejects(unwind(withReservation, reversalCause()))).toMatch(/PARTNER_REVERSAL_CLOSE_NOT_PROVABLE/);
      expect(await state(withReservation)).toMatchObject({ decision: 'vested', lot: 'expired', reversal_entries: 0 });
    });
  });

  describe('G2: an offset-consumed credit restores the exact offset', () => {
    it('reinstates the one recorded offset on its obligation and recovery_due, with immutable evidence, exactly once, and the audit stays consistent', async () => {
      const c = await credit('offset_consumed');
      expect(await audit(c.businessId)).toMatchObject({ status: 'consistent' });
      expect(await unwind(c, reversalCause())).toBe('recovery_restored');
      expect(await state(c)).toMatchObject({ decision: 'reversed', lot: 'reversed', recovery_due: 1, reversal_entries: 1 });
      expect((await rows<{ units_outstanding: number; units_due: number }>('select units_outstanding, units_due from partner_credit_recovery_obligations where id=$1', [c.obligationId]))[0]).toEqual({ units_outstanding: 1, units_due: 1 });
      const [e] = await rows<{ units: number; metadata: Record<string, unknown> }>("select units, metadata from partner_credit_ledger where decision_id=$1 and entry_type='recovery_restored'", [c.decisionId]);
      expect(e).toMatchObject({ units: 1, metadata: { obligationId: c.obligationId, restoredUnits: 1 } });
      expect(await audit(c.businessId)).toMatchObject({ status: 'consistent' });
      const after = await state(c);
      expect(await unwind(c, reversalCause())).toBe('already_reversed');
      expect(await state(c)).toEqual(after);
    });
    it('blocks (writes nothing) when the restoration cannot be proven', async () => {
      const unknownObligation = await credit('offset_consumed');
      await fxq("update partner_credit_ledger set metadata = jsonb_set(metadata,'{obligationId}', to_jsonb($2::text)) where decision_id=$1 and entry_type='recovery_offset'", [unknownObligation.decisionId, randomUUID()]);
      expect(await rejects(unwind(unknownObligation, reversalCause()))).toMatch(/PARTNER_REVERSAL_RESTORE_UNPROVABLE/);
      const projection = await credit('offset_consumed');
      await fxq('update partner_credit_accounts set recovery_due = 5 where id=$1', [projection.accountId]);
      expect(await rejects(unwind(projection, reversalCause()))).toMatch(/PARTNER_REVERSAL_RESTORE_UNPROVABLE/);
      const notOffset = await credit('offset_consumed'); // the obligation is already at its cap: nothing can have been offset
      await fxq('update partner_credit_recovery_obligations set units_outstanding = units_due where id=$1', [notOffset.obligationId]);
      await fxq('update partner_credit_accounts set recovery_due = 1 where id=$1', [notOffset.accountId]);
      expect(await rejects(unwind(notOffset, reversalCause()))).toMatch(/PARTNER_REVERSAL_RESTORE_UNPROVABLE/);
      const two = await credit('offset_consumed');
      await fxq("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key,metadata) values($1,$2,'recovery_offset',-1,$3,$4::jsonb)", [two.accountId, two.decisionId, `second-${randomUUID()}`, JSON.stringify({ obligationId: two.obligationId, offsetUnits: 1 })]);
      expect(await rejects(unwind(two, reversalCause()))).toMatch(/PARTNER_REVERSAL_RESTORE_UNPROVABLE/);
      for (const c of [unknownObligation, projection, notOffset, two]) expect(await state(c)).toMatchObject({ decision: 'vested', lot: 'consumed', reversal_entries: 0 });
    });
    it('a lot set to consumed by hand with NO offset entry still fails closed with the original error', async () => {
      const c = await credit('offset_consumed');
      await fxq("delete from partner_credit_ledger where decision_id=$1 and entry_type='recovery_offset'", [c.decisionId]);
      expect(await rejects(unwind(c, reversalCause()))).toMatch(/PARTNER_REVERSAL_LOT_STATE_UNSUPPORTED/);
    });
  });

  describe('reserved credits are deferred, never touched (O2a)', () => {
    it('writes nothing, leaves the credit exactly as it was, and the pending work is derived from persisted state', async () => {
      const c = await credit('reserved');
      const before = await state(c);
      expect(await unwind(c, reversalCause())).toBe('deferred_credit_in_use');
      expect(await unwind(c, revocationCause())).toBe('deferred_credit_in_use');
      expect(await state(c)).toEqual(before);
      const reader = new PartnerCreditDeferredReversalReader(dbApp);
      expect((await reader.list({ businessId: c.businessId }))).toEqual([]); // the settlement is not reversed yet
      await fxq("update orphan_settlements set status='reversed' where id=$1", [c.settlementId]);
      expect((await reader.list({ businessId: c.businessId })).map(x => x.decisionId)).toEqual([c.decisionId]);
      expect((await reader.list({ businessId: randomUUID() }))).toEqual([]);
      // a reversed settlement whose lot is still AVAILABLE is pending work too (a reservation may have been released since)
      const available = await credit('available');
      await fxq("update orphan_settlements set status='reversed' where id=$1", [available.settlementId]);
      expect((await reader.list({ businessId: available.businessId })).map(x => x.decisionId)).toEqual([available.decisionId]);
      // expired and provisional lots on a reversed settlement are not listed
      for (const kind of ['expired', 'provisional'] as const) {
        const other = await credit(kind);
        await fxq("update orphan_settlements set status='reversed' where id=$1", [other.settlementId]);
        expect((await reader.list({ businessId: other.businessId }))).toEqual([]);
      }
      expect(await audit(c.businessId)).toMatchObject({ status: 'consistent' });
    });
    it('waits for a concurrently held reservation lock and re-validates before deferring', async () => {
      const c = await credit('reserved');
      const holder = await connect();
      await holder.query('begin');
      await holder.query('select 1 from partner_credit_reservations where decision_id=$1 for update', [c.decisionId]);
      let done = false;
      const p = unwind(c, reversalCause()).then(r => { done = true; return r; });
      await new Promise(r => setTimeout(r, 400));
      expect(done).toBe(false);
      await holder.query('commit');
      expect(await p).toBe('deferred_credit_in_use');
    });
    it('refuses to defer when the reservation row is missing or the account does not show it reserved', async () => {
      const noRes = await credit('reserved');
      await fxq('delete from partner_credit_reservations where decision_id=$1', [noRes.decisionId]);
      expect(await rejects(unwind(noRes, reversalCause()))).toMatch(/PARTNER_REVERSAL_LOT_STATE_UNSUPPORTED/);
      const noBucket = await credit('reserved');
      await fxq('update partner_credit_accounts set reserved = 0 where id=$1', [noBucket.accountId]);
      expect(await rejects(unwind(noBucket, reversalCause()))).toMatch(/PARTNER_REVERSAL_LOT_STATE_UNSUPPORTED/);
    });
  });

  describe('one routine, two causes, canonical key (case I)', () => {
    it('provisional and available credits unwind under a revocation cause with the correction id carried in the metadata', async () => {
      for (const kind of ['provisional', 'available'] as const) {
        const c = await credit(kind);
        const cause = revocationCause();
        expect(await unwind(c, cause)).toBe('reversed');
        const [e] = await rows<{ idempotency_key: string; metadata: Record<string, unknown> }>("select idempotency_key, metadata from partner_credit_ledger where decision_id=$1 and entry_type='reverse'", [c.decisionId]);
        expect(e!.idempotency_key).toBe(`partner-reversal:v1:${c.settlementId}`);
        expect(e!.metadata).toMatchObject({ source: 'revocation', correctionId: (cause as { correctionId: string }).correctionId, reversalEventId: (cause as { correctionId: string }).correctionId });
        expect(await audit(c.businessId)).toMatchObject({ status: 'consistent' });
      }
    });
    it('executed revocation, then a settlement reversal: already reversed, exactly one consequence; and the other order', async () => {
      for (const kind of ['provisional', 'available', 'expired', 'offset_consumed'] as const) {
        const first = await credit(kind);
        await unwind(first, revocationCause());
        expect(await dbApp.transaction(tx => compensator.compensate(tx, { settlementRef: first.settlementId, businessId: first.businessId, reversalEventId: randomUUID() }))).toBe('already_reversed');
        expect((await state(first)).reversal_entries).toBe(1);
        const second = await credit(kind);
        expect(await dbApp.transaction(tx => compensator.compensate(tx, { settlementRef: second.settlementId, businessId: second.businessId, reversalEventId: randomUUID() }))).not.toBe('already_reversed');
        expect(await unwind(second, revocationCause())).toBe('already_reversed');
        expect((await state(second)).reversal_entries).toBe(1);
      }
    });
    it('N parallel unwinders of mixed causes produce exactly one financial consequence and no deadlock', async () => {
      for (const kind of ['provisional', 'available', 'expired', 'offset_consumed'] as const) {
        const c = await credit(kind);
        // one connection per racer: transactions on a shared connection would interleave instead of racing
        const racers = await Promise.all(Array.from({ length: 6 }, async () => buildDb(await connect())));
        const results = await Promise.all(racers.map((db, i) => unwindOn(db, c, i % 2 ? revocationCause() : reversalCause())));
        expect(results.filter(r => r === 'already_reversed')).toHaveLength(5);
        expect((await state(c)).reversal_entries).toBe(1);
        expect(await audit(c.businessId)).toMatchObject({ status: 'consistent' });
      }
    });
  });

  describe('the database re-verifies the evidence (service bypassed)', () => {
    it('refuses a reversal_noop that is not backed by an expired lot with only provisional, vest and expire entries', async () => {
      const notExpired = await credit('available');
      expect(await rejects(admin.query("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'reversal_noop',1,$3)", [notExpired.accountId, notExpired.decisionId, `n-${randomUUID()}`]))).toMatch(/closes only an expired lot/);
      const extra = await credit('expired');
      await fxq("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'admin_adjustment',-1,$3)", [extra.accountId, extra.decisionId, `a-${randomUUID()}`]);
      expect(await rejects(admin.query("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'reversal_noop',1,$3)", [extra.accountId, extra.decisionId, `n-${randomUUID()}`]))).toMatch(/closes only an expired lot/);
      const reserved = await credit('expired'); // a reservation row of any state is another effect
      await fxq(`insert into partner_credit_reservations(business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at,state,terminal_at) values($1,$2,$3,$4,$5,$6,now(),'released',now())`,
        [reserved.businessId, reserved.decisionId, reserved.lotId, reserved.accountId, `r-${randomUUID()}`, `r-${randomUUID()}`]);
      expect(await rejects(admin.query("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'reversal_noop',1,$3)", [reserved.accountId, reserved.decisionId, `n-${randomUUID()}`]))).toMatch(/closes only an expired lot/);
      const ok = await credit('expired');
      expect(await rejects(admin.query("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'reversal_noop',2,$3)", [ok.accountId, ok.decisionId, `n-${randomUUID()}`]))).toMatch(/r10_units_check|violates check/);
      await admin.query("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'reversal_noop',1,$3)", [ok.accountId, ok.decisionId, `n-${randomUUID()}`]);
      expect(await rejects(admin.query("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'reversal_noop',1,$3)", [ok.accountId, ok.decisionId, `n2-${randomUUID()}`]))).toMatch(/closes only an expired lot|one_reversal_noop_per_decision|duplicate key/); // the evidence trigger refuses a second one before the unique index
    });
    it('refuses a recovery_restored that does not reinstate exactly the one recorded offset on the same obligation', async () => {
      const c = await credit('offset_consumed');
      const ins = (units: number, obligationId: string) => admin.query("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key,metadata) values($1,$2,'recovery_restored',$3,$4,$5::jsonb)",
        [c.accountId, c.decisionId, units, `r-${randomUUID()}`, JSON.stringify({ obligationId })]);
      expect(await rejects(ins(1, randomUUID()))).toMatch(/reinstates exactly the one recorded offset/); // another obligation
      expect(await rejects(admin.query("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'recovery_restored',1,$3)", [c.accountId, c.decisionId, `r-${randomUUID()}`]))).toMatch(/names its decision and its obligation/);
      const noOffset = await credit('available');
      expect(await rejects(admin.query("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key,metadata) values($1,$2,'recovery_restored',1,$3,$4::jsonb)", [noOffset.accountId, noOffset.decisionId, `r-${randomUUID()}`, JSON.stringify({ obligationId: randomUUID() })]))).toMatch(/reinstates exactly the one recorded offset/);
      // a second recorded offset for the decision makes the restoration ambiguous: refused by the database
      const twoOffsets = await credit('offset_consumed');
      await fxq("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key,metadata) values($1,$2,'recovery_offset',-1,$3,$4::jsonb)", [twoOffsets.accountId, twoOffsets.decisionId, `second-${randomUUID()}`, JSON.stringify({ obligationId: twoOffsets.obligationId, offsetUnits: 1 })]);
      expect(await rejects(admin.query("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key,metadata) values($1,$2,'recovery_restored',1,$3,$4::jsonb)", [twoOffsets.accountId, twoOffsets.decisionId, `r-${randomUUID()}`, JSON.stringify({ obligationId: twoOffsets.obligationId })]))).toMatch(/reinstates exactly the one recorded offset/);
      await ins(1, c.obligationId!);
      expect(await rejects(ins(1, c.obligationId!))).toMatch(/one_recovery_restored_per_decision|duplicate key|reinstates exactly/);
    });
    it('lot rules: expired -> reversed needs reversal_noop; an offset-consumed lot needs recovery_restored; a consumed lot with a reservation still needs consumed_reversal', async () => {
      const expired = await credit('expired');
      expect(await rejects(admin.query("update partner_credit_lots set status='reversed' where id=$1", [expired.lotId]))).toMatch(/expired lot can only be reversed/);
      expect(await rejects(admin.query("update partner_credit_lots set status='available', available_units=1 where id=$1", [expired.lotId]))).toMatch(/expired lot can only be reversed/);
      await admin.query("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'reversal_noop',1,$3)", [expired.accountId, expired.decisionId, `n-${randomUUID()}`]);
      await admin.query("update partner_credit_lots set status='reversed' where id=$1", [expired.lotId]);
      const offset = await credit('offset_consumed');
      expect(await rejects(admin.query("update partner_credit_lots set status='reversed' where id=$1", [offset.lotId]))).toMatch(/recovery restoration was recorded/);
      await admin.query("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key,metadata) values($1,$2,'recovery_restored',1,$3,$4::jsonb)", [offset.accountId, offset.decisionId, `r-${randomUUID()}`, JSON.stringify({ obligationId: offset.obligationId })]);
      await admin.query("update partner_credit_lots set status='reversed' where id=$1", [offset.lotId]);
      const withReservation = await credit('reserved');
      await fxq("update partner_credit_reservations set state='consumed', terminal_at=now() where decision_id=$1", [withReservation.decisionId]);
      await fxq("update partner_credit_lots set status='consumed', available_units=0 where id=$1", [withReservation.lotId]);
      expect(await rejects(admin.query("update partner_credit_lots set status='reversed' where id=$1", [withReservation.lotId]))).toMatch(/reversed only after its consumed reversal was recorded/);
    });
    it('obligation guard: outstanding units follow recorded offsets and restorations only, and nothing else about the obligation may change', async () => {
      const c = await credit('offset_consumed');
      const upd = (set: string, ...p: unknown[]) => admin.query(`update partner_credit_recovery_obligations set ${set} where id=$1`, [c.obligationId, ...p]);
      expect(await rejects(upd('units_outstanding = 1'))).toMatch(/must equal its due units minus its recorded offsets/); // no restoration recorded
      expect(await rejects(upd('units_due = 2'))).toMatch(/immutable except for its outstanding units/);
      expect(await rejects(upd("reversal_ref = gen_random_uuid()"))).toMatch(/immutable except for its outstanding units/);
      await upd('units_outstanding = 0'); // a no-op update of the current value stays allowed
      // the real vest offset path: evidence first, then the decrement
      const fresh = await credit('available');
      const ob = (await fxq<{ id: string }>('insert into partner_credit_recovery_obligations(account_id,reversal_ref,units_due,units_outstanding) values($1,$2,1,1) returning id', [fresh.accountId, randomUUID()]))[0]!.id;
      expect(await rejects(admin.query('update partner_credit_recovery_obligations set units_outstanding = 0 where id=$1', [ob]))).toMatch(/must equal its due units minus its recorded offsets/);
      await fxq("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key,metadata) values($1,$2,'recovery_offset',-1,$3,$4::jsonb)", [fresh.accountId, fresh.decisionId, `o-${randomUUID()}`, JSON.stringify({ obligationId: ob, offsetUnits: 1 })]);
      await admin.query('update partner_credit_recovery_obligations set units_outstanding = 0 where id=$1', [ob]);
    });
  });

  describe('the audit catches broken R10 evidence', () => {
    it('flags a reversal_noop without a reversed lot, a recovery_restored that does not match its offset, and a non-conserving obligation', async () => {
      const noop = await credit('expired');
      await fxq("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'reversal_noop',1,$3)", [noop.accountId, noop.decisionId, `n-${randomUUID()}`]);
      expect(await codes(noop.businessId)).toContain('REVERSAL_NOOP_EVIDENCE');
      const restored = await credit('offset_consumed');
      await fxq("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key,metadata) values($1,$2,'recovery_restored',1,$3,$4::jsonb)", [restored.accountId, restored.decisionId, `r-${randomUUID()}`, JSON.stringify({ obligationId: restored.obligationId })]);
      expect(await codes(restored.businessId)).toEqual(expect.arrayContaining(['RECOVERY_RESTORED_EVIDENCE', 'OBLIGATION_CONSERVATION']));
      const conserve = await credit('offset_consumed');
      await fxq('update partner_credit_recovery_obligations set units_outstanding = 1 where id=$1', [conserve.obligationId]);
      await fxq('update partner_credit_accounts set recovery_due = 1 where id=$1', [conserve.accountId]);
      expect(await codes(conserve.businessId)).toContain('OBLIGATION_CONSERVATION');
    });
  });
});
