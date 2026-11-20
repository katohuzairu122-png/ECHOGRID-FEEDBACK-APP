import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Logo } from '@/components/brand';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { publicApiFetch } from '@/lib/public-api-client';
import { BusinessFinder } from './business-finder';

/** Built per request: the list comes from the API, which must not be called while the site is being built. */
export const dynamic = 'force-dynamic';

/**
 * LANDING-ROLE-01: where a loyalty customer lands after choosing "I'm a loyalty customer" on the registration page. Joining a business
 * still happens only by scanning that business's QR code; this page explains that and helps the customer find a registered business
 * (names only, from the anonymous /public/businesses list). A failure to load the list never blocks the QR path.
 */
export default async function LoyaltyJoinPage() {
  const t = await getTranslations('loyalty.customer.joinHub');
  let names: string[] = [];
  let loadFailed = false;
  try {
    const data = await publicApiFetch<{ businesses: { name: string }[] }>('/public/businesses');
    names = data.businesses.map((b) => b.name);
  } catch {
    loadFailed = true;
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-50 px-4 py-8 sm:px-8">
      <Logo variant="full" iconSize={40} />
      <div className="w-full max-w-xl">
        <h1 className="text-center text-2xl font-semibold text-neutral-900">{t('title')}</h1>
        <p className="mt-2 text-center text-sm text-neutral-600">{t('description')}</p>
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>{t('scanTitle')}</CardTitle>
            <CardDescription>{t('scanBody')}</CardDescription>
          </CardHeader>
        </Card>
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>{t('findTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <BusinessFinder
              names={names}
              loadFailed={loadFailed}
              labels={{
                selectLabel: t('selectLabel'),
                selectPlaceholder: t('selectPlaceholder'),
                empty: t('empty'),
                loadError: t('loadError'),
                chosenTitleTemplate: t('chosenTitle', { name: '{name}' }),
                chosenBodyTemplate: t('chosenBody', { name: '{name}' }),
                accountCta: t('accountCta'),
                accountNote: t('accountNote'),
              }}
            />
          </CardContent>
        </Card>
        <p className="mt-6 text-center text-sm">
          <Link href="/signup" className="font-medium text-brand-700 hover:underline">
            {t('back')}
          </Link>
        </p>
      </div>
    </main>
  );
}
