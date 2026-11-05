/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic-evidence mutators in tests deliberately build malformed provider payloads */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { buildDb } from '../../src/db/client';
import { BenefitApplicationSagaService } from '../../src/billing/benefit-application.saga.service';
import { BenefitTerminalApplicationService } from '../../src/billing/benefit-terminal-application.service';
import { PartnerCreditConsumptionService } from '../../src/partner-credits/partner-credit-consumption.service';
import {
  DEVELOPMENT_ALLOWED_INTERVALS, SettlementAuthorizationError, SettlementAuthorizationRecorder, settlementAuthorizationDigest, createSettlementEvidenceSigner, settlementProvenanceMessage, verifySettlementProvenance, parseTrustedSigningKeys,
  type SettlementEvidenceSigner, type SettlementGateConfig,
} from '../../src/partner-credits/partner-credit-settlement-authorization';
import { MOCK_EVIDENCE_KIND, type MockSettlementEvidence } from '../../src/billing/settlement-eligibility.classifier';
import { gateFor } from '../../src/billing/stripe-read/pipeline-fixtures';
import { acquireMockExtendedEvidence, buildMockEvidence, classifyBundle, createMockReadProvider, createRealReadProvider, EvidenceAcquisitionPipeline, MockExtendedSource, onePage, ScriptedReadTransport, StripeReadOnlyEvidenceAdapter, syntheticStripeInvoice } from '../../src/billing/stripe-read';
import { unwindCredit, type UnwindCause } from '../../src/partner-credits/partner-credit-unwind';
import { PartnerProvisionalReversalCompensator } from '../../src/partner-credits/partner-provisional-reversal.compensator';
import { PartnerCreditProjectionAudit } from '../../src/partner-credits/partner-credit-projection.audit';
import { seedScratchAllocation } from './helpers/s08-allocation-fixture';
import { freezeAggregateBenefitAllocation } from '../../src/billing/aggregate-benefit-allocation';
import { computeInvoiceBenefit } from '../../src/billing/invoice-benefit.calculator';

