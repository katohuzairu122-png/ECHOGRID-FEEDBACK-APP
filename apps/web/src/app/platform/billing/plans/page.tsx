import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { PlatformSubscriptionPlanDto } from '@echo-grid-feedback/shared-types';
import { apiFetch } from '@/lib/api-client';
import { getCurrentUser } from '@/lib/platform';
import { PlanFormDialog } from './plan-form-dialog';
import { Badge, Button, Card, CardContent } from '@/components/ui';

export default async function PlatformBillingPlansPage() {
  const [t, user, plans] = await Promise.all([
    getTranslations('platform.billing.plans'),
    getCurrentUser(),
    apiFetch<PlatformSubscriptionPlanDto[]>('/platform/billing/plans'),
  ]);

  // Mutation routes are billing/admin only server-side (billing-plans.routes.ts)
  // -- this only decides whether to show a control that would otherwise 403,
  // same convention as StatusForm/ImpersonateButton throughout this console.
  const canManage = user?.platformRole === 'billing' || user?.platformRole === 'admin';

  return (
    <div className="flex flex-col gap-6">
      <Link href="/platform/billing" className="text-sm font-medium text-brand-700 hover:underline">
        {t('backToBilling')}
      </Link>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
          <p className="text-sm text-neutral-500">{t('description')}</p>
        </div>
        {canManage && (
          <PlanFormDialog trigger={<Button type="button">{t('newButton')}</Button>} />
        )}
      </div>

      <div className="flex flex-col gap-3">
        {plans.map((plan) => (
          <Card key={plan.id}>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-medium text-neutral-900">{plan.name}</p>
                  <Badge variant="neutral">{plan.key}</Badge>
                  {plan.isDefaultTrial && <Badge variant="accent">{t('defaultTrialBadge')}</Badge>}
                  {!plan.isActive && <Badge variant="warning">{t('inactiveBadge')}</Badge>}
                </div>
                <p className="text-sm text-neutral-500">
                  {(plan.priceMonthlyCents / 100).toLocaleString(undefined, {
                    style: 'currency',
                    currency: plan.currency.toUpperCase(),
                  })}
                  /{t('perMonth')}
                  {plan.priceYearlyCents != null &&
                    ` · ${(plan.priceYearlyCents / 100).toLocaleString(undefined, {
                      style: 'currency',
                      currency: plan.currency.toUpperCase(),
                    })}/${t('perYear')}`}
                  {!plan.stripePriceIdMonthly && ` · ${t('noStripePriceWarning')}`}
                </p>
              </div>
              {canManage && (
                <PlanFormDialog
                  plan={plan}
                  trigger={
                    <Button type="button" variant="outline" size="sm">
                      {t('editButton')}
                    </Button>
                  }
                />
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
