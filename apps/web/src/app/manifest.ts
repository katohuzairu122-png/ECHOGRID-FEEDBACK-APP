import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { isCashierHost } from '@/lib/cashier/host';
import { cashierManifest } from '@/lib/cashier/manifest';

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  // CASHIER-PWA-01 C4: on the dedicated cashier origin the app that installs is the cashier app, so the root manifest
  // URL (which every page links to) answers with the cashier manifest there. Anywhere else it is unchanged.
  if (isCashierHost((await headers()).get('host'))) return cashierManifest();
  return {
    name: 'Echo Grid',
    short_name: 'Echo Grid',
    description: 'One account. All your loyalties.',
    start_url: '/',
    scope: '/',
    theme_color: '#10b981',
    background_color: '#ffffff',
    display: 'standalone',
    icons: [
      { src: '/icon', sizes: '32x32', type: 'image/png' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
      // 192x192 + 512x512 are the pair Chrome's installability check
      // actually looks for -- the two above are too small to qualify.
      { src: '/pwa-icon-192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa-icon-512', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}
