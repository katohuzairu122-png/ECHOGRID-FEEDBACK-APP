import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActiveBusiness } from '@/lib/business';
import { reversalGate } from '@/lib/workspace-guard';
import { apiFetch } from '@/lib/api-client';
import type { PurchaseListDto } from '@/lib/loyalty-purchases';
import { LoyaltySubnav } from '../loyalty-subnav';
import { PurchasesTable } from '@/components/loyalty-purchases/purchases-table';

/**
 * Loyalty > Purchases (LPC-10): the business's purchases, newest first, with a filter for confirmed or reversed ones (the reversal history). Owners
 * and managers holding loyalty:adjust only; a cashier has no route here and the API refuses the same requests.
 */
export default async function LoyaltyPurchasesPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  const blocked = await reversalGate();
  if (blocked) return blocked;

  const { status: statusParam, page: pageParam } = await searchParams;
  const status = statusParam === 'confirmed' || statusParam === 'reversed' ? statusParam : undefined;
  const page = Math.max(0, Number.parseInt(pageParam ?? '0', 10) || 0);
  const limit = 25;
  const query = new URLSearchParams({ limit: String(limit), offset: String(page * limit), ...(status ? { status } : {}) });
  const list = await apiFetch<PurchaseListDto>(`/loyalty/purchases?${query.toString()}`, { businessId: business.id });
  const t = await getTranslations('loyalty.purchases');
  const link = (extra: Record<string, string>) => `/dashboard/loyalty/purchases?${new URLSearchParams({ ...(status ? { status } : {}), ...extra }).toString()}`;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm text-neutral-500">{business.name}</p>
        <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
        <p className="text-sm text-neutral-600">{t('subtitle')}</p>
      </header>
      <LoyaltySubnav />
      <nav aria-label={t('filters.label')} className="flex gap-2 text-sm">
        <Link className={!status ? 'font-semibold text-brand-700' : 'text-brand-700 hover:underline'} href="/dashboard/loyalty/purchases">{t('filters.all')}</Link>
        <Link className={status === 'confirmed' ? 'font-semibold text-brand-700' : 'text-brand-700 hover:underline'} href={link({ status: 'confirmed' })}>{t('filters.confirmed')}</Link>
        <Link className={status === 'reversed' ? 'font-semibold text-brand-700' : 'text-brand-700 hover:underline'} href={link({ status: 'reversed' })}>{t('filters.reversed')}</Link>
      </nav>
      <PurchasesTable items={list.items} currency={business.defaultCurrency} />
      <div className="flex gap-4 text-sm">
        {page > 0 ? <Link className="text-brand-700 hover:underline" href={link({ page: String(page - 1) })}>{t('previous')}</Link> : null}
        {list.hasMore ? <Link className="text-brand-700 hover:underline" href={link({ page: String(page + 1) })}>{t('next')}</Link> : null}
      </div>
    </div>
  );
}
