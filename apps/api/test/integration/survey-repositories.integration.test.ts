import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { SurveyManagementService } from '../../src/surveys/survey-management.service';
import { SurveyParticipationService } from '../../src/surveys/survey-participation.service';

describe.skipIf(!process.env.DATABASE_URL)('Split 04 survey repositories (integration)', () => {
  let client: Client;
  let db: ReturnType<typeof buildDb>;
  let repos: ReturnType<typeof createRepositories>;
  let businessAId: string;
  let businessBId: string;
  let customerId: string;
  let businessABranchId: string;
  let businessAOtherBranchId: string;
  let businessBBranchId: string;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    db = buildDb(client);
    repos = createRepositories(db);

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

    const businessABranch = await repos.branches.create({
      businessId: businessA.id,
      name: 'Survey Branch A',
      slug: `survey-a-${suffix}`,
    });
    const businessAOtherBranch = await repos.branches.create({
      businessId: businessA.id,
      name: 'Survey Branch B',
      slug: `survey-b-${suffix}`,
    });
    const businessBBranch = await repos.branches.create({
      businessId: businessB.id,
      name: 'Other Business Branch',
      slug: `other-${suffix}`,
    });

    businessAId = businessA.id;
    businessABranchId = businessABranch.id;
    businessAOtherBranchId = businessAOtherBranch.id;
    businessBId = businessB.id;
    businessBBranchId = businessBBranch.id;
    customerId = customer.id;
  });

  afterAll(async () => {
    await client.end();
  });

  it('enforces management lifecycle and cross-business boundaries', async () => {
    const service = new SurveyManagementService(repos);
    const survey = await service.createSurvey(
      businessAId,
      { name: 'Management Survey' },
      crypto.randomUUID(),
    );

    await expect(service.getSurvey(businessBId, survey.id)).rejects.toMatchObject({
      code: 'SURVEY_NOT_FOUND',
      status: 404,
    });

    const version = await service.createVersion(
      businessAId,
      survey.id,
      {
        title: 'Management Survey v1',
        questions: [
          {
            key: 'score',
            label: 'Score',
            type: 'rating',
            required: true,
            validation: { min: 1, max: 5 },
          },
        ],
      },
      crypto.randomUUID(),
    );

    await expect(
      service.createCampaign(
        businessAId,
        {
          surveyVersionId: version.version.id,
          branchId: businessBBranchId,
          name: 'Wrong Branch',
          audienceClass: 'general_authenticated_participant',
          repeatPolicy: 'once_per_campaign',
          exposeInQrResolver: false,
        },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({
      code: 'SURVEY_VERSION_NOT_PUBLISHED',
      status: 409,
    });

    const published = await service.publishVersion(
      businessAId,
      survey.id,
      version.version.id,
      crypto.randomUUID(),
    );
    expect(published.status).toBe('published');

    await expect(
      service.createCampaign(
        businessAId,
        {
          surveyVersionId: version.version.id,
          branchId: businessBBranchId,
          name: 'Wrong Branch',
          audienceClass: 'general_authenticated_participant',
          repeatPolicy: 'once_per_campaign',
          exposeInQrResolver: false,
        },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({
      code: 'BRANCH_NOT_FOUND',
      status: 404,
    });

    const campaign = await service.createCampaign(
      businessAId,
      {
        surveyVersionId: version.version.id,
        name: 'Valid Campaign',
        audienceClass: 'general_authenticated_participant',
        repeatPolicy: 'once_per_campaign',
        exposeInQrResolver: false,
      },
      crypto.randomUUID(),
    );
    expect(campaign.status).toBe('draft');

    const active = await service.activateCampaign(
      businessAId,
      campaign.id,
      crypto.randomUUID(),
    );
    expect(active.status).toBe('active');

    const paused = await service.pauseCampaign(
      businessAId,
      campaign.id,
      crypto.randomUUID(),
    );
    expect(paused.status).toBe('paused');

    const closed = await service.closeCampaign(
      businessAId,
      campaign.id,
      crypto.randomUUID(),
    );
    expect(closed.status).toBe('closed');
  });

  it('exposes only active in-window campaigns through the QR discovery query', async () => {
    const management = new SurveyManagementService(repos);
    const actorId = crypto.randomUUID();

    const survey = await management.createSurvey(
      businessAId,
      { name: 'QR Discovery Survey' },
      actorId,
    );
    const createdVersion = await management.createVersion(
      businessAId,
      survey.id,
      {
        title: 'QR Discovery Survey v1',
        questions: [
          {
            key: 'rating',
            label: 'Rate us',
            type: 'rating',
            required: true,
            validation: { min: 1, max: 5 },
          },
        ],
      },
      actorId,
    );
    await management.publishVersion(
      businessAId,
      survey.id,
      createdVersion.version.id,
      actorId,
    );

    const businessWide = await management.createCampaign(
      businessAId,
      {
        surveyVersionId: createdVersion.version.id,
        name: 'Business-wide QR survey',
        audienceClass: 'general_authenticated_participant',
        repeatPolicy: 'repeatable',
        exposeInQrResolver: true,
      },
      actorId,
    );
    await management.activateCampaign(businessAId, businessWide.id, actorId);

    const branchOnly = await management.createCampaign(
      businessAId,
      {
        surveyVersionId: createdVersion.version.id,
        branchId: businessABranchId,
        name: 'Branch-only QR survey',
        audienceClass: 'general_authenticated_participant',
        repeatPolicy: 'repeatable',
        exposeInQrResolver: true,
      },
      actorId,
    );
    await management.activateCampaign(businessAId, branchOnly.id, actorId);

    const hidden = await management.createCampaign(
      businessAId,
      {
        surveyVersionId: createdVersion.version.id,
        name: 'Not exposed',
        audienceClass: 'general_authenticated_participant',
        repeatPolicy: 'repeatable',
        exposeInQrResolver: false,
      },
      actorId,
    );
    await management.activateCampaign(businessAId, hidden.id, actorId);

    const future = await management.createCampaign(
      businessAId,
      {
        surveyVersionId: createdVersion.version.id,
        name: 'Future QR survey',
        audienceClass: 'general_authenticated_participant',
        repeatPolicy: 'repeatable',
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        exposeInQrResolver: true,
      },
      actorId,
    );
    await management.activateCampaign(businessAId, future.id, actorId);

    const firstBranch = await repos.surveys.listQrExposedForBusinessBranch(
      businessAId,
      businessABranchId,
    );
    expect(firstBranch.map((row) => row.id)).toEqual(
      expect.arrayContaining([businessWide.id, branchOnly.id]),
    );
    expect(firstBranch.map((row) => row.id)).not.toContain(hidden.id);
    expect(firstBranch.map((row) => row.id)).not.toContain(future.id);

    const otherBranch = await repos.surveys.listQrExposedForBusinessBranch(
      businessAId,
      businessAOtherBranchId,
    );
    expect(otherBranch.map((row) => row.id)).toContain(businessWide.id);
    expect(otherBranch.map((row) => row.id)).not.toContain(branchOnly.id);

    await management.pauseCampaign(businessAId, branchOnly.id, actorId);
    const afterPause = await repos.surveys.listQrExposedForBusinessBranch(
      businessAId,
      businessABranchId,
    );
    expect(afterPause.map((row) => row.id)).not.toContain(branchOnly.id);
  });

  it('enforces participant eligibility, consent, and idempotent submission', async () => {
    const management = new SurveyManagementService(repos);
    const participationService = new SurveyParticipationService(db);
    const actorId = crypto.randomUUID();

    const survey = await management.createSurvey(
      businessAId,
      { name: 'Participant Survey' },
      actorId,
    );
    const createdVersion = await management.createVersion(
      businessAId,
      survey.id,
      {
        title: 'Participant Survey v1',
        questions: [
          {
            key: 'rating',
            label: 'Rate the experience',
            type: 'rating',
            required: true,
            validation: { min: 1, max: 5 },
          },
        ],
      },
      actorId,
    );
    await management.publishVersion(
      businessAId,
      survey.id,
      createdVersion.version.id,
      actorId,
    );

    const campaign = await management.createCampaign(
      businessAId,
      {
        surveyVersionId: createdVersion.version.id,
        name: 'Participant Campaign',
        audienceClass: 'general_authenticated_participant',
        repeatPolicy: 'once_per_campaign',
        exposeInQrResolver: false,
      },
      actorId,
    );
    await management.activateCampaign(businessAId, campaign.id, actorId);

    const idempotencyKey = crypto.randomUUID();
    const started = await participationService.start(customerId, campaign.id, {
      idempotencyKey,
      consentAccepted: true,
      consentVersion: 'v1',
    });

    expect(started.inserted).toBe(true);
    expect(started.participation.status).toBe('started');
    expect(started.participation.consentGrantId).not.toBeNull();

    await repos.consentGrants.revoke(started.participation.consentGrantId!, customerId);

    await expect(
      participationService.submit(customerId, campaign.id, {
        idempotencyKey,
        answers: [{ questionId: createdVersion.questions[0]!.id, value: 5 }],
      }),
    ).rejects.toMatchObject({
      code: 'SURVEY_CONSENT_REQUIRED',
      status: 403,
    });

    const reconsented = await participationService.start(customerId, campaign.id, {
      idempotencyKey,
      consentAccepted: true,
      consentVersion: 'v2',
    });
    expect(reconsented.inserted).toBe(false);
    expect(reconsented.participation.consentGrantId).not.toBe(started.participation.consentGrantId);

    const completed = await participationService.submit(customerId, campaign.id, {
      idempotencyKey,
      answers: [{ questionId: createdVersion.questions[0]!.id, value: 5 }],
    });
    expect(completed.status).toBe('completed');
    expect(completed.submissionPayloadHash).toMatch(/^[0-9a-f]{64}$/);

    const replay = await participationService.submit(customerId, campaign.id, {
      idempotencyKey,
      answers: [{ questionId: createdVersion.questions[0]!.id, value: 5 }],
    });
    expect(replay.id).toBe(completed.id);

    await expect(
      participationService.submit(customerId, campaign.id, {
        idempotencyKey,
        answers: [{ questionId: createdVersion.questions[0]!.id, value: 4 }],
      }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
    });

    await expect(
      participationService.start(customerId, campaign.id, {
        idempotencyKey: crypto.randomUUID(),
        consentAccepted: true,
        consentVersion: 'v1',
      }),
    ).rejects.toMatchObject({
      code: 'SURVEY_REPEAT_NOT_ALLOWED',
      status: 409,
    });
  });

  it('fails closed for membership and Community audience eligibility', async () => {
    const management = new SurveyManagementService(repos);
    const participationService = new SurveyParticipationService(db);
    const actorId = crypto.randomUUID();

    const survey = await management.createSurvey(
      businessAId,
      { name: 'Audience Survey' },
      actorId,
    );
    const createdVersion = await management.createVersion(
      businessAId,
      survey.id,
      {
        title: 'Audience Survey v1',
        questions: [
          {
            key: 'comment',
            label: 'Comment',
            type: 'text',
            required: false,
          },
        ],
      },
      actorId,
    );
    await management.publishVersion(
      businessAId,
      survey.id,
      createdVersion.version.id,
      actorId,
    );

    const memberCampaign = await management.createCampaign(
      businessAId,
      {
        surveyVersionId: createdVersion.version.id,
        name: 'Members only',
        audienceClass: 'business_member',
        repeatPolicy: 'repeatable',
        exposeInQrResolver: false,
      },
      actorId,
    );
    await management.activateCampaign(businessAId, memberCampaign.id, actorId);

    await expect(
      participationService.start(customerId, memberCampaign.id, {
        idempotencyKey: crypto.randomUUID(),
        consentAccepted: true,
        consentVersion: 'v1',
      }),
    ).rejects.toMatchObject({
      code: 'SURVEY_PARTICIPANT_INELIGIBLE',
      status: 403,
    });

    await repos.customerMemberships.create({
      customerId,
      businessId: businessAId,
      status: 'active',
      onboardingSource: 'integration_test',
    });

    const memberStart = await participationService.start(customerId, memberCampaign.id, {
      idempotencyKey: crypto.randomUUID(),
      consentAccepted: true,
      consentVersion: 'v1',
    });
    expect(memberStart.participation.status).toBe('started');

    const communityCampaign = await management.createCampaign(
      businessAId,
      {
        surveyVersionId: createdVersion.version.id,
        name: 'Community only',
        audienceClass: 'community_member',
        repeatPolicy: 'repeatable',
        exposeInQrResolver: false,
      },
      actorId,
    );
    await management.activateCampaign(businessAId, communityCampaign.id, actorId);

    await expect(
      participationService.start(customerId, communityCampaign.id, {
        idempotencyKey: crypto.randomUUID(),
        consentAccepted: true,
        consentVersion: 'v1',
      }),
    ).rejects.toMatchObject({
      code: 'SURVEY_COMMUNITY_AUDIENCE_UNAVAILABLE',
      status: 409,
    });
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
