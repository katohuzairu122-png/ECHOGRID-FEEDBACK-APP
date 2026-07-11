import { getTranslations } from 'next-intl/server';
import { getCurrentUser } from '@/lib/platform';
import { stopImpersonationAction } from '@/lib/actions/platform';
import { Button } from '@/components/ui';

/**
 * Only mounted when lib/session.ts's isImpersonating() (a free cookie
 * presence check) is true -- see dashboard/layout.tsx -- so the /auth/me
 * call this makes is paid only during an actual impersonation session, not
 * on every dashboard page load for every ordinary user. Always visible
 * while impersonating (rendered in the layout, not a page), by design: an
 * admin must never be able to navigate somewhere within the dashboard and
 * lose track of the fact that they're viewing it as someone else.
 */
export async function ImpersonationBanner() {
  const [t, user] = await Promise.all([
    getTranslations('dashboard.impersonationBanner'),
    getCurrentUser(),
  ]);

  // Defensive only -- isImpersonating() already confirmed the cookie flag is
  // set before this component was mounted; user should always resolve here.
  if (!user) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 bg-warning/10 px-6 py-3 text-sm text-warning">
      <p>
        <strong className="font-semibold">{t('label')}</strong>{' '}
        {t('viewingAs', { name: user.fullName, email: user.email })}
      </p>
      <form action={stopImpersonationAction}>
        <Button type="submit" variant="outline" size="sm">
          {t('stop')}
        </Button>
      </form>
    </div>
  );
}
