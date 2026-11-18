import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';
import { getMyAccess } from '@/lib/permissions';
import { classifyReadFailure } from '@/lib/read-failure';
import { RestrictedPanel } from '@/components/workspace/restricted-panel';
import type { CashierAccountDto, CashierBranchOption, CashierBusinessCodeDto } from '@/lib/cashier-accounts-types';
import { CashierAccountsView } from './cashier-accounts-view';

/**
 * CASHIER-AUTH-02B: Owner and Admin management of business-managed cashier accounts. Visible only with `cashier:manage`
 * (Owner and Admin by default; a Manager only if the Owner granted it). Presentation only: every call below and every action
 * is authorised again by the API, which also demands a fresh administrator password for each change.
 */
export default async function CashierAccountsPage() {
  const t = await getTranslations('cashier.dashboard.accounts');
  const access = await getMyAccess();
  if (!access.known) return <RestrictedPanel variant="unavailable" />;
  if (!access.permissions.has('cashier:manage')) {
    return (
      <section className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-md border border-neutral-200 bg-white p-4 text-sm">{t('noAccess')}</p>
      </section>
    );
  }
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');

  try {
    const [accounts, code, branches] = await Promise.all([
      apiFetch<CashierAccountDto[]>('/cashier-accounts', { businessId: business.id, cache: 'no-store' }),
      apiFetch<CashierBusinessCodeDto>('/cashier-accounts/business-code', { businessId: business.id, cache: 'no-store' }),
      apiFetch<CashierBranchOption[]>('/branches', { businessId: business.id, cache: 'no-store' }),
    ]);
    return (
      <CashierAccountsView
        accounts={accounts}
        code={code}
        branches={branches.map((b) => ({ id: b.id, name: b.name }))}
      />
    );
  } catch (error) {
    const failure = classifyReadFailure(error);
    if (failure === 'login') redirect('/login');
    return (
      <section className="mx-auto max-w-3xl px-4 py-8">
        <p className="text-sm text-red-700">{failure === 'forbidden' ? t('noAccess') : t('loadFailed')}</p>
      </section>
    );
  }
}
