import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { isCashierAppAvailable } from '@/lib/cashier/host';
import { InstallCapture } from '@/components/cashier/install-capture';

export const metadata: Metadata = {
  title: 'Echo Grid Cashier',
  description: 'Serve customers and handle loyalty at the counter.',
  // The cashier app installs as its own app: its own manifest, scope and start URL.
  manifest: '/cashier/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'Echo Grid Cashier', statusBarStyle: 'default' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: '#10b981', width: 'device-width', initialScale: 1 };

/**
 * CASHIER-PWA-01 C4. Every cashier route sits under this layout, which is the one availability gate: in production
 * the cashier app exists only on the dedicated cashier host (CASHIER_HOST); anywhere else, including the main site,
 * these routes are a plain 404. This does not depend on middleware, which the production runtime skips.
 */
export default async function CashierLayout({ children }: { children: React.ReactNode }) {
  const host = (await headers()).get('host');
  if (!isCashierAppAvailable(host)) notFound();
  return (
    <div className="min-h-dvh bg-neutral-50 text-neutral-900">
      <InstallCapture />
      {children}
    </div>
  );
}
