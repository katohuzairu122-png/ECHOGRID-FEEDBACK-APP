import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { LoyaltyActionResolver } from '../../src/loyalty/loyalty-action-resolver';
import { signCustomerQrToken } from '../../src/qr/customer-qr-token';
import { signQrToken } from '../../src/qr/qr-token';

describe.skipIf(!process.env.DATABASE_URL)('Unified QR action scope (real Postgres)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let resolver: LoyaltyActionResolver;
  let businessId: string;
  let otherBusinessId: string;
  let customerId: string;
  let accountId: string;
  let actorId: string;
  let qrId: string;
  let businessToken: string;
  const secret = 'isolated-qr-integration-fixture-secret';

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    repos = createRepositories(buildDb(client));
    resolver = new LoyaltyActionResolver(repos, {
      QR_TOKEN_SECRET: secret,
      QR_TOKEN_SECRET_PREVIOUS: undefined,
    });
    const suffix = crypto.randomUUID();
    businessId = (
      await repos.businesses.create({ name: 'QR action business', slug: `qr-action-${suffix}` })
    ).id;
    otherBusinessId = (
      await repos.businesses.create({ name: 'Other QR business', slug: `qr-other-${suffix}` })
    ).id;
    actorId = (
      await repos.users.create({
        email: `qr-${suffix}@example.test`,
        passwordHash: 'fixture-only',
        fullName: 'QR Fixture Staff',
        status: 'active',
      })
    ).id;
    const branch = await repos.branches.create({
      businessId,
      name: 'QR Branch',
      slug: `qr-branch-${suffix}`,
    });
    customerId = (
      await repos.customers.create({
        phone: `+1587${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      })
    ).id;
    const qr = await repos.qrCodes.create({
      businessId,
      branchId: branch.id,
      type: 'business',
      createdBy: actorId,
    });
    qrId = qr.id;
    const membership = await repos.customerMemberships.create({
      customerId,
      businessId,
      status: 'active',
      onboardingSource: 'qr-integration',
      onboardingReference: qr.id,
    });
    accountId = (
      await repos.loyaltyAccounts.create({
        customerId,
        businessId,
        membershipId: membership.id,
        points: 10,
      })
    ).id;
    businessToken = await signQrToken({ qrCodeId: qr.id, businessId, branchId: branch.id }, secret);
  });
  afterAll(async () => {
    await client.end();
  });

  it('resolves a global identity into only the selected business relationship and permissions', async () => {
    const token = await signCustomerQrToken(customerId, secret);
    const own = await resolver.resolveCustomerForStaff({
      customerQrToken: token,
      businessId,
      permissions: new Set(['loyalty:view', 'loyalty:manage']),
    });
    expect(own.loyaltyAccountId).toBe(accountId);
    expect(own.actions).toContain('REDEEM_REWARD');
    const other = await resolver.resolveCustomerForStaff({
      customerQrToken: token,
      businessId: otherBusinessId,
      permissions: new Set(['loyalty:view', 'loyalty:manage']),
    });
    expect(other.loyaltyAccountId).toBeNull();
    expect(other.actions).toEqual([]);
    const viewOnly = await resolver.resolveCustomerForStaff({
      customerQrToken: token,
      businessId,
      permissions: new Set(['loyalty:view']),
    });
    expect(viewOnly.actions).toEqual(['VIEW_ALLOWED_MEMBERSHIP_STATE']);
  });

  it('resolving a scanned business QR selects eligible actions without granting points or creating economic history', async () => {
    const before = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId);
    const history = await repos.loyaltyTransactions.listForAccount(accountId);
    const result = await resolver.resolveBusinessForCustomer({
      customerId,
      businessQrToken: businessToken,
    });
    expect(result.actions).toEqual([
      'OPEN_LOYALTY_CARD',
      'VIEW_REWARDS',
      'CHECK_IN',
      'LEAVE_FEEDBACK',
    ]);
    expect(await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId)).toEqual(
      before,
    );
    expect(await repos.loyaltyTransactions.listForAccount(accountId)).toEqual(history);
  });

  it('fails closed after the existing printed business QR is revoked', async () => {
    await repos.qrCodes.revoke(qrId, businessId, actorId);
    await expect(
      resolver.resolveBusinessForCustomer({ customerId, businessQrToken: businessToken }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
