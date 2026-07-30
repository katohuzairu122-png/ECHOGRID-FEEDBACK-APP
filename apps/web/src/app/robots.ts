import type { MetadataRoute } from 'next';
import { APP_URL } from '@/lib/app-url';

/**
 * Allows the new public landing page + auth pages, disallows everything
 * behind auth (dashboard/platform/loyalty) and the anonymous-but-not-
 * meant-to-be-indexed QR feedback surface. Deviates from the plan's
 * original "disallow all" default since a real public landing page is now
 * in scope (Phase 5) and should actually be indexable.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/login', '/signup'],
      disallow: ['/dashboard', '/platform', '/loyalty', '/feedback'],
    },
    sitemap: `${APP_URL}/sitemap.xml`,
  };
}
