# TIMEZONE-01: business timezone configuration (design only)

**Status: DESIGN ONLY. Nothing here is built, migrated, deployed or authorized. Owner review is required before any development block. Financial activation remains NO-GO. The WEB-1102 production restriction is unchanged.**
Baseline: `main` `de997da6` (2026-11-14). Labels: **VERIFIED**, **PROPOSED**, **NOT IMPLEMENTED**, **BLOCKED**, **UNKNOWN**.

## 1. Objective and scope

Every business operates in an explicitly configured IANA timezone (for example `Asia/Kuwait`), chosen with the help of the country at registration, editable by authorized staff, and used wherever a local business date or local time matters. In scope: the data contract, validation, UI, conversion rules, impact on dates and schedules, existing-business handling. Out of scope: per-user personal timezone for staff, and any rewriting of stored timestamps.

## 2. Verified existing implementation

- **Storage (VERIFIED).** Absolute times are `timestamptz` columns (UTC instants). `businesses.default_timezone` is `text NOT NULL DEFAULT 'UTC'`. `branches.timezone` is `text NOT NULL DEFAULT 'UTC'`, and `branches.country_code` (ISO 3166-1 alpha-2) exists but is nullable and unused by the business. **There is no business-level country.**
- **Validation (VERIFIED, weak).** The create and update schemas accept any string of 1 to 100 characters for `defaultTimezone` (`packages/shared-types/src/businesses.ts`); nothing checks that it is a real IANA identifier. An invalid value is stored as is.
- **Registration (VERIFIED).** Creating a business asks only for name and slug (`createBusinessAction`); timezone, currency, language and country are all left at seed defaults (`UTC`, `USD`, `en`).
- **Settings UI (VERIFIED).** The business settings form has a plain text box for the timezone (placeholder `America/New_York`, required). There is no picker, no country help and no preview.
- **Display (VERIFIED).** The Web app passes the business timezone into next-intl (`apps/web/src/i18n/request.ts`: `timeZone = business.defaultTimezone || DEFAULT_TIMEZONE`), so formatted dates in the dashboard already render in the business timezone.
- **Day and period boundaries on the server are UTC (VERIFIED):** the reward daily redemption limit counts since `date_trunc('day', now())` (the database session timezone, expected UTC; **UNKNOWN** until the setting is read); monthly response usage is computed at `date_trunc('month', ... AT TIME ZONE 'UTC')`; the notification daily cap uses `setUTCHours(0,0,0,0)`, and its own comment says there is no business timezone to key off; feedback analytics bucket with `date_trunc('day', created_at)`.
- **Scheduled jobs (VERIFIED):** cron triggers are global and in UTC (daily, weekly and monthly at 00:00 UTC, plus a 5-minute sweep).
- **Audit (VERIFIED):** business updates are recorded by the audit middleware; the entry is generic unless the route adds metadata.
- **Not present (NOT IMPLEMENTED):** IANA validation, country field on the business, country-assisted picker, timezone change audit detail, "confirm your timezone" prompt, any per-business local-day computation on the server.

## 3. Proposed target design

### 3.1 Data contract (PROPOSED)

- `businesses.default_timezone` stays the single canonical business timezone (IANA string).
- New `businesses.country_code` (nullable ISO 3166-1 alpha-2) to drive the country-assisted choice and later features.
- New `businesses.timezone_confirmed_at` (nullable timestamptz): set when an owner explicitly saves the timezone. Null means "never confirmed" (used for existing businesses).
- Branch timezone: today a branch carries its own non-null `timezone` defaulting to `UTC`, so "unset" cannot be told from "explicitly UTC". Proposal: until an owner decision (section 11) the **business timezone governs** local business dates, and the branch value is informational. This is a flagged conflict, not a settled rule.
- API validation: a shared validator accepts only identifiers that the runtime recognizes as valid timezones (a try on `Intl.DateTimeFormat(undefined, { timeZone })`, plus an allowed list generated from the IANA zone files at build time). **UNKNOWN:** confirm identical behavior on the Cloudflare Workers runtime before relying on it.

### 3.2 Country-assisted selection (PROPOSED)

A bundled table maps each country to its IANA zones (built from the IANA `zone1970.tab`, not fetched at runtime). One zone: it is chosen automatically (Kuwait gives `Asia/Kuwait`). Several zones (for example the United States, Brazil, Australia): the owner picks from that country's zones, labelled with the current local time. A search box finds any zone for businesses in unlisted cases.

### 3.3 Conversion rules (PROPOSED)

- **Absolute timestamps** (events, ledger entries, audit rows, token times) stay UTC and are never rewritten.
- **Local business date**: computed on read as the date of the instant in the business timezone. It is not stored unless a feature explicitly needs a frozen date (such as a daily counter), and then it is stored together with the timezone id used.
- **Recurring local schedules** (for example an off-peak window 14:00 to 17:00) are stored as local wall-clock times plus the business timezone id, never as UTC offsets, and evaluated by converting the event instant into business-local time.
- **Daylight saving:** a local time that does not exist (spring forward) moves forward to the next valid time; an ambiguous time (fall back) means the first occurrence. Both rules are stated and tested.

