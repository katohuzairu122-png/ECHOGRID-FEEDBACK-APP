import { getTranslations } from 'next-intl/server';
import { logoutAction } from '@/lib/actions/auth';
import { Button } from '@/components/ui';
import { PwaInstallButton } from '@/components/pwa-install-button';
import { WorkspaceNavigation } from '@/components/workspace/workspace-navigation';

export async function DashboardNav() {
  const t = await getTranslations('dashboard');
  return (
    <WorkspaceNavigation
      home="/dashboard"
      label={t('overview.workspace')}
      menuLabel={t('nav.menu')}
      moreLabel={t('nav.more')}
      closeLabel={t('nav.close')}
      items={[
        { href: '/dashboard', label: t('overview.title'), icon: 'store' },
        { href: '/dashboard/feedback', label: t('nav.feedback'), icon: 'chat' },
        { href: '/dashboard/loyalty', label: t('nav.loyalty'), icon: 'star' },
        { href: '/dashboard/analytics', label: t('nav.analytics'), icon: 'chart' },
        { href: '/dashboard/branches', label: t('nav.branches'), icon: 'store' },
        { href: '/dashboard/loyalty/scan', label: t('nav.customerQr'), icon: 'qr' },
        { href: '/dashboard/settlements', label: t('nav.settlements'), icon: 'gift' },
        { href: '/dashboard/messages', label: t('nav.messages'), icon: 'chat' },
        { href: '/dashboard/notifications', label: t('nav.notifications'), icon: 'bell' },
        { href: '/dashboard/settings', label: t('nav.settings'), icon: 'settings' },
        { href: '/dashboard/settings/team', label: t('nav.team'), icon: 'users' },
        { href: '/dashboard/billing', label: t('nav.billing'), icon: 'shield' },
        { href: '/support', label: t('nav.support'), icon: 'chat' },
      ]}
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
