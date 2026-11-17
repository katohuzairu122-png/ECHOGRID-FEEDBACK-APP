/**
 * Business survey hosting (S1, read-only). Mirrors the rows the staff routes GET /surveys and GET /surveys/campaigns
 * return for the caller's own business only. Presentation-only fields; no response data and no customer identity.
 */
export type BusinessSurveyStatus = 'draft' | 'published' | 'paused' | 'closed' | 'archived';
export type BusinessCampaignStatus = 'draft' | 'active' | 'paused' | 'closed';

export interface BusinessSurveyDto {
  id: string;
  name: string;
  status: BusinessSurveyStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessSurveyCampaignDto {
  id: string;
  surveyId: string;
  name: string;
  status: BusinessCampaignStatus;
  startsAt: string | null;
  endsAt: string | null;
  maxResponses: number | null;
}

export interface BusinessSurveysData {
  surveys: BusinessSurveyDto[];
  campaigns: BusinessSurveyCampaignDto[];
}

export type BusinessSurveysResult =
  | { status: 'ready'; data: BusinessSurveysData }
  | { status: 'forbidden' }
  | { status: 'unavailable' };
