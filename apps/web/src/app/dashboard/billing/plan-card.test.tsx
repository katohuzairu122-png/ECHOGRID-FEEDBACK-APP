import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { SubscriptionPlanDto } from '@echo-grid-feedback/shared-types';
import arDashboard from '../../../../messages/ar/dashboard.json';
import { PlanCard } from './plan-card';

vi.mock('@/lib/actions/billing', () => ({ createCheckoutSessionAction: vi.fn() }));

const starter: SubscriptionPlanDto = {
  id: '00000000-0000-4000-8000-000000000001',
  key: 'starter',
  name: 'Starter',
  description: 'For one location ready to collect feedback every day.',
  priceMonthlyCents: 900,
  priceYearlyCents: 9000,
  currency: 'usd',
  maxBranches: 1,
  maxUsers: 3,
  features: { monthlyResponses: 1000 },
  sortOrder: 1,
};

function renderArabic(plan: SubscriptionPlanDto) {
  return render(
    <NextIntlClientProvider locale="ar" messages={{ dashboard: arDashboard }}>
      <div dir="rtl">
        <PlanCard plan={plan} isCurrent={false} />
      </div>
    </NextIntlClientProvider>,
  );
}

describe('PlanCard Arabic display', () => {
  it('translates the affordable catalog and displays its response allowance', () => {
    renderArabic(starter);

    expect(screen.getByText('الانطلاق')).toBeInTheDocument();
    expect(screen.getByText('لموقع واحد جاهز لجمع ملاحظات العملاء يوميًا.')).toBeInTheDocument();
    expect(screen.getByText('1000 استجابة شهريًا')).toBeInTheDocument();
    expect(screen.getByText(/USD\s*9\.00/)).toHaveAttribute('dir', 'ltr');
    expect(screen.getByRole('button', { name: /USD\s*90\.00/ })).toBeInTheDocument();
  });

  it('preserves edited catalog content instead of showing stale seed translations', () => {
    renderArabic({ ...starter, name: 'Custom Starter', description: 'Custom description' });

    expect(screen.getByText('Custom Starter')).toBeInTheDocument();
    expect(screen.getByText('Custom description')).toBeInTheDocument();
    expect(screen.queryByText('الانطلاق')).not.toBeInTheDocument();
  });
});
