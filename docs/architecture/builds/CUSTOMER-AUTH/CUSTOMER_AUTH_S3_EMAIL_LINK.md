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

## 8a. Owner rulings on S4 (approved 2026-11-15; supersede the open questions above)

D1 two independent recovery factors; D2 a 24-hour hold for high-risk recovery with notifications and secure cancellation; D3 lost email = verified phone + recovery code, lost phone = verified email + recovery code, both lost = no self-service; D4 password recovery only; D5 phone possession alone is insufficient; D6 an unverified phone is never a valid recovery factor. **The hold, cancellation and notification workflows (D2) are mandatory prerequisites for activating any recovery and are NOT part of S4-01.**

## 8b. S4-01 Recovery code foundation (development only, unmounted, migration not executed anywhere real)

**What exists.** `customer-recovery-code.ts` (pure primitives), `customer-recovery-code.service.ts` (`issue`, `revoke`, `redeem`), schema `customer-recovery-codes.ts` and migration `0074_customer_recovery_codes`. No route, UI, recovery session, password reset, credential change or contact change. A static test fails if anything outside the service imports it or `index.ts` mentions it.

**Generation and storage.** 28 Crockford-base32 characters = 140 bits from the platform CSPRNG, shown as 7 groups of 4, 8 codes per set. Only a keyed HMAC-SHA-256 verifier (bound to the customer id and a purpose label, via a dedicated secret that S4-02 must add as its own binding) is stored; plaintext exists once, in the `issue` return value, and is never logged, emailed or texted.

**Schema.** `customer_recovery_code_sets` (one ACTIVE set per customer by a partial unique index; revocation metadata; failed-attempt budget) and `customer_recovery_codes` (unique (set, position) with position 1..8 bounds a set; unique (customer, verifier); consumption timestamp). Event types `recovery_code_issued|redeemed|failed|revoked` added to the audit CHECK; no new metadata keys.

**Issuance / rotation / revocation.** Requires a live `password`-method session (an email-and-password login, never `otp` or `recovery`) with fresh step-up, of an active customer holding a verified login email. Rotation revokes the previous set and inserts the new one in one transaction under the customer row lock; any failure rolls back and leaves the previous set valid.

**Redemption.** Locks the customer's active set row (serializes redemptions and rotations), consumes the matching unconsumed code with a conditional UPDATE, and spends a budget of 5 failures per 15-minute window (further attempts are refused without extra audit rows). One generic failure outward (`{ ok: false }`); the audit trail distinguishes `invalid_code`, `code_replayed`, `code_revoked` and `attempts_exhausted`. **Redeeming proves possession only; it never authorizes a password change.** E10 is unchanged and tested alongside.

**Residual risks / S4-02 requirements.** Route-level rate limiting (a dedicated limiter surface) and a dedicated HMAC secret binding are still required; the attempt budget can be exhausted by someone who already holds the other recovery factor, which delays but cannot bypass recovery; codes are shown once, so a customer who loses them must rotate while signed in; D2's hold, cancellation and notifications, and the combination of factors, are not implemented. Migration `0074` has been run only against disposable PostgreSQL.

## 8c. S4-02 Two-factor recovery orchestration (development only, unmounted; migration `0075` not executed anywhere real)

**What exists.** `customer-recovery-attempt.service.ts` (the orchestrator), `customer-recovery-policy.ts` (pure rules), `customer-recovery-config.ts` (dedicated secret), schema `customer-recovery-attempts.ts` and migration `0075_customer_recovery_attempts`. **No route, UI, recovery session or live binding exists; success issues no session.** A static test fails if anything outside the service imports it.

**State machine** (the row is the state; all security times are the DATABASE clock): `awaiting_factors` -> `factors_verified` (standard risk) | `security_hold` (high risk) -> `completed`; any non-terminal -> `cancelled | expired | rejected`. The ruling set's `initiated` is not a persisted state: creating the attempt is initiation. CHECK constraints enforce two distinct factors before any verified state, a mandatory risk class, terminal consistency, and that a `completed` attempt had its initiation notice accepted and, for high risk, its hold notice accepted and `ended_at >= hold_until`. One active attempt per customer (partial unique index); a verified-phone proof is unique per customer (no reuse across attempts); the cancel token is stored only as a keyed digest.

**Factors (D1/D3/D5/D6).** Email challenge (existing `email_recovery` purpose, bound to the customer and sent only to the customer's own verified login email), verified-phone proof (must be minted for `account_recovery`, fresh, newer than the attempt, the customer's own VERIFIED phone) and a recovery code (S4-01, redeemed inside the attempt's transaction so it is consumed if and only if recorded). Any two distinct factors satisfy a path; one never does, so a phone alone, a code alone, or both-lost cannot complete.

**Hold (D2).** HIGH risk = any path using a recovery code, or a phone verified within the recent window (7 days, an owner decision to confirm). High risk holds 24 hours, enforced in SQL against `now()`, surviving restarts and unaffected by client or service clocks. The hold is an additional safeguard, never a factor. Completion also needs the hold notice to have been ACCEPTED.

**Notifications and cancellation.** A `RecoveryNotifier` port is the only dependency; absent, failing or throwing means fail closed (attempt rejected, nothing proceeds). `accepted` means handed to the provider, not delivered. Notices never contain a code, OTP or password; only initiation and hold notices carry a cancel token (a fresh one at hold start; the old one dies). Cancellation is single use, attempt-bound, expiring and audited.

**Completion.** One transaction: completes the attempt (the guard), replaces the password hash, advances the legacy cutoff, revokes every session (`recovery`), retires the active recovery-code set (`security`) and writes the audit row. Any failure rolls all of it back. No session is issued; the customer signs in afresh.

**Rate limits.** Fail closed through the approved customer-email limiter shape, requesting only its closed budget set (5/900, 3/3600, 10/3600); keys are HMAC digests, never raw ids, phones or emails. No new namespace, binding or secret was created. **The specific per-surface budgets are an owner decision to confirm.**

**Secret.** `CUSTOMER_RECOVERY_HMAC_SECRET` (optional in `Bindings`, not in `wrangler.toml`); the services refuse to construct without a 32-byte secret and `resolveCustomerRecoverySecret` rejects reuse of another secret. Production secrets are not created here.

**Still required before any activation.** A real notifier adapter and email-challenge delivery; an OTP route that mints `account_recovery` phone proofs; routes with the trusted-source limiter; the production secret; the owner decisions above; applying `0074` and `0075` after read-only verification. Cancelling an attempt does not revoke recovery codes (consider in S4-03).

## 9. Changelog

| Date | Change |
| --- | --- |
| 2026-11-15 | S3 / R1 disposition; E10 recorded; S4 scoped as proposed |
| 2026-11-15 | RECOVERY-GUARD-01: E10-B enforced in the session and password services |
| 2026-11-15 | S4 rulings D1-D6 recorded; S4-01 recovery code foundation (draft, unmounted) |
| 2026-11-16 | S4-02 recovery orchestration (draft, unmounted); migration 0075 prepared |
