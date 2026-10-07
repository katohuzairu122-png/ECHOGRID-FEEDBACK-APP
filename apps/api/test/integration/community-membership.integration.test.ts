import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { CommunityMembershipService } from '../../src/community/community-membership.service';

describe.skipIf(!process.env.DATABASE_URL)('Split 05 Community membership service (integration)', () => {
  let client: Client;
  let db: ReturnType<typeof buildDb>;
  let customerId: string;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    db = buildDb(client);

    const customer = await createRepositories(db).customers.create({
      phone: `+1557${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
      phoneVerifiedAt: new Date(),
    });
    customerId = customer.id;
  });

  afterAll(async () => {
    await client.end();
  });

  it('creates membership and account only after explicit join, then preserves identity across leave/rejoin', async () => {
    const service = new CommunityMembershipService(db);

    const before = await service.getStatus(customerId);
    expect(before).toEqual({ membership: null, account: null });

    const joined = await service.join(customerId, 'community-policy-v1');
    expect(joined.created).toBe(true);
    expect(joined.reactivated).toBe(false);
    expect(joined.membership.status).toBe('active');
    expect(joined.membership.policyVersion).toBe('community-policy-v1');
    expect(joined.account.status).toBe('active');
    expect(joined.account.pointsBalance).toBe(0);

    const replay = await service.join(customerId, 'community-policy-v1');
    expect(replay.created).toBe(false);
    expect(replay.reactivated).toBe(false);
    expect(replay.membership.id).toBe(joined.membership.id);
    expect(replay.account.id).toBe(joined.account.id);

    const left = await service.leave(customerId);
    expect(left.membership?.status).toBe('left');
    expect(left.membership?.leftAt).not.toBeNull();
    expect(left.account?.status).toBe('closed');

    const rejoined = await service.join(customerId, 'community-policy-v2');
    expect(rejoined.created).toBe(false);
    expect(rejoined.reactivated).toBe(true);
    expect(rejoined.membership.id).toBe(joined.membership.id);
    expect(rejoined.membership.policyVersion).toBe('community-policy-v2');
    expect(rejoined.membership.status).toBe('active');
    expect(rejoined.membership.leftAt).toBeNull();
    expect(rejoined.account.id).toBe(joined.account.id);
    expect(rejoined.account.status).toBe('active');
  });

  it('does not allow customer self-service to override platform suspension', async () => {
    const repos = createRepositories(db);
    const membership = await repos.communityMemberships.updateStatus(customerId, {
      status: 'suspended',
      suspendedAt: new Date(),
    });
    expect(membership?.status).toBe('suspended');

    const service = new CommunityMembershipService(db);
    await expect(service.join(customerId, 'community-policy-v3')).rejects.toMatchObject({
      status: 409,
      code: 'COMMUNITY_MEMBERSHIP_SUSPENDED',
    });
    await expect(service.leave(customerId)).rejects.toMatchObject({
      status: 409,
      code: 'COMMUNITY_MEMBERSHIP_SUSPENDED',
    });

    const account = await repos.communityPointAccounts.findByCustomerId(customerId);
    expect(account?.id).toBeDefined();
  });
});
