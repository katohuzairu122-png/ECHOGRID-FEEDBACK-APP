import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { CurrentUserDto } from '@echo-grid-feedback/shared-types';
import { logoutAction } from '@/lib/actions/auth';
import { Badge, Button } from '@/components/ui';
import { Logo } from '@/components/brand';
import { PlatformMobileNav } from './platform-mobile-nav';

type PlatformRole = NonNullable<CurrentUserDto['platformRole']>;

const ROLE_LABEL_KEYS: Record<PlatformRole, string> = {
  support: 'roleLabels.support',
  billing: 'roleLabels.billing',
  admin: 'roleLabels.admin',
};

const NAV_ITEMS = [
  ['directory', '/platform/businesses'],
  ['auditLog', '/platform/audit-log'],
  ['billing', '/platform/billing'],
] as const;

const linkClassName = 'text-sm text-neutral-600 hover:text-neutral-900';

interface PlatformNavProps {
  role: PlatformRole;
}

export async function PlatformNav({ role }: PlatformNavProps) {
  const t = await getTranslations('platform.nav');
  const mobileItems = [
    ...NAV_ITEMS.map(([key, href]) => ({ href, label: t(key) })),
    { href: '/dashboard', label: t('backToDashboard') },
  ];

  return (
    <header className="border-b border-neutral-200 bg-white">
      <div className="mx-auto max-w-5xl px-4 py-3 sm:px-6 lg:py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-6">
            <Link href="/platform" aria-label="Echo Grid platform admin home">
              <Logo variant="horizontal" iconSize={28} />
            </Link>
            <div className="hidden items-center gap-3 lg:flex">
              <span className="text-sm font-medium text-neutral-500">{t('brand')}</span>
              <Badge variant="accent">{t(ROLE_LABEL_KEYS[role])}</Badge>
            </div>
            <nav className="hidden items-center gap-4 lg:flex" aria-label={t('menu')}>
              {NAV_ITEMS.map(([key, href]) => (
                <Link key={key} href={href} className={linkClassName}>
                  {t(key)}
                </Link>
              ))}
            </nav>
          </div>
          <div className="hidden items-center gap-4 lg:flex">
            <Link href="/dashboard" className={linkClassName}>
              {t('backToDashboard')}
            </Link>
            <form action={logoutAction}>
              <Button type="submit" variant="ghost" size="sm">
                {t('logout')}
              </Button>
            </form>
          </div>
          <PlatformMobileNav items={mobileItems} menuLabel={t('menu')} logoutLabel={t('logout')} />
        </div>
      </div>
    </header>
  );
}
