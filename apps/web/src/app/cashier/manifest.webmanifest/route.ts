import { headers } from 'next/headers';
import { isCashierAppAvailable } from '@/lib/cashier/host';
import { cashierManifest } from '@/lib/cashier/manifest';

/** The cashier manifest at its own path (used directly in development; the cashier host also serves it at /manifest.webmanifest). */
export async function GET() {
  if (!isCashierAppAvailable((await headers()).get('host'))) {
    return new Response('Not found', { status: 404 });
  }
  return new Response(JSON.stringify(cashierManifest()), {
    headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' },
  });
}
