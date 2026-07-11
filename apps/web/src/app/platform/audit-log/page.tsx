import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { PlatformAuditLogEntryDto } from '@echo-grid-feedback/shared-types';
import { apiFetch } from '@/lib/api-client';
import { AuditFilters } from './audit-filters';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';

/** Same no-total-count pagination trick as every other list here -- see
 * businesses/page.tsx's comment. Larger page size than the business
 * directory's since entries are compact, one-line rows. */
const PAGE_SIZE = 30;

interface AuditLogPageProps {
  searchParams: Promise<{
    businessId?: string;
    actorUserId?: string;
    entityType?: string;
    action?: string;
    from?: string;
    to?: string;
    offset?: string;
  }>;
}

export default async function PlatformAuditLogPage({ searchParams }: AuditLogPageProps) {
  const [t, format] = await Promise.all([getTranslations('platform.auditLog'), getFormatter()]);
  const {
    businessId,
    actorUserId,
    entityType,
    action,
    from,
    to,
    offset: offsetParam,
  } = await searchParams;
  const offset = Number(offsetParam) || 0;

  const query = new URLSearchParams({
    ...(businessId ? { businessId } : {}),
    ...(actorUserId ? { actorUserId } : {}),
    ...(entityType ? { entityType } : {}),
    ...(action ? { action } : {}),
    // <input type="date"> gives plain YYYY-MM-DD -- new Date() parses that
    // as UTC midnight, which the API's Date-typed from/to filter accepts
    // directly once serialized back to ISO.
    ...(from ? { from: new Date(from).toISOString() } : {}),
    ...(to ? { to: new Date(to).toISOString() } : {}),
    limit: String(PAGE_SIZE + 1),
    offset: String(offset),
  });
  const page = await apiFetch<PlatformAuditLogEntryDto[]>(`/platform/audit-log?${query}`);

  const hasMore = page.length > PAGE_SIZE;
  const items = page.slice(0, PAGE_SIZE);

  const pageHref = (nextOffset: number) =>
    `/platform/audit-log?${new URLSearchParams({
      ...(businessId ? { businessId } : {}),
      ...(actorUserId ? { actorUserId } : {}),
      ...(entityType ? { entityType } : {}),
      ...(action ? { action } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
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
          <AuditFilters
            businessId={businessId}
            actorUserId={actorUserId}
            entityType={entityType}
            action={action}
            from={from}
            to={to}
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
        <div className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
          {items.map((entry) => (
            <div key={entry.id} className="flex flex-col gap-1 px-6 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="neutral">{entry.action}</Badge>
                <span className="text-xs text-neutral-500">
                  {format.dateTime(new Date(entry.createdAt), 'short')}
                </span>
                {/* Set unconditionally by auditTrail during an impersonated
                    session (middleware/audit.ts, Block 4) -- surfacing it
                    here is the audit log actually delivering on that
                    accountability guarantee, not new logic. */}
                {Boolean(entry.metadata?.impersonatedBy) && (
                  <Badge variant="accent">{t('impersonatedBadge')}</Badge>
                )}
              </div>
              <p className="text-sm text-neutral-800">
                {entry.actorFullName ?? entry.actorEmail ?? t('systemActor')}
                {entry.businessName && <> · {entry.businessName}</>}
              </p>
            </div>
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
