import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { CurrentUserDto } from '@echo-grid-feedback/shared-types';
import { logoutAction } from '@/lib/actions/auth';
import { Badge, Button } from '@/components/ui';

type PlatformRole = NonNullable<CurrentUserDto['platformRole']>;

const ROLE_LABEL_KEYS: Record<PlatformRole, string> = {
  support: 'roleLabels.support',
  billing: 'roleLabels.billing',
  admin: 'roleLabels.admin',
};

interface PlatformNavProps {
  role: PlatformRole;
}

/**
 * Mirrors dashboard/dashboard-nav.tsx's structure/styling exactly -- same
 * header layout, same bare-Server-Action logout form -- so the console
 * reads as part of the same product, not a bolted-on separate app.
 * Directory and Audit Log links added in Block 6, now that those pages
 * exist -- grew this the same way dashboard-nav.tsx grew incrementally as
 * each of ITS modules shipped, not all at once. No separate "Impersonation"
 * link (Block 7): impersonation is an action taken from a business's team
 * list (businesses/[id]/page.tsx), not a screen of its own. Billing (Block
 * 10) is one link, not two -- it points at the subscriptions/MRR dashboard;
 * the plan catalog is reached via a cross-link from inside that page (same
 * "View audit log →" cross-link pattern as businesses/[id]/page.tsx), since
 * this nav has no sub-navigation concept yet and one more top-level link for
 * what's really a nested concern would be premature.
 */
export async function PlatformNav({ role }: PlatformNavProps) {
  const t = await getTranslations('platform.nav');

  return (
    <header className="border-b border-neutral-200 bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <Link href="/platform" className="text-lg font-semibold text-neutral-900">
              {t('brand')}
            </Link>
            <Badge variant="accent">{t(ROLE_LABEL_KEYS[role])}</Badge>
          </div>
          <nav className="flex items-center gap-4">
            <Link
              href="/platform/businesses"
              className="text-sm text-neutral-600 hover:text-neutral-900"
            >
              {t('directory')}
            </Link>
            <Link
              href="/platform/audit-log"
              className="text-sm text-neutral-600 hover:text-neutral-900"
            >
              {t('auditLog')}
            </Link>
            <Link
              href="/platform/billing"
              className="text-sm text-neutral-600 hover:text-neutral-900"
            >
              {t('billing')}
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="text-sm text-neutral-600 hover:text-neutral-900">
            {t('backToDashboard')}
          </Link>
          <form action={logoutAction}>
            <Button type="submit" variant="ghost" size="sm">
              {t('logout')}
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
