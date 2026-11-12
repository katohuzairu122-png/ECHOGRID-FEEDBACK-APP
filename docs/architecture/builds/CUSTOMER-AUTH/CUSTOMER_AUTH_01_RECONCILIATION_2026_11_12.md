# Echo Grid — CUSTOMER-AUTH-01 contract and migration reconciliation

**Date:** 2026-11-12
**Owner:** INFINICUS LLC
**Source baseline:** `main` at `0321c40f303f967f4e02bf6caf0097c20e4243f1`
**Status:** **PROPOSED DECISION RECORD — NOT LOCKED / NOT RELEASE AUTHORIZATION**
**Scope:** PRs #382, #384, #385 and #387; exact-head verification PR #388
**Activity:** Documentation only. No schema/code/API/secret change, no live inspection, no migration, no merge or deployment.

## 1. Verified repository disposition

- PR #382 (01B data contract) is merged into `main`.
- PR #384 (01C migration plan) is marked merged **into a stacked branch**, but the 01C document is **absent from current `main`**. This documentation PR restores the exact file from #384, with no substantive edit.
- PR #385 (01D-1 session-token primitives/pure policy) remains open and draft, based on the 01C branch. No customer route uses the new tokens.
- PR #387 (01D-2 migration and repositories) remains open and draft, based on #385. Its migration has not been applied to an authorized live database.
- The source tree of #387 includes all stacked dependencies but no exact-head hosted workflow had run when this reconciliation began. Draft PR #388 points at the **unchanged exact SHA** `e31026a350689e3394f4d35238d95718c623c9cb` and targets `main` solely to request hosted disposable PostgreSQL 18 and CI evidence. **Do not merge #388.**
- The last documented read-only live migration check (2026-11-12) reported 67 applied entries in each staging and production journal, with `0067_customer_preferred_locale` pending; it did not reconcile the 8 production and 13 staging historical SQL-hash discrepancies. **Not rechecked in this block.**

## 2. D-B9 — Migration ordering (proposed owner ruling)

**Recommended order:** `0067` first, authentication `0068` second, then the BDPN migration at the next free index (currently `0069` if nothing else lands). This is **not owner approval** for any step.

1. Preserve current `main` journal at 68 entries through `0067` until live drift and backup/restore readiness are reviewed.
2. In separately approved steps, apply/verify `0067` to staging and then production **before** merging or applying `0068` to a live environment. No combined unreviewed `0067` + `0068` run.
3. Complete 01D-2 reconciliation, full tests and PG18/Gate 2 certification; only then consider merging the finalized, feature-OFF schema migration into `main`.
4. Authorize `0068` separately for staging, verify schema and application compatibility, and later authorize production independently. Never turn on password authentication as a side effect of a migration.
5. After this migration slot is reserved/merged, BDPN must fetch authoritative `main` and take the next unused migration index, regenerate snapshots and Gate 2 pins. BDPN D-16/D-24 and independent activation gates still apply.

**Release risk:** PR #387 re-pins Gate 2 to **69** journal entries. Merging before `0067` is applied and independently certified in the target environments could cause migration tooling to try both schemas together and would change production acceptance expectations. If the owner reverses the ordering in favor of BDPN, re-number/re-generate authentication DDL before merge. Do not reuse `0068` twice.

## 3. MG-02 / 01B-AMEND-1 — Legacy 90-day JWT cutoff (proposed owner ruling)

**Recommendation: approve a nullable `customer_credentials.legacy_tokens_invalid_before` timestamp in the still-unapplied authentication migration.** This corrects the gap identified in 01C. PR #387 currently omits the column, schema mapping, repository handling and tests.

- A password can be enrolled **only after fresh, verified account-ownership proof**; a previously issued 90-day customer JWT alone is not sufficient.
- In the same protected transaction as first password creation, password change, verified recovery or credentialed-customer logout-all, set the cutoff to the effective security-event time. Concurrent password enrollment must not create a duplicate account.
- While legacy acceptance is enabled for compatibility, verify signature, type, customer status and customer-specific cutoff on every accepted legacy-token request. Deny legacy tokens with `iat` less than or equal to the cutoff (JWT `iat` is second precision). No cross-customer cutoff lookup.
- Customers without a password credential remain in the existing compatible OTP cohort. A logout-all mechanism for OTP-only customers **without** a credential record still needs a separate design; the proposed column cannot represent it.
- A kill switch must fail safely without allowing a legacy token to re-establish a password or override a cutoff. Record only non-sensitive authentication audit events. Never log a raw JWT/OTP/password.

**Gate:** Do not enable password enrollment, deploy dual-token verification or merge a production-intended `0068` until MG-02 is explicitly approved, migration and Drizzle snapshot regenerated, and legacy-cutoff race/replay tests pass.

## 4. Refresh-token concurrency contract (proposed correction)

01B section 7 incorrectly said a concurrent refresh inside the grace window returns the "same successor". The architecture stores only **hashes** of 256-bit raw refresh secrets; the original successor credential cannot be reconstructed.

