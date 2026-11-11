import type {
  SurveyAudienceClass,
  SurveyCampaignStatus,
  SurveyParticipationSource,
  SurveyParticipationStatus,
  SurveyQuestionDto,
  SurveyRepeatPolicy,
} from '@echo-grid-feedback/shared-types';

/**
 * Shapes of the EXISTING customer survey endpoints (apps/api/src/surveys/survey-customer.routes.ts).
 * Mirrored read-only; no endpoint was added.
 * GET  /surveys/me/participations
 * GET  /surveys/me/campaigns/:id
 * POST /surveys/me/campaigns/:id/start   POST .../submit
 */
export interface SurveyParticipationDto {
  id: string;
  surveyId: string;
  surveyVersionId: string;
  campaignId: string;
  businessId: string | null;
  branchId: string | null;
  status: SurveyParticipationStatus;
  source: SurveyParticipationSource;
  startedAt: string;
  submittedAt: string | null;
  completedAt: string | null;
  invalidatedAt: string | null;
}

export interface SurveyCampaignDetailDto {
  campaign: {
    id: string;
    businessId: string | null;
    name: string;
    status: SurveyCampaignStatus;
    audienceClass: SurveyAudienceClass;
    repeatPolicy: SurveyRepeatPolicy;
    startsAt: string | null;
    endsAt: string | null;
  };
  version: {
    id: string;
    title: string;
    description: string | null;
    questions: SurveyQuestionDto[];
  };
}

export type SurveysSection<T> =
  | { status: 'ready'; data: T }
  | { status: 'forbidden' }
  | { status: 'unavailable' };

export interface SurveysHubData {
  participations: SurveysSection<{ items: SurveyParticipationRow[]; offset: number; hasMore: boolean }>;
}

export interface SurveyParticipationRow extends SurveyParticipationDto {
  businessName: string | null;
}

export type SurveySubmitFailure = 'forbidden' | 'closed' | 'invalid' | 'unavailable';
export interface SurveySubmitState {
  status: 'idle' | 'success' | 'error';
  failure?: SurveySubmitFailure;
}

/** Answer values accepted by the API (surveyAnswerValueSchema). */
export type SurveyAnswerValue = string | number | boolean | string[];
