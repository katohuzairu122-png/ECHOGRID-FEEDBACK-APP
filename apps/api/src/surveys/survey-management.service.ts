import type {
  CreateSurveyCampaignInput,
  CreateSurveyInput,
  CreateSurveyVersionInput,
} from '@echo-grid-feedback/shared-types';
import { AppError } from '../lib/errors';
import type { Repositories, Survey, SurveyCampaign, SurveyQuestion, SurveyVersion } from '../repositories';

export type SurveyVersionWithQuestions = {
  version: SurveyVersion;
  questions: SurveyQuestion[];
};

export class SurveyManagementService {
  constructor(
    private readonly repos: Pick<Repositories, 'surveys' | 'branches'>,
  ) {}

  async listSurveys(businessId: string): Promise<Survey[]> {
    return this.repos.surveys.listForBusiness(businessId);
  }

  async getSurvey(businessId: string, surveyId: string): Promise<Survey> {
    const survey = await this.repos.surveys.findBusinessOwnedById(surveyId, businessId);
    if (!survey) {
      throw new AppError('Survey not found.', 404, 'SURVEY_NOT_FOUND');
    }
    return survey;
  }

  async createSurvey(
    businessId: string,
    input: CreateSurveyInput,
    actorId: string,
  ): Promise<Survey> {
    return this.repos.surveys.createSurvey({
      ownerType: 'business',
      businessId,
      name: input.name,
      status: 'draft',
      createdBy: actorId,
      updatedBy: actorId,
    });
  }

  async createVersion(
    businessId: string,
    surveyId: string,
    input: CreateSurveyVersionInput,
    actorId: string,
  ): Promise<SurveyVersionWithQuestions> {
    const survey = await this.getSurvey(businessId, surveyId);
    if (survey.status === 'archived' || survey.status === 'closed') {
      throw new AppError(
        'Closed or archived surveys cannot receive new versions.',
        409,
        'SURVEY_NOT_EDITABLE',
      );
    }

    return this.repos.surveys.createNextVersionWithQuestions(
      survey.id,
      {
        status: 'draft',
        title: input.title,
        description: input.description ?? null,
        createdBy: actorId,
      },
      input.questions.map((question, position) => ({
        key: question.key,
        label: question.label,
        type: question.type,
        required: question.required,
        position,
        options: question.options ?? null,
        validation: question.validation
          ? ({ ...question.validation } as Record<string, unknown>)
          : null,
      })),
    );
  }

  async publishVersion(
    businessId: string,
    surveyId: string,
    versionId: string,
    actorId: string,
  ): Promise<SurveyVersion> {
    const survey = await this.getSurvey(businessId, surveyId);
    if (survey.status === 'archived' || survey.status === 'closed') {
      throw new AppError(
        'Closed or archived surveys cannot publish versions.',
        409,
        'SURVEY_NOT_EDITABLE',
      );
    }

    const version = await this.repos.surveys.findVersionForBusiness(versionId, businessId);
    if (!version || version.surveyId !== survey.id) {
      throw new AppError('Survey version not found.', 404, 'SURVEY_VERSION_NOT_FOUND');
    }
    if (version.status === 'published') return version;
    if (version.status === 'archived') {
      throw new AppError('Archived survey versions cannot be published.', 409, 'SURVEY_VERSION_ARCHIVED');
    }

    const publishedAt = new Date();
    const published = await this.repos.surveys.updateVersionStatus(
      version.id,
      survey.id,
      'published',
      publishedAt,
    );
    if (!published) {
      throw new AppError('Survey version not found.', 404, 'SURVEY_VERSION_NOT_FOUND');
    }

    const updatedSurvey = await this.repos.surveys.updateSurveyStatus(
      survey.id,
      businessId,
      'published',
      actorId,
    );
    if (!updatedSurvey) {
      throw new AppError('Survey not found.', 404, 'SURVEY_NOT_FOUND');
    }
    return published;
  }

  async pauseSurvey(businessId: string, surveyId: string, actorId: string): Promise<Survey> {
    const survey = await this.getSurvey(businessId, surveyId);
    if (survey.status === 'paused') return survey;
    if (survey.status !== 'published') {
      throw new AppError('Only published surveys can be paused.', 409, 'SURVEY_STATUS_CONFLICT');
    }

    const updated = await this.repos.surveys.updateSurveyStatus(
      survey.id,
      businessId,
      'paused',
      actorId,
    );
    if (!updated) throw new AppError('Survey not found.', 404, 'SURVEY_NOT_FOUND');
    return updated;
  }

  async closeSurvey(businessId: string, surveyId: string, actorId: string): Promise<Survey> {
    const survey = await this.getSurvey(businessId, surveyId);
    if (survey.status === 'closed') return survey;
    if (survey.status === 'archived') {
      throw new AppError('Archived surveys cannot be closed.', 409, 'SURVEY_STATUS_CONFLICT');
    }

    const updated = await this.repos.surveys.updateSurveyStatus(
      survey.id,
      businessId,
      'closed',
      actorId,
    );
    if (!updated) throw new AppError('Survey not found.', 404, 'SURVEY_NOT_FOUND');
    return updated;
  }