- First valid exchange rotates atomically and returns a newly generated credential once.
- A second attempt against the rotated predecessor **inside** the 10-second provisional grace window returns a **retryable HTTP 409**, does not issue a successor and does not revoke the session. The client must use the successor already received by its primary request; this is not an excuse to retry the stale token indefinitely.
- A repeated predecessor **outside** grace is treated as replay, audited, and revokes the **compromised session plus its refresh-token chain**. Do not revoke other devices solely on this one replay under current 01B invariant I4. Password reset, password change and explicit logout-all follow distinct multi-session rules in I6.
- Both grants and denials must be verified under concurrent requests against real PostgreSQL, including when refresh races session revocation and customer suspension.

**Implementation status:** #385 implements pure policy outcomes; #387 implements the token exchange storage guard. Neither contains the fully wired service, routes, middleware or complete replay-revocation behavior. The final service must implement this rule without claiming the conflict path returns the successor. The owner may choose a different revocation blast radius, but it requires an explicit amendment before 01D-3.

## 5. Independent code and schema inspection — #387

**Observed in the draft SQL/schema:** four **new** tables — `customer_credentials`, `customer_sessions`, `customer_refresh_tokens`, `customer_auth_events`. No `customers` alteration or backfill. Foreign keys use customer deletion CASCADE for credentials/sessions, token CASCADE on session deletion, and customer SET NULL for retained events. Refresh token hashes are unique and constrained to lowercase 64-hex; session revocation requires paired timestamp/reason; auth-method, reason and event vocabularies use database checks. Event metadata uses an application-side allow-list.

**Observed in the draft repositories:** credential create uses `ON CONFLICT DO NOTHING`; session `findWithCustomer` filters by both session ID and verified customer ID; refresh `exchange` uses a conditional `rotated_at IS NULL` and `revoked_at IS NULL` update and inserts its successor in one transaction; customer session revoke updates session and token rows in one transaction.

**Not certified:**

- `legacy_tokens_invalid_before` is missing and therefore cannot be enforced as designed.
- `exchange` does not independently check session liveness/customer status within that transaction. The later service must prevent a refresh/revocation race from issuing an actionable credential after revocation. A dedicated two-connection adversarial race test is required.
- `customer_sessions.touch` and `recordStepUp` guard against revocation but do not themselves constrain absolute/idle expiry; callers must prove the liveness boundary before these writes or enforce it in the same atomic operation.
- `findByHash` is a pre-authentication lookup; downstream code must not expose the found row or treat the hash lookup alone as customer authorization.
- A direct credential repository read includes the password hash for internal verification. API DTOs and logs must never include it. Public exposure is not established by this repository.
- Audit events are **repository-append-only**, not database-immutability enforced; D-B5 (trigger decision) is open. Actual privacy/retention and RLS decisions D-B1, D-B2 and D-B7 remain open.
- New tables deliberately have no restricted-broker grants and no RLS. The pre-existing runtime owner/BYPASSRLS role is a substantive privilege issue; a successful restricted-broker denial test cannot certify runtime least privilege.
- PG16 disposable tests in #387 reportedly covered 25 new cases. Other suite failures were not reconciled against a clean baseline. No independent PG18 or actual hosted Gate 2 result was available at the start of this review. Do not claim certification on the strength of the PR body.

## 6. Required hosted PG18 and integration evidence

CI validation PR #388 is **validation-only** and uses exactly PR #387's head `e31026a350689e3394f4d35238d95718c623c9cb`. It must remain **draft and never be merged**.

The owner review requires: exact head SHA; completion and outcome of all relevant hosted workflows; PG18 clean replay of all 69 migrations from a disposable database and upgrade from previous head; 01D-2 25-case integration suite with concurrency; Gate 2 migration re-pin plus restricted-broker denial for all four tables; API unit tests/typecheck; non-owner isolation tests; and evidence that no public customer auth route has changed.

An exact-head **baseline** pass would be valuable evidence about the current unmodified #387, but **not final certification** once the required MG-02 schema change is added. After any commit to #387, repeat on its new SHA. Do not equate a successful test with owner approval to merge or run migrations.

## 7. Decisions and stop gates

| Decision | Reconciliation recommendation | State |
| --- | --- | --- |
| D-B9 | `0067`, auth `0068`, then BDPN at next free migration slot; separate environment gates | PROPOSED — owner approval pending |
| MG-02 / 01B-AMEND-1 | Add nullable per-customer legacy-JWT cutoff to unapplied `0068` | PROPOSED — owner approval pending |
| Refresh grace response | Retryable 409, no duplicate raw successor or revocation inside grace | PROPOSED — owner approval pending |
| Replay revocation | Revoke compromised session/token chain only; use all-sessions for password reset/change/logout-all | PROPOSED — owner approval pending |
| D-B7 | No newly granted broker access; resolve customer table RLS/runtime privilege separately | OPEN |
| CA-02, D-B1, D-B2, D-B5 | Session TTL/idle, privacy metadata, retention and event immutability | OPEN |

**No code, schema, migration, CI source or runtime behavior is changed by this record. PR #385 and #387 remain draft, not release-ready. No merge, deployment, live database access or automatic next block is authorized.**
