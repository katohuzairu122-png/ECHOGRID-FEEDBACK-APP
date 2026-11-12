import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { logoutAction } from '@/lib/actions/auth';
import { Button } from '@/components/ui';

/**
 * Protected error state for pages the current user may not use, or whose permissions could not be
 * confirmed. Offers only non-privileged recovery: try again, or sign out. Never links to another
 * privileged page.
 */
export async function RestrictedPanel({
  variant,
  retryHref = '/dashboard',
}: {
  variant: 'unavailable' | 'forbidden';
  retryHref?: string;
}) {
  const t = await getTranslations('dashboard.restricted');
  return (
    <section role="alert" className="mx-auto max-w-xl space-y-4 px-4 py-12 text-center">
      <h1 className="text-2xl font-semibold">{t(`${variant}Title`)}</h1>
      <p className="text-sm text-neutral-600">{t(`${variant}Body`)}</p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href={retryHref}
          className="inline-flex min-h-11 items-center rounded-md border border-neutral-300 px-4 text-sm font-medium"
        >
          {t('retry')}
        </Link>
        <form action={logoutAction}>
          <Button type="submit" variant="ghost">
            {t('logout')}
          </Button>
        </form>
      </div>
    </section>
  );
}
