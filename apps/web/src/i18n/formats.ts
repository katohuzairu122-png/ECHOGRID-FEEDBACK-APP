/**
 * Named dateTime presets (i18n & Multi-Currency Block 3) so every
 * date-rendering call site shares one definition instead of repeating raw
 * Intl options -- see the getFormatter() usage in
 * loyalty/dashboard/[businessId]/page.tsx, dashboard/feedback/page.tsx,
 * dashboard/loyalty/page.tsx, dashboard/analytics/{summaries-list,search/
 * page}.tsx, and dashboard/notifications/notification-log.tsx (the one
 * 'shortDateTime' caller -- a send log where the time genuinely matters).
 *
 * Shared between i18n/request.ts (the real request config) and
 * test-utils.tsx (the test provider) so the two can't drift apart --
 * without this, a test's NextIntlClientProvider has no way to know these
 * presets exist and every format.dateTime(date, 'short') call throws
 * MISSING_FORMAT under test.
 */
export const formats = {
  dateTime: {
    short: { dateStyle: 'medium' },
    shortDateTime: { dateStyle: 'medium', timeStyle: 'short' },
  },
} as const;
