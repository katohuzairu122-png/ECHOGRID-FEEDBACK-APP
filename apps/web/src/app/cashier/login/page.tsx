import { redirect } from 'next/navigation';
import { getCashierAccessToken, getCashierRefreshToken } from '@/lib/cashier/session';
import { CashierLoginForm } from './cashier-login-form';

/**
 * `reason` is set by the refresh handler when it could not restore a session: the form is then shown unconditionally,
 * so a refusal can never bounce between the sign-in and the app. Otherwise a device that already has a session goes
 * straight to the counter (the layout re-validates it) and a lapsed access token is renewed by the refresh handler.
 */
export default async function CashierLoginPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  if (!reason) {
    if (await getCashierAccessToken()) redirect('/cashier');
    if (await getCashierRefreshToken()) redirect('/cashier/session/refresh');
  }
  return <CashierLoginForm />;
}
