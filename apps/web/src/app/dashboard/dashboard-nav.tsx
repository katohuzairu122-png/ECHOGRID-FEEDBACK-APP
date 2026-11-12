import { getTranslations } from 'next-intl/server';
import { logoutAction } from '@/lib/actions/auth';
import { Button } from '@/components/ui';
import { PwaInstallButton } from '@/components/pwa-install-button';
import {
  WorkspaceNavigation,
  type WorkspaceNavItem,
} from '@/components/workspace/workspace-navigation';
import { getMyAccess, isCounterStaff } from '@/lib/permissions';

export async function DashboardNav() {
  const t = await getTranslations('dashboard');
  const access = await getMyAccess();
  const counterStaff = isCounterStaff(access);

  // Cashier: "Serve customers" is the home page and the only primary destination; the customer
  // list and the rest sit in the menu. Business configuration (analytics, branches, billing,
  // team, tiers) is not shown. The API still enforces every permission.
  const counterItems: WorkspaceNavItem[] = [
    { href: '/dashboard/loyalty/scan', label: t('nav.serve'), icon: 'qr' },
    { href: '/dashboard/loyalty', label: t('nav.customers'), icon: 'users' },
    ...(access.permissions.has('feedback:view')
      ? [{ href: '/dashboard/feedback', label: t('nav.feedback'), icon: 'chat' as const }]
      : []),
    ...(access.permissions.has('messages:view')
      ? [{ href: '/dashboard/messages', label: t('nav.messages'), icon: 'chat' as const }]
      : []),
    { href: '/support', label: t('nav.support'), icon: 'chat' },
  ];
  const fullItems: WorkspaceNavItem[] = [
    { href: '/dashboard', label: t('overview.title'), icon: 'store' },
    { href: '/dashboard/loyalty/scan', label: t('nav.serve'), icon: 'qr' },
    { href: '/dashboard/feedback', label: t('nav.feedback'), icon: 'chat' },
    { href: '/dashboard/loyalty', label: t('nav.loyalty'), icon: 'star' },
    { href: '/dashboard/analytics', label: t('nav.analytics'), icon: 'chart' },
    { href: '/dashboard/branches', label: t('nav.branches'), icon: 'store' },
    { href: '/dashboard/settlements', label: t('nav.settlements'), icon: 'gift' },
    { href: '/dashboard/messages', label: t('nav.messages'), icon: 'chat' },
    { href: '/dashboard/notifications', label: t('nav.notifications'), icon: 'bell' },
    { href: '/dashboard/settings', label: t('nav.settings'), icon: 'settings' },
    { href: '/dashboard/settings/team', label: t('nav.team'), icon: 'users' },
    { href: '/dashboard/billing', label: t('nav.billing'), icon: 'shield' },
    { href: '/support', label: t('nav.support'), icon: 'chat' },
  ];

  return (
    <WorkspaceNavigation
      home={counterStaff ? '/dashboard/loyalty/scan' : '/dashboard'}
      {...(counterStaff ? { primaryCount: 1 } : {})}
      label={t('overview.workspace')}
      menuLabel={t('nav.menu')}
      moreLabel={t('nav.more')}
      closeLabel={t('nav.close')}
      items={counterStaff ? counterItems : fullItems}
      utilities={
        <>
          <PwaInstallButton label={t('nav.installApp')} iosHint={t('nav.installIosHint')} />
          <form action={logoutAction}>
            <Button type="submit" variant="ghost">
              {t('nav.logout')}
            </Button>
          </form>
        </>
      }
    />
  );
}
