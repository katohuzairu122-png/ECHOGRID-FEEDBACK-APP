import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActiveBusiness } from '@/lib/business';
import { reversalGate } from '@/lib/workspace-guard';
import { apiFetch } from '@/lib/api-client';
import { ApiError } from '@/lib/api-error';
import type { PurchaseDto, ReversalPreviewDto } from '@/lib/loyalty-purchases';
import { LoyaltySubnav } from '../../loyalty-subnav';
import { ReversalPanel } from '@/components/loyalty-purchases/reversal-panel';

/** Loyalty > Purchases > one purchase (LPC-10): its details, the exact impact of reversing it, the reason and confirmation, and the result. */
export default async function PurchaseReversalPage({ params }: { params: Promise<{ id: string }> }) {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  const blocked = await reversalGate();
  if (blocked) return blocked;

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let purchase: PurchaseDto;
  try {
    purchase = await apiFetch<PurchaseDto>(`/loyalty/purchases/${id}`, { businessId: business.id });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  let preview: ReversalPreviewDto | null = null;
  let previewError: 'ALREADY_REVERSED' | 'UNAVAILABLE' | undefined;
  if (purchase.status === 'confirmed') {
    try {
      preview = await apiFetch<ReversalPreviewDto>(`/loyalty/purchases/${id}/reversal-preview`, { businessId: business.id });
    } catch (error) {
      previewError = error instanceof ApiError && error.code === 'PURCHASE_ALREADY_REVERSED' ? 'ALREADY_REVERSED' : 'UNAVAILABLE';
    }
  }
  const t = await getTranslations('loyalty.purchases');
  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm text-neutral-500">{business.name}</p>
        <h1 className="text-2xl font-semibold text-neutral-900">{t('reverseTitle')}</h1>
        <Link className="text-sm text-brand-700 hover:underline" href="/dashboard/loyalty/purchases">{t('back')}</Link>
      </header>
      <LoyaltySubnav />
      <ReversalPanel purchase={purchase} currency={business.defaultCurrency} preview={preview} previewError={previewError} />
    </div>
  );
}
