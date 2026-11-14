import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { isCashierHost } from './host';

/**
 * CASHIER-PWA-01 C4: the dedicated cashier origin serves the cashier app and nothing else a staff member could sign in
 * to. The business dashboard, platform console, and staff/recovery sign-in pages send a request that arrives on the
 * cashier host to the cashier app instead. Render-time (not middleware) because the production runtime skips
 * middleware. No-op everywhere when CASHIER_HOST is unset.
 */
export async function keepStaffSurfacesOffCashierHost(): Promise<void> {
  if (isCashierHost((await headers()).get('host'))) redirect('/cashier');
}