  async listCampaigns(businessId: string): Promise<SurveyCampaign[]> {
    return this.repos.surveys.listCampaignsForBusiness(businessId);
  }

  async createCampaign(
    businessId: string,
    input: CreateSurveyCampaignInput,
    actorId: string,
  ): Promise<SurveyCampaign> {
    const version = await this.repos.surveys.findVersionForBusiness(
      input.surveyVersionId,
      businessId,
    );
    if (!version) {
      throw new AppError('Survey version not found.', 404, 'SURVEY_VERSION_NOT_FOUND');
    }
    if (version.status !== 'published') {
      throw new AppError(
        'Only published survey versions can be used for campaigns.',
        409,
        'SURVEY_VERSION_NOT_PUBLISHED',
      );
    }

    const survey = await this.getSurvey(businessId, version.surveyId);
    if (survey.status === 'closed' || survey.status === 'archived') {
      throw new AppError(
        'Closed or archived surveys cannot receive new campaigns.',
        409,
        'SURVEY_NOT_EDITABLE',
      );
    }

    if (input.branchId && !(await this.repos.branches.findById(input.branchId, businessId))) {
      throw new AppError('Branch not found.', 404, 'BRANCH_NOT_FOUND');
    }

    return this.repos.surveys.createCampaign({
      surveyId: survey.id,
      surveyVersionId: version.id,
      businessId,
      branchId: input.branchId ?? null,
      name: input.name,
      status: 'draft',
      audienceClass: input.audienceClass,
      repeatPolicy: input.repeatPolicy,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      maxResponses: input.maxResponses ?? null,
      exposeInQrResolver: input.exposeInQrResolver,
      createdBy: actorId,
      updatedBy: actorId,
    });
  }

  async activateCampaign(
    businessId: string,
    campaignId: string,
    actorId: string,
  ): Promise<SurveyCampaign> {
    const campaign = await this.getCampaign(businessId, campaignId);
    if (campaign.status === 'active') return campaign;
    if (campaign.status === 'closed') {
      throw new AppError('Closed campaigns cannot be reactivated.', 409, 'SURVEY_CAMPAIGN_CLOSED');
    }

    const survey = await this.getSurvey(businessId, campaign.surveyId);
    if (survey.status !== 'published') {
      throw new AppError(
        'A campaign can only be activated while its survey is published.',
        409,
        'SURVEY_NOT_PUBLISHED',
      );
    }

    const version = await this.repos.surveys.findVersionForBusiness(
      campaign.surveyVersionId,
      businessId,
    );
    if (!version || version.status !== 'published') {
      throw new AppError(
        'A campaign requires a published survey version.',
        409,
        'SURVEY_VERSION_NOT_PUBLISHED',
      );
    }

    const updated = await this.repos.surveys.updateCampaignStatus(
      campaign.id,
      businessId,
      'active',
      actorId,
    );
    if (!updated) throw new AppError('Survey campaign not found.', 404, 'SURVEY_CAMPAIGN_NOT_FOUND');
    return updated;
  }

  async pauseCampaign(
    businessId: string,
    campaignId: string,
    actorId: string,
  ): Promise<SurveyCampaign> {
    const campaign = await this.getCampaign(businessId, campaignId);
    if (campaign.status === 'paused') return campaign;
    if (campaign.status !== 'active') {
      throw new AppError('Only active campaigns can be paused.', 409, 'SURVEY_CAMPAIGN_STATUS_CONFLICT');
    }

    const updated = await this.repos.surveys.updateCampaignStatus(
      campaign.id,
      businessId,
      'paused',
      actorId,
    );
    if (!updated) throw new AppError('Survey campaign not found.', 404, 'SURVEY_CAMPAIGN_NOT_FOUND');
    return updated;
  }

  async closeCampaign(
    businessId: string,
    campaignId: string,
    actorId: string,
  ): Promise<SurveyCampaign> {
    const campaign = await this.getCampaign(businessId, campaignId);
    if (campaign.status === 'closed') return campaign;

    const updated = await this.repos.surveys.updateCampaignStatus(
      campaign.id,
      businessId,
      'closed',
      actorId,
    );
    if (!updated) throw new AppError('Survey campaign not found.', 404, 'SURVEY_CAMPAIGN_NOT_FOUND');
    return updated;
  }

  private async getCampaign(businessId: string, campaignId: string): Promise<SurveyCampaign> {
    const campaign = await this.repos.surveys.findCampaignForBusiness(campaignId, businessId);
    if (!campaign) {
      throw new AppError('Survey campaign not found.', 404, 'SURVEY_CAMPAIGN_NOT_FOUND');
    }
    return campaign;
  }
}
