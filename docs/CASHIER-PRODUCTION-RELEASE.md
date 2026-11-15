# Cashier PWA - production release plan (CASHIER-PWA-DEPLOY-01, Gate D)

Status: PLAN ONLY. Nothing in this document has been executed in production. Every step needs the owner's explicit
authorization. The first tier of verification (staging) is recorded in the completion reports; the gaps are listed at the end.

## What is released
- Verified `main` commit (record the exact SHA at release time; it must be CI-green, including the `main`-push browser run).
- Three production migrations still pending (production ledger: 69 applied; repository: 72): **0069** (platform customer limited
  access), **0070** (impersonation setting), **0071** (cashier sessions: `refresh_tokens.client|business_id|branch_id|device_label`).
  0071 is additive (defaults to `'web'`, nothing existing changes); an app rollback needs no schema rollback.
- API Worker `echo-grid-feedback-api` (C3 cashier auth, C6 session routes, C7 activity route, cashier-token liveness check).
- Web Worker `echo-grid-feedback-web` (dashboard cashier entry, activity page, camera permission on the scanner routes).
- NEW dedicated Worker `echo-grid-feedback-cashier`, built from the same OpenNext artifact, environment `cashier` in `apps/web/wrangler.toml`.

## Required production configuration
| Item | Value | Where |
|---|---|---|
| Cashier Worker name | `echo-grid-feedback-cashier` | `[env.cashier]` (this PR) |
| `CASHIER_HOST` | `cashier.echo-grid.uk` | `[env.cashier.vars]` (this PR) |
| `CASHIER_APP_URL` on the cashier Worker | `https://cashier.echo-grid.uk` | `[env.cashier.vars]` (this PR) |
| `CASHIER_APP_URL` on the WEB Worker | `https://cashier.echo-grid.uk` | **NOT in this PR**: separate one-line change after step 7 |
| Domain `cashier.echo-grid.uk` | custom domain on the cashier Worker | owner, Cloudflare dashboard (step 6) |
| Secrets | none new (the cashier Worker needs no secret; it reuses the production API) | - |

## Release order (each step is an owner decision; stop on any failure)
1. Independent release-readiness review (R6) reports no open Critical/High finding.
2. Merge this PR. Confirm `main` CI is green on the resulting commit.
3. Run `migrate-production.yml` (typed phrase `MIGRATE_PRODUCTION`) for the exact main SHA. Verify the ledger reads 72 and the
   `refresh_tokens` columns and three check constraints exist (read-only queries). Production is additive-only here.
4. Run `deploy-production.yml` (API then web) per `docs/PRODUCTION-RELEASE.md`. Smoke: `/health`, web root, and that
   `https://echo-grid.uk/cashier/login` is a **404** (the main host must not serve the cashier app).
5. Run `deploy-cashier-production.yml` (`expected_commit` = the same SHA, typed phrase `DEPLOY_PRODUCTION_CASHIER`; the protected
   `production` environment approval is the human gate). It deploys only the cashier Worker and binds no domain.
6. Owner attaches the custom domain `cashier.echo-grid.uk` to the cashier Worker (this creates the DNS record; it is the one DNS action).
7. Verify on the real hostname (see "Acceptance" below). Only then merge the one-line change that sets `CASHIER_APP_URL` on the
   web Worker so the dashboard shows "Open Cashier App", and release the web Worker again.

## Acceptance on the production hostname (record evidence; do not skip)
- `https://cashier.echo-grid.uk/` redirects to `/cashier/login`; `/dashboard`, `/login`, `/signup`, `/platform` redirect into the cashier app.
- `https://echo-grid.uk/cashier/login` is 404.
- Manifest on the cashier host is "Echo Grid Cashier" (scope `/cashier/`); icons 192 and 512 load; the service worker registers.
- Owner signs in with their own account, chooses business/branch, serves a real test customer (lookup, purchase, redemption, duplicate refused).
- Revoke from Dashboard -> Cashier app -> Active sessions: the device loses access on its next request and cannot refresh.
- Only the 8 cashier routes work with a cashier token (re-run the denial checks against production with a throwaway session).
- Android: install, camera permission prompt, scan of a real customer QR, offline banner and reconnect (physical device).

## Rollback
- Cashier Worker: remove the custom domain binding (owner), then roll back or delete the Worker. No data is held in the Worker.
- Web/API: redeploy the previous release through `deploy-production.yml` for the prior SHA (Workers keep prior versions).
- Database: none required (0071 additive). Do not run destructive SQL.
- Fast kill switch: unset/blank `CASHIER_HOST` and redeploy the cashier Worker, or remove the domain; every `/cashier` route is then a 404.

## Security acceptance (as of the last staging run)
Passed on staging: 8-route allow-list, business/branch binding, replay/rotation, immediate revocation, role matrix (Owner, Manager,
Staff, branch-restricted, no membership, cross-business), cashier activity scoping and PII exclusion, host isolation on the Cloudflare edge.

## Outstanding gaps (must be closed or explicitly accepted before production)
- Real-device verification: camera scan with a real customer QR, Android installation, native offline/reconnect.
- Positive customer-QR verification (staging had no customer sign-in path).
- Unresolved cause of the earlier `main`-push-only browser failure (mitigated by a more robust test, not root-caused).
- Suspended-business and inactive-membership cases verified at source level only.
- Independent human release-readiness review (R6).
