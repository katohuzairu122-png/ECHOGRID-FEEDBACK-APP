import { getTranslations } from 'next-intl/server';
import { LoyaltySubnavLinks } from './loyalty-subnav-links';

/** Local sub-navigation for Loyalty staff screens. */
export async function LoyaltySubnav() {
  const t = await getTranslations('loyalty.staff.subnav');
  const items = [
    { href: '/dashboard/loyalty/branches', label: 'Branch purchase loyalty' },
    { href: '/dashboard/loyalty', label: t('accounts') },
    { href: '/dashboard/loyalty/tiers', label: t('tiers') },
    { href: '/dashboard/loyalty/rewards', label: t('rewards') },
    { href: '/dashboard/loyalty/redeem', label: t('redeem') },
    { href: '/dashboard/loyalty/settings', label: t('settings') },
  ];
  return <nav className="flex flex-wrap gap-2 border-b border-neutral-200 pb-3"><LoyaltySubnavLinks items={items} /></nav>;
}
