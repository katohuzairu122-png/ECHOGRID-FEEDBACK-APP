# CUSTOMER-AUTH-UX-02-R2 — Pending Registration Retention Foundation

Status: **DEVELOPMENT ONLY — NOT ACTIVATED; OWNER RETENTION AND RATE-LIMIT DECISIONS PENDING**.

Baseline main: `4f16dfc00f882c4543a89b9aa91ff461fc879d43`.

## What is implemented

`purgeExpiredRegistrationCiphertext(db, trustedNow, batchSize)` is a deliberately **unwired** PostgreSQL cleanup primitive. It targets only `customer_auth_challenges.registration_sealed_data` on expired `email_registration` rows. It preserves challenge IDs, evidence and other challenge types. It uses a bounded batch (1–500), row locks and `SKIP LOCKED` for concurrency. No scheduler, API route, cron trigger, environment binding or shared-resource mutation has been added.

Expiration is already an enforced 15-minute proof validity boundary; the function cannot clear an unexpired proof's sealed setup data when supplied the authoritative current timestamp. The caller must be trusted: arbitrary user-supplied timestamps are forbidden. A production caller must be explicitly reviewed and authorized before this module can execute in a shared environment.

Disposable PostgreSQL regression tests cover live-row preservation, batch bounds and historical-row preservation. Until those tests and exact-head CI actually run, their existence is **not** evidence of a pass.

Existing registration success clears sealed data as part of proof consumption. Existing per-subject opportunistic cleanup remains unchanged. No retention or deletion operation runs automatically from this change.

## Privacy decisions needed before activation

**R2-D1 — Data disposal policy.** Approve removal of sealed pending-registration data at proof expiration, including the permitted cleanup delay/SLA. This is a proposal, not approval. Specify whether historical challenge metadata is retained or separately erased under existing policies.

**R2-D2 — Execution authorization.** Authorize a bounded schedule or operator-run cleanup path with isolated environment scope, permission model, error reporting, retry strategy, idempotency, monitoring and operational rollback plan. No shared environment may execute the function before explicit approval.

**R2-D3 — Rate-limit budgets.** Confirm actual per-route budgets for registration, proof completion, email/password login, OTP upgrade/link, recovery, refresh and verification, including a total SMS cost ceiling and verified source identity. The illustrative budgets in `CUSTOMER_AUTH_01D5_RATE_LIMITS.md` are not approved.

**R2-D4 — Environment readiness.** Resolve staging flag discrepancy, verify applied schema 0087 and email/SMS provider readiness without assuming activation.

## Further acceptance gates

- Exact-head API/Web typechecks, unit suite and PostgreSQL 16/18 integration.
- Isolated customer-specific Chromium A–H including QR continuation, Settings phone verification, and legacy upgrade.
- Security review of retention policy, actual scheduling behavior, non-enumerating responses and failure handling.
- Explicit owner approval for live configuration, migration, feature activation and release.

No merge, deployment, shared database migration, secret or configuration change is authorized by this document.
