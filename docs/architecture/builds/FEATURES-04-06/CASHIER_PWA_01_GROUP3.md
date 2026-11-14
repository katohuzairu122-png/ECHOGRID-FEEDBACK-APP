# CASHIER-PWA-01 Group 3 (C7 + C8) - development notes

Status: development and testing only. Nothing deployed, no migration applied anywhere, no DNS/Worker/secret change.
Built on the exact head of PR #420 (318cb611); #420 itself is unmodified.

## C7 - cashier activity history
- **No new persistence, no migration.** `GET /cashier-activity` is a read-only view over `audit_log`. Rows count when they carry `metadata.client = 'cashier'` (stamped by the audit middleware and the phone-lookup service for a verified cashier token) or are cashier session actions (`cashier_session.revoked|revoked_all`, `auth.cashier_login|logout`). Earlier rows are not backfilled.
- **Gaps closed in the audit middleware (cashier tokens only):** QR verification (`cashier.qr_verified|qr_rejected`), redemption lookups (`cashier.redemption_lookup`, an attempt even though it is a GET), rejected confirmations (`cashier.redemption_rejected`), and cashier 401/403 refusals stamped as cashier security events. Successful purchases and confirmed redemptions reuse their existing semantic rows, decorated with the marker, so nothing is duplicated and no ledger effect is created.
- **Categories:** customer_lookup, qr_verification, points_issued, redemption_attempt, redemption_success, redemption_failure, session, security.
- **Access (R5), existing permissions only:** `audit:view` (Owner/Admin) or `loyalty:accounts:view` (Manager) may read. Scope = the caller's authorized branches (business-wide grant = all; branch grants = those branches; an out-of-scope branch is 403; business-level rows with no branch are business-wide only). A counter-only role is denied: no existing approved permission grants own-activity access. Cashier tokens are refused by the C2 guard (the route is not on the allow-list; allow-list still exactly 8 routes). Cross-business is refused by tenant resolution.
- **Data returned:** timestamp, business id, branch id/name, actor id/name, categories, outcome, error code, audit correlation id (the row id), and a reference only for transactions/sessions. Never IP, user agent, QR payloads, tokens, phone hashes, customer or loyalty-account ids.
- **Pagination:** limit 1-100, filters (category, branch, actor, from, to), deterministic keyset order `created_at(ms) DESC, id DESC` (millisecond-truncated on both sides so microsecond timestamps cannot skip or repeat rows).
- **UI:** `/dashboard/cashier/activity`. A branch-scoped manager must pick a branch (tenant context requires it).

## PR #420 independent review (fresh reviewer agent, read-only)
Verdict: safe to build on, no authorization or isolation defect. Findings fixed here (not in #420): (1) refresh failure cleared cookies on transient errors and could clobber a concurrent winner; now only definitive refusals clear. (2) missing context cookie caused a login/app redirect loop; now routes to the refresh handler, and the sign-in page ignores existing cookies after a failed refresh (`?reason=session`). (3) `/invite` was reachable on the cashier host; now guarded. Hardening: the refresh GET refuses cross-site navigations (`Sec-Fetch-Site`); manifest `start_url` is inside `scope`.

## Rulings applied
R1 Owner/Admin session admin only (unchanged). R2 nav entry for `loyalty:serve`. R3 `/cashier` on dev hosts only; production needs `CASHIER_HOST`. R4 name fields kept: tests show only the bound business/branch names are returned, from the stored binding. R5 as above. R6 no deployment.

## Verification levels (see the completion report for results)
1 source level, 2 local runtime (Next.js / local workerd), 3 Cloudflare Workers runtime, 4 real device. Levels 3 and 4 are not claimed unless stated in the report.

## Verification performed (development, on a throwaway PG16 and local tooling)
- Source level: API vitest 190 files / 2968 tests, web vitest 102 files / 662 tests, both typecheck projects, eslint (0 errors; 4 pre-existing warnings in api index.ts). Scratch-DB integration: cashier migration, sessions, activity (4) plus the existing loyalty points, redemption and reward suites.
- Local Workers-runtime (wrangler dev, local workerd, NOT the Cloudflare edge): OpenNext build succeeded; API worker plus web worker with `CASHIER_HOST=cashier.localhost`; 42 API-level scenario checks (cashier sign-in, allow-list denials, business substitution, audit/activity, pagination, replay, revocation, isolation) and 28 Chromium (Pixel 7 emulation) checks (host redirects, manifests, UI sign-in, cookies, nav, offline banner, revocation to sign-in) all passed.
- Not verified: Cloudflare edge runtime and real hostnames/DNS, real-device install, camera QR scanning, production middleware behaviour beyond the minimal-mode build used locally, hosted-environment secrets.
- Test-harness note: an early browser failure was a plain-http non-localhost origin refusing Secure cookies (not an app defect); an apparent offline-banner failure was the harness matching Next's always-present route announcer (role=alert).
