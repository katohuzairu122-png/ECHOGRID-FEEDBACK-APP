import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildDb } from '../../src/db/client';
import type { BenefitApplicationSagaService, IntentView } from '../../src/billing/benefit-application.saga.service';
import { BenefitReconciliationService, type ReconcileResult } from '../../src/billing/benefit-reconciliation.service';
import { RESERVATION_METADATA_KEY, type ProviderInvoiceLine, type ProviderInvoiceReader } from '../../src/billing/provider-effect.adapter';
import { createBenefitScratch } from './helpers/benefit-scratch';

/**
 * Split 08 provider reconciliation on PostgreSQL (migration 0049) against a MOCK provider and a scratch database. No Stripe, Neon or production resource.
 */
describe.skipIf(!process.env.DATABASE_URL)('Split 08 provider reconciliation (integration, mock provider, scratch database)', () => {
  let s: Awaited<ReturnType<typeof createBenefitScratch>>;
  let saga: BenefitApplicationSagaService;
  let recon: BenefitReconciliationService;
  const SECRET = 'sk_live_REDACTION_CANARY';
  const scope = { accountId: 'acct_A', livemode: true, customerId: 'cus_1', subscriptionId: 'sub_1' };
  let n = 0;

  type Script = { lines?: () => ProviderInvoiceLine[]; error?: unknown; account?: string; delayMs?: number };
  const readerFor = (sc: Script): ProviderInvoiceReader => ({
    async currentAccount() { if (sc.delayMs) await new Promise(r => setTimeout(r, sc.delayMs)); return { id: sc.account ?? 'acct_A' }; },
    async retrieveInvoice(id) { if (sc.error) throw sc.error; return { id, livemode: true, customerId: 'cus_1', subscriptionId: 'sub_1', currency: 'usd', status: 'paid', amountRemaining: 0 }; },
    async listInvoiceLines() { return { data: sc.lines ? sc.lines() : [{ id: 'li_base', amount: 10_000, currency: 'usd', metadata: null }], hasMore: false }; },
  });
  // the default effect id is unique per reservation: one provider effect can settle exactly one reservation
  const benefitLine = (i: IntentView, id = `ef_${i.reservationId}`, amount = -i.expectedBenefitMinor): ProviderInvoiceLine => ({ id, amount, currency: 'usd', metadata: { [RESERVATION_METADATA_KEY]: i.reservationId } });
  const attempted = async (at = new Date(0)) => {
    const i = await saga.createIntent({ reservationId: await s.makeReservation(s.tenantA), invoiceRef: `in_${++n}`, expectedBenefitMinor: 300, currency: 'usd', policyVersion: 'PC-BENEFIT/1' });
    await saga.beginApply(i.id, 'att', at);
    return i;
  };
  const clockAt = (ms: number) => () => new Date(ms);
  const rec = async (i: IntentView, sc: Script, clock: () => Date, extra: Partial<Parameters<BenefitReconciliationService['reconcile']>[1]> = {}) =>
    recon.reconcile(i.id, { reader: readerFor(sc), scope, clock, ...extra });
  const okRec = (r: ReconcileResult) => { if (r.status !== 'reconciled') throw new Error('skipped: ' + r.reason); return r; };
  const attempts = (id: string) => s.rows<{ attempt_no: number; outcome: string | null; detail_code: string | null; next_retry_at: Date | null; retry_after_ms: number | null }>('select attempt_no,outcome,detail_code,next_retry_at,retry_after_ms from benefit_reconciliation_attempts where intent_id=$1 order by attempt_no', [id]);

  beforeAll(async () => {
    s = await createBenefitScratch('echogrid_s08_recon');
    saga = await s.newService();
    recon = new BenefitReconciliationService(buildDb(await s.connect()), saga);
  }, 300_000);
  afterAll(async () => { if (s) await s.close(); }, 120_000);

  it('is inert by default: reconciliation attempts are write-denied until the saga guards are disabled (disposable database only)', async () => {
    await expect(s.admin.query("insert into benefit_reconciliation_attempts(intent_id,business_id,attempt_no,reconcile_key,started_at) values(gen_random_uuid(),$1,1,'k',now())", [s.tenantA])).rejects.toThrow(/writes disabled pending financial activation/);
    await s.disableSagaGuards();
  });

  it('a verified, attributed effect is recorded and forwarded; the saga consumes only on the exact match', async () => {
    const i = await attempted();
    const r = okRec(await rec(i, { lines: () => [benefitLine(i)] }, clockAt(1_000)));
    expect(r).toMatchObject({ attemptNo: 1, outcome: 'effect_present', forwarded: 'observation' });
    expect(r.saga && r.saga.ok && r.saga.intent).toMatchObject({ state: 'consumed', outcome: 'confirmed', providerEffectRef: `ef_${i.reservationId}` });
    expect(await attempts(i.id)).toMatchObject([{ attempt_no: 1, outcome: 'effect_present' }]);
  });

  it('a wrong-amount effect is forwarded and held as disputed, never consumed', async () => {
    const i = await attempted();
    const r = okRec(await rec(i, { lines: () => [benefitLine(i, `ef_wrong_${i.reservationId}`, -299)] }, clockAt(1_000)));
    expect(r.saga && r.saga.ok && r.saga.intent).toMatchObject({ state: 'retained', cause: 'PROVIDER_EFFECT_MISMATCH', outcome: 'disputed' });
  });

  it('two attributed effects for one reservation (duplicate application) are held as disputed', async () => {
    const i = await attempted();
    const r = okRec(await rec(i, { lines: () => [benefitLine(i, `ef_a_${i.reservationId}`), benefitLine(i, `ef_b_${i.reservationId}`)] }, clockAt(1_000)));
    expect(r.saga && r.saga.ok && r.saga.intent).toMatchObject({ state: 'retained', cause: 'PROVIDER_EFFECT_UNATTRIBUTED', outcome: 'disputed' });
  });

  it('absence is never inferred from one query, nor from queries too close together, nor across a broken streak; two separated complete queries release', async () => {
    const i = await attempted(new Date(0));
    const first = okRec(await rec(i, {}, clockAt(10_000)));
    expect(first).toMatchObject({ outcome: 'absent_complete', forwarded: 'none', saga: null });
    expect((await saga.get(i.id))!.state).toBe('applying');
    const tooSoon = okRec(await rec(i, {}, clockAt(10_000 + 60_000)));
    expect(tooSoon.forwarded).toBe('none');
    expect((await saga.get(i.id))!.state).toBe('applying');
    // a retryable error between breaks the streak
    okRec(await rec(i, { error: Object.assign(new Error('x'), { type: 'StripeConnectionError' }) }, clockAt(10_000 + 400_000)));
    const afterError = okRec(await rec(i, {}, clockAt(10_000 + 800_000)));
    expect(afterError.forwarded).toBe('none');
    expect((await saga.get(i.id))!.state).not.toBe('released');
    const released = okRec(await rec(i, {}, clockAt(10_000 + 1_200_000)));
    expect(released.forwarded).toBe('absence');
    expect(released.saga && released.saga.ok && released.saga.intent).toMatchObject({ state: 'released', cause: 'PROVIDER_CONFIRMED_NO_EFFECT', outcome: 'rejected' });
    expect((await attempts(i.id)).map(a => a.outcome)).toEqual(['absent_complete', 'absent_complete', 'error_retryable', 'absent_complete', 'absent_complete']);
  });

  it('absence observed only BEFORE the provider attempt began never releases', async () => {
    const i = await attempted(new Date(500_000));
    okRec(await rec(i, {}, clockAt(100_000)));
    const r = okRec(await rec(i, {}, clockAt(100_000 + 400_000)));
    expect(r.forwarded).toBe('none');
    expect((await saga.get(i.id))!.state).toBe('applying');
  });

  it('errors are classified, persisted with REDACTED detail, scheduled for retry, and hold the saga (never release)', async () => {
    const i = await attempted();
    const err = Object.assign(new Error(`Rate limited with key ${SECRET}`), { type: 'StripeRateLimitError', code: 'rate_limit', statusCode: 429, headers: { 'retry-after': '90', authorization: SECRET }, raw: { message: SECRET } });
    const r = okRec(await rec(i, { error: err }, clockAt(1_000_000), { rand: () => 0.5 }));
    expect(r).toMatchObject({ outcome: 'error_rate_limited', forwarded: 'observation' });
    expect(r.saga && r.saga.ok && r.saga.intent).toMatchObject({ state: 'retained', cause: 'PROVIDER_UNREACHABLE', outcome: 'unresolved' });
    const [row] = await attempts(i.id);
    expect(row).toMatchObject({ outcome: 'error_rate_limited', detail_code: 'rate_limit', retry_after_ms: 90_000 });
    expect(row!.next_retry_at!.getTime()).toBeGreaterThanOrEqual(1_000_000 + 90_000);
    // the canary must appear in no persisted column of any saga or reconciliation table
    const dump = await s.rows<{ t: string }>("select (select string_agg(x::text, ' ') from benefit_reconciliation_attempts x) || (select coalesce(string_agg(x::text,' '),'') from benefit_provider_observations x) || (select coalesce(string_agg(x::text,' '),'') from benefit_application_transitions x) as t");
    expect(dump[0]!.t).not.toContain(SECRET);
  });

  it('a scope mismatch (wrong provider account) is recorded and held, repeatedly, and never read as absence', async () => {
    const i = await attempted();
    for (let k = 0; k < 4; k++) {
      const r = okRec(await rec(i, { account: 'acct_OTHER' }, clockAt(1_000 + k * 600_000)));
      expect(r).toMatchObject({ outcome: 'scope_mismatch', forwarded: 'observation' });
    }
    expect((await saga.get(i.id))!.state).toBe('retained');
    expect((await attempts(i.id)).every(a => a.detail_code === 'ACCOUNT_MISMATCH')).toBe(true);
  });

  it('concurrency: simultaneous reconcilers run exactly one provider query; the rest see it in flight', async () => {
    const i = await attempted();
    const services = await Promise.all(Array.from({ length: 6 }, async () => new BenefitReconciliationService(buildDb(await s.connect()), await s.newService())));
    const results = await Promise.all(services.map(svc => svc.reconcile(i.id, { reader: readerFor({ delayMs: 400, lines: () => [benefitLine(i)] }), scope, clock: clockAt(2_000) })));
    expect(results.filter(r => r.status === 'reconciled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'skipped' && r.reason === 'IN_FLIGHT')).toHaveLength(5);
    expect((await attempts(i.id))).toHaveLength(1);
    expect((await saga.get(i.id))!.state).toBe('consumed');
  });

  it('crash recovery: an unfinished attempt left by a dead process still counts, breaks any absence streak, and does not block a later run', async () => {
    const i = await attempted(new Date(0));
    okRec(await rec(i, {}, clockAt(10_000)));
    await s.admin.query("insert into benefit_reconciliation_attempts(intent_id,business_id,attempt_no,reconcile_key,started_at) values($1,$2,2,$3,$4)", [i.id, s.tenantA, `reconcile:v1:${i.id}:2`, new Date(10_000 + 400_000)]); // process died mid-query
    const later = okRec(await rec(i, {}, clockAt(10_000 + 5_000_000)));
    expect(later.attemptNo).toBe(3);
    expect(later.forwarded).toBe('none'); // streak: [absent, unfinished(null), absent] is not two consecutive complete absences
    expect((await saga.get(i.id))!.state).toBe('applying');
  });

  it('skips what is not reconcilable: unknown, not yet attempted, and terminal intents', async () => {
    const fresh = await saga.createIntent({ reservationId: await s.makeReservation(s.tenantA), invoiceRef: 'in_s1', expectedBenefitMinor: 300, currency: 'usd', policyVersion: 'PC-BENEFIT/1' });
    expect(await rec(fresh, {}, clockAt(1))).toEqual({ status: 'skipped', reason: 'NOT_ATTEMPTED' });
    expect(await recon.reconcile(crypto.randomUUID(), { reader: readerFor({}), scope })).toEqual({ status: 'skipped', reason: 'NOT_FOUND' });
    const done = await attempted();
    okRec(await rec(done, { lines: () => [benefitLine(done)] }, clockAt(1_000)));
    expect(await rec(done, {}, clockAt(2_000))).toEqual({ status: 'skipped', reason: 'TERMINAL' });
  });

  it('attempt rows complete exactly once and are never deleted or truncated; identity is immutable', async () => {
    const i = await attempted();
    okRec(await rec(i, {}, clockAt(5_000)));
    await expect(s.admin.query("update benefit_reconciliation_attempts set outcome='effect_present', finished_at=now() where intent_id=$1", [i.id])).rejects.toThrow(/already completed/);
    await expect(s.admin.query('delete from benefit_reconciliation_attempts where intent_id=$1', [i.id])).rejects.toThrow(/append-only|delete refused/);
    await expect(s.admin.query('truncate benefit_reconciliation_attempts')).rejects.toThrow(/append-only/);
    const open = await s.admin.query("insert into benefit_reconciliation_attempts(intent_id,business_id,attempt_no,reconcile_key,started_at) values($1,$2,99,'reconcile:v1:x:99',now()) returning id", [i.id, s.tenantA]);
    await expect(s.admin.query("update benefit_reconciliation_attempts set attempt_no=100 where id=$1", [open.rows[0]!.id])).rejects.toThrow(/identity is immutable/);
    await expect(s.admin.query("update benefit_reconciliation_attempts set outcome='absent_complete' where id=$1", [open.rows[0]!.id])).rejects.toMatchObject({ code: '23514' }); // outcome without finished_at
    await expect(s.admin.query("insert into benefit_reconciliation_attempts(intent_id,business_id,attempt_no,reconcile_key,started_at) values($1,$2,98,'reconcile:v1:y:98',now())", [i.id, s.tenantB])).rejects.toMatchObject({ code: '23503' }); // tenant key
  });

  it('moves no credit: reservation, lot, account and ledger are untouched by reconciliation', async () => {
    const i = await attempted();
    const snap = async () => JSON.stringify(await s.rows('select (select count(*) from partner_credit_ledger) ledger, r.state, l.status, a.available, a.reserved from partner_credit_reservations r join partner_credit_lots l on l.id=r.lot_id join partner_credit_accounts a on a.id=r.account_id where r.id=$1', [i.reservationId]));
    const before = await snap();
    okRec(await rec(i, { lines: () => [benefitLine(i)] }, clockAt(1_000)));
    expect(await snap()).toBe(before);
  });
});
