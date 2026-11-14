# CASHIER-PWA-01 Group 2 (C4 + C5 + C6) - development notes

Status: development only. Nothing deployed, no migration applied, no Worker/DNS/secret change.

## What was built
- **C4 cashier app** under `/cashier` (same Next build): sign-in (`/cashier/login`), Serve Customers (`/cashier`, primary), Redeem code, This device. Mobile-first bottom tabs, offline banner, error boundary, installable manifest (own id/scope/start_url, reuses brand icons).
- **Auth reuse, no parallel system**: sign-in calls the C3 endpoints (`/auth/cashier/login|session|refresh|logout`); tokens live only in httpOnly cookies `ff_cashier_*`, path `/cashier`, never the staff cookies. The selection ticket stays in an httpOnly cookie.
- **Serve reuse**: the existing Serve Customers server actions run under a cashier credential surface (`lib/cashier/surface.ts`, AsyncLocalStorage). `apiFetch` sends the cashier token only inside that surface; everything else is unchanged.
- **Availability** (middleware is skipped by the production runtime, so nothing depends on it): `/cashier/*` is a 404 in production unless the request host equals `CASHIER_HOST`. Unset `CASHIER_HOST` = cashier app not deployed anywhere. On the cashier host, `/`, `/login`, `/signup`, recovery pages, `/dashboard` and `/platform` redirect to `/cashier`; `/manifest.webmanifest` answers with the cashier manifest.
- **Refresh without middleware**: the 15-minute access cookie is renewed by a route handler (`/cashier/session/refresh`) from server components, and inline inside server actions (both may write cookies). Rendering never rotates a token.
- **C5**: dashboard page `/dashboard/cashier` (nav "Cashier app") for anyone holding `loyalty:serve` (default Owner/Manager/Staff), "Open Cashier App" (from `CASHIER_APP_URL`; hidden with an explanation when unset), install guidance (Android, iOS, desktop, unsupported browsers). Owners need no extra setup/approval.
- **C6**: `GET /cashier-sessions`, `DELETE /cashier-sessions/:sessionId`, `POST /cashier-sessions/revoke-all` (ordinary staff routes, `business:manage_settings` + business-wide access, i.e. Owner/Admin). Pinned to the caller's business and to `client = 'cashier'` rows; other-business, web and unknown ids are one 404. Audit: `cashier_session.revoked`, `cashier_session.revoked_all` (existing audit trail). `authenticate` now checks that a cashier token's session is still live, so revocation takes effect on the next request, not at the next refresh.

## C2 allow-list
Unchanged (eight routes). The cashier app needs no ninth route; `lib/cashier/allow-list-conformance.test.ts` fails if any reused action or cashier code calls a route outside the list. Additive C3 change (not an allow-list change): cashier session responses now also carry `businessName`/`branchName` for the app header, because the cashier token cannot call `GET /businesses`.

## Deliberate decisions to review
- Session management uses `business:manage_settings` (Owner/Admin). Managers do not hold it by default; widening it is an owner decision.
- Cashier staff (counter-only role) also see the "Cashier app" nav entry; the existing dashboard-nav tests were updated for it.
- Dev-only path-mode: outside production the cashier app is served on any host under `/cashier`.

## Deployment prerequisites (not done; need separate authorization)
`CASHIER_HOST`/`CASHIER_APP_URL` env, dedicated Worker (same build) and `cashier.echo-grid.uk` custom domain, release-workflow governance route for the new Worker, then browser verification of install and offline behaviour on real devices. No DB migration is required by Group 2.
