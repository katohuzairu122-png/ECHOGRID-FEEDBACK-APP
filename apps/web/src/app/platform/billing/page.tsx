import Link from 'next/link';
import { getTranslations, getFormatter } from 'next-intl/server';
import type { PlatformBusinessSubscriptionDto, PlatformMrrSummaryDto } from '@echo-grid-feedback/shared-types';
import { apiFetch } from '@/lib/api-client';
import { SubscriptionFilters } from './subscription-filters';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import type { BadgeProps } from '@/components/ui';

/** Same no-total-count pagination trick as every other list in this
 * console -- see platform/businesses/page.tsx's comment. */
const PAGE_SIZE = 30;

const STATUS_BADGE_VARIANT: Record<
  PlatformBusinessSubscriptionDto['status'],
  NonNullable<BadgeProps['variant']>
> = {
  trialing: 'accent',
  active: 'success',
  past_due: 'warning',
  incomplete: 'warning',
  canceled: 'neutral',
  incomplete_expired: 'danger',
  unpaid: 'danger',
};

interface PlatformBillingPageProps {
  searchParams: Promise<{ status?: string; offset?: string }>;
}

export default async function PlatformBillingPage({ searchParams }: PlatformBillingPageProps) {
  const { status, offset: offsetParam } = await searchParams;
  const offset = Number(offsetParam) || 0;

  const [t, format, mrr, page] = await Promise.all([
    getTranslations('platform.billing.subscriptions'),
    getFormatter(),
    apiFetch<PlatformMrrSummaryDto>('/platform/billing/subscriptions/mrr'),
    apiFetch<PlatformBusinessSubscriptionDto[]>(
      `/platform/billing/subscriptions?${new URLSearchParams({
        ...(status ? { status } : {}),
        limit: String(PAGE_SIZE + 1),
        offset: String(offset),
      })}`,
    ),
  ]);

  const hasMore = page.length > PAGE_SIZE;
  const items = page.slice(0, PAGE_SIZE);

  const pageHref = (nextOffset: number) =>
    `/platform/billing?${new URLSearchParams({
      ...(status ? { status } : {}),
      offset: String(nextOffset),
    })}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
          <p className="text-sm text-neutral-500">{t('description')}</p>
        </div>
        <Link href="/platform/billing/plans" className="text-sm font-medium text-brand-600 hover:underline">
          {t('managePlans')}
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {(mrr.mrrCents / 100).toLocaleString(undefined, {
              style: 'currency',
              currency: mrr.currency.toUpperCase(),
            })}
          </CardTitle>
          <CardDescription>{t('mrrLabel', { count: mrr.activeSubscriptionCount })}</CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardContent className="py-4">
          <SubscriptionFilters status={status} />
        </CardContent>
      </Card>

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('emptyTitle')}</CardTitle>
            <CardDescription>{t('emptyDescription')}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
          {items.map((subscription) => (
            <div key={subscription.id} className="flex flex-wrap items-center justify-between gap-2 px-6 py-4">
              <div>
                <Link
                  href={`/platform/businesses/${subscription.businessId}`}
                  className="font-medium text-brand-600 hover:underline"
                >
                  {subscription.businessName}
                </Link>
                <p className="text-sm text-neutral-500">
                  {subscription.planName}
                  {subscription.status === 'trialing' && subscription.trialEndsAt
                    ? ` · ${t('trialEndsOn', { date: format.dateTime(new Date(subscription.trialEndsAt), 'short') })}`
                    : subscription.currentPeriodEnd
                      ? ` · ${t('renewsOn', { date: format.dateTime(new Date(subscription.currentPeriodEnd), 'short') })}`
                      : ''}
                </p>
              </div>
              <Badge variant={STATUS_BADGE_VARIANT[subscription.status]}>
                {t(`status.${subscription.status}`)}
              </Badge>
            </div>
          ))}
        </div>
      )}

      {(offset > 0 || hasMore) && (
        <div className="flex justify-center gap-4">
          {offset > 0 && (
            <Link
              href={pageHref(Math.max(0, offset - PAGE_SIZE))}
              className="text-sm font-medium text-brand-600 hover:underline"
            >
              {t('newer')}
            </Link>
          )}
          {hasMore && (
            <Link
              href={pageHref(offset + PAGE_SIZE)}
              className="text-sm font-medium text-brand-600 hover:underline"
            >
              {t('older')}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
