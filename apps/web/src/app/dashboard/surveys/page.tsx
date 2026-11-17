import { redirect } from 'next/navigation';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import { classifyReadFailure } from '@/lib/read-failure';
import type {
  BusinessSurveyCampaignDto,
  BusinessSurveyDto,
  BusinessSurveysResult,
} from '@/lib/business-surveys-types';
import { BusinessSurveysView } from './surveys-view';

/**
 * Business survey hosting (S1, read-only). Lists the signed-in business's own surveys and campaigns through the
 * existing staff routes (survey:view). Nothing is created, activated, paused or closed here, and no responses or
 * other business's data are read. A failure is never shown as an empty list.
 */
export default async function BusinessSurveysPage() {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');

  let result: BusinessSurveysResult;
  try {
    const [surveys, campaigns] = await Promise.all([
      apiFetch<BusinessSurveyDto[]>('/surveys', { businessId: business.id, cache: 'no-store' }),
      apiFetch<BusinessSurveyCampaignDto[]>('/surveys/campaigns', {
        businessId: business.id,
        cache: 'no-store',
      }),
    ]);
    result = { status: 'ready', data: { surveys, campaigns } };
  } catch (error) {
    const failure = classifyReadFailure(error);
    if (failure === 'login') redirect('/login');
    result = { status: failure === 'forbidden' ? 'forbidden' : 'unavailable' };
  }
  return <BusinessSurveysView result={result} />;
}
