import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { hasSession } from '@/lib/session';
import { getCurrentUser } from '@/lib/platform';
import { buttonVariants } from '@/components/ui';
import { cn } from '@/lib/utils';
import { AppFooter } from '@/components/brand';
import { PlatformNav } from './platform-nav';

/**
 * Three layers of gating, same defense-in-depth reasoning as
 * dashboard/layout.tsx plus one platform-specific layer on top:
 *   1. middleware.ts already redirects to /login if there's no refresh
 *      token at all (runs before this, Edge runtime).
 *   2. hasSession() re-checks here, same as dashboard/layout.tsx.
 *   3. getCurrentUser().platformRole -- unique to this layout. Unlike the
 *      business dashboard, which any authenticated user can reach, this
 *      section requires a platformRole the overwhelming majority of
 *      accounts don't have. A valid staff session alone is not enough, so
 *      this renders an explicit access-denied view rather than silently
 *      redirecting -- a silent bounce back to /dashboard would look like a
 *      bug ("why did clicking that link do nothing") rather than the
 *      correct, deliberate rejection it is.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  if (!(await hasSession())) {
    redirect('/login');
  }

  const user = await getCurrentUser();
  if (!user?.platformRole) {
    const t = await getTranslations('platform.accessDenied');
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-6">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold text-neutral-900">{t('title')}</h1>
          <p className="mt-2 text-sm text-neutral-500">{t('description')}</p>
          <Link href="/dashboard" className={cn(buttonVariants({ variant: 'outline' }), 'mt-6')}>
            {t('backToDashboard')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <PlatformNav role={user.platformRole} />
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
      <AppFooter />
    </div>
  );
}
