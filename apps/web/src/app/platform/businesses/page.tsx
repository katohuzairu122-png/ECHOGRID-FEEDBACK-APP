import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { PlatformBusinessDto } from '@echo-grid-feedback/shared-types';
import { apiFetch } from '@/lib/api-client';
import { BusinessFilters } from './business-filters';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';

/** Same "fetch limit+1, Newer/Older" trick as every other list in this app
 * (dashboard/feedback/page.tsx, analytics/search/page.tsx) -- Block 2's
 * businesses.list() has no total-count query, consistent with every other
 * paginated repository method in this codebase. */
const PAGE_SIZE = 20;

const STATUS_BADGE_VARIANT: Record<PlatformBusinessDto['status'], 'success' | 'danger' | 'neutral'> = {
  active: 'success',
  suspended: 'danger',
  archived: 'neutral',
};

// Reuses the filter dropdown's own status labels (filters.status*) rather
// than a second, parallel set of keys for the same three words.
const STATUS_LABEL_KEYS: Record<PlatformBusinessDto['status'], string> = {
  active: 'filters.statusActive',
  suspended: 'filters.statusSuspended',
  archived: 'filters.statusArchived',
};

interface BusinessesPageProps {
  searchParams: Promise<{ search?: string; status?: string; offset?: string }>;
}

export default async function PlatformBusinessesPage({ searchParams }: BusinessesPageProps) {
  const t = await getTranslations('platform.businesses');
  const { search, status, offset: offsetParam } = await searchParams;
  const offset = Number(offsetParam) || 0;

  const query = new URLSearchParams({
    ...(search ? { search } : {}),
    ...(status ? { status } : {}),
    limit: String(PAGE_SIZE + 1),
    offset: String(offset),
  });
  const page = await apiFetch<PlatformBusinessDto[]>(`/platform/businesses?${query}`);

  const hasMore = page.length > PAGE_SIZE;
  const items = page.slice(0, PAGE_SIZE);

  const pageHref = (nextOffset: number) =>
    `/platform/businesses?${new URLSearchParams({
      ...(search ? { search } : {}),
      ...(status ? { status } : {}),
      offset: String(nextOffset),
    })}`;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
        <p className="text-sm text-neutral-500">{t('description')}</p>
      </div>

      <Card>
        <CardContent className="py-4">
          <BusinessFilters search={search} status={status} />
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
        <div className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
          {items.map((business) => (
            <Link
              key={business.id}
              href={`/platform/businesses/${business.id}`}
              className="flex items-center justify-between gap-4 px-6 py-4 hover:bg-neutral-50"
            >
              <div>
                <p className="text-sm font-medium text-neutral-900">{business.name}</p>
                <p className="text-xs text-neutral-500">/{business.slug}</p>
              </div>
              <Badge variant={STATUS_BADGE_VARIANT[business.status]}>
                {t(STATUS_LABEL_KEYS[business.status])}
              </Badge>
            </Link>
          ))}
        </div>
      )}

      {(offset > 0 || hasMore) && (
        <div className="flex justify-center gap-4">
          {offset > 0 && (
            <Link
              href={pageHref(Math.max(0, offset - PAGE_SIZE))}
              className="text-sm font-medium text-brand-600 hover:underline"
            >
              {t('newer')}
            </Link>
          )}
          {hasMore && (
            <Link
              href={pageHref(offset + PAGE_SIZE)}
              className="text-sm font-medium text-brand-600 hover:underline"
            >
              {t('older')}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
