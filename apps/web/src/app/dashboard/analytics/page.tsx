import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type {
  BranchDto,
  FeedbackSummaryDto,
  SentimentTrendPointDto,
} from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import { BranchFilter } from './branch-filter';
import { SummaryGenerator } from './summary-generator';
import { SummariesList } from './summaries-list';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  SentimentTrendChart,
} from '@/components/ui';

interface AnalyticsPageProps {
  searchParams: Promise<{ branchId?: string }>;
}

/**
 * Sentiment Analytics module's dashboard UI (the module's own "Block 5" per
 * comments already in feedback.ts/analytics.ts -- schema, classification,
 * summary generation, and this read-side API were already built; only the
 * UI was missing). Covers the trend overview and the AI summaries panel;
 * the searchable feedback explorer lives at its own /search sub-route
 * (see search/page.tsx for why it's separate rather than a third stacked
 * section here).
 */
export default async function AnalyticsPage({ searchParams }: AnalyticsPageProps) {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');

  const { branchId } = await searchParams;
  // i18n & Multi-Currency Block 7.
  const t = await getTranslations('analytics.page');
  // Shared by both queries below -- trend and summaries agree on scope
  // (business-wide vs. one branch), consistent with FeedbackSummaryRepository
  // treating those as two distinct report types that are never mixed.
  const query = new URLSearchParams(branchId ? { branchId } : {});

  const [branches, trend, summaries] = await Promise.all([
    apiFetch<BranchDto[]>('/branches', { businessId: business.id }),
    apiFetch<SentimentTrendPointDto[]>(`/analytics/trends?${query}`, { businessId: business.id }),
    apiFetch<FeedbackSummaryDto[]>(`/analytics/summaries?${query}`, { businessId: business.id }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
          <p className="text-sm text-neutral-500">{business.name}</p>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href={branchId ? `/dashboard/analytics/search?branchId=${branchId}` : '/dashboard/analytics/search'}
            className="text-sm font-medium text-brand-600 hover:underline"
          >
            {t('searchFeedback')}
          </Link>
          <BranchFilter branches={branches} selectedBranchId={branchId} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('trendTitle')}</CardTitle>
          <CardDescription>{t('trendDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <SentimentTrendChart points={trend} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('summariesTitle')}</CardTitle>
          <CardDescription>{t('summariesDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <SummaryGenerator branchId={branchId} />
          <SummariesList summaries={summaries} />
        </CardContent>
      </Card>
    </div>
  );
}
