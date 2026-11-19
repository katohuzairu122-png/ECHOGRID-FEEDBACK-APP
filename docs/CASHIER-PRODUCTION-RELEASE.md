# Cashier production release plan (corrected 2026-11-19, CASHIER-PROD-RELEASE-P1)

> **Update (D2-R8):** `main` now also contains **migrations 0084** (D2-R1 onboarding-event erasure function; dormant, no caller, no operator role members) **and 0085** (database-enforced immutability of `audit_log`; behaviour change: any UPDATE or DELETE of an audit row, and TRUNCATE, now fails, except the FK `SET NULL` action). A P3 run would apply **0080-0085** and leave the ledger at **86**, not 84. D6 was framed for 0080-0083 and must be re-ruled for 0084 and 0085; P3 and the P2 recovery steps must be re-prepared first. The 0080-0083 and "ledger 84" wording below predates 0084/0085. D1, D2, D3 and D6 remain open. See `docs/architecture/builds/CASHIER/CASHIER-PROD-D2-R8-AUDIT-INTEGRITY.md`.

Status: **PLAN ONLY. Nothing in this document has been executed in production.** Every step needs the Owner's explicit authorization, one gate at a time.
This replaces the earlier plan (written for migrations 0069-0071 and an eight-route allow-list), which no longer matched the repository.
The evidence behind every statement below is in `docs/architecture/builds/CASHIER/CASHIER_PROD_RELEASE_P1.md`.

## What is released

The release candidate is the **tip of `main` at the moment of release** (the deploy workflows refuse anything else). Record the exact 40-character SHA at P1 sign-off and re-check it before each gate. There is no cashier-only branch or cherry-pick: it would bypass the reviewed, CI-gated history and the workflows do not support it.

Compared with the last production deployment (`96be656`, 2026-11-18) the release contains, among other changes:

- **Database migrations 0080, 0081, 0082, 0083** (production ledger today: 80 applied, last = 0079). All four are additive; see the migration review in the P1 document.
  - 0080 business public profiles and 0081 B2B participation foundation: tables only, no routes use them yet (dormant).
  - **0082 managed cashier identities** (the migration this release exists for): relaxes `users.email` to nullable, adds managed-identity columns, the business cashier code, constraints and guard triggers.
  - **0083 customer onboarding events** (02D): an append-only attribution table. **It is not dormant**: every customer join through a business QR code writes one row (see the D2 ruling).
- **API Worker** `echo-grid-feedback-api`: managed cashier sign-in, branch assignment, in-session branch switching, session revocation, the cashier-accounts management routes, the onboarding invitation issuer, SEC-CASHIER-02C-R1 (switch versus removal race), SEC-CASHIER-02D-R2 (branch deletion ends cashier sessions), Split 01 customer-membership changes (explicit consent on every join, membership gates), and the other changes listed in the P1 document.
- **Web Worker** `echo-grid-feedback-web`: the dashboard Cashier Accounts pages (`/dashboard/cashier/accounts`), the cashier activity and session panels, community and customer interfaces.
- **NEW dedicated Worker** `echo-grid-feedback-cashier`, built from the same OpenNext artifact (`[env.cashier]` in `apps/web/wrangler.toml`). It does not exist yet.
- Not part of the release and not deployed by any workflow: the acceptance harness (`apps/api/scripts/acceptance/**`) and the test-only mail receiver (`apps/mail-receiver`).

## The cashier API surface (current)

Cashier-scoped access tokens may call only the **nine** allow-listed routes in `apps/api/src/middleware/cashier-scope.ts`: `POST /loyalty/actions/resolve-customer`, `POST /loyalty/actions/lookup-customer`, `POST /loyalty/actions/lookup-purchase`, `POST /loyalty/accounts/:id/purchase`, `GET /loyalty/redemptions/:code`, `POST /loyalty/redemptions/:code/confirm`, `POST /loyalty/actions/onboarding-invite`, `GET /businesses/me`, `GET /auth/me`. Plus the cashier authentication endpoints themselves (managed login, session, refresh, logout, branch switch, branch list), which are not business routes. Cashier tokens cannot reach `/cashier-accounts/*` or any other management API.

## Required production configuration

| Item | Value | Where |
|---|---|---|
| Cashier Worker name | `echo-grid-feedback-cashier` | `[env.cashier]` |
| `CASHIER_HOST` | `cashier.echo-grid.uk` | `[env.cashier.vars]` |
| `CASHIER_APP_URL` on the cashier Worker | `https://cashier.echo-grid.uk` | `[env.cashier.vars]` |
| `API_BASE_URL` on the cashier Worker | the production API Worker URL | `[env.cashier.vars]` |
| `CASHIER_APP_URL` on the WEB Worker | `https://cashier.echo-grid.uk` | **not set**; a separate one-line change after the cashier host is verified |
| Domain `cashier.echo-grid.uk` | custom domain on the cashier Worker | Owner, Cloudflare dashboard (creates the DNS record) |
| **Secret `CLIENT_ATTRIBUTION_SECRET`** | the same value on the API, web **and cashier** Workers | Owner, Cloudflare secrets (value never committed or printed). Without it every sign-in shares one strict rate-limit bucket of 10 requests per minute behind the web egress address. Presence is NOT VERIFIED from the repository; confirm names with `wrangler secret list --name <worker>`. |
| Hyperdrive | the production Hyperdrive config (API Worker only) | already bound |

