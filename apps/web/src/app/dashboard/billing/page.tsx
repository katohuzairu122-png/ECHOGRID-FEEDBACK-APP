import { redirect } from 'next/navigation';
import { getTranslations, getFormatter } from 'next-intl/server';
import type { BusinessSubscriptionWithPlanDto, SubscriptionPlanDto } from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import { PlanCard } from './plan-card';
import { ManageBillingButton } from './manage-billing-button';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import type { BadgeProps } from '@/components/ui';

const STATUS_BADGE_VARIANT: Record<BusinessSubscriptionWithPlanDto['status'], NonNullable<BadgeProps['variant']>> = {
  trialing: 'accent',
  active: 'success',
  past_due: 'warning',
  incomplete: 'warning',
  canceled: 'neutral',
  incomplete_expired: 'danger',
  unpaid: 'danger',
};

export default async function BillingPage() {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');

  const [t, format, subscription, plans] = await Promise.all([
    getTranslations('dashboard.billing'),
    getFormatter(),
    apiFetch<BusinessSubscriptionWithPlanDto | null>('/billing/subscription', { businessId: business.id }),
    apiFetch<SubscriptionPlanDto[]>('/billing/plans', { businessId: business.id }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
        <p className="text-sm text-neutral-500">{business.name}</p>
      </div>

      {subscription && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>{subscription.plan.name}</CardTitle>
              <Badge variant={STATUS_BADGE_VARIANT[subscription.status]}>
                {t(`status.${subscription.status}`)}
              </Badge>
            </div>
            <CardDescription>
              {subscription.status === 'trialing' && subscription.trialEndsAt
                ? t('trialEndsOn', { date: format.dateTime(new Date(subscription.trialEndsAt), 'short') })
                : subscription.cancelAtPeriodEnd && subscription.currentPeriodEnd
                  ? t('cancelsOn', { date: format.dateTime(new Date(subscription.currentPeriodEnd), 'short') })
                  : subscription.currentPeriodEnd
                    ? t('renewsOn', { date: format.dateTime(new Date(subscription.currentPeriodEnd), 'short') })
                    : null}
            </CardDescription>
          </CardHeader>
          {subscription.hasPaymentAccount && (
            <CardContent>
              <ManageBillingButton />
            </CardContent>
          )}
        </Card>
      )}

      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold text-neutral-900">{t('plansTitle')}</h2>
          <p className="text-sm text-neutral-500">{t('plansDescription')}</p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => (
            <PlanCard key={plan.id} plan={plan} isCurrent={subscription?.planId === plan.id} />
          ))}
        </div>
      </div>
    </div>
  );
}
