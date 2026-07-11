import { z } from 'zod';

/**
 * Languages the platform has translation files for (i18n & Multi-Currency
 * Block 2 ships messages/en, messages/es, messages/fr). Deliberately a
 * closed enum, not a freeform BCP-47 string: default_locale drives both
 * Intl formatting (which would accept almost any tag) AND UI string lookup
 * (which only resolves for languages we've actually translated) -- allowing
 * an untranslated tag here would silently produce a half-localized business
 * (correct number formats, English-only text), which is worse than not
 * offering the option. Grow this list only in lockstep with adding a real
 * messages/<locale> directory (Block 2 onward).
 */
export const SUPPORTED_LOCALES = ['en', 'es', 'fr'] as const;

export const DEFAULT_LOCALE: (typeof SUPPORTED_LOCALES)[number] = 'en';

/**
 * Matches businesses.defaultTimezone's DB default exactly (see
 * apps/api/src/db/schema/businesses.ts) -- the fallback every locale
 * resolution path (apps/web's i18n/request.ts, the customer dashboard
 * layout, the anonymous QR pages) uses when a business's own timezone
 * can't be resolved.
 */
export const DEFAULT_TIMEZONE = 'UTC';

export const localeSchema = z.enum(SUPPORTED_LOCALES);

export type Locale = z.infer<typeof localeSchema>;

/** Human-readable labels for the locale switcher (Block 3 settings UI, Block 4 dashboard shell). */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
};

/**
 * Narrows an arbitrary string -- typically a business's defaultLocale read
 * from an API response that is asserted, not runtime-validated (see
 * apps/web/src/lib/api-client.ts's parseEnvelope) -- to a supported Locale,
 * falling back to DEFAULT_LOCALE otherwise. The single shared check every
 * locale-resolution call site uses (apps/web's i18n/request.ts, the
 * customer dashboard layout, both anonymous QR pages) instead of each
 * re-deriving its own SUPPORTED_LOCALES.includes() guard.
 */
export function resolveSupportedLocale(candidate: string | null | undefined): Locale {
  if (candidate && (SUPPORTED_LOCALES as readonly string[]).includes(candidate)) {
    return candidate as Locale;
  }
  return DEFAULT_LOCALE;
}
