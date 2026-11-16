import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { sign } from 'hono/jwt';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { LoyaltyActionResolver } from '../../src/loyalty/loyalty-action-resolver';
import { signCustomerQrToken } from '../../src/qr/customer-qr-token';

/**
 * CUSTOMER-QR-ROTATION-01: the customer QR is a renewable identity credential (24h). It is NOT consumed by
 * transactions, is rejected after expiry / revocation / tampering / suspension, and never authorizes anything by
 * itself (actions still depend on the staff member's permissions and the business membership).
 */
describe.skipIf(!process.env.DATABASE_URL)('Customer QR rotation and revocation (real Postgres)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let resolver: LoyaltyActionResolver;
  let businessId: string;
  let customerId: string;
  let accountId: string;
  const secret = 'customer-qr-rotation-fixture-secret';
  const staff = new Set(['loyalty:serve']);

  const resolve = (token: string, permissions: Set<string> = staff) =>
    resolver.resolveCustomerForStaff({ customerQrToken: token, businessId, permissions });
  const issue = async () =>
    signCustomerQrToken(customerId, secret, (await repos.customers.findById(customerId))!.qrRevocationEpoch);

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    repos = createRepositories(buildDb(client));
    resolver = new LoyaltyActionResolver(repos, { QR_TOKEN_SECRET: secret, QR_TOKEN_SECRET_PREVIOUS: undefined });
    const suffix = crypto.randomUUID();
    businessId = (await repos.businesses.create({ name: 'QR rotation business', slug: `qr-rot-${suffix}` })).id;
    const branch = await repos.branches.create({ businessId, name: 'Rot Branch', slug: `qr-rot-b-${suffix}` });
    const actor = await repos.users.create({
      email: `qr-rot-${suffix}@example.test`, passwordHash: 'fixture-only', fullName: 'Rot Staff', status: 'active',
    });
    customerId = (
      await repos.customers.create({
        phone: `+1588${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      })
    ).id;
    const qr = await repos.qrCodes.create({ businessId, branchId: branch.id, type: 'business', createdBy: actor.id });
    const membership = await repos.customerMemberships.create({
      customerId, businessId, status: 'active', onboardingSource: 'qr-rotation', onboardingReference: qr.id,
    });
    accountId = (
      await repos.loyaltyAccounts.create({ customerId, businessId, membershipId: membership.id, points: 10 })
    ).id;
  });
  afterAll(async () => {
    await client.end();
  });

  it('a new customer starts at revocation epoch 0', async () => {
    expect((await repos.customers.findById(customerId))!.qrRevocationEpoch).toBe(0);
  });

  it('allows many scans with the same QR, sequentially and concurrently', async () => {
    const token = await issue();
    for (let i = 0; i < 5; i += 1) expect((await resolve(token)).customerId).toBe(customerId);
    const parallel = await Promise.all(Array.from({ length: 8 }, () => resolve(token)));
    expect(parallel.every((r) => r.customerId === customerId)).toBe(true);
  });

  it('is not invalidated by a successful transaction on the account', async () => {
    const token = await issue();
    expect((await resolve(token)).loyaltyAccountId).toBe(accountId);
    await repos.loyaltyAccounts.applyPointsDelta(accountId, 5);
    const after = await resolve(token);
    expect(after.customerId).toBe(customerId);
    expect(after.actions).toContain('GRANT_LOYALTY_PROGRESS');
    expect((await repos.customers.findById(customerId))!.qrRevocationEpoch).toBe(0);
  });

  it('rejects an expired token, a tampered token and a token from another secret', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await sign(
      { sub: customerId, type: 'qr_customer', sigVer: 1, nonce: 'n', rev: 0, iat: now - 100_000, exp: now - 1 },
      secret, 'HS256',
    );
    await expect(resolve(expired)).rejects.toMatchObject({ code: 'CUSTOMER_QR_NOT_FOUND' });
    const good = await issue();
    const [h, p, s] = good.split('.');
    const forged = `${h}.${p}.${s!.slice(0, -2)}${s!.endsWith('AA') ? 'BB' : 'AA'}`;
    await expect(resolve(forged)).rejects.toMatchObject({ code: 'CUSTOMER_QR_NOT_FOUND' });
    const otherSecret = await signCustomerQrToken(customerId, 'some-other-secret');
    await expect(resolve(otherSecret)).rejects.toMatchObject({ code: 'CUSTOMER_QR_NOT_FOUND' });
  });

  it('a QR names a customer only: without staff permission it authorizes no action', async () => {
    const token = await issue();
    const noPermission = await resolve(token, new Set());
    expect(noPermission.actions).toEqual([]);
  });

  it('revocation atomically invalidates earlier tokens and the fresh token works at once', async () => {
    const before = await issue();
    expect((await resolve(before)).customerId).toBe(customerId);
    const epoch = await repos.customers.bumpQrRevocationEpoch(customerId);
    expect(epoch).toBe(1);
    await expect(resolve(before)).rejects.toMatchObject({ code: 'CUSTOMER_QR_NOT_FOUND' });
    const fresh = await signCustomerQrToken(customerId, secret, epoch!);
    expect((await resolve(fresh)).customerId).toBe(customerId);
  });

  it('concurrent revocations never lose an increment', async () => {
    const start = (await repos.customers.findById(customerId))!.qrRevocationEpoch;
    const other = new Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      const otherRepos = createRepositories(buildDb(other));
      await Promise.all([
        repos.customers.bumpQrRevocationEpoch(customerId),
        otherRepos.customers.bumpQrRevocationEpoch(customerId),
      ]);
    } finally {
      await other.end();
    }
    expect((await repos.customers.findById(customerId))!.qrRevocationEpoch).toBe(start + 2);
  });

  it('a legacy token without an epoch is valid only while the epoch is still 0', async () => {
    const legacyCustomer = await repos.customers.create({
      phone: `+1589${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
      phoneVerifiedAt: new Date(),
    });
    const now = Math.floor(Date.now() / 1000);
    const legacy = await sign(
      { sub: legacyCustomer.id, type: 'qr_customer', sigVer: 1, nonce: 'n', iat: now, exp: now + 300 },
      secret, 'HS256',
    );
    const asLegacy = () => resolver.resolveCustomerForStaff({ customerQrToken: legacy, businessId, permissions: staff });
    await expect(asLegacy()).resolves.toMatchObject({ customerId: legacyCustomer.id });
    await repos.customers.bumpQrRevocationEpoch(legacyCustomer.id);
    await expect(asLegacy()).rejects.toMatchObject({ code: 'CUSTOMER_QR_NOT_FOUND' });
  });

  it('a suspended customer no longer resolves even with an otherwise valid token', async () => {
    const suspended = await repos.customers.create({
      phone: `+1580${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
      phoneVerifiedAt: new Date(),
      status: 'suspended',
    });
    const token = await signCustomerQrToken(suspended.id, secret);
    await expect(
      resolver.resolveCustomerForStaff({ customerQrToken: token, businessId, permissions: staff }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_QR_NOT_FOUND' });
  });
});
