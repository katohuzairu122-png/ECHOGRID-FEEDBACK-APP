import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { BranchDto, FeedbackDto } from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { getCurrentUser } from '@/lib/platform';
import { apiFetch } from '@/lib/api-client';
import { BranchFilter } from './branch-filter';
import { SavedViewTabs } from './saved-view-tabs';
import { FeedbackFilters } from './feedback-filters';
import { FeedbackInboxList } from './feedback-inbox-list';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui';

/**
 * UI-chosen page size, independent of the API's own default (50) -- fits
 * the "several cards per screen" reading pattern of this list better than
 * the API's own bulk-listing default. "Newer/Older" offset links, not
 * numbered pages: GET /feedback still has no total-count query (Automated
 * Feedback Sorting's listWithFilters explicitly avoids one, see
 * feedback.repository.ts) -- the API does the "fetch one extra, report
 * hasMore" trick itself now (feedback.routes.ts).
 */
const PAGE_SIZE = 20;

interface FeedbackPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Flattens Next's searchParams shape (string | string[] | undefined) down
 * to what URLSearchParams/the API filter query actually need. */
function toArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
function toSingle(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function FeedbackPage({ searchParams }: FeedbackPageProps) {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');

  // i18n & Multi-Currency Block 5.
  const t = await getTranslations('feedback.staff');

  const params = await searchParams;
  const branchId = toSingle(params.branchId);
  const savedView = toSingle(params.savedView);
  const search = toSingle(params.search);
  const category = toArray(params.category);
  const urgency = toArray(params.urgency);
  const offset = Number(toSingle(params.offset)) || 0;

  const feedbackQuery = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (branchId) feedbackQuery.set('branchId', branchId);
  if (savedView) feedbackQuery.set('savedView', savedView);
  if (search) feedbackQuery.set('search', search);
  category.forEach((c) => feedbackQuery.append('category', c));
  urgency.forEach((u) => feedbackQuery.append('urgency', u));

  const [branches, page, currentUser] = await Promise.all([
    apiFetch<BranchDto[]>('/branches', { businessId: business.id }),
    apiFetch<{ items: FeedbackDto[]; hasMore: boolean }>(`/feedback?${feedbackQuery}`, { businessId: business.id }),
    getCurrentUser(),
  ]);

  const { items, hasMore } = page;
  const branchNames = new Map(branches.map((b) => [b.id, b.name]));

  // Carried into SavedViewTabs/FeedbackFilters so switching a saved view or
  // submitting the filter form never silently drops the other active
  // filters -- every param EXCEPT offset (a new filter/view always starts
  // back at page 1) survives into the base for the next navigation.
  const baseParams: Record<string, string> = {};
  if (branchId) baseParams.branchId = branchId;
  if (savedView) baseParams.savedView = savedView;
  if (search) baseParams.search = search;

  const pageHref = (nextOffset: number) => {
    const p = new URLSearchParams(feedbackQuery);
    p.delete('limit');
    p.set('offset', String(nextOffset));
    return `/dashboard/feedback?${p}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
          <p className="text-sm text-neutral-500">{business.name}</p>
        </div>
        <BranchFilter branches={branches} selectedBranchId={branchId} />
      </div>

      <SavedViewTabs activeSavedView={savedView} baseParams={baseParams} />
      <FeedbackFilters search={search} category={category} urgency={urgency} baseParams={baseParams} />

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('emptyTitle')}</CardTitle>
            <CardDescription>{t('emptyDescription')}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <FeedbackInboxList items={items} branchNames={branchNames} currentUserId={currentUser?.id} />
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
