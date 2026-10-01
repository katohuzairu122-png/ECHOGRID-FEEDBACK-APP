import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { logoutAction } from '@/lib/actions/auth';
import { Button } from '@/components/ui';
import { Logo } from '@/components/brand';
import { PwaInstallButton } from '@/components/pwa-install-button';
import { DashboardMobileNav } from './dashboard-mobile-nav';
import { DashboardNavLinks } from './dashboard-nav-links';
import { BusinessSwitcher } from './business-switcher';
import { getActiveBusinessQuiet, getBusinesses } from '@/lib/business';

const NAV_ITEMS = [
  ['branches', '/dashboard/branches'],
  ['feedback', '/dashboard/feedback'],
  ['loyalty', '/dashboard/loyalty'],
  ['messages', '/dashboard/messages'],
  ['analytics', '/dashboard/analytics'],
  ['notifications', '/dashboard/notifications'],
  ['settings', '/dashboard/settings'],
  ['team', '/dashboard/settings/team'],
  ['billing', '/dashboard/billing'],
  ['support', '/support'],
] as const;

export async function DashboardNav() {
  const t = await getTranslations('dashboard');
  // The switcher is optional dashboard chrome. A transient business-list
  // failure must not take down the shared layout and strand every dashboard
  // page behind a global error boundary.
  const [businesses, activeBusiness] = await Promise.all([
    getBusinesses().catch(() => []),
    getActiveBusinessQuiet(),
  ]);

  return (
    <header className="border-b border-neutral-200 bg-white">
      <div className="mx-auto max-w-6xl px-4 py-3 sm:px-6 lg:py-4">
        <div className="flex items-center justify-between gap-3">
          <Link href="/dashboard" aria-label="Echo Grid dashboard home">
            <Logo variant="horizontal" iconSize={28} />
          </Link>
          <nav className="hidden items-center gap-2 lg:flex" aria-label={t('nav.menu')}>
            <DashboardNavLinks
              items={NAV_ITEMS.map(([key, href]) => ({ href, label: t(`nav.${key}`) }))}
            />
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
        {activeBusiness && <div className="mt-3"><BusinessSwitcher businesses={businesses} activeBusinessId={activeBusiness.id} /></div>}
      </div>
    </header>
  );
}
