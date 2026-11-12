# CUSTOMER-AUTH-01A — Architecture and Security Assessment

**Status: DESIGN PROPOSAL — DOCUMENTATION ONLY (owner-authorized: "CUSTOMER-AUTH-01A design only").**
No code, schema, migration, endpoint, UI, credential, Twilio or Neon change is made or authorized. No customer data was read. The target design below is **not locked**: every `CA-xx` item is a recommendation for the owner to decide.

- Baseline: `origin/main` @ `41f9a6f6106d2c99383d97e1ac24ae82bddbe71d`.
- Parent: `CUSTOMER_AUTH_01_REQUIREMENTS_AND_ROADMAP.md` (owner requirements, Part A; open decisions CA-01 to CA-10).
- Evidence rule: every statement about the current system was checked in source at this baseline. Statements that are not checked are marked **UNVERIFIED**. Where I ran something to confirm a behaviour, the command and result are in section 11.
- Next blocks this feeds: 01B (data contract) and 01C (migration plan). Neither is started.

## 1. Executive summary

**Verdict on the current customer authentication: adequate for "view and redeem my own points", not adequate as the base for a durable account that carries a password, remote enrollment and more sensitive actions.** The owner's requirement to assess the 90-day session first is justified.

Findings that matter most (details in section 4):

| ID   | Finding                                                                                                                                                                                                                 | Severity (my rating)                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| F-A1 | Post-login redirect target `next` can be pointed at another site (open redirect). **Verified end to end in logic and in Chromium.** Affects customer and staff sign-in                                                  | High (phishing after a real login)          |
| F-A2 | A customer session is one 90-day bearer token that **cannot be revoked individually**; logout only deletes the browser cookie, and there is no device list or "sign out everywhere"                                     | High once an account holds more than points |
| F-A3 | Sign-in strength is SMS only. A SIM swap, or a recycled phone number, gives full account control                                                                                                                        | Medium to High                              |
| F-A4 | The OTP rate limit is **per phone number only**: no per-client and no global cap. Two consequences: anyone can lock a victim's number out of requesting codes, and an attacker can spend SMS budget across many numbers | Medium                                      |
| F-A5 | No audit events exist for customer authentication                                                                                                                                                                       | Medium                                      |
| F-A6 | Production and non-production use different verification code paths, so the path that runs in production is not the one most tests exercise                                                                             | Medium (process)                            |

Design recommendations in one paragraph: keep the phone as the verified anchor and one customer row; add a **separate** customer credential table with a password; replace the single token with a **short-lived access token plus a rotating refresh token tied to a server-side session record**, with replay detection and per-device revocation (the staff system already proves this pattern); never depend on Next middleware for refresh; layer abuse limits (per phone, per client, global, bot check) in front of every SMS send; keep SMS OTP as the recovery path and as a transitional login; require a fresh proof for sensitive actions; migrate existing OTP-only customers by letting them create a password after a normal OTP login, with no duplicate account and no forced invalidation.

## 2. Scope and non-goals

In scope: current-state assessment, threat model, target architecture, abuse controls, migration approach, decision options, test requirements.
Out of scope: any implementation, schema definition (01B), migration procedure (01C), copy, translations, SMS provider changes, consent wording (CA-08), remote enrollment design (01G, needs the D-18 amendment). The existing separation holds: customer QR for cashier service, D-C2, Community Points, settlements and all financial restrictions are untouched.

## 3. Current state (verified)

### 3.1 Components

