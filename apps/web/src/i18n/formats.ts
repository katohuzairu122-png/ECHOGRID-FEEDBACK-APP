/**
 * The app's named date/time presets, in ONE place (i18n & Multi-Currency
 * Block 3 originally defined these inline in request.ts).
 *
 * Extracted so the test harness and the runtime cannot drift. They had
 * drifted: request.ts declared these presets, `test-utils.tsx`'s
 * NextIntlClientProvider did not pass them, and every test rendering a
 * component that calls `format.dateTime(d, 'short')` logged
 * `IntlError: MISSING_FORMAT: Format 'short' is not available` and silently
 * fell back to `String(date)`. 18 call sites across dashboard, platform,
 * loyalty and analytics pages were therefore asserted against a date format
 * the real app never produces -- and deleting `short` from this object would
 * have produced identical test output, so the suite could not catch its own
 * regression.
 *
 * Deliberately NOT marked `server-only`, unlike request.ts which imports it:
 * this same object is passed to every NextIntlClientProvider, including the
 * one in the test harness, and none of those are server-only contexts.
 *
 * `as const` is load-bearing. Without it `dateStyle: 'medium'` widens to
 * `string`, which is not assignable to `Intl.DateTimeFormatOptions['dateStyle']`
 * -- the literal types survived only because the object used to be written
 * inline at its point of use.
 *
 * Adding a preset: add it here and nowhere else. Every provider in the app
 * already forwards this object, so a new entry is available everywhere the
 * moment it lands. Prefer extending this list over passing raw Intl options
 * at a call site -- that is the duplication this file exists to prevent.
 */
export const formats = {
  dateTime: {
    /** Date only, no time -- the default for feedback/loyalty/analytics
     * listings where the time of day carries no meaning. 17 of the 18
     * dateTime call sites use this one. */
    short: { dateStyle: 'medium' },
    /** Date AND time -- used only by dashboard/notifications/notification-log.tsx,
     * a send log where the minute a message went out genuinely matters. */
    shortDateTime: { dateStyle: 'medium', timeStyle: 'short' },
  },
} as const;
