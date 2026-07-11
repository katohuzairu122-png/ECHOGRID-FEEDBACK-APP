import { getTranslations } from 'next-intl/server';
import type { PlatformBusinessDto } from '@echo-grid-feedback/shared-types';
import { apiFetch } from '@/lib/api-client';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';

const STATUS_BADGE_VARIANT: Record<PlatformBusinessDto['status'], 'success' | 'danger' | 'neutral'> = {
  active: 'success',
  suspended: 'danger',
  archived: 'neutral',
};

const STATUS_LABEL_KEYS: Record<PlatformBusinessDto['status'], string> = {
  active: 'statusLabels.active',
  suspended: 'statusLabels.suspended',
  archived: 'statusLabels.archived',
};

/**
 * The console's landing screen. Deliberately real content, not a static
 * placeholder -- Block 2's directory API already exists, so this shows the
 * 5 most recently created businesses as a genuinely useful at-a-glance view
 * rather than an empty shell waiting for Block 6. Block 6 replaces this
 * fixed 5-row preview with the full searchable/filterable/paginated
 * directory at its own route; this page keeps just the teaser once that
 * exists, matching dashboard/page.tsx's own "Branches" card, which links
 * out to the full branches screen rather than duplicating it.
 */
export default async function PlatformHomePage() {
  const t = await getTranslations('platform.home');
  const recent = await apiFetch<PlatformBusinessDto[]>('/platform/businesses?limit=5');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
        <p className="text-sm text-neutral-500">{t('description')}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t('recentBusinessesTitle')}</CardTitle>
          <CardDescription>{t('recentBusinessesDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-neutral-500">{t('empty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-100">
              {recent.map((business) => (
                <li key={business.id} className="flex items-center justify-between py-3">
                  <div>
                    <p className="text-sm font-medium text-neutral-900">{business.name}</p>
                    <p className="text-xs text-neutral-500">/{business.slug}</p>
                  </div>
                  <Badge variant={STATUS_BADGE_VARIANT[business.status]}>
                    {t(STATUS_LABEL_KEYS[business.status])}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
