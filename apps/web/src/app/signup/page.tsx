import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Logo } from '@/components/brand';
import { buttonVariants } from '@/components/ui';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { cn } from '@/lib/utils';
import { SignupForm } from './signup-form';

/**
 * LANDING-ROLE-01: the registration entry asks FIRST how the person will use Echo Grid. A business owner continues to the existing owner form
 * (unchanged, at /signup?role=business); a loyalty customer goes to /loyalty/join and never sees the owner form. Links that already carry a
 * destination (?next=..., e.g. a team invitation) or ?role=business keep going straight to the owner form, so no existing flow changes.
 */
export default async function SignupPage({ searchParams }: { searchParams: Promise<{ role?: string; next?: string }> }) {
  const { role, next } = await searchParams;
  if (role === 'business' || (typeof next === 'string' && next.length > 0)) return <SignupForm />;

  const t = await getTranslations('auth.chooser');
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-neutral-50 px-4 py-8 sm:px-8">
      <Logo variant="full" iconSize={40} />
      <div className="w-full max-w-3xl">
        <h1 className="text-center text-2xl font-semibold text-neutral-900">{t('title')}</h1>
        <p className="mt-2 text-center text-sm text-neutral-600">{t('description')}</p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Card className="flex flex-col">
            <CardHeader>
              <CardTitle>{t('ownerTitle')}</CardTitle>
              <CardDescription>{t('ownerBody')}</CardDescription>
            </CardHeader>
            <CardContent className="mt-auto flex flex-col gap-2">
              <Link href="/signup?role=business" className={cn(buttonVariants(), 'w-full')}>
                {t('ownerCta')}
              </Link>
            </CardContent>
          </Card>
          <Card className="flex flex-col">
            <CardHeader>
              <CardTitle>{t('customerTitle')}</CardTitle>
              <CardDescription>{t('customerBody')}</CardDescription>
            </CardHeader>
            <CardContent className="mt-auto flex flex-col gap-2">
              <Link href="/loyalty/join" className={cn(buttonVariants(), 'w-full')}>
                {t('customerCta')}
              </Link>
              <p className="text-xs text-neutral-500">{t('customerNote')}</p>
            </CardContent>
          </Card>
        </div>
        <p className="mt-6 text-center text-sm text-neutral-500">
          {t('haveAccount')}{' '}
          <Link href="/login" className="font-medium text-brand-700 hover:underline">
            {t('ownerLogin')}
          </Link>
          {' · '}
          <Link href="/loyalty/login" className="font-medium text-brand-700 hover:underline">
            {t('customerLogin')}
          </Link>
        </p>
      </div>
    </main>
  );
}