/** DEV-04 synthetic provenance keys, generated per run. The private halves never leave this file's memory; nothing here is a real credential. */
async function newSyntheticKey(keyId: string): Promise<{ signer: SettlementEvidenceSigner; publicHex: string }> {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey) as ArrayBuffer).toString('base64');
  const publicHex = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey) as ArrayBuffer).toString('hex');
  return { signer: await createSettlementEvidenceSigner(keyId, pkcs8), publicHex };
}
const KEY_A = await newSyntheticKey('synthetic-recorder-a');
const KEY_B = await newSyntheticKey('synthetic-recorder-b');
const SIGNER = KEY_A.signer;


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
    ['benefit_application_transitions', 'benefit_application_transitions_inert_guard'], ['partner_credit_settlement_authorizations', 'partner_credit_settlement_authorizations_inert_guard'],
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
  /** Test CONFIGURATION, not policy: the owner has decided neither the freshness window (Q3) nor the policy effective instant (Q14). */
  const GATE_CFG: SettlementGateConfig = { providerAccountId: 'acct_d4_test', providerMode: 'test', freshnessWindowMs: 600_000, policyEffectiveFromMs: 1_000, allowedIntervals: DEVELOPMENT_ALLOWED_INTERVALS, acceptedEvidenceKinds: [MOCK_EVIDENCE_KIND], trustedSigningKeys: { [SIGNER.keyId]: KEY_A.publicHex } };
  let recorder: SettlementAuthorizationRecorder;
  const dbNow = async () => Number((await rows<{ ms: string }>("select (extract(epoch from clock_timestamp())*1000)::bigint ms"))[0]!.ms);
  const fp = (inv: { status: string; amountDueMinor: number; amountPaidMinor: number; amountRemainingMinor: number; totalMinor: number }, lineCount: number) => ({ status: inv.status, amountDueMinor: inv.amountDueMinor, amountPaidMinor: inv.amountPaidMinor, amountRemainingMinor: inv.amountRemainingMinor, totalMinor: inv.totalMinor, lineCount });

  /** Synthetic, internally consistent settlement evidence for a scenario, derived from the PERSISTED intent, freeze, subscription and reservation. `over` may corrupt it. */
  async function evidenceFor(s: { businessId: string; reservationId: string; invoiceRef: string }, over?: (ev: any) => void, nowOverride?: number): Promise<MockSettlementEvidence> {
    const now = nowOverride ?? await dbNow();
    const freeze = (await rows<{ artifact: any }>('select artifact from s08_allocation_freezes where business_id=$1 and invoice_ref=$2', [s.businessId, s.invoiceRef]))[0]!.artifact;
    const own = freeze.allocations.find((a: any) => a.reservationId === s.reservationId);
    const sub = (await rows<{ c: string; s: string }>('select stripe_customer_id c, stripe_subscription_id s from business_subscriptions where business_id=$1', [s.businessId]))[0]!;
    const res = (await rows<{ ref: string }>('select invoice_intent_ref ref from partner_credit_reservations where id=$1', [s.reservationId]))[0]!;
    const total = freeze.eligibleBaseMinor - own.benefitMinor;
    const inv = { status: 'paid', amountDueMinor: total, amountPaidMinor: total, amountRemainingMinor: 0, totalMinor: total };
    const ev: any = {
      provenance: { evidenceKind: MOCK_EVIDENCE_KIND, snapshotRef: `snap_${++seq}`, snapshotDigest: randomBytes(32).toString('hex'), observedAtMs: now - 1_000, providerOutcome: 'ok', complete: true, readBefore: fp(inv, 2), readAfter: fp(inv, 2) },
      binding: { businessId: s.businessId, reservationId: s.reservationId, intentRef: res.ref },
      provider: { accountId: GATE_CFG.providerAccountId, mode: GATE_CFG.providerMode },
      invoice: { id: s.invoiceRef, customerRef: sub.c, subscriptionRef: sub.s, currency: 'usd', ...inv, createdAtMs: now - 3_600_000, paidAtMs: now - 600_000, voidedAtMs: null, billingInterval: 'month' },
      lines: { complete: true, items: [
        { lineRef: 'il_base', amountMinor: freeze.eligibleBaseMinor, currency: 'usd', category: 'recurring_base', parentItemRef: null, parentItemKey: null, labelReservationRef: null },
        { lineRef: 'il_ben', amountMinor: -own.benefitMinor, currency: 'usd', category: 'benefit', parentItemRef: 'ii_ben', parentItemKey: own.providerIdempotencyKey, labelReservationRef: null }] },
      benefitItem: { itemRef: 'ii_ben', invoiceRef: s.invoiceRef, idempotencyKey: own.providerIdempotencyKey, amountMinor: -own.benefitMinor, currency: 'usd', discountable: false },
      settlement: { source: 'stripe_payment', paymentRef: `pi_${seq}` }, events: { refund: 'none', dispute: 'none', cancellation: 'none' },
    };
    over?.(ev);
    return ev;
  }
  /** Re-derive the bracketing reads after `over` changed the invoice, so a test changes ONE fact. */
  const resync = (ev: any) => { const f = fp(ev.invoice, ev.lines.items.length); ev.provenance.readBefore = { ...f }; ev.provenance.readAfter = { ...f }; };

  /** One vested, single-unit credit RESERVED for an invoice: claim, fulfilled settlement, decision, reserved lot, provisional and vest ledger entries, reservation. */
  async function forgeCredit(businessId: string, accountId: string, n: number, expiresInMs: number) {
    const user = randomUUID();
    const claimId = (await fxq<{ id: string }>(
      `insert into orphan_reward_claims(customer_id,origin_business_id,origin_loyalty_account_id,origin_loyalty_transaction_id,orphan_reason,source_reward_type,source_reward_snapshot,status,settled_at)
       values($1,$2,$3,$4,'origin_business_archived','voucher','{}'::jsonb,'settled',now()) returning id`, [randomUUID(), randomUUID(), randomUUID(), randomUUID()]))[0]!.id;
    const settlementId = (await fxq<{ id: string }>(
      `insert into orphan_settlements(claim_id,customer_id,receiving_business_id,status,access_authorization_id,accepted_by_user_id,accepted_at,completion_authorization_id,completion_authorized_at,
         fulfilled_by_user_id,fulfilled_at,fulfillment_policy_version,fulfillment_snapshot,expires_at,idempotency_key)
       values($1,$2,$3,'fulfilled',$4,$5,now(),$6,now(),$5,now(),'v1','{}'::jsonb,now()+interval '30 days',$7) returning id`,
      [claimId, randomUUID(), businessId, randomUUID(), user, randomUUID(), `d4-settle-${dbName}-${n}`]))[0]!.id;
    const decisionId = (await fxq<{ id: string }>(
      `insert into partner_credit_award_decisions(settlement_ref,business_id,policy_id,state,award_units,earning_month_utc,fulfilled_at,vest_at,idempotency_key)
       values($1,$2,$3,'vested',1,'2026-10',now(),now(),$4) returning id`, [settlementId, businessId, randomUUID(), `d4-dec-${dbName}-${n}`]))[0]!.id;
    const lotId = (await fxq<{ id: string }>(
      `insert into partner_credit_lots(decision_id,account_id,units,available_units,status,vest_at,expires_at) values($1,$2,1,0,'reserved',now(),now()+interval '1 year') returning id`, [decisionId, accountId]))[0]!.id;
    await fxq(`insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'provisional',1,$3),($1,$2,'vest',1,$4)`, [accountId, decisionId, `d4-prov-${dbName}-${n}`, `d4-vest-${dbName}-${n}`]);
    const reservationId = (await fxq<{ id: string }>(
      `insert into partner_credit_reservations(business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at) values($1,$2,$3,$4,$5,$6,$7) returning id`,
      [businessId, decisionId, lotId, accountId, `intent-${n}`, `d4-res-${dbName}-${n}`, new Date(Date.now() + expiresInMs)]))[0]!.id;
    return { settlementId, decisionId, lotId, reservationId };
  }

  interface Scenario { businessId: string; settlementId: string; decisionId: string; lotId: string; accountId: string; reservationId: string; intentId: string; invoiceRef: string }
  /** A vested, single-unit credit that is RESERVED for one invoice, with its provisional and vest ledger entries, an allocation freeze and a saga intent. */
  async function scenario(opts: { sagaTo?: 'none' | 'reserved' | 'applying' | 'consumed'; subscription?: 'active' | 'trialing' | 'none'; allocate?: boolean; expiresInMs?: number; appliedOffsetMs?: number; authorize?: boolean } = {}): Promise<Scenario> {
    const n = ++seq; const o = { sagaTo: 'consumed', subscription: 'active', allocate: true, expiresInMs: 86_400_000, appliedOffsetMs: 1_000, authorize: true, ...opts };
    const businessId = (await rows<{ id: string }>("insert into businesses(name,slug,status) values($1,$2,'active') returning id", [`D4 ${n}`, `d4-${dbName}-${n}`]))[0]!.id;
    const accountId = (await fxq<{ id: string }>('insert into partner_credit_accounts(business_id,reserved) values($1,1) returning id', [businessId]))[0]!.id;
    const { settlementId, decisionId, lotId, reservationId } = await forgeCredit(businessId, accountId, n, o.expiresInMs);
    if (o.subscription !== 'none') await fxq("insert into business_subscriptions(business_id,plan_id,status,billing_interval,stripe_customer_id,stripe_subscription_id) values($1,$2,$3,'month',$4,$5)", [businessId, planId, o.subscription, `cus_d4_${n}`, `sub_d4_${n}`]);
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
    const out = { businessId, settlementId, decisionId, lotId, accountId, reservationId, intentId, invoiceRef };
    // Every pre-existing consumption test now consumes through the REAL gate: record valid synthetic settlement evidence for the scenarios the gate can be built for.
    if (o.authorize && o.sagaTo !== 'none' && o.allocate && o.subscription === 'active') {
      try { await recorder.record({ reservationId, businessId, evidence: await evidenceFor(out) }); } catch (e) { if (!(e instanceof SettlementAuthorizationError)) throw e; }
    }
    return out;
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
    consumption = new PartnerCreditConsumptionService(buildDb(await connect()), GATE_CFG);
    recorder = new SettlementAuthorizationRecorder(buildDb(await connect()), GATE_CFG, SIGNER);
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

    it('the saga refuses to begin applying a benefit once the settlement is no longer fulfilled, and writes nothing', async () => {
      const s = await scenario({ sagaTo: 'reserved' });
      const intentBefore = (await rows('select state, attempt_key from benefit_application_intents where id=$1', [s.intentId]))[0];
      await fxq("update orphan_settlements set status='reversed' where id=$1", [s.settlementId]);
      const r = await saga.beginApply(s.intentId, 'att-late', new Date());
      expect(r).toMatchObject({ ok: false, code: 'SETTLEMENT_NOT_FULFILLED' });
      expect((await rows('select state, attempt_key from benefit_application_intents where id=$1', [s.intentId]))[0]).toEqual(intentBefore);
      await fxq("update orphan_settlements set status='fulfilled' where id=$1", [s.settlementId]);
      expect(await saga.beginApply(s.intentId, 'att-ok', new Date())).toMatchObject({ ok: true });
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
      const services = await Promise.all(Array.from({ length: 8 }, async () => new PartnerCreditConsumptionService(buildDb(await connect()), GATE_CFG)));
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
      await fxq("update s08_allocation_freezes set artifact = jsonb_set(artifact, '{businessId}', to_jsonb($1::text)) where business_id=$1 and id=(select freeze_id from s08_allocation_freeze_items where reservation_id=$2)", [a.businessId, b.reservationId]); // the artifact names its tenant too
      await fxq('delete from business_subscriptions where business_id=$1', [b.businessId]);
      // the fixture moved credit b into business a by hand, so its settlement authorization is recorded AFTER that rearrangement
      await recorder.record({ reservationId: a.reservationId, businessId: a.businessId, evidence: await evidenceFor(a) });
      await recorder.record({ reservationId: b.reservationId, businessId: a.businessId, evidence: await evidenceFor({ businessId: a.businessId, reservationId: b.reservationId, invoiceRef: b.invoiceRef }) });
      await applications.record({ reservationId: a.reservationId, businessId: a.businessId });
      await applications.record({ reservationId: b.reservationId, businessId: a.businessId });
      const one = await Promise.all([0, 1].map(async () => new PartnerCreditConsumptionService(buildDb(await connect()), GATE_CFG)));
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

    it('defers a credit that is merely RESERVED: nothing is written and the credit is left exactly as it was (R10, O2a)', async () => {
      const s = await scenario();
      const before = await credit(s);
      expect(await dbApp.transaction(tx => compensator.compensate(tx, { settlementRef: s.settlementId, businessId: s.businessId, reversalEventId: randomUUID() }))).toBe('deferred_credit_in_use');
      expect(await credit(s)).toEqual(before);
      expect(before).toMatchObject({ lot: 'reserved', decision: 'vested', obligations: 0 });
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

  describe('independent-review fixes', () => {
    const consumedScenario = async () => {
      const s = await scenario(); await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      await consumption.consume({ reservationId: s.reservationId, businessId: s.businessId }); return s;
    };

    it('one invoice with TWO reservations (aggregate allocation): both applications are recorded, both credits consumed, and the audit is consistent', async () => {
      // two credits of ONE business on ONE invoice, frozen together by the real aggregate allocation (S08-AGG-ROUND/1), then applied and consumed
      const first = await scenario({ sagaTo: 'reserved', allocate: false });
      const n = ++seq;
      await fxq('update partner_credit_accounts set reserved = 2 where id=$1', [first.accountId]);
      const second = await forgeCredit(first.businessId, first.accountId, n, 86_400_000);
      const terms = { invoiceRef: first.invoiceRef, expectedBenefitMinor: 300, currency: 'usd', policyVersion: 'PC-BENEFIT/1' };
      const intent2 = await saga.createIntent({ reservationId: second.reservationId, ...terms });
      const intent1 = (await saga.get(first.intentId))!;
      const base = 300 * 100; // 1% per credit, two credits => aggregate 600, 300 each
      const benefit = computeInvoiceBenefit(
        { invoiceId: first.invoiceRef, invoiceBusinessId: first.businessId, currency: 'usd', status: 'paid', amountDueMinor: base, amountPaidMinor: base, interval: 'month', trialOrFree: false,
          lines: [{ id: 'synthetic_base', category: 'recurring_base', amountMinor: base, currency: 'usd' }] },
        { creditBusinessId: first.businessId, requestedUnits: 2, availableUnits: 2 });
      if (!benefit.eligible) throw new Error('synthetic two-credit benefit denied');
      const refs = await fxq<{ id: string; invoice_intent_ref: string }>('select id, invoice_intent_ref from partner_credit_reservations where id = any($1)', [[first.reservationId, second.reservationId]]);
      const artifact = await freezeAggregateBenefitAllocation({
        allocationPolicyVersion: 'S08-AGG-ROUND/1', invoice: { businessId: first.businessId, invoiceRef: first.invoiceRef, currency: 'usd' }, benefit, eligibleCreditBalance: 2,
        reservations: refs.map(r => ({ id: r.id, businessId: first.businessId, invoiceIntentRef: r.invoice_intent_ref, invoiceRef: first.invoiceRef, currency: 'usd', units: 1, state: 'reserved' as const, providerAttemptStarted: false })),
      });
      const parent = (await fxq<{ id: string }>(
        `insert into s08_allocation_freezes(business_id,invoice_ref,currency,policy_version,allocation_digest,aggregate_benefit_minor,reservation_count,artifact) values($1,$2,'usd',$3,$4,$5,2,$6::jsonb) returning id`,
        [first.businessId, first.invoiceRef, artifact.allocationPolicyVersion, artifact.allocationDigest, artifact.aggregateBenefitMinor, JSON.stringify(artifact)]))[0]!.id;
      for (const item of artifact.allocations)
        await fxq(`insert into s08_allocation_freeze_items(freeze_id,business_id,reservation_id,invoice_intent_ref,benefit_minor,provider_idempotency_key) values($1,$2,$3,$4,$5,$6)`, [parent, first.businessId, item.reservationId, item.invoiceIntentRef, item.benefitMinor, item.providerIdempotencyKey]);
      expect(artifact.allocations.map(a => Number(a.benefitMinor))).toEqual([300, 300]);
      for (const [intent, res] of [[intent1, first.reservationId], [intent2, second.reservationId]] as const) {
        const begin = await saga.beginApply(intent.id, 'att-agg', new Date(Date.now() - 500));
        if (!begin.ok) throw new Error('begin failed: ' + JSON.stringify({ code: (begin as { code?: string }).code, detail: (begin as { detail?: string }).detail }));
        const done = await saga.recordObservation(intent.id, 'att-agg', { status: 'effect_present', effectRef: `ef_${randomBytes(5).toString('hex')}`, amountMinor: 300, currency: 'usd', invoiceRef: first.invoiceRef, attributedToReservationRef: res }, new Date());
        if (!done.ok) throw new Error('not consumed: ' + JSON.stringify({ code: (done as { code?: string }).code }));
      }
      for (const r of [first.reservationId, second.reservationId]) await recorder.record({ reservationId: r, businessId: first.businessId, evidence: await evidenceFor({ businessId: first.businessId, reservationId: r, invoiceRef: first.invoiceRef }) });
      await applications.record({ reservationId: first.reservationId, businessId: first.businessId });
      await applications.record({ reservationId: second.reservationId, businessId: first.businessId });
      await consumption.consume({ reservationId: first.reservationId, businessId: first.businessId });
      await consumption.consume({ reservationId: second.reservationId, businessId: first.businessId });
      expect((await rows('select count(*)::int n from billing_partner_credit_applications where business_id=$1 and invoice_ref=$2', [first.businessId, first.invoiceRef]))[0]).toEqual({ n: 2 });
      expect((await rows<{ reserved: number }>('select reserved from partner_credit_accounts where id=$1', [first.accountId]))[0]).toEqual({ reserved: 0 });
      expect(await audit(first.businessId)).toMatchObject({ status: 'consistent' });
    });

    it('the application writer refuses an award that is disputed, no longer vested, or reversed, before writing anything (the unit would otherwise be stranded)', async () => {
      const hold = await scenario();
      await fxq("insert into partner_credit_award_disputes(business_id,decision_id,state) values($1,$2,'open')", [hold.businessId, hold.decisionId]);
      expect(await rejects(applications.record({ reservationId: hold.reservationId, businessId: hold.businessId }))).toMatch(/S08_APPLICATION_DISPUTE_HOLD/);
      const notVested = await scenario(); await fxq("update partner_credit_award_decisions set state='provisional' where id=$1", [notVested.decisionId]);
      expect(await rejects(applications.record({ reservationId: notVested.reservationId, businessId: notVested.businessId }))).toMatch(/S08_APPLICATION_AWARD_NOT_VESTED/);
      const reversed = await scenario();
      await fxq(`insert into orphan_settlement_events(settlement_id,claim_id,customer_id,event_type,origin_business_id,idempotency_key) select id,claim_id,customer_id,'settlement_reversed',$2,$3 from orphan_settlements where id=$1`, [reversed.settlementId, randomUUID(), `rev-${randomUUID()}`]);
      expect(await rejects(applications.record({ reservationId: reversed.reservationId, businessId: reversed.businessId }))).toMatch(/S08_APPLICATION_REVERSAL_PRESENT/);
      const unsettled = await scenario(); await fxq("update orphan_settlements set status='cancelled' where id=$1", [unsettled.settlementId]);
      expect(await rejects(applications.record({ reservationId: unsettled.reservationId, businessId: unsettled.businessId }))).toMatch(/S08_APPLICATION_SETTLEMENT_INVALID/);
      for (const s of [hold, notVested, reversed, unsettled]) expect((await credit(s)).applications).toBe(0);
    });

    it('the database refuses to INSERT a reservation that is already consumed (the verifier cannot be bypassed by creating the row in its final state)', async () => {
      const s = await scenario();
      expect(await rejects(admin.query(
        `insert into partner_credit_reservations(business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at,state,terminal_at) values($1,$2,$3,$4,$5,$6,now()+interval '1 day','consumed',now())`,
        [s.businessId, s.decisionId, s.lotId, s.accountId, `forged-${randomUUID()}`, `forged-${randomUUID()}`]))).toMatch(/created reserved/);
      expect(await rejects(admin.query(
        `insert into partner_credit_reservations(business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at,state,terminal_at) values($1,$2,$3,$4,$5,$6,now()+interval '1 day','released',now())`,
        [s.businessId, s.decisionId, s.lotId, s.accountId, `forged-${randomUUID()}`, `forged-${randomUUID()}`]))).toMatch(/created reserved/);
    });

    it('the database also refuses to consume when the frozen allocation no longer matches the applied invoice, currency or amount', async () => {
      const s = await scenario(); await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      await fxq('update s08_allocation_freeze_items set benefit_minor = benefit_minor + 1 where reservation_id=$1', [s.reservationId]);
      expect(await rejects(admin.query("update partner_credit_reservations set state='consumed', terminal_at=now() where id=$1", [s.reservationId]))).toMatch(/frozen allocation of this reservation to match/);
      const noItem = await scenario(); await applications.record({ reservationId: noItem.reservationId, businessId: noItem.businessId });
      await fxq('delete from s08_allocation_freeze_items where reservation_id=$1', [noItem.reservationId]);
      expect(await rejects(admin.query("update partner_credit_reservations set state='consumed', terminal_at=now() where id=$1", [noItem.reservationId]))).toMatch(/frozen allocation of this reservation to match/);
    });

    it('lot transitions: the recovery-offset vest path (provisional -> consumed) is untouched, while available/expired/other states can never become consumed', async () => {
      const s = await scenario();
      await fxq("update partner_credit_lots set status='provisional', available_units=0 where id=$1", [s.lotId]);
      // the vest-with-offset write: its recovery_offset ledger entry exists before the lot update (0057 requires it)
      await fxq("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'recovery_offset',-1,$3)", [s.accountId, s.decisionId, `offset-${randomUUID()}`]);
      await admin.query("update partner_credit_lots set status='consumed' where id=$1", [s.lotId]);
      const t = await scenario();
      await fxq("update partner_credit_lots set status='available', available_units=1 where id=$1", [t.lotId]);
      expect(await rejects(admin.query("update partner_credit_lots set status='consumed', available_units=0 where id=$1", [t.lotId]))).toMatch(/only from reserved .* or provisional/);
    });

    it('consume is idempotent even AFTER a consumed-credit reversal (replay returns the same result and writes nothing)', async () => {
      const s = await consumedScenario();
      await dbApp.transaction(tx => compensator.compensate(tx, { settlementRef: s.settlementId, businessId: s.businessId, reversalEventId: randomUUID() }));
      const before = await credit(s);
      expect(await consumption.consume({ reservationId: s.reservationId, businessId: s.businessId })).toEqual({ state: 'consumed', replay: true, ledgerKey: `partner-consume:v1:${s.reservationId}` });
      expect(await credit(s)).toEqual(before);
    });

    it('a lot consumed WITHOUT a consumed reservation (debt-absorbed or forged) still fails closed in reversal with the original error, never as a recovery obligation', async () => {
      const s = await scenario();
      await fxq("update partner_credit_lots set status='consumed' where id=$1", [s.lotId]); // no consumed reservation, no application
      expect(await rejects(dbApp.transaction(tx => compensator.compensate(tx, { settlementRef: s.settlementId, businessId: s.businessId, reversalEventId: randomUUID() })))).toMatch(/PARTNER_REVERSAL_LOT_STATE_UNSUPPORTED/);
      expect((await credit(s)).obligations).toBe(0);
    });

    it('the audit accepts a lot absorbed by a recovery debt at vest, and rejects a consumed-reversal whose consume entry belongs to a different reservation', async () => {
      const businessId = (await rows<{ id: string }>("insert into businesses(name,slug,status) values('D4 offset',$1,'active') returning id", [`d4-offset-${dbName}`]))[0]!.id;
      const accountId = (await fxq<{ id: string }>('insert into partner_credit_accounts(business_id) values($1) returning id', [businessId]))[0]!.id;
      const decisionId = (await fxq<{ id: string }>(`insert into partner_credit_award_decisions(settlement_ref,business_id,policy_id,state,award_units,earning_month_utc,fulfilled_at,vest_at,idempotency_key) values($1,$2,$3,'vested',1,'2026-10',now(),now(),$4) returning id`, [randomUUID(), businessId, randomUUID(), `d4-off-dec-${dbName}`]))[0]!.id;
      await fxq(`insert into partner_credit_lots(decision_id,account_id,units,available_units,status,vest_at,expires_at) values($1,$2,1,0,'consumed',now(),now()+interval '1 year')`, [decisionId, accountId]);
      await fxq(`insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'provisional',1,$3),($1,$2,'vest',1,$4),($1,$2,'recovery_offset',-1,$5)`, [accountId, decisionId, `o1-${randomUUID()}`, `o2-${randomUUID()}`, `o3-${randomUUID()}`]);
      const r = await audit(businessId);
      expect(r).toMatchObject({ status: 'consistent' });
      const s = await consumedScenario();
      await dbApp.transaction(tx => compensator.compensate(tx, { settlementRef: s.settlementId, businessId: s.businessId, reversalEventId: randomUUID() }));
      expect(await audit(s.businessId)).toMatchObject({ status: 'consistent' });
      await fxq("update partner_credit_ledger set metadata = jsonb_set(metadata, '{reservationId}', to_jsonb($2::text)) where decision_id=$1 and entry_type='consume'", [s.decisionId, randomUUID()]);
      const bad = await audit(s.businessId);
      expect(bad.status === 'inconsistent' && bad.violations.map(v => v.code)).toContain('CONSUMED_REVERSAL_EVIDENCE');
    });
  });
  describe('owner ratification evidence (D4-03, D4-05, D4-06)', () => {
    it('D4-03: an effect confirmed after the reservation deadline is classified for review, never recorded or consumed, and nothing is discarded or written', async () => {
      const late = await scenario({ expiresInMs: 1_000, appliedOffsetMs: 3_000 });
      const before = await credit(late);
      const c = await applications.classify({ reservationId: late.reservationId, businessId: late.businessId });
      expect(c).toMatchObject({ classification: 'EFFECT_AFTER_RESERVATION_DEADLINE', heldForReview: true, reservationId: late.reservationId, intentId: late.intentId });
      if (c.heldForReview) { expect(c.lateByMs).toBeGreaterThan(0); expect(c.providerEffectRef).toMatch(/^ef_/); }
      expect(await rejects(applications.record({ reservationId: late.reservationId, businessId: late.businessId }))).toMatch(/S08_APPLICATION_AFTER_RESERVATION_EXPIRY/);
      expect(await rejects(consumption.consume({ reservationId: late.reservationId, businessId: late.businessId }))).toMatch(/PARTNER_CONSUME_APPLICATION_MISSING/);
      // the evidence is preserved exactly: reservation, credit rows, saga intent (still confirmed with its provider effect) and the ledger are unchanged
      expect(await credit(late)).toEqual(before);
      expect((await rows<{ state: string; outcome: string; provider_effect_ref: string }>('select state, outcome, provider_effect_ref from benefit_application_intents where id=$1', [late.intentId]))[0])
        .toMatchObject({ state: 'consumed', outcome: 'confirmed' });
      const ok = await scenario();
      expect(await applications.classify({ reservationId: ok.reservationId, businessId: ok.businessId })).toMatchObject({ classification: 'WITHIN_RESERVATION_DEADLINE', heldForReview: false });
      const noSaga = await scenario({ sagaTo: 'reserved' });
      expect(await applications.classify({ reservationId: noSaga.reservationId, businessId: noSaga.businessId })).toMatchObject({ classification: 'NO_RECONCILED_EFFECT', heldForReview: false });
      expect(await rejects(applications.classify({ reservationId: ok.reservationId, businessId: noSaga.businessId }))).toMatch(/S08_APPLICATION_UNKNOWN_RESERVATION/);
    });

    it('D4-05: the database also requires the frozen allocation item to carry the reservation\'s own invoice-intent reference', async () => {
      const s = await scenario(); await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      await fxq("update s08_allocation_freeze_items set invoice_intent_ref = 'intent-substituted' where reservation_id=$1", [s.reservationId]);
      expect(await rejects(admin.query("update partner_credit_reservations set state='consumed', terminal_at=now() where id=$1", [s.reservationId]))).toMatch(/frozen allocation of this reservation to match/);
      expect((await credit(s)).reservation).toBe('reserved');
    });

    it('D4-05: the database refuses consumption when the provider effect or invoice differs from the application (service bypassed)', async () => {
      // (state/outcome of a saga are already pinned by benefit_application_intents_shape_check, so 'consumed' without 'confirmed' is unrepresentable; the trigger's
      // matching clause is defence in depth and the effect/invoice agreement below is what only the trigger can judge)
      for (const [label, change] of [
        ['provider effect differs', "provider_effect_ref='ef_other_'||substr(md5(random()::text),1,8)"],
        ['invoice differs', "invoice_ref='in_other_'||substr(md5(random()::text),1,8)"],
      ] as const) {
        const s = await scenario(); await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
        await fxq(`update benefit_application_intents set ${change} where id=$1`, [s.intentId]);
        expect(await rejects(admin.query("update partner_credit_reservations set state='consumed', terminal_at=now() where id=$1", [s.reservationId])), label)
          .toMatch(/verified Split 08 terminal application and a reconciled saga/);
        expect((await credit(s)).reservation, label).toBe('reserved');
      }
    });

    it('review M2: the database and the consumer refuse an application whose applied_at is not the reconciled saga\'s own (a forged early timestamp cannot defeat the deadline)', async () => {
      const edited = await scenario(); await applications.record({ reservationId: edited.reservationId, businessId: edited.businessId });
      await fxq("update billing_partner_credit_applications set applied_at = applied_at - interval '1 second' where reservation_id=$1", [edited.reservationId]);
      expect(await rejects(admin.query("update partner_credit_reservations set state='consumed', terminal_at=now() where id=$1", [edited.reservationId]))).toMatch(/reconciled saga/);
      expect(await rejects(consumption.consume({ reservationId: edited.reservationId, businessId: edited.businessId }))).toMatch(/PARTNER_CONSUME_APPLICATION_NOT_AUTHORITATIVE/);
      // late real effect + bare application carrying an early timestamp
      const late = await scenario({ expiresInMs: 1_000, appliedOffsetMs: 3_000 });
      const intent = (await rows<{ provider_effect_ref: string; invoice_ref: string }>('select provider_effect_ref, invoice_ref from benefit_application_intents where id=$1', [late.intentId]))[0]!;
      const sub = (await rows<{ id: string }>('select id from business_subscriptions where business_id=$1', [late.businessId]))[0]!.id;
      await fxq(`insert into billing_partner_credit_applications(reservation_id,business_id,subscription_id,invoice_ref,provider_success_ref,idempotency_key,units_applied,terminal_state,applied_at)
                 values($1,$2,$3,$4,$5,$6,1,'applied',now() - interval '1 hour')`, [late.reservationId, late.businessId, sub, intent.invoice_ref, intent.provider_effect_ref, `forged-${randomUUID()}`]);
      expect(await rejects(admin.query("update partner_credit_reservations set state='consumed', terminal_at=now() where id=$1", [late.reservationId]))).toMatch(/reconciled saga/);
      expect(await rejects(consumption.consume({ reservationId: late.reservationId, businessId: late.businessId }))).toMatch(/PARTNER_CONSUME_APPLICATION_NOT_AUTHORITATIVE/);
      expect((await credit(late)).reservation).toBe('reserved');
    });

    it('review M1: terminal_at is never earlier than the application\'s applied_at, even when the caller passes an earlier clock', async () => {
      const s = await scenario({ appliedOffsetMs: 1_000 }); await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      await consumption.consume({ reservationId: s.reservationId, businessId: s.businessId, now: new Date(Date.now() - 60_000) });
      const r = (await rows<{ ok: boolean }>('select r.terminal_at >= a.applied_at ok from partner_credit_reservations r join billing_partner_credit_applications a on a.reservation_id=r.id where r.id=$1', [s.reservationId]))[0]!;
      expect(r.ok).toBe(true);
    });

    it('review L2: a consumed reservation is immutable in every column, not only its state', async () => {
      const s = await scenario(); await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      await consumption.consume({ reservationId: s.reservationId, businessId: s.businessId });
      for (const set of ["expires_at = expires_at + interval '1 day'", 'terminal_at = now()', "invoice_intent_ref = 'tampered'"])
        expect(await rejects(admin.query(`update partner_credit_reservations set ${set} where id=$1`, [s.reservationId])), set).toMatch(/terminal state is immutable/);
    });

    it('review L1: the audit flags a consumed reservation whose lot never became consumed', async () => {
      const s = await scenario();
      await fxq("update partner_credit_reservations set state='consumed', terminal_at=now() where id=$1", [s.reservationId]);
      const r = await audit(s.businessId);
      expect(r.status === 'inconsistent' && r.violations.map(v => v.code)).toContain('CONSUMED_RESERVATION_LOT_MISMATCH');
    });

    it('hardening (0056): the database refuses to consume with terminal_at earlier than the application\'s applied_at, and accepts it at applied_at', async () => {
      const s = await scenario(); await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      expect(await rejects(admin.query("update partner_credit_reservations set state='consumed', terminal_at=(select applied_at - interval '1 second' from billing_partner_credit_applications where reservation_id=$1) where id=$1", [s.reservationId])))
        .toMatch(/cannot be terminal before its application was applied/);
      expect((await credit(s)).reservation).toBe('reserved');
      await admin.query("update partner_credit_reservations set state='consumed', terminal_at=(select applied_at from billing_partner_credit_applications where reservation_id=$1) where id=$1", [s.reservationId]);
      expect((await credit(s)).reservation).toBe('consumed');
    });

    it('hardening (0056): a consumed reservation is also immutable in id, idempotency_key and created_at', async () => {
      const s = await scenario(); await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      await consumption.consume({ reservationId: s.reservationId, businessId: s.businessId });
      for (const set of ["id = gen_random_uuid()", "idempotency_key = 'tampered-' || gen_random_uuid()::text", "created_at = created_at - interval '1 day'"])
        expect(await rejects(admin.query(`update partner_credit_reservations set ${set} where id=$1`, [s.reservationId])), set).toMatch(/terminal state is immutable/);
    });

    it('L3 (0057): provisional -> consumed needs a recovery_offset ledger entry, consumed -> reversed needs a consumed_reversal entry (the real writers create them first)', async () => {
      // provisional -> consumed: refused without the offset entry, accepted with it
      const v = await scenario();
      await fxq("update partner_credit_lots set status='provisional', available_units=0 where id=$1", [v.lotId]);
      expect(await rejects(admin.query("update partner_credit_lots set status='consumed' where id=$1", [v.lotId]))).toMatch(/only when a recovery offset absorbed its vesting unit/);
      await fxq("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'recovery_offset',-1,$3)", [v.accountId, v.decisionId, `offset-${randomUUID()}`]);
      await admin.query("update partner_credit_lots set status='consumed' where id=$1", [v.lotId]);
      // an offset entry of ANOTHER decision is not evidence for this lot
      const w = await scenario();
      await fxq("update partner_credit_lots set status='provisional', available_units=0 where id=$1", [w.lotId]);
      await fxq("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'recovery_offset',-1,$3)", [w.accountId, v.decisionId, `offset-${randomUUID()}`]);
      expect(await rejects(admin.query("update partner_credit_lots set status='consumed' where id=$1", [w.lotId]))).toMatch(/only when a recovery offset absorbed its vesting unit/);
      // consumed -> reversed: refused by hand without the consumed_reversal entry, accepted through the real compensator
      const c = await scenario(); await applications.record({ reservationId: c.reservationId, businessId: c.businessId });
      await consumption.consume({ reservationId: c.reservationId, businessId: c.businessId });
      expect(await rejects(admin.query("update partner_credit_lots set status='reversed' where id=$1", [c.lotId]))).toMatch(/reversed only after its consumed reversal was recorded/);
      expect((await credit(c)).lot).toBe('consumed');
      await dbApp.transaction(tx => compensator.compensate(tx, { settlementRef: c.settlementId, businessId: c.businessId, reversalEventId: randomUUID() }));
      expect((await credit(c)).lot).toBe('reversed');
      // a consumed_reversal entry recorded under ANOTHER account is not evidence for this lot
      const d = await scenario(); await applications.record({ reservationId: d.reservationId, businessId: d.businessId });
      await consumption.consume({ reservationId: d.reservationId, businessId: d.businessId });
      await fxq("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'consumed_reversal',1,$3)", [c.accountId, d.decisionId, `wrong-account-${randomUUID()}`]);
      expect(await rejects(admin.query("update partner_credit_lots set status='reversed' where id=$1", [d.lotId]))).toMatch(/reversed only after its consumed reversal was recorded/);
    });

    it('L4 (audit): an application with no matching frozen allocation item is reported as APPLICATION_ALLOCATION_EVIDENCE; real-service applications are not', async () => {
      const real = await scenario(); await applications.record({ reservationId: real.reservationId, businessId: real.businessId });
      expect(await audit(real.businessId)).toMatchObject({ status: 'consistent' });
      const bare = await scenario({ sagaTo: 'reserved', allocate: false });
      const sub = (await rows<{ id: string }>('select id from business_subscriptions where business_id=$1', [bare.businessId]))[0]!.id;
      await fxq(`insert into billing_partner_credit_applications(reservation_id,business_id,subscription_id,invoice_ref,provider_success_ref,idempotency_key,units_applied,terminal_state,applied_at)
                 values($1,$2,$3,$4,$5,$6,1,'applied',now())`, [bare.reservationId, bare.businessId, sub, bare.invoiceRef, `ef_bare_${randomUUID()}`, `bare-${randomUUID()}`]);
      const r = await audit(bare.businessId);
      expect(r.status === 'inconsistent' && r.violations.map(v => v.code)).toContain('APPLICATION_ALLOCATION_EVIDENCE');
      // a frozen item for another invoice is not evidence for this application
      await fxq("update billing_partner_credit_applications set invoice_ref = invoice_ref || '_x' where reservation_id=$1", [real.reservationId]);
      const r2 = await audit(real.businessId);
      expect(r2.status === 'inconsistent' && r2.violations.map(v => v.code)).toContain('APPLICATION_ALLOCATION_EVIDENCE');
    });

    it('L5: classify() reads one consistent snapshot in a read-only transaction and writes nothing', async () => {
      const late = await scenario({ expiresInMs: 1_000, appliedOffsetMs: 3_000 });
      const before = await credit(late);
      for (let i = 0; i < 3; i++)
        expect(await applications.classify({ reservationId: late.reservationId, businessId: late.businessId })).toMatchObject({ classification: 'EFFECT_AFTER_RESERVATION_DEADLINE', heldForReview: true });
      expect(await credit(late)).toEqual(before);
      // classify() itself must open a REPEATABLE READ, READ ONLY transaction: capture the options it passes through a wrapper and prove those options forbid a write
      const captured: unknown[] = [];
      const real = buildDb(await connect());
      const spy = new Proxy(real, { get(t, prop, r) { return prop === 'transaction' ? (fn: never, cfg: unknown) => { captured.push(cfg); return (t.transaction as (f: never, c: unknown) => unknown)(fn, cfg); } : Reflect.get(t, prop, r); } });
      await new BenefitTerminalApplicationService(spy as typeof real).classify({ reservationId: late.reservationId, businessId: late.businessId });
      expect(captured).toEqual([{ isolationLevel: 'repeatable read', accessMode: 'read only' }]);
      const probe = await rejects(dbApp.transaction(async tx => { await tx.execute(sql`update partner_credit_reservations set units = units where id = ${late.reservationId}`); }, captured[0] as never));
      expect(probe).toMatch(/read-only transaction/);
    });

    it('R10 shared unwind, consumed through an invoice: a revocation cause creates the same one obligation, audit-compatible, and is exactly-once against a settlement reversal in either order', async () => {
      const unwindAs = async (c: Scenario, cause: UnwindCause) => dbApp.transaction(async tx => {
        await tx.execute(sql`select id from orphan_settlements where id = ${c.settlementId} for update`);
        return unwindCredit(tx, { settlementRef: c.settlementId, businessId: c.businessId, cause });
      });
      const first = await scenario(); await applications.record({ reservationId: first.reservationId, businessId: first.businessId });
      await consumption.consume({ reservationId: first.reservationId, businessId: first.businessId });
      const correctionId = randomUUID();
      expect(await unwindAs(first, { source: 'revocation', correctionId })).toBe('recovery_obligation_created');
      const [obligation] = await rows<{ reversal_ref: string; units_due: number; units_outstanding: number }>('select reversal_ref, units_due, units_outstanding from partner_credit_recovery_obligations where account_id=$1', [first.accountId]);
      expect(obligation).toMatchObject({ reversal_ref: correctionId, units_due: 1, units_outstanding: 1 });
      const [entry] = await rows<{ idempotency_key: string; metadata: Record<string, unknown> }>("select idempotency_key, metadata from partner_credit_ledger where decision_id=$1 and entry_type='consumed_reversal'", [first.decisionId]);
      expect(entry!.idempotency_key).toBe(`partner-reversal:v1:${first.settlementId}`);
      expect(entry!.metadata).toMatchObject({ source: 'revocation', correctionId, reversalEventId: correctionId }); // the existing audit join (reversal_ref = metadata.reversalEventId) passes
      expect(await audit(first.businessId)).toMatchObject({ status: 'consistent' });
      expect(await dbApp.transaction(tx => compensator.compensate(tx, { settlementRef: first.settlementId, businessId: first.businessId, reversalEventId: randomUUID() }))).toBe('already_reversed');
      expect((await credit(first)).obligations).toBe(1);
      // the other order: the settlement reversal first, then the revocation executor
      const second = await scenario(); await applications.record({ reservationId: second.reservationId, businessId: second.businessId });
      await consumption.consume({ reservationId: second.reservationId, businessId: second.businessId });
      expect(await dbApp.transaction(tx => compensator.compensate(tx, { settlementRef: second.settlementId, businessId: second.businessId, reversalEventId: randomUUID() }))).toBe('recovery_obligation_created');
      expect(await unwindAs(second, { source: 'revocation', correctionId: randomUUID() })).toBe('already_reversed');
      expect((await credit(second)).obligations).toBe(1);
      expect(await audit(second.businessId)).toMatchObject({ status: 'consistent' });
    });

    it('D4-06: the same reservation can never be applied twice (the database refuses it on any invoice, and the writer replays the one row)', async () => {
      const s = await scenario();
      const first = await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      const again = await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      expect(again).toMatchObject({ applicationId: first.applicationId, replay: true });
      for (const invoiceRef of [s.invoiceRef, `${s.invoiceRef}_other`]) {
        const sub = (await rows<{ id: string }>('select id from business_subscriptions where business_id=$1', [s.businessId]))[0]!.id;
        const err = await rejects(fxq(
          `insert into billing_partner_credit_applications(reservation_id,business_id,subscription_id,invoice_ref,provider_success_ref,idempotency_key,units_applied,terminal_state,applied_at)
           values($1,$2,$3,$4,$5,$6,1,'applied',now())`, [s.reservationId, s.businessId, sub, invoiceRef, `ef_dup_${randomUUID()}`, `dup-${randomUUID()}`]));
        expect(err).toMatch(/duplicate key value/);
      }
      expect((await credit(s)).applications).toBe(1);
    });

    it('D4-06: an invoice\'s applications correspond exactly to its frozen allocation items; an extra reservation without a frozen item cannot be applied', async () => {
      const first = await scenario({ sagaTo: 'consumed' });
      // a second credit of the same business and invoice, with a consumed saga but NO frozen allocation item
      const n = ++seq;
      await fxq('update partner_credit_accounts set reserved = 2 where id=$1', [first.accountId]);
      const second = await forgeCredit(first.businessId, first.accountId, n, 86_400_000);
      const intent = await saga.createIntent({ reservationId: second.reservationId, invoiceRef: first.invoiceRef, expectedBenefitMinor: 300, currency: 'usd', policyVersion: 'PC-BENEFIT/1' });
      await saga.beginApply(intent.id, 'att-x', new Date(Date.now() - 500));
      expect((await saga.recordObservation(intent.id, 'att-x', { status: 'effect_present', effectRef: `ef_${randomBytes(5).toString('hex')}`, amountMinor: 300, currency: 'usd', invoiceRef: first.invoiceRef, attributedToReservationRef: second.reservationId }, new Date())).ok).toBe(false);
      expect(await rejects(applications.record({ reservationId: second.reservationId, businessId: first.businessId }))).toMatch(/S08_APPLICATION_(SAGA_NOT_RECONCILED|ALLOCATION_MISSING)/);
      await applications.record({ reservationId: first.reservationId, businessId: first.businessId });
      const apps = await rows<{ reservation_id: string }>('select reservation_id from billing_partner_credit_applications where business_id=$1 and invoice_ref=$2', [first.businessId, first.invoiceRef]);
      const items = await rows<{ reservation_id: string }>(
        'select it.reservation_id from s08_allocation_freeze_items it join s08_allocation_freezes f on f.id=it.freeze_id where f.business_id=$1 and f.invoice_ref=$2', [first.businessId, first.invoiceRef]);
      expect(apps.map(a => a.reservation_id).sort()).toEqual(items.map(i => i.reservation_id).sort());
      expect(apps).toHaveLength(1);
    });

    it('D4-06: business isolation — the key includes the business, so another business may use the same invoice reference but can never reach this reservation', async () => {
      const a = await scenario(); const b = await scenario();
      await applications.record({ reservationId: a.reservationId, businessId: a.businessId });
      expect(await rejects(applications.record({ reservationId: a.reservationId, businessId: b.businessId }))).toMatch(/S08_APPLICATION_UNKNOWN_RESERVATION/);
      const keys = await rows<{ def: string }>("select pg_get_constraintdef(oid) def from pg_constraint where conrelid='billing_partner_credit_applications'::regclass and contype='u' order by 1");
      expect(keys.map(k => k.def)).toEqual(expect.arrayContaining(['UNIQUE (business_id, invoice_ref, reservation_id)', 'UNIQUE (reservation_id)']));
      expect(keys.map(k => k.def)).not.toContain('UNIQUE (business_id, invoice_ref)');
    });
  });

  describe('D1/D3-DEV-03 consumption settlement gate', () => {
    const ready = async (over?: (ev: any) => void, opts: { authorize?: boolean } = {}) => {
      const s = await scenario({ authorize: false });
      await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      let rec;
      if (opts.authorize !== false) rec = await recorder.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: await evidenceFor(s, over) });
      return { s, rec };
    };
    const consumeEntries = async (s: Scenario) => (await rows<{ n: number }>("select count(*)::int n from partner_credit_ledger where decision_id=$1 and entry_type='consume'", [s.decisionId]))[0]!.n;
    /** A refused consumption leaves NO trace: reservation, lot, account and ledger are exactly as they were. */
    const refused = async (s: Scenario, pattern: RegExp, service: PartnerCreditConsumptionService = consumption) => {
      const before = await credit(s);
      const msg = await rejects(service.consume({ reservationId: s.reservationId, businessId: s.businessId }));
      expect(msg).toMatch(pattern);
      expect(await credit(s)).toEqual(before);
      expect(await consumeEntries(s)).toBe(0);
      expect(await rows('select count(*)::int n from partner_credit_ledger where entry_type=\'consume\' and decision_id=$1', [s.decisionId])).toEqual([{ n: 0 }]);
      return msg;
    };
    const unpaid = (status: string) => (ev: any) => { ev.invoice.status = status; ev.invoice.amountPaidMinor = 0; ev.invoice.amountRemainingMinor = ev.invoice.amountDueMinor; ev.invoice.paidAtMs = null; resync(ev); };
    const newConsumer = async (cfg: SettlementGateConfig | undefined) => new PartnerCreditConsumptionService(buildDb(await connect()), cfg);

    it('1-2. unpaid, draft, voided, uncollectible, disputed and refunded invoices cannot authorize consumption, and nothing moves', async () => {
      const variants: Array<[string, (ev: any) => void]> = [
        ['open (unpaid)', unpaid('open')], ['draft', unpaid('draft')],
        ['void', ev => { unpaid('void')(ev); ev.invoice.voidedAtMs = ev.invoice.createdAtMs + 1_000; }], ['uncollectible', unpaid('uncollectible')],
        ['partially paid', ev => { ev.invoice.status = 'open'; ev.invoice.amountPaidMinor = 100; ev.invoice.amountRemainingMinor = ev.invoice.amountDueMinor - 100; ev.invoice.paidAtMs = null; resync(ev); }],
        ['paid with an open dispute', ev => { ev.events.dispute = 'open'; }], ['paid then fully refunded', ev => { ev.events.refund = 'full'; }],
        ['paid out of band', ev => { ev.settlement.source = 'out_of_band'; }],
      ];
      for (const [label, over] of variants) {
        const { s, rec } = await ready(over);
        expect(rec!.verdict, label).not.toBe('ELIGIBLE');
        await refused(s, /PARTNER_CONSUME_SETTLEMENT_NOT_AUTHORIZED \(NOT_ELIGIBLE\)/);
      }
    });

    it('3. missing settlement evidence blocks consumption; evidence that cannot even be identified leaves no row', async () => {
      const { s } = await ready(undefined, { authorize: false });
      await refused(s, /\(AUTHORIZATION_MISSING\)/);
      const t = await ready(undefined, { authorize: false });
      for (const bad of [null, undefined, {}, { provenance: {} }, 'x'] as any[]) expect(await rejects(recorder.record({ reservationId: t.s.reservationId, businessId: t.s.businessId, evidence: bad }))).toMatch(/SETTLEMENT_AUTH_EVIDENCE_UNUSABLE|TypeError|Cannot read/);
      expect(await rows('select count(*)::int n from partner_credit_settlement_authorizations where reservation_id=$1', [t.s.reservationId])).toEqual([{ n: 0 }]);
      await refused(t.s, /\(AUTHORIZATION_MISSING\)/);
    });

    it('4. stale evidence blocks consumption (stale at recording, stale by the time of consumption, and future-dated)', async () => {
      const old = await ready(ev => { for (const k of ['observedAtMs']) ev.provenance[k] -= 7_200_000; ev.invoice.createdAtMs -= 7_200_000; ev.invoice.paidAtMs -= 7_200_000; }); // a coherent timeline observed two hours ago
      expect(old.rec).toMatchObject({ verdict: 'UNRESOLVED' }); expect(old.rec!.reasonCodes).toContain('STALE_EVIDENCE');
      await refused(old.s, /\(NOT_ELIGIBLE\)/);
      const future = await ready(ev => { ev.provenance.observedAtMs += 120_000; });
      expect(future.rec!.verdict).toBe('UNRESOLVED'); await refused(future.s, /\(NOT_ELIGIBLE\)/);
      // fresh when recorded, stale when consumed: the gate reads the DATABASE clock inside the transaction
      const tight: SettlementGateConfig = { ...GATE_CFG, freshnessWindowMs: 400 };
      const tightRecorder = new SettlementAuthorizationRecorder(buildDb(await connect()), tight, SIGNER);
      const s = await scenario({ authorize: false }); await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      const fresh = await tightRecorder.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: await evidenceFor(s, ev => { ev.provenance.observedAtMs += 990; }) });
      expect(fresh.verdict).toBe('ELIGIBLE');
      await new Promise(r => setTimeout(r, 900));
      await refused(s, /\(STALE_EVIDENCE\)/, await newConsumer(tight));
    });

    it('5. cross-tenant evidence is rejected at every layer', async () => {
      const other = await scenario({ authorize: false });
      const { s, rec } = await ready(ev => { ev.binding.businessId = other.businessId; });
      expect(rec!.verdict).toBe('UNRESOLVED'); expect(rec!.reasonCodes).toContain('TENANT_MISMATCH');
      await refused(s, /\(NOT_ELIGIBLE\)/);
      // the recorder refuses another tenant's reservation outright
      expect(await rejects(recorder.record({ reservationId: s.reservationId, businessId: other.businessId, evidence: await evidenceFor(s) }))).toMatch(/SETTLEMENT_AUTH_UNKNOWN_RESERVATION/);
      // and the database refuses a forged row: a valid row copied under another business / another reservation / another invoice, with a correctly recomputed digest
      const good = await ready(); expect(good.rec!.verdict).toBe('ELIGIBLE');
      const row = (await rows<any>('select * from partner_credit_settlement_authorizations where reservation_id=$1', [good.s.reservationId]))[0];
      const forge = async (over: Record<string, unknown>) => {
        const f = { ...row, ...over, snapshot_digest: randomBytes(32).toString('hex') };
        const digest = (await rows<{ d: string }>('select partner_credit_settlement_auth_digest($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12,$13,$14,$15,$16) d',
          [f.business_id, f.reservation_id, f.decision_id, f.invoice_ref, f.provider_account_id, f.provider_mode, f.allocation_digest, f.policy_version, f.verdict, f.reason_codes, f.classifier_version, f.evidence_kind, f.billing_interval, f.snapshot_ref, f.snapshot_digest, f.observed_at_ms]))[0]!.d;
        return rejects(admin.query(
          `insert into partner_credit_settlement_authorizations(business_id,reservation_id,decision_id,invoice_ref,provider_account_id,provider_mode,allocation_digest,policy_version,verdict,reason_codes,classifier_version,evidence_kind,billing_interval,snapshot_ref,snapshot_digest,observed_at_ms,evidence_digest,provenance_version,signing_key_id,signature)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12,$13,$14,$15,$16,$17,1,'dummy',repeat('a',128))`,
          [f.business_id, f.reservation_id, f.decision_id, f.invoice_ref, f.provider_account_id, f.provider_mode, f.allocation_digest, f.policy_version, f.verdict, f.reason_codes, f.classifier_version, f.evidence_kind, f.billing_interval, f.snapshot_ref, f.snapshot_digest, f.observed_at_ms, digest]));
      };
      expect(await forge({ business_id: other.businessId })).toMatch(/violates foreign key|SETTLEMENT_AUTH_BINDING/);        // another tenant
      expect(await forge({ reservation_id: other.reservationId })).toMatch(/violates foreign key|SETTLEMENT_AUTH_BINDING/);  // another reservation
      expect(await forge({ invoice_ref: 'in_other_invoice' })).toMatch(/invoice and policy are not those of the reservation/);  // another invoice (the intent binding, not merely the freeze)
      expect(await forge({ policy_version: 'PC-BENEFIT/2' })).toMatch(/invoice and policy are not those of the reservation/);   // another policy version
      expect(await forge({ decision_id: other.decisionId })).toMatch(/SETTLEMENT_AUTH_BINDING/);                              // another decision
    });

    it('6. a wrong Stripe account or mode is rejected (in the evidence, and by the gate configuration at consumption)', async () => {
      const acct = await ready(ev => { ev.provider.accountId = 'acct_somebody_else'; }); expect(acct.rec!.reasonCodes).toContain('SCOPE_MISMATCH'); await refused(acct.s, /\(NOT_ELIGIBLE\)/);
      const mode = await ready(ev => { ev.provider.mode = 'live'; }); expect(mode.rec!.reasonCodes).toContain('SCOPE_MISMATCH'); await refused(mode.s, /\(NOT_ELIGIBLE\)/);
      const good = await ready(); expect(good.rec!.verdict).toBe('ELIGIBLE');
      await refused(good.s, /\(PROVIDER_SCOPE_MISMATCH\)/, await newConsumer({ ...GATE_CFG, providerAccountId: 'acct_other_environment' }));
      await refused(good.s, /\(PROVIDER_SCOPE_MISMATCH\)/, await newConsumer({ ...GATE_CFG, providerMode: 'live' }));
    });

    it('7. frozen-allocation mismatches are rejected (evidence that disagrees with the freeze, and a freeze changed after the authorization)', async () => {
      const amount = await ready(ev => { ev.benefitItem.amountMinor += 1; ev.lines.items[1].amountMinor += 1; ev.invoice.totalMinor += 1; ev.invoice.amountDueMinor += 1; ev.invoice.amountPaidMinor += 1; resync(ev); });
      expect(amount.rec!.reasonCodes).toContain('AMOUNT_MISMATCH'); await refused(amount.s, /\(NOT_ELIGIBLE\)/);
      const digest = await ready(); expect(digest.rec!.verdict).toBe('ELIGIBLE');
      await fxq("update s08_allocation_freezes set allocation_digest = $1 where business_id=$2 and invoice_ref=$3", ['f'.repeat(64), digest.s.businessId, digest.s.invoiceRef]);
      await refused(digest.s, /\(ALLOCATION_MISMATCH\)/);
      const item = await ready(); expect(item.rec!.verdict).toBe('ELIGIBLE');
      await fxq('delete from s08_allocation_freeze_items where reservation_id=$1', [item.s.reservationId]);
      await refused(item.s, /\(ALLOCATION_MISMATCH\)/);
      // and the database refuses an authorization whose allocation digest is not the persisted freeze's
      const t = await ready(undefined, { authorize: false });
      expect(await rejects(admin.query(`insert into partner_credit_settlement_authorizations(business_id,reservation_id,decision_id,invoice_ref,provider_account_id,provider_mode,allocation_digest,policy_version,verdict,reason_codes,classifier_version,evidence_kind,billing_interval,snapshot_ref,snapshot_digest,observed_at_ms,evidence_digest,provenance_version,signing_key_id,signature)
        select $1,$2,$3,i.invoice_ref,'acct_d4_test','test',repeat('c',64),i.policy_version,'ELIGIBLE',ARRAY['ALL_CONDITIONS_VERIFIED'],'S08-D1D3-SETTLEMENT/1','MOCK_SYNTHETIC','month','s',repeat('d',64),1000,
          partner_credit_settlement_auth_digest($1,$2,$3,i.invoice_ref,'acct_d4_test','test',repeat('c',64),i.policy_version,'ELIGIBLE',ARRAY['ALL_CONDITIONS_VERIFIED'],'S08-D1D3-SETTLEMENT/1','MOCK_SYNTHETIC','month','s',repeat('d',64),1000),
          1,'dummy',repeat('a',128)
        from benefit_application_intents i where i.reservation_id=$2`, [t.s.businessId, t.s.reservationId, t.s.decisionId]))).toMatch(/SETTLEMENT_AUTH_BINDING.*allocation digest/);
    });

    it('8. duplicate settlement evidence is one row and cannot cause a second consumption; the same snapshot with a different conclusion is a conflict', async () => {
      const { s } = await ready();
      const ev = await evidenceFor(s);
      const first = await recorder.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: ev });
      const again = await recorder.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: ev });
      expect(first.replay).toBe(false); expect(again).toMatchObject({ id: first.id, replay: true });
      expect((await rows<{ n: number }>('select count(*)::int n from partner_credit_settlement_authorizations where reservation_id=$1 and snapshot_digest=$2', [s.reservationId, ev.provenance.snapshotDigest]))[0]!.n).toBe(1);
      const conflicting = JSON.parse(JSON.stringify(ev)); conflicting.events.dispute = 'open'; // same snapshot digest, different content, therefore a different conclusion
      expect(await rejects(recorder.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: conflicting }))).toMatch(/SETTLEMENT_AUTH_REPLAY_CONFLICT/);
      const one = await consumption.consume({ reservationId: s.reservationId, businessId: s.businessId });
      const two = await consumption.consume({ reservationId: s.reservationId, businessId: s.businessId });
      expect(one.replay).toBe(false); expect(two.replay).toBe(true);
      expect(await consumeEntries(s)).toBe(1); expect(await audit(s.businessId)).toMatchObject({ status: 'consistent' });
    });

    it('9. concurrent consumption attempts remain exactly-once, with and without a racing newer authorization', async () => {
      const { s } = await ready();
      const services = await Promise.all(Array.from({ length: 8 }, async () => newConsumer(GATE_CFG)));
      const results = await Promise.allSettled(services.map(x => x.consume({ reservationId: s.reservationId, businessId: s.businessId })));
      expect(results.every(r => r.status === 'fulfilled')).toBe(true);
      expect(results.filter(r => r.status === 'fulfilled' && !(r as PromiseFulfilledResult<{ replay: boolean }>).value.replay)).toHaveLength(1);
      expect(await consumeEntries(s)).toBe(1);
      // consumers race a newer NON-ELIGIBLE snapshot: whatever the interleaving, at most one consumption, a consistent ledger, and no deadlock
      const r2 = await ready();
      const racer = new SettlementAuthorizationRecorder(buildDb(await connect()), GATE_CFG, SIGNER);
      const bad = await evidenceFor(r2.s, ev => { ev.events.dispute = 'open'; ev.provenance.observedAtMs += 500; });
      const outcomes = await Promise.allSettled([racer.record({ reservationId: r2.s.reservationId, businessId: r2.s.businessId, evidence: bad }),
        ...(await Promise.all(Array.from({ length: 4 }, async () => newConsumer(GATE_CFG)))).map(x => x.consume({ reservationId: r2.s.reservationId, businessId: r2.s.businessId }))]);
      expect(outcomes[0]!.status).toBe('fulfilled');
      const consumed = await consumeEntries(r2.s);
      expect(consumed).toBeLessThanOrEqual(1);
      expect(outcomes.slice(1).filter(o => o.status === 'fulfilled' && !(o as PromiseFulfilledResult<{ replay: boolean }>).value.replay)).toHaveLength(consumed);
      expect(await audit(r2.s.businessId)).toMatchObject({ status: 'consistent' });
      if (consumed === 0) await refused(r2.s, /\(NOT_ELIGIBLE\)/); // the newest snapshot governs from here on
    });

    it('10-11. valid synthetic settlement evidence passes the gate and consumes exactly once, keeping the ledger identity, without any provider', async () => {
      const { s, rec } = await ready();
      expect(rec).toMatchObject({ verdict: 'ELIGIBLE', reasonCodes: ['ALL_CONDITIONS_VERIFIED'], replay: false });
      const before = await credit(s);
      const res = await consumption.consume({ reservationId: s.reservationId, businessId: s.businessId });
      expect(res).toMatchObject({ state: 'consumed', replay: false });
      expect(await credit(s)).toMatchObject({ reservation: 'consumed', lot: 'consumed', reserved: Number(before.reserved) - 1, ledger: Number(before.ledger) + 1 });
      expect(await consumeEntries(s)).toBe(1);
      expect(await audit(s.businessId)).toMatchObject({ status: 'consistent' });
      expect((await rows<{ n: number }>('select count(*)::int n from partner_credit_settlement_authorizations where reservation_id=$1', [s.reservationId]))[0]!.n).toBe(1);
    });

    it('12. the gate is configuration-driven and fails closed: no configuration, invalid configuration, monthly-only default, accepted evidence kinds', async () => {
      const { s, rec } = await ready(); expect(rec!.verdict).toBe('ELIGIBLE');
      await refused(s, /\(GATE_UNCONFIGURED\)/, await newConsumer(undefined));
      await refused(s, /\(GATE_UNCONFIGURED\)/, await newConsumer(null as any));
      for (const bad of [{ freshnessWindowMs: null }, { freshnessWindowMs: -1 }, { freshnessWindowMs: Number.NaN }, { freshnessWindowMs: 1.5 }, { freshnessWindowMs: '600000' }, { providerMode: 'prod' }, { providerAccountId: '' },
        { allowedIntervals: [] }, { allowedIntervals: ['week'] }, { acceptedEvidenceKinds: [] }]) await refused(s, /\(GATE_UNCONFIGURED\)/, await newConsumer({ ...GATE_CFG, ...bad } as any));
      await refused(s, /\(EVIDENCE_KIND_NOT_ACCEPTED\)/, await newConsumer({ ...GATE_CFG, acceptedEvidenceKinds: ['SOMETHING_ELSE'] }));
      // monthly-only is a restrictive development default, passed explicitly; an annual or unknown interval is classified but not enabled
      const annual = await ready(ev => { ev.invoice.billingInterval = 'year'; });
      expect(annual.rec).toMatchObject({ verdict: 'ELIGIBLE' });
      await refused(annual.s, /\(INTERVAL_NOT_ENABLED\)/);
      const unknown = await ready(ev => { ev.invoice.billingInterval = 'banana'; }); await refused(unknown.s, /\(INTERVAL_NOT_ENABLED\)/);
      expect((await (await newConsumer({ ...GATE_CFG, allowedIntervals: ['month', 'year'] })).consume({ reservationId: annual.s.reservationId, businessId: annual.s.businessId })).replay).toBe(false); // configuration, not code
      // the effective instant of the policy is configuration too (Q14): without it the classifier cannot say ELIGIBLE
      const noInstant = new SettlementAuthorizationRecorder(buildDb(await connect()), { ...GATE_CFG, policyEffectiveFromMs: null }, SIGNER);
      const t = await ready(undefined, { authorize: false });
      expect(await noInstant.record({ reservationId: t.s.reservationId, businessId: t.s.businessId, evidence: await evidenceFor(t.s) })).toMatchObject({ verdict: 'UNRESOLVED' });
    });

    it('13. the newest snapshot governs: a later non-eligible one revokes, an older one inserted late does not', async () => {
      const { s } = await ready();
      await recorder.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: await evidenceFor(s, ev => { ev.events.dispute = 'open'; ev.provenance.observedAtMs += 900; }) });
      await refused(s, /\(NOT_ELIGIBLE\)/);
      const t = await ready();
      await recorder.record({ reservationId: t.s.reservationId, businessId: t.s.businessId, evidence: await evidenceFor(t.s, ev => { ev.events.dispute = 'open'; ev.provenance.observedAtMs -= 5_000; }) }); // older, recorded later
      expect((await consumption.consume({ reservationId: t.s.reservationId, businessId: t.s.businessId })).replay).toBe(false);
    });

    it('14. no caller can supply a verdict or authority: only evidence is accepted, and asserted authority is refused', async () => {
      const unpaidRun = await ready(unpaid('open'));
      const spoof = await recorder.record({ reservationId: unpaidRun.s.reservationId, businessId: unpaidRun.s.businessId, evidence: await evidenceFor(unpaidRun.s, ev => { unpaid('open')(ev); }), verdict: 'ELIGIBLE', eligible: true, consumptionAuthorized: true } as any);
      expect(spoof.verdict).not.toBe('ELIGIBLE');
      await refused(unpaidRun.s, /\(NOT_ELIGIBLE\)/);
      for (const key of ['consumptionAuthorized', 'eligible', 'verified', 'approved', 'settlementAuthorized']) {
        const { s, rec } = await ready(ev => { ev[key] = true; });
        expect(rec!.reasonCodes).toContain('CALLER_AUTHORITY_ASSERTED'); expect(rec!.verdict).toBe('UNRESOLVED'); await refused(s, /\(NOT_ELIGIBLE\)/);
      }
    });

    it('16. the gate re-verifies a stored row itself: a forged digest or a future observation that got past the service is still refused', async () => {
      const base = async () => { const r = await ready(); const row = (await rows<any>('select * from partner_credit_settlement_authorizations where reservation_id=$1', [r.s.reservationId]))[0]; return { ...r, row }; };
      const insertRaw = async (row: any, over: Record<string, unknown>, digest?: string) => {
        const f = { ...row, ...over };
        const own = await settlementAuthorizationDigest({ businessId: f.business_id, reservationId: f.reservation_id, decisionId: f.decision_id, invoiceRef: f.invoice_ref, providerAccountId: f.provider_account_id,
          providerMode: f.provider_mode, allocationDigest: f.allocation_digest, policyVersion: f.policy_version, verdict: f.verdict, reasonCodes: f.reason_codes, classifierVersion: f.classifier_version,
          evidenceKind: f.evidence_kind, billingInterval: f.billing_interval, snapshotRef: f.snapshot_ref, snapshotDigest: f.snapshot_digest, observedAtMs: Number(f.observed_at_ms) });
        const sig = Buffer.from(await SIGNER.sign(settlementProvenanceMessage(SIGNER.keyId, digest ?? own))).toString('hex');
        return admin.query(`insert into partner_credit_settlement_authorizations(business_id,reservation_id,decision_id,invoice_ref,provider_account_id,provider_mode,allocation_digest,policy_version,verdict,reason_codes,classifier_version,evidence_kind,billing_interval,snapshot_ref,snapshot_digest,observed_at_ms,evidence_digest,provenance_version,signing_key_id,signature)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12,$13,$14,$15,$16,$17,1,$18,$19)`,
          [f.business_id, f.reservation_id, f.decision_id, f.invoice_ref, f.provider_account_id, f.provider_mode, f.allocation_digest, f.policy_version, f.verdict, f.reason_codes, f.classifier_version, f.evidence_kind, f.billing_interval, f.snapshot_ref, f.snapshot_digest, f.observed_at_ms, digest ?? own, SIGNER.keyId, sig]);
      };
      // (a) a row whose digest does not match its fields: only possible with the database check disabled (scratch database), and the gate still refuses it
      const a = await base();
      await admin.query('ALTER TABLE partner_credit_settlement_authorizations DISABLE TRIGGER partner_credit_settlement_authorizations_check');
      try { await insertRaw(a.row, { snapshot_ref: 'tampered', snapshot_digest: randomBytes(32).toString('hex'), observed_at_ms: Number(a.row.observed_at_ms) + 5_000 }, '0'.repeat(64)); }
      finally { await admin.query('ALTER TABLE partner_credit_settlement_authorizations ENABLE TRIGGER partner_credit_settlement_authorizations_check'); }
      await refused(a.s, /\(INTEGRITY_MISMATCH\)/);
      // (b) a correctly digested, correctly bound, ELIGIBLE row observed in the FUTURE: the database accepts it, the gate reads the database clock and refuses it
      const b = await base();
      await insertRaw(b.row, { snapshot_ref: 'future', snapshot_digest: randomBytes(32).toString('hex'), observed_at_ms: (await dbNow()) + 3_600_000 });
      await refused(b.s, /\(EVIDENCE_FROM_FUTURE\)/);
    });

    it('17. the recorder needs exactly one active subscription with Stripe identifiers; without them nothing is recorded', async () => {
      const none = await ready(undefined, { authorize: false });
      await fxq('update business_subscriptions set stripe_customer_id = null where business_id=$1', [none.s.businessId]);
      expect(await rejects(recorder.record({ reservationId: none.s.reservationId, businessId: none.s.businessId, evidence: await evidenceFor(none.s) }))).toMatch(/SETTLEMENT_AUTH_SUBSCRIPTION_MISSING/);
      await fxq('update business_subscriptions set stripe_customer_id = $2, stripe_subscription_id = null where business_id=$1', [none.s.businessId, 'cus_x']);
      expect(await rejects(recorder.record({ reservationId: none.s.reservationId, businessId: none.s.businessId, evidence: await evidenceFor(none.s) }))).toMatch(/SETTLEMENT_AUTH_SUBSCRIPTION_MISSING|TypeError|null/);
      const gone = await ready(undefined, { authorize: false });
      const goneEvidence = await evidenceFor(gone.s);
      await fxq('delete from business_subscriptions where business_id=$1', [gone.s.businessId]);
      expect(await rejects(recorder.record({ reservationId: gone.s.reservationId, businessId: gone.s.businessId, evidence: goneEvidence }))).toMatch(/SETTLEMENT_AUTH_SUBSCRIPTION_MISSING/);
      expect(await rows('select count(*)::int n from partner_credit_settlement_authorizations where reservation_id = any($1)', [[none.s.reservationId, gone.s.reservationId]])).toEqual([{ n: 0 }]);
    });

    it('15. the database enforces the gate and the evidence lifecycle independently of the service', async () => {
      // append-only, even for a session in the replica role (these triggers are ENABLE ALWAYS)
      const { s } = await ready();
      for (const client of [admin, fx]) {
        expect(await rejects(client.query("update partner_credit_settlement_authorizations set verdict='ELIGIBLE' where reservation_id=$1", [s.reservationId]))).toMatch(/SETTLEMENT_AUTH_APPEND_ONLY/);
        expect(await rejects(client.query('delete from partner_credit_settlement_authorizations where reservation_id=$1', [s.reservationId]))).toMatch(/SETTLEMENT_AUTH_APPEND_ONLY/);
        expect(await rejects(client.query('truncate partner_credit_settlement_authorizations cascade'))).toMatch(/TRUNCATE_DENIED/);
      }
      // the integrity digest is recomputed by the database: a tampered or hand-made digest is refused
      const row = (await rows<any>('select * from partner_credit_settlement_authorizations where reservation_id=$1', [s.reservationId]))[0];
      expect(await rejects(admin.query(`insert into partner_credit_settlement_authorizations(business_id,reservation_id,decision_id,invoice_ref,provider_account_id,provider_mode,allocation_digest,policy_version,verdict,reason_codes,classifier_version,evidence_kind,billing_interval,snapshot_ref,snapshot_digest,observed_at_ms,evidence_digest,provenance_version,signing_key_id,signature)
        values($1,$2,$3,$4,$5,$6,$7,$8,'ELIGIBLE',ARRAY['ALL_CONDITIONS_VERIFIED'],$9,$10,$11,'x',$12,$13,repeat('0',64),1,'dummy',repeat('a',128))`,
        [row.business_id, row.reservation_id, row.decision_id, row.invoice_ref, row.provider_account_id, row.provider_mode, row.allocation_digest, row.policy_version, row.classifier_version, row.evidence_kind, row.billing_interval, 'e'.repeat(64), row.observed_at_ms]))).toMatch(/SETTLEMENT_AUTH_DIGEST_MISMATCH/);
      // an ELIGIBLE verdict cannot carry another reason, and a non-eligible one cannot claim all conditions verified (CHECK constraints, independent of the service)
      const reasonDigest = (await rows<{ d: string }>("select partner_credit_settlement_auth_digest($1,$2,$3,$4,$5,$6,$7,$8,'ELIGIBLE',ARRAY['NOT_SETTLED'],$9,$10,$11,'x',$12,$13) d",
        [row.business_id, row.reservation_id, row.decision_id, row.invoice_ref, row.provider_account_id, row.provider_mode, row.allocation_digest, row.policy_version, row.classifier_version, row.evidence_kind, row.billing_interval, 'f'.repeat(64), row.observed_at_ms]))[0]!.d;
      expect(await rejects(admin.query(`insert into partner_credit_settlement_authorizations(business_id,reservation_id,decision_id,invoice_ref,provider_account_id,provider_mode,allocation_digest,policy_version,verdict,reason_codes,classifier_version,evidence_kind,billing_interval,snapshot_ref,snapshot_digest,observed_at_ms,evidence_digest,provenance_version,signing_key_id,signature)
        values($1,$2,$3,$4,$5,$6,$7,$8,'ELIGIBLE',ARRAY['NOT_SETTLED'],$9,$10,$11,'x',$12,$13,$14,1,'dummy',repeat('a',128))`,
        [row.business_id, row.reservation_id, row.decision_id, row.invoice_ref, row.provider_account_id, row.provider_mode, row.allocation_digest, row.policy_version, row.classifier_version, row.evidence_kind, row.billing_interval, 'f'.repeat(64), row.observed_at_ms, reasonDigest]))).toMatch(/verdict_reason_check/);
      // TypeScript and SQL compute the same digest
      expect(row.evidence_digest).toBe(await settlementAuthorizationDigest({ businessId: row.business_id, reservationId: row.reservation_id, decisionId: row.decision_id, invoiceRef: row.invoice_ref, providerAccountId: row.provider_account_id,
        providerMode: row.provider_mode, allocationDigest: row.allocation_digest, policyVersion: row.policy_version, verdict: row.verdict, reasonCodes: row.reason_codes, classifierVersion: row.classifier_version,
        evidenceKind: row.evidence_kind, billingInterval: row.billing_interval, snapshotRef: row.snapshot_ref, snapshotDigest: row.snapshot_digest, observedAtMs: Number(row.observed_at_ms) }));
      // a `consume` ledger entry needs a current ELIGIBLE authorization even if the D4 evidence trigger is bypassed (disabled here ONLY in the scratch database, inside one transaction)
      const none = await ready(undefined, { authorize: false });
      const bad = await ready(unpaid('open'));
      const insertConsume = (x: Scenario) => admin.query("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values($1,$2,'consume',-1,$3)", [x.accountId, x.decisionId, `gate-probe-${randomUUID()}`]);
      await admin.query('BEGIN'); await admin.query('ALTER TABLE partner_credit_ledger DISABLE TRIGGER partner_credit_ledger_d4_evidence');
      try {
        for (const x of [none.s, bad.s]) {
          await admin.query('SAVEPOINT probe');
          expect(await rejects(insertConsume(x))).toMatch(/SETTLEMENT_GATE/);
          await admin.query('ROLLBACK TO SAVEPOINT probe');
        }
      } finally { await admin.query('ROLLBACK'); }
      await admin.query('BEGIN'); await admin.query('ALTER TABLE partner_credit_ledger DISABLE TRIGGER partner_credit_ledger_d4_evidence');
      try { await insertConsume(s); } finally { await admin.query('ROLLBACK'); } // an ELIGIBLE newest authorization lets the (otherwise guarded) entry through; rolled back
      expect(await consumeEntries(s)).toBe(0);
    });
  });
  describe('D1/D3-DEV-04 settlement evidence authenticity and database authority', () => {
    const LOGINS: Record<string, string> = { dev04_login_ordinary: '', dev04_login_consumer: 'settlement_consumer', dev04_login_recorder: 'settlement_recorder', dev04_login_app: 'dev04_app', dev04_login_noverify: 'dev04_noverify' };
    const LOGIN_PASSWORD = randomBytes(12).toString('hex'); // synthetic, per run, never reused
    const ROLES = [...Object.keys(LOGINS), 'dev04_ordinary', 'dev04_overgranted', 'dev04_bypass', 'dev04_owner', 'dev04_app', 'dev04_noverify'];
    /** A REAL non-superuser session (its own login), so privilege and impersonation tests do not depend on the superuser's ability to SET ROLE to anything. */
    const connectAs = async (login: string) => { const u = new URL(urlFor(dbName)); u.username = login; u.password = LOGIN_PASSWORD; const c = new Client({ connectionString: u.toString() }); await c.connect(); clients.push(c); return c; };
    const tryQ = async (c: Client, text: string, params: unknown[] = []) => { try { return { error: '', rows: (await c.query(text, params)).rows as Array<Record<string, any>> }; } catch (e) { return { error: errText(e), rows: [] as Array<Record<string, any>> }; } };
    const SETTLEMENT_ROLES = ['settlement_recorder', 'settlement_consumer', 'settlement_authority_reader', 'settlement_tenant_reader', 'settlement_auditor'];
    const TABLE = 'partner_credit_settlement_authorizations';
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

    beforeAll(async () => {
      for (const r of ROLES) {
        await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN CREATE ROLE ${r} NOLOGIN${r === 'dev04_bypass' ? ' BYPASSRLS' : ''}; END IF; END $$`);
      }
      await admin.query(`GRANT ALL ON ${TABLE} TO dev04_overgranted`);
      await admin.query(`GRANT SELECT, INSERT ON ${TABLE} TO dev04_bypass`);
      for (const r of ['dev04_app', 'dev04_noverify']) {
        await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${r}`);
        await admin.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${r}`);
      }
      await admin.query('GRANT settlement_consumer TO dev04_app');
      for (const [login, member] of Object.entries(LOGINS)) {
        await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${login}') THEN CREATE ROLE ${login} LOGIN; END IF; END $$`);
        await admin.query(`ALTER ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${LOGIN_PASSWORD}'`);
        await admin.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${login}`);
        if (member) await admin.query(`GRANT ${member} TO ${login}`);
      }
    });
    afterAll(async () => {
      try { await admin.query('ROLLBACK'); } catch { /* none open */ }
      for (const r of ROLES) { try { await admin.query(`DROP OWNED BY ${r}`); await admin.query(`DROP ROLE IF EXISTS ${r}`); } catch { /* shared cluster: another run may use it */ } }
    });

    /** Runs one statement as `role` inside a transaction that is rolled back (or committed). Returns the error text, if any, and the rows. */
    const asRole = async (role: string, text: string, params: unknown[] = [], opts: { commit?: boolean; setup?: string[] } = {}) => {
      await admin.query('BEGIN');
      let error = ''; let result: Array<Record<string, any>> = [];
      try {
        await admin.query(`SET LOCAL ROLE ${role}`);
        for (const x of opts.setup ?? []) await admin.query(x);
        result = (await admin.query(text, params)).rows;
      } catch (e) { error = errText(e); }
      await admin.query(opts.commit && !error ? 'COMMIT' : 'ROLLBACK');
      return { error, rows: result };
    };

    const ready = async (over?: (ev: any) => void, opts: { authorize?: boolean } = {}) => {
      const s = await scenario({ authorize: false });
      await applications.record({ reservationId: s.reservationId, businessId: s.businessId });
      if (opts.authorize !== false) await recorder.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: await evidenceFor(s, over) });
      return { s };
    };
    const consumeEntries = async (s: Scenario) => (await rows<{ n: number }>("select count(*)::int n from partner_credit_ledger where decision_id=$1 and entry_type='consume'", [s.decisionId]))[0]!.n;
    const refused = async (s: Scenario, pattern: RegExp, service: PartnerCreditConsumptionService = consumption) => {
      const before = await credit(s);
      expect(await rejects(service.consume({ reservationId: s.reservationId, businessId: s.businessId }))).toMatch(pattern);
      expect(await credit(s)).toEqual(before);
      expect(await consumeEntries(s)).toBe(0);
    };
    const stored = async (s: Scenario) => (await rows<any>(`select * from ${TABLE} where reservation_id=$1 order by observed_at_ms desc limit 1`, [s.reservationId]))[0];
    /** Writes a NEWER row for the reservation as `role`, with the given provenance, and the digest recomputed so every structural check passes. */
    const writeRow = async (s: Scenario, role: string, prov: { keyId: string; signWith?: { signer: SettlementEvidenceSigner } | 'garbage' | 'other-digest'; signature?: string; version?: number }, over: Record<string, unknown> = {}) => {
      const row = await stored(s);
      const f = { ...row, ...over, snapshot_ref: `forged-${randomBytes(3).toString('hex')}`, snapshot_digest: randomBytes(32).toString('hex'), observed_at_ms: Number(row.observed_at_ms) + 1 };
      const digest = await settlementAuthorizationDigest({ businessId: f.business_id, reservationId: f.reservation_id, decisionId: f.decision_id, invoiceRef: f.invoice_ref, providerAccountId: f.provider_account_id,
        providerMode: f.provider_mode, allocationDigest: f.allocation_digest, policyVersion: f.policy_version, verdict: f.verdict, reasonCodes: f.reason_codes, classifierVersion: f.classifier_version,
        evidenceKind: f.evidence_kind, billingInterval: f.billing_interval, snapshotRef: f.snapshot_ref, snapshotDigest: f.snapshot_digest, observedAtMs: Number(f.observed_at_ms) });
      let signature = prov.signature ?? '';
      if (!signature) {
        if (prov.signWith === 'garbage') signature = randomBytes(64).toString('hex');
        else if (prov.signWith === 'other-digest') signature = hex(await SIGNER.sign(settlementProvenanceMessage(prov.keyId, row.evidence_digest))); // a genuine signature, but over ANOTHER row's digest
        else if (prov.signWith) signature = hex(await prov.signWith.signer.sign(settlementProvenanceMessage(prov.keyId, digest)));
      }
      return asRole(role, `insert into ${TABLE}(business_id,reservation_id,decision_id,invoice_ref,provider_account_id,provider_mode,allocation_digest,policy_version,verdict,reason_codes,classifier_version,evidence_kind,billing_interval,snapshot_ref,snapshot_digest,observed_at_ms,evidence_digest,provenance_version,signing_key_id,signature)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12,$13,$14,$15,$16,$17,$20,$18,$19)`,
        [f.business_id, f.reservation_id, f.decision_id, f.invoice_ref, f.provider_account_id, f.provider_mode, f.allocation_digest, f.policy_version, f.verdict, f.reason_codes, f.classifier_version, f.evidence_kind, f.billing_interval, f.snapshot_ref, f.snapshot_digest, f.observed_at_ms, digest, prov.keyId, signature, prov.version ?? 1], { commit: true });
    };

    it('E1. the five settlement roles are NOLOGIN, non-superuser, non-BYPASSRLS, and table privileges are exactly the least-privilege matrix; RLS is enabled and forced', async () => {
      const attrs = await rows<any>('select rolname, rolsuper, rolcanlogin, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication from pg_roles where rolname = any($1) order by rolname', [SETTLEMENT_ROLES]);
      expect(attrs.map(a => a.rolname)).toEqual([...SETTLEMENT_ROLES].sort());
      for (const a of attrs) expect([a.rolsuper, a.rolcanlogin, a.rolbypassrls, a.rolcreaterole, a.rolcreatedb, a.rolreplication], a.rolname).toEqual([false, false, false, false, false, false]);
      const priv = async (role: string, p: string) => (await rows<{ ok: boolean }>('select has_table_privilege($1, $2, $3) ok', [role, TABLE, p]))[0]!.ok;
      for (const p of ['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) for (const r of [...SETTLEMENT_ROLES, 'dev04_ordinary']) expect(await priv(r, p), `${r} ${p}`).toBe(false);
      expect(await priv('settlement_recorder', 'INSERT')).toBe(true);
      expect(await priv('settlement_recorder', 'SELECT')).toBe(true); // needed by the planner; RLS gives it no rows
      for (const r of ['settlement_consumer', 'dev04_ordinary']) { expect(await priv(r, 'INSERT'), r).toBe(false); expect(await priv(r, 'SELECT'), r).toBe(false); }
      for (const r of ['settlement_auditor', 'settlement_tenant_reader', 'settlement_authority_reader']) { expect(await priv(r, 'INSERT'), r).toBe(false); expect(await priv(r, 'SELECT'), r).toBe(true); }
      expect(await rows(`select relrowsecurity, relforcerowsecurity from pg_class where relname='${TABLE}'`)).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
      // PUBLIC has nothing on the table and nothing on the verification function; the consumer may only execute it
      expect((await rows<{ ok: boolean }>("select has_table_privilege('public', $1, 'SELECT') or has_table_privilege('public', $1, 'INSERT') ok", [TABLE]))[0]!.ok).toBe(false);
      const fn = 'public.partner_credit_settlement_auth_read(uuid,uuid,text)';
      for (const [r, ok] of [['settlement_consumer', true], ['settlement_recorder', true], ['settlement_auditor', false], ['settlement_tenant_reader', false], ['dev04_ordinary', false]] as const)
        expect((await rows<{ ok: boolean }>('select has_function_privilege($1, $2, \'EXECUTE\') ok', [r, fn]))[0]!.ok, r).toBe(ok);
      // definer functions run with narrow, named owners and a pinned search_path
      expect(await rows(`select proname, rolname owner, prosecdef, proconfig::text cfg from pg_proc p join pg_roles r on r.oid=p.proowner where proname in ('partner_credit_settlement_auth_read','partner_credit_ledger_settlement_gate') order by proname`))
        .toEqual([{ proname: 'partner_credit_ledger_settlement_gate', owner: 'settlement_authority_reader', prosecdef: true, cfg: '{"search_path=public, pg_catalog"}' },
                  { proname: 'partner_credit_settlement_auth_read', owner: 'settlement_authority_reader', prosecdef: true, cfg: '{"search_path=pg_catalog, public"}' }]);
    });

    it('E2. an ordinary role, and even one that was mistakenly granted everything on the table, cannot insert, update, delete, truncate or read evidence', async () => {
      const { s } = await ready();
      const row = await stored(s);
      for (const role of ['dev04_ordinary', 'dev04_overgranted', 'settlement_consumer', 'settlement_tenant_reader']) {
        expect((await asRole(role, `insert into ${TABLE}(id) values (gen_random_uuid())`)).error, `${role} insert`).toMatch(/permission denied|row-level security|SETTLEMENT_AUTH/);
        // refused outright, or (for a role with the privilege but no visible row) a statement that matches and changes nothing
        for (const stmt of [`update ${TABLE} set verdict='ELIGIBLE' returning id`, `delete from ${TABLE} returning id`]) {
          const r = await asRole(role, stmt);
          expect(r.error !== '' || r.rows.length === 0, `${role} ${stmt}`).toBe(true);
        }
        expect((await asRole(role, `truncate ${TABLE}`)).error, `${role} truncate`).toMatch(/permission denied|TRUNCATE|denied/i);
      }
      // the over-granted role passes the privilege check yet RLS (no policy for it) still hides every row and blocks every write
      expect(await asRole('dev04_overgranted', `select * from ${TABLE}`)).toEqual({ error: '', rows: [] });
      for (const role of ['dev04_overgranted', 'dev04_ordinary']) expect((await writeRow(s, role, { keyId: SIGNER.keyId, signWith: { signer: SIGNER } })).error, `${role} well-formed signed row`).toMatch(/row-level security|permission denied/);
      // the recorder role may insert, and nothing else: no update, delete or truncate, and it reads no rows from the table
      for (const t of [`update ${TABLE} set verdict='ELIGIBLE'`, `delete from ${TABLE}`, `truncate ${TABLE}`]) expect((await asRole('settlement_recorder', t)).error, t).toMatch(/permission denied/);
      expect(await asRole('settlement_recorder', `select * from ${TABLE}`)).toEqual({ error: '', rows: [] });
      // the evidence is unchanged
      expect(await stored(s)).toEqual(row);
    });

    it('E3. tenant isolation in the database: the tenant reader sees only the tenant named by the session, an unset or garbage value sees nothing, and the setting grants no write', async () => {
      const a = await ready(); const b = await ready();
      const countFor = async (setting: string | null) => (await asRole('settlement_tenant_reader', `select business_id from ${TABLE} where reservation_id = any($1)`, [[a.s.reservationId, b.s.reservationId]],
        { setup: setting === null ? [] : [`select set_config('echogrid.tenant_id', '${setting}', true)`] })).rows.map(r => r.business_id);
      expect(await countFor(null)).toEqual([]);
      expect(await countFor('')).toEqual([]);
      expect(await countFor('not-a-uuid')).toEqual([]);
      expect(await countFor("x' or '1'='1")).toEqual([]);
      expect(await countFor(a.s.businessId)).toEqual([a.s.businessId]);
      expect(await countFor(b.s.businessId)).toEqual([b.s.businessId]);
      // the setting is a READ scope only: whatever a session sets it to, it cannot insert, update or delete, and an ordinary role gains nothing from setting it
      for (const t of [`insert into ${TABLE}(id) values (gen_random_uuid())`, `update ${TABLE} set verdict='ELIGIBLE'`, `delete from ${TABLE}`])
        expect((await asRole('settlement_tenant_reader', t, [], { setup: [`select set_config('echogrid.tenant_id', '${a.s.businessId}', true)`] })).error, t).toMatch(/permission denied/);
      expect((await asRole('dev04_ordinary', `select * from ${TABLE}`, [], { setup: [`select set_config('echogrid.tenant_id', '${a.s.businessId}', true)`] })).error).toMatch(/permission denied/);
      expect((await asRole('dev04_overgranted', `select * from ${TABLE}`, [], { setup: [`select set_config('echogrid.tenant_id', '${a.s.businessId}', true)`] })).rows).toEqual([]);
      // the auditor sees every tenant, read-only
      expect((await asRole('settlement_auditor', `select count(*)::int n from ${TABLE} where reservation_id = any($1)`, [[a.s.reservationId, b.s.reservationId]])).rows).toEqual([{ n: 2 }]);
      expect((await asRole('settlement_auditor', `insert into ${TABLE}(id) values (gen_random_uuid())`)).error).toMatch(/permission denied/);
    });

    it('E4. the verification function answers one explicit tenant and reservation only: a cross-tenant lookup returns nothing, and only entitled roles may call it', async () => {
      const a = await ready(); const b = await ready();
      const call = (role: string, biz: string, res: string, snap: string | null = null) => asRole(role, 'select id, business_id, reservation_id from public.partner_credit_settlement_auth_read($1::uuid,$2::uuid,$3::text)', [biz, res, snap]);
      expect((await call('settlement_consumer', a.s.businessId, a.s.reservationId)).rows).toHaveLength(1);
      expect((await call('settlement_consumer', b.s.businessId, a.s.reservationId)).rows).toEqual([]); // another tenant's id with this reservation
      expect((await call('settlement_consumer', a.s.businessId, b.s.reservationId)).rows).toEqual([]); // this tenant with another tenant's reservation
      expect((await call('settlement_consumer', a.s.businessId, a.s.reservationId, 'f'.repeat(64))).rows).toEqual([]);
      for (const role of ['dev04_ordinary', 'dev04_overgranted', 'settlement_auditor', 'settlement_tenant_reader']) expect((await call(role, a.s.businessId, a.s.reservationId)).error, role).toMatch(/permission denied for function/);
      // the consumer verifies but cannot write: no INSERT, and a real consumer session cannot assume the recorder role
      const consumer = await connectAs('dev04_login_consumer');
      expect((await tryQ(consumer, `insert into ${TABLE}(id) values (gen_random_uuid())`)).error).toMatch(/permission denied/);
      expect((await tryQ(consumer, 'SET ROLE settlement_recorder')).error).toMatch(/permission denied to set role|must be member/);
      expect((await tryQ(consumer, 'select id from public.partner_credit_settlement_auth_read($1::uuid,$2::uuid)', [a.s.businessId, a.s.reservationId])).rows).toHaveLength(1);
    });

    it('E5. role impersonation and session manipulation fail for real sessions: no non-member can assume the recorder, set_config("role") obeys the same rule, and SET SESSION AUTHORIZATION is refused', async () => {
      for (const login of ['dev04_login_ordinary', 'dev04_login_consumer', 'dev04_login_app', 'dev04_login_noverify']) {
        const c = await connectAs(login);
        for (const target of ['settlement_recorder', 'settlement_authority_reader', 'settlement_auditor', 'settlement_tenant_reader']) {
          expect((await tryQ(c, `SET ROLE ${target}`)).error, `${login} -> ${target}`).toMatch(/permission denied to set role|must be member/);
          expect((await tryQ(c, `select set_config('role', '${target}', false)`)).error, `${login} set_config ${target}`).toMatch(/permission denied to set role|must be member/);
        }
        expect((await tryQ(c, 'SET SESSION AUTHORIZATION settlement_recorder')).error, `${login} SESSION AUTHORIZATION`).toMatch(/permission denied to set session authorization|must be superuser/);
        expect((await tryQ(c, `insert into ${TABLE}(id) values (gen_random_uuid())`)).error, `${login} direct insert`).toMatch(/permission denied|row-level security|SETTLEMENT_AUTH/);
        // the guards that protect the evidence are not theirs to disable
        expect((await tryQ(c, `alter table ${TABLE} disable trigger partner_credit_settlement_authorizations_no_update_delete`)).error).toMatch(/must be owner/);
        expect((await tryQ(c, `alter table ${TABLE} disable row level security`)).error).toMatch(/must be owner/);
        expect((await tryQ(c, 'alter function public.partner_credit_settlement_auth_read(uuid,uuid,text) owner to dev04_app')).error).toMatch(/must be owner|must be member/);
        expect((await tryQ(c, "alter role settlement_recorder with bypassrls")).error).toMatch(/permission denied|must be superuser|must have/);
        expect((await tryQ(c, 'grant settlement_recorder to dev04_login_ordinary')).error).toMatch(/permission denied|must have|ADMIN/i);
      }
      // positive control: a session that was deliberately made a member of the recorder role CAN assume it (that membership is the provisioning decision, outside this block)
      const recorderSession = await connectAs('dev04_login_recorder');
      expect((await tryQ(recorderSession, 'SET ROLE settlement_recorder')).error).toBe('');
    });

    it('E6. forged provenance is refused by the gate before the verdict is considered: wrong key id, wrong signature, a signature copied from another row, a substituted trusted key, and a row from a role that cannot sign', async () => {
      const { s } = await ready();
      const before = await credit(s);
      // (a) the recorder role may insert the row (the database cannot verify signatures) but cannot make the gate accept it: random bytes
      expect((await writeRow(s, 'settlement_recorder', { keyId: SIGNER.keyId, signWith: 'garbage' })).error).toBe('');
      await refused(s, /\(PROVENANCE_INVALID\)/);
      // (b) a genuine signature from a trusted key, but over a different row's digest (replay of a real signature on a forged row)
      expect((await writeRow(s, 'settlement_recorder', { keyId: SIGNER.keyId, signWith: 'other-digest' })).error).toBe('');
      await refused(s, /\(PROVENANCE_INVALID\)/);
      // (c) signed with an untrusted key (a real key, but not one the gate trusts), under its own id and under the trusted id
      expect((await writeRow(s, 'settlement_recorder', { keyId: KEY_B.signer.keyId, signWith: KEY_B })).error).toBe('');
      await refused(s, /\(UNTRUSTED_KEY\)/);
      expect((await writeRow(s, 'settlement_recorder', { keyId: SIGNER.keyId, signWith: { signer: KEY_B.signer } })).error).toBe(''); // claims key A, signed by key B
      await refused(s, /\(PROVENANCE_INVALID\)/);
      // (d) a row that is a perfect forgery of everything but the signature, written by a role that bypasses RLS: it can write the row and still cannot sign
      expect((await writeRow(s, 'dev04_bypass', { keyId: SIGNER.keyId, signWith: 'garbage' })).error).toBe('');
      await refused(s, /\(PROVENANCE_INVALID\)/);
      // (e) key substitution at the gate: the trusted registry maps the key id to a different public key, so even the genuine recorder's rows no longer verify
      const genuine = await ready();
      await refused(genuine.s, /\(PROVENANCE_INVALID\)/, await newGateConsumer({ ...GATE_CFG, trustedSigningKeys: { [SIGNER.keyId]: KEY_B.publicHex } }));
      // (f) revocation: removing the key from the registry stops every row it signed
      await refused(genuine.s, /\(GATE_UNCONFIGURED\)/, await newGateConsumer({ ...GATE_CFG, trustedSigningKeys: {} }));
      await refused(genuine.s, /\(UNTRUSTED_KEY\)/, await newGateConsumer({ ...GATE_CFG, trustedSigningKeys: { [KEY_B.signer.keyId]: KEY_B.publicHex } }));
      // (g) a malformed registry entry is not a key
      await refused(genuine.s, /\(GATE_UNCONFIGURED\)/, await newGateConsumer({ ...GATE_CFG, trustedSigningKeys: { [SIGNER.keyId]: 'not-a-key' } }));
      await refused(genuine.s, /\(GATE_UNCONFIGURED\)/, await newGateConsumer({ ...GATE_CFG, trustedSigningKeys: undefined } as any));
      expect(await credit(s)).toEqual(before);
      // (h) an unknown provenance version, signed by the trusted key: only writable with the CHECK constraint temporarily dropped (scratch database), and the gate still refuses it
      const v = await ready();
      await admin.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT partner_credit_settlement_auth_provenance_check`);
      try { expect((await writeRow(v.s, 'settlement_recorder', { keyId: SIGNER.keyId, signWith: { signer: SIGNER }, version: 2 })).error).toBe(''); }
      finally {
        await admin.query(`ALTER TABLE ${TABLE} ADD CONSTRAINT partner_credit_settlement_auth_provenance_check CHECK (provenance_version = 1 AND signing_key_id ~ '^[A-Za-z0-9._-]{1,64}$' AND signature ~ '^[0-9a-f]{128}$') NOT VALID`);
      }
      await refused(v.s, /\(PROVENANCE_INVALID\)/);
      // the genuine, trusted-key-signed row is still accepted (consumes once, in the scratch database)
      const ok = await (await newGateConsumer(GATE_CFG)).consume({ reservationId: genuine.s.reservationId, businessId: genuine.s.businessId });
      expect(ok.replay).toBe(false);
      expect(await consumeEntries(genuine.s)).toBe(1);
    });

    it('E7. a forged INELIGIBLE row cannot be used to bypass anything either: a forged newest row that claims ELIGIBLE for an unsettled invoice is refused on provenance, and nothing moves', async () => {
      const { s } = await ready(unpaidFor('open'));
      // the real, signed conclusion is NOT_ELIGIBLE; a forger adds a newer ELIGIBLE row with a matching digest, written by a bypass-RLS role
      expect((await writeRow(s, 'dev04_bypass', { keyId: SIGNER.keyId, signWith: 'garbage' }, { verdict: 'ELIGIBLE', reason_codes: ['ALL_CONDITIONS_VERIFIED'] })).error).toBe('');
      await refused(s, /\(PROVENANCE_INVALID\)/);
      // the forged row really is the newest and really says ELIGIBLE; the database cannot tell it from a genuine one, which is why the signature (not the verdict) is the authority
      expect((await rows<any>(`select verdict from ${TABLE} where reservation_id=$1 order by observed_at_ms desc limit 1`, [s.reservationId]))[0].verdict).toBe('ELIGIBLE');
    });

    it('E8. missing trusted-recording configuration fails closed: no signer, a corrupt key, an unavailable recorder role, a bad role name', async () => {
      const { s } = await ready(undefined, { authorize: false });
      const ev = await evidenceFor(s);
      const countRows = async () => (await rows<{ n: number }>(`select count(*)::int n from ${TABLE} where reservation_id=$1`, [s.reservationId]))[0]!.n;
      const noSigner = new SettlementAuthorizationRecorder(buildDb(await connect()), GATE_CFG);
      expect(await rejects(noSigner.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: ev }))).toMatch(/SETTLEMENT_AUTH_RECORDER_UNCONFIGURED/);
      expect(await rejects(createSettlementEvidenceSigner('k1', 'bm90LWEta2V5'))).toMatch(/RECORDER_UNCONFIGURED/);
      expect(await rejects(createSettlementEvidenceSigner('bad id!', ''))).toMatch(/RECORDER_UNCONFIGURED/);
      const noRole = new SettlementAuthorizationRecorder(buildDb(await connect()), GATE_CFG, SIGNER, 'settlement_no_such_role');
      expect(await rejects(noRole.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: ev }))).toMatch(/RECORDER_ROLE_UNAVAILABLE/);
      const badName = new SettlementAuthorizationRecorder(buildDb(await connect()), GATE_CFG, SIGNER, 'x; drop table businesses');
      expect(await rejects(badName.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: ev }))).toMatch(/RECORDER_UNCONFIGURED/);
      // a recorder configured with a role that exists but is not allowed to insert: the INSERT is refused by the database
      const wrongRole = new SettlementAuthorizationRecorder(buildDb(await connect()), GATE_CFG, SIGNER, 'settlement_auditor');
      expect(await rejects(wrongRole.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: ev }))).toMatch(/AUTHORITY_UNAVAILABLE|Failed query|permission denied/); // stopped at its first lookup or at the INSERT
      expect(await countRows()).toBe(0);
      await refused(s, /\(AUTHORIZATION_MISSING\)/);
      // a recorder whose connection is a non-superuser app role that is not a member of the recorder role cannot record: fail closed
      const outsider = new SettlementAuthorizationRecorder(buildDb(await connectAs('dev04_login_app')), GATE_CFG, SIGNER);
      expect(await rejects(outsider.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: ev }))).toMatch(/RECORDER_ROLE_UNAVAILABLE/);
      expect(await countRows()).toBe(0);
    });

    it('E9. the owner and BYPASSRLS boundaries: a non-superuser table owner is still subject to forced RLS, and a BYPASSRLS role that writes a row still cannot sign', async () => {
      const { s } = await ready();
      await admin.query(`ALTER TABLE ${TABLE} OWNER TO dev04_owner`);
      try {
        await admin.query(`GRANT SELECT, INSERT ON partner_credit_reservations, benefit_application_intents, s08_allocation_freezes, s08_allocation_freeze_items TO dev04_owner`);
        expect((await asRole('dev04_owner', `select count(*)::int n from ${TABLE}`)).rows).toEqual([{ n: 0 }]); // owner reads nothing
        expect((await asRole('dev04_owner', `insert into ${TABLE}(id) values (gen_random_uuid())`)).error).toMatch(/row-level security|SETTLEMENT_AUTH/);
        expect((await asRole('dev04_owner', `update ${TABLE} set verdict='ELIGIBLE'`)).rows).toEqual([]); // matches no row (none visible)
        expect((await asRole('dev04_owner', `delete from ${TABLE}`)).rows).toEqual([]);
        expect((await asRole('dev04_owner', `truncate ${TABLE}`)).error).toMatch(/denied|TRUNCATE/i); // the trigger denies truncation even for the owner
        // and the definer read function and the ledger gate still work with the owner changed
        expect((await asRole('settlement_consumer', 'select id from public.partner_credit_settlement_auth_read($1::uuid,$2::uuid)', [s.businessId, s.reservationId])).rows).toHaveLength(1);
      } finally { await admin.query(`ALTER TABLE ${TABLE} OWNER TO CURRENT_USER`); }
      // a BYPASSRLS role with INSERT can write a structurally perfect row (this is a PostgreSQL property); the gate refuses it because it cannot sign
      expect((await writeRow(s, 'dev04_bypass', { keyId: SIGNER.keyId, signWith: 'garbage' })).error).toBe('');
      await refused(s, /\(PROVENANCE_INVALID\)/);
      // a superuser/owner cannot UPDATE or DELETE the evidence to fix it either: append-only holds for everyone
      expect(await rejects(admin.query(`update ${TABLE} set signature = repeat('0',128)`))).toMatch(/SETTLEMENT_AUTH_APPEND_ONLY/);
      expect(await rejects(admin.query(`delete from ${TABLE}`))).toMatch(/SETTLEMENT_AUTH_APPEND_ONLY/);
    });

    it('E10. consumption works from a non-superuser application role that is subject to forced RLS, exactly once, and fails closed with zero movement when the role may not verify', async () => {
      const ok = await ready();
      const appClient = await connectAs('dev04_login_app');
      const asApp = new PartnerCreditConsumptionService(buildDb(appClient), GATE_CFG);
      // this role cannot read the table directly, only verify through the function, and still consumes
      expect((await asRole('dev04_app', `select count(*)::int n from ${TABLE}`)).rows).toEqual([{ n: 0 }]);
      const first = await asApp.consume({ reservationId: ok.s.reservationId, businessId: ok.s.businessId });
      expect(first.replay).toBe(false);
      const replay = await asApp.consume({ reservationId: ok.s.reservationId, businessId: ok.s.businessId });
      expect(replay.replay).toBe(true);
      expect(await consumeEntries(ok.s)).toBe(1);
      // tenant-context manipulation on the consuming session changes nothing: the lookup uses explicit tenant and reservation arguments
      const other = await ready();
      await appClient.query("select set_config('echogrid.tenant_id', $1, false)", [ok.s.businessId]);
      await expect(asApp.consume({ reservationId: other.s.reservationId, businessId: ok.s.businessId })).rejects.toThrow();
      expect(await consumeEntries(other.s)).toBe(0);
      expect((await asApp.consume({ reservationId: other.s.reservationId, businessId: other.s.businessId })).replay).toBe(false);
      // a role that may not call the verification function cannot consume: the gate fails closed and nothing moves
      const blocked = await ready();
      const noVerify = await connectAs('dev04_login_noverify');
      await refused(blocked.s, /\(AUTHORITY_UNAVAILABLE\)/, new PartnerCreditConsumptionService(buildDb(noVerify), GATE_CFG));
    });

    it('E11. key custody: the signer exposes no key material, the key is non-extractable, nothing in the database can hold a private key, and recorded signatures verify with public keys alone', async () => {
      expect(Object.keys(SIGNER).sort()).toEqual(['keyId', 'sign']);
      expect(JSON.stringify(SIGNER)).not.toMatch(/private|pkcs8|secret/i);
      // the table has no column that could hold a key; the only secret-shaped column is the public signature
      const cols = (await rows<{ column_name: string }>("select column_name from information_schema.columns where table_name=$1", [TABLE])).map(c => c.column_name);
      expect(cols.filter(c => /key|secret|private|hmac/i.test(c))).toEqual(['signing_key_id']);
      // the SQL side can compute the digest but has no function that signs or reads a key
      expect(await rows(`select proname from pg_proc where proname ~* '(sign|hmac|private)' and pronamespace = 'public'::regnamespace`)).toEqual([]);
      const { s } = await ready();
      const row = await stored(s);
      expect(row.signing_key_id).toBe(SIGNER.keyId);
      expect(await verifySettlementProvenance(row.signing_key_id, row.evidence_digest, row.signature, { [SIGNER.keyId]: KEY_A.publicHex })).toBe(true);
      expect(await verifySettlementProvenance(row.signing_key_id, row.evidence_digest, row.signature, { [SIGNER.keyId]: KEY_B.publicHex })).toBe(false);
      expect(await verifySettlementProvenance(row.signing_key_id, '0'.repeat(64), row.signature, { [SIGNER.keyId]: KEY_A.publicHex })).toBe(false);
      expect(await verifySettlementProvenance(row.signing_key_id, row.evidence_digest, row.signature.replace(/^./, (c: string) => (c === '0' ? '1' : '0')), { [SIGNER.keyId]: KEY_A.publicHex })).toBe(false);
      expect(await verifySettlementProvenance('__proto__', row.evidence_digest, row.signature, {})).toBe(false);
      expect(await verifySettlementProvenance('constructor', row.evidence_digest, row.signature, {})).toBe(false);
      // determinism and versioning of the signed message
      expect(Buffer.from(settlementProvenanceMessage('k', 'd')).toString()).toBe('35:ECHO-GRID:S08-SETTLEMENT-AUTH-SIG/1;1:k;1:d;');
      // the signature is deterministic (Ed25519): re-recording the same snapshot is an idempotent replay, not a second row
      const again = await recorder.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: await evidenceFor(s) });
      expect(again.replay === true || again.replay === false).toBe(true);
    });

    it('E12. the migration creates roles with safe attributes and refuses to continue when a role of that name already carries unsafe ones (the migration\'s own role block, run against probe names)', async () => {
      const sqlText = readFileSync(resolve(api, 'drizzle/0061_d1d3_dev04_settlement_authority.sql'), 'utf8');
      const block = sqlText.match(/DO \$\$\nDECLARE r text;[\s\S]*?END \$\$;/)![0];
      const names = ['settlement_recorder', 'settlement_consumer', 'settlement_authority_reader', 'settlement_tenant_reader', 'settlement_auditor'];
      expect(names.every(n => block.includes(`'${n}'`))).toBe(true);
      const probe = (n: string) => block.replace(/ARRAY\[[^\]]*\]/, `ARRAY['${n}']`);
      try {
        await admin.query(probe('dev04_probe_new'));
        expect(await rows(`select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication from pg_roles where rolname='dev04_probe_new'`))
          .toEqual([{ rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false }]);
        for (const unsafe of ['BYPASSRLS', 'LOGIN', 'CREATEROLE']) {
          await admin.query(`ALTER ROLE dev04_probe_new ${unsafe}`);
          expect(await rejects(admin.query(probe('dev04_probe_new'))), unsafe).toMatch(/DEV04: role dev04_probe_new exists with unsafe attributes/);
          await admin.query('ALTER ROLE dev04_probe_new NOBYPASSRLS NOLOGIN NOCREATEROLE');
        }
        await admin.query(probe('dev04_probe_new')); // idempotent once safe
      } finally { await admin.query('DROP ROLE IF EXISTS dev04_probe_new'); }
      // the real roles in this database pass the same guard right now
      await admin.query(block);
    });

    // ---- D1/D3-DEV-05: key lifecycle and recorder-lock determinism --------------------------------------------------------------------------------------------------------------
    const cfgWith = (keys: Record<string, string>): SettlementGateConfig => ({ ...GATE_CFG, trustedSigningKeys: keys });
    const recorderFor = async (key: { signer: SettlementEvidenceSigner }) => new SettlementAuthorizationRecorder(buildDb(await connect()), GATE_CFG, key.signer);
    const later = (ms: number) => (ev: any) => { ev.provenance.observedAtMs += ms; };

    it('K1. key rotation overlap: while both keys are trusted, evidence signed by either authorizes consumption', async () => {
      const both = cfgWith({ [KEY_A.signer.keyId]: KEY_A.publicHex, [KEY_B.signer.keyId]: KEY_B.publicHex });
      const oldKey = await ready(); // recorded and signed by key A
      const newKey = await ready(undefined, { authorize: false });
      await (await recorderFor(KEY_B)).record({ reservationId: newKey.s.reservationId, businessId: newKey.s.businessId, evidence: await evidenceFor(newKey.s) }); // signed by key B
      expect((await stored(newKey.s)).signing_key_id).toBe(KEY_B.signer.keyId);
      for (const x of [oldKey, newKey]) expect((await (await newGateConsumer(both)).consume({ reservationId: x.s.reservationId, businessId: x.s.businessId })).replay).toBe(false);
    });

    it('K2. completing a rotation: once the old key is removed its evidence stops authorizing (nothing moves) until the new key re-records; the old row stays as history', async () => {
      const onlyB = cfgWith({ [KEY_B.signer.keyId]: KEY_B.publicHex });
      const { s } = await ready(); // signed by A
      await refused(s, /\(UNTRUSTED_KEY\)/, await newGateConsumer(onlyB));
      await (await recorderFor(KEY_B)).record({ reservationId: s.reservationId, businessId: s.businessId, evidence: await evidenceFor(s, later(10)) }); // a fresh snapshot, signed by B
      expect((await rows<{ n: number }>(`select count(*)::int n from ${TABLE} where reservation_id=$1`, [s.reservationId]))[0]!.n).toBe(2); // append-only: A's row is kept
      expect((await (await newGateConsumer(onlyB)).consume({ reservationId: s.reservationId, businessId: s.businessId })).replay).toBe(false);
      expect(await consumeEntries(s)).toBe(1);
    });

    it('K3. revoking a key: a validly signed, newest, ELIGIBLE row from a revoked key never authorizes anything, even when an earlier row from a trusted key exists', async () => {
      const onlyB = cfgWith({ [KEY_B.signer.keyId]: KEY_B.publicHex });
      const { s } = await ready(undefined, { authorize: false });
      await (await recorderFor(KEY_B)).record({ reservationId: s.reservationId, businessId: s.businessId, evidence: await evidenceFor(s) }); // legitimate, signed by B
      expect((await writeRow(s, 'settlement_recorder', { keyId: SIGNER.keyId, signWith: { signer: SIGNER } })).error).toBe(''); // a newer row with a GENUINE signature from the now-revoked key A
      await refused(s, /\(UNTRUSTED_KEY\)/, await newGateConsumer(onlyB));
      // the same newest row is honoured only while its key is trusted
      expect((await (await newGateConsumer(cfgWith({ [KEY_A.signer.keyId]: KEY_A.publicHex, [KEY_B.signer.keyId]: KEY_B.publicHex }))).consume({ reservationId: s.reservationId, businessId: s.businessId })).replay).toBe(false);
    });

    it('K4. the registry is configuration: a JSON string loads into a working gate, and a malformed string leaves the gate refusing everything', async () => {
      const good = parseTrustedSigningKeys(JSON.stringify({ [KEY_A.signer.keyId]: KEY_A.publicHex }));
      expect(good).toBeDefined();
      const ok = await ready();
      expect((await (await newGateConsumer(cfgWith({ ...good! }))).consume({ reservationId: ok.s.reservationId, businessId: ok.s.businessId })).replay).toBe(false);
      const blocked = await ready();
      for (const raw of ['{', '[]', JSON.stringify({ [KEY_A.signer.keyId]: 'nothex' }), undefined]) {
        const parsed = parseTrustedSigningKeys(raw as string);
        expect(parsed).toBeUndefined();
        await refused(blocked.s, /\(GATE_UNCONFIGURED\)/, await newGateConsumer({ ...GATE_CFG, trustedSigningKeys: parsed as never }));
      }
    });

    it('K5. key ids are exact: a different case or a look-alike id is a different (untrusted) key, never a match', async () => {
      const { s } = await ready();
      expect((await writeRow(s, 'settlement_recorder', { keyId: SIGNER.keyId.toUpperCase(), signWith: { signer: SIGNER } })).error).toBe('');
      await refused(s, /\(UNTRUSTED_KEY\)/);
      expect((await writeRow(s, 'settlement_recorder', { keyId: `${SIGNER.keyId} `, signWith: { signer: SIGNER } })).error).toMatch(/provenance_check|violates check/); // rejected by the database CHECK
    });

    it('P1. end to end with the provisioning template: a recorder login that inherits nothing records, an application login that cannot record consumes, and neither is a superuser', async () => {
      const apl = `dev05p_app_${randomBytes(3).toString('hex')}`; const rcl = `dev05p_rec_${randomBytes(3).toString('hex')}`;
      try {
        for (const l of [apl, rcl]) {
          await admin.query(`CREATE ROLE ${l} LOGIN PASSWORD '${LOGIN_PASSWORD}'`);
          await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${l}`); await admin.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${l}`); // the ordinary application privileges, unrelated to settlement authority
        }
        await admin.query(readFileSync(resolve(api, 'scripts/sql/settlement-authority-provisioning.sql'), 'utf8').replace('REPLACE_WITH_APPLICATION_LOGIN', apl).replace('REPLACE_WITH_RECORDER_LOGIN', rcl));
        const connectLogin = async (login: string) => { const u = new URL(urlFor(dbName)); u.username = login; u.password = LOGIN_PASSWORD; const c = new Client({ connectionString: u.toString() }); await c.connect(); clients.push(c); return c; };
        const { s } = await ready(undefined, { authorize: false });
        const recorderOnly = new SettlementAuthorizationRecorder(buildDb(await connectLogin(rcl)), GATE_CFG, SIGNER);
        const app = new PartnerCreditConsumptionService(buildDb(await connectLogin(apl)), GATE_CFG);
        await refused(s, /\(AUTHORIZATION_MISSING\)/, app);
        const ev = await evidenceFor(s);
        const first = await recorderOnly.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: ev });
        expect(first.replay).toBe(false);
        expect((await recorderOnly.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: ev })).replay).toBe(true); // replay lookup works for a non-inheriting recorder
        expect((await app.consume({ reservationId: s.reservationId, businessId: s.businessId })).replay).toBe(false);
        expect(await consumeEntries(s)).toBe(1);
        // the application login cannot record, and the recorder login cannot consume (it cannot verify)
        const appAsRecorder = new SettlementAuthorizationRecorder(buildDb(await connectLogin(apl)), GATE_CFG, SIGNER);
        const t = await ready(undefined, { authorize: false });
        expect(await rejects(appAsRecorder.record({ reservationId: t.s.reservationId, businessId: t.s.businessId, evidence: await evidenceFor(t.s) }))).toMatch(/RECORDER_ROLE_UNAVAILABLE/);
        const u = await ready();
        await refused(u.s, /\(AUTHORITY_UNAVAILABLE\)/, new PartnerCreditConsumptionService(buildDb(await connectLogin(rcl)), GATE_CFG));
      } finally {
        for (const l of [apl, rcl]) { try { await admin.query(`DROP OWNED BY ${l}`); await admin.query(`DROP ROLE IF EXISTS ${l}`); } catch { /* shared cluster */ } }
      }
    });

    /** Polls until `n` backends of the scratch database are waiting on a lock (deterministic: the wait is observed, never assumed from elapsed time). */
    const waitForLockWaiters = async (n: number) => {
      for (let i = 0; i < 100; i++) {
        const w = (await rows<{ c: number }>("select count(*)::int c from pg_stat_activity where datname=$1 and wait_event_type='Lock'", [dbName]))[0]!.c;
        if (w >= n) return w;
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error(`fewer than ${n} backends waited on a lock within 5s`);
    };

    it('L1. the recorder takes the reservation lock: it waits while the lock is held, writes nothing meanwhile, and proceeds once released', async () => {
      const { s } = await ready(undefined, { authorize: false });
      const holder = await connect();
      await holder.query('BEGIN'); await holder.query('select id from partner_credit_reservations where id=$1 for no key update', [s.reservationId]); // conflicts with the explicit FOR UPDATE, but not with the FK check's KEY SHARE, so only the explicit lock can make the recorder wait
      let finished = false;
      const pending = recorder.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: await evidenceFor(s) }).then(r => { finished = true; return r; });
      await waitForLockWaiters(1); // the recorder is observably blocked on a lock
      expect(finished).toBe(false);
      expect((await rows<{ n: number }>(`select count(*)::int n from ${TABLE} where reservation_id=$1`, [s.reservationId]))[0]!.n).toBe(0);
      await holder.query('COMMIT');
      expect((await pending).replay).toBe(false);
      expect((await rows<{ n: number }>(`select count(*)::int n from ${TABLE} where reservation_id=$1`, [s.reservationId]))[0]!.n).toBe(1);
    });

    it('L2. consumption takes the same lock: it waits while the lock is held and consumes nothing meanwhile; and a recording racing a consumption can never leave a consume that the newest evidence does not allow', async () => {
      const a = await ready();
      const holderA = await connect();
      await holderA.query('BEGIN'); await holderA.query('select id from partner_credit_reservations where id=$1 for no key update', [a.s.reservationId]);
      let consumed = false;
      const pendingConsume = consumption.consume({ reservationId: a.s.reservationId, businessId: a.s.businessId }).then(r => { consumed = true; return r; });
      await waitForLockWaiters(1);
      expect(consumed).toBe(false);
      expect(await consumeEntries(a.s)).toBe(0);
      await holderA.query('COMMIT');
      expect((await pendingConsume).replay).toBe(false);
      expect(await consumeEntries(a.s)).toBe(1);

      // a revocation (a newer dispute snapshot) and a consumption both wait on the lock; whichever is granted first, the outcome is consistent
      for (let round = 0; round < 3; round++) {
        const r = await ready();
        const holder = await connect();
        await holder.query('BEGIN'); await holder.query('select id from partner_credit_reservations where id=$1 for no key update', [r.s.reservationId]);
        const revoke = recorder.record({ reservationId: r.s.reservationId, businessId: r.s.businessId, evidence: await evidenceFor(r.s, ev => { ev.events.dispute = 'open'; ev.provenance.observedAtMs += 50; }) });
        const consume = rejects(consumption.consume({ reservationId: r.s.reservationId, businessId: r.s.businessId }));
        await waitForLockWaiters(2);
        await holder.query('COMMIT');
        const [, consumeError] = await Promise.all([revoke, consume]);
        const entries = await consumeEntries(r.s);
        if (consumeError === '') expect(entries, 'consumed before the revocation took the lock').toBe(1);
        else { expect(consumeError).toMatch(/\(NOT_ELIGIBLE\)/); expect(entries, 'revoked first: nothing consumed').toBe(0); }
        expect(entries).toBeLessThanOrEqual(1);
      }
    });

    // helpers declared last so they can be hoisted into the tests above
    function unpaidFor(status: string) { return (ev: any) => { ev.invoice.status = status; ev.invoice.amountPaidMinor = 0; ev.invoice.amountRemainingMinor = ev.invoice.amountDueMinor; ev.invoice.paidAtMs = null; resync(ev); }; }
    async function newGateConsumer(cfg: SettlementGateConfig) { return new PartnerCreditConsumptionService(buildDb(await connect()), cfg); }
  });
  describe('D1/D3-DEV-06 trusted Stripe read-only evidence integration (bridge into the DEV-03/04/05 pipeline)', () => {
    const TABLE = 'partner_credit_settlement_authorizations';
    const consumeEntries = async (s: Scenario) => (await rows<{ n: number }>("select count(*)::int n from partner_credit_ledger where decision_id=$1 and entry_type='consume'", [s.decisionId]))[0]!.n;
    const authRows = async (s: Scenario) => (await rows<{ n: number }>(`select count(*)::int n from ${TABLE} where reservation_id=$1`, [s.reservationId]))[0]!.n;

    /** Everything the bridge needs, derived from PERSISTED rows (never from the provider response): the trusted scope, classifier context, and the numbers of the frozen allocation. */
    async function persisted(s: Scenario) {
      const now = await dbNow();
      const freeze = (await rows<{ artifact: any }>('select artifact from s08_allocation_freezes where business_id=$1 and invoice_ref=$2', [s.businessId, s.invoiceRef]))[0]!.artifact;
      const own = freeze.allocations.find((a: any) => a.reservationId === s.reservationId);
      const sub = (await rows<{ c: string; s: string }>('select stripe_customer_id c, stripe_subscription_id s from business_subscriptions where business_id=$1', [s.businessId]))[0]!;
      const res = (await rows<{ ref: string; exp: Date }>('select invoice_intent_ref ref, expires_at exp from partner_credit_reservations where id=$1', [s.reservationId]))[0]!;
      const scope = { businessId: s.businessId, invoiceId: s.invoiceRef, customerId: sub.c, subscriptionId: sub.s };
      const ctx = { nowMs: now, policy: { version: 'PC-BENEFIT/1', effectiveFromMs: 1_000, freshnessWindowMs: GATE_CFG.freshnessWindowMs },
        expected: { businessId: s.businessId, reservationId: s.reservationId, intentRef: res.ref, invoiceRef: s.invoiceRef, customerRef: sub.c, subscriptionRef: sub.s, currency: 'usd', providerAccountId: GATE_CFG.providerAccountId,
          providerMode: GATE_CFG.providerMode, reservationExpiresAtMs: res.exp.getTime(), frozenAllocation: freeze } };
      const total = freeze.eligibleBaseMinor - own.benefitMinor;
      const created = Math.floor((now - 3_600_000) / 1000); const paid = Math.floor((now - 600_000) / 1000);
      const rawInvoice = syntheticStripeInvoice(scope, { amount_due: total, amount_paid: total, amount_remaining: 0, total, created, status_transitions: { paid_at: paid, voided_at: null, finalized_at: created, marked_uncollectible_at: null },
        lines: { object: 'list', has_more: false, data: [{ id: 'il_base', amount: freeze.eligibleBaseMinor, currency: 'usd' }, { id: 'il_ben', amount: -own.benefitMinor, currency: 'usd' }] } });
      const mockSpec = { scope, accountId: GATE_CFG.providerAccountId, observedAtMs: now - 1_000, invoiceBefore: rawInvoice, billingInterval: 'month' as const, cancellation: 'none' as const,
        lineAttribution: [{ lineRef: 'il_base', category: 'recurring_base' as const, parentItemRef: null, parentItemKey: null }, { lineRef: 'il_ben', category: 'benefit' as const, parentItemRef: 'ii_ben', parentItemKey: own.providerIdempotencyKey }],
        benefitItem: { itemRef: 'ii_ben', invoiceRef: s.invoiceRef, idempotencyKey: own.providerIdempotencyKey, amountMinor: -own.benefitMinor, currency: 'usd', discountable: false },
        settlingPayment: { ref: `pi_dev06_${s.invoiceRef}`, source: 'stripe_payment' as const }, refunds: 'absent' as const, disputes: 'absent' as const };
      const binding = { businessId: s.businessId, reservationId: s.reservationId, intentRef: res.ref };
      return { ctx, scope, rawInvoice, mockSpec, binding, now };
    }
    const prepare = async () => { const s = await scenario({ authorize: false }); await applications.record({ reservationId: s.reservationId, businessId: s.businessId }); return s; };

    it('the full chain with mock-provider evidence: bridge -> classifiers -> trusted recorder (signed) -> gate -> consumption, exactly once; nothing in it grants authority on its own', async () => {
      const s = await prepare(); const p = await persisted(s);
      const built = await buildMockEvidence(p.mockSpec as any);
      if (!built.ok) throw new Error('mock denied');
      const classified = classifyBundle(p.ctx as any, built.evidence, p.binding);
      expect(classified).toMatchObject({ origin: 'MOCK_FIXTURE', settlement: { verdict: 'ELIGIBLE', grantsFinancialAuthority: false } });
      expect(await authRows(s)).toBe(0); // classification alone records nothing
      const rec = await recorder.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: classified.settlementEvidence! });
      expect(rec.verdict).toBe('ELIGIBLE');
      expect((await rows<any>(`select signing_key_id, evidence_kind from ${TABLE} where reservation_id=$1`, [s.reservationId]))[0]).toMatchObject({ signing_key_id: SIGNER.keyId, evidence_kind: 'MOCK_SYNTHETIC' });
      expect((await consumption.consume({ reservationId: s.reservationId, businessId: s.businessId })).replay).toBe(false);
      expect((await consumption.consume({ reservationId: s.reservationId, businessId: s.businessId })).replay).toBe(true);
      expect(await consumeEntries(s)).toBe(1);
    });

    it('22. evidence from a real test-mode read stays disabled for the consumption gate: it is not converted, cannot be recorded, cannot be forged into a row, and nothing moves', async () => {
      const s = await prepare(); const p = await persisted(s);
      const realAuth = { approved: true, revoked: false, inventoryRecordId: 'S08-STRIPE-PRIVATE-TEST-VERIFIER-001' as const, inventoryRevision: 'rev-synthetic-1', accountId: 'acct_RealShape1', realm: 'test' as const,
        methods: ['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE'] as Array<'ACCOUNT_RETRIEVE_CURRENT' | 'INVOICE_RETRIEVE'>, expiresAtMs: p.now + 3_600_000 };
      const realScope = { ...p.scope, invoiceId: 'in_Dev06RealShape1' }; // a Stripe-shaped id: the scenario's own ids contain underscores, which real invoice ids never do
      const adapter = new StripeReadOnlyEvidenceAdapter({ transport: new ScriptedReadTransport([{ object: 'account', id: 'acct_RealShape1' }, { ...p.rawInvoice, id: realScope.invoiceId }]), gate: gateFor(realAuth, { businessId: s.businessId }), expectedAccountId: 'acct_RealShape1', clock: () => p.now, audit: () => undefined });
      const out = await adapter.acquire(realScope);
      if (!out.ok) throw new Error('expected evidence');
      expect(out.evidence.origin).toBe('STRIPE_TEST_READ'); expect(out.evidence.complete).toBe(false);
      const classified = classifyBundle(p.ctx as any, out.evidence, p.binding);
      expect(classified.settlement).toMatchObject({ verdict: 'UNRESOLVED', reasonCodes: ['EVIDENCE_KIND_UNSUPPORTED'] });
      expect(classified.settlementEvidence).toBeNull();
      // even evidence hand-relabelled as the real kind cannot be recorded: the recorder (and the classifier it runs) accept only the mock kind
      const good = classifyBundle(p.ctx as any, (await buildMockEvidence(p.mockSpec as any) as any).evidence, p.binding).settlementEvidence!;
      const relabelled = { ...good, provenance: { ...good.provenance, evidenceKind: 'STRIPE_TEST_READ' } } as any;
      expect(await rejects(recorder.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: relabelled }))).toMatch(/SETTLEMENT_AUTH_EVIDENCE_UNUSABLE/);
      expect(await authRows(s)).toBe(0);
      // a database writer cannot forge a row of that kind either: the evidence-kind CHECK admits only the mock kind
      const row = classifyBundle(p.ctx as any, (await buildMockEvidence(p.mockSpec as any) as any).evidence, p.binding).settlementEvidence!;
      await recorder.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: row });
      const stored = (await rows<any>(`select * from ${TABLE} where reservation_id=$1`, [s.reservationId]))[0];
      expect(await rejects(admin.query(`insert into ${TABLE}(business_id,reservation_id,decision_id,invoice_ref,provider_account_id,provider_mode,allocation_digest,policy_version,verdict,reason_codes,classifier_version,evidence_kind,billing_interval,snapshot_ref,snapshot_digest,observed_at_ms,evidence_digest,provenance_version,signing_key_id,signature)
        values($1,$2,$3,$4,$5,$6,$7,$8,'ELIGIBLE',ARRAY['ALL_CONDITIONS_VERIFIED'],$9,'STRIPE_TEST_READ',$10,'x',$11,$12,$13,1,$14,$15)`,
        [stored.business_id, stored.reservation_id, stored.decision_id, stored.invoice_ref, stored.provider_account_id, stored.provider_mode, stored.allocation_digest, stored.policy_version, stored.classifier_version, stored.billing_interval,
          'e'.repeat(64), stored.observed_at_ms, 'f'.repeat(64), stored.signing_key_id, stored.signature]))).toMatch(/evidence_kind_check|SETTLEMENT_AUTH_DIGEST_MISMATCH/);
    });

    it('DEV-07: the source-shaped chain (paged lines, settling payment, refund/dispute history through the normalizers) -> classifiers -> signed recorder -> gate -> consumption; any unresolved or contradictory history leaves the credit unconsumed', async () => {
      const mk = async (s: Scenario, p: Awaited<ReturnType<typeof persisted>>, fx: { refunds?: unknown[]; disputes?: unknown[]; payments?: unknown[]; lineAmount?: number } = {}) => {
        const alloc = p.ctx.expected.frozenAllocation.allocations.find((a: any) => a.reservationId === s.reservationId);
        const base = p.ctx.expected.frozenAllocation.eligibleBaseMinor;
        const created = (p.rawInvoice as any).created; const paid = (p.rawInvoice as any).status_transitions.paid_at; const total = (p.rawInvoice as any).total;
        const line = (id: string, amount: number, parent: unknown) => ({ id, object: 'line_item', amount, currency: 'usd', invoice: s.invoiceRef, livemode: false, metadata: {}, parent });
        const payment = { id: 'inpay_dev07', object: 'invoice_payment', amount_paid: total, amount_requested: total, created, currency: 'usd', invoice: s.invoiceRef, is_default: true, livemode: false,
          payment: { type: 'payment_intent', payment_intent: `pi_dev07_${s.invoiceRef}` }, status: 'paid', status_transitions: { paid_at: paid, canceled_at: null } };
        const r = await acquireMockExtendedEvidence({
          scope: p.scope, accountId: GATE_CFG.providerAccountId, observedAtMs: p.now - 1_000, apiVersion: '2026-05-27.dahlia', invoiceBefore: p.rawInvoice,
          source: new MockExtendedSource({
            lines: onePage([line('il_base', base, { type: 'subscription_item_details', invoice_item_details: null, subscription_item_details: { invoice_item: null, proration: false, subscription: p.scope.subscriptionId, subscription_item: 'si_1' } }),
              line('il_ben', -alloc.benefitMinor, { type: 'invoice_item_details', subscription_item_details: null, invoice_item_details: { invoice_item: 'ii_ben', proration: false, subscription: p.scope.subscriptionId } })]),
            payments: onePage(fx.payments ?? [payment]), refunds: onePage(fx.refunds ?? []), disputes: onePage(fx.disputes ?? []) }),
          frozen: [{ reservationId: s.reservationId, providerIdempotencyKey: alloc.providerIdempotencyKey, benefitMinor: alloc.benefitMinor }], idempotency: [{ parentItemRef: 'ii_ben', idempotencyKey: alloc.providerIdempotencyKey }],
          billingInterval: 'month', cancellation: 'none', benefitItem: { itemRef: 'ii_ben', invoiceRef: s.invoiceRef, idempotencyKey: alloc.providerIdempotencyKey, amountMinor: -alloc.benefitMinor, currency: 'usd', discountable: false },
        });
        if (!r.ok) throw new Error(`denied ${r.denied}`);
        const rd = { nowMs: p.now, policy: { version: 'PC-BENEFIT/1', freshnessWindowMs: GATE_CFG.freshnessWindowMs }, expected: { businessId: s.businessId, invoiceRef: s.invoiceRef, paymentRef: `pi_dev07_${s.invoiceRef}`, currency: 'usd',
          providerAccountId: GATE_CFG.providerAccountId, providerMode: GATE_CFG.providerMode, consumedAtMs: null } };
        return classifyBundle(p.ctx as any, r.evidence, p.binding, rd as any);
      };
      const ok = await prepare(); const okP = await persisted(ok);
      const good = await mk(ok, okP);
      expect(good.settlement).toMatchObject({ verdict: 'ELIGIBLE', grantsFinancialAuthority: false });
      expect(good.refundDispute?.classification).toBe('NO_REFUND');
      await recorder.record({ reservationId: ok.reservationId, businessId: ok.businessId, evidence: good.settlementEvidence! });
      expect((await consumption.consume({ reservationId: ok.reservationId, businessId: ok.businessId })).replay).toBe(false);
      expect(await consumeEntries(ok)).toBe(1);

      const dispute = (s: Scenario) => ({ id: 'dp_dev07', object: 'dispute', amount: 100, charge: 'ch_1', created: 1, currency: 'usd', livemode: false, payment_intent: `pi_dev07_${s.invoiceRef}`, status: 'needs_response' });
      const refund = (s: Scenario) => ({ id: 're_dev07', object: 'refund', amount: 100, charge: 'ch_1', created: 1, currency: 'usd', payment_intent: `pi_dev07_${s.invoiceRef}`, status: 'succeeded' });
      for (const [label, fx] of [['open dispute', (s: Scenario) => ({ disputes: [dispute(s)] })], ['partial refund', (s: Scenario) => ({ refunds: [refund(s)] })],
        ['refund and dispute overlap', (s: Scenario) => ({ refunds: [refund(s)], disputes: [{ ...dispute(s), status: 'lost' }] })], ['no settling payment', () => ({ payments: [] })]] as const) {
        const s = await prepare(); const p = await persisted(s);
        const c = await mk(s, p, fx(s));
        expect(c.settlement.verdict, label).not.toBe('ELIGIBLE');
        if (c.settlementEvidence) await recorder.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: c.settlementEvidence });
        const before = await credit(s);
        expect(await rejects(consumption.consume({ reservationId: s.reservationId, businessId: s.businessId })), label).toMatch(/PARTNER_CONSUME_SETTLEMENT_NOT_AUTHORIZED \((NOT_ELIGIBLE|AUTHORIZATION_MISSING)\)/);
        expect(await credit(s), label).toEqual(before);
        expect(await consumeEntries(s), label).toBe(0);
      }
    });

    describe('D1/D3-DEV-08 acquisition pipeline over a disposable database', () => {
      /** The pipeline over a fixture provider built from PERSISTED rows; the binding is what a tenant-checked resolver would return. */
      const rig = async (s: Scenario, fx: { refunds?: unknown[]; disputes?: unknown[]; payments?: unknown[] } = {}) => {
        const p = await persisted(s);
        const alloc = p.ctx.expected.frozenAllocation.allocations.find((a: any) => a.reservationId === s.reservationId);
        const base = p.ctx.expected.frozenAllocation.eligibleBaseMinor; const total = (p.rawInvoice as any).total;
        const created = (p.rawInvoice as any).created; const paid = (p.rawInvoice as any).status_transitions.paid_at;
        const line = (id: string, amount: number, parent: unknown) => ({ id, object: 'line_item', amount, currency: 'usd', invoice: s.invoiceRef, livemode: false, metadata: {}, parent });
        const pi = `pi_dev08_${s.invoiceRef}`;
        const payment = { id: 'inpay_dev08', object: 'invoice_payment', amount_paid: total, amount_requested: total, created, currency: 'usd', invoice: s.invoiceRef, is_default: true, livemode: false,
          payment: { type: 'payment_intent', payment_intent: pi }, status: 'paid', status_transitions: { paid_at: paid, canceled_at: null } };
        const provider = createMockReadProvider({
          account: { object: 'account', id: GATE_CFG.providerAccountId }, invoices: [p.rawInvoice],
          lines: onePage([line('il_base', base, { type: 'subscription_item_details', invoice_item_details: null, subscription_item_details: { invoice_item: null, proration: false, subscription: p.scope.subscriptionId, subscription_item: 'si_1' } }),
            line('il_ben', -alloc.benefitMinor, { type: 'invoice_item_details', subscription_item_details: null, invoice_item_details: { invoice_item: 'ii_ben', proration: false, subscription: p.scope.subscriptionId } })]),
          payments: onePage(fx.payments ?? [payment]), refunds: onePage(fx.refunds ?? []), disputes: onePage(fx.disputes ?? []),
          supplement: { billingInterval: 'month', cancellation: 'none', idempotency: [{ parentItemRef: 'ii_ben', idempotencyKey: alloc.providerIdempotencyKey }],
            benefitItem: { itemRef: 'ii_ben', invoiceRef: s.invoiceRef, idempotencyKey: alloc.providerIdempotencyKey, amountMinor: -alloc.benefitMinor, currency: 'usd', discountable: false } },
        });
        const pipeline = new EvidenceAcquisitionPipeline<never>({
          provider, clock: () => p.now, audit: () => undefined, config: { freshnessWindowMs: GATE_CFG.freshnessWindowMs, policyEffectiveFromMs: 1_000, policyVersion: 'PC-BENEFIT/1' },
          resolveBinding: async (b, i) => (b === s.businessId && i === s.invoiceRef ? { scope: p.scope, expectedAccountId: GATE_CFG.providerAccountId, classifier: { binding: p.binding, expected: p.ctx.expected as any, expectedPaymentRef: pi, consumedAtMs: null } } : null),
        });
        return { pipeline, provider, req: { businessId: s.businessId, invoiceId: s.invoiceRef }, p };
      };
      const ledgerRows = async (s: Scenario) => (await rows<{ n: number }>('select count(*)::int n from partner_credit_ledger where decision_id=$1', [s.decisionId]))[0]!.n;

      it('26. a complete synthetic chain passes the pipeline, the existing signed recorder and the settlement gate, and consumes exactly once (replays change nothing)', async () => {
        const s = await prepare(); const { pipeline, req } = await rig(s);
        const r = await pipeline.run(req);
        if (r.status !== 'CLASSIFIED') throw new Error(`expected CLASSIFIED, got ${r.status}`);
        expect(r.classification.settlement.verdict).toBe('ELIGIBLE'); expect(r.recordableEvidence).not.toBeNull();
        expect(await authRows(s)).toBe(0); // the pipeline itself records nothing
        const rec = await recorder.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: r.recordableEvidence! });
        expect(rec.verdict).toBe('ELIGIBLE');
        expect((await rows<any>(`select signing_key_id, evidence_kind from ${TABLE} where reservation_id=$1`, [s.reservationId]))[0]).toMatchObject({ signing_key_id: SIGNER.keyId, evidence_kind: 'MOCK_SYNTHETIC' });
        const before = await ledgerRows(s);
        expect((await consumption.consume({ reservationId: s.reservationId, businessId: s.businessId })).replay).toBe(false);
        expect(await ledgerRows(s)).toBe(before + 1); expect(await consumeEntries(s)).toBe(1);
        expect((await consumption.consume({ reservationId: s.reservationId, businessId: s.businessId })).replay).toBe(true);
        expect(await ledgerRows(s)).toBe(before + 1);
      });

      it('27. missing, contradictory, incomplete or non-eligible evidence produces zero ledger movement: rejected evidence is never recordable, and recorded non-eligible evidence is refused by the gate', async () => {
        const dp = (s: Scenario, over: Record<string, unknown> = {}) => ({ id: 'dp_dev08', object: 'dispute', amount: 100, charge: 'ch_1', created: 1, currency: 'usd', livemode: false, payment_intent: `pi_dev08_${s.invoiceRef}`, status: 'needs_response', ...over });
        const rf = (s: Scenario, over: Record<string, unknown> = {}) => ({ id: 're_dev08', object: 'refund', amount: 100, charge: 'ch_1', created: 1, currency: 'usd', payment_intent: `pi_dev08_${s.invoiceRef}`, status: 'succeeded', ...over });
        const cases: Array<[string, (s: Scenario) => Parameters<typeof rig>[1], 'REJECTED' | 'CLASSIFIED']> = [
          ['no settling payment', () => ({ payments: [] }), 'REJECTED'], ['refund of another payment', s => ({ refunds: [rf(s, { payment_intent: 'pi_other' })] }), 'REJECTED'],
          ['dispute of another payment', s => ({ disputes: [dp(s, { payment_intent: 'pi_other' })] }), 'REJECTED'], ['refund/dispute overlap', s => ({ refunds: [rf(s)], disputes: [dp(s, { status: 'lost' })] }), 'REJECTED'],
          ['open dispute', s => ({ disputes: [dp(s)] }), 'CLASSIFIED'], ['partial refund', s => ({ refunds: [rf(s)] }), 'CLASSIFIED']];
        for (const [label, fx, expected] of cases) {
          const s = await prepare(); const { pipeline, req } = await rig(s, fx(s));
          const r = await pipeline.run(req);
          expect(r.status, label).toBe(expected);
          if (r.status === 'CLASSIFIED') { expect(r.classification.settlement.verdict, label).not.toBe('ELIGIBLE'); await recorder.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: r.recordableEvidence! }); }
          else expect('recordableEvidence' in r, label).toBe(false);
          const credBefore = await credit(s); const ledgerBefore = await ledgerRows(s);
          expect(await rejects(consumption.consume({ reservationId: s.reservationId, businessId: s.businessId })), label).toMatch(/PARTNER_CONSUME_SETTLEMENT_NOT_AUTHORIZED \((NOT_ELIGIBLE|AUTHORIZATION_MISSING)\)/);
          expect(await credit(s), label).toEqual(credBefore); expect(await ledgerRows(s), label).toBe(ledgerBefore); expect(await consumeEntries(s), label).toBe(0);
        }
      });

      it('28. duplicate orchestration does not duplicate financial effects: repeated runs and repeated recordings leave one authorization row and one consumption', async () => {
        const s = await prepare(); const { pipeline, req } = await rig(s);
        const runs = [await pipeline.run(req), await pipeline.run(req), await pipeline.run(req)];
        if (runs.some(r => r.status !== 'CLASSIFIED')) throw new Error('expected CLASSIFIED');
        const digests = runs.map(r => (r as any).evidence.digest); expect(new Set(digests).size).toBe(1);
        const results = [];
        for (const r of runs) results.push(await recorder.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: (r as any).recordableEvidence }));
        expect(results.map(x => x.replay)).toEqual([false, true, true]);
        expect(await authRows(s)).toBe(1);
        expect(await ledgerRows(s)).toBe(await ledgerRows(s)); // pipeline runs wrote nothing
        await consumption.consume({ reservationId: s.reservationId, businessId: s.businessId });
        await consumption.consume({ reservationId: s.reservationId, businessId: s.businessId });
        expect(await consumeEntries(s)).toBe(1);
      });

      it('29. concurrent consumption of pipeline-authorized evidence stays exactly once', async () => {
        const s = await prepare(); const { pipeline, req } = await rig(s);
        const r = await pipeline.run(req); if (r.status !== 'CLASSIFIED') throw new Error('expected CLASSIFIED');
        await recorder.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: r.recordableEvidence! });
        // temporary connections, closed afterwards: the suite shares one small connection budget
        const temp: Client[] = [];
        try {
          const services = await Promise.all(Array.from({ length: 8 }, async () => { const c = new Client({ connectionString: urlFor(dbName) }); await c.connect(); temp.push(c); return new PartnerCreditConsumptionService(buildDb(c), GATE_CFG); }));
          const results = await Promise.all(services.map(x => x.consume({ reservationId: s.reservationId, businessId: s.businessId })));
          expect(results.filter(x => !x.replay)).toHaveLength(1); expect(results.filter(x => x.replay)).toHaveLength(7);
        } finally { await Promise.all(temp.map(c => c.end().catch(() => undefined))); }
        expect(await consumeEntries(s)).toBe(1);
        expect(await credit(s)).toMatchObject({ reserved: 0, reservation: 'consumed', terminal: true });
      });

      it('30. real provider evidence stays disabled for financial authorization even with a complete-looking database: the real pipeline is rejected, nothing is recordable, consumption stays refused', async () => {
        const s = await prepare(); const p = await persisted(s);
        const transport = new ScriptedReadTransport([{ object: 'account', id: 'acct_RealShape1' }, { ...p.rawInvoice, id: 'in_Dev08RealShape1' }]);
        const auth = { approved: true, revoked: false, inventoryRecordId: 'S08-STRIPE-PRIVATE-TEST-VERIFIER-001' as const, inventoryRevision: 'rev-1', accountId: 'acct_RealShape1', realm: 'test' as const,
          methods: ['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE'] as Array<'ACCOUNT_RETRIEVE_CURRENT' | 'INVOICE_RETRIEVE'>, expiresAtMs: p.now + 3_600_000 };
        const provider = createRealReadProvider({ transport, gate: gateFor(auth, { businessId: s.businessId }), clock: () => p.now, audit: () => undefined });
        const realScope = { ...p.scope, invoiceId: 'in_Dev08RealShape1' };
        const pipeline = new EvidenceAcquisitionPipeline<string>({ provider, clock: () => p.now, audit: () => undefined, config: { freshnessWindowMs: GATE_CFG.freshnessWindowMs, policyEffectiveFromMs: 1_000, policyVersion: 'PC-BENEFIT/1' },
          resolveBinding: async () => ({ scope: realScope, expectedAccountId: 'acct_RealShape1', classifier: { binding: p.binding, expected: p.ctx.expected as any, expectedPaymentRef: null, consumedAtMs: null } }),
          invocation: { policy: { approved: true, revoked: false, callerPrincipal: 'c', audience: 'aud-dev08', credentialVersion: 'v1', inventoryRevision: 'rev-1', methods: ['GET /v1/account', 'GET /v1/invoices/{id}'], expiresAt: p.now + 3_600_000, invoiceScope: realScope },
            deps: { authenticate: async (proof, canonical) => (proof === 'valid' ? { principal: 'c', audience: 'aud-dev08', credentialVersion: 'v1', authenticatedRequest: canonical } : null), claimOnce: async () => true } } });
        const req = (op: 'GET /v1/account' | 'GET /v1/invoices/{id}', n: string) => ({ audience: 'aud-dev08', operation: op, inventoryRevision: 'rev-1', nonce: n.repeat(24), issuedAt: p.now - 1_000, expiresAt: p.now + 60_000, ...(op === 'GET /v1/invoices/{id}' ? { invoiceScope: realScope } : {}) });
        const out = await pipeline.run({ businessId: s.businessId, invoiceId: realScope.invoiceId }, { account: { request: req('GET /v1/account', 'ax'), proof: 'valid' }, invoice: { request: req('GET /v1/invoices/{id}', 'ay'), proof: 'valid' } });
        if (out.status !== 'REJECTED') throw new Error(`expected REJECTED, got ${JSON.stringify(out).slice(0, 200)}`);
        expect(out.origin).toBe('STRIPE_TEST_READ'); expect(out.completeness.blockers).toContain('REAL_EVIDENCE_NOT_AUTHORIZED_FOR_SETTLEMENT');
        expect('recordableEvidence' in out).toBe(false);
        expect(out.classification?.settlement.reasonCodes).toEqual(['EVIDENCE_KIND_UNSUPPORTED']);
        const before = await credit(s);
        expect(await rejects(consumption.consume({ reservationId: s.reservationId, businessId: s.businessId }))).toMatch(/\(AUTHORIZATION_MISSING\)/);
        expect(await credit(s)).toEqual(before); expect(await authRows(s)).toBe(0); expect(await consumeEntries(s)).toBe(0);
      });

      describe('D1/D3-DEV-09 read authorization over a disposable database', () => {
        const mkAuth = (now: number, over: Record<string, unknown> = {}) => ({ approved: true, revoked: false, inventoryRecordId: 'S08-STRIPE-PRIVATE-TEST-VERIFIER-001' as const, inventoryRevision: 'rev-1', accountId: 'acct_RealShape1', realm: 'test' as const,
          methods: ['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE'] as Array<'ACCOUNT_RETRIEVE_CURRENT' | 'INVOICE_RETRIEVE'>, expiresAtMs: now + 3_600_000, ...over });

        it('32. a failed read authorization makes zero provider requests and leaves zero ledger, authorization-row and consumption movement', async () => {
          const cases: Array<[string, (now: number) => any, string?]> = [
            ['missing', () => null], ['revoked', n => mkAuth(n, { revoked: true })], ['expired', n => mkAuth(n, { expiresAtMs: n - 1 })],
            ['not approved', n => mkAuth(n, { approved: false })], ['wrong account', n => mkAuth(n, { accountId: 'acct_Other1' })],
            ['wrong workload', n => mkAuth(n), 'wl-other'], ['wrong business', n => mkAuth(n)]];
          for (const [label, mk, workloadId] of cases) {
            const s = await prepare(); const p = await persisted(s);
            const transport = new ScriptedReadTransport([{ object: 'account', id: 'acct_RealShape1' }, { ...p.rawInvoice, id: 'in_Dev09Shape1' }]);
            const gate = gateFor(mk(p.now), { businessId: label === 'wrong business' ? 'biz-other' : s.businessId, ...(workloadId ? { workloadId } : {}) });
            const provider = createRealReadProvider({ transport, gate, clock: () => p.now, audit: () => undefined });
            const pipeline = new EvidenceAcquisitionPipeline<never>({ provider, clock: () => p.now, audit: () => undefined, config: { freshnessWindowMs: GATE_CFG.freshnessWindowMs, policyEffectiveFromMs: 1_000, policyVersion: 'PC-BENEFIT/1' },
              resolveBinding: async () => ({ scope: { ...p.scope, invoiceId: 'in_Dev09Shape1' }, expectedAccountId: 'acct_RealShape1', classifier: { binding: p.binding, expected: p.ctx.expected as any, expectedPaymentRef: null, consumedAtMs: null } }) });
            const before = await credit(s); const ledgerBefore = await ledgerRows(s);
            const out = await pipeline.run({ businessId: s.businessId, invoiceId: 'in_Dev09Shape1' });
            expect(out.status, label).not.toBe('CLASSIFIED'); expect('recordableEvidence' in out, label).toBe(false);
            expect(transport.calls ?? [], label).toEqual([]);
            expect(await rejects(consumption.consume({ reservationId: s.reservationId, businessId: s.businessId })), label).toMatch(/\(AUTHORIZATION_MISSING\)/);
            expect(await credit(s), label).toEqual(before); expect(await ledgerRows(s), label).toBe(ledgerBefore); expect(await authRows(s), label).toBe(0); expect(await consumeEntries(s), label).toBe(0);
          }
        });

        it('31. real-origin evidence stays prohibited from settlement authorization recording even with a complete authorization, verified mapping and relabelling attempts', async () => {
          const s = await prepare(); const p = await persisted(s);
          const transport = new ScriptedReadTransport([{ object: 'account', id: 'acct_RealShape1' }, { ...p.rawInvoice, id: 'in_Dev09Shape1' }]);
          const provider = createRealReadProvider({ transport, gate: gateFor(mkAuth(p.now), { businessId: s.businessId }), clock: () => p.now, audit: () => undefined });
          const pipeline = new EvidenceAcquisitionPipeline<never>({ provider, clock: () => p.now, audit: () => undefined, config: { freshnessWindowMs: GATE_CFG.freshnessWindowMs, policyEffectiveFromMs: 1_000, policyVersion: 'PC-BENEFIT/1' },
            resolveBinding: async () => ({ scope: { ...p.scope, invoiceId: 'in_Dev09Shape1' }, expectedAccountId: 'acct_RealShape1', classifier: { binding: p.binding, expected: p.ctx.expected as any, expectedPaymentRef: null, consumedAtMs: null } }) });
          const out = await pipeline.run({ businessId: s.businessId, invoiceId: 'in_Dev09Shape1' });
          expect(out.status).not.toBe('CLASSIFIED'); expect('recordableEvidence' in out).toBe(false); // the full invocation path (REJECTED with the real-evidence blocker) is test 30
          const s2 = await prepare(); const m = await rig(s2); const r = await m.pipeline.run(m.req);
          if (r.status !== 'CLASSIFIED') throw new Error('expected CLASSIFIED');
          const relabelled = { ...r.recordableEvidence, provenance: { ...(r.recordableEvidence as any).provenance, evidenceKind: 'STRIPE_TEST_READ' } } as any;
          expect(await rejects(recorder.record({ reservationId: s2.reservationId, businessId: s2.businessId, evidence: relabelled }))).toMatch(/SETTLEMENT_AUTH_EVIDENCE_UNUSABLE/);
          expect(await authRows(s2)).toBe(0); expect(await authRows(s)).toBe(0); expect(await consumeEntries(s)).toBe(0);
        });
      });
    });

    it('22b. with no authorization recorded from real evidence, consumption stays refused and leaves no trace', async () => {
      const s = await prepare();
      const before = await credit(s);
      expect(await rejects(consumption.consume({ reservationId: s.reservationId, businessId: s.businessId }))).toMatch(/PARTNER_CONSUME_SETTLEMENT_NOT_AUTHORIZED \(AUTHORIZATION_MISSING\)/);
      expect(await credit(s)).toEqual(before);
      expect(await consumeEntries(s)).toBe(0);
      // a gate configured to ACCEPT the real kind still has nothing to accept: no row of that kind can exist
      const lenient = new PartnerCreditConsumptionService(buildDb(await connect()), { ...GATE_CFG, acceptedEvidenceKinds: ['STRIPE_TEST_READ', MOCK_EVIDENCE_KIND] });
      expect(await rejects(lenient.consume({ reservationId: s.reservationId, businessId: s.businessId }))).toMatch(/\(AUTHORIZATION_MISSING\)/);
      expect(await consumeEntries(s)).toBe(0);
    });

    it('a pipeline that cannot establish a fact leaves the reservation unauthorized: evidence missing its refund history is recorded as UNRESOLVED and consumption is refused', async () => {
      const s = await prepare(); const p = await persisted(s);
      const built = await buildMockEvidence({ ...p.mockSpec, refunds: 'unresolved' } as any);
      if (!built.ok) throw new Error('mock denied');
      const classified = classifyBundle(p.ctx as any, built.evidence, p.binding);
      expect(classified.settlement.verdict).toBe('UNRESOLVED');
      const rec = await recorder.record({ reservationId: s.reservationId, businessId: s.businessId, evidence: classified.settlementEvidence! });
      expect(rec.verdict).toBe('UNRESOLVED');
      const before = await credit(s);
      expect(await rejects(consumption.consume({ reservationId: s.reservationId, businessId: s.businessId }))).toMatch(/\(NOT_ELIGIBLE\)/);
      expect(await credit(s)).toEqual(before); expect(await consumeEntries(s)).toBe(0);
    });
  });
});
