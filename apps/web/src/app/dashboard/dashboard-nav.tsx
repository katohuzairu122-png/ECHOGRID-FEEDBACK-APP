import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { logoutAction } from '@/lib/actions/auth';
import { Button } from '@/components/ui';

/**
 * Server Component -- async only because getTranslations() is (i18n &
 * Multi-Currency Block 4). The logout <form> still needs no
 * useActionState: it's a bare Server Action reference, and logout either
 * works or the user just tries again.
 *
 * Deliberately does NOT fetch the current user to conditionally show a
 * "Platform Admin" link -- that would add an extra /auth/me round trip to
 * EVERY dashboard page load (this component is in the shared layout) for
 * the overwhelming majority of users who will never have a platformRole.
 * That entry point lives on dashboard/page.tsx instead (Platform Admin
 * Console Block 5) -- one page, visited once per session in the common
 * case, not every navigation.
 */
export async function DashboardNav() {
  const t = await getTranslations('dashboard');

  return (
    <header className="border-b border-neutral-200 bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-6">
          <Link href="/dashboard" className="text-lg font-semibold text-neutral-900">
            Echo Grid Feedback
          </Link>
          <nav className="flex items-center gap-4">
            <Link
              href="/dashboard/branches"
              className="text-sm text-neutral-600 hover:text-neutral-900"
            >
              {t('nav.branches')}
            </Link>
            <Link
              href="/dashboard/feedback"
              className="text-sm text-neutral-600 hover:text-neutral-900"
            >
              {t('nav.feedback')}
            </Link>
            <Link
              href="/dashboard/loyalty"
              className="text-sm text-neutral-600 hover:text-neutral-900"
            >
              {t('nav.loyalty')}
            </Link>
            <Link
              href="/dashboard/analytics"
              className="text-sm text-neutral-600 hover:text-neutral-900"
            >
              {t('nav.analytics')}
            </Link>
            <Link
              href="/dashboard/notifications"
              className="text-sm text-neutral-600 hover:text-neutral-900"
            >
              {t('nav.notifications')}
            </Link>
            <Link
              href="/dashboard/settings"
              className="text-sm text-neutral-600 hover:text-neutral-900"
            >
              {t('nav.settings')}
            </Link>
            <Link
              href="/dashboard/billing"
              className="text-sm text-neutral-600 hover:text-neutral-900"
            >
              {t('nav.billing')}
            </Link>
          </nav>
        </div>
        <form action={logoutAction}>
          <Button type="submit" variant="ghost" size="sm">
            {t('nav.logout')}
          </Button>
        </form>
      </div>
    </header>
  );
}
