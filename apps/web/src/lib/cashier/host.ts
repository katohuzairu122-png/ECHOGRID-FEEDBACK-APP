/**
 * CASHIER-PWA-01 C4: where the cashier app may be served. Pure, no server-only guard, so layouts, route handlers and
 * tests can share it.
 *
 * Production: only on the host named by CASHIER_HOST (the dedicated cashier origin). Unset means the cashier app is not
 * deployed there at all, and every cashier route is a 404, which is the safe default for the existing main Worker.
 * Development and test: available on any host under /cashier, so it can be built and exercised locally.
 */
export const CASHIER_BASE_PATH = '/cashier';

export function normalizeHost(host: string | null | undefined): string {
  return (host ?? '').trim().toLowerCase().replace(/:\d+$/, '');
}

export function isCashierHost(host: string | null | undefined, cashierHost = process.env.CASHIER_HOST): boolean {
  const configured = normalizeHost(cashierHost);
  return configured !== '' && normalizeHost(host) === configured;
}

export function isCashierAppAvailable(
  host: string | null | undefined,
  env: { CASHIER_HOST?: string | undefined; NODE_ENV?: string | undefined } = process.env,
): boolean {
  if (env.NODE_ENV !== 'production') return true;
  return isCashierHost(host, env.CASHIER_HOST);
}

/** Where the dashboard's "Open Cashier App" sends the user: the configured cashier origin, or the local path in development. */
export function cashierAppUrl(env: { CASHIER_APP_URL?: string | undefined; NODE_ENV?: string | undefined } = process.env): string | null {
  const configured = env.CASHIER_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '') + CASHIER_BASE_PATH;
  return env.NODE_ENV === 'production' ? null : CASHIER_BASE_PATH;
}
