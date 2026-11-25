import { getTranslations } from 'next-intl/server';
import { logoutAction } from '@/lib/actions/auth';
import { Button } from '@/components/ui';
import { PwaInstallButton } from '@/components/pwa-install-button';
import {
  WorkspaceNavigation,
  type WorkspaceNavItem,
} from '@/components/workspace/workspace-navigation';
import { canViewCommunityHub, classifyWorkspace, getMyAccess } from '@/lib/permissions';
import { CASHIER_HOME, COMMUNITY_HOME, OVERVIEW_HOME } from '@/lib/workspace-guard';

/** Permission each management destination needs to appear. Presentation only: the API enforces each one. */
const REQUIRED: Record<string, string | undefined> = {
  // '/dashboard/community' is gated by canViewCommunityHub (any of several permissions), not by a single key.
  '/dashboard/loyalty/scan': 'loyalty:serve',
  '/dashboard/feedback': 'feedback:view',
  '/dashboard/loyalty': 'loyalty:accounts:view',
  '/dashboard/analytics': 'analytics:view',
  '/dashboard/branches': 'branches:view',
  '/dashboard/settlements': 'settlement:view',
  '/dashboard/surveys': 'survey:view',
  '/dashboard/messages': 'messages:view',
  '/dashboard/notifications': 'notifications:view',
  '/dashboard/settings': 'business:manage_settings',
  '/dashboard/settings/team': 'team:view',
  '/dashboard/billing': 'billing:view',
};

export async function DashboardNav() {
  const t = await getTranslations('dashboard');
  const access = await getMyAccess();
  const kind = classifyWorkspace(access);
  const support: WorkspaceNavItem = { href: '/support', label: t('nav.support'), icon: 'chat' };

  // BCOMM-01: Community is the FIRST item (one entry, no duplicates). Customers and rewards live inside Loyalty, so Loyalty carries them; the
  // Business Overview keeps its own destination. The mobile bar shows the first three items plus More, so it reads Community, Loyalty, Feedback.
  const all: WorkspaceNavItem[] = [
    { href: COMMUNITY_HOME, label: t('nav.community'), icon: 'users' },
    { href: '/dashboard/loyalty', label: t('nav.loyalty'), icon: 'star' },
    { href: '/dashboard/feedback', label: t('nav.feedback'), icon: 'chat' },
    { href: '/dashboard/loyalty/scan', label: t('nav.serve'), icon: 'qr', hardNavigation: true },
    { href: '/dashboard/analytics', label: t('nav.analytics'), icon: 'chart' },
    { href: OVERVIEW_HOME, label: t('overview.title'), icon: 'store' },
    { href: '/dashboard/branches', label: t('nav.branches'), icon: 'store' },
    { href: '/dashboard/settlements', label: t('nav.settlements'), icon: 'gift' },
    { href: '/dashboard/surveys', label: t('nav.surveys'), icon: 'chart' },
    { href: '/dashboard/messages', label: t('nav.messages'), icon: 'chat', badgeSource: 'staff-messages' },
    { href: '/dashboard/notifications', label: t('nav.notifications'), icon: 'bell' },
    { href: '/dashboard/settings', label: t('nav.settings'), icon: 'settings' },
    { href: '/dashboard/settings/team', label: t('nav.team'), icon: 'users' },
    { href: '/dashboard/billing', label: t('nav.billing'), icon: 'shield' },
    support,
  ];

  // One counter entry: "Serve customers". The Cashier app page (open/install the cashier app, sign-in sessions, activity, cashier accounts) is reached
  // from inside Serve customers, not from a second tab.
  // Cashier: Serve customers is the home and the only workspace; no administrative navigation at all.
  // Unavailable (permissions unconfirmed): nothing privileged is implied; only support and sign-out.
  // Management: only destinations the effective permissions allow.
  const items: WorkspaceNavItem[] =
    kind === 'cashier'
      ? [{ href: CASHIER_HOME, label: t('nav.serve'), icon: 'qr', hardNavigation: true }, support]
      : kind === 'unavailable'
        ? [support]
        : all.filter((item) => {
            if (item.href === COMMUNITY_HOME) return canViewCommunityHub(access);
            const need = REQUIRED[item.href];
            return !need || access.permissions.has(need);
          });

  return (
    <WorkspaceNavigation
      home={kind === 'cashier' ? CASHIER_HOME : canViewCommunityHub(access) ? COMMUNITY_HOME : OVERVIEW_HOME}
      {...(kind === 'cashier' ? { primaryCount: 1 } : kind === 'management' ? { primaryCount: 3 } : {})}
      label={t('overview.workspace')}
      menuLabel={t('nav.menu')}
      moreLabel={t('nav.more')}
      closeLabel={t('nav.close')}
      items={items}
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
