import type {
  StartSurveyParticipationInput,
  SubmitSurveyParticipationInput,
  SurveyAnswerInput,
  SurveyQuestionValidation,
} from '@echo-grid-feedback/shared-types';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  surveyCampaigns,
  surveyParticipations,
  surveys,
} from '../db/schema';
import {
  createRepositories,
  type SurveyCampaign,
  type SurveyParticipation,
  type SurveyQuestion,
} from '../repositories';
import { AppError } from '../lib/errors';

type ParticipationStartResult = {
  participation: SurveyParticipation;
  inserted: boolean;
};

function normalizeAnswerValue(value: SurveyAnswerInput['value']): SurveyAnswerInput['value'] {
  return Array.isArray(value) ? [...value].sort() : value;
}

async function hashSubmission(answers: SurveyAnswerInput[]): Promise<string> {
  const canonical = [...answers]
    .map((answer) => ({
      questionId: answer.questionId,
      value: normalizeAnswerValue(answer.value),
    }))
    .sort((a, b) => a.questionId.localeCompare(b.questionId));
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertAnswerValue(question: SurveyQuestion, value: SurveyAnswerInput['value']): void {
  const validation = (question.validation ?? {}) as SurveyQuestionValidation;
  const fail = (message: string): never => {
    throw new AppError(message, 422, 'SURVEY_ANSWER_INVALID', {
      questionId: question.id,
      questionKey: question.key,
    });
  };

  if (question.type === 'text' || question.type === 'textarea') {
    if (typeof value !== 'string') fail('This survey answer must be text.');
    if (validation.minLength !== undefined && value.length < validation.minLength) {
      fail('This survey answer is shorter than allowed.');
    }
    if (validation.maxLength !== undefined && value.length > validation.maxLength) {
      fail('This survey answer is longer than allowed.');
    }
    return;
  }

  if (question.type === 'number' || question.type === 'rating') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail('This survey answer must be a number.');
    }
    if (question.type === 'rating' && !Number.isInteger(value)) {
      fail('This survey rating must be an integer.');
    }
    if (validation.min !== undefined && value < validation.min) {
      fail('This survey answer is below the allowed minimum.');
    }
    if (validation.max !== undefined && value > validation.max) {
      fail('This survey answer is above the allowed maximum.');
    }
    return;
  }

  if (question.type === 'boolean') {
    if (typeof value !== 'boolean') fail('This survey answer must be true or false.');
    return;
  }

  const options = question.options ?? [];
  if (question.type === 'single_choice') {
    if (typeof value !== 'string' || !options.includes(value)) {
      fail('This survey answer is not one of the allowed options.');
    }
    return;
  }

  if (question.type === 'multi_choice') {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      fail('This survey answer must be a list of allowed options.');
    }
    if (new Set(value).size !== value.length || value.some((item) => !options.includes(item))) {
      fail('This survey answer contains duplicate or invalid options.');
    }
    return;
  }

  fail('Unsupported survey question type.');
}

export class SurveyParticipationService {
  constructor(private readonly db: Database) {}

  async start(
    customerId: string,
    campaignId: string,
    input: StartSurveyParticipationInput,
  ): Promise<ParticipationStartResult> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const campaign = await this.requireStartableCampaign(repos, campaignId);
      const existing = await repos.surveyParticipations.findByCampaignIdempotencyKey(
        campaign.id,
        input.idempotencyKey,
      );

      if (existing) {
        if (existing.participantCustomerId !== customerId) {
          throw new AppError(
            'This idempotency key is already in use.',
            409,
            'IDEMPOTENCY_CONFLICT',
          );
        }
        if (existing.status === 'invalidated') {
          throw new AppError(
            'This survey participation has been invalidated.',
            409,
            'SURVEY_PARTICIPATION_INVALIDATED',
          );
        }

        const consent = await this.ensureCampaignConsent(
          repos,
          customerId,
          campaign,
          input.consentVersion,
          input.idempotencyKey,
        );
        if (existing.consentGrantId !== consent.id) {
          const updated = await repos.surveyParticipations.attachConsentGrant(
            existing.id,
            customerId,
            consent.id,
          );
          if (updated) return { participation: updated, inserted: false };
        }
        return { participation: existing, inserted: false };
      }

