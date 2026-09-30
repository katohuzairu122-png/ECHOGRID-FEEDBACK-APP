import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { hasSession } from '@/lib/session';
import { Logo, FeedbackIcon, InsightsIcon, ActionIcon, LoyaltyIcon } from '@/components/brand';
import { buttonVariants } from '@/components/ui';

const FEATURES = [
  { key: 'feedback', Icon: FeedbackIcon },
  { key: 'insights', Icon: InsightsIcon },
  { key: 'action', Icon: ActionIcon },
  { key: 'loyalty', Icon: LoyaltyIcon },
] as const;

export default async function RootPage() {
  if (await hasSession()) {
    redirect('/dashboard');
  }
  const t = await getTranslations('landing');

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-16 bg-neutral-50 px-6 py-16">
      <div className="flex flex-col items-center gap-8 text-center">
        <Logo variant="full" iconSize={48} />
        <div className="flex gap-3">
          <Link href="/signup" className={buttonVariants({ size: 'lg' })}>
            {t('signupCta')}
          </Link>
          <Link href="/login" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
            {t('loginLink')}
          </Link>
        </div>
      </div>
      <div className="grid w-full max-w-4xl grid-cols-2 gap-6 sm:grid-cols-4">
        {FEATURES.map(({ key, Icon }) => (
          <div key={key} className="flex flex-col items-center gap-2 text-center">
            <Icon className="h-8 w-8 text-brand-600" />
            <p className="text-sm font-semibold text-neutral-900">{t(`features.${key}.title`)}</p>
            <p className="text-xs text-neutral-500">{t(`features.${key}.description`)}</p>
          </div>
        ))}
      </div>
      <nav aria-label="Support and legal" className="flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs text-neutral-500">
        <Link href="/support">Support</Link>
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/refunds">Refunds</Link>
        <Link href="/cookies">Cookies</Link>
      </nav>
    </main>
  );
}
