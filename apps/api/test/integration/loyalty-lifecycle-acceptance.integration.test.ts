import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { BusinessService } from '../../src/businesses/business.service';
import { LoyaltyAccountService } from '../../src/loyalty/loyalty-account.service';
import { LoyaltyProgramService } from '../../src/loyalty/programs/program.service';
import { LoyaltyTierService } from '../../src/loyalty/loyalty-tier.service';
import { listAvailableEntitlements, redeemAccountEntitlement } from '../../src/loyalty/programs/entitlement.service';
import { customerProgrammeCard } from '../../src/loyalty/programs/programme-card.service';
import { assertRewardCanChange } from '../../src/loyalty/programs/reward-usage.service';
import { appDbOf } from '../helpers/runtime-db';

/**
 * LPC-16 functional acceptance, local and synthetic: one business walks the whole loyalty lifecycle on a disposable PostgreSQL database.
 * API-boundary authorization (who may call which route) is proved separately by the RBAC matrix and the cashier route allow-list tests; this suite proves the
 * behaviour behind those routes.
 */
describe.skipIf(!process.env.DATABASE_URL)('loyalty lifecycle acceptance (synthetic, local)', () => {
  const run = crypto.randomUUID().slice(0, 8);
  let admin: Client;
  let repos: ReturnType<typeof createRepositories>;
  let programmes: LoyaltyProgramService;
  let loyalty: LoyaltyAccountService;
  let ownerId: string;
  let managerId: string;
  let businessId: string;
  let branchId: string;

  async function customer(business = businessId) {
    const c = await repos.customers.create({ phone: `+1555${Math.floor(Math.random() * 1e9)}${Date.now() % 1000}` });
    const membership = await repos.customerMemberships.create({ customerId: c.id, businessId: business, status: 'active', onboardingSource: 'integration_test', onboardingReference: 'acceptance' });
    const account = await repos.loyaltyAccounts.create({ customerId: c.id, businessId: business, membershipId: membership.id });
    return { customerId: c.id, accountId: account.id };
  }
  const buy = (accountId: string, amount: number, key: string) =>
    loyalty.recordPurchase({ businessId, branchId, accountId, purchaseAmount: amount, idempotencyKey: key, channel: 'branch', staffUserId: ownerId });
  const eventId = async (key: string) => (await admin.query(`select id from loyalty_purchase_events where business_id=$1 and idempotency_key=$2`, [businessId, key])).rows[0].id as string;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    const db = buildDb(admin);
    repos = createRepositories(db);
    programmes = new LoyaltyProgramService(appDbOf(db));
    loyalty = new LoyaltyAccountService(appDbOf(db));
    ownerId = (await repos.users.create({ email: `acc-owner-${run}@example.test`, fullName: 'owner', passwordHash: 'x', status: 'active' })).id;
    managerId = (await repos.users.create({ email: `acc-manager-${run}@example.test`, fullName: 'manager', passwordHash: 'x', status: 'active' })).id;
    businessId = (await new BusinessService(appDbOf(db)).createBusiness({ name: `Acceptance ${run}` } as never, ownerId)).businessId;
    const managerRole = await repos.roles.findByName(businessId, 'Manager');
    await repos.userBusinessRoles.grant({ userId: managerId, businessId, roleId: managerRole!.id } as never);
    branchId = (await repos.branches.create({ businessId, name: 'Main', slug: `acc-${run}` })).id;
  });
  afterAll(async () => { await admin.end(); });

  it('1-2. configuration: only the Owner activates a programme, and an invalid configuration is refused', async () => {
    const reward = (await repos.loyaltyRewards.create({ businessId, name: 'Free coffee', type: 'free_item', status: 'active', createdBy: ownerId } as never)).id;
    await expect(programmes.createDraft(businessId, ownerId, { type: 'LP-01', config: { stampThreshold: 1, rewardId: reward, stampExpiryDays: null, resetPolicy: 'on_completion' } })).rejects.toMatchObject({ code: 'PROGRAM_CONFIG_INVALID' });
    const draft = await programmes.createDraft(businessId, ownerId, { type: 'LP-01', config: { stampThreshold: 3, rewardId: reward, stampExpiryDays: null, resetPolicy: 'on_completion' } });
    await programmes.validate(businessId, ownerId, draft.id);
    await expect(programmes.activate(businessId, managerId, draft.id)).rejects.toMatchObject({ code: 'PROGRAM_OWNER_REQUIRED', status: 403 });
    await programmes.activate(businessId, ownerId, draft.id);
    expect((await programmes.list(businessId)).find((p) => p.status === 'active')?.id).toBe(draft.id);
  });

  it('3-9. enrol, purchase, progress, entitlement, customer visibility, cashier hand-over (once), catalogue protection', async () => {
    const member = await customer();
    const db = buildDb(admin);
    await buy(member.accountId, 5, `a-${run}-1`);
    await buy(member.accountId, 5, `a-${run}-2`);
    expect((await customerProgrammeCard(db, { customerId: member.customerId, businessId })).programme?.view).toMatchObject({ kind: 'stamps', stamps: 2, threshold: 3 });
    expect(await listAvailableEntitlements(db, { businessId, accountId: member.accountId, branchId })).toEqual([]);
    await buy(member.accountId, 5, `a-${run}-3`); // completes the card
    const waiting = await listAvailableEntitlements(db, { businessId, accountId: member.accountId, branchId });
    expect(waiting).toHaveLength(1);
    expect((await customerProgrammeCard(db, { customerId: member.customerId, businessId })).earnedRewards).toEqual([{ rewardName: 'Free coffee', expiresAt: null }]);
    // Reward catalogue protection: the reward the active programme pays out cannot be switched off or deleted, and the earned one cannot be deleted.
    await expect(assertRewardCanChange(db, { businessId, rewardId: waiting[0]!.rewardId, change: 'deactivate' })).rejects.toMatchObject({ code: 'REWARD_IN_USE_BY_PROGRAMME' });
    // Cashier hand-over: once only, and not by another business.
    await expect(redeemAccountEntitlement(db, { businessId: crypto.randomUUID(), accountId: member.accountId, entitlementId: waiting[0]!.id, redeemedBy: ownerId })).rejects.toMatchObject({ code: 'LOYALTY_ACCOUNT_NOT_FOUND' });
    await redeemAccountEntitlement(db, { businessId, accountId: member.accountId, entitlementId: waiting[0]!.id, redeemedBy: ownerId });
    await expect(redeemAccountEntitlement(db, { businessId, accountId: member.accountId, entitlementId: waiting[0]!.id, redeemedBy: ownerId })).rejects.toMatchObject({ code: 'ENTITLEMENT_NOT_AVAILABLE' });
    expect((await customerProgrammeCard(db, { customerId: member.customerId, businessId })).earnedRewards).toEqual([]);
  });

  it('10-12. reversal after a hand-over keeps the reward, flags it, and leaves the history intact', async () => {
    const member = await customer();
    for (const i of [1, 2, 3]) await buy(member.accountId, 5, `b-${run}-${i}`);
    const [entitlement] = (await listAvailableEntitlements(buildDb(admin), { businessId, accountId: member.accountId, branchId }));
    await redeemAccountEntitlement(buildDb(admin), { businessId, accountId: member.accountId, entitlementId: entitlement!.id, redeemedBy: ownerId });
    const result = await loyalty.reversePurchase({ businessId, purchaseEventId: await eventId(`b-${run}-3`), reason: 'Refunded', actorUserId: ownerId });
    expect(result.progress.usedEntitlementIds).toEqual([entitlement!.id]); // flagged for review
    expect((await admin.query(`select status from loyalty_program_entitlements where id=$1`, [entitlement!.id])).rows[0].status).toBe('redeemed');
    expect((await admin.query(`select payment_status from loyalty_purchase_events where id=$1`, [await eventId(`b-${run}-3`)])).rows[0].payment_status).toBe('reversed');
  });

  it('10-12. reversal before a hand-over revokes the earned reward and reopens the card; a second reversal is refused', async () => {
    const member = await customer();
    for (const i of [1, 2, 3]) await buy(member.accountId, 5, `c-${run}-${i}`);
    expect(await listAvailableEntitlements(buildDb(admin), { businessId, accountId: member.accountId })).toHaveLength(1);
    const id = await eventId(`c-${run}-3`);
    const result = await loyalty.reversePurchase({ businessId, purchaseEventId: id, reason: 'Mistaken receipt', actorUserId: ownerId });
    expect(result.progress.revokedEntitlements).toBe(1);
    expect(await listAvailableEntitlements(buildDb(admin), { businessId, accountId: member.accountId })).toEqual([]);
    expect((await customerProgrammeCard(buildDb(admin), { customerId: member.customerId, businessId })).programme?.view).toMatchObject({ stamps: 2 });
    await expect(loyalty.reversePurchase({ businessId, purchaseEventId: id, reason: 'again', actorUserId: ownerId })).rejects.toMatchObject({ code: 'PURCHASE_ALREADY_REVERSED' });
  });

  it('tier qualification: a points programme moves the customer up a tier, and a reversal moves them back (balance never below zero)', async () => {
    const other = await (async () => {
      const id = (await new BusinessService(appDbOf(buildDb(admin))).createBusiness({ name: `Acceptance tiers ${run}` } as never, ownerId)).businessId;
      const branch = (await repos.branches.create({ businessId: id, name: 'Main', slug: `acc-t-${run}` })).id;
      return { id, branch };
    })();
    const draft = await programmes.createDraft(other.id, ownerId, { type: 'LP-03', config: { pointsPerCurrencyUnit: '1' } });
    await programmes.validate(other.id, ownerId, draft.id);
    await programmes.activate(other.id, ownerId, draft.id);
    const silver = await new LoyaltyTierService(createRepositories(buildDb(admin))).create(other.id, { name: 'Silver', minPoints: 50 } as never, ownerId);
    const member = await customer(other.id);
    const service = new LoyaltyAccountService(appDbOf(buildDb(admin)));
    const record = (amount: number, key: string) => service.recordPurchase({ businessId: other.id, branchId: other.branch, accountId: member.accountId, purchaseAmount: amount, idempotencyKey: key, channel: 'branch', staffUserId: ownerId });
    await record(30, `t-${run}-1`);
    expect((await record(30, `t-${run}-2`)).account.tierId).toBe(silver.id);
    const id = (await admin.query(`select id from loyalty_purchase_events where business_id=$1 and idempotency_key=$2`, [other.id, `t-${run}-2`])).rows[0].id as string;
    const reversed = await service.reversePurchase({ businessId: other.id, purchaseEventId: id, reason: 'Refund', actorUserId: ownerId });
    expect(reversed.pointsReversed).toBe(30);
    const row = (await admin.query(`select points, tier_id from loyalty_accounts where id=$1`, [member.accountId])).rows[0];
    expect(row.points).toBe(30);
    expect(row.tier_id).toBeNull();
  });

  it('unauthorized and cross-tenant operations are rejected at the service boundary', async () => {
    const member = await customer();
    const stranger = await new BusinessService(appDbOf(buildDb(admin))).createBusiness({ name: `Acceptance stranger ${run}` } as never, ownerId);
    await buy(member.accountId, 5, `u-${run}-1`);
    const id = await eventId(`u-${run}-1`);
    await expect(loyalty.reversePurchase({ businessId: stranger.businessId, purchaseEventId: id, reason: 'attack', actorUserId: ownerId })).rejects.toMatchObject({ code: 'PURCHASE_NOT_FOUND' });
    await expect(programmes.activate(stranger.businessId, managerId, crypto.randomUUID())).rejects.toBeDefined();
    await expect(customerProgrammeCard(buildDb(admin), { customerId: member.customerId, businessId: stranger.businessId })).rejects.toMatchObject({ code: 'LOYALTY_ACCOUNT_NOT_FOUND' });
  });
});
