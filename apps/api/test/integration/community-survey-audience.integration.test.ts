import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { CommunityMembershipService } from '../../src/community/community-membership.service';
import { assertSurveyAudienceEligible } from '../../src/surveys/survey-participation.service';

describe.skipIf(!process.env.DATABASE_URL)(
  'Split 05 Community survey audiences (integration)',
  () => {
    let client: Client;
    let db: ReturnType<typeof buildDb>;
    let customerId: string;
    let communityMemberCampaign: Awaited<
      ReturnType<ReturnType<typeof createRepositories>['surveys']['createCampaign']>
    >;
    let communityCandidateCampaign: typeof communityMemberCampaign;

    beforeAll(async () => {
      client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      db = buildDb(client);
      const repos = createRepositories(db);
      const suffix = crypto.randomUUID();

      const customer = await repos.customers.create({
        phone: `+1591${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });
      customerId = customer.id;

      const business = await repos.businesses.create({
        name: 'Community Audience Business',
        slug: `community-audience-${suffix}`,
      });
      const survey = await repos.surveys.createSurvey({
        ownerType: 'business',
        businessId: business.id,
        name: 'Community Audience Survey',
        status: 'published',
      });
      const { version } = await repos.surveys.createVersionWithQuestions(
        {
          surveyId: survey.id,
          version: 1,
          status: 'published',
          title: 'Community Audience Survey v1',
          publishedAt: new Date(),
        },
        [],
      );

      communityMemberCampaign = await repos.surveys.createCampaign({
        surveyId: survey.id,
        surveyVersionId: version.id,
        businessId: business.id,
        name: 'Active Community members',
        status: 'active',
        audienceClass: 'community_member',
        repeatPolicy: 'once_per_campaign',
      });
      communityCandidateCampaign = await repos.surveys.createCampaign({
        surveyId: survey.id,
        surveyVersionId: version.id,
        businessId: business.id,
        name: 'Community candidates',
        status: 'active',
        audienceClass: 'community_candidate',
        repeatPolicy: 'once_per_campaign',
      });
    });

    afterAll(async () => {
      await client.end();
    });

    it('treats a non-member as a candidate without creating membership or a point account', async () => {
      const repos = createRepositories(db);

      await expect(
        assertSurveyAudienceEligible(
          repos,
          customerId,
          communityCandidateCampaign,
        ),
      ).resolves.toBeUndefined();

      await expect(
        assertSurveyAudienceEligible(
          repos,
          customerId,
          communityMemberCampaign,
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: 'SURVEY_PARTICIPANT_INELIGIBLE',
      });

      expect(
        await repos.communityMemberships.findByCustomerId(customerId),
      ).toBeUndefined();
      expect(
        await repos.communityPointAccounts.findByCustomerId(customerId),
      ).toBeUndefined();
    });

    it('resolves community_member only for active membership and excludes active members from candidate campaigns', async () => {
      const repos = createRepositories(db);
      await new CommunityMembershipService(db).join(
        customerId,
        'community-policy-v1',
      );

      await expect(
        assertSurveyAudienceEligible(
          repos,
          customerId,
          communityMemberCampaign,
        ),
      ).resolves.toBeUndefined();

      await expect(
        assertSurveyAudienceEligible(
          repos,
          customerId,
          communityCandidateCampaign,
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: 'SURVEY_PARTICIPANT_INELIGIBLE',
      });
    });

    it('stops resolving community_member after leave and permits candidate participation again', async () => {
      const repos = createRepositories(db);
      await new CommunityMembershipService(db).leave(customerId);

      await expect(
        assertSurveyAudienceEligible(
          repos,
          customerId,
          communityMemberCampaign,
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: 'SURVEY_PARTICIPANT_INELIGIBLE',
      });

      await expect(
        assertSurveyAudienceEligible(
          repos,
          customerId,
          communityCandidateCampaign,
        ),
      ).resolves.toBeUndefined();

      expect(
        await repos.communityMemberships.findActiveByCustomerId(customerId),
      ).toBeUndefined();
    });
  },
);
