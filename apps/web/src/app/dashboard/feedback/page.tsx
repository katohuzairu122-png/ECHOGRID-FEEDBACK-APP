import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { BranchDto, FeedbackDto } from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import { BranchFilter } from './branch-filter';
import { FeedbackActions } from './feedback-actions';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  StarDisplay,
} from '@/components/ui';

/**
 * UI-chosen page size, independent of the API's own default (50) -- fits
 * the "several cards per screen" reading pattern of this list better than
 * the API's own bulk-listing default. "Newer/Older" offset links, not
 * numbered pages: FeedbackRepository.listForBusiness has no total-count
 * query, so true page-N-of-M pagination isn't available without a backend
 * change out of scope for this block -- fetching PAGE_SIZE+1 items and
 * checking whether the extra one came back is the standard no-count-needed
 * way to know whether an "Older" link should exist.
 */
const PAGE_SIZE = 20;

interface FeedbackPageProps {
  searchParams: Promise<{ branchId?: string; offset?: string }>;
}

export default async function FeedbackPage({ searchParams }: FeedbackPageProps) {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');

  // i18n & Multi-Currency Block 3 -- renders in the request-resolved
  // locale/timeZone (i18n/request.ts) instead of the server runtime's
  // default, via the 'short' preset defined there.
  const format = await getFormatter();
  // i18n & Multi-Currency Block 5.
  const t = await getTranslations('feedback.staff');

  const { branchId, offset: offsetParam } = await searchParams;
  const offset = Number(offsetParam) || 0;

  const feedbackQuery = new URLSearchParams({
    ...(branchId ? { branchId } : {}),
    limit: String(PAGE_SIZE + 1),
    offset: String(offset),
  });

  const [branches, page] = await Promise.all([
    apiFetch<BranchDto[]>('/branches', { businessId: business.id }),
    apiFetch<FeedbackDto[]>(`/feedback?${feedbackQuery}`, { businessId: business.id }),
  ]);

  const hasMore = page.length > PAGE_SIZE;
  const items = page.slice(0, PAGE_SIZE);
  const branchNames = new Map(branches.map((b) => [b.id, b.name]));

  const pageHref = (nextOffset: number) =>
    `/dashboard/feedback?${new URLSearchParams({
      ...(branchId ? { branchId } : {}),
      offset: String(nextOffset),
    })}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
          <p className="text-sm text-neutral-500">{business.name}</p>
        </div>
        <BranchFilter branches={branches} selectedBranchId={branchId} />
      </div>

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('emptyTitle')}</CardTitle>
            <CardDescription>{t('emptyDescription')}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => (
            <Card key={item.id}>
              <CardContent className="flex flex-col gap-3 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <StarDisplay value={item.rating} />
                      <Badge variant={item.status === 'new' ? 'accent' : 'neutral'}>
                        {item.status === 'new' ? t('statusNew') : t('statusReviewed')}
                      </Badge>
                    </div>
                    <p className="text-xs text-neutral-500">
                      {branchNames.get(item.branchId) ?? t('unknownBranch')} ·{' '}
                      {format.dateTime(new Date(item.createdAt), 'short')}
                    </p>
                  </div>
                  <FeedbackActions feedbackId={item.id} status={item.status} />
                </div>

                {item.comment && <p className="text-sm text-neutral-800">{item.comment}</p>}

                {item.followUpQuestion && item.followUpAnswer && (
                  <div className="rounded-md bg-neutral-50 p-3">
                    <p className="text-xs font-medium text-neutral-500">{item.followUpQuestion}</p>
                    <p className="text-sm text-neutral-800">{item.followUpAnswer}</p>
                  </div>
                )}

                {(item.customerName || item.customerEmail || item.customerPhone) && (
                  <p className="text-xs text-neutral-500">
                    {[item.customerName, item.customerEmail, item.customerPhone]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
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
