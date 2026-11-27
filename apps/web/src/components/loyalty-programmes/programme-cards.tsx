import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import type { LoyaltyProgramType, ProgramUnavailableReason } from '@echo-grid-feedback/shared-types';

export interface RegistryCard {
  type: LoyaltyProgramType;
  available: boolean;
  unavailableReason?: ProgramUnavailableReason | undefined;
}

/**
 * The eight programme cards (LOYALTY-PROGRAMME-COMPLETION 6.1). Availability comes from the canonical registry returned by the API; an
 * unavailable programme has no select action and says why. `activeType` marks the programme the business is running now.
 */
export function ProgrammeCards({ registry, activeType, setup }: { registry: RegistryCard[]; activeType?: LoyaltyProgramType | undefined; setup?: boolean | undefined }) {
  const t = useTranslations('loyalty.programmes');
  return (
    <ul className="grid gap-4 sm:grid-cols-2" aria-label={t('cards.title')}>
      {registry.map((entry) => (
        <li key={entry.type}>
          <Card className="h-full" data-testid={`programme-card-${entry.type}`}>
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <CardTitle>{t(`types.${entry.type}.name`)}</CardTitle>
                {entry.type === activeType ? <Badge variant="brand">{t('cards.current')}</Badge> : entry.available ? null : <Badge variant="neutral">{t('cards.unavailable')}</Badge>}
              </div>
              <CardDescription>{t(`types.${entry.type}.summary`)}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <p className="rounded-md bg-neutral-50 p-2 text-neutral-700">{t(`types.${entry.type}.example`)}</p>
              <p className="text-xs text-neutral-500">{t(`types.${entry.type}.needs`)}</p>
              {entry.available ? (
                <Link
                  className="inline-flex min-h-11 items-center justify-center rounded-md bg-brand-700 px-4 py-2 font-medium text-white hover:bg-brand-800"
                  href={`/dashboard/loyalty/programme?type=${entry.type}${setup ? '&setup=1' : ''}#configure`}
                >
                  {entry.type === activeType ? t('cards.edit') : t('cards.select')}
                </Link>
              ) : (
                <p role="note" className="text-warning">{t(`cards.reason.${entry.unavailableReason ?? 'IN_DEVELOPMENT'}`)}</p>
              )}
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
