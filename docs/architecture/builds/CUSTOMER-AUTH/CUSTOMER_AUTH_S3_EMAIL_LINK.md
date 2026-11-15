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
| F5 no phone-based recovery after linking | Low, product | **Resolved by owner decision E10 (section 7).** No code change in S3; recovery is the separate block S4 |
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
4. E10 recorded (section 7). No routine phone-OTP login for linked customers, and the pre-existing phone-only `recoverPassword` / `completeRecovery` (01D-4a) gated per E10-B (enforced by RECOVERY-GUARD-01, section 7.3); S4 still required for any recovery route.
5. Exact-head hosted CI and PG18 pass on the activation change; separate owner authorization for the deploy.

## 6. Limits

Local verification used PostgreSQL 16; hosted CI uses PG18. Real Cloudflare limiter behaviour is not measured. Nothing here is a security certification.

## 7. Owner decision E10: routine login and account recovery after email linking (APPROVED 2026-11-15)

Recorded as an approved architecture decision. **It authorizes no implementation.** Recovery is not built, mounted or enabled.

### 7.1 Policy

**E10-A, routine authentication.** For a customer who has linked a verified email login credential: email-based authentication is the routine login path; phone OTP must not independently authenticate that customer; the customer id, the verified phone association, loyalty memberships, balances and history are unchanged.

**E10-B, recovery.** The verified phone may be one recovery factor. Phone possession alone must **not** authorize a password reset, email-credential replacement, session issuance, account takeover or removal of an existing authentication factor. Recovery requires additional independent ownership evidence.

**E10-C, recovery protection (requirements on the future implementation).** SIM-swap and number-reassignment risk; challenge expiry; single-use proof consumption; rate limiting; attempt exhaustion; recovery-factor independence; generic responses; recovery audit events; session revocation after success; notification through previously verified channels; handling of email unavailable, phone unavailable and both unavailable. No fallback may silently weaken existing authentication.

**E10-D, continuity.** Global customer id, memberships, business-specific balances, reward ownership, history, Community Points separation and customer authorization boundaries are preserved. Recovery restores access to the **existing** identity and never creates or merges accounts.

### 7.2 Verified state against E10 (repository inspection at PR #459 head)

| Requirement | State |
| --- | --- |
| E10-A: OTP cannot authenticate a linked customer | **Complies in the rotating session composition.** `establishSession` refuses `otp` for a customer with a verified login email (internal reason `otp_retired`, generic outward failure), `authenticateLegacyToken` rejects them, and the link transaction revokes all sessions and advances the legacy cutoff. Integration tests cover each. |
| E10-A: email login continuity | Covered by the existing integration test (email login succeeds after linking, same customer id) |
| E10-A: deployed legacy OTP router and legacy middleware | **Not enforced there by design; unmounted/unchanged.** Mounting the compatible verifier is an activation gate (section 5, item 2) |
| E10-B: phone alone cannot reset/replace/open a session | **Enforced at the service boundary by CUSTOMER-AUTH-RECOVERY-GUARD-01** (see 7.3). Before that change the dormant `CustomerPasswordAuthService.recoverPassword` (01D-4a) would have let a fresh verified-phone proof replace the password and open a `recovery` session for an email-linked customer. It had no caller outside tests and no route |

### 7.3 Recovery guard (CUSTOMER-AUTH-RECOVERY-GUARD-01, development only)

- `CustomerSessionService.completeRecovery` is the authoritative boundary. In its transaction it locks the customer row (the same lock the email link takes first), reads whether a verified login email exists, and if so returns `recovery_not_permitted` **before** any credential write, session revocation or recovery session. It records a `recovery_failed` audit event (`phone_only_recovery_not_permitted`) that commits with the refusal. No schema change: `recovery_failed` is an existing event type.
- `recoverPassword` performs a cheap early check before password policy and before any PBKDF2 work, so the outcome never depends on the supplied password. The outward result is the same generic `customer_inactive` used for suspended customers; no new outward reason exists.
- **Compatibility.** Phone-only recovery for customers **without** a verified login email is unchanged (existing tests still pass). Whether that legacy flow remains approved is an S4 decision; it is not mounted.
- **Limit.** The guard stops takeover; it cannot make the outcome indistinguishable from success for an unlinked customer, because phone-only recovery succeeds for them. Enumeration resistance is an S4 requirement.
- The deferred behavior stays: no recovery endpoint, route, credential or factor exists. A static test pins that `recoverPassword` has no non-test caller.

## 8. S4 (proposed, NOT AUTHORIZED, NOT IMPLEMENTED): CUSTOMER-AUTH-01D-4b-S4 Secure Account Recovery

**Scope (proposed).** A recovery flow for an email-linked customer that treats the verified phone as one factor among at least two independent factors; purpose-bound single-use digest-only challenges; per-surface fail-closed rate limits; generic responses; audit events; revocation of all sessions on success; notification to previously verified channels; reuse of the existing customer id only.

**Dependencies.** S3 and R1 merged; migrations `0072` and `0073` verified applied; 01D-5 rate-limit budgets approved; an approved mail and SMS delivery path; resolution of `recoverPassword` (section 7.3).

**Security gates.** No session or credential change on phone possession alone; replay, expiry and exhaustion tests; concurrency tests on PG18; SIM-swap mitigation (recovery cool-down and notification window); no account enumeration; hosted CI on the exact head; owner review. Nothing is a security certification.

**Unresolved decisions (owner).**
1. What the second independent factor is (for example the linked email, a recovery code issued at link time, or support-assisted verification) and what happens when only one factor remains.
2. Cool-down length and who is notified after a phone-initiated recovery.
3. Recovery when email is unavailable, when phone is unavailable and when both are.
4. Whether recovery may change the login email, or only the password.
5. Handling of a recycled phone number that is still recorded as verified.
6. Treatment of customers whose phone is not verified.

## 9. Changelog

| Date | Change |
| --- | --- |
| 2026-11-15 | S3 / R1 disposition; E10 recorded; S4 scoped as proposed |
| 2026-11-15 | RECOVERY-GUARD-01: E10-B enforced in the session and password services |
