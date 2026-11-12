import { getTranslations } from 'next-intl/server';
import { canConfigureProgramme, classifyWorkspace, getMyAccess } from '@/lib/permissions';
import { LoyaltySubnavLinks } from './loyalty-subnav-links';
import styles from './loyalty-visual.module.css';

/** Shared staff navigation across account, tier, campaign, QR and settings screens. */
export async function LoyaltySubnav() {
  const t = await getTranslations('loyalty.staff.subnav');
  const access = await getMyAccess();
  // Counter staff work from Serve customers; the administrative sub-navigation is not shown to them.
  if (classifyWorkspace(access) === 'cashier') return null;
  const configure = canConfigureProgramme(access);
  const items = [
    { href: '/dashboard/loyalty', label: t('accounts') },
    ...(configure
      ? [
          { href: '/dashboard/loyalty/tiers', label: t('tiers') },
          { href: '/dashboard/loyalty/rewards', label: t('rewards') },
        ]
      : []),
    { href: '/dashboard/loyalty/redeem', label: t('redeem') },
    { href: '/dashboard/loyalty/scan', label: t('customerQr') },
    { href: '/dashboard/settlements', label: t('settlements') },
    { href: '/dashboard/loyalty/settings', label: t('settings') },
  ];
  return (
    <nav className={styles.subnav} aria-label={t('navigationLabel')}>
      <LoyaltySubnavLinks items={items} />
    </nav>
  );
}
