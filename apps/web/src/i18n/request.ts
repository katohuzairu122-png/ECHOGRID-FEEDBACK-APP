import 'server-only';
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, DEFAULT_TIMEZONE, resolveSupportedLocale } from '@echo-grid-feedback/shared-types';
import { getActiveBusinessQuiet } from '@/lib/business';
import { hasSession } from '@/lib/session';
import { loadMessages } from './load-messages';

/**
 * Root-level locale/timezone resolution (i18n & Multi-Currency Block 2).
 *
 * This app has no [locale] URL segment -- locale is business-configured,
 * not user-chosen -- so next-intl runs in its "without i18n routing" mode
 * and this function is entirely responsible for deciding the locale.
 *
 * It resolves the STAFF caller's active business (same lookup
 * dashboard pages already use, via the quiet/non-redirecting variant --
 * see lib/business.ts) and falls back to DEFAULT_LOCALE/DEFAULT_TIMEZONE
 * whenever that fails: not logged in, on /login, or any of the
 * anonymous/customer surfaces that resolve their OWN specific business
 * further down the tree and override this request-level default via a
 * nested NextIntlClientProvider -- see
 * app/loyalty/dashboard/[businessId]/layout.tsx and the two QR landing
 * pages (feedback/[token], loyalty/[token]). This function must never
 * throw: a locale-resolution failure should always degrade to English/UTC,
 * never break the page it has nothing to do with.
 */
export default getRequestConfig(async () => {
  let locale = DEFAULT_LOCALE;
  let timeZone = DEFAULT_TIMEZONE;

  // hasSession() is a cookie-presence check only, no network call (see
  // lib/session.ts) -- gating the /businesses lookup behind it means the
  // large majority of requests this config runs on (both anonymous QR
  // pages, every /loyalty/* customer page, /login itself) skip a doomed
  // API round trip entirely instead of making one just to get a 401.
  if (await hasSession()) {
    const business = await getActiveBusinessQuiet();
    if (business) {
      // resolveSupportedLocale guards against a value outside
      // SUPPORTED_LOCALES even though BusinessDto types defaultLocale as
      // Locale already -- the API response is asserted, not
      // runtime-validated (see api-client.ts's parseEnvelope), so this is a
      // real runtime check, not belt-and-suspenders over something the type
      // system already guarantees.
      locale = resolveSupportedLocale(business.defaultLocale);
      timeZone = business.defaultTimezone || DEFAULT_TIMEZONE;
    }
  }

  return {
    locale,
    timeZone,
    messages: await loadMessages(locale),
    // Named presets (i18n & Multi-Currency Block 3) so every date-rendering
    // call site shares one definition instead of repeating raw Intl options
    // -- see the getFormatter() usage in loyalty/dashboard/[businessId]/
    // page.tsx, dashboard/feedback/page.tsx, dashboard/loyalty/page.tsx,
    // dashboard/analytics/{summaries-list,search/page}.tsx, and
    // dashboard/notifications/notification-log.tsx (the one 'shortDateTime'
    // caller -- a send log where the time genuinely matters).
    formats: {
      dateTime: {
        short: { dateStyle: 'medium' },
        shortDateTime: { dateStyle: 'medium', timeStyle: 'short' },
      },
    },
  };
});
