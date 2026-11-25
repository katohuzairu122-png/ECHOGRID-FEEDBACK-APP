import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';
import { getMyAccess } from '@/lib/permissions';
import { classifyReadFailure } from '@/lib/read-failure';
import { RestrictedPanel } from '@/components/workspace/restricted-panel';
import type { BusinessClosureStatusDto } from '@/lib/business-closure-types';
import { ClosureView } from './closure-view';

/**
 * BIZ-CLOSE-01: the Owner's closure REQUEST. Visible only with `business:delete` (Owner by default; never Admin or Manager). Presentation
 * only: the API authorises every read and write again. Nothing is deleted or changed by this page, and closure itself is not available.
 */
export default async function BusinessClosurePage() {
  const t = await getTranslations('dashboard.closure');
  const access = await getMyAccess();
  if (!access.known) return <RestrictedPanel variant="unavailable" />;
  if (!access.permissions.has('business:delete')) {
    return <p className="rounded-md border border-neutral-200 bg-white p-4 text-sm">{t('noAccess')}</p>;
  }
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  try {
    const status = await apiFetch<BusinessClosureStatusDto>('/business-closure', { businessId: business.id, cache: 'no-store' });
    return <ClosureView businessName={business.name} status={status} />;
  } catch (error) {
    const failure = classifyReadFailure(error);
    if (failure === 'login') redirect('/login');
    return <p className="text-sm text-red-700">{failure === 'forbidden' ? t('noAccess') : t('loadFailed')}</p>;
  }
}
