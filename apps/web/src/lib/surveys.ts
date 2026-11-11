import 'server-only';
import type { BusinessPublicDto } from '@echo-grid-feedback/shared-types';
import { ApiError } from './api-error';
import { customerApiFetch } from './customer-api-client';
import { publicApiFetch } from './public-api-client';
import { rethrowControlFlow } from './rethrow-control-flow';
import type {
  SurveyCampaignDetailDto,
  SurveyParticipationDto,
  SurveyParticipationRow,
  SurveysHubData,
} from './surveys-types';

export const SURVEYS_PAGE_SIZE = 20;
const MAX_BUSINESS_LOOKUPS = 10;

/** Business names for display only; a failed lookup just leaves the name out. */
async function businessNames(ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  await Promise.all(
    ids.slice(0, MAX_BUSINESS_LOOKUPS).map(async (id) => {
      try {
        const business = await publicApiFetch<BusinessPublicDto>(`/businesses/${id}/public`);
        names.set(id, business.name);
      } catch {
        // Name is optional context.
      }
    }),
  );
  return names;
}

/**
 * The customer's own survey history (existing GET /surveys/me/participations). A failure is reported as
 * forbidden/unavailable, never as an empty list. The endpoint has no total count, so one extra row is
 * requested to know whether an older page exists.
 */
export async function getSurveysHub(offset = 0): Promise<SurveysHubData> {
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  try {
    const rows = await customerApiFetch<SurveyParticipationDto[]>(
      `/surveys/me/participations?limit=${SURVEYS_PAGE_SIZE + 1}&offset=${safeOffset}`,
      { cache: 'no-store' },
    );
    const page = rows.slice(0, SURVEYS_PAGE_SIZE);
    const names = await businessNames([
      ...new Set(page.map((row) => row.businessId).filter((id): id is string => Boolean(id))),
    ]);
    const items: SurveyParticipationRow[] = page.map((row) => ({
      ...row,
      businessName: row.businessId ? (names.get(row.businessId) ?? null) : null,
    }));
    return {
      participations: {
        status: 'ready',
        data: { items, offset: safeOffset, hasMore: rows.length > SURVEYS_PAGE_SIZE },
      },
    };
  } catch (error) {
    rethrowControlFlow(error);
    return {
      participations: {
        status: error instanceof ApiError && error.status === 403 ? 'forbidden' : 'unavailable',
      },
    };
  }
}

export type CampaignLoad =
  | { status: 'ready'; data: SurveyCampaignDetailDto }
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'unavailable' };

/** One campaign the customer may take (existing GET /surveys/me/campaigns/:id). */
export async function getSurveyCampaign(campaignId: string): Promise<CampaignLoad> {
  try {
    const data = await customerApiFetch<SurveyCampaignDetailDto>(
      `/surveys/me/campaigns/${encodeURIComponent(campaignId)}`,
      { cache: 'no-store' },
    );
    return { status: 'ready', data };
  } catch (error) {
    rethrowControlFlow(error);
    if (error instanceof ApiError && error.status === 404) return { status: 'not_found' };
    if (error instanceof ApiError && error.status === 403) return { status: 'forbidden' };
    return { status: 'unavailable' };
  }
}
