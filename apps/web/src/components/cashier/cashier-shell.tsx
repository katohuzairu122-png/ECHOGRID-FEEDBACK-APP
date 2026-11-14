import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ApiError } from '@/lib/api-error';
import { cashierApiFetch } from '@/lib/cashier/auth-api';
import {
  getCashierAccessToken,
  getCashierContext,
  getCashierRefreshToken,
} from '@/lib/cashier/session';
import { CashierTabs } from './cashier-tabs';
import { OfflineBanner } from './offline-banner';

/**
 * The cashier session gate and shell, wrapped around each signed-in cashier page. It is a component rather than a route
 * group layout on purpose: a `(group)` directory puts parentheses in the static chunk URLs, which Cloudflare's asset
 * serving redirects in an endless loop (found on the first staging deployment), so the cashier tree has no route groups.
 *
 * The cashier session gate. No refresh token: sign in. A refresh token but no access token (the 15-minute token
 * lapsed), or an access token the API no longer accepts (session revoked, access removed): the refresh route handler
 * decides, and sends a dead session to the sign-in. Business management is not reachable from here at all: the cashier
 * token can call only the API's eight cashier routes.
 */
export async function CashierShell({ children }: { children: React.ReactNode }) {
  if (!(await getCashierRefreshToken())) redirect('/cashier/login');
  if (!(await getCashierAccessToken())) redirect('/cashier/session/refresh');
  const ctx = await getCashierContext();
  // No usable context cookie: the refresh handler re-issues it from the session (and signs a dead session out).
  if (!ctx) redirect('/cashier/session/refresh');

  let userName: string | null = null;
  try {
    const me = await cashierApiFetch<{ fullName?: string }>('/auth/me');
    userName = me.fullName ?? null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect('/cashier/session/refresh');
    // Any other failure (API unreachable) must not lock the cashier out of the screen; actions report their own errors.
  }

  const t = await getTranslations('cashier');
  return (
    <div className="pb-20">
      <OfflineBanner title={t('offline.title')} body={t('offline.body')} />
      <header className="border-b border-neutral-200 bg-white px-4 py-3">
        <div className="mx-auto max-w-2xl">
          <p className="text-xs text-neutral-500">{t('header.servingAt')}</p>
          <p className="text-lg font-bold leading-tight">
            {ctx.businessName ?? ''}
            {ctx.branchName ? ` · ${ctx.branchName}` : ''}
          </p>
          {userName && <p className="text-xs text-neutral-600">{t('header.signedInAs', { name: userName })}</p>}
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-5">{children}</main>
      <CashierTabs
        label={t('header.nav')}
        tabs={[
          { href: '/cashier', label: t('header.serve') },
          { href: '/cashier/redeem', label: t('header.redeem') },
          { href: '/cashier/account', label: t('header.account') },
        ]}
      />
    </div>
  );
}
