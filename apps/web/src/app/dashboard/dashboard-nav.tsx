import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { logoutAction } from '@/lib/actions/auth';
import { Button } from '@/components/ui';
import { Logo } from '@/components/brand';

const NAV_ITEMS = [
  ['branches', '/dashboard/branches'],
  ['feedback', '/dashboard/feedback'],
  ['loyalty', '/dashboard/loyalty'],
  ['messages', '/dashboard/messages'],
  ['analytics', '/dashboard/analytics'],
  ['notifications', '/dashboard/notifications'],
  ['settings', '/dashboard/settings'],
  ['billing', '/dashboard/billing'],
] as const;

const linkClassName = 'text-sm text-neutral-600 hover:text-neutral-900';

/**
 * Server Component -- async only because getTranslations() is (i18n &
 * Multi-Currency Block 4). The logout <form> still needs no
 * useActionState: it's a bare Server Action reference, and logout either
 * works or the user just tries again.
 *
 * Deliberately does NOT fetch the current user to conditionally show a
 * "Platform Admin" link -- that would add an extra /auth/me round trip to
 * EVERY dashboard page load (this component is in the shared layout) for
 * the overwhelming majority of users who will never have a platformRole.
 * That entry point lives on dashboard/page.tsx instead (Platform Admin
 * Console Block 5) -- one page, visited once per session in the common
 * case, not every navigation.
 */
export async function DashboardNav() {
  const t = await getTranslations('dashboard');

  return (
    <header className="border-b border-neutral-200 bg-white">
      <div className="mx-auto max-w-5xl px-4 py-3 sm:px-6 lg:py-4">
        <div className="flex items-center justify-between gap-4">
          <Link href="/dashboard" aria-label="Echo Grid dashboard home">
            <Logo variant="horizontal" iconSize={28} />
          </Link>
          <nav className="hidden items-center gap-4 lg:flex" aria-label={t('nav.menu')}>
            {NAV_ITEMS.map(([key, href]) => (
              <Link key={key} href={href} className={linkClassName}>
                {t(`nav.${key}`)}
              </Link>
            ))}
          </nav>
          <form action={logoutAction} className="hidden lg:block">
            <Button type="submit" variant="ghost" size="sm">
              {t('nav.logout')}
            </Button>
          </form>

          <details className="group relative lg:hidden">
            <summary className="flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center rounded-md border border-neutral-200 text-neutral-700 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 [&::-webkit-details-marker]:hidden">
              <span className="sr-only">{t('nav.menu')}</span>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                className="h-5 w-5 group-open:hidden"
              >
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                className="hidden h-5 w-5 group-open:block"
              >
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </summary>
            <div className="absolute end-0 z-50 mt-2 w-64 rounded-lg border border-neutral-200 bg-white p-2 shadow-lg">
              <nav className="grid" aria-label={t('nav.menu')}>
                {NAV_ITEMS.map(([key, href]) => (
                  <Link
                    key={key}
                    href={href}
                    className="rounded-md px-3 py-2.5 text-sm text-neutral-700 hover:bg-neutral-50 hover:text-neutral-950"
                  >
                    {t(`nav.${key}`)}
                  </Link>
                ))}
              </nav>
              <form action={logoutAction} className="mt-1 border-t border-neutral-100 pt-1">
                <Button type="submit" variant="ghost" size="sm" className="w-full justify-start">
                  {t('nav.logout')}
                </Button>
              </form>
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}
