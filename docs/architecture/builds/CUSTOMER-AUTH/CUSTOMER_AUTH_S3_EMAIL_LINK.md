# ECHO GRID — CUSTOMER-AUTH-01D-4b-S3

## Verified-email linking for existing phone-only customers: scope, review remediation (R1) and activation gate

**Status: DEVELOPMENT ONLY. UNMOUNTED. NOT ACTIVATED. NOT A SECURITY CERTIFICATION.**
Introduced by PR #457 (merged 2026-11-15, `f1c04de`). Remediated by CUSTOMER-AUTH-01D-4b-S3-R1 (this change). No migration, route mount, binding, secret or deployment is part of either.

## 1. What exists

`customer-email-link.service.ts` and `customer-email-link.routes.ts` let a customer who holds a **live, step-up-fresh OTP session** attach a verified login email to the **existing** customer id. The proof is purpose-bound (`email_link`), owner-bound and digest-only. An existing password is verified and kept; a customer with no credential sets a first password. On success all the customer's sessions are revoked, the legacy-token cutoff advances and an audit event is written. After linking, phone OTP and legacy tokens are refused for that customer.

## 2. R1 review disposition (independent read-only review of PR #457)

| Finding | Severity | Disposition |
| --- | --- | --- |
| F1 hashing inside a transaction holding row locks | Medium | Fixed. PBKDF2 verify/hash now runs before the transaction and holds no row locks. The transaction revalidates owner, proof, stored hash and uniqueness under lock |
| F2 wrong existing-password guesses not bounded | Medium | Fixed. A wrong existing password spends the proof's attempt budget (max 5); live `email_link` proofs per customer are capped at 3 |
| F3 deploy ordering of migration `0072` | Medium | Verified: nothing deployed reaches the `0072` columns (section 4). Pinned by a static test and an activation gate |
| F4 misleading `customer_inactive` for retired OTP | Low | Fixed internally (`otp_retired`). Callers still return one generic failure |
| F5 no phone-based recovery after linking | Low, product | **Owner decision, not changed.** Recorded as open question E10 |
| F6 unchecked row count on credential update | Low | Fixed. Exactly one row required, otherwise rollback |
| F7 missing tests and docs | Low | Tests added (suspended customer, password-method session, concurrent claim with passwords); this document and roadmap/queue rows added |

## 3. Transaction boundary

1. No locks: cheap proof check (non-consuming), credential snapshot, PBKDF2.
2. One short transaction: lock customer, session, credential; consume proof (single use); require the stored hash to equal the verified snapshot; write; revoke sessions; audit. Any throw rolls everything back, including proof consumption.

## 4. Migration dependencies (F3)

S3 needs `customer_credentials.login_email`, `login_email_verified_at` and the unique index (migration `0072`), and the `customer_auth_challenges` table and nullable `customers.phone` (migration `0073`). The journal orders `0072` before `0073`, both after `0068`.

At this commit the deployed Worker cannot reach those columns: the legacy `customerAuthenticate` default never reads credentials, `CustomerSessionService` is not constructed outside tests, and the link routes are imported only by their isolated composition. `customer-email-link-schema-compat.test.ts` fails if that changes.

## 5. Activation gate (all required; none is authorized here)

1. Migrations `0072` and `0073` verified applied in the target environment by a read-only check **before** any code that reads `login_email_verified_at` is deployed or any route is mounted.
2. The compatible verifier is composed so a linked customer cannot use the legacy default middleware: `customerAuthenticate()` without the rotating service accepts a legacy JWT without consulting the verified-email state.
3. Rate-limit bindings and budgets approved (01D-5), including a per-customer dimension for link completion.
4. Owner decision on F5 / E10 (recovery after link).
5. Exact-head hosted CI and PG18 pass on the activation change; separate owner authorization for the deploy.

## 6. Limits

Local verification used PostgreSQL 16; hosted CI uses PG18. Real Cloudflare limiter behaviour is not measured. Nothing here is a security certification.
