import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { LoyaltyAccountService } from '../../src/loyalty/loyalty-account.service';
import { VisitSessionService } from '../../src/visits/visit-session.service';

// createdBy/actor columns are `uuid` at the schema level -- a placeholder
// string like 'staff-actor' fails at the database, not just in spirit; these
// tests don't assert on the actor's identity, only that one is recorded.
const STAFF_ACTOR_ID = crypto.randomUUID();

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
    const qrCode = await repos.qrCodes.create({ businessId, branchId });

    const account = await service.recordCheckin(customerId, businessId, qrCode.id);

    expect(account.customerId).toBe(customerId);
    expect(account.points).toBe(10); // loyalty_settings' default pointsPerCheckin
    expect(account.visitCount).toBe(1);
    expect(account.lastVisitAt).not.toBeNull();
  });

  it('recordCheckin on an already-enrolled customer increments the SAME account, not a duplicate', async () => {
    // A distinct `type` from the previous test's QR code -- qr_codes has an
    // active-uniqueness constraint per (branch_id, type) (see
    // qr-code-active-uniqueness.integration.test.ts), so a second 'feedback'
    // QR for the same branch while the first is still active would violate it.
    // recordCheckin doesn't care about type; only that it's a valid active code.
    const qrCode = await repos.qrCodes.create({ businessId, branchId, type: 'loyalty' });

    const before = await service.getAccount(
      (await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId))!.id,
      businessId,
    );
    const after = await service.recordCheckin(customerId, businessId, qrCode.id);

    expect(after.id).toBe(before.id);
    expect(after.points).toBe(before.points + 10);
    expect(after.visitCount).toBe(before.visitCount + 1);
  });

  // Continuing Development Block 5.2 (S5.7 one reward per qualifying
  // visit). Requires the visit_sessions table to actually exist -- see the
  // handover note on that migration gap; these two cases will fail with a
  // "relation does not exist" error until `pnpm db:generate` (run from
  // apps/api) picks up visit_sessions for the first time, alongside this
  // block's loyalty_transactions.visit_session_id column.

  it('recordCheckin does not award a second reward for the same visit session and account (S5.7)', async () => {
    const qrCode = await repos.qrCodes.create({ businessId, branchId, type: 'checkin_dedup' });
    const session = await new VisitSessionService(repos).issue(businessId, branchId, STAFF_ACTOR_ID, {
      ttlSeconds: 60,
    });

    const before = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId);
    const first = await service.recordCheckin(customerId, businessId, qrCode.id, session.id);
    expect(first.points).toBe(before!.points + 10);

    // Same account, same visit session, called again -- simulates a
    // retried/replayed request. Must return the account unchanged, not
    // award a second 10 points.
    const second = await service.recordCheckin(customerId, businessId, qrCode.id, session.id);
    expect(second.points).toBe(first.points);
    expect(second.visitCount).toBe(first.visitCount);
  });

  it('recordCheckin lets a DIFFERENT customer earn their own reward off the same shared visit session (composite key)', async () => {
    const qrCode = await repos.qrCodes.create({ businessId, branchId, type: 'checkin_dedup_shared' });
    // maxUses: null -- a shared table-session code, meant for many
    // different customers, not the one-time-token flavor.
    const session = await new VisitSessionService(repos).issue(businessId, branchId, STAFF_ACTOR_ID, {
      ttlSeconds: 60,
    });
    const otherCustomer = await repos.customers.create({ phone: `+1555${Date.now()}` });

    const first = await service.recordCheckin(customerId, businessId, qrCode.id, session.id);
    const second = await service.recordCheckin(otherCustomer.id, businessId, qrCode.id, session.id);

    // The composite (visitSessionId, loyaltyAccountId) key must not block
    // a different account from claiming the same shared session -- this is
    // the exact regression a visitSessionId-only unique index would cause.
    expect(second.customerId).toBe(otherCustomer.id);
    expect(second.points).toBe(10);
    expect(second.id).not.toBe(first.id);
  });

  it('recordPurchase computes points from the business\'s pointsPerCurrencyUnit setting and floors the result', async () => {
    const account = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId);
    const before = account!.points;

    // Default pointsPerCurrencyUnit is 1.00 -> $19.99 floors to 19 points.
    const updated = await service.recordPurchase(businessId, account!.id, 19.99, STAFF_ACTOR_ID);

    expect(updated.points).toBe(before + 19);
  });

  it('adjustPoints rejects an adjustment that would drop the balance below zero', async () => {
    const account = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId);
    await expect(
      service.adjustPoints(businessId, account!.id, -(account!.points + 1000), 'oops', STAFF_ACTOR_ID),
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
      STAFF_ACTOR_ID,
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
