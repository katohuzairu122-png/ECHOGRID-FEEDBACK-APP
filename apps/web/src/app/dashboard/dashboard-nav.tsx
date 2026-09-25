import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { logoutAction } from '@/lib/actions/auth';
import { Button } from '@/components/ui';
import { Logo } from '@/components/brand';
import { PwaInstallButton } from '@/components/pwa-install-button';
import { DashboardMobileNav } from './dashboard-mobile-nav';

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
          <div className="hidden items-center gap-1 lg:flex">
            <PwaInstallButton label={t('nav.installApp')} iosHint={t('nav.installIosHint')} />
            <form action={logoutAction}>
              <Button type="submit" variant="ghost" size="sm">
                {t('nav.logout')}
              </Button>
            </form>
          </div>

          <DashboardMobileNav
            menuLabel={t('nav.menu')}
            logoutLabel={t('nav.logout')}
            installLabel={t('nav.installApp')}
            installIosHint={t('nav.installIosHint')}
            items={NAV_ITEMS.map(([key, href]) => ({ href, label: t(`nav.${key}`) }))}
          />
        </div>
      </div>
    </header>
  );
}
