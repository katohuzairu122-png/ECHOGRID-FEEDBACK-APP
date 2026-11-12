# ECHO GRID — CUSTOMER-AUTH-01A

## Customer Authentication Architecture and Security Assessment of the Current 90-Day Session

**Status: PROPOSED DESIGN — DOCUMENTATION ONLY. NOT LOCKED. NOT AN OWNER DECISION.**
Implementation, migration, credential conversion, activation and deployment: **NOT AUTHORIZED**. Financial activation: NO-GO.

- Block: 01A of `CUSTOMER_AUTH_01_REQUIREMENTS_AND_ROADMAP.md` (Part C). Authorized by the owner for design only.
- Baseline: `8c9d0dcfe1f58a0f83aa8a4b65ec984f1d344fbb` (head of `main` when written; includes the redirect fix from PR #377).
- Everything marked **VERIFIED** was read in source at the baseline. Everything marked **UNVERIFIED** was not checked and must not be treated as fact. Everything marked **PROPOSED** is Claude's recommendation, not a decision.
- Open decisions CA-01 to CA-10 remain the owner's. This document supplies options and a recommended default for each. It does not answer any of them.

---

## 1. Purpose and scope

**Purpose.** Assess the current customer session and OTP flow, then propose the authentication architecture that would let customers log in with a password and a revocable session, without weakening any existing boundary.

**In scope.** Threat model, assessment of the current system, session and refresh model, password and credential principles, enumeration resistance, rate-limit design, recovery design, step-up rules, existing-session migration approach, audit events, and the interface 01B must satisfy.

**Out of scope (unchanged).** Schema and column definitions (01B), the migration plan for existing customers (01C), API and web code (01D to 01F), remote enrollment and BDPN D-18 (01G), Twilio budget and credential decisions, staff authentication, the customer QR for cashier service, D-C2, Split 05 to 08 financial boundaries.

---

## 2. Current system (VERIFIED at baseline)

| Area                  | Fact                                                                                                                                                                                                                                                                                                          | Evidence                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Token                 | HS256 JWT, `type: customer_access`, claims `sub`, `type`, `iat`, `exp` only. **90-day lifetime, no refresh, no rotation.** No `jti`, `sid`, `iss`, `aud` or key id.                                                                                                                                           | `apps/api/src/customer-auth/customer-jwt.ts`                                 |
| Secret                | One secret, `CUSTOMER_JWT_SECRET`, separate from staff secrets.                                                                                                                                                                                                                                               | `customer-jwt.ts`, `config/env.ts`                                           |
| Per-request check     | `customerAuthenticate` verifies the signature, then loads the customer and requires `status = 'active'` and not soft-deleted. This is a database read on every call.                                                                                                                                          | `middleware/customer-authenticate.ts`, `repositories/customer.repository.ts` |
| Revocation            | None per token or per device. The only server-side kill is suspending the whole customer.                                                                                                                                                                                                                     | same                                                                         |
| Logout                | `customerLogoutAction` deletes the browser cookie only. The token itself stays valid until `exp`.                                                                                                                                                                                                             | `apps/web/src/lib/actions/customer-auth.ts`                                  |
| Cookie                | `ff_customer_token`: `httpOnly`, `secure` in production, `sameSite=lax`, `path=/`, `maxAge` 90 days. The web server calls the API with the token as a Bearer header, so page scripts never read it.                                                                                                           | `apps/web/src/lib/customer-session.ts`                                       |
| TTL coupling          | The 90 days is duplicated by hand in the web cookie code and in `apps/web/src/app/api/customer-auth/otp/verify/route.ts`, with only a comment tying it to the API constant.                                                                                                                                   | same files                                                                   |
| Registration          | Implicit: the first successful OTP verify creates the `customers` row. No password, no profile, no consent record at that moment.                                                                                                                                                                             | `customer-auth.service.ts` `completeVerifiedPhone`                           |
| OTP in production     | Twilio Verify (`request` and `check`). The local `otp_codes` table path is used when `ENVIRONMENT !== 'production'`, so **staging does not exercise the Twilio Verify path**.                                                                                                                                 | `customer-auth.routes.ts`                                                    |
| OTP local rules       | 6 digits, 10-minute expiry, 5 attempts, 60-second request cooldown, hashed at 10,000 PBKDF2 iterations. These apply to the local path only.                                                                                                                                                                   | `otp.ts`                                                                     |
| Rate limit            | `OTP_RATE_LIMITER`, **3 per 60 seconds, keyed by the submitted phone string**, applied to **both** `/otp/request` and `/otp/verify` through one shared binding. A body with no usable phone shares one key, `phone:invalid`. The config comment still says "3/min/IP", which is no longer what the code does. | `middleware/rate-limit.ts`, `customer-auth.routes.ts`, `wrangler.toml`       |
| Phone format          | `z.string().trim().regex(E164)`, checked after the rate limiter runs.                                                                                                                                                                                                                                         | `packages/shared-types/src/customer-auth.ts`                                 |
| Enumeration           | `/otp/request` returns 204 for any phone. Failure messages on verify are generic. A suspended account gets a distinct "not active" message, but only after the caller proved phone possession.                                                                                                                | `customer-auth.service.ts`                                                   |
| Staff reference model | 15-minute access token, 30-day rotating refresh token stored hashed with a durable `sessionId`, replay detection with a 10-second concurrent-refresh grace, `revokeAllForUser` on suspected reuse, status re-checked on rotation.                                                                             | `auth/auth.service.ts`, `auth/jwt.ts`, `db/schema/refresh-tokens.ts`         |
| Password hashing      | PBKDF2-HMAC-SHA256, 600,000 iterations, chained below the 100,000-per-call Workers cap, run in a Durable Object. The hash is self-describing, so a later move to Argon2id is possible per hash.                                                                                                               | `auth/password.ts`, `auth/pbkdf2-worker.ts`, `password-hasher.do.ts`         |
| Customer QR           | Separate short-lived signed token (5 minutes, nonce, signature version). Unchanged by this design.                                                                                                                                                                                                            | `qr/customer-qr-token.ts`                                                    |
| Schema                | `customers` has `phone` (unique, E.164), no password column. Customer-auth tables today: `otp_codes`, `otp_request_cooldowns`.                                                                                                                                                                                | `db/schema/customers.ts`, `otp-codes.ts`                                     |

**UNVERIFIED (not checked in this block):**

- Twilio Verify service settings in production (attempt limits, expiry, fraud guard, geo permissions).
- Whether the production Cloudflare rate-limit namespaces behave as the `wrangler.toml` comments assume (roadmap open item O-E1).
- How the web Worker's Worker-to-Worker calls appear to the API in production, beyond what `rate-limit.ts` itself documents.
- Whether `CUSTOMER_JWT_SECRET` is ever rotated today. Nothing in the code supports rotation.

---

## 3. Trust domains and boundaries

Customer and staff stay separate in every layer. 01A proposes keeping that and making it checkable.

| Concern     | Rule (PROPOSED)                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets     | Customer signing material never shared with staff secrets or with the customer QR secret. A new purpose gets a new secret.                                       |
| Credentials | New customer credential storage. **No reuse of staff `users` rows, password hashes or reset tokens.** The PBKDF2 implementation may be reused as code.           |
| Cookies     | Customer cookies are separate from staff cookies and carry the customer prefix. A staff token must never authenticate a customer route and the reverse.          |
| Token types | Distinct `type` claim per token. Verification rejects anything else, as `verifyCustomerAccessToken` does now.                                                    |
| Middleware  | `customerAuthenticate` keeps its place and is never composed with staff tenant or RBAC middleware.                                                               |
| Data        | A customer session proves "this is customer X". It grants no business-side authority. Business scope still comes from memberships and the existing cashier flow. |

---

## 4. Threat model

Assets: the global customer identity, loyalty memberships, points and rewards, consent history, customer QR issuance, and the phone number itself.

| ID  | Threat                                                                              | Today                                                                                                                                                        | Notes                                                                                                   |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| T1  | Stolen session token (device theft, malware, shared device, leaked log)             | Valid up to 90 days. Logout does not invalidate it.                                                                                                          | Cookie flags limit script theft but not device theft.                                                   |
| T2  | Phone takeover (SIM swap, recycled number, SMS interception)                        | The phone **is** the only credential, so takeover is full account takeover.                                                                                  | Adding a password does not help if SMS recovery can reset it without further checks.                    |
| T3  | OTP brute force                                                                     | Production: depends on Twilio settings (UNVERIFIED). Local path: 5 attempts, 3-per-minute limiter.                                                           |                                                                                                         |
| T4  | Targeted lockout of a victim                                                        | Possible: anyone can send three requests a minute for a victim's phone number and exhaust that phone's shared bucket. Both request and verify spend from it. | Availability attack, not a takeover.                                                                    |
| T5  | SMS cost abuse                                                                      | The limiter is per phone, so an attacker rotating many phone numbers is not limited by source.                                                               | Each request can cost a real SMS in production. Application-level sender limits are UNVERIFIED.         |
| T6  | Credential stuffing and password guessing (new, once passwords exist)               | Not applicable yet.                                                                                                                                          | Needs limits per account **and** per source, and a hash cost that does not become a CPU attack surface. |
| T7  | Account enumeration (new login and recovery responses)                              | Current OTP responses are uniform.                                                                                                                           | New endpoints must keep that property, including timing.                                                |
| T8  | Session fixation and CSRF                                                           | Cookie is `lax` and mutations use server actions.                                                                                                            | Re-assess when refresh and device-management actions are added.                                         |
| T9  | Refresh-token replay                                                                | Not applicable yet.                                                                                                                                          | Needs reuse detection, as staff has.                                                                    |
| T10 | Cross-domain confusion (staff token on customer route or reverse)                   | Blocked by separate secrets and `type` checks.                                                                                                               | Keep, and add tests when new token types appear.                                                        |
| T11 | Recovery abuse (social engineering support, recovery to attacker-controlled factor) | Not applicable yet.                                                                                                                                          | CA-04 is open.                                                                                          |
| T12 | Insider or log leakage of tokens and OTPs                                           | Not assessed.                                                                                                                                                | Needs a logging rule in 01D.                                                                            |
| T13 | Open redirect after login                                                           | Found during 01A, fixed in PR #377.                                                                                                                          | Tracked here for completeness.                                                                          |

---

## 5. Assessment of the current 90-day session

Severity is relative to what a customer session can do today (view and redeem own loyalty data, issue the customer QR, community and messaging actions). It is not a statement about any live incident.

| #   | Finding                                                                                                                          | Severity                                 | Why it matters                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A1  | No revocation. A token captured once works for up to 90 days, and logout, a phone change or "log out everywhere" cannot stop it. | **High** for expansion, **Medium** today | Requirement 4 asks for revocable sessions. This is the central gap.                                                  |
| A2  | 90-day non-rotating lifetime with no idle timeout.                                                                               | Medium                                   | One leak has a long tail, and there is no signal that a token was stolen.                                            |
| A3  | The phone number is the sole factor and every sensitive action trusts it.                                                        | **High**                                 | Recycled numbers and SIM swaps are well-known. Adding a password does not change this while SMS can still reset it.  |
| A4  | OTP limiter is keyed by phone only and shared by request and verify.                                                             | Medium                                   | Enables T4 lockout and leaves T5 cost abuse without a source-based control.                                          |
| A5  | No audit trail for customer sign-in, failed attempts, or session events.                                                         | Medium                                   | Nothing supports incident response or the owner's request for "high-risk events".                                    |
| A6  | The token has no `sid`, `jti`, `iss` or `aud`.                                                                                   | Low to Medium                            | Blocks per-session revocation and weakens cross-system confusion defenses.                                           |
| A7  | Staging uses a different OTP path from production.                                                                               | Medium (process)                         | Production-only behavior has no pre-release exercise unless a separate decision allows real SMS in staging.          |
| A8  | TTL is duplicated by hand across API and web.                                                                                    | Low                                      | A change to one can silently desynchronize the other.                                                                |
| A9  | Rate-limit comment says IP while behavior is phone.                                                                              | Low                                      | Documentation drift, but it hides A4 and T5 from reviewers.                                                          |
| A10 | No account-level step-up concept.                                                                                                | Medium                                   | Requirement: "a verified phone is an authentication factor, not permanent authorization for every sensitive action." |

**Verdict.** The current design was a deliberate simplification and is adequate for the narrow scope it was written for. It is **not adequate** as the foundation for password login, device management, recovery and remote enrollment. Expanding capabilities on top of it without A1, A3 and A4 addressed is not recommended. Nothing in this assessment shows an exploited weakness.

---

## 6. Proposed target architecture

### 6.1 Session and refresh model (answers CA-02 as a PROPOSAL)

```
   Browser (httpOnly cookies) ──► Web server (BFF) ──Bearer──► API
        refresh cookie                 │                         │
        access cookie                  │ rotates on 401/near-exp │ verifies sig + sid
                                       ▼                         ▼
                              customer_session record  ◄── status, expiry, revoked_at
```

- **Access token:** short-lived (PROPOSED 15 minutes), signed with a customer-session secret, carrying `sub`, `sid`, `type`, `iat`, `exp`, plus `iss` and `aud` for customer use. Verified on every request, with `sid` checked against the session record.
- **Refresh credential:** opaque random value, **stored only as a hash**, rotated on every use, bound to the session. Lifetime PROPOSED 30 days absolute with an idle limit (value for the owner, see section 10).
- **Session record:** one durable row per device sign-in. It has identity, creation, last use, absolute and idle expiry, revocation time and reason, coarse device label and source (never raw credentials). Fields are 01B's job.
- **Rotation and replay:** reuse of a rotated refresh credential revokes the whole session (and flags it for audit). A short concurrent-refresh grace, in line with the staff 10 seconds, avoids false positives from double submits.
- **Revocation:** by session (this device), all sessions (log out everywhere), on password change, on recovery, and on suspension. `customerAuthenticate` keeps its per-request customer status check and adds the session check.
- **Logout:** revokes the server-side session and clears cookies. It does not delete the customer or any membership (requirement A.9).
- **Cookies:** `httpOnly`, `secure`, `sameSite=lax`, `path=/`, no `Domain`, and in production the `__Host-` prefix. Short access cookie and longer refresh cookie, each with an explicit `maxAge` taken from one shared constant instead of a copied number (fixes A8).
- **Alternative considered and not preferred:** keep a single long token plus a server-side denylist. Simpler, but a long-lived bearer token stays the unit of trust, there is no natural place to detect theft, and the denylist grows. Rotation gives theft detection for the cost of one table.

### 6.2 Credential and password principles (inputs to CA-01)

- Reuse the existing PBKDF2-HMAC-SHA256 implementation and its self-describing hash so Argon2id can come later per hash. Store customer credentials in **new customer-only storage** (01B).
- Password rules follow current NIST SP 800-63B style guidance (PROPOSED): minimum length (value for the owner), no forced composition rules, no periodic rotation, allow long passphrases and password managers, reject the account phone number and obvious values, and optionally a breached-password check. The breached-password check needs an outbound network decision and is flagged for the owner.
- Password hashing runs through the existing Durable Object worker. Because each attempt costs 600,000 PBKDF2 rounds, login **must** be rate limited before hashing, or the endpoint becomes a CPU-exhaustion vector (T6).
- Password change and reset revoke all other sessions.

### 6.3 Account enumeration resistance

- Login, registration start and recovery start return the **same status code and body shape** for known and unknown phones.
- Perform a dummy hash verification on unknown accounts so timing does not reveal existence.
- OTP request keeps its uniform 204.
- Messages stay generic ("Phone or password is incorrect"). Distinct states (suspended) are shown only after a proof of phone possession, as today.
- Registration should not reveal "this number already has an account" before ownership is proven. A flow that proves the phone first, then branches, avoids that.

### 6.4 Rate-limit design (answers part of A4 and T4 to T6)

PROPOSED principles. Numbers belong to the owner and need real traffic data.

| Surface        | Keys                                                         | Principle                                                                                                                       |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| OTP request    | per phone **and** per source **and** a global sender ceiling | Per-phone limits cap harassment of one number, per-source limits cap volume, a global ceiling caps cost.                        |
| OTP verify     | per phone, per source                                        | Separate budget from request, so requests do not consume verify attempts.                                                       |
| Password login | per phone, per source, and per phone+source                  | Separate namespace. Prefer progressive delay and per-source limits to hard account lockout, because hard lockout turns into T4. |
| Recovery       | per phone, per source                                        | Stricter than login.                                                                                                            |
| Refresh        | per session                                                  | Loose. Detects abuse and replay.                                                                                                |

- Separate limiter bindings per purpose, so one surface cannot spend another's budget.
- Keep the shared `phone:invalid` key behavior out of new routes. Reject malformed input without consuming a shared bucket.
- The source-key source (IP versus a stable subject) depends on how the web Worker's calls reach the API, which is UNVERIFIED (O-E1). 01D must verify this before sizing limits.
- Every limit change needs the owner's budget decision, because SMS has real cost.

### 6.5 Registration and routine login (answers part of CA-05 as a PROPOSAL)

```
New customer:    phone ─► OTP (Twilio Verify) ─► set password ─► session
Returning:       phone + password ─────────────────────────────► session
Existing OTP-only customer, first return: OTP ─► offer password ─► session
Forgot:          phone ─► OTP ─► (extra factor if risk) ─► new password ─► all other sessions revoked
Business QR:     already signed in ─► no OTP ─► explicit join choice
```

- Registration, joining a business, following a business and marketing consent stay **separate actions**. Account creation records only what account creation needs. No promotional consent is required.
- Minimal profile (verified phone, password, optional name) as in the roadmap's initial view.

### 6.6 Step-up and high-risk events (answers requirement 8 as a PROPOSAL)

A verified phone is a factor, not a standing license. PROPOSED triggers for re-verification (fresh OTP or password within a recent window):

- change of password, phone number or recovery method
- "log out everywhere", account deletion, data export
- sign-in from a new device after a recovery event
- any future action that moves value or exposes sensitive data

Which actions are in this list, and the "recent" window, are owner decisions.

### 6.7 Recovery (CA-04, options only)

The risk is recovery that is weaker than the login it protects.

| Option                                                              | Strength                                               | Weakness                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| R1: SMS OTP to the registered phone only                            | Simple, no new data                                    | Fails when the phone is lost, and recycled numbers are exposed to T2. |
| R2: R1 plus a verified email added later                            | Second channel, lets a user recover after a lost phone | Collects and must verify an email, expands scope and privacy surface. |
| R3: Support-assisted recovery with strict identity checks and audit | Covers lost phone                                      | Social engineering risk, staffing and policy needed.                  |

**PROPOSED:** R1 for password reset with the step-up above and notification to the old session channel, and R2 as an opt-in second factor. R3 only with a written policy. This is an owner decision.

### 6.8 Existing sessions and migration approach (inputs to CA-03, CA-09, and 01C)

- Existing 90-day tokens remain valid until their own expiry. No forced invalidation before a compatible recovery path exists (requirement 5).
- A **kill switch** can stop accepting legacy tokens if abuse is detected.
- A legacy token carries no `sid`, so it is treated as a **low-assurance session**: normal loyalty use continues, but it cannot perform step-up actions or credential changes until re-verified.
- The first OTP sign-in after release offers to set a password and replaces the legacy session with a revocable one. Same `customers` row, no duplicate identity.
- Rollout is progressive (cohort or flag). 01C owns the repeatability and no-duplicate rules.

---

## 7. Audit and observability (PROPOSED)

Record, without secrets or raw codes: OTP requested, OTP verified or failed, password login success and failure, password set or changed, recovery started and completed, session created, rotated, revoked and replay detected, step-up passed or failed, rate-limit hits, legacy-token use, kill-switch changes. Events carry the customer id, session id and a coarse source indicator, and follow the repository's existing audit conventions. Retention and privacy rules need the owner's decision. Logs must never contain tokens, OTPs or passwords (T12).

---

## 8. Interface 01B must satisfy

01B designs the storage. 01A requires only that it can express:

1. A customer credential record, one per customer, with a self-describing hash and change history.
2. A customer session record with rotating refresh-credential hashes, absolute and idle expiry, revocation reason and replay detection.
3. A customer auth event record for the audit list in section 7.
4. A way to mark legacy sessions without a `sid` and to count them for rollout.
5. No new customer identity table. No change to `customers.phone` uniqueness. No staff table reuse.
6. A migration list and a Gate 2 impact statement, sequenced behind the pending `0067` and the D-C1 rollout.

---

## 9. Verification the later blocks must provide (not performed here)

- Unit and integration tests for rotation, replay revocation, expiry, idle limit, logout and suspension.
- Cross-domain tests: staff token rejected on customer routes and the reverse, QR token rejected as a session.
- Enumeration tests (status, body, timing class) for login and recovery.
- Rate-limit tests per surface and per key, including the lockout case.
- Legacy-token behavior tests, including the kill switch.
- A real-device and Twilio Verify test plan, which depends on the owner's SMS credential and budget decision (CA-10, roadmap Part D).
- A red-team style review of recovery before any activation.

---

## 10. Decisions needed from the owner (CA-01 to CA-10)

01A does not answer these. The table says what 01A needs to finish 01B.

| ID           | What 01B needs                                           | 01A recommendation (PROPOSED)                                                   |
| ------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| CA-01        | Confirm PBKDF2 reuse and separate customer storage       | Yes, with an Argon2id path later                                                |
| CA-02        | Access and refresh lifetimes, idle limit, absolute limit | 15 minutes access, rotating refresh, 30-day absolute. Idle limit for the owner. |
| CA-03        | Whether password setup is offered or required after OTP  | Offered at first return, required only for new registrations                    |
| CA-04        | Recovery option R1, R2 or R3                             | R1 plus opt-in R2                                                               |
| CA-05        | Minimal profile and password minimum length              | Phone, password, optional name                                                  |
| CA-08        | Notice and consent language for both entry paths         | Separate versioned notices, no promotional consent required                     |
| CA-09        | Rollout shape and kill-switch ownership                  | Progressive with a kill switch, legacy tokens honored until expiry              |
| CA-10        | Real-device and Twilio test budget                       | Needed before 01D activation                                                    |
| CA-06, CA-07 | Not needed for 01A to 01C                                | Deferred to 01G                                                                 |

Additional owner inputs 01A surfaced:

- Whether production needs **source-level** and **global** limits on OTP requests now, ahead of the password work (findings A4 and T5).
- Whether real SMS may be used in staging so the Twilio Verify path gets exercised (A7).
- Breached-password checking: allowed outbound host, or not.
- Step-up action list and the "recent verification" window.

---

## 11. Low-risk hardening candidates (NOT part of this block, NOT authorized)

These need their own authorization. They do not need the new session model.

1. Correct the stale "3/min/IP" comment and document the real key.
2. Split request and verify into separate limiter budgets.
3. Add a source-based and global ceiling on OTP request cost.
4. Replace the duplicated 90-day constant with one shared value.
5. Add audit events for the existing OTP flow.

---

## 12. Risks, assumptions, residual risk

- This design adds server state on the hot path (a session check per request). Cost and latency are not measured. 01D must measure before rollout.
- Rotation adds client complexity at the web server. Concurrent-request races are handled by the grace window, which is a known trade-off.
- Phone-number recycling (T2) is reduced, not removed, by passwords plus step-up. It remains a residual risk while SMS is a recovery channel.
- The assessment covers code at the baseline only. Production Twilio and Cloudflare settings are UNVERIFIED.
- No test, build or deployment was run for this block.

## 13. Future work

01B data contract, 01C migration plan, 01D API, 01E web, 01F business-QR path, 01G remote enrollment (needs a D-18 amendment), 01H certification. Each needs its own authorization.

## 14. Changelog

| Date       | Change                            |
| ---------- | --------------------------------- |
| 2026-11-12 | First draft of 01A (design only). |
