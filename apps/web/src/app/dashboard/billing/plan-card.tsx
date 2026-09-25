'use client';

import { useActionState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import type { SubscriptionPlanDto } from '@echo-grid-feedback/shared-types';
import { createCheckoutSessionAction, type BillingActionState } from '@/lib/actions/billing';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui';

const initialState: BillingActionState = {};

interface PlanCardProps {
  plan: SubscriptionPlanDto;
  isCurrent: boolean;
}

/** The catalog has stable plan keys, but an edited/custom plan must retain
 * its actual name and description rather than display stale seed copy. */
function usePlanCopy(plan: SubscriptionPlanDto) {
  const t = useTranslations('dashboard.billing.plans.catalog');
  switch (plan.key) {
    case 'starter':
      return {
        name: plan.name === 'Starter' ? t('starter.name') : plan.name,
        description:
          plan.description === 'For a single location getting started with customer feedback.'
            ? t('starter.description')
            : plan.description,
      };
    case 'growth':
      return {
        name: plan.name === 'Growth' ? t('growth.name') : plan.name,
        description:
          plan.description === 'For multi-location businesses that need AI-powered insights.'
            ? t('growth.description')
            : plan.description,
      };
    case 'enterprise':
      return {
        name: plan.name === 'Enterprise' ? t('enterprise.name') : plan.name,
        description:
          plan.description === 'Unlimited branches and team members, with custom branding.'
            ? t('enterprise.description')
            : plan.description,
      };
    default:
      return { name: plan.name, description: plan.description };
  }
}

export function PlanTitle({ plan }: { plan: SubscriptionPlanDto }) {
  const { name } = usePlanCopy(plan);
  return <span dir="auto">{name}</span>;
}

/**
 * Two separate bound Server Actions (one per interval) rather than a single
 * form with an interval <select> -- each plan's monthly/yearly pricing is
 * both visible at once (no toggle needed to compare), and a plan with no
 * yearly price configured yet (billing.service.ts's PLAN_NOT_PURCHASABLE
 * guards this server-side too) simply omits that button rather than
 * offering a choice that would fail on submit.
 *
 * Client component (useActionState) -- same reason status-form.tsx/
 * impersonate-button.tsx are, the one client-side requirement being error
 * display without a full page reload on a failed checkout attempt.
 */
export function PlanCard({ plan, isCurrent }: PlanCardProps) {
  const t = useTranslations('dashboard.billing.plans');
  const locale = useLocale();
  const { name, description } = usePlanCopy(plan);

  const monthlyAction = createCheckoutSessionAction.bind(null, plan.id, 'month');
  const [monthlyState, monthlyFormAction, monthlyPending] = useActionState(
    monthlyAction,
    initialState,
  );

  const yearlyAction = createCheckoutSessionAction.bind(null, plan.id, 'year');
  const [yearlyState, yearlyFormAction, yearlyPending] = useActionState(yearlyAction, initialState);

  const formatPrice = (cents: number) =>
    new Intl.NumberFormat(locale === 'ar' ? 'en-US' : locale, {
      style: 'currency',
      currency: plan.currency.toUpperCase(),
      currencyDisplay: locale === 'ar' ? 'code' : 'symbol',
    }).format(cents / 100);

  return (
    <Card className={isCurrent ? 'border-brand-500 ring-1 ring-brand-500' : undefined}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>
            <span dir="auto">{name}</span>
          </CardTitle>
          {isCurrent && <Badge variant="brand">{t('currentPlan')}</Badge>}
        </div>
        {description && <CardDescription dir="auto">{description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-2xl font-semibold text-neutral-900">
          <bdi dir="ltr">{formatPrice(plan.priceMonthlyCents)}</bdi>
          <span className="text-sm font-normal text-neutral-500">/{t('perMonth')}</span>
        </p>
        <ul className="flex flex-col gap-1 text-sm text-neutral-600">
          <li>
            {plan.maxBranches === null
              ? t('unlimitedBranches')
              : t('limitedBranches', { count: plan.maxBranches })}
          </li>
          <li>
            {plan.maxUsers === null
              ? t('unlimitedUsers')
              : t('limitedUsers', { count: plan.maxUsers })}
          </li>
        </ul>
      </CardContent>
      {!isCurrent && (
        <CardFooter className="flex flex-col items-stretch gap-2">
          <form action={monthlyFormAction}>
            <Button type="submit" disabled={monthlyPending} className="w-full">
              {monthlyPending ? t('starting') : t('subscribeMonthly')}
            </Button>
          </form>
          {plan.priceYearlyCents !== null && (
            <form action={yearlyFormAction}>
              <Button type="submit" variant="outline" disabled={yearlyPending} className="w-full">
                {yearlyPending ? (
                  t('starting')
                ) : (
                  <>
                    {t('subscribeYearly')} (
                    <bdi dir="ltr">{formatPrice(plan.priceYearlyCents)}</bdi>)
                  </>
                )}
              </Button>
            </form>
          )}
          {(monthlyState.error || yearlyState.error) && (
            <p role="alert" className="text-sm text-danger">
              {monthlyState.error ?? yearlyState.error}
            </p>
          )}
        </CardFooter>
      )}
    </Card>
  );
}
