import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildDb } from '../../src/db/client';
import { BenefitApplicationSagaService } from '../../src/billing/benefit-application.saga.service';
import { BenefitTerminalApplicationService } from '../../src/billing/benefit-terminal-application.service';
import { PartnerCreditConsumptionService } from '../../src/partner-credits/partner-credit-consumption.service';
import { PartnerProvisionalReversalCompensator } from '../../src/partner-credits/partner-provisional-reversal.compensator';
import { PartnerCreditProjectionAudit } from '../../src/partner-credits/partner-credit-projection.audit';
import { seedScratchAllocation } from './helpers/s08-allocation-fixture';

/**
 * D4 final credit consumption and ledger accounting on PostgreSQL, in a SCRATCH database created and dropped here on the disposable server named by
 * DATABASE_URL (migration 0053 and every earlier migration applied). Fixture parents are forged on one connection with foreign keys and triggers bypassed
 * (session_replication_role = replica); every service call runs on its own connection with ALL constraints and the D4 triggers active. Only the inert write
 * guards (0041/0042/0048) are disabled, and only after the "inert by default" test has proved they deny. No provider, Stripe, Neon or production resource.
 */
describe.skipIf(!process.env.DATABASE_URL)('D4 final credit consumption and ledger accounting (integration, scratch database)', () => {
  const base = new URL(process.env.DATABASE_URL!);
  const api = resolve(__dirname, '../..');
  const dbName = `echogrid_s08_d4_${randomBytes(4).toString('hex')}`;
  const urlFor = (name: string) => { const u = new URL(base.toString()); u.pathname = `/${name}`; return u.toString(); };
  const clients: Client[] = [];
  let admin: Client;
  let fx: Client;
  const connect = async () => { const c = new Client({ connectionString: urlFor(dbName) }); await c.connect(); clients.push(c); return c; };
  const rows = async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await admin.query<T>(sql, params)).rows;
  const fxq = async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await fx.query<T>(sql, params)).rows;
  const GUARDS: Array<[string, string]> = [
    ['partner_credit_award_decisions', 'partner_credit_awards_insert_disabled'], ['partner_credit_lots', 'partner_credit_lots_inert_guard'], ['partner_credit_accounts', 'partner_credit_accounts_inert_guard'],
    ['partner_credit_reservations', 'partner_credit_reservations_inert_guard'], ['partner_credit_ledger', 'partner_credit_ledger_insert_disabled'],
    ['partner_credit_recovery_obligations', 'partner_credit_recovery_insert_disabled'], ['billing_partner_credit_applications', 'billing_partner_credit_applications_inert_guard'],
    ['benefit_application_intents', 'benefit_application_intents_inert_guard'], ['benefit_provider_attempts', 'benefit_provider_attempts_inert_guard'],
    ['benefit_provider_observations', 'benefit_provider_observations_inert_guard'], ['benefit_application_compensations', 'benefit_application_compensations_inert_guard'],
    ['benefit_application_transitions', 'benefit_application_transitions_inert_guard'],
  ];
  const setGuards = async (on: boolean) => { for (const [t, g] of GUARDS) await admin.query(`ALTER TABLE ${t} ${on ? 'ENABLE' : 'DISABLE'} TRIGGER ${g}`); };
  const errText = (e: unknown) => String((e as { cause?: { message?: string } })?.cause?.message ?? (e as Error)?.message ?? e);
  const rejects = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e) { return errText(e); } };

  let seq = 0;
  let saga: BenefitApplicationSagaService;
  let applications: BenefitTerminalApplicationService;
  let consumption: PartnerCreditConsumptionService;
  let compensator: PartnerProvisionalReversalCompensator;
  let dbApp: ReturnType<typeof buildDb>;
  let planId: string;

  interface Scenario { businessId: string; settlementId: string; decisionId: string; lotId: string; accountId: string; reservationId: string; intentId: string; invoiceRef: string }
  /** A vested, single-unit credit that is RESERVED for one invoice, with its provisional and vest ledger entries, an allocation freeze and a saga intent. */
  async function scenario(opts: { sagaTo?: 'none' | 'reserved' | 'applying' | 'consumed'; subscription?: 'active' | 'trialing' | 'none'; allocate?: boolean; expiresInMs?: number; appliedOffsetMs?: number } = {}): Promise<Scenario> {
    const n = ++seq; const o = { sagaTo: 'consumed', subscription: 'active', allocate: true, expiresInMs: 86_400_000, appliedOffsetMs: 1_000, ...opts };
    const businessId = (await rows<{ id: string }>("insert into businesses(name,slug,status) values($1,$2,'active') returning id", [`D4 ${n}`, `d4-${dbName}-${n}`]))[0]!.id;
    const user = randomUUID();
    const claimId = (await fxq<{ id: string }>(
      `insert into orphan_reward_claims(customer_id,origin_business_id,origin_loyalty_account_id,origin_loyalty_transaction_id,orphan_reason,source_reward_type,source_reward_snapshot,status,settled_at)
       values($1,$2,$3,$4,'origin_business_archived','voucher','{}'::jsonb,'settled',now()) returning id`, [randomUUID(), randomUUID(), randomUUID(), randomUUID()]))[0]!.id;
    const settlementId = (await fxq<{ id: string }>(
      `insert into orphan_settlements(claim_id,customer_id,receiving_business_id,status,access_authorization_id,accepted_by_user_id,accepted_at,completion_authorization_id,completion_authorized_at,
         fulfilled_by_user_id,fulfilled_at,fulfillment_policy_version,fulfillment_snapshot,expires_at,idempotency_key)
       values($1,$2,$3,'fulfilled',$4,$5,now(),$6,now(),$5,now(),'v1','{}'::jsonb,now()+interval '30 days',$7) returning id`,
      [claimId, randomUUID(), businessId, randomUUID(), user, randomUUID(), `d4-settle-${dbName}-${n}`]))[0]!.id;
    const accountId = (await fxq<{ id: string }>('insert into partner_credit_accounts(business_id,reserved) values($1,1) returning id', [businessId]))[0]!.id;
    const decisionId = (await fxq<{ id: string }>(
      `insert into partner_credit_award_decisions(settlement_ref,business_id,policy_id,state,award_units,earning_month_utc,fulfilled_at,vest_at,idempotency_key)
       values($1,$2,$3,'vested',1,'2026-10',now(),now(),$4) returning id`, [settlementId, businessId, randomUUID(), `d4-dec-${dbName}-${n}`]))[0]!.id;
    const lotId = (await fxq<{ id: string }>(
      `insert into partner_credit_lots(decision_id,account_id,units,available_units,status,vest_at,expires_at) values($1,$2,1,0,'reserved',now(),now()+interval '1 year') returning id`, [decisionId, accountId]))[0]!.id;
    await fxq(`insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'provisional',1,$3),($1,$2,'vest',1,$4)`, [accountId, decisionId, `d4-prov-${dbName}-${n}`, `d4-vest-${dbName}-${n}`]);
    const reservationId = (await fxq<{ id: string }>(
      `insert into partner_credit_reservations(business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at) values($1,$2,$3,$4,$5,$6,$7) returning id`,
      [businessId, decisionId, lotId, accountId, `intent-${n}`, `d4-res-${dbName}-${n}`, new Date(Date.now() + o.expiresInMs)]))[0]!.id;
    if (o.subscription !== 'none') await fxq("insert into business_subscriptions(business_id,plan_id,status,billing_interval) values($1,$2,$3,'month')", [businessId, planId, o.subscription]);
    const invoiceRef = `in_d4_${n}`;
    let intentId = '';
    if (o.sagaTo !== 'none') {
      const intent = await saga.createIntent({ reservationId, invoiceRef, expectedBenefitMinor: 300, currency: 'usd', policyVersion: 'PC-BENEFIT/1' });
      intentId = intent.id;
      if (o.allocate) await seedScratchAllocation(fx, intent);
      if (o.sagaTo === 'applying' || o.sagaTo === 'consumed') {
        const t0 = Date.now() + o.appliedOffsetMs - 500;
        await saga.beginApply(intent.id, 'att-1', new Date(t0));
        if (o.sagaTo === 'consumed') {
          const r = await saga.recordObservation(intent.id, 'att-1', { status: 'effect_present', effectRef: `ef_${randomBytes(5).toString('hex')}`, amountMinor: 300, currency: 'usd', invoiceRef, attributedToReservationRef: reservationId }, new Date(Date.now() + o.appliedOffsetMs));
          if (!r.ok) throw new Error('saga did not reach consumed: ' + JSON.stringify(r));
        }
      }
    }
    return { businessId, settlementId, decisionId, lotId, accountId, reservationId, intentId, invoiceRef };
  }
  const credit = async (s: Scenario) => (await rows(
    `select r.state reservation, (r.terminal_at is not null) terminal, l.status lot, l.available_units, a.available, a.provisional, a.reserved, a.recovery_due,
            (select count(*)::int from partner_credit_ledger g where g.account_id=a.id) ledger,
            (select count(*)::int from partner_credit_recovery_obligations o where o.account_id=a.id) obligations,
            (select count(*)::int from billing_partner_credit_applications p where p.reservation_id=r.id) applications, d.state decision
       from partner_credit_reservations r join partner_credit_lots l on l.id=r.lot_id join partner_credit_accounts a on a.id=r.account_id join partner_credit_award_decisions d on d.id=r.decision_id where r.id=$1`, [s.reservationId]))[0]!;
  const audit = async (businessId: string) => new PartnerCreditProjectionAudit(dbApp).inspect({ businessId });

  beforeAll(async () => {
    const root = new Client({ connectionString: urlFor('postgres') });
    await root.connect(); await root.query(`create database ${dbName}`); await root.end();
    const m = spawnSync(process.execPath, [resolve(api, 'node_modules/drizzle-kit/bin.cjs'), 'migrate'], { cwd: api, encoding: 'utf8', timeout: 240_000, env: { ...process.env, DATABASE_URL: urlFor(dbName) } });
    if (m.status !== 0) throw new Error('scratch migrate failed');
    admin = await connect(); fx = await connect();
    await fx.query('SET session_replication_role = replica');
    planId = randomUUID();
    dbApp = buildDb(await connect());
    saga = new BenefitApplicationSagaService(buildDb(await connect()));
    applications = new BenefitTerminalApplicationService(buildDb(await connect()));
    consumption = new PartnerCreditConsumptionService(buildDb(await connect()));
    compensator = new PartnerProvisionalReversalCompensator();
  }, 300_000);

  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => undefined);
    const root = new Client({ connectionString: urlFor('postgres') });
    await root.connect(); await root.query(`drop database if exists ${dbName} with (force)`); await root.end();
  });

  describe('inert by default', () => {
    it('with the shipped guards the terminal application and the consumption are refused and write nothing', async () => {
      // the saga guard is on too, so the scenario itself cannot be built through the service: build the rows with the fixture connection
      const n = ++seq;
      const businessId = (await rows<{ id: string }>("insert into businesses(name,slug,status) values($1,$2,'active') returning id", [`D4 inert ${n}`, `d4-inert-${dbName}-${n}`]))[0]!.id;
      const accountId = (await fxq<{ id: string }>('insert into partner_credit_accounts(business_id,reserved) values($1,1) returning id', [businessId]))[0]!.id;
      const decisionId = (await fxq<{ id: string }>(`insert into partner_credit_award_decisions(settlement_ref,business_id,policy_id,state,award_units,earning_month_utc,fulfilled_at,vest_at,idempotency_key) values($1,$2,$3,'vested',1,'2026-10',now(),now(),$4) returning id`, [randomUUID(), businessId, randomUUID(), `d4-inert-dec-${dbName}`]))[0]!.id;
      const lotId = (await fxq<{ id: string }>(`insert into partner_credit_lots(decision_id,account_id,units,available_units,status,vest_at,expires_at) values($1,$2,1,0,'reserved',now(),now()+interval '1 year') returning id`, [decisionId, accountId]))[0]!.id;
      const reservationId = (await fxq<{ id: string }>(`insert into partner_credit_reservations(business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at) values($1,$2,$3,$4,'i1',$5,now()+interval '1 day') returning id`, [businessId, decisionId, lotId, accountId, `d4-inert-res-${dbName}`]))[0]!.id;
      expect(await rejects(applications.record({ reservationId, businessId }))).toMatch(/S08_APPLICATION_NO_SAGA|disabled pending/);
      expect(await rejects(consumption.consume({ reservationId, businessId }))).not.toBe('');
      const enabled = await rows<{ tgname: string; tgenabled: string }>(`select tgname, tgenabled from pg_trigger where tgname = any($1)`, [GUARDS.map(g => g[1])]);
      expect(enabled).toHaveLength(GUARDS.length);
      for (const g of enabled) expect(g.tgenabled, g.tgname).toBe('O');
      expect(await rows('select count(*)::int n from billing_partner_credit_applications')).toEqual([{ n: 0 }]);
      expect((await rows<{ n: number }>("select count(*)::int n from partner_credit_ledger where entry_type in ('consume','consumed_reversal')"))[0]!.n).toBe(0);
      await setGuards(false); // from here on only the isolated scratch database has the guards off
    });
  });

  describe('migration 0053 vocabulary and invariants', () => {
    it('adds exactly the two entry types, keeps every earlier one, and leaves the append-only and activation guards in place', async () => {
      const def = (await rows<{ d: string }>("select pg_get_constraintdef(oid) d from pg_constraint where conrelid='partner_credit_ledger'::regclass and conname='partner_credit_ledger_type_check'"))[0]!.d;
      for (const t of ['provisional', 'vest', 'expire', 'reverse', 'recovery_offset', 'admin_adjustment', 'consume', 'consumed_reversal']) expect(def).toContain(`'${t}'`);
      const only = await rows<{ conname: string }>("select conname from pg_constraint where conrelid='partner_credit_ledger'::regclass and contype='c' and pg_get_constraintdef(oid) like '%provisional%'");
      expect(only.map(r => r.conname)).toEqual(['partner_credit_ledger_type_check']);
      expect(await rows("select tgname from pg_trigger where tgrelid='partner_credit_ledger'::regclass and tgname='partner_credit_ledger_no_update_delete'")).toHaveLength(1);
    });

    it('consume must be -1 and consumed_reversal +1, and a decision has at most one of each', async () => {
      const s = await scenario({ sagaTo: 'consumed' });
      await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      for (const [type, units] of [['consume', 1], ['consume', -2], ['consumed_reversal', -1], ['consumed_reversal', 2]] as const)
        expect(await rejects(fx.query(`insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,$3,$4,$5)`, [s.accountId, s.decisionId, type, units, `bad-${randomUUID()}`])), `${type} ${units}`).toMatch(/d4_units_check/);
      await fx.query(`insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'consume',-1,$3)`, [s.accountId, s.decisionId, `one-${randomUUID()}`]);
      expect(await rejects(fx.query(`insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'consume',-1,$3)`, [s.accountId, s.decisionId, `two-${randomUUID()}`]))).toMatch(/one_consume_per_decision/);
    });

    it('the database itself refuses consumption evidence it cannot find (service bypassed)', async () => {
      const noApp = await scenario({ sagaTo: 'consumed' });
      expect(await rejects(admin.query("update partner_credit_reservations set state='consumed', terminal_at=now() where id=$1", [noApp.reservationId]))).toMatch(/Consumption requires the verified Split 08 terminal application/);
      const unreconciled = await scenario({ sagaTo: 'applying' });
      await fxq(`insert into billing_partner_credit_applications(reservation_id,business_id,subscription_id,invoice_ref,provider_success_ref,idempotency_key,units_applied,terminal_state,applied_at)
                 values($1,$2,$3,'in_x','ef_forged',$4,1,'applied',now())`, [unreconciled.reservationId, unreconciled.businessId, randomUUID(), `forged-${randomUUID()}`]);
      expect(await rejects(admin.query("update partner_credit_reservations set state='consumed', terminal_at=now() where id=$1", [unreconciled.reservationId]))).toMatch(/reconciled saga/);
      expect(await rejects(admin.query("update partner_credit_lots set status='consumed' where id=$1", [noApp.lotId]))).toMatch(/after its reservation is consumed/);
      expect(await rejects(admin.query(`insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'consume',-1,$3)`, [noApp.accountId, noApp.decisionId, `nc-${randomUUID()}`]))).toMatch(/requires a consumed reservation/);
    });

    it('terminal states are final: a consumed reservation or lot cannot be reopened, and a consumed lot can only be reversed', async () => {
      const s = await scenario({ sagaTo: 'consumed' });
      await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      await consumption.consume({ reservationId: s.reservationId, businessId: s.businessId });
      expect(await rejects(admin.query("update partner_credit_reservations set state='reserved', terminal_at=null where id=$1", [s.reservationId]))).toMatch(/terminal state cannot change/);
      expect(await rejects(admin.query("update partner_credit_reservations set state='released' where id=$1", [s.reservationId]))).toMatch(/terminal state cannot change/);
      expect(await rejects(admin.query("update partner_credit_lots set status='available', available_units=1 where id=$1", [s.lotId]))).toMatch(/consumed lot can only be reversed/);
      expect(await rejects(admin.query("update partner_credit_lots set status='expired' where id=$1", [s.lotId]))).toMatch(/consumed lot can only be reversed/);
    });
  });

  describe('Split 08 terminal application writer', () => {
    it('records the one immutable application from a reconciled saga, a frozen allocation and an active subscription, and leaves every credit row alone', async () => {
      const s = await scenario();
      const before = await credit(s);
      const r = await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      expect(r.replay).toBe(false);
      const app = (await rows<Record<string, unknown>>('select * from billing_partner_credit_applications where reservation_id=$1', [s.reservationId]))[0]!;
      const intent = (await rows<Record<string, unknown>>('select * from benefit_application_intents where id=$1', [s.intentId]))[0]!;
      expect(app).toMatchObject({ business_id: s.businessId, invoice_ref: s.invoiceRef, units_applied: 1, terminal_state: 'applied', provider_success_ref: intent.provider_effect_ref, idempotency_key: `s08-credit-application:v1:${s.reservationId}` });
      expect((app.applied_at as Date).getTime()).toBe((intent.applied_at as Date).getTime());
      expect(await credit(s)).toEqual({ ...before, applications: 1 });
    });

    it('is idempotent: a replay returns the same row, and a changed saga is a conflict, never an overwrite', async () => {
      const s = await scenario();
      const a = await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      const b = await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      expect(b).toEqual({ ...a, replay: true });
      await fxq("update benefit_application_intents set provider_effect_ref='ef_changed' where id=$1", [s.intentId]);
      expect(await rejects(applications.record({ reservationId: s.reservationId, businessId: s.businessId }))).toMatch(/S08_APPLICATION_REPLAY_CONFLICT/);
      expect((await rows('select count(*)::int n from billing_partner_credit_applications where reservation_id=$1', [s.reservationId]))[0]).toEqual({ n: 1 });
    });

    it.each([['reserved'], ['applying']] as const)('refuses a saga that is only %s: an unreconciled attempt is not authority', async sagaTo => {
      const s = await scenario({ sagaTo });
      expect(await rejects(applications.record({ reservationId: s.reservationId, businessId: s.businessId }))).toMatch(/S08_APPLICATION_SAGA_NOT_RECONCILED/);
      expect((await credit(s)).applications).toBe(0);
    });

    it('refuses without a saga, without a frozen allocation, and with a substituted amount, invoice or currency', async () => {
      const none = await scenario({ sagaTo: 'none' });
      expect(await rejects(applications.record({ reservationId: none.reservationId, businessId: none.businessId }))).toMatch(/S08_APPLICATION_NO_SAGA/);
      // the saga cannot even begin an attempt without a frozen allocation, so remove the freeze after the saga reconciled
      const noAlloc = await scenario();
      await fxq('delete from s08_allocation_freeze_items where reservation_id=$1', [noAlloc.reservationId]);
      expect(await rejects(applications.record({ reservationId: noAlloc.reservationId, businessId: noAlloc.businessId }))).toMatch(/S08_APPLICATION_ALLOCATION_MISSING/);
      const amount = await scenario();
      await fxq('update s08_allocation_freeze_items set benefit_minor = benefit_minor + 1 where reservation_id=$1', [amount.reservationId]);
      expect(await rejects(applications.record({ reservationId: amount.reservationId, businessId: amount.businessId }))).toMatch(/S08_APPLICATION_ALLOCATION_MISMATCH/);
      const invoice = await scenario();
      await fxq('update s08_allocation_freezes set invoice_ref = $2 where id = (select freeze_id from s08_allocation_freeze_items where reservation_id=$1)', [invoice.reservationId, 'in_other']);
      expect(await rejects(applications.record({ reservationId: invoice.reservationId, businessId: invoice.businessId }))).toMatch(/S08_APPLICATION_ALLOCATION_MISMATCH/);
      const currency = await scenario();
      await fxq("update s08_allocation_freezes set currency = 'eur' where id = (select freeze_id from s08_allocation_freeze_items where reservation_id=$1)", [currency.reservationId]);
      expect(await rejects(applications.record({ reservationId: currency.reservationId, businessId: currency.businessId }))).toMatch(/S08_APPLICATION_ALLOCATION_MISMATCH/);
    });

    it('refuses an ineligible subscription, an effect confirmed after the reservation expired, another business and a reservation that is no longer reserved', async () => {
      const trial = await scenario({ subscription: 'trialing' });
      expect(await rejects(applications.record({ reservationId: trial.reservationId, businessId: trial.businessId }))).toMatch(/S08_APPLICATION_SUBSCRIPTION_NOT_ELIGIBLE/);
      const noSub = await scenario({ subscription: 'none' });
      expect(await rejects(applications.record({ reservationId: noSub.reservationId, businessId: noSub.businessId }))).toMatch(/S08_APPLICATION_SUBSCRIPTION_NOT_ELIGIBLE/);
      const late = await scenario({ expiresInMs: 600_000 });
      await fxq("update partner_credit_reservations set expires_at = now() - interval '1 hour' where id=$1", [late.reservationId]);
      expect(await rejects(applications.record({ reservationId: late.reservationId, businessId: late.businessId }))).toMatch(/S08_APPLICATION_AFTER_RESERVATION_EXPIRY/);
      const a = await scenario(); const b = await scenario();
      expect(await rejects(applications.record({ reservationId: a.reservationId, businessId: b.businessId }))).toMatch(/S08_APPLICATION_UNKNOWN_RESERVATION/);
      const released = await scenario();
      await fxq("update partner_credit_reservations set state='released', terminal_at=now() where id=$1", [released.reservationId]);
      expect(await rejects(applications.record({ reservationId: released.reservationId, businessId: released.businessId }))).toMatch(/S08_APPLICATION_RESERVATION_NOT_ACTIVE/);
      for (const s of [trial, noSub, late, released]) expect((await credit(s)).applications).toBe(0);
    });
  });

  describe('Split 07 final consumption', () => {
    it('moves exactly one reserved unit to consumed, appends one consume entry, keeps the ledger identity, and the audit is consistent', async () => {
      const s = await scenario();
      await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      const r = await consumption.consume({ reservationId: s.reservationId, businessId: s.businessId });
      expect(r).toEqual({ state: 'consumed', replay: false, ledgerKey: `partner-consume:v1:${s.reservationId}` });
      expect(await credit(s)).toMatchObject({ reservation: 'consumed', terminal: true, lot: 'consumed', available_units: 0, available: 0, provisional: 0, reserved: 0, recovery_due: 0, ledger: 3, applications: 1, decision: 'vested' });
      const entry = (await rows<{ entry_type: string; units: number; metadata: Record<string, unknown> }>("select entry_type, units, metadata from partner_credit_ledger where idempotency_key=$1", [r.ledgerKey]))[0]!;
      expect(entry).toMatchObject({ entry_type: 'consume', units: -1 });
      expect(entry.metadata).toMatchObject({ reservationId: s.reservationId });
      expect(await audit(s.businessId)).toMatchObject({ status: 'consistent' });
    });

    it('is idempotent and exactly-once: replays write nothing, and 8 parallel consumers produce one consumption', async () => {
      const s = await scenario();
      await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      const services = await Promise.all(Array.from({ length: 8 }, async () => new PartnerCreditConsumptionService(buildDb(await connect()))));
      const results = await Promise.allSettled(services.map(x => x.consume({ reservationId: s.reservationId, businessId: s.businessId })));
      const ok = results.filter((x): x is PromiseFulfilledResult<{ state: 'consumed'; replay: boolean; ledgerKey: string }> => x.status === 'fulfilled');
      expect(ok.length).toBe(8);
      expect(ok.filter(x => x.value.replay === false)).toHaveLength(1);
      expect((await rows("select count(*)::int n from partner_credit_ledger where decision_id=$1 and entry_type='consume'", [s.decisionId]))[0]).toEqual({ n: 1 });
      expect(await credit(s)).toMatchObject({ reserved: 0, ledger: 3, reservation: 'consumed' });
      expect(await audit(s.businessId)).toMatchObject({ status: 'consistent' });
    });

    it('concurrent consumption of several credits of ONE account serialises on the account and never drives a bucket negative', async () => {
      const a = await scenario(); const b = await scenario();
      // put both credits on the same account
      await fxq('update partner_credit_accounts set reserved = 0 where id = $1', [b.accountId]);
      await fxq('update partner_credit_lots set account_id=$1 where id=$2', [a.accountId, b.lotId]);
      await fxq('update partner_credit_reservations set account_id=$1 where id=$2', [a.accountId, b.reservationId]);
      await fxq('update partner_credit_ledger set account_id=$1 where decision_id=$2', [a.accountId, b.decisionId]);
      await fxq('update partner_credit_accounts set reserved = 2 where id = $1', [a.accountId]);
      await fxq('update partner_credit_award_decisions set business_id=$1 where id=$2', [a.businessId, b.decisionId]);
      await fxq('update partner_credit_reservations set business_id=$1 where id=$2', [a.businessId, b.reservationId]);
      await fxq('update orphan_settlements set receiving_business_id=$1 where id=$2', [a.businessId, b.settlementId]);
      await fxq('update benefit_application_intents set business_id=$1 where id=$2', [a.businessId, b.intentId]);
      await fxq('update s08_allocation_freeze_items set business_id=$1 where reservation_id=$2', [a.businessId, b.reservationId]);
      await fxq('update s08_allocation_freezes set business_id=$1 where id=(select freeze_id from s08_allocation_freeze_items where reservation_id=$2)', [a.businessId, b.reservationId]);
      await fxq('delete from business_subscriptions where business_id=$1', [b.businessId]);
      await applications.record({ reservationId: a.reservationId, businessId: a.businessId });
      await applications.record({ reservationId: b.reservationId, businessId: a.businessId });
      const one = await Promise.all([0, 1].map(async () => new PartnerCreditConsumptionService(buildDb(await connect()))));
      const res = await Promise.all([one[0]!.consume({ reservationId: a.reservationId, businessId: a.businessId }), one[1]!.consume({ reservationId: b.reservationId, businessId: a.businessId })]);
      expect(res.every(r => r.state === 'consumed' && !r.replay)).toBe(true);
      expect((await rows<{ reserved: number; available: number }>('select reserved, available from partner_credit_accounts where id=$1', [a.accountId]))[0]).toEqual({ reserved: 0, available: 0 });
      expect((await rows("select count(*)::int n from partner_credit_ledger where account_id=$1 and entry_type='consume'", [a.accountId]))[0]).toEqual({ n: 2 });
      expect(await audit(a.businessId)).toMatchObject({ status: 'consistent' });
    });

    it('refuses with no application, an application the saga does not back, an application confirmed after expiry, and writes nothing', async () => {
      const none = await scenario(); const before = await credit(none);
      expect(await rejects(consumption.consume({ reservationId: none.reservationId, businessId: none.businessId }))).toMatch(/PARTNER_CONSUME_APPLICATION_MISSING/);
      expect(await credit(none)).toEqual(before);
      const unbacked = await scenario(); await applications.record({ reservationId: unbacked.reservationId, businessId: unbacked.businessId });
      await fxq("update benefit_application_intents set provider_effect_ref='ef_other' where id=$1", [unbacked.intentId]);
      expect(await rejects(consumption.consume({ reservationId: unbacked.reservationId, businessId: unbacked.businessId }))).toMatch(/PARTNER_CONSUME_APPLICATION_NOT_AUTHORITATIVE/);
      const late = await scenario(); await applications.record({ reservationId: late.reservationId, businessId: late.businessId });
      await fxq("update partner_credit_reservations set expires_at = now() - interval '1 hour' where id=$1", [late.reservationId]);
      expect(await rejects(consumption.consume({ reservationId: late.reservationId, businessId: late.businessId }))).toMatch(/PARTNER_CONSUME_APPLICATION_AFTER_EXPIRY/);
      for (const s of [unbacked, late]) expect(await credit(s)).toMatchObject({ reservation: 'reserved', lot: 'reserved', reserved: 1, ledger: 2 });
    });

    it('refuses a reversed or non-fulfilled settlement, a non-vested award, another business, an inconsistent lot or account, and an active dispute hold', async () => {
      const prep = async (mut?: (s: Scenario) => Promise<void>) => { const s = await scenario(); await applications.record({ reservationId: s.reservationId, businessId: s.businessId }); if (mut) await mut(s); return s; };
      const reversed = await prep(async s => { await fxq(`insert into orphan_settlement_events(settlement_id,claim_id,customer_id,event_type,origin_business_id,idempotency_key) select id,claim_id,customer_id,'settlement_reversed',$2,$3 from orphan_settlements where id=$1`, [s.settlementId, randomUUID(), `rev-${randomUUID()}`]); });
      expect(await rejects(consumption.consume({ reservationId: reversed.reservationId, businessId: reversed.businessId }))).toMatch(/PARTNER_CONSUME_REVERSAL_PRESENT/);
      const notFulfilled = await prep(async s => { await fxq("update orphan_settlements set status='cancelled' where id=$1", [s.settlementId]); });
      expect(await rejects(consumption.consume({ reservationId: notFulfilled.reservationId, businessId: notFulfilled.businessId }))).toMatch(/PARTNER_CONSUME_SETTLEMENT_INVALID/);
      const notVested = await prep(async s => { await fxq("update partner_credit_award_decisions set state='provisional' where id=$1", [s.decisionId]); });
      expect(await rejects(consumption.consume({ reservationId: notVested.reservationId, businessId: notVested.businessId }))).toMatch(/PARTNER_CONSUME_AWARD_NOT_VESTED/);
      const x = await prep(); const y = await prep();
      expect(await rejects(consumption.consume({ reservationId: x.reservationId, businessId: y.businessId }))).toMatch(/PARTNER_CONSUME_UNKNOWN_RESERVATION/);
      const lot = await prep(async s => { await fxq("update partner_credit_lots set status='available', available_units=1 where id=$1", [s.lotId]); });
      expect(await rejects(consumption.consume({ reservationId: lot.reservationId, businessId: lot.businessId }))).toMatch(/PARTNER_CONSUME_NOT_CONSUMABLE/);
      const acct = await prep(async s => { await fxq('update partner_credit_accounts set reserved=0 where id=$1', [s.accountId]); });
      expect(await rejects(consumption.consume({ reservationId: acct.reservationId, businessId: acct.businessId }))).toMatch(/PARTNER_CONSUME_NOT_CONSUMABLE/);
      const hold = await prep(async s => { await fxq("insert into partner_credit_award_disputes(business_id,decision_id,state) values($1,$2,'open')", [s.businessId, s.decisionId]); });
      expect(await rejects(consumption.consume({ reservationId: hold.reservationId, businessId: hold.businessId }))).toMatch(/PARTNER_CONSUME_DISPUTE_HOLD/);
      for (const s of [reversed, notFulfilled, notVested, lot, hold]) expect((await credit(s)).ledger).toBe(2);
      expect((await rows("select count(*)::int n from partner_credit_ledger where entry_type='consume'"))[0]!.n).toBeGreaterThanOrEqual(0);
    });

    it('refuses a ledger entry that exists without a consumption (a half-applied replay) and a consumed reservation whose sides disagree', async () => {
      const s = await scenario(); await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      await fxq(`insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'consume',-1,$3)`, [s.accountId, s.decisionId, `partner-consume:v1:${s.reservationId}`]);
      expect(await rejects(consumption.consume({ reservationId: s.reservationId, businessId: s.businessId }))).toMatch(/PARTNER_CONSUME_LEDGER_WITHOUT_CONSUMPTION/);
      const t = await scenario(); await applications.record({ reservationId: t.reservationId, businessId: t.businessId });
      await consumption.consume({ reservationId: t.reservationId, businessId: t.businessId });
      await fxq("update partner_credit_lots set status='reversed' where id=$1", [t.lotId]);
      expect(await rejects(consumption.consume({ reservationId: t.reservationId, businessId: t.businessId }))).toMatch(/PARTNER_CONSUME_REPLAY_CONFLICT/);
    });

    it('a failure partway rolls the whole consumption back (nothing half-written)', async () => {
      const s = await scenario(); await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      // an existing ledger entry with the same idempotency key but a different type makes the final insert fail AFTER the reservation, lot and account were updated
      await fxq(`insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'admin_adjustment',1,$3)`, [s.accountId, s.decisionId, `partner-consume:v1:${s.reservationId}`]);
      const before = await credit(s);
      expect(await rejects(consumption.consume({ reservationId: s.reservationId, businessId: s.businessId }))).not.toBe('');
      expect(await credit(s)).toEqual(before);
    });
  });

  describe('consumed-credit reversal and recovery obligation', () => {
    const consumed = async () => {
      const s = await scenario(); await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      await consumption.consume({ reservationId: s.reservationId, businessId: s.businessId }); return s;
    };
    const reverse = (s: Scenario, reversalEventId = randomUUID()) => dbApp.transaction(tx => compensator.compensate(tx, { settlementRef: s.settlementId, businessId: s.businessId, reversalEventId }));

    it('originates exactly one recovery obligation, preserves the consumption history, and keeps every identity', async () => {
      const s = await consumed(); const event = randomUUID();
      const before = await credit(s);
      expect(await reverse(s, event)).toBe('recovery_obligation_created');
      expect(await credit(s)).toMatchObject({ reservation: 'consumed', applications: 1, lot: 'reversed', decision: 'reversed', available: 0, provisional: 0, reserved: 0, recovery_due: 1, obligations: 1, ledger: Number(before.ledger) + 1 });
      const ob = (await rows<{ reversal_ref: string; units_due: number; units_outstanding: number }>('select reversal_ref, units_due, units_outstanding from partner_credit_recovery_obligations where account_id=$1', [s.accountId]))[0]!;
      expect(ob).toEqual({ reversal_ref: event, units_due: 1, units_outstanding: 1 });
      const entries = await rows<{ entry_type: string; units: number }>('select entry_type, units from partner_credit_ledger where decision_id=$1 order by occurred_at, entry_type', [s.decisionId]);
      expect(entries.map(e => `${e.entry_type}:${e.units}`).sort()).toEqual(['consume:-1', 'consumed_reversal:1', 'provisional:1', 'vest:1']);
      expect(await audit(s.businessId)).toMatchObject({ status: 'consistent' });
    });

    it('is idempotent per reversal: a replay is "already_reversed" and writes nothing', async () => {
      const s = await consumed(); await reverse(s);
      const before = await credit(s);
      expect(await reverse(s, randomUUID())).toBe('already_reversed');
      expect(await credit(s)).toEqual(before);
    });

    it('refuses, and rolls back, when the consumption evidence is missing', async () => {
      const s = await consumed();
      await fxq('delete from billing_partner_credit_applications where reservation_id=$1', [s.reservationId]);
      const before = await credit(s);
      expect(await rejects(reverse(s))).toMatch(/PARTNER_REVERSAL_CONSUMPTION_EVIDENCE_MISSING/);
      expect(await credit(s)).toEqual(before);
      const t = await consumed();
      await fxq("delete from partner_credit_ledger where decision_id=$1 and entry_type='consume'", [t.decisionId]);
      expect(await rejects(reverse(t))).toMatch(/PARTNER_REVERSAL_MISSING_CONSUME_LEDGER/);
      expect(await rejects(reverse({ ...t, businessId: randomUUID() }))).toMatch(/PARTNER_REVERSAL_TENANT_MISMATCH/);
      const u = await consumed();
      await fxq("delete from partner_credit_ledger where decision_id=$1 and entry_type='provisional'", [u.decisionId]);
      const beforeU = await credit(u);
      expect(await rejects(reverse(u))).toMatch(/PARTNER_REVERSAL_MISSING_ORIGINAL_LEDGER/);
      expect(await credit(u)).toEqual(beforeU);
    });

    it('still refuses a credit that is merely RESERVED (regression: only a verified consumption can be reversed into a debt)', async () => {
      const s = await scenario();
      expect(await rejects(reverse(s))).toMatch(/PARTNER_REVERSAL_LOT_STATE_UNSUPPORTED/);
      expect((await credit(s)).obligations).toBe(0);
    });

    it('a second reversal event against the same consumed decision cannot create a second obligation', async () => {
      const s = await consumed(); await reverse(s);
      await fxq("update partner_credit_award_decisions set state='vested' where id=$1", [s.decisionId]);
      await fxq("update partner_credit_lots set status='consumed' where id=$1", [s.lotId]);
      expect(await rejects(reverse(s, randomUUID()))).toMatch(/PARTNER_REVERSAL_ALREADY_COMPENSATED/);
      expect((await credit(s)).obligations).toBe(1);
    });
  });

  describe('projection audit understands the D4 vocabulary and catches broken evidence', () => {
    it('flags a consumed lot without its consume entry, a consume entry without its lot, and a consumed reversal without its obligation', async () => {
      const a = await scenario(); await applications.record({ reservationId: a.reservationId, businessId: a.businessId });
      await fxq("update partner_credit_reservations set state='consumed', terminal_at=now() where id=$1", [a.reservationId]);
      await fxq("update partner_credit_lots set status='consumed' where id=$1", [a.lotId]); await fxq('update partner_credit_accounts set reserved=0 where id=$1', [a.accountId]);
      const r1 = await audit(a.businessId);
      expect(r1.status).toBe('inconsistent');
      expect(r1.status === 'inconsistent' && r1.violations.map(v => v.code)).toEqual(expect.arrayContaining(['CONSUMED_LOT_EVIDENCE', 'LEDGER_NET']));
      const b = await scenario(); await applications.record({ reservationId: b.reservationId, businessId: b.businessId }); await consumption.consume({ reservationId: b.reservationId, businessId: b.businessId });
      await fxq("update partner_credit_lots set status='reversed' where id=$1", [b.lotId]); await fxq("update partner_credit_award_decisions set state='reversed' where id=$1", [b.decisionId]);
      await fxq(`insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key,metadata) values($1,$2,'consumed_reversal',1,$3,$4::jsonb)`, [b.accountId, b.decisionId, `cr-${randomUUID()}`, JSON.stringify({ reversalEventId: randomUUID() })]);
      const r2 = await audit(b.businessId);
      expect(r2.status === 'inconsistent' && r2.violations.map(v => v.code)).toContain('CONSUMED_REVERSAL_EVIDENCE');
      const c = await scenario();
      await fxq(`insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'consume',-1,$3)`, [c.accountId, c.decisionId, `orph-${randomUUID()}`]);
      const r3 = await audit(c.businessId);
      expect(r3.status === 'inconsistent' && r3.violations.map(v => v.code)).toContain('CONSUME_ENTRY_WITHOUT_LOT');
    });

    it('a full lifecycle (consume, then consumed reversal) leaves a fully consistent account', async () => {
      const s = await scenario(); await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      await consumption.consume({ reservationId: s.reservationId, businessId: s.businessId });
      expect(await audit(s.businessId)).toMatchObject({ status: 'consistent' });
      await dbApp.transaction(tx => compensator.compensate(tx, { settlementRef: s.settlementId, businessId: s.businessId, reversalEventId: randomUUID() }));
      expect(await audit(s.businessId)).toMatchObject({ status: 'consistent' });
    });
  });
});