The earlier statement that the cashier Worker "needs no secret" is withdrawn: it reads `CLIENT_ATTRIBUTION_SECRET` to sign the real client address (`apps/web/src/lib/cashier/client-attribution.ts`). It is inert when absent, so sign-in works, but only at the shared limit.

## Release order (each step is an Owner decision; stop on any failure; one gate at a time)

| Gate | Action | Needs |
|---|---|---|
| P1 | Repository and security verification, this plan | done by the P1 report |
| P2 | Fresh Neon snapshot of the production branch; record its id; confirm the branch and project | Owner authorization |
| P3 | `migrate-production.yml` (phrase `MIGRATE_PRODUCTION`, exact SHA, protected `production` environment approval). Applies 0080-0083 in one run. Then read-only verification | Owner authorization, P2 done |
| P4 | Provision `cashier:manage` with the reviewed script `CASHIER_PROD_P4_cashier_manage_provisioning.sql` (one permission row, Owner and Admin of the one verified business). Never `db:backfill-role-permissions` | Owner authorization, P3 verified |
| P5 | `deploy-production.yml` (phrase `DEPLOY_PRODUCTION_RELEASE`; API then web, each with its own environment approval), then `deploy-cashier-production.yml` (phrase `DEPLOY_PRODUCTION_CASHIER`). Then the Owner attaches `cashier.echo-grid.uk` to the cashier Worker. | Owner authorization, P3 and P4 done, secret confirmed |
| P6 | Smoke tests (no accounts created, no transactions) | Owner authorization |
| P7 | Owner creates the first branch (production has none), one dedicated cashier account, and signs in on the real hostname | Owner |

Order matters: migrations first (the deployed code then runs on the additive schema; proven in P1), permission before the new web Worker (so the Owner sees the page), cashier Worker last.
`migrate-production.yml` does not take a snapshot and does not run CI: P2 is a separate, manual precondition and the exact SHA must have green CI.

## Smoke checks (P6; no credentials of real customers, no purchases)

- `GET /health` on the API; web root loads; `https://echo-grid.uk/cashier/login` is a **404** (the main host must not serve the cashier app).
- `https://cashier.echo-grid.uk/` redirects to `/cashier/login`; `/dashboard`, `/login`, `/signup`, `/platform` redirect into the cashier app; manifest "Echo Grid Cashier"; the service worker registers.
- The Owner can open `/dashboard/cashier/accounts` (requires `cashier:manage` and password re-entry).
- Read-only database checks: ledger 84; `cashier:manage` held by exactly Owner and Admin of the one business.

## Rollback

- **Application** (fast, no data loss): redeploy the previous API and web SHA (`96be656`) through `deploy-production.yml`; the additive schema stays and the old code runs on it (verified locally). Cashier Worker: remove the custom domain binding, then delete or roll back the Worker; kill switch: blank `CASHIER_HOST` and redeploy, every `/cashier` route is then a 404.
- **Permission**: revoke the two grants and the permission row; or leave them (inert without the new code).
- **Database restore** is the last resort and is **not** equivalent to an application rollback: restoring the P2 snapshot discards every legitimate write after it (customer joins, sign-ins, audit rows, new businesses). Prefer forward fixes. Neon restore creates a new branch; follow the project's restore finalisation procedure and verify the project and branch before repointing anything. Neon history retention is only six hours, so the snapshot is the only recovery point beyond that.
- Do not run destructive SQL. Additive columns and tables are left in place on rollback.

## Owner acceptance (P7)

1. Open the production business dashboard; create the first real **branch** if the business still has none.
2. Cashier Accounts, re-enter your password, create one **dedicated** test cashier (not an employee's identity), assign the branch (or two branches to test switching).
3. Save the one-time password and the business cashier code at once; they are shown once.
4. Open `https://cashier.echo-grid.uk`, enter business code, username, password; pick the branch if asked.
5. Confirm the branch context and the serving screen load; try a branch you did not assign (must be refused).
6. Sign out or revoke the session from the dashboard; confirm the old session cannot be reused. Disable the account afterwards if it was only a test.
No purchase, redemption or other financial activity is part of this smoke test.

## Outstanding items (must be closed or explicitly accepted)

See the P1 document: owner rulings D1 (secret), D2 (onboarding-event retention, active from the first QR join), D3 (deliberate lockout), D6 (bundle including B2B 0080/0081); a green exact-head CI run (the main-push browser test `qr-engagement` failed on `27fa440`, unrelated to cashier and not root-caused); verification of DNS/TLS/route state; real-device camera and offline behaviour of the cashier PWA; an independent release-readiness review.
