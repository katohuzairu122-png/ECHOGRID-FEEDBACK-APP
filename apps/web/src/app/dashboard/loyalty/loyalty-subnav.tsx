import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/** Local sub-navigation for the Loyalty module's 5 staff screens -- plain
 * Server Component, no active-link highlighting, matching DashboardNav's
 * own deliberate simplicity (see its file comment). Kept local to this
 * route segment rather than added to the global DashboardNav, since these
 * are second-level pages within Loyalty, not top-level dashboard sections.
 * Async only because getTranslations() is (i18n & Multi-Currency Block 6). */
export async function LoyaltySubnav() {
  const t = await getTranslations('loyalty.staff.subnav');

  return (
    <nav className="flex flex-wrap gap-4 border-b border-neutral-200 pb-3">
      <Link href="/dashboard/loyalty" className="text-sm font-medium text-neutral-700 hover:text-brand-700">
        {t('accounts')}
      </Link>
      <Link href="/dashboard/loyalty/tiers" className="text-sm font-medium text-neutral-700 hover:text-brand-700">
        {t('tiers')}
      </Link>
      <Link href="/dashboard/loyalty/rewards" className="text-sm font-medium text-neutral-700 hover:text-brand-700">
        {t('rewards')}
      </Link>
      <Link href="/dashboard/loyalty/redeem" className="text-sm font-medium text-neutral-700 hover:text-brand-700">
        {t('redeem')}
      </Link>
      <Link href="/dashboard/loyalty/settings" className="text-sm font-medium text-neutral-700 hover:text-brand-700">
        {t('settings')}
      </Link>
    </nav>
  );
}
