import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';
import { getMyAccess } from '@/lib/permissions';
import { classifyReadFailure } from '@/lib/read-failure';
import { RestrictedPanel } from '@/components/workspace/restricted-panel';
import type { InvitationListDto } from '@/lib/customer-invitations-types';
import { InvitationsView } from './invitations-view';

/**
 * OWNER-INVITE-01: customer invitations, INSIDE the owner-facing Cashier App (not a separate top-level entry, and never on the cashier
 * interface). Visible only with `cashier:manage` (Owner and Admin by default). Presentation only: the API authorises every read and write again.
 */
export default async function CustomerInvitationsPage() {
  const t = await getTranslations('cashier.dashboard.invitations');
  const access = await getMyAccess();
  if (!access.known) return <RestrictedPanel variant="unavailable" />;
  if (!access.permissions.has('cashier:manage')) {
    return <section className="mx-auto max-w-3xl px-4 py-8"><p className="rounded-md border border-neutral-200 bg-white p-4 text-sm">{t('noAccess')}</p></section>;
  }
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  try {
    const [list, branches] = await Promise.all([
      apiFetch<InvitationListDto>('/customer-invitations', { businessId: business.id, cache: 'no-store' }),
      apiFetch<{ id: string; name: string }[]>('/branches', { businessId: business.id, cache: 'no-store' }),
    ]);
    return <InvitationsView list={list} branches={branches.map((b) => ({ id: b.id, name: b.name }))} />;
  } catch (error) {
    const failure = classifyReadFailure(error);
    if (failure === 'login') redirect('/login');
    return <section className="mx-auto max-w-3xl px-4 py-8"><p className="text-sm text-red-700">{failure === 'forbidden' ? t('noAccess') : t('loadFailed')}</p></section>;
  }
}
