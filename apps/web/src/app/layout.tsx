import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import './globals.css';

export const metadata: Metadata = {
  title: 'Echo Grid Feedback',
  description: 'Enterprise Customer Experience Platform',
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
    <html lang={locale}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
