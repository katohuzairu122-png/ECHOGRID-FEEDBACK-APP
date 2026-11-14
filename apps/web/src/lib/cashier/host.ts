/**
 * CASHIER-PWA-01 C4 / SEC-CASHIER-R2 F5: where the cashier app may be served. Pure, no server-only guard, so layouts,
 * route handlers, actions and tests can share it.
 *
 * FAILS CLOSED. The cashier app is served only on the host named by CASHIER_HOST, and only when that value is a plain,
 * well-formed host name. An unset, empty, malformed (a URL, a path, spaces, wildcard) or mismatched value serves
 * nothing, whatever NODE_ENV says: no code path treats a missing or unexpected NODE_ENV as permission.
 *
 * The one exception is an explicit local-development opt-in, CASHIER_DEV_ANY_HOST=1 (committed only in
 * apps/web/.env.development, which Next.js loads for `next dev` alone). It is ignored when NODE_ENV is "production", so
 * a stray copy of the variable cannot open a deployed Worker.
 */
export const CASHIER_BASE_PATH = '/cashier';

// Lower-case DNS labels separated by dots: "cashier.echo-grid.uk", "cashier.localhost", "localhost". No scheme, port,
// path, userinfo, wildcard or whitespace.
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function normalizeHost(host: string | null | undefined): string {
  return (host ?? '').trim().toLowerCase().replace(/:\d+$/, '');
}

/** The configured cashier host, or null when unset or malformed. */
export function configuredCashierHost(value: string | undefined = process.env.CASHIER_HOST): string | null {
  const host = normalizeHost(value);
  return host !== '' && HOST_PATTERN.test(host) ? host : null;
}

export function isCashierHost(host: string | null | undefined, cashierHost: string | undefined = process.env.CASHIER_HOST): boolean {
  const configured = configuredCashierHost(cashierHost);
  return configured !== null && normalizeHost(host) === configured;
}

type Env = { CASHIER_HOST?: string | undefined; CASHIER_DEV_ANY_HOST?: string | undefined; CASHIER_APP_URL?: string | undefined; NODE_ENV?: string | undefined };

/** Explicit local-development opt-in; never honoured in production. */
export function isDevAnyHostEnabled(env: Env = process.env): boolean {
  return env.CASHIER_DEV_ANY_HOST === '1' && env.NODE_ENV !== 'production';
}

export function isCashierAppAvailable(host: string | null | undefined, env: Env = process.env): boolean {
  if (isDevAnyHostEnabled(env)) return true;
  return isCashierHost(host, env.CASHIER_HOST);
}

/** Where the dashboard's "Open Cashier App" sends the user: the configured cashier origin, or the local path in opted-in development. */
export function cashierAppUrl(env: Env = process.env): string | null {
  const configured = env.CASHIER_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '') + CASHIER_BASE_PATH;
  return isDevAnyHostEnabled(env) ? CASHIER_BASE_PATH : null;
}
