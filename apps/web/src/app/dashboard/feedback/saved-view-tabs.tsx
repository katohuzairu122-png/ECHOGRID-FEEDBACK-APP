import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { cn } from '@/lib/utils';

const SAVED_VIEWS = [
  'critical_now',
  'high_priority_unresolved',
  'negative_unresolved',
  'follow_up_required',
  'unclassified',
  'recently_resolved',
  'positive_feedback',
] as const;

interface SavedViewTabsProps {
  activeSavedView?: string | undefined;
  /** Every OTHER active query param (branchId, category, etc.) so switching
   * tabs doesn't silently drop a filter the user already set -- only
   * savedView/offset get replaced, everything else carries forward. */
  baseParams: Record<string, string>;
}

/**
 * Plain links, not a client-side tab widget -- the active view is entirely
 * derived from the URL (same "URL is the source of truth" principle as
 * BranchFilter), so no client component or interactivity is needed here at
 * all. Server Component, async only for the translation lookup.
 */
export async function SavedViewTabs({ activeSavedView, baseParams }: SavedViewTabsProps) {
  const t = await getTranslations('feedback.staff.savedViews');

  const hrefFor = (view: string | undefined) => {
    const params = new URLSearchParams(baseParams);
    if (view) params.set('savedView', view);
    else params.delete('savedView');
    const qs = params.toString();
    return qs ? `/dashboard/feedback?${qs}` : '/dashboard/feedback';
  };

  const tabClass = (isActive: boolean) =>
    cn(
      'whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
      isActive ? 'bg-brand-600 text-white' : 'text-neutral-600 hover:bg-neutral-100',
    );

  return (
    <nav aria-label={t('all')} className="flex flex-wrap gap-1.5">
      <Link href={hrefFor(undefined)} className={tabClass(!activeSavedView)} aria-current={!activeSavedView ? 'page' : undefined}>
        {t('all')}
      </Link>
      {SAVED_VIEWS.map((view) => (
        <Link
          key={view}
          href={hrefFor(view)}
          className={tabClass(activeSavedView === view)}
          aria-current={activeSavedView === view ? 'page' : undefined}
        >
          {t(view)}
        </Link>
      ))}
    </nav>
  );
}
