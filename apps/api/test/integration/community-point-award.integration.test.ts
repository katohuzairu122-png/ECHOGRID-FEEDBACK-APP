import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { CommunityMembershipService } from '../../src/community/community-membership.service';
import { CommunityPointAwardService } from '../../src/community/community-point-award.service';
import { CustomerMembershipService } from '../../src/customer-relationships/customer-membership.service';

describe.skipIf(!process.env.DATABASE_URL)(
  'Split 05 Community Point award evaluator (integration)',
  () => {
    let client: Client;
    let db: ReturnType<typeof buildDb>;
    let customerId: string;
    let businessId: string;
    let campaignId: string;
    let completionRef: string;
    let businessLoyaltyAccountId: string;
    let globalRuleId: string;

    beforeAll(async () => {
      client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      db = buildDb(client);
      const repos = createRepositories(db);
      const suffix = crypto.randomUUID();

      const customer = await repos.customers.create({
        phone: `+1558${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });
      customerId = customer.id;

      const business = await repos.businesses.create({
        name: 'Community Award Business',
        slug: `community-award-${suffix}`,
      });
      businessId = business.id;

      const businessMembership = await new CustomerMembershipService(db).join({
        customerId,
        businessId,
        onboardingSource: 'split05-isolation-test',
        onboardingReference: 'community-award-isolation',
        consentVersion: 'v1',
        idempotencyKey: crypto.randomUUID(),
      });
      businessLoyaltyAccountId = businessMembership.loyaltyAccount.id;
      expect(businessMembership.loyaltyAccount.points).toBe(0);

      const survey = await repos.surveys.createSurvey({
        ownerType: 'business',
        businessId,
        name: 'Community Award Survey',
        status: 'published',
      });
      const { version } = await repos.surveys.createVersionWithQuestions(
        {
          surveyId: survey.id,
          version: 1,
          status: 'published',
          title: 'Community Award Survey v1',
          publishedAt: new Date(),
        },
        [],
      );
      const campaign = await repos.surveys.createCampaign({
        surveyId: survey.id,
        surveyVersionId: version.id,
        businessId,
        name: 'Community Award Campaign',
        status: 'active',
        audienceClass: 'general_authenticated_participant',
        repeatPolicy: 'once_per_campaign',
      });
      campaignId = campaign.id;

      const participation = await repos.surveyParticipations.createIdempotent({
        surveyId: survey.id,
        surveyVersionId: version.id,
        campaignId: campaign.id,
        participantCustomerId: customerId,
        businessId,
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

      const globalRule = await repos.communityPointRules.create({
        sourceType: 'survey_completion',
        version: 101,
        status: 'draft',
        points: 25,
      });
      globalRuleId = globalRule.id;
      await repos.communityPointRules.updateLifecycle(globalRule.id, {
        status: 'active',
        activatedAt: new Date(),
      });

      const scopedRule = await repos.communityPointRules.create({
        sourceType: 'survey_completion',
        resourceType: 'survey_campaign',
        resourceId: campaign.id,
        version: 101,
        status: 'draft',
        points: 80,
      });
      await repos.communityPointRules.updateLifecycle(scopedRule.id, {
        status: 'active',
        activatedAt: new Date(),
      });
    });

    afterAll(async () => {
      await client.end();
    });

    it('holds valid evidence pending until explicit Community membership exists', async () => {
      const service = new CommunityPointAwardService(db);
      const result = await service.evaluateSurveyCompletion(completionRef);

      expect(result.awarded).toBe(false);
      expect(result.pendingMembership).toBe(true);
      expect(result.decision.status).toBe('pending_membership');
      expect(result.decision.points).toBe(80);
      expect(result.transaction).toBeNull();
      expect(result.account).toBeNull();

      const repos = createRepositories(db);
      expect(await repos.communityPointAccounts.findByCustomerId(customerId)).toBeUndefined();
      expect(await repos.communityPointTransactions.listForCustomer(customerId)).toHaveLength(0);
    });

    it('releases the pending decision after explicit join exactly once', async () => {
      const membership = await new CommunityMembershipService(db).join(
        customerId,
        'community-policy-v1',
      );
      expect(membership.account.pointsBalance).toBe(0);

      const service = new CommunityPointAwardService(db);
      const released = await service.reevaluatePendingMembership(customerId);
      expect(released).toHaveLength(1);
      expect(released[0]!.awarded).toBe(true);
      expect(released[0]!.pendingMembership).toBe(false);
      expect(released[0]!.decision.status).toBe('awarded');
      expect(released[0]!.transaction?.type).toBe('earn');
      expect(released[0]!.transaction?.points).toBe(80);
      expect(released[0]!.account?.pointsBalance).toBe(80);
      expect(released[0]!.transaction?.businessId).toBe(businessId);
      expect(released[0]!.transaction?.sourceRef).toBe(completionRef);

      const replay = await service.evaluateSurveyCompletion(completionRef);
      expect(replay.awarded).toBe(false);
      expect(replay.decision.id).toBe(released[0]!.decision.id);
      expect(replay.transaction?.id).toBe(released[0]!.transaction?.id);
      expect(replay.account?.pointsBalance).toBe(80);

      const secondRelease = await service.reevaluatePendingMembership(customerId);
      expect(secondRelease).toHaveLength(0);

      const repos = createRepositories(db);
      const account = await repos.communityPointAccounts.findByCustomerId(customerId);
      expect(account?.pointsBalance).toBe(80);
      const transactions = await repos.communityPointTransactions.listForCustomer(customerId);
      expect(transactions).toHaveLength(1);
      expect(transactions[0]!.id).toBe(released[0]!.transaction?.id);
    });

    it('does not mutate the same customer\'s business loyalty account or ledger', async () => {
      const repos = createRepositories(db);
      const loyaltyAccount = await repos.loyaltyAccounts.findById(
        businessLoyaltyAccountId,
        businessId,
      );
      expect(loyaltyAccount?.points).toBe(0);
      expect(
        await repos.loyaltyTransactions.listForAccount(
          businessLoyaltyAccountId,
          businessId,
        ),
      ).toHaveLength(0);
    });

    it('rejects nonexistent completion evidence', async () => {
      await expect(
        new CommunityPointAwardService(db).evaluateSurveyCompletion(
          crypto.randomUUID(),
        ),
      ).rejects.toMatchObject({
        status: 404,
        code: 'SURVEY_COMPLETION_EVIDENCE_NOT_FOUND',
      });
    });

    it('does not award when all applicable rules are paused/inactive', async () => {
      const repos = createRepositories(db);
      const suffix = crypto.randomUUID();
      const survey = await repos.surveys.createSurvey({
        ownerType: 'business',
        businessId,
        name: 'Paused Community Rule Survey',
        status: 'published',
      });
      const { version } = await repos.surveys.createVersionWithQuestions(
        {
          surveyId: survey.id,
          version: 1,
          status: 'published',
          title: 'Paused Community Rule Survey v1',
          publishedAt: new Date(),
        },
        [],
      );
      const campaign = await repos.surveys.createCampaign({
        surveyId: survey.id,
        surveyVersionId: version.id,
        businessId,
        name: 'Paused Community Rule Campaign',
        status: 'active',
        audienceClass: 'general_authenticated_participant',
        repeatPolicy: 'once_per_campaign',
      });
      const participation = await repos.surveyParticipations.createIdempotent({
        surveyId: survey.id,
        surveyVersionId: version.id,
        campaignId: campaign.id,
        participantCustomerId: customerId,
        businessId,
        status: 'started',
        idempotencyKey: suffix,
        source: 'direct',
      });
      const completed = await repos.surveyParticipations.completeWithAnswers(
        participation.participation.id,
        [],
        crypto.randomUUID(),
      );

      const pausedRule = await repos.communityPointRules.create({
        sourceType: 'survey_completion',
        resourceType: 'survey_campaign',
        resourceId: campaign.id,
        version: 1,
        status: 'paused',
        points: 999,
      });

      await repos.communityPointRules.updateLifecycle(globalRuleId, {
        status: 'paused',
      });
      try {
        await expect(
          new CommunityPointAwardService(db).evaluateSurveyCompletion(
            completed.id,
          ),
        ).rejects.toMatchObject({
          status: 409,
          code: 'COMMUNITY_POINT_RULE_NOT_ACTIVE',
        });

        expect(
          await repos.communityPointAwardDecisions.listBySourceRef(
            'survey_completion',
            completed.id,
          ),
        ).toHaveLength(0);
      } finally {
        await repos.communityPointRules.updateLifecycle(globalRuleId, {
          status: 'active',
          activatedAt: new Date(),
        });
        await repos.communityPointRules.updateLifecycle(pausedRule.id, {
          status: 'retired',
          retiredAt: new Date(),
        });
      }
    });

    it('rejects non-completed evidence and never creates an award decision from it', async () => {
      const repos = createRepositories(db);
      const survey = await repos.surveys.createSurvey({
        ownerType: 'business',
        businessId,
        name: 'Incomplete Award Survey',
        status: 'published',
      });
      const { version } = await repos.surveys.createVersionWithQuestions(
        {
          surveyId: survey.id,
          version: 1,
          status: 'published',
          title: 'Incomplete Award Survey v1',
          publishedAt: new Date(),
        },
        [],
      );
      const campaign = await repos.surveys.createCampaign({
        surveyId: survey.id,
        surveyVersionId: version.id,
        businessId,
        name: 'Incomplete Award Campaign',
        status: 'active',
        audienceClass: 'general_authenticated_participant',
        repeatPolicy: 'once_per_campaign',
      });
      const started = await repos.surveyParticipations.createIdempotent({
        surveyId: survey.id,
        surveyVersionId: version.id,
        campaignId: campaign.id,
        participantCustomerId: customerId,
        businessId,
        status: 'started',
        idempotencyKey: crypto.randomUUID(),
        source: 'direct',
      });

      await expect(
        new CommunityPointAwardService(db).evaluateSurveyCompletion(
          started.participation.id,
        ),
      ).rejects.toMatchObject({
        status: 404,
        code: 'SURVEY_COMPLETION_EVIDENCE_NOT_FOUND',
      });
    });
  },
);
