# ECHO GRID — CUSTOMER-AUTH-UX-02-R4 Staging Readiness Audit

**Date:** 2026-11-22  
**Status:** READ-ONLY VERIFIED — ACTIVATION/ACCEPTANCE BLOCKED  
**Repository baseline:** main `ce30172485041327787aea227f365c8aa33bd076`

## Scope and evidence

Inspection was read-only through the connected Cloudflare and Neon management APIs. No customer rows, tokens, secret values, or proof payloads were retrieved. No deployments, configuration updates, schema changes, or feature activations occurred.

### Cloudflare Workers

| Worker | CUSTOMER_EMAIL_AUTH_ENABLED | CUSTOMER_LEGACY_UPGRADE_ENABLED | CUSTOMER_PASSWORD_MIN_LENGTH |
| --- | --- | --- | --- |
| `echo-grid-feedback-api-staging` | `true` (plain text binding) | absent | `8` |
| `echo-grid-feedback-web-staging` | `true` (plain text binding) | absent | `8` |
| `echo-grid-feedback-api` | absent | absent | not checked |
| `echo-grid-feedback-web` | absent | absent | not checked |

Presence-only checks on staging API showed the expected `HYPERDRIVE`, `PASSWORD_HASHER`, `CUSTOMER_AUTH_RATE_LIMIT`, `RESEND_API_KEY`, `CUSTOMER_EMAIL_AUTH_HMAC_SECRET`, `CUSTOMER_SESSION_SIGNING_SECRET`, and `CLIENT_ATTRIBUTION_SECRET` bindings. Their existence does not establish correct values or operational delivery, database readiness, limiter behavior, or secret dedication.

**Finding R4-F1:** Staging customer email authentication is already feature-enabled on both Workers. This is an observed configuration state, **not** an approval or a configuration change performed in this audit. Legacy upgrade remains unconfigured.

### Neon staging database — catalog and migration ledger only

Project: `echo-grid-staging` (PostgreSQL 18). Inspected the project's default database branch, whose Neon display name happens to be `production`; this does **not** refer to the separate `echo-grid-production` project.

- `information_schema.columns`: `public.customer_auth_challenges.registration_sealed_data` is **ABSENT**.
- `drizzle.__drizzle_migrations`: latest recorded row has `id = 87`, `created_at = 1795154649004`.
- Repo `apps/api/drizzle/meta/_journal.json` maps `1795154649004` to **0086_d2_final_privacy_lifecycle**.
- Repo `0087_customer_pending_registration` has `when = 1795250000000`.
- Repo `apps/api/drizzle/0087_customer_pending_registration.sql` adds the missing `registration_sealed_data` column and its CHECK constraint.

**Finding R4-F2 (BLOCKER):** Migration **0087 is not recorded as applied** on the inspected staging database, and its required column is absent. Counting 87 migration rows is not sufficient: IDs start from 1 whereas journal indexes start from 0.

## Consequence

The new single-pass email-registration code expects the missing column. With email auth enabled in staging, signup paths may fail at database execution. Do not claim staging customer signup or legacy upgrade ready.

Additional read-only cross-provider verification matched the staging API Worker's `HYPERDRIVE` configuration to Neon endpoint `ep-sparkling-hall-au6p04ch` (the configured Hyperdrive origin uses the corresponding `-pooler` hostname). Neon lists that same endpoint on the inspected staging project default branch. Therefore the staging API is configured to use the inspected database **missing migration 0087**. This proves a configured schema/feature mismatch, but does not prove that a particular live request failed.

## Owner-controlled remediation gates

1. **VERIFIED:** The staging API Hyperdrive target matches the inspected Neon staging endpoint. Recheck the mapping only if a deployment or resource binding changes.
2. Review and explicitly authorize the staging migration `0087` and backup/restore plan. Do not apply it automatically.
3. Review the decision on whether email auth should remain enabled in staging before the schema and provider acceptance are confirmed. Do not change flags automatically.
4. Validate real worker-to-database connection, registration proof delivery, mail-provider behavior, rate limits, session handling, and ownership boundaries using **authorized synthetic test identities only**.
5. Execute the full customer A–H isolated Chromium acceptance matrix. Skipped/opt-in specs are not passes.
6. Approve pending sealed-registration retention cleanup policy and rate-limit budgets separately; merged PR #554's cleanup is unwired.
7. Require distinct owner authorization for production configuration, migrations, release or activation.

## Security restrictions

No shared migrations, secret exposure, real customer identity modifications, terms or membership changes, deployment, rate-limit configuration modifications, feature activation, or automatic merge is authorized by this audit.

R3 browser tests and direct QR deep-link safeguards are tracked separately in draft PR #555. That PR's hosted CI is not evidence that opt-in customer A–H browser acceptance ran.


