import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';

describe.skipIf(!process.env.DATABASE_URL)('Split 04 survey repositories (integration)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let businessAId: string;
  let businessBId: string;
  let customerId: string;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    repos = createRepositories(buildDb(client));

    const suffix = crypto.randomUUID();
    const businessA = await repos.businesses.create({
      name: 'Survey Repository Business A',
      slug: `survey-repo-a-${suffix}`,
    });
    const businessB = await repos.businesses.create({
      name: 'Survey Repository Business B',
      slug: `survey-repo-b-${suffix}`,
    });
    const customer = await repos.customers.create({
      phone: `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
      phoneVerifiedAt: new Date(),
    });

    businessAId = businessA.id;
    businessBId = businessB.id;
    customerId = customer.id;
  });

  afterAll(async () => {
    await client.end();
  });

  it('preserves tenant isolation and durable idempotent completion evidence', async () => {
    const survey = await repos.surveys.createSurvey({
      ownerType: 'business',
      businessId: businessAId,
      name: 'Experience Survey',
      status: 'draft',
    });

    expect(await repos.surveys.findBusinessOwnedById(survey.id, businessAId)).toBeDefined();
    expect(await repos.surveys.findBusinessOwnedById(survey.id, businessBId)).toBeUndefined();

    const { version, questions } = await repos.surveys.createVersionWithQuestions(
      {
        surveyId: survey.id,
        version: 1,
        status: 'published',
        title: 'Experience Survey v1',
        publishedAt: new Date(),
      },
      [
        {
          key: 'rating',
          label: 'How was your experience?',
          type: 'rating',
          required: true,
          position: 0,
          options: null,
          validation: { min: 1, max: 5 },
        },
      ],
    );

    expect(version.version).toBe(1);
    expect(questions).toHaveLength(1);

    const campaign = await repos.surveys.createCampaign({
      surveyId: survey.id,
      surveyVersionId: version.id,
      businessId: businessAId,
      name: 'October Experience',
      status: 'active',
      audienceClass: 'general_authenticated_participant',
      repeatPolicy: 'once_per_campaign',
    });

    expect(await repos.surveys.findCampaignForBusiness(campaign.id, businessAId)).toBeDefined();
    expect(await repos.surveys.findCampaignForBusiness(campaign.id, businessBId)).toBeUndefined();

    const idempotencyKey = crypto.randomUUID();
    const first = await repos.surveyParticipations.createIdempotent({
      surveyId: survey.id,
      surveyVersionId: version.id,
      campaignId: campaign.id,
      participantCustomerId: customerId,
      businessId: businessAId,
      status: 'started',
      idempotencyKey,
      source: 'direct',
    });
    const replay = await repos.surveyParticipations.createIdempotent({
      surveyId: survey.id,
      surveyVersionId: version.id,
      campaignId: campaign.id,
      participantCustomerId: customerId,
      businessId: businessAId,
      status: 'started',
      idempotencyKey,
      source: 'direct',
    });

    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(replay.participation.id).toBe(first.participation.id);

    const completed = await repos.surveyParticipations.completeWithAnswers(
      first.participation.id,
      [
        {
          questionId: questions[0]!.id,
          questionKey: questions[0]!.key,
          questionLabel: questions[0]!.label,
          questionType: questions[0]!.type,
          value: 5,
        },
      ],
      'payload-hash-1',
    );

    expect(completed.status).toBe('completed');
    expect(completed.completedAt).not.toBeNull();
    expect(completed.submissionPayloadHash).toBe('payload-hash-1');
    expect(await repos.surveyParticipations.listAnswers(completed.id)).toHaveLength(1);
    expect(await repos.surveyParticipations.countCompletedForCampaign(campaign.id)).toBe(1);
  });
});
