import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { CommunityMembershipService } from '../../src/community/community-membership.service';
import { CommunityPointAwardService } from '../../src/community/community-point-award.service';
import { CommunityPointAdminAdjustmentService } from '../../src/community/community-point-admin-adjustment.service';
import { CommunityPlatformStateService } from '../../src/community/community-platform-state.service';

describe.skipIf(!process.env.DATABASE_URL)(
  'Split 05 platform Community suspension/restoration (integration)',
  () => {
    let client: Client;
    let db: ReturnType<typeof buildDb>;
    let actorUserId: string;
    let customerId: string;
    let membershipId: string;
    let accountId: string;
    let completionRef: string;

    beforeAll(async () => {
      client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      db = buildDb(client);
      const repos = createRepositories(db);
      const suffix = crypto.randomUUID();

      const actor = await repos.users.create({
        email: `community-state-${suffix}@example.test`,
        passwordHash: 'not-used-in-integration',
        fullName: 'Community State Admin',
        status: 'active',
        emailVerifiedAt: new Date(),
        platformRole: 'admin',
      });
      actorUserId = actor.id;

      const customer = await repos.customers.create({
        phone: `+1590${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });
      customerId = customer.id;

      const joined = await new CommunityMembershipService(db).join(
        customerId,
        'community-policy-v1',
      );
      membershipId = joined.membership.id;
      accountId = joined.account.id;

      const adjusted = await new CommunityPointAdminAdjustmentService(db).adjust(
        customerId,
        {
          points: 50,
          reason: 'Seed balance to prove lifecycle preservation.',
          idempotencyKey: `community-state-seed-${suffix}`,
        },
        {
          actorUserId,
          ipAddress: '203.0.113.40',
          userAgent: 'split-05-state-integration',
        },
      );
      expect(adjusted.account.pointsBalance).toBe(50);

      const business = await repos.businesses.create({
        name: 'Community State Business',
        slug: `community-state-${suffix}`,
      });
      const survey = await repos.surveys.createSurvey({
        ownerType: 'business',
        businessId: business.id,
        name: 'Community State Survey',
        status: 'published',
      });
      const { version } = await repos.surveys.createVersionWithQuestions(
        {
          surveyId: survey.id,
          version: 1,
          status: 'published',
          title: 'Community State Survey v1',
          publishedAt: new Date(),
        },
        [],
      );
      const campaign = await repos.surveys.createCampaign({
        surveyId: survey.id,
        surveyVersionId: version.id,
        businessId: business.id,
        name: 'Community State Campaign',
        status: 'active',
        audienceClass: 'general_authenticated_participant',
        repeatPolicy: 'once_per_campaign',
      });
      const participation = await repos.surveyParticipations.createIdempotent({
        surveyId: survey.id,
        surveyVersionId: version.id,
        campaignId: campaign.id,
        participantCustomerId: customerId,
        businessId: business.id,
        status: 'started',
        idempotencyKey: crypto.randomUUID(),
        source: 'direct',
      });
      const completed = await repos.surveyParticipations.completeWithAnswers(
        participation.participation.id,
        [],
        crypto.randomUUID(),
      );
      completionRef = completed.id;

      const rule = await repos.communityPointRules.create({
        sourceType: 'survey_completion',
        resourceType: 'survey_campaign',
        resourceId: campaign.id,
        version: 303,
        status: 'draft',
        points: 25,
      });
      await repos.communityPointRules.updateLifecycle(rule.id, {
        status: 'active',
        activatedAt: new Date(),
      });
    });

    afterAll(async () => {
      await client.end();
    });

    const audit = () => ({
      actorUserId,
      ipAddress: '203.0.113.41',
      userAgent: 'split-05-state-integration',
    });

    it('suspends membership/account atomically while preserving balance and history', async () => {
      const service = new CommunityPlatformStateService(db);
      const result = await service.suspend(
        customerId,
        { reason: 'Platform policy investigation.' },
        audit(),
      );

      expect(result.changed).toBe(true);
      expect(result.membership.id).toBe(membershipId);
      expect(result.membership.status).toBe('suspended');
      expect(result.membership.suspendedAt).not.toBeNull();
      expect(result.account.id).toBe(accountId);
      expect(result.account.status).toBe('suspended');
      expect(result.account.pointsBalance).toBe(50);

      const history = await createRepositories(db).communityPointTransactions.listForAccount(
        accountId,
      );
      expect(history.some((row) => row.points === 50)).toBe(true);
      expect(history.reduce((sum, row) => sum + row.points, 0)).toBe(50);

      const replay = await service.suspend(
        customerId,
        { reason: 'Repeated suspend request.' },
        audit(),
      );
      expect(replay.changed).toBe(false);
      expect(replay.account.pointsBalance).toBe(50);

      const auditRows = await createRepositories(db).auditLog.listForEntity(
        'community_membership',
        membershipId,
      );
      expect(
        auditRows.filter(
          (row) => row.action === 'community_membership.suspended_by_platform',
        ),
      ).toHaveLength(1);
    });

    it('blocks earning while suspended without deleting completed evidence', async () => {
      const beforeHistory =
        await createRepositories(db).communityPointTransactions.listForAccount(
          accountId,
        );

      const result = await new CommunityPointAwardService(db).evaluateSurveyCompletion(
        completionRef,
      );

      expect(result.awarded).toBe(false);
      expect(result.pendingMembership).toBe(true);
      expect(result.transaction).toBeNull();

      const afterHistory =
        await createRepositories(db).communityPointTransactions.listForAccount(
          accountId,
        );
      expect(afterHistory).toHaveLength(beforeHistory.length);
    });

    it('prevents customer self-service from overriding platform suspension', async () => {
      const service = new CommunityMembershipService(db);
      await expect(
        service.join(customerId, 'community-policy-v2'),
      ).rejects.toMatchObject({
        status: 409,
        code: 'COMMUNITY_MEMBERSHIP_SUSPENDED',
      });
      await expect(service.leave(customerId)).rejects.toMatchObject({
        status: 409,
        code: 'COMMUNITY_MEMBERSHIP_SUSPENDED',
      });
    });

    it('restores the paired state and allows pending evidence to earn again', async () => {
      const state = new CommunityPlatformStateService(db);
      const restored = await state.restore(
        customerId,
        { reason: 'Platform investigation cleared.' },
        audit(),
      );

      expect(restored.changed).toBe(true);
      expect(restored.membership.status).toBe('active');
      expect(restored.membership.suspendedAt).toBeNull();
      expect(restored.account.status).toBe('active');
      expect(restored.account.pointsBalance).toBe(50);

      const awards =
        await new CommunityPointAwardService(db).reevaluatePendingMembership(
          customerId,
        );
      expect(awards).toHaveLength(1);
      expect(awards[0]!.awarded).toBe(true);
      expect(awards[0]!.transaction?.points).toBe(25);
      expect(awards[0]!.account?.pointsBalance).toBe(75);

      const replay = await state.restore(
        customerId,
        { reason: 'Repeated restore request.' },
        audit(),
      );
      expect(replay.changed).toBe(false);
      expect(replay.account.pointsBalance).toBe(75);

      const auditRows = await createRepositories(db).auditLog.listForEntity(
        'community_membership',
        membershipId,
      );
      expect(
        auditRows.filter(
          (row) => row.action === 'community_membership.restored_by_platform',
        ),
      ).toHaveLength(1);
    });

    it('rejects inconsistent membership/account lifecycle state instead of silently healing it', async () => {
      const repos = createRepositories(db);
      await repos.communityPointAccounts.updateStatus(accountId, 'suspended');

      await expect(
        new CommunityPlatformStateService(db).suspend(
          customerId,
          { reason: 'Must fail on state mismatch.' },
          audit(),
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'COMMUNITY_STATE_CONFLICT',
      });

      await repos.communityPointAccounts.updateStatus(accountId, 'active');
    });

    it('rolls back both state changes when required semantic audit insertion fails', async () => {
      const service = new CommunityPlatformStateService(db);

      await expect(
        service.suspend(
          customerId,
          { reason: 'This must roll back with audit failure.' },
          {
            actorUserId: crypto.randomUUID(),
            ipAddress: null,
            userAgent: null,
          },
        ),
      ).rejects.toBeDefined();

      const status = await new CommunityMembershipService(db).getStatus(customerId);
      expect(status.membership?.status).toBe('active');
      expect(status.account?.status).toBe('active');
      expect(status.account?.pointsBalance).toBe(75);
    });

    it('preserves ledger/account projection consistency across lifecycle changes', async () => {
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
