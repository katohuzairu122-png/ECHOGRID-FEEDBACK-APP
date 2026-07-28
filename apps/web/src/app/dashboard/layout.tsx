import { redirect } from 'next/navigation';
import { hasSession, isImpersonating } from '@/lib/session';
import { AppFooter } from '@/components/brand';
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
  if (!(await hasSession())) {
    redirect('/login');
  }

  const impersonating = await isImpersonating();

  return (
    <div className="min-h-screen bg-neutral-50">
      {impersonating && <ImpersonationBanner />}
      <DashboardNav />
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
      <AppFooter />
    </div>
  );
}
