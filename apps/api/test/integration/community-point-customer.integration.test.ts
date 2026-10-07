import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { CommunityMembershipService } from '../../src/community/community-membership.service';
import { CommunityPointCustomerService } from '../../src/community/community-point-customer.service';

describe.skipIf(!process.env.DATABASE_URL)(
  'Split 05 Community Point customer reads (integration)',
  () => {
    let client: Client;
    let db: ReturnType<typeof buildDb>;
    let customerAId: string;
    let customerBId: string;

    beforeAll(async () => {
      client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      db = buildDb(client);
      const repos = createRepositories(db);

      const customerA = await repos.customers.create({
        phone: `+1560${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });
      const customerB = await repos.customers.create({
        phone: `+1561${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });
      customerAId = customerA.id;
      customerBId = customerB.id;

      const joinedA = await new CommunityMembershipService(db).join(
        customerAId,
        'community-policy-v1',
      );
      const joinedB = await new CommunityMembershipService(db).join(
        customerBId,
        'community-policy-v1',
      );

      const txA = await repos.communityPointTransactions.createIdempotent({
        accountId: joinedA.account.id,
        customerId: customerAId,
        type: 'admin_adjustment',
        points: 40,
        sourceType: 'admin_adjustment',
        sourceRef: 'customer-read-a',
        idempotencyKey: crypto.randomUUID(),
      });
      expect(txA.inserted).toBe(true);
      await repos.communityPointAccounts.incrementBalance(joinedA.account.id, 40);

      const txB = await repos.communityPointTransactions.createIdempotent({
        accountId: joinedB.account.id,
        customerId: customerBId,
        type: 'admin_adjustment',
        points: 90,
        sourceType: 'admin_adjustment',
        sourceRef: 'customer-read-b',
        idempotencyKey: crypto.randomUUID(),
      });
      expect(txB.inserted).toBe(true);
      await repos.communityPointAccounts.incrementBalance(joinedB.account.id, 90);
    });

    afterAll(async () => {
      await client.end();
    });

    it('returns only the requested global customer account and ledger history', async () => {
      const service = new CommunityPointCustomerService(db);

      const summaryA = await service.getSummary(customerAId);
      const summaryB = await service.getSummary(customerBId);
      expect(summaryA.account?.customerId).toBe(customerAId);
      expect(summaryA.account?.pointsBalance).toBe(40);
      expect(summaryB.account?.customerId).toBe(customerBId);
      expect(summaryB.account?.pointsBalance).toBe(90);

      const historyA = await service.listTransactions(customerAId, {
        limit: 100,
        offset: 0,
      });
      const historyB = await service.listTransactions(customerBId, {
        limit: 100,
        offset: 0,
      });

      expect(historyA).toHaveLength(1);
      expect(historyA[0]!.customerId).toBe(customerAId);
      expect(historyA[0]!.points).toBe(40);
      expect(historyB).toHaveLength(1);
      expect(historyB[0]!.customerId).toBe(customerBId);
      expect(historyB[0]!.points).toBe(90);
      expect(historyA[0]!.id).not.toBe(historyB[0]!.id);
    });

    it('keeps a closed account and its history readable after Community leave', async () => {
      await new CommunityMembershipService(db).leave(customerAId);

      const service = new CommunityPointCustomerService(db);
      const summary = await service.getSummary(customerAId);
      const history = await service.listTransactions(customerAId, {
        limit: 100,
        offset: 0,
      });

      expect(summary.account?.status).toBe('closed');
      expect(summary.account?.pointsBalance).toBe(40);
      expect(history).toHaveLength(1);
      expect(history[0]!.points).toBe(40);
    });

    it('does not create an account for a customer who only reads Community Points', async () => {
      const customer = await createRepositories(db).customers.create({
        phone: `+1562${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });

      const service = new CommunityPointCustomerService(db);
      expect(await service.getSummary(customer.id)).toEqual({ account: null });
      expect(
        await service.listTransactions(customer.id, { limit: 100, offset: 0 }),
      ).toEqual([]);

      expect(
        await createRepositories(db).communityPointAccounts.findByCustomerId(customer.id),
      ).toBeUndefined();
    });
  },
);
