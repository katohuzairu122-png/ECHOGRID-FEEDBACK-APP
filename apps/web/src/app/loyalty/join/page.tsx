import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Logo } from '@/components/brand';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { publicApiFetch } from '@/lib/public-api-client';
import { BusinessFinder } from './business-finder';

/** Built per request: the list comes from the API, which must not be called while the site is being built. */
export const dynamic = 'force-dynamic';

/**
 * CUSTOMER-JOIN-HUB-02: three independent paths: business QR onboarding, direct platform account registration,
 * and searching public business names. Creating a platform account never creates a business membership.
 * A business membership requires its separately verified QR and explicit join consent.
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
            <CardTitle>{t('platformTitle')}</CardTitle>
            <CardDescription>{t('platformBody')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/loyalty/signup" className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-5 py-2.5 font-medium text-white hover:bg-brand-800">
              {t('platformCta')}
            </Link>
          </CardContent>
        </Card>
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>{t('findTitle')}</CardTitle>
            <CardDescription>{t('findBody')}</CardDescription>
          </CardHeader>
          <CardContent>
            <BusinessFinder
              names={names}
              loadFailed={loadFailed}
              labels={{
                searchLabel: t('searchLabel'),
                searchPlaceholder: t('searchPlaceholder'),
                noMatches: t('noMatches'),
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
