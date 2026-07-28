import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { PlatformBusinessDto, PlatformTeamMemberDto } from '@echo-grid-feedback/shared-types';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getCurrentUser } from '@/lib/platform';
import { StatusForm } from './status-form';
import { ImpersonateButton } from './impersonate-button';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';

interface BusinessDetailPageProps {
  params: Promise<{ id: string }>;
}

const STATUS_BADGE_VARIANT: Record<PlatformBusinessDto['status'], 'success' | 'danger' | 'neutral'> = {
  active: 'success',
  suspended: 'danger',
  archived: 'neutral',
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-neutral-500">{label}</p>
      <p className="text-neutral-900">{value}</p>
    </div>
  );
}

export default async function BusinessDetailPage({ params }: BusinessDetailPageProps) {
  const { id } = await params;
  // Two translators: t for this page's own detail.* keys, tStatus reusing
  // the directory's filters.status* labels (same three words, not worth a
  // third copy) -- next-intl scopes a translator to exactly the namespace
  // it's given, so reaching a sibling namespace needs its own call, not a
  // longer key path off t.
  const [t, tStatus, format] = await Promise.all([
    getTranslations('platform.businesses.detail'),
    getTranslations('platform.businesses.filters'),
    getFormatter(),
  ]);

  let business: PlatformBusinessDto;
  try {
    business = await apiFetch<PlatformBusinessDto>(`/platform/businesses/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  // Parallel: getCurrentUser() is React.cache()'d (lib/platform.ts) and was
  // already called once by platform/layout.tsx's auth guard on this same
  // request -- this is a free cache hit, not a second /auth/me round trip.
  const [user, team] = await Promise.all([
    getCurrentUser(),
    apiFetch<PlatformTeamMemberDto[]>(`/platform/businesses/${id}/team`),
  ]);

  const statusLabelKeys: Record<PlatformBusinessDto['status'], string> = {
    active: 'statusActive',
    suspended: 'statusSuspended',
    archived: 'statusArchived',
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/platform/businesses"
          className="text-sm font-medium text-brand-700 hover:underline"
        >
          {t('backToDirectory')}
        </Link>
        <div className="mt-1 flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-neutral-900">{business.name}</h1>
          <Badge variant={STATUS_BADGE_VARIANT[business.status]}>
            {tStatus(statusLabelKeys[business.status])}
          </Badge>
        </div>
        <p className="text-sm text-neutral-500">/{business.slug}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('overviewTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          <Field label={t('legalNameLabel')} value={business.legalName ?? t('notSet')} />
          <Field label={t('industryLabel')} value={business.industry ?? t('notSet')} />
          <Field label={t('localeLabel')} value={business.defaultLocale} />
          <Field label={t('currencyLabel')} value={business.defaultCurrency} />
          <Field label={t('timezoneLabel')} value={business.defaultTimezone} />
          <Field
            label={t('createdLabel')}
            value={format.dateTime(new Date(business.createdAt), 'short')}
          />
        </CardContent>
      </Card>

      {user?.platformRole === 'admin' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('statusForm.title')}</CardTitle>
            <CardDescription>{t('statusForm.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <StatusForm business={business} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('teamTitle')}</CardTitle>
          <CardDescription>{t('teamDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {team.length === 0 ? (
            <p className="text-sm text-neutral-500">{t('teamEmpty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-100">
              {team.map((member) => (
                <li key={member.id} className="flex items-center justify-between gap-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-neutral-900">{member.userFullName}</p>
                    <p className="text-xs text-neutral-500">
                      {member.userEmail} · {member.roleName}
                    </p>
                  </div>
                  {(user?.platformRole === 'support' || user?.platformRole === 'admin') && (
                    <ImpersonateButton
                      businessId={business.id}
                      userId={member.userId}
                      userName={member.userFullName}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Link
        href={`/platform/audit-log?businessId=${business.id}`}
        className="text-sm font-medium text-brand-700 hover:underline"
      >
        {t('viewAuditLog')}
      </Link>
    </div>
  );
}
