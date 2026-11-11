import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { BranchDto, FeedbackDto } from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { getCurrentUser } from '@/lib/platform';
import { apiFetch, ApiError } from '@/lib/api-client';
import { BranchFilter } from './branch-filter';
import { SavedViewTabs } from './saved-view-tabs';
import { FeedbackFilters } from './feedback-filters';
import { FeedbackInboxList } from './feedback-inbox-list';
import { buttonVariants } from '@/components/ui';
import { cn } from '@/lib/utils';
import styles from './feedback-inbox.module.css';

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

  let loaded:
    { branches: BranchDto[]; page: { items: FeedbackDto[]; hasMore: boolean } } | undefined;
  let failure: 'forbidden' | 'unavailable' | undefined;
  let currentUser: Awaited<ReturnType<typeof getCurrentUser>> | undefined;
  try {
    const [branches, page, user] = await Promise.all([
      apiFetch<BranchDto[]>('/branches', { businessId: business.id }),
      apiFetch<{ items: FeedbackDto[]; hasMore: boolean }>(`/feedback?${feedbackQuery}`, {
        businessId: business.id,
      }),
      getCurrentUser(),
    ]);
    loaded = { branches, page };
    currentUser = user;
  } catch (error) {
    // Never convert a denial or outage into an empty inbox; only an authentication expiry leaves the page.
    failure = error instanceof ApiError && error.status === 403 ? 'forbidden' : 'unavailable';
    if (error instanceof ApiError && error.status === 401) redirect('/login');
  }

  const header = (
    <header className={styles.header}>
      <div>
        <p className={styles.eyebrow}>{business.name}</p>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
      </div>
      <div className={styles.headerActions}>
        <Link
          href="/dashboard/feedback/forms"
          className={cn(buttonVariants({ variant: 'outline' }), 'min-h-11 rounded-xl')}
        >
          {t('manageForms')}
        </Link>
        {loaded && <BranchFilter branches={loaded.branches} selectedBranchId={branchId} />}
      </div>
    </header>
  );

  if (!loaded) {
    return (
      <div className={styles.page}>
        {header}
        <section className={styles.state} data-tone="error" role="alert">
          <h2>{failure === 'forbidden' ? t('forbiddenTitle') : t('unavailableTitle')}</h2>
          <p className={styles.muted}>
            {failure === 'forbidden' ? t('forbiddenDescription') : t('unavailableDescription')}
          </p>
          {failure !== 'forbidden' && (
            <div className={styles.stateLinks}>
              <Link href="/dashboard/feedback" className={buttonVariants({ variant: 'primary' })}>
                {t('retry')}
              </Link>
            </div>
          )}
        </section>
      </div>
    );
  }

  const { branches, page } = loaded;
  const { items, hasMore } = page;
  const filtersActive = Boolean(
    search || category.length || urgency.length || savedView || branchId,
  );
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
    <div className={styles.page}>
      {header}

      <section className={styles.toolbar} aria-label={t('filtersLabel')}>
        <SavedViewTabs activeSavedView={savedView} baseParams={baseParams} />
        <FeedbackFilters
          search={search}
          category={category}
          urgency={urgency}
          baseParams={baseParams}
        />
      </section>

      {items.length === 0 ? (
        <section className={styles.state}>
          <h2>{filtersActive ? t('noResultsTitle') : t('emptyTitle')}</h2>
          <p className={styles.muted}>
            {filtersActive ? t('noResultsDescription') : t('emptyDescription')}
          </p>
          {filtersActive && (
            <div className={styles.stateLinks}>
              <Link href="/dashboard/feedback" className={buttonVariants({ variant: 'outline' })}>
                {t('clearFilters')}
              </Link>
            </div>
          )}
        </section>
      ) : (
        <FeedbackInboxList
          items={items}
          branchNames={branchNames}
          currentUserId={currentUser?.id}
        />
      )}

      {(offset > 0 || hasMore) && (
        <nav className={styles.pager} aria-label={t('title')}>
          {offset > 0 && <Link href={pageHref(Math.max(0, offset - PAGE_SIZE))}>{t('newer')}</Link>}
          {hasMore && <Link href={pageHref(offset + PAGE_SIZE)}>{t('older')}</Link>}
        </nav>
      )}
    </div>
  );
}
