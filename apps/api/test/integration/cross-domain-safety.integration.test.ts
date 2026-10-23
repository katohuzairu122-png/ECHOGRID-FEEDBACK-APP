import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDb } from '../../src/db/client';
import { BenefitApplicationSagaService } from '../../src/billing/benefit-application.saga.service';
import { PartnerCreditDisputeService } from '../../src/partner-credits/partner-credit-dispute.service';
import { createBenefitScratch } from './helpers/benefit-scratch';

/**
 * Block E cross-domain regression net (Splits 07/08 and HETA Block G) on a PRISTINE scratch database with nothing disabled: the financial surface is
 * inert as shipped, the frozen migrations are byte-identical, and the journal replays contiguously. Disposable server only.
 */
const drizzleDir = resolve(__dirname, '../../drizzle');
const FROZEN: Record<string, string> = {
  '0040_split07_partner_credit_foundations.sql': '966faf45e2154fe3de2818944f735b63b2fb06c1928022157e23470b3f451425',
  '0041_split07_block1_integrity_guards.sql': '3424e2911999b4ac3e54fefc4dd080713b03c08d5f22a83f8ed9f86201734700',
  '0042_split08_ce1_inert_evidence.sql': '4685e4f578835d65c6b59be4dcb2bff978ad690d13c3b3c00b24e8b0aa6b7f8c',
  '0043_split07_stripe_subscription_observations.sql': 'b9844cf45ff786db3924230c98e3be5be10167b55e3395f38f01353988577c52',
  '0044_split07_multiunit_inert_conservation.sql': '3bea51443db6b8ae1a8589a7122218ca2333a49e782e08cbf6e707f758b6ff4a',
  '0045_heta01_f1_stripe_evidence.sql': '163cc763aeb770f68822e097fe59b1fc8fdc1a7e51df91d711201f9803883da6',
  '0046_heta01_f1_malformed_bad_account.sql': 'd17113c830bb3dda3f55eb5344fda92fd8353bb5730a65518c42f17aeac76e76',
  '0047_split08_ce1_composite_tenant_integrity.sql': '2af51afe3df438cce9dffbf2722b999349421909dee75b38cc68c657ad1039ea',
};
// Every financial / saga / dispute table that must stay write-denied on a database where nobody has disabled a guard.
const INERT_TABLES = [
  'partner_credit_accounts', 'partner_credit_award_decisions', 'partner_credit_lots', 'partner_credit_ledger', 'partner_credit_reservations', 'partner_credit_recovery_obligations',
  'partner_credit_multiunit_lot_allocations', 'partner_credit_multiunit_movements', 'billing_partner_credit_applications',
  'benefit_application_intents', 'benefit_provider_attempts', 'benefit_provider_observations', 'benefit_application_compensations', 'benefit_application_transitions', 'benefit_reconciliation_attempts',
  'partner_credit_award_disputes', 'partner_credit_dispute_events', 'partner_credit_corrections',
];
type Scratch = Awaited<ReturnType<typeof createBenefitScratch>>;
let s: Scratch;
const msg = (e: unknown) => String((e as { cause?: { message?: string } })?.cause?.message ?? (e as Error)?.message ?? e);

beforeAll(async () => { s = await createBenefitScratch('xdom'); }, 300_000);
afterAll(async () => { await s?.close(); });

describe('cross-domain safety net', () => {
  it('frozen migrations 0040-0047 are byte-identical to their approved hashes', () => {
    for (const [f, h] of Object.entries(FROZEN)) expect({ f, h: createHash('sha256').update(readFileSync(resolve(drizzleDir, f))).digest('hex') }).toEqual({ f, h });
  });

  it('the migration journal is contiguous and every .sql file is registered exactly once', () => {
    const journal = JSON.parse(readFileSync(resolve(drizzleDir, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    journal.entries.forEach((e, i) => expect(e.idx).toBe(i));
    const files = readdirSync(drizzleDir).filter(f => f.endsWith('.sql')).map(f => f.replace(/\.sql$/, '')).sort();
    expect(journal.entries.map(e => e.tag).sort()).toEqual(files);
  });

  it('as shipped, no financial/saga/dispute table accepts an INSERT, and none can be truncated, even from the owner connection', async () => {
    // the scratch helper disables four 0041/0042 guards for fixtures; re-enable them so this is the shipped state
    for (const [t, g] of [['partner_credit_award_decisions', 'partner_credit_awards_insert_disabled'], ['partner_credit_lots', 'partner_credit_lots_inert_guard'], ['partner_credit_accounts', 'partner_credit_accounts_inert_guard'], ['partner_credit_reservations', 'partner_credit_reservations_inert_guard']])
      await s.admin.query(`ALTER TABLE ${t} ENABLE TRIGGER ${g}`);
    const enabled = await s.rows<{ t: string }>("select tgrelid::regclass::text t from pg_trigger where not tgisinternal and tgenabled='O' and (tgname like '%inert_guard' or tgname like '%insert_disabled')");
    for (const t of INERT_TABLES) expect(enabled.map(r => r.t), t).toContain(t);
    for (const t of INERT_TABLES) {
      await s.admin.query('BEGIN');
      let m = '';
      try { await s.admin.query(`truncate ${t} cascade`); } catch (e) { m = msg(e); }
      await s.admin.query('ROLLBACK');
      expect({ t, denied: m !== '' }).toEqual({ t, denied: true });
    }
  });

  it('the application services cannot create financial state on a shipped database (inert end to end, no provider contact)', async () => {
    const saga = new BenefitApplicationSagaService(buildDb(await s.connect()));
    const dispute = new PartnerCreditDisputeService(buildDb(await s.connect()));
    const user = await s.makeUser('admin');
    const decision = await s.makeDecision(s.tenantA);
    await expect(saga.createIntent({ reservationId: crypto.randomUUID(), businessId: s.tenantA, invoiceRef: 'in_x', effectKey: 'k', amountMinor: 1, currency: 'usd' } as never)).rejects.toThrow();
    await expect(dispute.open({ decisionId: decision, businessId: s.tenantA, actorId: user, reason: 'x' } as never)).rejects.toThrow();
    for (const t of ['benefit_application_intents', 'partner_credit_award_disputes'])
      expect((await s.rows<{ n: number }>(`select count(*)::int n from ${t}`))[0]!.n).toBe(0);
  });

  it('HETA Block G tables carry no tenant column: they hold evidence-consistency bookkeeping, never tenant-attributed money', async () => {
    const cols = await s.rows<{ table_name: string; column_name: string }>("select table_name, column_name from information_schema.columns where table_name in ('heta_reconciliation_work','heta_provenance_comparisons','heta_record_revisions') and column_name ~ '(business|tenant|user)_?id'");
    expect(cols).toEqual([]);
  });
});
