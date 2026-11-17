import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import type { BusinessSurveysResult } from '@/lib/business-surveys-types';

/**
 * Read-only survey hosting overview (S1). Shows exactly what GET /surveys and GET /surveys/campaigns return for the
 * caller's own business. There is deliberately no create, publish, activate, pause or close control: campaign
 * activation can start Community Point awards, so it stays a separate, explicitly authorized block.
 */
export function BusinessSurveysView({ result }: { result: BusinessSurveysResult }) {
  const t = useTranslations('dashboard.surveys');
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
        <p className="text-sm text-neutral-500">{t('description')}</p>
      </div>

      {result.status !== 'ready' ? (
        <Card>
          <CardContent role="status" data-state={result.status} className="flex flex-col gap-2 py-5">
            <p>{result.status === 'forbidden' ? t('forbidden') : t('unavailable')}</p>
            {result.status === 'unavailable' && (
              <Link href="/dashboard/surveys" className="text-sm font-medium text-brand-700 underline">
                {t('retry')}
              </Link>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('surveysHeading')}</CardTitle>
              <CardDescription>{t('surveysDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              {result.data.surveys.length === 0 ? (
                <p data-testid="surveys-empty" className="text-sm text-neutral-600">
                  {t('surveysEmpty')}
                </p>
              ) : (
                <ul data-testid="surveys-list" className="flex flex-col divide-y divide-neutral-100">
                  {result.data.surveys.map((survey) => (
                    <li key={survey.id} className="flex items-center justify-between gap-3 py-2">
                      <span className="text-sm font-medium text-neutral-900">{survey.name}</span>
                      <span className="text-xs text-neutral-600" data-testid={`survey-status-${survey.id}`}>
                        {t(`surveyStatus.${survey.status}`)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('campaignsHeading')}</CardTitle>
              <CardDescription>{t('campaignsDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              {result.data.campaigns.length === 0 ? (
                <p data-testid="campaigns-empty" className="text-sm text-neutral-600">
                  {t('campaignsEmpty')}
                </p>
              ) : (
                <ul data-testid="campaigns-list" className="flex flex-col divide-y divide-neutral-100">
                  {result.data.campaigns.map((campaign) => (
                    <li key={campaign.id} className="flex items-center justify-between gap-3 py-2">
                      <span className="text-sm font-medium text-neutral-900">{campaign.name}</span>
                      <span className="text-xs text-neutral-600" data-testid={`campaign-status-${campaign.id}`}>
                        {t(`campaignStatus.${campaign.status}`)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
