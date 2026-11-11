import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';

export interface PartnerTermsDto {
  policyVersion: string;
  terms: string;
  termsDigest: string;
}

export type PartnerTermsData =
  | { status: 'ready'; data: PartnerTermsDto }
  | { status: 'forbidden' }
  | { status: 'unavailable' };

/**
 * Read-only Partner Program terms (P1). Shows exactly what GET /partner-credits/consent/terms returns.
 * There is deliberately no accept or enroll control here: acceptance and enrollment are separate, explicitly
 * authorized actions, and a failure is never rendered as empty terms.
 */
export function PartnerTermsView({ result }: { result: PartnerTermsData }) {
  const t = useTranslations('dashboard.billing.partner');
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/dashboard/billing" className="text-sm font-medium text-brand-700 underline">
          {t('back')}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-neutral-900">{t('title')}</h1>
        <p className="text-sm text-neutral-500">{t('description')}</p>
      </div>

      {result.status !== 'ready' ? (
        <Card>
          <CardContent role="status" data-state={result.status} className="flex flex-col gap-2 py-5">
            <p>{result.status === 'forbidden' ? t('forbidden') : t('unavailable')}</p>
            {result.status === 'unavailable' && (
              <Link href="/dashboard/billing/partner-terms" className="text-sm font-medium text-brand-700 underline">
                {t('retry')}
              </Link>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('termsHeading')}</CardTitle>
              <CardDescription>
                {t('versionLabel')}: <span data-testid="policy-version">{result.data.policyVersion}</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p data-testid="terms-text" className="text-sm leading-relaxed text-neutral-800">
                {result.data.terms}
              </p>
              <div>
                <p className="text-xs font-medium text-neutral-500">{t('digestLabel')}</p>
                <code data-testid="terms-digest" className="break-all text-xs text-neutral-700">
                  {result.data.termsDigest}
                </code>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('statusHeading')}</CardTitle>
              <CardDescription>{t('statusBody')}</CardDescription>
            </CardHeader>
          </Card>
        </>
      )}
    </div>
  );
}
