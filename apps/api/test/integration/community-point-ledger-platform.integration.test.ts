import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { CommunityMembershipService } from '../../src/community/community-membership.service';

describe.skipIf(!process.env.DATABASE_URL)(
  'Split 05 platform Community Point ledger inspection (integration)',
  () => {
    let client: Client;
    let db: ReturnType<typeof buildDb>;
    let customerAId: string;
    let customerBId: string;
    let accountAId: string;

    beforeAll(async () => {
      client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      db = buildDb(client);
      const repos = createRepositories(db);

      const customerA = await repos.customers.create({
        phone: `+1570${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });
      const customerB = await repos.customers.create({
        phone: `+1571${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
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
      accountAId = joinedA.account.id;

      for (const [index, points] of [10, 30].entries()) {
        const created = await repos.communityPointTransactions.createIdempotent({
          accountId: joinedA.account.id,
          customerId: customerAId,
          type: 'admin_adjustment',
          points,
          sourceType: 'admin_adjustment',
          sourceRef: `platform-ledger-a-${index}`,
          idempotencyKey: crypto.randomUUID(),
        });
        expect(created.inserted).toBe(true);
        await repos.communityPointAccounts.incrementBalance(joinedA.account.id, points);
      }

      const createdB = await repos.communityPointTransactions.createIdempotent({
        accountId: joinedB.account.id,
        customerId: customerBId,
        type: 'admin_adjustment',
        points: 90,
        sourceType: 'admin_adjustment',
        sourceRef: 'platform-ledger-b',
        idempotencyKey: crypto.randomUUID(),
      });
      expect(createdB.inserted).toBe(true);
      await repos.communityPointAccounts.incrementBalance(joinedB.account.id, 90);
    });

    afterAll(async () => {
      await client.end();
    });

    it('filters the global ledger by customer/account without leaking other customers', async () => {
      const repos = createRepositories(db);
      const byCustomer = await repos.communityPointTransactions.listPlatform(
        { customerId: customerAId },
        { limit: 100, offset: 0 },
      );
      expect(byCustomer).toHaveLength(2);
      expect(byCustomer.every((row) => row.customerId === customerAId)).toBe(true);
      expect(byCustomer.some((row) => row.customerId === customerBId)).toBe(false);

      const byAccount = await repos.communityPointTransactions.listPlatform(
        { accountId: accountAId },
        { limit: 100, offset: 0 },
      );
      expect(byAccount).toHaveLength(2);
      expect(byAccount.every((row) => row.accountId === accountAId)).toBe(true);
    });

    it('supports type/source filters and bounded pagination', async () => {
      const repos = createRepositories(db);
      const rows = await repos.communityPointTransactions.listPlatform(
        {
          customerId: customerAId,
          type: 'admin_adjustment',
          sourceType: 'admin_adjustment',
        },
        { limit: 1, offset: 0 },
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.type).toBe('admin_adjustment');
      expect(rows[0]!.sourceType).toBe('admin_adjustment');

      const next = await repos.communityPointTransactions.listPlatform(
        { customerId: customerAId },
        { limit: 1, offset: 1 },
      );
      expect(next).toHaveLength(1);
      expect(next[0]!.id).not.toBe(rows[0]!.id);
    });

    it('keeps the account projection equal to the inspected ledger sum', async () => {
      const repos = createRepositories(db);
      const account = await repos.communityPointAccounts.findByCustomerId(customerAId);
      const rows = await repos.communityPointTransactions.listPlatform(
        { customerId: customerAId },
        { limit: 100, offset: 0 },
      );
      expect(account?.pointsBalance).toBe(
        rows.reduce((sum, row) => sum + row.points, 0),
      );
    });
  },
);
