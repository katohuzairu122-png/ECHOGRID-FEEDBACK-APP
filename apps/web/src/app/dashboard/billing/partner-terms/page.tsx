import { redirect } from 'next/navigation';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import { classifyReadFailure } from '@/lib/read-failure';
import { PartnerTermsView, type PartnerTermsData, type PartnerTermsDto } from './partner-terms-view';

/**
 * Business Partner Program terms (P1, read-only). Uses the existing GET /partner-credits/consent/terms
 * (business-wide billing:manage). No accept or enroll action is exposed; there is no enrollment-status read
 * endpoint, so none is shown.
 */
export default async function PartnerTermsPage() {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');

  let result: PartnerTermsData;
  try {
    const data = await apiFetch<PartnerTermsDto>('/partner-credits/consent/terms', {
      businessId: business.id,
      cache: 'no-store',
    });
    result = { status: 'ready', data };
  } catch (error) {
    const failure = classifyReadFailure(error);
    if (failure === 'login') redirect('/login');
    result = { status: failure === 'forbidden' ? 'forbidden' : 'unavailable' };
  }
  return <PartnerTermsView result={result} />;
}
