# DEV-60 — Strict UTC Summary-Period Instant Validation

**Authorization:** Development only. No scheduling cadence, summary cost policy, backend query or provider changes.

## Baseline finding
The queue validator used `Date.parse` alone for `generate_summary.periodStart` / `periodEnd`. JavaScript parsing can normalize impossible calendar dates, accept non-ISO strings and silently alter the intended interval. All known producers in `sentiment-job.ts` / `index.ts` / analytics routes serialize Date objects as UTC ISO via `toISOString()`.

## Scoped implementation
- Require a canonical UTC ISO timestamp with seconds and optional three-digit millisecond precision: `YYYY-MM-DDTHH:mm:ss[.SSS]Z`.
- Round-trip parsed values through `toISOString()` to reject normalized-invalid calendar values such as February 30, alongside malformed timezone, time and precision inputs.
- Preserve strict `periodStart < periodEnd` ordering and the existing `daily/weekly/monthly` vocabulary.
- Add leap-day, inverted range, precision, offset, normalized-invalid date and non-string regressions.

**Compatibility boundary:** This intentionally rejects legacy non-canonical date strings and timezone-offset formats not produced by known queue producers. It does not rewrite payloads, replay messages or change any scheduled cron.

**Verification:** Typecheck and exact-head CI required. No staging or production certification.