### 3.4 Audit and change behavior (PROPOSED)

Every change records the old and new identifier, who changed it and when, using the existing audit metadata hook. A change affects **future** local-day boundaries only; stored instants are untouched. Only roles with `business:manage_settings` may change it. A change shows a warning that daily limits, schedules and reports will use the new local day from now on.

## 4. Data ownership and contracts

The business owns its timezone and country. Platform admin can see them read-only. Customers do not own a business timezone: absolute timestamps shown to customers use the customer's device timezone, and validity windows (for example "valid until 30 Nov") use the business timezone and say so (owner decision, section 11).

## 5. Authentication and authorization

Reading the timezone follows existing business read permissions. Writing requires `business:manage_settings` (owner and manager per the current grants), enforced on the API; cashiers cannot change it (D-C1). Registration sets it for the creating owner.

## 6. UI and user journeys

- **Registration:** a country selector, then the timezone auto-filled or chosen, with "Local time there now: 14:32" as a check. A "Confirm later" path keeps the default but marks the business as unconfirmed.
- **Settings:** the free-text box becomes the same country and zone picker with a live local-time preview and the change warning.
- **Existing businesses on `UTC`:** an owner-only banner "Confirm your business timezone" until `timezone_confirmed_at` is set. Nothing changes automatically.
- **Platform admin:** the business detail page shows country, timezone and confirmed state.

## 7. Impact analysis

| Area                                    | Today                     | Effect of an explicit business timezone                    | Needs                                                                   |
| --------------------------------------- | ------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| Dashboard date display                  | Business timezone (works) | Unchanged                                                  | Validation so a bad value cannot break formatting                       |
| Loyalty earning dates                   | Stored as UTC instants    | Display unchanged                                          | None for storage                                                        |
| Reward daily limit (`maxRewardsPerDay`) | UTC day                   | Should become the business local day                       | Server change in REWARD-CONFIG blocks; **decision needed**              |
| Reward start and expiry                 | Instants                  | Show and set as local dates; "expires end of 30 Nov local" | Decision on end-of-day semantics                                        |
| Off-peak program (LP-06)                | Not built                 | Depends entirely on business-local time                    | TIMEZONE-01 is a prerequisite                                           |
| Streaks (LP-05)                         | Not built                 | "Day" means business-local day                             | Prerequisite                                                            |
| Purchase verification                   | Instants                  | Receipt time compared as instants; display local           | None                                                                    |
| Cashier activity                        | Instants                  | Shown in business local time                               | Display only                                                            |
| Reports and analytics buckets           | `date_trunc('day')` (UTC) | Should bucket by business local day                        | Query change                                                            |
| Monthly response allowance              | UTC month                 | Local month would shift edge cases                         | **Billing decision; keep UTC unless the owner says otherwise**          |
| Notifications daily cap                 | UTC midnight              | Local midnight                                             | Service change                                                          |
| Scheduled jobs                          | Global UTC cron           | Cannot be per business                                     | Keep UTC crons; evaluate "local" rules on read or in the 5-minute sweep |
| Historical records                      | UTC instants              | Unchanged                                                  | Never rewrite                                                           |

## 8. Backward compatibility

No stored timestamp changes. Existing `UTC` businesses behave exactly as today until the owner confirms a timezone, after which only future day boundaries move. The new columns are additive and nullable. Branch timezone values are not modified.

## 9. Dependencies

Prerequisite for LP-05 (streaks) and LP-06 (off-peak) in REWARD-CONFIG-01. Independent of CASHIER-PWA-01 apart from display. Any migration needs the Gate 2 re-pin and authorization (staging first). The validation-only step needs no migration and could ship first.

## 10. Acceptance criteria

Invalid identifiers are rejected by the API and the form; Kuwait selects `Asia/Kuwait` automatically; a multi-zone country shows its zones; times shown in the dashboard match the business zone on both sides of a daylight-saving change (tests use fixed instants around the transitions); a timezone change is audited with old and new values and does not alter any stored instant; the daily reward limit rolls over at local midnight once adopted; cashiers cannot change the timezone; the unconfirmed banner appears only for owners and disappears after confirmation.

## 11. Open owner decisions

1. Branch timezone versus business timezone (single business zone, or branches may override).
2. Whether the daily reward limit and analytics buckets use the business local day (recommended) or stay UTC.
3. Whether the monthly response allowance stays UTC (recommended, because it is a billing quantity).
4. What the customer sees: their own device time for events, business time for validity windows (recommended).
5. Whether existing businesses get the banner only, or an automatic suggestion based on the branch country.
6. The "global timezone selector for the whole app" in the owner's note is read here as the business timezone selector; confirm that no separate per-user timezone is wanted.

## 12. Implementation block breakdown (PROPOSED, each needs authorization)

- T1: server-side IANA validation and tests (no migration).
- T2: country and zone data, picker component, settings form.
- T3: registration step and `country_code` and `timezone_confirmed_at` columns (migration).
- T4: audit detail and the confirm banner for existing businesses.
- T5: local-day helpers (a single tested module) and adoption in daily limits, analytics buckets and the notification cap.
- T6: daylight-saving test suite and acceptance run.
