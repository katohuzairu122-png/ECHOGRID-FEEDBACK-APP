import type { Metadata, Viewport } from 'next';
import { Poppins } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { APP_URL } from '@/lib/app-url';
import { PwaServiceWorkerRegistration } from '@/components/pwa-service-worker-registration';
import { formats } from '@/i18n/formats';
import './globals.css';

// Poppins is not a variable font on Google Fonts, so specific weights must
// be listed. Exposed as --font-poppins (applied to <html> below), which
// globals.css's --font-sans already references as its first choice --
// every element gets Poppins by default with no per-component font class
// needed. display: 'swap' avoids invisible text while the webfont loads.
const poppins = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-poppins',
  display: 'swap',
});

const TAGLINE = 'Every Voice Drives Better Decisions.';
const DESCRIPTION = `Echo Grid — ${TAGLINE} AI-powered customer feedback, loyalty, and sentiment analytics for multi-branch businesses. An INFINICUS company.`;

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: { default: 'Echo Grid', template: '%s · Echo Grid' },
  description: DESCRIPTION,
  openGraph: {
    title: 'Echo Grid',
    description: DESCRIPTION,
    siteName: 'Echo Grid',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Echo Grid',
    description: DESCRIPTION,
  },
  // iOS ignores manifest.ts's display/theme_color for "Add to Home Screen";
  // these are the meta tags Safari actually reads for the same effect.
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Echo Grid',
  },
};

export const viewport: Viewport = {
  themeColor: '#10b981',
};

/**
 * Wraps the whole app in a NextIntlClientProvider using the request-level
 * locale/messages resolved by i18n/request.ts (i18n & Multi-Currency
 * Block 2) -- every page gets a valid translation context by default, even
 * ones that don't need a locale different from that default. The
 * customer dashboard subtree and the two anonymous QR pages nest their own
 * provider further down the tree to override this with a specific
 * business's locale; see i18n/request.ts's top comment for the full
 * 3-context design.
 */
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [locale, messages] = await Promise.all([getLocale(), getMessages()]);

  return (
    <html lang={locale} className={poppins.variable}>
      <body>
        {/* `formats` passed explicitly rather than relied on being inherited
            from i18n/request.ts through the server context. Same reasoning as
            wrangler.toml's explicit NODE_ENV: inheritance here probably works,
            but "probably" is not worth a silent fallback to String(date)
            across 18 call sites, and the prop costs nothing. */}
        <NextIntlClientProvider locale={locale} messages={messages} formats={formats}>
          {children}
        </NextIntlClientProvider>
        <PwaServiceWorkerRegistration />
      </body>
    </html>
  );
}
