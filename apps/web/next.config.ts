import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @echo-grid-feedback/shared-types ships raw .ts source (no build step -- see
  // its package.json), and Next.js doesn't transpile node_modules/symlinked
  // workspace packages by default. First needed now that apps/web actually
  // imports from it (Branch Mgmt Block 4's BusinessDto).
  transpilePackages: ['@echo-grid-feedback/shared-types'],
};

// i18n & Multi-Currency Block 2 -- this app has no [locale] URL segment
// (locale is business-configured, not chosen via the URL), so next-intl is
// wired in its "without i18n routing" mode. The plugin's only job in that
// mode is pointing the bundler at i18n/request.ts so it can be resolved on
// the server; see that file for how locale is actually determined.
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

export default withNextIntl(nextConfig);
