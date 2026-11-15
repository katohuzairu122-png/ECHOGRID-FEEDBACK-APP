import 'server-only';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { isCashierAppAvailable, isCashierHost } from './host';

/**
 * CASHIER-PWA-01 C4: the dedicated cashier origin serves the cashier app and nothing else a staff member could sign in
 * to. The business dashboard, platform console, and staff/recovery sign-in pages send a request that arrives on the
 * cashier host to the cashier app instead. Render-time (not middleware) because the production runtime skips
 * middleware. No-op everywhere when CASHIER_HOST is unset.
 */
export async function keepStaffSurfacesOffCashierHost(): Promise<void> {
  if (isCashierHost((await headers()).get('host'))) redirect('/cashier');
}

/** The Host the browser addressed, or null outside a request scope. Only the Host header is used: forwarded-host headers are never consulted. */
export async function currentHost(): Promise<string | null> {
  try {
    return (await headers()).get('host');
  } catch {
    return null;
  }
}

/**
 * SEC-CASHIER-R2 F4: server actions run before any layout, so a page-level guard does not cover them. Every cashier
 * action calls this first: on any host other than the cashier host (in production) it is a 404, so a forged POST that
 * carries a cashier action id to the main site does nothing.
 */
export async function requireCashierOrigin(): Promise<void> {
  if (!isCashierAppAvailable(await currentHost())) notFound();
}

/** True when this request addressed the dedicated cashier origin. */
export async function onCashierHost(): Promise<boolean> {
  return isCashierHost(await currentHost());
}

/**
 * SEC-CASHIER-R2 F4: staff sessions and staff API calls never happen on the cashier-only origin. Used by the staff
 * session setters and the staff API client, so a forged staff action invoked on the cashier host cannot create a staff
 * session there or call the staff API with one.
 */
export async function refuseOnCashierHost(): Promise<void> {
  if (await onCashierHost()) notFound();
}
