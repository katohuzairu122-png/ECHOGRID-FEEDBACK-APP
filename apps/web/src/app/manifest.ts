import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Echo Grid',
    short_name: 'Echo Grid',
    description: 'Every Voice Drives Better Decisions.',
    theme_color: '#10b981',
    background_color: '#ffffff',
    display: 'standalone',
    icons: [
      { src: '/icon', sizes: '32x32', type: 'image/png' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  };
}
