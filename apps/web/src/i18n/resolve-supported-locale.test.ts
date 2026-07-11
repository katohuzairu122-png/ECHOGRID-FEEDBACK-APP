import { describe, it, expect } from 'vitest';
import { resolveSupportedLocale, DEFAULT_LOCALE } from '@echo-grid-feedback/shared-types';

/**
 * resolveSupportedLocale is the single guard every locale-resolution call
 * site in this app relies on (i18n/request.ts, the customer dashboard
 * layout, both anonymous QR pages) to turn an unvalidated string --
 * typically a business's defaultLocale read from an API response that's
 * asserted rather than runtime-checked, see lib/api-client.ts's
 * parseEnvelope -- into a Locale next-intl can safely render with. It's
 * defined in @echo-grid-feedback/shared-types, which has no test runner of its
 * own (i18n & Multi-Currency Block 8), so this app -- its main consumer --
 * covers it at the boundary instead of leaving it untested.
 */
describe('resolveSupportedLocale', () => {
  it('passes through every currently supported locale unchanged', () => {
    expect(resolveSupportedLocale('en')).toBe('en');
    expect(resolveSupportedLocale('es')).toBe('es');
    expect(resolveSupportedLocale('fr')).toBe('fr');
  });

  it('falls back to the default locale for an unsupported language tag', () => {
    expect(resolveSupportedLocale('de')).toBe(DEFAULT_LOCALE);
    expect(resolveSupportedLocale('en-US')).toBe(DEFAULT_LOCALE);
  });

  it('falls back to the default locale for null, undefined, or an empty string', () => {
    expect(resolveSupportedLocale(null)).toBe(DEFAULT_LOCALE);
    expect(resolveSupportedLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(resolveSupportedLocale('')).toBe(DEFAULT_LOCALE);
  });

  it('is case-sensitive -- an uppercase variant of a supported locale is not itself supported', () => {
    // Documents current behavior rather than prescribing it: SUPPORTED_LOCALES
    // stores lowercase codes only, so 'EN' does not match and falls back.
    // If a future business's stored defaultLocale is ever cased differently,
    // this test will flag the mismatch before it reaches users as a silent
    // fallback-to-English.
    expect(resolveSupportedLocale('EN')).toBe(DEFAULT_LOCALE);
  });
});