## 2026-11-22 authorized staging migration completion

**OWNER AUTHORIZATION:** In the ongoing customer-authentication completion conversation, the owner explicitly granted authorization to proceed with the previously identified staging migration and controlled synthetic acceptance. This authorization did not include production migration or deployment, activating legacy upgrade, or automatically merging PRs.

**Target:** Neon project `echo-grid-staging`, default branch `br-bold-water-aukjlvw3` (Neon display name `production`), database `neondb`. The staging API's Hyperdrive metadata pointed to the matching Neon endpoint before the change. The separate `echo-grid-production` project was **not** modified.

1. **Recovery point created:** Neon branch `br-falling-hat-auq20iqi` named `backup-pre-customer-auth-0087-2026-11-22`, parent `br-bold-water-aukjlvw3`; the recovery branch was retained and not used as a test target.
2. **Rehearsal:** Applied the two canonical `0087_customer_pending_registration.sql` DDL operations plus Drizzle ledger entry to a disposable migration branch. Verified column type, CHECK constraint, previous ledger entry, and new journal entry; no errors.
3. **Applied to staging:** Neon prepared migration `c86c8fac-1d83-4308-bb9d-4d7f0d1bfcf8` returned `applied: true`, and its temporary branch was deleted by Neon.
4. **Post-apply catalog verification:** `public.customer_auth_challenges.registration_sealed_data` exists with type `text`; `customer_auth_challenges_registration_sealed_check` exists.
5. **Drizzle migration ledger:** New row `id=88`, `created_at=1795250000000`, `hash=fab77c0dbab7628a314ac8b82187aa8568e2d2abb3e5c8cafabfaa0cfc1643dd`. Previous row `id=87`, timestamp `1795154649004` preserved.
6. **Readiness aggregates (read-only):** `customer_credentials` rows with null `legacy_tokens_invalid_before`: **0**. Verified login email credentials: **3**. No identity or credential rows were inspected individually or modified.

**R4-F2 STATUS: REMEDIATED IN STAGING — schema/journal verified.** The earlier evidence in this document records the pre-migration state and must not be mistaken for the current state.

**Outstanding acceptance:** Successful staging single-pass registration, mail proof delivery and consumption, rotating sessions, negative auth, phone verification, legacy upgrade, QR business continuity, and cross-customer denial have **not** been executed or certified by this migration operation. Staging `CUSTOMER_EMAIL_AUTH_ENABLED` was already `true`, and no worker configuration changed. `CUSTOMER_LEGACY_UPGRADE_ENABLED` remains absent. Existing candidate R3 tests are opt-in and skipped without an authorized test stack and fixtures.

**Recovery rule:** This is a forward-only migration. Do not drop the column or overwrite the staging branch automatically; a rollback requiring data restoration must be separately risk-reviewed and authorized. Preserve the backup branch until the owner approves release validation and retention.

No production database, Worker deployment, live identities, feature flags, customer consent, or retention scheduler was modified.


## 2026-11-22 controlled staging Chromium smoke acceptance

Read-only Chromium navigation executed through Cloudflare Browser Rendering against the existing staging Web Worker, after the authorized staging database migration. No customer account was created, no SMS/email proof requested, and no session or live identity was modified.

| Check | Observed result |
| --- | --- |
| `/loyalty/signup` | HTTP 200, page/form loads |
| `/loyalty/login/email` | HTTP 200 |
| `/loyalty/signup/verify` with missing proof | HTTP 200, incomplete/missing-proof guidance shown |
| Login `next=https://evil.example/steal` | Hidden `next` sanitized to `/loyalty/dashboard` |
| Login `next=//evil.example/steal` | Hidden `next` sanitized to `/loyalty/dashboard` |
| Login `next=/loyalty/dashboard/qr` | Hidden `next` preserved |
| Signed-out direct `/loyalty/dashboard/qr` | Redirected to `/loyalty/login` **without a `next` parameter** |

**Staging deployment drift:** PR #555 (QR deep-link preflight and its tests) was subsequently merged to main, but the currently observed staging Web Worker still exhibited the older signed-out redirect behavior. No staging deploy was authorized or performed during this session. Do not claim the PR #555 deep-link fix is live in staging.

These are **partial read-only browser smoke checks, NOT complete A–H acceptance**. They do not verify signup proof delivery, registration completion, idempotence/replay, rotating session validity and revocation, verified-phone eligibility, legacy upgrade, business QR enrollment, or cross-customer authorization.

**Outstanding operating decisions:** Stage the approved code under explicit deployment authorization; prepare a controlled synthetic mailbox/SMS verification mechanism; run full Chromium acceptance; determine retention cleanup schedule/policy and rate-limit budgets. Production remains untouched and email-auth feature activation there remains off.
