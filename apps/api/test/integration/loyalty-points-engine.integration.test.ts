import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { LoyaltyAccountService } from '../../src/loyalty/loyalty-account.service';

/**
 * LoyaltyAccountService takes the raw Database (not injected repos) because
 * every earning method needs a real transaction spanning the points update,
 * the tier recalculation, and the ledger insert -- the same reasoning
 * BusinessService's own transaction exception documents. That means fakes
 * (loyalty-tier.service.test.ts's style) can't exercise it meaningfully;
 * this integration suite is the ONLY place the points engine's actual
 * transactional behavior -- atomic delta application, tier recalculation
 * against the post-delta balance, the append-only ledger -- is verified.
 */
describe.skipIf(!process.env.DATABASE_URL)('LoyaltyAccountService points engine (integration)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let service: LoyaltyAccountService;
  let businessId: string;
  let branchId: string;
  let customerId: string;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const db = buildDb(client);
    repos = createRepositories(db);
    service = new LoyaltyAccountService(db);

    const business = await repos.businesses.create({
      name: 'Loyalty Points Engine Test Business',
      slug: `loyalty-points-engine-${crypto.randomUUID()}`,
    });
    businessId = business.id;

    const branch = await repos.branches.create({
      businessId,
      name: 'Main',
      slug: `loyalty-points-engine-branch-${crypto.randomUUID()}`,
    });
    branchId = branch.id;

    const customer = await repos.customers.create({ phone: `+1555${Date.now()}` });
    customerId = customer.id;

    // Silver at 50, Gold at 200 -- deliberately not evenly spaced from the
    // default settings' points-per-checkin, so the tier-recalculation test
    // below has to cross a real threshold via multiple check-ins.
    await repos.loyaltyTiers.create({ businessId, name: 'Silver', minPoints: 50, sortOrder: 1 });
    await repos.loyaltyTiers.create({ businessId, name: 'Gold', minPoints: 200, sortOrder: 2 });
  });

  afterAll(async () => {
    await repos.businesses.softDelete(businessId, businessId);
    await client.end();
  });

  it('recordCheckin auto-enrolls a customer with no existing account, awards the configured points, and records a visit', async () => {
    const qrCode = await repos.qrCodes.create({
      businessId,
      branchId,
      token: `checkin-test-${crypto.randomUUID()}`,
    });

    const account = await service.recordCheckin(customerId, businessId, qrCode.id);

    expect(account.customerId).toBe(customerId);
    expect(account.points).toBe(10); // loyalty_settings' default pointsPerCheckin
    expect(account.visitCount).toBe(1);
    expect(account.lastVisitAt).not.toBeNull();
  });

  it('recordCheckin on an already-enrolled customer increments the SAME account, not a duplicate', async () => {
    const qrCode = await repos.qrCodes.create({
      businessId,
      branchId,
      token: `checkin-test-2-${crypto.randomUUID()}`,
    });

    const before = await service.getAccount(
      (await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId))!.id,
      businessId,
    );
    const after = await service.recordCheckin(customerId, businessId, qrCode.id);

    expect(after.id).toBe(before.id);
    expect(after.points).toBe(before.points + 10);
    expect(after.visitCount).toBe(before.visitCount + 1);
  });

  it('recordPurchase computes points from the business\'s pointsPerCurrencyUnit setting and floors the result', async () => {
    const account = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId);
    const before = account!.points;

    // Default pointsPerCurrencyUnit is 1.00 -> $19.99 floors to 19 points.
    const updated = await service.recordPurchase(businessId, account!.id, 19.99, 'staff-actor');

    expect(updated.points).toBe(before + 19);
  });

  it('adjustPoints rejects an adjustment that would drop the balance below zero', async () => {
    const account = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId);
    await expect(
      service.adjustPoints(businessId, account!.id, -(account!.points + 1000), 'oops', 'staff-actor'),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_POINTS', status: 422 });

    // Confirms the rejected adjustment did NOT partially apply -- the whole
    // transaction rolled back, not just the ledger insert.
    const unchanged = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId);
    expect(unchanged!.points).toBe(account!.points);
  });

  it('tier is automatically recalculated once earned points cross a threshold', async () => {
    const account = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId);
    expect(account!.points).toBeLessThan(200);

    // Enough manual points to cross the Gold threshold (200).
    const updated = await service.adjustPoints(
      businessId,
      account!.id,
      200 - account!.points,
      'test bump to Gold',
      'staff-actor',
    );

    const goldTier = (await repos.loyaltyTiers.listForBusiness(businessId)).find((t) => t.name === 'Gold');
    expect(updated.tierId).toBe(goldTier!.id);
  });

  it('every earning/spending call writes an append-only ledger row -- points and account balance never drift apart', async () => {
    const account = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId);
    const transactions = await repos.loyaltyTransactions.listForAccount(account!.id);

    const ledgerTotal = transactions.reduce((sum, tx) => sum + tx.points, 0);
    expect(ledgerTotal).toBe(account!.points);
  });
});
