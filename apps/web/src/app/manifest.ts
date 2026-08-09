import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Echo Grid',
    short_name: 'Echo Grid',
    description: 'Every Voice Drives Better Decisions.',
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