| Component                | What it does today                                                                                                                                                                                                                                                                  | Source                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Identity                 | One `customers` row per phone (`phone` unique, E.164). No password column. Statuses `active` and `suspended`                                                                                                                                                                        | `db/schema/customers.ts`                                                                               |
| Request code             | `POST /customer-auth/otp/request`. Production: Twilio Verify. Non-production: local code stored hashed (PBKDF2, 10,000 iterations) in `otp_codes`, "sent" through a console SMS service                                                                                             | `customer-auth.routes.ts`, `customer-auth.service.ts`, `otp.ts`                                        |
| Verify code              | `POST /customer-auth/otp/verify`. On success finds or **creates** the customer (registration and login are one step) and returns an access token                                                                                                                                    | `completeVerifiedPhone`                                                                                |
| Session                  | One HS256 JWT: `sub` = customer id, `type: customer_access`, 90 days, no refresh, no session id. Separate secret `CUSTOMER_JWT_SECRET`                                                                                                                                              | `customer-jwt.ts`                                                                                      |
| API check                | `customerAuthenticate` verifies the token, then loads the customer and requires `status = active`. Nothing else is checked                                                                                                                                                          | `middleware/customer-authenticate.ts`                                                                  |
| Routes that depend on it | Ten route modules: loyalty, memberships, consent, community, community points, surveys, messaging, language, two settlement modules                                                                                                                                                 | `grep customerAuthenticate`                                                                            |
| Web session              | Next server action or route handler receives the token from the API and stores it in cookie `ff_customer_token`: HttpOnly, Secure in production, SameSite Lax, 90 days, path `/`. A 10-minute HttpOnly cookie holds the pending phone. The layouts gate on cookie **presence** only | `lib/customer-session.ts`, `lib/actions/customer-auth.ts`, `app/api/customer-auth/otp/verify/route.ts` |
| Logout                   | Deletes the cookie. The token remains valid until it expires                                                                                                                                                                                                                        | `customerLogoutAction`                                                                                 |
| OTP limit                | `OTP_RATE_LIMITER`: 3 per 60 seconds, **keyed by the phone number**, because the web Worker's calls would otherwise all share one address                                                                                                                                           | `rate-limit.ts`, `wrangler.toml`                                                                       |
| Business QR flow         | `/loyalty/[token]` resolves the business QR publicly; a signed-in customer sees the check-in panel; otherwise sign-in with a `next` return path. Joining records explicit join consent                                                                                              | `app/loyalty/[token]/page.tsx`, `customer-membership.service.ts`                                       |
| Customer QR              | Separate short-lived signed token for cashier service                                                                                                                                                                                                                               | `qr/customer-qr-token.ts`                                                                              |

### 3.2 What the code does well (keep)

Separate secret and a `type` claim for customer tokens; customer status checked on every request; OTP codes hashed, with an attempt cap and a guarded single-use consume that closes the concurrent-verify race; generic "invalid or expired" answers; the verify path returns no signal about whether a number was known; HttpOnly, Secure, SameSite cookies; a rate limiter that is aware of the Worker-to-Worker address problem; and staff authentication already implements rotation with replay detection that can be mirrored.

## 4. Findings

### F-A1 Open redirect after sign-in — High — **separate fix recommended, not part of 01A**

The web app validates `next` with "starts with `/` and not `//`". The value `/\evil.test/phish` passes that check, and the URL parser and browsers treat the backslash as a slash, so it resolves to another site.

- Verified: the check accepts it (Node); `new URL('/\\evil.test/phish', base).origin` is `https://evil.test`; Chromium navigated to `http://evil.test/phish` from `window.location.href = '/\\evil.test/phish'`; the customer verify route builds `NextResponse.redirect(new URL(next, request.url), 303)`, so a successful login can be redirected off-site.
- Where the same weak check appears: customer verify route, customer verify action, staff login and signup actions, staff login and signup pages.
- Impact: a crafted login link sends a freshly authenticated user to an attacker page that looks like Echo Grid.
- I queued a separate fix task (shared safe-redirect helper with tests). 01D must use that helper and must not add new sinks.

### F-A2 Non-revocable 90-day bearer — High for the target scope

- The only server-side check is "customer row exists and is active". A stolen token works for up to 90 days; logout does not invalidate it; there is no device list and no "sign out everywhere". Suspending the customer is the only kill switch, and it is account-wide.
- The source justifies this by the low stakes ("view or redeem my own points"). A password, remote enrollment, consent changes and profile data raise the stakes.
- Recommendation: server-side sessions with rotating refresh (section 6.3).

### F-A3 SMS-only factor, number recycling — Medium to High

- Whoever receives the SMS signs in. SIM swap and port-out give full control. A phone number that is reassigned to a new person lets them register or sign in as the previous owner and inherit points, memberships and messages (the identity is the number).
- Recommendation: the password lowers routine SMS exposure; sensitive actions need fresh proof; a recovery design that does not silently hand an account to whoever holds a number now (section 6.7); detect "number changed hands" signals where the provider offers them (UNVERIFIED availability).

### F-A4 Rate limiting is per phone only — Medium

