import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as schema from '../db/schema';
import type { Database } from '../db/client';
import { createRepositories, type QrCode } from '../repositories';
import { BranchLoyaltyService } from './branch-loyalty.service';

// Real embedded PostgreSQL executes the committed migration chain. The adapter
// cast only bridges the node-postgres/PGlite client types; queries and rollback
// are executed by PostgreSQL, rather than mocked transaction callbacks.
describe('Branch loyalty migration and transaction behavior', () => {
  let engine: PGlite;
  let db: Database;
  let service: BranchLoyaltyService;
  let businessId: string;
  let branchId: string;
  let otherBranchId: string;
  let customerId: string;
  const actor = crypto.randomUUID();
  const program = {
    onboardingMode: 'business_only' as const,
    listedInCommunity: true,
    qualifyingPurchaseDescription: 'Paid coffees qualify, one stamp each.',
    unitLabel: 'stamps',
    rewardName: 'Free coffee',
    rewardCost: 4,
    feedbackBonusUnits: 0,
    enabled: true,
  };
  beforeAll(async () => {
    engine = new PGlite();
    const journal = JSON.parse(readFileSync(resolve('drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    for (const entry of journal.entries)
      await engine.exec(readFileSync(resolve(`drizzle/${entry.tag}.sql`), 'utf8'));
    db = drizzle(engine, { schema }) as unknown as Database;
    service = new BranchLoyaltyService(db);
  }, 60000);
  afterAll(async () => {
    await engine?.close();
  });
  beforeEach(async () => {
    const repos = createRepositories(db);
    businessId = (
      await repos.businesses.create({ name: 'Purchase test business', slug: crypto.randomUUID() })
    ).id;
    branchId = (await repos.branches.create({ businessId, name: 'First', slug: 'first' })).id;
    otherBranchId = (await repos.branches.create({ businessId, name: 'Second', slug: 'second' }))
      .id;
    customerId = (
      await repos.customers.create({
        phone: `+965${Math.floor(Math.random() * 100000000)}`,
        phoneVerifiedAt: new Date(),
      })
    ).id;
    await service.configure(businessId, branchId, program, actor);
    await service.configure(businessId, otherBranchId, program, actor);
  });
  const join = () => service.join(customerId, businessId, branchId, false);
  async function purchase(units = 4) {
    const membership = (await join())!;
    const input = {
      membershipId: membership.id,
      receiptReference: crypto.randomUUID(),
      qualifyingUnits: units,
      evidence: 'Paid coffee receipt checked by staff',
    };
    return {
      membership,
      input,
      entry: (await service.purchase(businessId, branchId, input, actor))!,
    };
  }
  it('QR enrollment stays pending and earns nothing; repeat enrollment is idempotent', async () => {
    const first = (await join())!;
    expect((await join())!.id).toBe(first.id);
    const accounts = await service.list(customerId);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ units: 0, activatedAt: null });
    await expect(service.redeem(customerId, first.id, crypto.randomUUID())).rejects.toMatchObject({
      code: 'PURCHASE_REQUIRED',
    });
  });
  it('first purchase activates membership, credits only the exact branch, and retries do not double-credit', async () => {
    const { membership, input, entry } = await purchase();
    await service.join(customerId, businessId, otherBranchId, false);
    expect((await service.purchase(businessId, branchId, input, actor))!.id).toBe(entry.id);
    const accounts = await service.list(customerId);
    expect(accounts.find((a) => a.id === membership.id)).toMatchObject({ units: 4 });
    expect(accounts.find((a) => a.branchId === otherBranchId)).toMatchObject({
      units: 0,
      activatedAt: null,
    });
    expect(accounts.find((a) => a.id === membership.id)?.activatedAt).toBeInstanceOf(Date);
    await expect(
      service.purchase(businessId, branchId, { ...input, qualifyingUnits: 8 }, actor),
    ).rejects.toMatchObject({ code: 'REFERENCE_ALREADY_USED' });
  });
  it('refuses cross-branch staff recording and foreign customer redemption', async () => {
    const { membership, input } = await purchase();
    await expect(service.purchase(businessId, otherBranchId, input, actor)).rejects.toMatchObject({
      code: 'MEMBERSHIP_NOT_FOUND',
    });
    await expect(
      service.redeem(crypto.randomUUID(), membership.id, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: 'MEMBERSHIP_NOT_FOUND' });
  });
  it('reserves balance once and fulfillment is idempotent and branch-scoped', async () => {
    const { membership } = await purchase();
    const requestId = crypto.randomUUID();
    const reward = (await service.redeem(customerId, membership.id, requestId))!;
    expect((await service.redeem(customerId, membership.id, requestId))!.code).toBe(reward.code);
    expect((await service.list(customerId))[0]?.units).toBe(0);
    await expect(
      service.redeem(customerId, membership.id, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_POINTS' });
    await expect(
      service.confirm(businessId, otherBranchId, reward.code!, actor),
    ).rejects.toMatchObject({ code: 'REDEMPTION_NOT_FOUND' });
    expect(
      (await service.confirm(businessId, branchId, reward.code!, actor))!.confirmedAt,
    ).toBeInstanceOf(Date);
    expect((await service.confirm(businessId, branchId, reward.code!, actor))!.id).toBe(reward.id);
  });
  it('refund appends exactly one reversal and removes activation after the last qualifying purchase', async () => {
    const { entry } = await purchase();
    const reversal = (await service.refund(
      businessId,
      branchId,
      entry.id,
      'Order refunded',
      actor,
    ))!;
    expect((await service.refund(businessId, branchId, entry.id, 'Retry', actor))!.id).toBe(
      reversal.id,
    );
    expect((await service.list(customerId))[0]).toMatchObject({ units: 0, activatedAt: null });
  });
  it('spent or reserved purchase rewards require review without a partial refund mutation', async () => {
    const { entry, membership } = await purchase();
    await service.redeem(customerId, membership.id, crypto.randomUUID());
    await expect(
      service.refund(businessId, branchId, entry.id, 'Refund requested', actor),
    ).rejects.toMatchObject({ code: 'REFUND_REQUIRES_REVIEW' });
    expect(await service.history(customerId, membership.id)).toHaveLength(2);
  });
  it('community mode requires explicit acceptance; business-only enrollment never removes an earlier opt-in', async () => {
    await service.configure(
      businessId,
      branchId,
      { ...program, onboardingMode: 'community' },
      actor,
    );
    await expect(join()).rejects.toMatchObject({ code: 'COMMUNITY_CHOICE_REQUIRED' });
    expect((await service.communityChoice(customerId)).joined).toBe(false);
    await service.join(customerId, businessId, branchId, true);
    await service.join(customerId, businessId, otherBranchId, false);
    expect((await service.communityChoice(customerId)).joined).toBe(true);
    await service.setCommunityChoice(customerId, false);
    expect(await service.list(customerId)).toHaveLength(2);
  });
  it('disabling a program preserves balances and permits fulfillment of an already reserved reward', async () => {
    const { membership } = await purchase(8);
    const reward = (await service.redeem(customerId, membership.id, crypto.randomUUID()))!;
    await service.configure(businessId, branchId, { ...program, enabled: false }, actor);
    expect((await service.list(customerId))[0]?.units).toBe(4);
    await expect(
      service.redeem(customerId, membership.id, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: 'PROGRAM_UNAVAILABLE' });
    expect(
      (await service.confirm(businessId, branchId, reward.code!, actor))!.confirmedAt,
    ).toBeInstanceOf(Date);
  });
  it('legacy business balances are untouched and new branch membership starts at zero', async () => {
    const repos = createRepositories(db);
    const account = await repos.loyaltyAccounts.create({ customerId, businessId, points: 27 });
    await join();
    expect((await repos.loyaltyAccounts.findById(account.id, businessId))?.points).toBe(27);
    expect((await service.list(customerId))[0]?.units).toBe(0);
  });
  it('earned program terms cannot be overwritten while operational flags remain configurable', async () => {
    await purchase();
    await expect(
      service.configure(businessId, branchId, { ...program, rewardCost: 12 }, actor),
    ).rejects.toMatchObject({ code: 'PROGRAM_TERMS_LOCKED' });
    expect((await service.program(businessId, branchId))?.rewardCost).toBe(4);
    await service.configure(businessId, branchId, { ...program, listedInCommunity: false }, actor);
    expect((await service.directory()).some((b) => b.branchId === branchId)).toBe(false);
  });
  it('subscription cancellation retains balances but blocks new branch earning', async () => {
    const { input } = await purchase();
    const repos = createRepositories(db);
    const plan = await repos.subscriptionPlans.create({
      key: crypto.randomUUID(),
      name: 'Test',
      priceMonthlyCents: 100,
    });
    await repos.businessSubscriptions.create({ businessId, planId: plan.id, status: 'canceled' });
    await expect(
      service.purchase(
        businessId,
        branchId,
        { ...input, receiptReference: crypto.randomUUID() },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'PROGRAM_UNAVAILABLE' });
    expect((await service.list(customerId))[0]?.units).toBe(4);
  });
  it('verified feedback is bound to the purchaser and branch, accepts a negative rating and rejects a refunded purchase', async () => {
    await service.configure(businessId, branchId, { ...program, feedbackBonusUnits: 2 }, actor);
    const { entry } = await purchase();
    const repos = createRepositories(db);
    const qr = await repos.qrCodes.create({ businessId, branchId });
    const input = { submissionKey: crypto.randomUUID(), rating: 1, comment: 'Poor service today' };
    await expect(
      service.verifiedFeedback(crypto.randomUUID(), qr, entry.id, input),
    ).rejects.toMatchObject({ code: 'PURCHASE_REQUIRED' });
    await expect(
      service.verifiedFeedback(
        customerId,
        { ...qr, branchId: otherBranchId } as QrCode,
        entry.id,
        input,
      ),
    ).rejects.toMatchObject({ code: 'PURCHASE_REQUIRED' });
    const feedback = await service.verifiedFeedback(customerId, qr, entry.id, input);
    expect(feedback).toMatchObject({ rating: 1, branchId, verifiedPurchaseId: entry.id });
    expect((await service.verifiedFeedback(customerId, qr, entry.id, input)).id).toBe(feedback.id);
    expect((await service.list(customerId))[0]?.units).toBe(6);
    await expect(
      service.verifiedFeedback(customerId, qr, entry.id, { ...input, rating: 5 }),
    ).rejects.toMatchObject({ code: 'PURCHASE_FEEDBACK_EXISTS' });
    await service.refund(businessId, branchId, entry.id, 'Refund', actor);
    expect((await service.list(customerId))[0]?.units).toBe(0);
    await expect(service.verifiedFeedback(customerId, qr, entry.id, input)).rejects.toMatchObject({
      code: 'PURCHASE_REFUNDED',
    });
  });
});
