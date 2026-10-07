import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { CommunityMembershipService } from '../../src/community/community-membership.service';
import { CommunityPointAwardService } from '../../src/community/community-point-award.service';
import { CommunityPointReversalService } from '../../src/community/community-point-reversal.service';

describe.skipIf(!process.env.DATABASE_URL)(
  'Split 05 Community Point reversal (integration)',
  () => {
    let client: Client;
    let db: ReturnType<typeof buildDb>;
    let customerId: string;
    let completionRef: string;
    let accountId: string;
    let originalEarnId: string;

    beforeAll(async () => {
      client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      db = buildDb(client);
      const repos = createRepositories(db);
      const suffix = crypto.randomUUID();

      const customer = await repos.customers.create({
        phone: `+1559${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });
      customerId = customer.id;

      const business = await repos.businesses.create({
        name: 'Community Reversal Business',
        slug: `community-reversal-${suffix}`,
      });

      const survey = await repos.surveys.createSurvey({
        ownerType: 'business',
        businessId: business.id,
        name: 'Community Reversal Survey',
        status: 'published',
      });
      const { version } = await repos.surveys.createVersionWithQuestions(
        {
          surveyId: survey.id,
          version: 1,
          status: 'published',
          title: 'Community Reversal Survey v1',
          publishedAt: new Date(),
        },
        [],
      );
      const campaign = await repos.surveys.createCampaign({
        surveyId: survey.id,
        surveyVersionId: version.id,
        businessId: business.id,
        name: 'Community Reversal Campaign',
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
        version: 202,
        status: 'draft',
        points: 100,
      });
      await repos.communityPointRules.updateLifecycle(rule.id, {
        status: 'active',
        activatedAt: new Date(),
      });

      const joined = await new CommunityMembershipService(db).join(
        customerId,
        'community-policy-v1',
      );
      accountId = joined.account.id;

      const awarded = await new CommunityPointAwardService(db).evaluateSurveyCompletion(
        completionRef,
      );
      expect(awarded.awarded).toBe(true);
      expect(awarded.transaction?.points).toBe(100);
      expect(awarded.account?.pointsBalance).toBe(100);
      originalEarnId = awarded.transaction!.id;
    });

    afterAll(async () => {
      await client.end();
    });

    it('requires authoritative invalidated survey evidence before reversal', async () => {
      await expect(
        new CommunityPointReversalService(db).reverseInvalidatedSurveyCompletion(
          completionRef,
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'SURVEY_COMPLETION_NOT_INVALIDATED',
      });
    });

    it('appends one compensating reversal and may drive the balance negative', async () => {
      const repos = createRepositories(db);

      // Persist a spend before the evidence is invalidated. The public
      // redemption flow remains disabled; this row only establishes the
      // frozen negative-correction scenario at the ledger layer.
      const spend = await repos.communityPointTransactions.createIdempotent({
        accountId,
        customerId,
        type: 'redeem',
        points: -100,
        sourceType: 'redemption',
        sourceRef: 'integration-spend-before-invalidation',
        idempotencyKey: crypto.randomUUID(),
      });
      expect(spend.inserted).toBe(true);
      const afterSpend = await repos.communityPointAccounts.incrementBalance(accountId, -100);
      expect(afterSpend?.pointsBalance).toBe(0);

      await repos.surveyParticipations.invalidate(completionRef);

      const service = new CommunityPointReversalService(db);
      const first = await service.reverseInvalidatedSurveyCompletion(completionRef);
      expect(first).toHaveLength(1);
      expect(first[0]!.reversed).toBe(true);
      expect(first[0]!.decision.status).toBe('reversed');
      expect(first[0]!.decision.reasonCode).toBe('source_evidence_invalidated');
      expect(first[0]!.originalTransaction.id).toBe(originalEarnId);
      expect(first[0]!.originalTransaction.type).toBe('earn');
      expect(first[0]!.originalTransaction.points).toBe(100);
      expect(first[0]!.reversalTransaction.type).toBe('reverse');
      expect(first[0]!.reversalTransaction.points).toBe(-100);
      expect(first[0]!.reversalTransaction.reversalOf).toBe(originalEarnId);
      expect(first[0]!.account.pointsBalance).toBe(-100);

      const replay = await service.reverseInvalidatedSurveyCompletion(completionRef);
      expect(replay).toHaveLength(1);
      expect(replay[0]!.reversed).toBe(false);
      expect(replay[0]!.reversalTransaction.id).toBe(
        first[0]!.reversalTransaction.id,
      );
      expect(replay[0]!.account.pointsBalance).toBe(-100);

      const account = await repos.communityPointAccounts.findById(accountId);
      expect(account?.pointsBalance).toBe(-100);

      const original = await repos.communityPointTransactions.findById(originalEarnId);
      expect(original?.type).toBe('earn');
      expect(original?.points).toBe(100);

      const reversal = await repos.communityPointTransactions.findReversalOf(originalEarnId);
      expect(reversal?.id).toBe(first[0]!.reversalTransaction.id);

      const history = await repos.communityPointTransactions.listForAccount(accountId);
      expect(history).toHaveLength(3);
      expect(history.filter((row) => row.type === 'reverse')).toHaveLength(1);
    });
  },
);