- 3 requests per minute per phone number is the only limit on `/otp/request` and `/otp/verify`. There is no per-client limit and no global limit.
- Targeted lock-out: an attacker can spend a victim's 3 requests every minute and block the victim from receiving a code.
- Cost abuse: each distinct number gets its own allowance, so cycling through numbers is not limited by this layer. Twilio's own send and attempt limits (about five sends per verification lifecycle) help per number but not across numbers.
- Documentation drift: the route comment says "3/min/IP" while the code keys by phone.
- Recommendation: layered limits (section 6.5), including a trusted client-address signal from the web tier.

### F-A5 No customer-authentication audit trail — Medium

No audit event is written by the customer-auth module (verified: no audit calls in `customer-auth/`). Account takeover cannot be investigated. Recommendation: section 6.9.

### F-A6 Two verification paths — Medium (process)

Production uses Twilio Verify plus `completeVerifiedPhone`; development and tests use the local code table. The shared point is `completeVerifiedPhone`. Recommendation: a provider interface with two implementations behind identical contract tests, and the real provider exercised in a controlled non-production run before any activation (CA-10).

### Minor and structural observations

- F-A7: after a correct code, a suspended account gets a distinct "not active" error. It requires phone proof first, so exposure is low; keep the message generic in the redesign.
- F-A8: the `customers.phone` unique constraint includes soft-deleted rows, which complicates re-registration and account deletion. 01B must decide.
- F-A9: the web tier refreshes **staff** sessions in Next middleware, and the deployed configuration forces minimal mode, which the repository documents as skipping middleware. **Customer** refresh must therefore not depend on middleware. Whether staff refresh behaves correctly in production is UNVERIFIED and is not part of this block.
- F-A10: the pending-phone cookie stores the raw phone number (HttpOnly, 10 minutes). Acceptable; consider a server-side pending record in 01B.

## 5. Threat model

Assets: customer account and its memberships, points and rewards; the phone number; sessions; SMS budget; the trust between a business and its customers; the customer QR token.
Actors: another customer; a business user; a platform operator; an external attacker (phishing, credential stuffing, SMS pumping, session theft); a malicious or compromised device.
Trust boundaries: browser to web tier (BFF) to API to database; web tier to Twilio; customer domain versus staff domain (separate secrets, cookies, tables and middleware).

| ID   | Threat                                                          | Today                                            | Target control (section 6)                                                                                           |
| ---- | --------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| T-01 | Open redirect after login                                       | Present (F-A1)                                   | Shared safe-redirect helper, allowlisted internal paths                                                              |
| T-02 | Stolen session token reused                                     | Valid up to 90 days                              | Short access token, rotating refresh, replay detection, per-session revoke                                           |
| T-03 | SIM swap or number reassignment                                 | Full control                                     | Password for routine login; step-up for sensitive actions; recovery rules; new-device notice                         |
| T-04 | Credential stuffing on password login                           | n/a                                              | Per-phone and per-client throttles with progressive delay, breached and common password blocklist, generic errors    |
| T-05 | Account enumeration (registered or not)                         | Mostly generic                                   | Same response and timing for every registration and login outcome; dummy-hash work for unknown numbers               |
| T-06 | SMS pumping and cost abuse                                      | Per-phone limit only                             | Bot check before sending, per-client and global budgets, destination-country policy, provider fraud controls         |
| T-07 | Targeted OTP lock-out of a victim                               | Possible                                         | Separate counters for "requests" and "verify attempts"; verify path not blockable by third parties; per-client limit |
| T-08 | Password reset takeover                                         | n/a                                              | Recovery needs phone proof; reset revokes every session; notice to the user                                          |
| T-09 | Refresh token theft                                             | n/a                                              | Rotation with reuse detection that kills the whole session family                                                    |
| T-10 | CSRF on state-changing requests                                 | Lax cookie, server actions                       | Keep Lax plus origin checks; step-up for sensitive actions; no state change on GET                                   |
| T-11 | Cookie theft by script                                          | HttpOnly                                         | Keep HttpOnly; add the `__Host-` prefix                                                                              |
| T-12 | Cross-domain confusion (staff token as customer or the reverse) | Separate secret and `type`                       | Keep; distinct key ids, issuers and audiences; separate tables                                                       |
| T-13 | Existing 90-day tokens after the redesign                       | n/a                                              | Compatibility window with reduced rights, then expiry (CA-09)                                                        |
| T-14 | Phishing of the code or password                                | Possible                                         | Domain-bound messages; no password in SMS; training copy in 01E                                                      |
| T-15 | Weak recovery when the phone is lost                            | n/a                                              | Owner decision CA-04; no silent fallback                                                                             |
| T-16 | Account takeover goes unnoticed                                 | No audit                                         | Audit events, rate and anomaly alerts, user-visible session list                                                     |
| T-17 | Session fixation or login CSRF                                  | Server action sets the cookie after verification | New session identifier on every login; reject cross-site login posts                                                 |
| T-18 | Information leaked in logs                                      | Phone in some error paths UNVERIFIED             | Never log phone, code, password or token; hash identifiers in audit                                                  |

