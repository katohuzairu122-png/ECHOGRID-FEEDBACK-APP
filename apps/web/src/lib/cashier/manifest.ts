import type { MetadataRoute } from 'next';

/**
 * The cashier app's web app manifest: its own identity, scope and start URL, so it installs as a separate app from the
 * main Echo Grid PWA and is confined to /cashier/. Icons reuse the existing brand icon routes (same mark, no new asset).
 */
export function cashierManifest(): MetadataRoute.Manifest {
  return {
    name: 'Echo Grid Cashier',
    short_name: 'Cashier',
    description: 'Serve customers and handle loyalty at the counter.',
    id: '/cashier',
    start_url: '/cashier/',
    scope: '/cashier/',
    display: 'standalone',
    orientation: 'any',
    theme_color: '#10b981',
    background_color: '#ffffff',
    icons: [
      { src: '/pwa-icon-192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa-icon-512', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}
