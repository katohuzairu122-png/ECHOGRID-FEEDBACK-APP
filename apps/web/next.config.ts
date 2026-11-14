import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @echo-grid-feedback/shared-types ships raw .ts source (no build step -- see
  // its package.json), and Next.js doesn't transpile node_modules/symlinked
  // workspace packages by default. First needed now that apps/web actually
  // imports from it (Branch Mgmt Block 4's BusinessDto).
  transpilePackages: ['@echo-grid-feedback/shared-types'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value:
              "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'",
          },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      // The staff QR scanner (components/qr-camera-scanner.tsx) is the only camera user. The site-wide policy above
      // denies the camera everywhere, which made "Scan" fail with "The camera could not be opened" on a phone
      // (found by CASHIER-PWA-DEPLOY-01 device verification). These routes alone allow THIS origin's own pages to
      // ask for the camera (the browser still prompts); embedded third-party frames stay denied (and framing is
      // already forbidden), microphone and geolocation stay denied. A later matching header overrides an earlier one.
      {
        source: '/cashier/:path*',
        headers: [{ key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' }],
      },
      {
        source: '/dashboard/loyalty/scan',
        headers: [{ key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' }],
      },
    ];
  },
};

// i18n & Multi-Currency Block 2 -- this app has no [locale] URL segment
// (locale is business-configured, not chosen via the URL), so next-intl is
// wired in its "without i18n routing" mode. The plugin's only job in that
// mode is pointing the bundler at i18n/request.ts so it can be resolved on
// the server; see that file for how locale is actually determined.
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

export default withNextIntl(nextConfig);