## 6. Target architecture (proposal)

### 6.1 Principles

One global customer identity (`customers`), unchanged. Credentials and sessions live in **new, separate** customer tables and are never shared with staff tables. Code (the password hashing worker, rotation logic) may be shared; rows, secrets and cookies may not. A verified phone is an authentication factor, not blanket authorization. Fail closed. Every state change is audited. Registration, joining, following and marketing remain separate actions.

### 6.2 Credential model (CA-01)

- A password credential belongs to one customer. Stored as a self-describing hash. Recommendation: reuse the existing PBKDF2-HMAC-SHA256 implementation (600,000 iterations, chained inside the Worker limit) for compatibility and speed of delivery, with the hash format allowing an upgrade to Argon2id per hash at the next successful login.
- Policy: minimum length around 10 and a generous maximum, no composition rules, a common and breached password check, no hints, no security questions.
- Throttling uses progressive delays per phone and per client, not a hard lock that a third party could trigger (T-07).
- Unknown numbers do the same hashing work as known ones (T-05).

### 6.3 Sessions (CA-02)

- A server-side session record per login (device label, created, last used, expiry, revoked). An access token that is short-lived (about 15 minutes) and carries the session id; a refresh token that is long-lived, stored only as a hash, **rotated on every use**, with reuse detection that revokes the whole session (the staff implementation is the reference).
- Lifetimes (recommendation, owner to confirm): idle expiry about 30 days, absolute expiry 90 days (equal to today's maximum), sensitive actions need a recent proof.
- Controls: list devices, revoke one, revoke all, automatic revoke-all on password change and recovery, revoke on suspension.
- Cookies: prefix `__Host-`, HttpOnly, Secure, SameSite Lax (Lax keeps QR-link navigation working), path `/`. Refresh happens in a route handler or server action that is allowed to set cookies, **never in middleware** (F-A9) and never during render.
- Token format: separate signing key with a key id, issuer and audience claims, so keys can rotate and staff tokens can never validate as customer tokens.

### 6.4 Step-up verification

"Sensitive" actions need proof within a short window (about 10 minutes) by password or a fresh SMS code. Proposed list for the owner to confirm: change password; change or add a recovery method; change the phone number; delete the account; view or export personal data; consent changes that affect third parties; remote enrollment confirmation (when 01G exists). Routine loyalty actions (view points, scan, join at a business QR) do not need it.

### 6.5 Abuse controls in front of every SMS send and every login

- Per phone: requests and verify attempts counted separately (T-07).
- Per client: needs a **trusted** client address. The web tier would forward the end user's address in a header authenticated with a shared secret; the API trusts it only with that secret (otherwise the Worker-to-Worker collapse documented in the code returns).
- Global: a daily and hourly send budget with an alert, and a switch to disable SMS sends.
- Bot check before the first SMS for a new registration (for example a Cloudflare Turnstile style challenge). Provider choice is an owner decision.
- Destination policy: which country codes may receive SMS (owner decision), plus provider fraud controls (UNVERIFIED which Twilio Verify protections are enabled on the account).

### 6.6 Flows (design level)

**Public registration:** phone → bot check → SMS code → create the customer (if new) → set password (required before a session starts) → session. Joining any business is a separate, later, explicit action.
**Password login:** phone and password → session. No SMS.
**Business QR:** valid session → straight to the business panel with an explicit join choice, no OTP; no session → sign in or register, then return to the QR page through the safe-redirect helper. The business-focused view is only a presentation hint; it creates no second identity.
**Customer QR for cashier service:** unchanged.
**Legacy code login:** during migration, "sign in with a code" remains available and doubles as recovery.

### 6.7 Recovery (CA-04)

Standard path: SMS code → set a new password → every other session revoked → the user is told. When the phone is unavailable, options (owner decision): (a) an optional verified email added while signed in, used only for recovery; (b) support-assisted recovery with strict identity checks, a waiting period and audit; (c) no recovery (the number is the account). Never recovery through a business, because that crosses tenants. Number reassignment is handled by (b) and the notice in 6.4, not silently.

### 6.8 Migration of existing customers (CA-03, CA-09) — design level; detail in 01C

No table swap and no re-registration: the credential row is keyed to the **same customer id**, so points, memberships, consent history, messages, surveys and Community memberships stay attached. An OTP-only customer signs in with a code as today and is offered, then later asked, to create a password. Old 90-day tokens keep working until they expire, with reduced rights (no step-up-protected actions) and are replaced by the new session model on the next sign-in. Nothing forces a password before the recovery path exists. Rollout is progressive behind a switch, and the old path is removed only after a stability period.

### 6.9 Audit and observability

Events: registered, login succeeded, login failed (rate limited), password set, password changed, recovery requested, recovery completed, session created, session revoked, refresh reuse detected, step-up passed or failed, suspension. Identifiers are stored hashed or truncated; never the phone, code, password or token. Alerts on spikes of failures, sends and reuse detection.

### 6.10 API surface (names are proposals; 01B defines contracts)

Registration start and verify; set password; login; refresh; logout; sessions list and revoke; password change; recovery start, verify and complete; legacy code login. Registration, login and recovery responses are identical for every outcome and equalized in time.

### 6.11 Impact on existing code

Ten customer route modules keep calling one middleware, so the change concentrates in `customerAuthenticate` (session-aware verification) and in the web customer client (refresh handling). Layout gating by cookie presence is kept, with refresh on 401. `completeVerifiedPhone` becomes one step among several. Customer routes keep their rate limiter; its keying is part of 6.5.

## 7. Decisions CA-01 to CA-10: options and recommendations (owner decides)

| ID                                  | Options                                                               | Recommendation                                                             | Consequence of the recommendation                                                  |
| ----------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| CA-01 Hashing                       | PBKDF2 reuse; Argon2id now; external identity provider                | PBKDF2 reuse now, Argon2id path later                                      | Fast to deliver and consistent; accepts OWASP-approved but not top-ranked          |
| CA-02 Sessions                      | Keep one token; rotating refresh with server session                  | Rotating refresh, server session, 15-minute access                         | New table and refresh handling in the web tier; per-device revoke becomes possible |
| CA-03 Migration                     | Force password at next login; offer then require later; keep OTP only | Offer, then require after a notice period and only once recovery works     | No customer is locked out                                                          |
| CA-04 No-phone recovery             | Verified email; support-assisted; none                                | Optional verified email plus a gated support path                          | Needs an email proof flow and a support procedure                                  |
| CA-05 Registration                  | Phone and password only; plus name and email                          | Phone and password; everything else optional later                         | Lowest friction; no compulsory marketing consent                                   |
| CA-06 Remote enrollment eligibility | Any business; published and plan-eligible                             | Published BDPN profile plus plan rule (waits for D-24)                     | Blocked until BDPN-01 and the D-18 amendment                                       |
| CA-07 Scope of remote enrollment    | All programs; business opt-in                                         | Business opt-in                                                            | Businesses control exposure                                                        |
| CA-08 Consent notices               | One notice; one per entry path                                        | One per path, versioned                                                    | Evidence per action                                                                |
| CA-09 Existing sessions             | Invalidate all; honour until expiry                                   | Honour until expiry, reduced rights                                        | No outage; longer tail of old tokens                                               |
| CA-10 Certification                 | None; staged                                                          | Real-device tests, Twilio test-mode run, security review before activation | Needs your Twilio and budget decision                                              |

Additional decisions this assessment raises: SMS destination countries and daily budget; bot-check provider; whether to forward a signed client address from the web tier; which actions require step-up; whether registration without a password is ever allowed.

## 8. Security requirements and test plan for later blocks

Mapped to the owner's acceptance conditions 1 to 12:

| Requirement                                   | Must be proven by tests                                                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| SR-01 Verified phone before the first session | Registration cannot complete without a valid provider approval (acceptance 1, 2)                                                                     |
| SR-02 Password login without SMS              | A returning customer signs in with phone and password only; no provider call is made (3, 4)                                                          |
| SR-03 Enumeration resistance                  | Identical status, body and similar timing for known, unknown, suspended and rate-limited numbers across registration, login and recovery             |
| SR-04 Layered rate limits                     | Per phone, per client and global limits trip independently; a victim cannot be locked out by a third party                                           |
| SR-05 Session revocation                      | Revoke one, revoke all, logout, password change and recovery each invalidate the right sessions immediately (7)                                      |
| SR-06 Refresh rotation                        | A used refresh token is dead; replay revokes the family                                                                                              |
| SR-07 Recovery                                | Phone recovery works and revokes all sessions; no recovery without proof (5)                                                                         |
| SR-08 Migration                               | An OTP-only customer creates a password with the same id; the row count is unchanged; memberships and points intact; the migration is repeatable (6) |
| SR-09 Business QR                             | Signed-in scan needs no OTP; joining requires an explicit choice and only that business (4, 8)                                                       |
| SR-10 Domain separation                       | A staff token never authenticates a customer route and the reverse; distinct keys, issuers and cookies                                               |
| SR-11 Redirect safety                         | The shared helper rejects every bypass in the findings list (F-A1)                                                                                   |
| SR-12 No unintended grants                    | No auth action creates points, credits, settlements or marketing consent (12)                                                                        |
| SR-13 Cashier boundary                        | Customer QR verification still exposes nothing outside the cashier's business (10, 11)                                                               |
| SR-14 Audit                                   | Every event in 6.9 is recorded without personal identifiers in clear                                                                                 |
| SR-15 Failure behaviour                       | Provider outage, rate-limit store failure and database failure all fail closed with a retryable message                                              |
| SR-16 Real-device certification               | iOS and Android browsers, installed web app, cookie persistence, camera and QR flows (CA-10)                                                         |

## 9. Risks, constraints and dependencies

- Needs a schema migration (credentials and sessions) and a Gate 2 journal re-pin. `0067` is still pending in production and staging and the D-C1 rollout is pending, so sequencing matters (one schema or authorization change at a time).
- Twilio: real SMS has a cost and a provider fraud surface. No real credentials are used in development; testing the real path needs your explicit decision.
- Compatibility: ten route modules and the web customer client change together; a progressive rollout with a switch is required.
- Number recycling and SIM swap cannot be fully removed by software; the design reduces exposure and makes takeovers visible.
- Remote enrollment (01G) is blocked by BDPN-01 and the D-18 amendment.
- UNVERIFIED: which Twilio Verify fraud protections are enabled; whether staff refresh works in the deployed configuration; production limiter bucket behaviour (open item O-E1).

## 10. What 01B and 01C must produce

01B: tables, constraints, indexes and retention for credentials, sessions, recovery methods and audit; unique-phone behaviour with deleted rows (F-A8); token claim contract; Gate 2 and migration impact.
01C: the migration procedure for OTP-only customers, with a dry run, rollback and communication plan; handling of old tokens; the progressive rollout switch.

## 11. Evidence appendix

Files inspected: `apps/api/src/customer-auth/*` (routes, service, jwt, otp, sms, twilio-verify), `middleware/customer-authenticate.ts`, `middleware/rate-limit.ts`, `db/schema/customers.ts`, `db/schema/refresh-tokens.ts`, `auth/password.ts`, `auth/auth.service.ts`, `wrangler.toml` (limiter and minimal-mode settings), `apps/web/src/lib/customer-session.ts`, `lib/actions/customer-auth.ts`, `lib/api-client.ts`, `app/api/customer-auth/otp/verify/route.ts`, `app/loyalty/[token]/page.tsx`, `middleware.ts`.
Commands and results:

- Node: `safeNext('/\\evil.test/phish')` returned the path unchanged; `new URL(path, 'https://echo.example/...').origin` was `https://evil.test`.
- Chromium (Playwright, local, requests intercepted): setting `window.location.href = '/\\evil.test/phish'` produced a request to `http://evil.test/phish`.
- `grep customerAuthenticate`: ten route modules. `grep audit` in `customer-auth/`: no matches.
  No live system, customer record or credential was accessed.
