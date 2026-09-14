import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { sentimentPolarity } from '@echo-grid-feedback/shared-types';
import type { BranchDto, FeedbackDto, SentimentPolarity } from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import { SearchFilters } from './search-filters';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  StarDisplay,
} from '@/components/ui';

const PAGE_SIZE = 20;
const DAY_MS = 86_400_000;

interface SearchPageProps {
  searchParams: Promise<{
    branchId?: string;
    sentiment?: string;
    rating?: string;
    keyword?: string;
    range?: string;
    offset?: string;
  }>;
}

/**
 * Badge styling per sentiment BUCKET, not per stored value (audit P2-1).
 *
 * The previous version compared `sentiment` directly against 'positive' /
 * 'negative' under a comment asserting it was "a closed 3-value enum". That
 * stopped being true when Automated Feedback Sorting widened the scale to
 * five: FeedbackDto.sentiment is `sentimentSchema.nullable()`, i.e. the full
 * six-member union. So a 5-star rave stored as 'very_positive' fell through
 * to 'neutral' and rendered grey -- and, worse, the label key was passed to
 * t() verbatim, and analytics.json's search block has only positive/
 * neutral/negative, so the badge showed a missing-translation error rather
 * than a word.
 *
 * Keyed by SentimentPolarity so those three keys and these three variants
 * are the same three things by construction, and 'unknown'/unclassified
 * rows render no badge at all rather than a defaulted one.
 */
const SENTIMENT_BADGE_VARIANT: Record<SentimentPolarity, 'success' | 'danger' | 'neutral'> = {
  positive: 'success',
  negative: 'danger',
  neutral: 'neutral',
};

/**
 * A separate page from /dashboard/analytics (not a third stacked section
 * there), on purpose: analytics:view is a genuinely different permission
 * from feedback:manage, and this is a read-only exploration view -- no
 * Mark reviewed/Delete actions, unlike the feedback inbox, since a user
 * with only analytics:view may not hold feedback:manage at all and
 * showing action buttons that would just 403 on click would be broken UX.
 * Reuses the "fetch limit+1, Older/Newer" pagination trick already
 * established in dashboard/feedback/page.tsx -- FeedbackRepository.search
 * has no total-count query either.
 */
export default async function SearchPage({ searchParams }: SearchPageProps) {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');

  // i18n & Multi-Currency Block 3 -- see dashboard/feedback/page.tsx's
  // identical comment.
  const format = await getFormatter();
  // i18n & Multi-Currency Block 7.
  const t = await getTranslations('analytics.search');

  const { branchId, sentiment, rating, keyword, range, offset: offsetParam } = await searchParams;
  const offset = Number(offsetParam) || 0;
  const days = Number(range) || 30;
  const from = new Date(Date.now() - days * DAY_MS).toISOString();

  const searchQuery = new URLSearchParams({
    ...(branchId ? { branchId } : {}),
    ...(sentiment ? { sentiment } : {}),
    ...(rating ? { rating } : {}),
    ...(keyword ? { keyword } : {}),
    from,
    limit: String(PAGE_SIZE + 1),
    offset: String(offset),
  });

  const [branches, page] = await Promise.all([
    apiFetch<BranchDto[]>('/branches', { businessId: business.id }),
    apiFetch<FeedbackDto[]>(`/analytics/search?${searchQuery}`, { businessId: business.id }),
  ]);

  const hasMore = page.length > PAGE_SIZE;
  const items = page.slice(0, PAGE_SIZE);
  const branchNames = new Map(branches.map((b) => [b.id, b.name]));

  const pageHref = (nextOffset: number) =>
    `/dashboard/analytics/search?${new URLSearchParams({
      ...(branchId ? { branchId } : {}),
      ...(sentiment ? { sentiment } : {}),
      ...(rating ? { rating } : {}),
      ...(keyword ? { keyword } : {}),
      ...(range ? { range } : {}),
      offset: String(nextOffset),
    })}`;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/dashboard/analytics" className="text-sm font-medium text-brand-700 hover:underline">
          {t('backToOverview')}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-neutral-900">{t('title')}</h1>
        <p className="text-sm text-neutral-500">{business.name}</p>
      </div>

      <Card>
        <CardContent className="py-4">
          <SearchFilters
            branches={branches}
            branchId={branchId}
            sentiment={sentiment}
            rating={rating}
            keyword={keyword}
            range={range}
          />
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
        <div className="flex flex-col gap-3">
          {items.map((item) => {
            // Resolved once per row: null covers not-yet-analyzed,
            // unclassified, and 'unknown' -- all of which mean "no bucket",
            // so no badge. The bucket name doubles as the analytics.json
            // message key, which is why t() can take it directly.
            const polarity =
              item.analysisStatus === 'completed' ? sentimentPolarity(item.sentiment) : null;

            return (
            <Card key={item.id}>
              <CardContent className="flex flex-col gap-3 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StarDisplay value={item.rating} />
                  {polarity && (
                    <Badge variant={SENTIMENT_BADGE_VARIANT[polarity]}>{t(polarity)}</Badge>
                  )}
                  <Badge variant={item.status === 'new' ? 'accent' : 'neutral'}>
                    {item.status === 'new' ? t('statusNew') : t('statusReviewed')}
                  </Badge>
                </div>
                <p className="text-xs text-neutral-500">
                  {branchNames.get(item.branchId) ?? t('unknownBranch')} ·{' '}
                  {format.dateTime(new Date(item.createdAt), 'short')}
                </p>
                {item.comment && <p className="text-sm text-neutral-800">{item.comment}</p>}
                {(item.customerName || item.customerEmail || item.customerPhone) && (
                  <p className="text-xs text-neutral-500">
                    {[item.customerName, item.customerEmail, item.customerPhone]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
              </CardContent>
            </Card>
            );
          })}
        </div>
      )}

      {(offset > 0 || hasMore) && (
        <div className="flex justify-center gap-4">
          {offset > 0 && (
            <Link
              href={pageHref(Math.max(0, offset - PAGE_SIZE))}
              className="text-sm font-medium text-brand-700 hover:underline"
            >
              {t('newer')}
            </Link>
          )}
          {hasMore && (
            <Link
              href={pageHref(offset + PAGE_SIZE)}
              className="text-sm font-medium text-brand-700 hover:underline"
            >
              {t('older')}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
