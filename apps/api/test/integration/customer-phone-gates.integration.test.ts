import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { CustomerMembershipService } from '../../src/customer-relationships/customer-membership.service';
import { FixtureCommunityMembershipService as CommunityMembershipService } from '../helpers/community-consent-fixtures';
import { appDbOf } from '../helpers/runtime-db';

/**
 * CUSTOMER-PHONE-01: a phone number given at registration is a claim, not proof. Verification is required ONLY for
 * joining an additional business and for Community participation; the first business and existing memberships are
 * never gated, so existing customers are not locked out.
 */
describe.skipIf(!process.env.DATABASE_URL)('Verified-phone gates (real Postgres)', () => {
  let client: Client;
  let db: ReturnType<typeof buildDb>;
  let repos: ReturnType<typeof createRepositories>;
  let membership: CustomerMembershipService;
  let businessA: string;
  let businessB: string;
  const phone = () => `+1559${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  const join = (customerId: string, businessId: string) =>
    membership.join({ customerId, businessId, onboardingSource: 'business_qr', onboardingReference: 'gate-test', consentVersion: 'v1' });

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    db = buildDb(client);
    repos = createRepositories(db);
    membership = new CustomerMembershipService(appDbOf(db));
    const suffix = crypto.randomUUID();
    businessA = (await repos.businesses.create({ name: 'Gate A', slug: `gate-a-${suffix}` })).id;
    businessB = (await repos.businesses.create({ name: 'Gate B', slug: `gate-b-${suffix}` })).id;
  });
  afterAll(async () => {
    await client.end();
  });

  const unverified = async () => (await repos.customers.create({ phone: phone() })).id;
  const verified = async () => (await repos.customers.create({ phone: phone(), phoneVerifiedAt: new Date() })).id;
  const emailOnly = async () => (await repos.customers.create({})).id;

  it('an unverified customer can join and earn at their FIRST business', async () => {
    const id = await unverified();
    const joined = await join(id, businessA);
    expect(joined.membership.status).toBe('active');
    await repos.loyaltyAccounts.applyPointsDelta(joined.loyaltyAccount.id, 5);
    expect((await repos.loyaltyAccounts.findByCustomerAndBusiness(id, businessA))!.points).toBe(5);
  });

  it('an email-only customer (no phone at all) can join their first business', async () => {
    await expect(join(await emailOnly(), businessA)).resolves.toBeTruthy();
  });

  it('joining an ADDITIONAL business needs a verified phone, and nothing is created when refused', async () => {
    const id = await unverified();
    await join(id, businessA);
    await expect(join(id, businessB)).rejects.toMatchObject({ status: 403, code: 'PHONE_VERIFICATION_REQUIRED' });
    expect(await repos.customerMemberships.findByCustomerAndBusiness(id, businessB)).toBeUndefined();
    expect(await repos.loyaltyAccounts.findByCustomerAndBusiness(id, businessB)).toBeUndefined();
  });

  it('an email-only customer is also refused a second business', async () => {
    const id = await emailOnly();
    await join(id, businessA);
    await expect(join(id, businessB)).rejects.toMatchObject({ code: 'PHONE_VERIFICATION_REQUIRED' });
  });

  it('a verified customer can join several businesses', async () => {
    const id = await verified();
    await join(id, businessA);
    await expect(join(id, businessB)).resolves.toBeTruthy();
  });

  it('leaving the first business does not bypass the gate for the next one', async () => {
    const id = await unverified();
    const first = await join(id, businessA);
    await db.execute(
      (await import('drizzle-orm')).sql`update business_customer_memberships set status = 'left' where id = ${first.membership.id}`,
    );
    await expect(join(id, businessB)).rejects.toMatchObject({ code: 'PHONE_VERIFICATION_REQUIRED' });
  });

  it('existing memberships are never locked: repeating the join of an active membership works unverified', async () => {
    const id = await unverified();
    await join(id, businessA);
    await expect(join(id, businessA)).resolves.toMatchObject({ membership: { status: 'active' } });
  });

  it('verifying the phone later unlocks the additional business (progressive completion)', async () => {
    const id = await unverified();
    await join(id, businessA);
    await expect(join(id, businessB)).rejects.toMatchObject({ code: 'PHONE_VERIFICATION_REQUIRED' });
    await db.execute(
      (await import('drizzle-orm')).sql`update customers set phone_verified_at = now() where id = ${id}`,
    );
    await expect(join(id, businessB)).resolves.toBeTruthy();
  });

  it('Community participation requires a verified phone', async () => {
    const community = new CommunityMembershipService(appDbOf(db));
    await expect(community.join(await unverified(), 'policy-v1')).rejects.toMatchObject({
      status: 403,
      code: 'PHONE_VERIFICATION_REQUIRED',
    });
    await expect(community.join(await emailOnly(), 'policy-v1')).rejects.toMatchObject({
      code: 'PHONE_VERIFICATION_REQUIRED',
    });
    await expect(community.join(await verified(), 'policy-v1')).resolves.toMatchObject({ created: true });
  });
});
