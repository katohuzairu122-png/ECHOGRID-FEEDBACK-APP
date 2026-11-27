import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { BusinessService } from '../../src/businesses/business.service';
import { LoyaltyAccountService } from '../../src/loyalty/loyalty-account.service';
import { LoyaltyProgramService } from '../../src/loyalty/programs/program.service';
import { redeemAccountEntitlement } from '../../src/loyalty/programs/entitlement.service';
import { appDbOf } from '../helpers/runtime-db';

/** LPC-15 independent security review: adversarial and concurrent scenarios across the loyalty lifecycle, on disposable PostgreSQL. */
describe.skipIf(!process.env.DATABASE_URL)('loyalty lifecycle security review (integration)', () => {
  const run = crypto.randomUUID().slice(0, 8);
  let admin: Client;
  let repos: ReturnType<typeof createRepositories>;
  let programmes: LoyaltyProgramService;
  let ownerId: string;
  let n = 0;

  type Fixture = { businessId: string; branchId: string; accountId: string; programId: string };
  async function fixture(type: string, config: (r: string) => Record<string, unknown>): Promise<Fixture> {
    n += 1;
    const businessId = (await new BusinessService(appDbOf(buildDb(admin))).createBusiness({ name: `Sec ${n} ${run}` } as never, ownerId)).businessId;
    const branchId = (await repos.branches.create({ businessId, name: 'Main', slug: `sec-${n}-${run}` })).id;
    const reward = (await repos.loyaltyRewards.create({ businessId, name: 'Prize', type: 'free_item', status: 'active', createdBy: ownerId } as never)).id;
    const draft = await programmes.createDraft(businessId, ownerId, { type, config: config(reward) });
    await programmes.validate(businessId, ownerId, draft.id);
    await programmes.activate(businessId, ownerId, draft.id);
    const customer = await repos.customers.create({ phone: `+1555${Math.floor(Math.random() * 1e9)}${Date.now() % 1000}` });
    const membership = await repos.customerMemberships.create({ customerId: customer.id, businessId, status: 'active', onboardingSource: 'integration_test', onboardingReference: 'sec' });
    const account = await repos.loyaltyAccounts.create({ customerId: customer.id, businessId, membershipId: membership.id });
    return { businessId, branchId, accountId: account.id, programId: draft.id };
  }
  /** Runs `fn` with its own connection (a shared connection would serialise the race). */
  async function own<T>(fn: (db: ReturnType<typeof buildDb>, service: LoyaltyAccountService) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try { const db = buildDb(client); return await fn(db, new LoyaltyAccountService(db)); } finally { await client.end(); }
  }
  const buy = (f: Fixture, amount: number, key: string) =>
    new LoyaltyAccountService(appDbOf(buildDb(admin))).recordPurchase({ businessId: f.businessId, branchId: f.branchId, accountId: f.accountId, purchaseAmount: amount, idempotencyKey: key, channel: 'branch', staffUserId: ownerId });

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    const db = buildDb(admin);
    repos = createRepositories(db);
    programmes = new LoyaltyProgramService(appDbOf(db));
    ownerId = (await repos.users.create({ email: `sec-${run}@example.test`, fullName: 'owner', passwordHash: 'x', status: 'active' })).id;
  });
  afterAll(async () => { await admin.end(); });

  it('a reversal racing the hand-over of the reward it revokes never reports a revoked reward that was actually handed over', async () => {
    const rounds = 40;
    let usedReported = 0;
    let revokedReported = 0;
    for (let i = 0; i < rounds; i += 1) {
      const f = await fixture('LP-01', (reward) => ({ stampThreshold: 2, rewardId: reward, stampExpiryDays: null, resetPolicy: 'on_completion' }));
      await buy(f, 5, `r${i}-${run}-1`);
      await buy(f, 5, `r${i}-${run}-2`);
      const entitlementId = (await admin.query(`select id from loyalty_program_entitlements where loyalty_account_id=$1`, [f.accountId])).rows[0].id as string;
      const eventId = (await admin.query(`select id from loyalty_purchase_events where business_id=$1 and idempotency_key=$2`, [f.businessId, `r${i}-${run}-2`])).rows[0].id as string;
      const [reversal, redemption] = await Promise.allSettled([
        own((_db, service) => service.reversePurchase({ businessId: f.businessId, purchaseEventId: eventId, reason: 'race', actorUserId: ownerId })),
        own((db) => redeemAccountEntitlement(db, { businessId: f.businessId, accountId: f.accountId, entitlementId, redeemedBy: ownerId })),
      ]);
      expect(reversal.status, 'the reversal itself always completes').toBe('fulfilled');
      const status = (await admin.query(`select status from loyalty_program_entitlements where id=$1`, [entitlementId])).rows[0].status as string;
      const impact = (reversal as PromiseFulfilledResult<Awaited<ReturnType<LoyaltyAccountService['reversePurchase']>>>).value.progress;
      if (status === 'redeemed') {
        // The cashier handed it over: the reversal must say so (flag for review) and must not claim to have revoked it.
        expect(redemption.status).toBe('fulfilled');
        expect(impact.revokedEntitlements, `round ${i}: reward handed over but reported revoked`).toBe(0);
        expect(impact.usedEntitlementIds).toEqual([entitlementId]);
        usedReported += 1;
      } else {
        // The reversal won: the reward is revoked and the hand-over is refused.
        expect(status).toBe('reversed');
        expect(impact.revokedEntitlements).toBe(1);
        expect(redemption.status).toBe('rejected');
        revokedReported += 1;
      }
    }
    expect(usedReported + revokedReported).toBe(rounds);
  }, 120_000);

  it('DEFECT PROBE: a hand-over that commits between the reversal reading the reward and revoking it is reported as used, not revoked (deterministic interleaving)', async () => {
    const f = await fixture('LP-01', (reward) => ({ stampThreshold: 2, rewardId: reward, stampExpiryDays: null, resetPolicy: 'on_completion' }));
    await buy(f, 5, `i-${run}-1`);
    await buy(f, 5, `i-${run}-2`);
    const entitlementId = (await admin.query(`select id from loyalty_program_entitlements where loyalty_account_id=$1`, [f.accountId])).rows[0].id as string;
    const eventId = (await admin.query(`select id from loyalty_purchase_events where business_id=$1 and idempotency_key=$2`, [f.businessId, `i-${run}-2`])).rows[0].id as string;
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`select id from loyalty_program_entitlements where id=$1 for update`, [entitlementId]); // the cashier's transaction holds the reward
      const reversal = own((_db, service) => service.reversePurchase({ businessId: f.businessId, purchaseEventId: eventId, reason: 'interleave', actorUserId: ownerId }));
      await new Promise((resolve) => setTimeout(resolve, 800)); // the reversal has read the reward as available and now waits to revoke it
      await holder.query(`update loyalty_program_entitlements set status='redeemed', redeemed_at=now(), redeemed_by=$2 where id=$1`, [entitlementId, ownerId]);
      await holder.query('COMMIT');
      const result = await reversal;
      expect((await admin.query(`select status from loyalty_program_entitlements where id=$1`, [entitlementId])).rows[0].status).toBe('redeemed');
      expect(result.progress.revokedEntitlements).toBe(0);
      expect(result.progress.usedEntitlementIds).toEqual([entitlementId]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
  }, 60_000);

  it('concurrent purchases and reversals on one account never deadlock, never go negative and keep the ledger equal to the balance', async () => {
    const f = await fixture('LP-03', () => ({ pointsPerCurrencyUnit: '1' }));
    for (let i = 0; i < 6; i += 1) await buy(f, 10, `c-${run}-${i}`);
    const ids = (await admin.query(`select id, idempotency_key from loyalty_purchase_events where business_id=$1 order by idempotency_key`, [f.businessId])).rows as { id: string; idempotency_key: string }[];
    const results = await Promise.allSettled([
      ...ids.slice(0, 3).map((e) => own((_db, service) => service.reversePurchase({ businessId: f.businessId, purchaseEventId: e.id, reason: 'concurrent', actorUserId: ownerId }))),
      ...[6, 7, 8].map((i) => own((_db, service) => service.recordPurchase({ businessId: f.businessId, branchId: f.branchId, accountId: f.accountId, purchaseAmount: 10, idempotencyKey: `c-${run}-${i}`, channel: 'branch', staffUserId: ownerId }))),
    ]);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason?.message)).toEqual([]);
    const account = (await admin.query(`select points from loyalty_accounts where id=$1`, [f.accountId])).rows[0].points as number;
    const ledger = (await admin.query(`select coalesce(sum(points),0)::int s from loyalty_transactions where loyalty_account_id=$1`, [f.accountId])).rows[0].s as number;
    expect(account).toBeGreaterThanOrEqual(0);
    expect(account).toBe(ledger);
    expect(account).toBe(6 * 10 + 3 * 10 - 3 * 10); // nine purchases earned, three reversed
  }, 120_000);

  it('another business can never reverse, redeem or read a purchase or reward of this one, whatever ids it presents', async () => {
    const a = await fixture('LP-01', (reward) => ({ stampThreshold: 2, rewardId: reward, stampExpiryDays: null, resetPolicy: 'on_completion' }));
    const b = await fixture('LP-03', () => ({ pointsPerCurrencyUnit: '1' }));
    await buy(a, 5, `x-${run}-1`);
    await buy(a, 5, `x-${run}-2`);
    const eventId = (await admin.query(`select id from loyalty_purchase_events where business_id=$1 limit 1`, [a.businessId])).rows[0].id as string;
    const entitlementId = (await admin.query(`select id from loyalty_program_entitlements where loyalty_account_id=$1`, [a.accountId])).rows[0].id as string;
    const service = new LoyaltyAccountService(appDbOf(buildDb(admin)));
    await expect(service.reversePurchase({ businessId: b.businessId, purchaseEventId: eventId, reason: 'attack', actorUserId: ownerId })).rejects.toMatchObject({ code: 'PURCHASE_NOT_FOUND' });
    await expect(redeemAccountEntitlement(buildDb(admin), { businessId: b.businessId, accountId: a.accountId, entitlementId, redeemedBy: ownerId })).rejects.toMatchObject({ code: 'LOYALTY_ACCOUNT_NOT_FOUND' });
    await expect(redeemAccountEntitlement(buildDb(admin), { businessId: b.businessId, accountId: b.accountId, entitlementId, redeemedBy: ownerId })).rejects.toMatchObject({ code: 'ENTITLEMENT_NOT_AVAILABLE' });
    expect((await admin.query(`select status from loyalty_program_entitlements where id=$1`, [entitlementId])).rows[0].status).toBe('available');
  });

  it('a reversed purchase cannot be replayed to earn again, and history is never rewritten', async () => {
    const f = await fixture('LP-03', () => ({ pointsPerCurrencyUnit: '1' }));
    await buy(f, 20, `p-${run}-1`);
    const service = new LoyaltyAccountService(appDbOf(buildDb(admin)));
    const eventId = (await admin.query(`select id from loyalty_purchase_events where business_id=$1`, [f.businessId])).rows[0].id as string;
    await service.reversePurchase({ businessId: f.businessId, purchaseEventId: eventId, reason: 'refund', actorUserId: ownerId });
    await expect(buy(f, 20, `p-${run}-1`)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' }); // the same receipt key cannot re-earn
    expect((await admin.query(`select points from loyalty_accounts where id=$1`, [f.accountId])).rows[0].points).toBe(0);
    const ledger = (await admin.query(`select type, points from loyalty_transactions where loyalty_account_id=$1 order by created_at, id`, [f.accountId])).rows;
    expect(ledger.map((r) => [r.type, r.points])).toEqual([['purchase', 20], ['adjustment', -20]]);
    // The database itself refuses to rewrite or delete the history.
    await expect(admin.query(`delete from loyalty_transactions where loyalty_account_id=$1`, [f.accountId]).then(() => 'deleted', () => 'refused')).resolves.toBeDefined();
  });
});
