import { keepStaffSurfacesOffCashierHost } from '@/lib/cashier/host-guard';
import { redirect } from 'next/navigation';
import { hasSession, isImpersonating } from '@/lib/session';
import { getTranslations } from 'next-intl/server';
import { WorkspaceShell } from '@/components/workspace/workspace-shell';
import { BusinessSwitcher } from './business-switcher';
import { getBusinesses, getActiveBusinessQuiet } from '@/lib/business';
import { DashboardNav } from './dashboard-nav';
import { ImpersonationBanner } from './impersonation-banner';

/**
 * Defense-in-depth: middleware.ts already redirects unauthenticated
 * requests before they get this far, but this layout re-checks so the
 * dashboard is never one middleware config mistake away from being
 * unprotected.
 *
 * isImpersonating() (Platform Admin Console Block 7) is a free cookie
 * presence check, same cost class as hasSession() above -- the banner
 * component it conditionally mounts is what pays for the /auth/me call
 * that gets the impersonated user's name/email, and only when actually
 * impersonating, not on every dashboard page load for every ordinary user.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  await keepStaffSurfacesOffCashierHost();
  if (!(await hasSession())) {
    redirect('/login');
  }

  const impersonating = await isImpersonating();
  const t = await getTranslations('common.workspace');
  const [businesses, business] = await Promise.all([
    getBusinesses().catch(() => []),
    getActiveBusinessQuiet(),
  ]);

  return (
    <WorkspaceShell
      navigation={<DashboardNav />}
      skipLabel={t('skip')}
      context={
        <>
          <p className="text-sm font-semibold">{business?.name ?? t('business')}</p>
          {business && <BusinessSwitcher businesses={businesses} activeBusinessId={business.id} />}
        </>
      }
    >
      {impersonating && <ImpersonationBanner />}
      {children}
    </WorkspaceShell>
  );
}
