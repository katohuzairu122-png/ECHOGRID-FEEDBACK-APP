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

This audit does not establish whether the staging API Worker currently points to precisely this Neon branch through its Hyperdrive binding; that mapping must be independently verified before making a definitive runtime-outage claim. The finding is a confirmed schema/configuration mismatch **for the inspected staging project**, not proof that live requests failed.

## Owner-controlled remediation gates

1. Verify the actual staging API Hyperdrive target corresponds to the inspected Neon project and database branch, using metadata only and without exposing credentials.
2. Review and explicitly authorize the staging migration `0087` and backup/restore plan. Do not apply it automatically.
3. Review the decision on whether email auth should remain enabled in staging before the schema and provider acceptance are confirmed. Do not change flags automatically.
4. Validate real worker-to-database connection, registration proof delivery, mail-provider behavior, rate limits, session handling, and ownership boundaries using **authorized synthetic test identities only**.
5. Execute the full customer A–H isolated Chromium acceptance matrix. Skipped/opt-in specs are not passes.
6. Approve pending sealed-registration retention cleanup policy and rate-limit budgets separately; merged PR #554's cleanup is unwired.
7. Require distinct owner authorization for production configuration, migrations, release or activation.

## Security restrictions

No shared migrations, secret exposure, real customer identity modifications, terms or membership changes, deployment, rate-limit configuration modifications, feature activation, or automatic merge is authorized by this audit.

R3 browser tests and direct QR deep-link safeguards are tracked separately in draft PR #555. That PR's hosted CI is not evidence that opt-in customer A–H browser acceptance ran.