      await this.lockRepeatPolicyScope(tx, campaign);
      await this.assertAudienceEligible(repos, customerId, campaign);
      await this.assertRepeatPolicy(repos, customerId, campaign);

      if (campaign.maxResponses !== null) {
        const completed = await repos.surveyParticipations.countCompletedForCampaign(campaign.id);
        if (completed >= campaign.maxResponses) {
          throw new AppError(
            'This survey campaign has reached its response limit.',
            409,
            'SURVEY_CAMPAIGN_FULL',
          );
        }
      }

      const consent = await this.ensureCampaignConsent(
        repos,
        customerId,
        campaign,
        input.consentVersion,
        input.idempotencyKey,
      );

      const result = await repos.surveyParticipations.createIdempotent({
        surveyId: campaign.surveyId,
        surveyVersionId: campaign.surveyVersionId,
        campaignId: campaign.id,
        participantCustomerId: customerId,
        businessId: campaign.businessId,
        branchId: campaign.branchId,
        consentGrantId: consent.id,
        status: 'started',
        idempotencyKey: input.idempotencyKey,
        source: 'direct',
      });

      if (result.participation.participantCustomerId !== customerId) {
        throw new AppError(
          'This idempotency key is already in use.',
          409,
          'IDEMPOTENCY_CONFLICT',
        );
      }
      return result;
    });
  }

  async submit(
    customerId: string,
    campaignId: string,
    input: SubmitSurveyParticipationInput,
  ): Promise<SurveyParticipation> {
    const submissionPayloadHash = await hashSubmission(input.answers);

    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const campaign = await this.requireStartableCampaign(repos, campaignId);

      await tx.execute(
        sql`select id from ${surveyParticipations}
            where ${surveyParticipations.campaignId} = ${campaign.id}
              and ${surveyParticipations.idempotencyKey} = ${input.idempotencyKey}
            for update`,
      );

      const participation = await repos.surveyParticipations.findByCampaignIdempotencyKey(
        campaign.id,
        input.idempotencyKey,
      );
      if (!participation || participation.participantCustomerId !== customerId) {
        throw new AppError(
          'Survey participation not found.',
          404,
          'SURVEY_PARTICIPATION_NOT_FOUND',
        );
      }
      if (participation.status === 'invalidated') {
        throw new AppError(
          'This survey participation has been invalidated.',
          409,
          'SURVEY_PARTICIPATION_INVALIDATED',
        );
      }
      if (participation.status === 'completed') {
        if (participation.submissionPayloadHash === submissionPayloadHash) {
          return participation;
        }
        throw new AppError(
          'This idempotency key was already used for a different survey submission.',
          409,
          'IDEMPOTENCY_CONFLICT',
        );
      }

      const consent = await repos.consentGrants.findActiveForResource(
        customerId,
        campaign.businessId,
        'survey_participation',
        'survey_campaign',
        campaign.id,
      );
      if (!consent) {
        throw new AppError(
          'Active survey participation consent is required.',
          403,
          'SURVEY_CONSENT_REQUIRED',
        );
      }

      await this.assertAudienceEligible(repos, customerId, campaign);

      const version = await repos.surveys.findVersionById(participation.surveyVersionId);
      if (
        !version ||
        version.id !== campaign.surveyVersionId ||
        version.surveyId !== campaign.surveyId ||
        version.status !== 'published'
      ) {
        throw new AppError(
          'The survey version for this participation is not available.',
          409,
          'SURVEY_VERSION_NOT_PUBLISHED',
        );
      }

      const questions = await repos.surveys.listQuestions(version.id);
      const byId = new Map(questions.map((question) => [question.id, question]));
      const seen = new Set<string>();

      for (const answer of input.answers) {
        if (seen.has(answer.questionId)) {
          throw new AppError(
            'A survey question may only be answered once.',
            422,
            'SURVEY_ANSWER_DUPLICATE',
            { questionId: answer.questionId },
          );
        }
        seen.add(answer.questionId);
        const question = byId.get(answer.questionId);
        if (!question) {
          throw new AppError(
            'This answer does not belong to the survey version being completed.',
            422,
            'SURVEY_ANSWER_INVALID',
            { questionId: answer.questionId },
          );
        }
        assertAnswerValue(question, answer.value);
      }

      const missingRequired = questions.find(
        (question) => question.required && !seen.has(question.id),
      );
      if (missingRequired) {
        throw new AppError(
          'A required survey question is missing.',
          422,
          'SURVEY_REQUIRED_ANSWER_MISSING',
          { questionId: missingRequired.id, questionKey: missingRequired.key },
        );
      }

      await tx.execute(
        sql`select id from ${surveyCampaigns}
            where ${surveyCampaigns.id} = ${campaign.id}
            for update`,
      );
      if (campaign.maxResponses !== null) {
        const completed = await repos.surveyParticipations.countCompletedForCampaign(campaign.id);
        if (completed >= campaign.maxResponses) {
          throw new AppError(
            'This survey campaign has reached its response limit.',
            409,
            'SURVEY_CAMPAIGN_FULL',
          );
        }
      }

      return repos.surveyParticipations.completeWithAnswersLocked(
        participation.id,
        input.answers.map((answer) => {
          const question = byId.get(answer.questionId)!;
          return {
            questionId: question.id,
            questionKey: question.key,
            questionLabel: question.label,
            questionType: question.type,
            value: normalizeAnswerValue(answer.value),
          };
        }),
        submissionPayloadHash,
      );
    });
  }

  private async requireStartableCampaign(
    repos: ReturnType<typeof createRepositories>,
    campaignId: string,
  ): Promise<SurveyCampaign> {
    const campaign = await repos.surveys.findCampaignById(campaignId);
    if (!campaign) {
      throw new AppError('Survey campaign not found.', 404, 'SURVEY_CAMPAIGN_NOT_FOUND');
    }
    if (campaign.status !== 'active') {
      throw new AppError(
        'This survey campaign is not accepting participation.',
        409,
        'SURVEY_CAMPAIGN_NOT_ACTIVE',
      );
    }

    const now = new Date();
    if (campaign.startsAt && campaign.startsAt > now) {
      throw new AppError(
        'This survey campaign has not started.',
        409,
        'SURVEY_CAMPAIGN_NOT_STARTED',
      );
    }
    if (campaign.endsAt && campaign.endsAt <= now) {
      throw new AppError(
        'This survey campaign has ended.',
        409,
        'SURVEY_CAMPAIGN_ENDED',
      );
    }

    const [survey, version] = await Promise.all([
      repos.surveys.findById(campaign.surveyId),
      repos.surveys.findVersionById(campaign.surveyVersionId),
    ]);
    if (!survey || survey.status !== 'published') {
      throw new AppError(
        'This survey is not accepting participation.',
        409,
        'SURVEY_NOT_PUBLISHED',
      );
    }
    if (
      !version ||
      version.status !== 'published' ||
      version.surveyId !== survey.id
    ) {
      throw new AppError(
        'This survey version is not available.',
        409,
        'SURVEY_VERSION_NOT_PUBLISHED',
      );
    }

    if (campaign.businessId !== null) {
      if (survey.ownerType !== 'business' || survey.businessId !== campaign.businessId) {
        throw new AppError(
          'Survey campaign ownership is inconsistent.',
          409,
          'SURVEY_CAMPAIGN_OWNERSHIP_CONFLICT',
        );
      }
      const business = await repos.businesses.findById(campaign.businessId);
      if (!business || business.status !== 'active') {
        throw new AppError(
          'This business is not accepting survey participation.',
          409,
          'BUSINESS_NOT_AVAILABLE',
        );
      }
    } else if (survey.ownerType !== 'platform' || survey.businessId !== null) {
      throw new AppError(
        'Survey campaign ownership is inconsistent.',
        409,
        'SURVEY_CAMPAIGN_OWNERSHIP_CONFLICT',
      );
    }

    return campaign;
  }

  private async assertAudienceEligible(
    repos: ReturnType<typeof createRepositories>,
    customerId: string,
    campaign: SurveyCampaign,
  ): Promise<void> {
    if (
      campaign.audienceClass === 'customer' ||
      campaign.audienceClass === 'general_authenticated_participant'
    ) {
      return;
    }

    if (campaign.audienceClass === 'business_member') {
      if (!campaign.businessId) {
        throw new AppError(
          'This survey audience is not available for this campaign.',
          403,
          'SURVEY_PARTICIPANT_INELIGIBLE',
        );
      }
      const membership = await repos.customerMemberships.findActive(
        customerId,
        campaign.businessId,
      );
      if (!membership) {
        throw new AppError(
          'An active business membership is required for this survey.',
          403,
          'SURVEY_PARTICIPANT_INELIGIBLE',
        );
      }
      return;
    }

    throw new AppError(
      'Community survey audiences are not available until Community membership is implemented.',
      409,
      'SURVEY_COMMUNITY_AUDIENCE_UNAVAILABLE',
    );
  }

  private async assertRepeatPolicy(
    repos: ReturnType<typeof createRepositories>,
    customerId: string,
    campaign: SurveyCampaign,
  ): Promise<void> {
    if (campaign.repeatPolicy === 'repeatable') return;

    const count =
      campaign.repeatPolicy === 'once'
        ? await repos.surveyParticipations.countNonInvalidatedForCustomerSurvey(
            customerId,
            campaign.surveyId,
          )
        : await repos.surveyParticipations.countNonInvalidatedForCustomerCampaign(
            customerId,
            campaign.id,
          );

    if (count > 0) {
      throw new AppError(
        'This survey does not allow another participation for this customer.',
        409,
        'SURVEY_REPEAT_NOT_ALLOWED',
      );
    }
  }

  private async lockRepeatPolicyScope(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    campaign: SurveyCampaign,
  ): Promise<void> {
    if (campaign.repeatPolicy === 'once') {
      await tx.execute(
        sql`select id from ${surveys} where ${surveys.id} = ${campaign.surveyId} for update`,
      );
    } else if (campaign.repeatPolicy === 'once_per_campaign') {
      await tx.execute(
        sql`select id from ${surveyCampaigns}
            where ${surveyCampaigns.id} = ${campaign.id}
            for update`,
      );
    }
  }

  private async ensureCampaignConsent(
    repos: ReturnType<typeof createRepositories>,
    customerId: string,
    campaign: SurveyCampaign,
    consentVersion: string,
    idempotencyKey: string,
  ) {
    const existing = await repos.consentGrants.findActiveForResource(
      customerId,
      campaign.businessId,
      'survey_participation',
      'survey_campaign',
      campaign.id,
    );
    if (existing) return existing;

    return repos.consentGrants.create({
      customerId,
      businessId: campaign.businessId,
      purpose: 'survey_participation',
      scope: 'participate',
      resourceType: 'survey_campaign',
      resourceId: campaign.id,
      consentVersion,
      status: 'active',
      idempotencyKey: `survey:${campaign.id}:${customerId}:${idempotencyKey}`,
      expiresAt: campaign.endsAt,
      metadata: {
        campaignId: campaign.id,
        surveyId: campaign.surveyId,
        surveyVersionId: campaign.surveyVersionId,
      },
    });
  }
}
