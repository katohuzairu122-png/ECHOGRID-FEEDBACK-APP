import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { CommunityMembershipService } from '../../src/community/community-membership.service';
import { CommunityPointAdminAdjustmentService } from '../../src/community/community-point-admin-adjustment.service';

describe.skipIf(!process.env.DATABASE_URL)(
  'Split 05 platform Community Point adjustments (integration)',
  () => {
    let client: Client;
    let db: ReturnType<typeof buildDb>;
    let actorUserId: string;
    let customerId: string;
    let accountId: string;

    beforeAll(async () => {
      client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      db = buildDb(client);
      const repos = createRepositories(db);

      const actor = await repos.users.create({
        email: `community-adjust-${crypto.randomUUID()}@example.test`,
        passwordHash: 'not-used-in-integration',
        fullName: 'Community Adjustment Admin',
        status: 'active',
        emailVerifiedAt: new Date(),
        platformRole: 'admin',
      });
      actorUserId = actor.id;

      const customer = await repos.customers.create({
        phone: `+1580${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });
      customerId = customer.id;

      const joined = await new CommunityMembershipService(db).join(
        customerId,
        'community-policy-v1',
      );
      accountId = joined.account.id;
    });

    afterAll(async () => {
      await client.end();
    });

    const audit = () => ({
      actorUserId,
      ipAddress: '203.0.113.20',
      userAgent: 'split-05-adjustment-integration',
    });

    it('applies a signed adjustment atomically, audits it, and replays exactly once', async () => {
      const service = new CommunityPointAdminAdjustmentService(db);
      const idempotencyKey = `community-adjust-${crypto.randomUUID()}`;

      const first = await service.adjust(
        customerId,
        {
          points: 40,
          reason: 'Correct verified platform support discrepancy.',
          idempotencyKey,
        },
        audit(),
      );
      expect(first.changed).toBe(true);
      expect(first.transaction.type).toBe('admin_adjustment');
      expect(first.transaction.sourceType).toBe('admin_adjustment');
      expect(first.transaction.points).toBe(40);
      expect(first.transaction.createdBy).toBe(actorUserId);
      expect(first.account.pointsBalance).toBe(40);

      const replay = await service.adjust(
        customerId,
        {
          points: 40,
          reason: 'Correct verified platform support discrepancy.',
          idempotencyKey,
        },
        audit(),
      );
      expect(replay.changed).toBe(false);
      expect(replay.transaction.id).toBe(first.transaction.id);
      expect(replay.account.pointsBalance).toBe(40);

      const auditRows = await createRepositories(db).auditLog.listForEntity(
        'community_point_transaction',
        first.transaction.id,
      );
      expect(
        auditRows.filter((row) => row.action === 'community_point.admin_adjusted'),
      ).toHaveLength(1);
    });

    it('rejects materially different reuse of an adjustment idempotency key', async () => {
      const service = new CommunityPointAdminAdjustmentService(db);
      const idempotencyKey = `community-adjust-conflict-${crypto.randomUUID()}`;

      await service.adjust(
        customerId,
        {
          points: 5,
          reason: 'First correction value.',
          idempotencyKey,
        },
        audit(),
      );

      await expect(
        service.adjust(
          customerId,
          {
            points: 6,
            reason: 'First correction value.',
            idempotencyKey,
          },
          audit(),
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'IDEMPOTENCY_CONFLICT',
      });
    });

    it('uses one opposite-signed compensating admin adjustment for a platform adjustment', async () => {
      const service = new CommunityPointAdminAdjustmentService(db);
      const original = await service.adjust(
        customerId,
        {
          points: 20,
          reason: 'Temporary manual credit requiring correction.',
          idempotencyKey: `community-adjust-reverse-${crypto.randomUUID()}`,
        },
        audit(),
      );

      const first = await service.reverseAdjustment(
        original.transaction.id,
        {
          reason: 'Manual credit was entered in error.',
          idempotencyKey: `community-adjust-reversal-${crypto.randomUUID()}`,
        },
        audit(),
      );
      expect(first.changed).toBe(true);
      expect(first.transaction.type).toBe('admin_adjustment');
      expect(first.transaction.points).toBe(-20);
      expect(first.transaction.metadata).toMatchObject({
        correctionOf: original.transaction.id,
      });

      const replay = await service.reverseAdjustment(
        original.transaction.id,
        {
          reason: 'Repeated operator request must not duplicate correction.',
          idempotencyKey: `community-adjust-reversal-retry-${crypto.randomUUID()}`,
        },
        audit(),
      );
      expect(replay.changed).toBe(false);
      expect(replay.transaction.id).toBe(first.transaction.id);

      const auditRows = await createRepositories(db).auditLog.listForEntity(
        'community_point_transaction',
        first.transaction.id,
      );
      expect(
        auditRows.filter(
          (row) => row.action === 'community_point.admin_adjustment_reversed',
        ),
      ).toHaveLength(1);
    });

    it('can compensate a negative admin adjustment without misusing the negative-only reverse type', async () => {
      const service = new CommunityPointAdminAdjustmentService(db);
      const original = await service.adjust(
        customerId,
        {
          points: -15,
          reason: 'Temporary manual debit requiring correction.',
          idempotencyKey: `community-negative-adjust-${crypto.randomUUID()}`,
        },
        audit(),
      );

      const reversed = await service.reverseAdjustment(
        original.transaction.id,
        {
          reason: 'Manual debit was entered in error.',
          idempotencyKey: `community-negative-reversal-${crypto.randomUUID()}`,
        },
        audit(),
      );

      expect(reversed.transaction.type).toBe('admin_adjustment');
      expect(reversed.transaction.points).toBe(15);
      expect(reversed.transaction.metadata).toMatchObject({
        correctionOf: original.transaction.id,
      });
    });

    it('does not let platform manual reversal bypass evidence-owned earn reversal', async () => {
      const repos = createRepositories(db);
      const earn = await repos.communityPointTransactions.createIdempotent({
        accountId,
        customerId,
        type: 'earn',
        points: 7,
        sourceType: 'survey_completion',
        sourceRef: `manual-reversal-boundary-${crypto.randomUUID()}`,
        idempotencyKey: crypto.randomUUID(),
      });
      expect(earn.inserted).toBe(true);
      await repos.communityPointAccounts.incrementBalance(accountId, 7);

      await expect(
        new CommunityPointAdminAdjustmentService(db).reverseAdjustment(
          earn.transaction.id,
          {
            reason: 'This must remain evidence-owned.',
            idempotencyKey: `invalid-manual-reversal-${crypto.randomUUID()}`,
          },
          audit(),
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'COMMUNITY_ADMIN_REVERSAL_TARGET_INVALID',
      });

      expect(
        await repos.communityPointTransactions.findReversalOf(earn.transaction.id),
      ).toBeUndefined();
    });

    it('rolls back ledger and balance if the required semantic audit insert fails', async () => {
      const repos = createRepositories(db);
      const beforeAccount = await repos.communityPointAccounts.findById(accountId);
      const idempotencyKey = `community-audit-rollback-${crypto.randomUUID()}`;

      await expect(
        new CommunityPointAdminAdjustmentService(db).adjust(
          customerId,
          {
            points: 33,
            reason: 'This mutation must roll back with its audit failure.',
            idempotencyKey,
          },
          {
            actorUserId: crypto.randomUUID(),
            ipAddress: null,
            userAgent: null,
          },
        ),
      ).rejects.toBeDefined();

      expect(
        await repos.communityPointTransactions.findByIdempotencyKey(idempotencyKey),
      ).toBeUndefined();
      const afterAccount = await repos.communityPointAccounts.findById(accountId);
      expect(afterAccount?.pointsBalance).toBe(beforeAccount?.pointsBalance);
    });

    it('keeps the projected balance equal to the append-only ledger sum', async () => {
      const repos = createRepositories(db);
      const account = await repos.communityPointAccounts.findById(accountId);
      const history = await repos.communityPointTransactions.listForAccount(
        accountId,
        { limit: 200, offset: 0 },
      );
      expect(account?.pointsBalance).toBe(
        history.reduce((sum, row) => sum + row.points, 0),
      );
    });
  },
);
