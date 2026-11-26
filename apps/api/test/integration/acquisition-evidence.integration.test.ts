import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { acquisitionEvidence } from '../../src/analytics/acquisition-evidence';
import { makeFixtures } from './helpers/tentaship-fixtures';

/** G4 acquisition evidence against real PostgreSQL: counts of what is already recorded, honest unavailable states, all-or-nothing privacy suppression, tenant scoping, exact decimals. Synthetic data only. */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');
const period = () => ({ start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) });

describe.skipIf(!databaseUrl)('G4 acquisition evidence (real PostgreSQL)', () => {
  let client: Client; let f: ReturnType<typeof makeFixtures>; let admin: { id: string };
  beforeAll(async () => { client = new Client({ connectionString: databaseUrl }); await client.connect(); f = makeFixtures(client); admin = await f.user('g4-admin'); });
  afterAll(async () => { await client?.end(); });

  const purchase = async (biz: string, cust: string, amount: string) => {
    const m = (await f.q(`SELECT id FROM business_customer_memberships WHERE customer_id=$1 AND business_id=$2`, [cust, biz]))[0].id; const a = (await f.q(`SELECT id FROM loyalty_accounts WHERE customer_id=$1 AND business_id=$2`, [cust, biz]))[0].id;
    await f.q(`INSERT INTO loyalty_purchase_events (business_id, customer_id, membership_id, loyalty_account_id, idempotency_key, qualifying_amount) VALUES ($1,$2,$3,$4,$5,$6)`, [biz, cust, m, a, randomUUID(), amount]);
  };

  it('REQUIRES an explicit privacy threshold and a valid period; nothing is defaulted', async () => {
    const biz = await f.business('g4a');
    await expect(acquisitionEvidence(f.db, biz, period(), { minGroupSize: undefined })).rejects.toMatchObject({ code: 'PRIVACY_THRESHOLD_REQUIRED' });
    await expect(acquisitionEvidence(f.db, biz, period(), { minGroupSize: 1 })).rejects.toMatchObject({ code: 'PRIVACY_THRESHOLD_REQUIRED' });
    await expect(acquisitionEvidence(f.db, biz, { start: new Date(), end: new Date(Date.now() - 1000) }, { minGroupSize: 2 })).rejects.toMatchObject({ code: 'MEASUREMENT_PERIOD_INVALID' });
    await expect(acquisitionEvidence(f.db, randomUUID(), period(), { minGroupSize: 2 })).rejects.toMatchObject({ code: 'BUSINESS_NOT_FOUND' });
  });

  it('COUNTS recorded evidence with exact decimals and evidence levels; unsupported metrics are unavailable (never zero); tenant-scoped; identity-free', async () => {
    const biz = await f.business('g4b'); const other = await f.business('g4c');
    for (let i = 0; i < 3; i++) { const c = await f.customer({ businessId: biz, purchase: true }); await purchase(biz, c, '10.10'); }
    await f.customer({ businessId: other, purchase: true });
    const r = await acquisitionEvidence(f.db, biz, period(), { minGroupSize: 2 });
    expect(r.suppressed).toBe(false);
    expect(r.enrollments).toMatchObject({ available: true, count: 3, evidenceLevel: 'verified_acquisition' });
    expect(r.recordedPurchases).toMatchObject({ available: true, count: 6, evidenceLevel: 'recorded_transaction' }); // 3 fixture purchases (20) + 3 added (10.10)
    expect(r.recordedPurchaseCustomers).toMatchObject({ available: true, count: 3 });
    expect(r.recordedPurchaseAmount).toEqual({ available: true, amount: '90.300000', currency: 'USD', evidenceLevel: 'recorded_transaction' });
    for (const k of ['discovery', 'profileVisits', 'communityInteractions', 'verifiedReferrals', 'verifiedRegistration', 'attributedRevenue', 'roas', 'customerLifetimeValue'] as const) expect(r[k]).toMatchObject({ available: false });
    expect(JSON.stringify(r)).not.toMatch(/customer_id|customerId|phone|email/i);
    const none = await acquisitionEvidence(f.db, biz, { start: new Date(Date.now() - 10 * 86_400_000), end: new Date(Date.now() - 5 * 86_400_000) }, { minGroupSize: 2 });
    expect(none.recordedPurchases).toMatchObject({ available: true, count: 0 }); expect(none.recordedPurchaseAmount).toMatchObject({ available: true, amount: '0.000000' }); // a recorded zero is distinct from unavailable
  });

  it('PRIVACY: if ANY non-empty group is below the threshold the WHOLE report is suppressed (no differencing)', async () => {
    const biz = await f.business('g4d'); const c = await f.customer({ businessId: biz, purchase: true }); void c;
    const r = await acquisitionEvidence(f.db, biz, period(), { minGroupSize: 3 });
    expect(r.suppressed).toBe(true);
    for (const k of ['invitationsIssued', 'enrollments', 'enrollmentsBySource', 'recordedPurchases', 'recordedPurchaseCustomers', 'recordedPurchaseAmount'] as const) expect(r[k]).toEqual({ available: false, reason: 'SUPPRESSED_BELOW_PRIVACY_THRESHOLD' });
    const empty = await f.business('g4e'); expect((await acquisitionEvidence(f.db, empty, period(), { minGroupSize: 5 })).suppressed).toBe(false); // an empty business has no small group to protect
  });
});
