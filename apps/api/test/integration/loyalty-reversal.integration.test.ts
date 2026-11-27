import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { BusinessService } from '../../src/businesses/business.service';
import { LoyaltyAccountService } from '../../src/loyalty/loyalty-account.service';
import { LoyaltyProgramService } from '../../src/loyalty/programs/program.service';
import { consumeEntitlement } from '../../src/loyalty/programs/stamp.service';
import { getPurchase, listPurchases } from '../../src/loyalty/programs/purchase-history.service';
import { appDbOf } from '../helpers/runtime-db';

/** LPC-08 purchase reversal on a disposable PostgreSQL database (Owner rules: stop at zero, flag used rewards, never delete). */
describe.skipIf(!process.env.DATABASE_URL)('purchase reversal (integration)', () => {
  const run = crypto.randomUUID().slice(0, 8);
  let admin: Client;
  let repos: ReturnType<typeof createRepositories>;
  let programmes: LoyaltyProgramService;
  let loyalty: LoyaltyAccountService;
  let ownerId: string;
  let n = 0;

  type Fixture = { businessId: string; branchId: string; rewardA: string; rewardB: string; accountId: string; programId: string };
  /** A business with its own active programme and one member, so scenarios never share state. */
  async function fixture(type: string, config: (r: { a: string; b: string }) => Record<string, unknown>): Promise<Fixture> {
    n += 1;
    const businessId = (await new BusinessService(appDbOf(buildDb(admin))).createBusiness({ name: `Rev ${n} ${run}` } as never, ownerId)).businessId;
    const branchId = (await repos.branches.create({ businessId, name: 'Main', slug: `rev-${n}-${run}` })).id;
    const rewardA = (await repos.loyaltyRewards.create({ businessId, name: 'Reward A', type: 'free_item', status: 'active', createdBy: ownerId } as never)).id;
    const rewardB = (await repos.loyaltyRewards.create({ businessId, name: 'Reward B', type: 'free_item', status: 'active', createdBy: ownerId } as never)).id;
    const draft = await programmes.createDraft(businessId, ownerId, { type, config: config({ a: rewardA, b: rewardB }) });
    await programmes.validate(businessId, ownerId, draft.id);
    await programmes.activate(businessId, ownerId, draft.id);
    const customer = await repos.customers.create({ phone: `+1555${Math.floor(Math.random() * 1e9)}${Date.now() % 1000}` });
    const membership = await repos.customerMemberships.create({ customerId: customer.id, businessId, status: 'active', onboardingSource: 'integration_test', onboardingReference: 'rev' });
    const account = await repos.loyaltyAccounts.create({ customerId: customer.id, businessId, membershipId: membership.id });
    return { businessId, branchId, rewardA, rewardB, accountId: account.id, programId: draft.id };
  }
  const buy = (f: Fixture, amount: number, key: string) =>
    loyalty.recordPurchase({ businessId: f.businessId, branchId: f.branchId, accountId: f.accountId, purchaseAmount: amount, idempotencyKey: key, channel: 'branch', staffUserId: ownerId });
  const eventId = async (f: Fixture, key: string) => (await admin.query(`select id from loyalty_purchase_events where business_id=$1 and idempotency_key=$2`, [f.businessId, key])).rows[0].id as string;
  const reverse = (f: Fixture, key: string, service = loyalty) => eventId(f, key).then((id) => service.reversePurchase({ businessId: f.businessId, purchaseEventId: id, reason: 'Refunded at the counter', actorUserId: ownerId }));
  const points = async (f: Fixture) => (await admin.query(`select points from loyalty_accounts where id=$1`, [f.accountId])).rows[0].points as number;
  const counters = async (f: Fixture) => (await admin.query(`select counters from loyalty_program_progress where program_id=$1 and loyalty_account_id=$2`, [f.programId, f.accountId])).rows[0]?.counters;
  const entitlements = async (f: Fixture) => (await admin.query(`select source_key, status from loyalty_program_entitlements where loyalty_account_id=$1 order by source_key`, [f.accountId])).rows as { source_key: string; status: string }[];

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    const db = buildDb(admin);
    repos = createRepositories(db);
    programmes = new LoyaltyProgramService(appDbOf(db));
    loyalty = new LoyaltyAccountService(appDbOf(db));
    ownerId = (await repos.users.create({ email: `rev-${run}@example.test`, fullName: 'owner', passwordHash: 'x', status: 'active' })).id;
  });
  afterAll(async () => { await admin.end(); });

  it('takes back the points, marks the purchase reversed, keeps history, and refuses a second reversal', async () => {
    const f = await fixture('LP-03', () => ({ pointsPerCurrencyUnit: '1' }));
    await buy(f, 10, `p-${run}-1`);
    await buy(f, 20, `p-${run}-2`);
    expect(await points(f)).toBe(30);
    const result = await reverse(f, `p-${run}-2`);
    expect(result).toMatchObject({ pointsEarned: 20, pointsReversed: 20, pointsShortfall: 0 });
    expect(await points(f)).toBe(10);
    expect((await admin.query(`select payment_status from loyalty_purchase_events where idempotency_key=$1 and business_id=$2`, [`p-${run}-2`, f.businessId])).rows[0].payment_status).toBe('reversed');
    const ledger = (await admin.query(`select type, points, notes from loyalty_transactions where loyalty_account_id=$1 order by created_at, id`, [f.accountId])).rows;
    expect(ledger.map((r) => [r.type, r.points])).toEqual([['purchase', 10], ['purchase', 20], ['adjustment', -20]]);
    expect(ledger[2].notes).toContain('Reversal of purchase');
    await expect(reverse(f, `p-${run}-2`)).rejects.toMatchObject({ code: 'PURCHASE_ALREADY_REVERSED' });
    expect(await points(f)).toBe(10);
  });

  it('never takes the balance below zero and records the shortfall when the points were already spent', async () => {
    const f = await fixture('LP-03', () => ({ pointsPerCurrencyUnit: '1' }));
    await buy(f, 50, `s-${run}-1`);
    await loyalty.adjustPoints(f.businessId, f.accountId, -35, 'spent on a reward', ownerId);
    expect(await points(f)).toBe(15);
    const result = await reverse(f, `s-${run}-1`);
    expect(result).toMatchObject({ pointsEarned: 50, pointsReversed: 15, pointsShortfall: 35 });
    expect(await points(f)).toBe(0);
    const note = (await admin.query(`select notes from loyalty_transactions where loyalty_account_id=$1 and type='adjustment' order by created_at desc limit 1`, [f.accountId])).rows[0].notes as string;
    expect(note).toContain('35 points could not be taken back');
  });

  it('another business cannot reverse this purchase, and an unknown purchase is not found', async () => {
    const f = await fixture('LP-03', () => ({ pointsPerCurrencyUnit: '1' }));
    const other = await fixture('LP-03', () => ({ pointsPerCurrencyUnit: '1' }));
    await buy(f, 10, `t-${run}-1`);
    const id = await eventId(f, `t-${run}-1`);
    await expect(loyalty.reversePurchase({ businessId: other.businessId, purchaseEventId: id, reason: 'attempt', actorUserId: ownerId })).rejects.toMatchObject({ code: 'PURCHASE_NOT_FOUND' });
    await expect(loyalty.reversePurchase({ businessId: f.businessId, purchaseEventId: crypto.randomUUID(), reason: 'attempt', actorUserId: ownerId })).rejects.toMatchObject({ code: 'PURCHASE_NOT_FOUND' });
    expect(await points(f)).toBe(10);
  });

  it('two simultaneous reversals of one purchase: exactly one succeeds and the points are taken back once', async () => {
    const f = await fixture('LP-03', () => ({ pointsPerCurrencyUnit: '1' }));
    await buy(f, 40, `r-${run}-1`);
    const id = await eventId(f, `r-${run}-1`);
    const clients = await Promise.all([0, 1].map(async () => { const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); return c; }));
    try {
      const results = await Promise.allSettled(clients.map((c) => new LoyaltyAccountService(buildDb(c)).reversePurchase({ businessId: f.businessId, purchaseEventId: id, reason: 'race', actorUserId: ownerId })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
    expect(await points(f)).toBe(0);
  });

  it('LP-01: reversing the stamp that completed a card revokes the unused reward and reopens the card', async () => {
    const f = await fixture('LP-01', (r) => ({ stampThreshold: 3, rewardId: r.a, stampExpiryDays: null, resetPolicy: 'on_completion' }));
    for (const i of [1, 2, 3]) await buy(f, 5, `l1-${run}-${i}`);
    expect(await entitlements(f)).toEqual([{ source_key: 'cycle:1', status: 'available' }]);
    const result = await reverse(f, `l1-${run}-3`);
    expect(result.progress).toMatchObject({ programmesAdjusted: 1, revokedEntitlements: 1, usedEntitlementIds: [] });
    expect(await counters(f)).toMatchObject({ stamps: 2, cycle: 0 });
    expect(await entitlements(f)).toEqual([{ source_key: 'cycle:1', status: 'reversed' }]);
    // The card can be completed again, earning a new reward for cycle 1 only once the stamp is bought again.
    await buy(f, 5, `l1-${run}-4`);
    expect(await counters(f)).toMatchObject({ stamps: 0, cycle: 1 });
  });

  it('LP-01: a reward already handed over stays given and is flagged for review', async () => {
    const f = await fixture('LP-01', (r) => ({ stampThreshold: 3, rewardId: r.a, stampExpiryDays: null, resetPolicy: 'on_completion' }));
    for (const i of [1, 2, 3]) await buy(f, 5, `u1-${run}-${i}`);
    const [entitlement] = (await admin.query(`select id from loyalty_program_entitlements where loyalty_account_id=$1`, [f.accountId])).rows;
    await consumeEntitlement(buildDb(admin), { businessId: f.businessId, entitlementId: entitlement.id, redeemedBy: ownerId });
    const result = await reverse(f, `u1-${run}-3`);
    expect(result.progress.usedEntitlementIds).toEqual([entitlement.id]);
    expect(result.progress.revokedEntitlements).toBe(0);
    expect(await entitlements(f)).toEqual([{ source_key: 'cycle:1', status: 'redeemed' }]);
    expect(await counters(f)).toMatchObject({ stamps: 2, cycle: 0 });
  });

  it('LP-04: reversing a purchase that crossed the second rung revokes only that rung’s reward', async () => {
    const f = await fixture('LP-04', (r) => ({ metric: 'purchases', milestones: [{ threshold: '2', rewardId: r.a }, { threshold: '4', rewardId: r.b }] }));
    for (const i of [1, 2, 3, 4]) await buy(f, 5, `m-${run}-${i}`);
    expect((await entitlements(f)).map((e) => e.status)).toEqual(['available', 'available']);
    const result = await reverse(f, `m-${run}-4`);
    expect(result.progress.revokedEntitlements).toBe(1);
    expect(await counters(f)).toMatchObject({ count: 3 });
    const after = await entitlements(f);
    expect(after.find((e) => e.source_key.includes('2'))?.status).toBe('available');
    expect(after.filter((e) => e.status === 'reversed')).toHaveLength(1);
    // A reversed purchase earlier in the history is left out of every later reversal too.
    const second = await reverse(f, `m-${run}-3`);
    expect(await counters(f)).toMatchObject({ count: 2 });
    expect(second.progress.revokedEntitlements).toBe(0);
  });

  it('refuses to reverse, and changes nothing, when the stored progress cannot be reproduced from its history', async () => {
    const f = await fixture('LP-04', (r) => ({ metric: 'purchases', milestones: [{ threshold: '2', rewardId: r.a }] }));
    for (const i of [1, 2]) await buy(f, 5, `x-${run}-${i}`);
    await admin.query(`update loyalty_program_progress set counters = jsonb_set(counters, '{count}', '99') where program_id=$1 and loyalty_account_id=$2`, [f.programId, f.accountId]);
    const before = await points(f);
    await expect(reverse(f, `x-${run}-2`)).rejects.toMatchObject({ code: 'PROGRESS_REPLAY_MISMATCH' });
    expect(await points(f)).toBe(before);
    expect((await admin.query(`select payment_status from loyalty_purchase_events where business_id=$1 and idempotency_key=$2`, [f.businessId, `x-${run}-2`])).rows[0].payment_status).toBe('confirmed');
  });

  it('LPC-10: the preview shows exactly what the reversal then does, and changes nothing itself', async () => {
    const f = await fixture('LP-01', (r) => ({ stampThreshold: 3, rewardId: r.a, stampExpiryDays: null, resetPolicy: 'on_completion' }));
    for (const i of [1, 2, 3]) await buy(f, 5, `pv-${run}-${i}`);
    const id = await eventId(f, `pv-${run}-3`);
    const snapshot = async () => JSON.stringify([
      await points(f), await counters(f), await entitlements(f),
      (await admin.query(`select payment_status from loyalty_purchase_events where id=$1`, [id])).rows[0].payment_status,
      (await admin.query(`select count(*)::int c from loyalty_transactions where loyalty_account_id=$1`, [f.accountId])).rows[0].c,
      (await admin.query(`select count(*)::int c from loyalty_program_progress_events where loyalty_account_id=$1`, [f.accountId])).rows[0].c,
    ]);
    const before = await snapshot();
    const preview = await loyalty.previewPurchaseReversal({ businessId: f.businessId, purchaseEventId: id, reason: 'preview', actorUserId: ownerId });
    expect(await snapshot()).toBe(before);
    expect(preview.progress.rewardImpact).toEqual([{ rewardName: 'Reward A', outcome: 'revoked' }]);
    const real = await loyalty.reversePurchase({ businessId: f.businessId, purchaseEventId: id, reason: 'Refunded', actorUserId: ownerId });
    expect({ ...real, progress: real.progress.rewardImpact }).toEqual({ ...preview, progress: preview.progress.rewardImpact });
    await expect(loyalty.previewPurchaseReversal({ businessId: f.businessId, purchaseEventId: id, reason: 'again', actorUserId: ownerId })).rejects.toMatchObject({ code: 'PURCHASE_ALREADY_REVERSED' });
  });

  it('LPC-10: the purchase history is business-scoped, filterable, exact, and shows the reversal with its shortfall', async () => {
    const f = await fixture('LP-03', () => ({ pointsPerCurrencyUnit: '1' }));
    const other = await fixture('LP-03', () => ({ pointsPerCurrencyUnit: '1' }));
    await buy(f, 12.5, `h-${run}-1`);
    await buy(f, 50, `h-${run}-2`);
    await buy(other, 99, `h-${run}-o`);
    await loyalty.adjustPoints(f.businessId, f.accountId, -40, 'spent', ownerId);
    await reverse(f, `h-${run}-2`);
    const all = await listPurchases(buildDb(admin), { businessId: f.businessId, limit: 10, offset: 0 });
    expect(all.items).toHaveLength(2);
    expect(all.items.map((p) => p.amount)).not.toContain('99.00');
    expect(all.items.every((p) => p.accountId === f.accountId)).toBe(true);
    const reversed = all.items.find((p) => p.status === 'reversed')!;
    expect(reversed).toMatchObject({ amount: '50.000', pointsEarned: 50, reversal: { pointsReversed: 22, pointsShortfall: 28 } });
    expect(typeof reversed.amount).toBe('string');
    expect((await listPurchases(buildDb(admin), { businessId: f.businessId, status: 'confirmed', limit: 10, offset: 0 })).items.map((p) => p.amount)).toEqual(['12.500']);
    expect((await listPurchases(buildDb(admin), { businessId: f.businessId, limit: 1, offset: 0 })).hasMore).toBe(true);
    await expect(getPurchase(buildDb(admin), other.businessId, reversed.id)).rejects.toMatchObject({ code: 'PURCHASE_NOT_FOUND' });
    expect(await getPurchase(buildDb(admin), f.businessId, reversed.id)).toMatchObject({ status: 'reversed' });
  });
});
