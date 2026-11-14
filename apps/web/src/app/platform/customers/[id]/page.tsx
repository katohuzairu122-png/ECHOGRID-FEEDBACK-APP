import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { PlatformCustomerDetailDto } from '@echo-grid-feedback/shared-types';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getCurrentUser } from '@/lib/platform';
import { SanctionForm } from './sanction-form';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';

const STATUS_VARIANT: Record<
  PlatformCustomerDetailDto['status'],
  'success' | 'danger' | 'warning'
> = {
  active: 'success',
  suspended: 'warning',
  banned: 'danger',
};

export default async function PlatformCustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [t, format] = await Promise.all([getTranslations('platform.customers'), getFormatter()]);

  let customer: PlatformCustomerDetailDto;
  try {
    customer = await apiFetch<PlatformCustomerDetailDto>(`/platform/customers/${id}`);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }
  const user = await getCurrentUser();
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/platform/customers" className="text-sm text-brand-700 underline">
          {t('back')}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-neutral-900">{customer.maskedPhone}</h1>
        <p className="text-sm text-neutral-500">{t('detail.privacyNote')}</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>{t('detail.summary')}</CardTitle>
            <Badge variant={STATUS_VARIANT[customer.status]}>
              {t(`status.${customer.status}`)}
            </Badge>
          </div>
          {customer.suspendedUntil && (
            <CardDescription>
              {t('detail.until', { date: when(customer.suspendedUntil) })}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div>
            <p className="text-xs font-medium text-neutral-500">{t('detail.businesses')}</p>
            <p className="text-neutral-900">{customer.businessCount}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-neutral-500">{t('detail.warnings')}</p>
            <p className="text-neutral-900">{customer.warningCount}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-neutral-500">{t('detail.joined')}</p>
            <p className="text-neutral-900">{when(customer.joinedAt)}</p>
          </div>
        </CardContent>
      </Card>

      {user?.platformRole === 'admin' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('detail.actionTitle')}</CardTitle>
            <CardDescription>{t('detail.actionDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <SanctionForm customerId={customer.id} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('detail.history')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {customer.history.length === 0 && (
            <p className="text-neutral-500">{t('detail.noHistory')}</p>
          )}
          {customer.history.map((h) => (
            <div key={h.id} className="border-b border-neutral-100 pb-2 last:border-0">
              <p className="font-medium text-neutral-900">
                {t(`detail.form.${h.action}`)}{' '}
                <span className="font-normal text-neutral-500">{when(h.createdAt)}</span>
              </p>
              <p className="text-neutral-700">{h.reason}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
