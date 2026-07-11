/**
 * Curated dropdown options for the business settings form (i18n &
 * Multi-Currency Block 3) -- NOT a validation constraint. The API accepts
 * any 3-letter ISO 4217 code (see updateBusinessSchema in
 * @echo-grid-feedback/shared-types), deliberately unconstrained since currency
 * only feeds Intl formatting, not UI string lookup. This list exists purely
 * so the common case is a picker, not free text -- ~180 real currencies is
 * too many for a plain <select> to be good UX, but the ~20 below cover the
 * large majority of real businesses. Presentation-only, so it lives in
 * apps/web, not shared-types (which is for cross-app contracts).
 */
export const COMMON_CURRENCIES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'USD', label: 'USD -- US Dollar' },
  { code: 'EUR', label: 'EUR -- Euro' },
  { code: 'GBP', label: 'GBP -- British Pound' },
  { code: 'CAD', label: 'CAD -- Canadian Dollar' },
  { code: 'AUD', label: 'AUD -- Australian Dollar' },
  { code: 'NZD', label: 'NZD -- New Zealand Dollar' },
  { code: 'JPY', label: 'JPY -- Japanese Yen' },
  { code: 'CNY', label: 'CNY -- Chinese Yuan' },
  { code: 'INR', label: 'INR -- Indian Rupee' },
  { code: 'MXN', label: 'MXN -- Mexican Peso' },
  { code: 'BRL', label: 'BRL -- Brazilian Real' },
  { code: 'CHF', label: 'CHF -- Swiss Franc' },
  { code: 'SEK', label: 'SEK -- Swedish Krona' },
  { code: 'NOK', label: 'NOK -- Norwegian Krone' },
  { code: 'DKK', label: 'DKK -- Danish Krone' },
  { code: 'SGD', label: 'SGD -- Singapore Dollar' },
  { code: 'HKD', label: 'HKD -- Hong Kong Dollar' },
  { code: 'ZAR', label: 'ZAR -- South African Rand' },
  { code: 'AED', label: 'AED -- UAE Dirham' },
];
