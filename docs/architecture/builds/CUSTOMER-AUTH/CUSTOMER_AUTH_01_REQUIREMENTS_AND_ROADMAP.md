# ECHO GRID — CUSTOMER-AUTH-01

## Universal Customer Registration, Authentication and Loyalty Enrollment

**Status: PROPOSED — OWNER REQUIREMENTS DEFINED, ARCHITECTURE NOT LOCKED. DOCUMENTATION ONLY.**
Financial activation: NO-GO. Implementation, migration, credential conversion, activation and deployment: **NOT AUTHORIZED**.

- Owner: INFINICUS LLC. Repository: `katohuzairu122-png/ECHOGRID-FEEDBACK-APP`.
- Baseline: `41f9a6f6106d2c99383d97e1ac24ae82bddbe71d` (verified as the head of `main` when this was written).
- Part A is the owner's requirement text as submitted on 2026-11-12. Parts B to E were added by Claude: verified current state, work breakdown, dependencies and initial views. Claude's additions are recommendations, not decisions.

---

## PART A — Owner requirements (as submitted)

### 1. Purpose

Enable customers to join and use Echo Grid as an independent loyalty platform, without needing a physical business QR for registration or repeated Twilio verification during routine visits.

Preserve the existing global customer identity, independent business loyalty memberships, consent boundaries, verified QR workflows and financial restrictions.

### 2. Owner-approved product direction

**A. Registration and authentication**

1. A customer creates one global Echo Grid account.
2. The customer verifies their phone through Twilio during initial registration.
3. The customer establishes a secure password.
4. Subsequent routine logins use the password without SMS verification.
5. Valid sessions allow continued access without repeated login.
6. Scanning a business QR does not trigger another OTP for an authenticated customer.
7. Password recovery uses verified recovery methods, including SMS OTP.
8. High-risk security events may require additional verification.
9. Logging out, closing the application or changing devices does not delete customer registration.

**B. Public customer registration**

Customers may join Echo Grid directly through the public website, advertising links, shared registration links, or direct navigation to the customer registration page. A business QR must not be required to establish global customer identity.

**C. Business QR registration**

A business's existing QR remains a valid customer acquisition channel. The customer may register or sign in, review the originating business and explicitly join its loyalty program. The customer initially sees a business-focused experience, with an optional path to the wider Echo Grid platform. The business-focused view must not create a separate identity or permanently restrict the customer's global account.

**D. Remote business enrollment**

After approved business discovery is available, authenticated customers may browse participating businesses and request enrollment without physically scanning their QR codes. This requires a separately approved amendment to existing BDPN decision D-18, which currently limits discovery to informational join text. Remote enrollment must not bypass business eligibility, program terms, consent or purchase-verification requirements.

### 3. Identity and ownership contract

Preserve the existing architecture:

- `customers`: one global customer identity.
- `business_customer_memberships`: independent customer-to-business relationships.
- `loyalty_accounts`: independent business loyalty accounts.
- `consent_grants`: purpose-specific consent evidence.
- Split 05 Community Points: unchanged.
- Split 06 settlements: unchanged.
- Splits 07 to 08 financial boundaries: unchanged.
- BDPN: approved and published business discovery profiles.
- NETWORK-00: Feed and Points & Membership under one Community navigation tab.

Do not create a second customer identity table or reuse staff authentication credentials.

**Registration, joining a business, following a business and receiving marketing are separate actions.**

### 4. Authentication security

The design must cover: secure password hashing using the repository-approved or independently reviewed system; account enumeration resistance; login and recovery rate limiting; secure password creation, reset and credential updates; revocable customer sessions; rotating refresh credentials or a security-reviewed equivalent; secure HttpOnly session cookies; session expiry and logout; cross-device login and session invalidation; protection against session theft and account takeover; sensitive account changes requiring appropriate verification; recovery when the original phone is unavailable; explicit separation of customer and staff trust domains.

The existing 90-day non-rotating customer JWT requires a security assessment before expanding customer account capabilities.

**A verified phone number is an authentication factor, not permanent authorization for every future sensitive action.**

### 5. Existing customer migration

Current OTP-only customers must retain their global customer identifier, loyalty memberships, points and rewards, QR eligibility, Community memberships, consent history, feedback and surveys, and relevant audit records.

An existing customer must be able to establish a password after appropriate identity verification without creating a duplicate account. Migration must be safe to repeat and must not automatically invalidate existing customers before a compatible recovery path exists.

### 6. Two distinct QR contracts

**Business QR (acquisition and engagement).** Identifies the participating business and authorized branch context. May initiate login, registration, voluntary membership enrollment, feedback or permitted check-in operations. Does not grant rewards automatically.

**Customer QR (cashier service).** Uses the existing short-lived signed customer token. The cashier verifies the token within the cashier's authorized business scope. Purchase validation and reward fulfillment require independent authorization and business rules. Phone-number lookup is not a substitute for customer authentication or verified purchase evidence. D-C2 remains separately gated.

### 7. Privacy and consent

- Creating a global account does not enroll a customer in every business.
- Business QR registration requires an explicit loyalty-join choice.
- Business membership does not authorize platform marketing.
- Discovering a business does not expose private business customer lists.
- No automatic contact sharing between businesses.
- No cross-business points pooling or transfers.
- No financial activation through onboarding.
- No compulsory promotional consent as a condition of basic customer registration.

### 8. Explicit architecture conflict: BDPN D-18 (remote joining)

Existing decision: informational join wording only; no discovery Join button. New owner requirement: allow voluntary remote loyalty enrollment. Required action: create a versioned D-18 amendment proposing a restricted remote-enrollment contract. Do not modify or silently supersede the locked decision until separately reviewed and approved. Remote enrollment remains inactive until this conflict is resolved and its eligibility and consent rules are verified.

### 9. Open architecture decisions

| ID    | Question                                                                            |
| ----- | ----------------------------------------------------------------------------------- |
| CA-01 | Password-hashing implementation and compatibility with current infrastructure       |
| CA-02 | Customer session lifetime, refresh rotation and revocation                          |
| CA-03 | OTP-only customer migration and credential enrollment                               |
| CA-04 | Password recovery when the registered phone is unavailable                          |
| CA-05 | Initial public registration route and customer account profile requirements         |
| CA-06 | Remote enrollment eligibility, including business plan and publication requirements |
| CA-07 | Whether remote enrollment is limited to selected business loyalty programs          |
| CA-08 | Consent language, notice and versioning for both entry paths                        |
| CA-09 | Existing-session migration and progressive rollout                                  |
| CA-10 | Required live-device and operational security certification                         |

Do not invent answers to unresolved security, economic or regulatory questions.

### 10. Acceptance conditions

The implementation must eventually prove:

1. A customer can register without scanning a business QR.
2. Initial registration requires verified phone ownership.
3. Returning customers can log in with a password.
4. A customer can scan multiple business QRs without repeated OTP while authenticated.
5. A customer can securely recover account access.
6. An existing OTP-only account can establish a password without duplication.
7. Customer identity and loyalty memberships persist after logout.
8. A business QR enrolls only in the selected business after explicit approval.
9. Remote enrollment cannot occur without the approved eligibility and consent contract.
10. Customer QR verification cannot expose unrelated business data.
11. Cashier service requires appropriate permissions and actual transaction authorization.
12. No action creates unauthorized points, credits, settlements or marketing consent.

### 11. Release restrictions

Every implementation block requires its own development authorization, verification and owner completion report. No production migration, live credential conversion, feature activation, automatic merge, deployment or financial operation is authorized by this document.

**Decision objective:** One durable Echo Grid customer account, two enrollment channels, normal password login and no unnecessary Twilio OTP during routine loyalty interactions.

---

## PART B — Verified current state (Claude, at baseline `41f9a6f`)

Each item was checked in the source at this baseline.

| Area                 | Verified fact                                                                                                                                                                                                                                                                                                      | Evidence                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Identity             | `customers` holds one row per phone number across the platform (`phone` is unique, E.164). It has **no password column**.                                                                                                                                                                                          | `apps/api/src/db/schema/customers.ts`                   |
| Customer auth routes | Only two: `POST /otp/request` and `POST /otp/verify`, each limited by the OTP limiter keyed on the phone number. No password, recovery or session-management route exists.                                                                                                                                         | `apps/api/src/customer-auth/customer-auth.routes.ts`    |
| SMS provider         | Twilio Verify through `twilio-verify.service.ts`. A required Verify service secret is reported missing in a local run, so any test of the real flow needs your credential decision; no real SMS credentials are used in development.                                                                               | `customer-auth/`, local worker startup warning          |
| Session              | A single HS256 token, `type: customer_access`, **90 days, non-rotating**, signed with a separate `CUSTOMER_JWT_SECRET`. The source documents this as a deliberate simplification.                                                                                                                                  | `customer-auth/customer-jwt.ts`                         |
| Session checks       | The middleware verifies the token and that the customer row exists and is `active`. There is no per-session record, no device list and no "log out everywhere", so a single token cannot be revoked on its own.                                                                                                    | `middleware/customer-authenticate.ts`                   |
| Cookie               | The web app keeps the token in the `ff_customer_token` cookie; the wallet and dashboard gate on its presence.                                                                                                                                                                                                      | `apps/web/src/lib/customer-session.ts`                  |
| Staff passwords      | PBKDF2-HMAC-SHA256 at 600,000 iterations, run in a worker (a single Workers call is capped at 100,000 iterations, so the work is chained). The hash is self-describing, so a later move to Argon2id is possible without a mass reset. This is staff authentication and must not be reused as customer credentials. | `auth/password.ts`, `auth/pbkdf2-worker.ts`             |
| Customer QR          | Short-lived signed token verified by the cashier flow inside the cashier's business scope; unchanged by this proposal.                                                                                                                                                                                             | `qr/customer-qr-token.ts`, `loyalty-action-resolver.ts` |
| Business join today  | Join happens through a business QR token and records an explicit join consent; there is no remote join.                                                                                                                                                                                                            | `customer-relationships/customer-membership.service.ts` |
| Rate limiting        | Customer routes sit behind the 20-per-60-second limiter. Whether the web worker's calls share one bucket in production is unverified (open item O-E1).                                                                                                                                                             | `loyalty-customer.routes.ts`, `index.ts`                |

What is **not** true today, so the requirement is not already met: no password exists, a returning customer must complete SMS verification when the 90-day session is gone, and sessions cannot be revoked individually.

---

## PART C — Work breakdown and gates (Claude proposal)

Nothing below is authorized. Each block needs its own authorization, tests, exact-head CI and owner completion report.

| Block | Content                                                                                                                                                                    | Type               | Depends on                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------- |
| G0    | Owner answers to CA-01 to CA-10                                                                                                                                            | Decision           | None                                                                |
| 01A   | Customer auth architecture and **security assessment of the current 90-day session**: threat model, session and refresh model, recovery, enumeration and rate-limit design | Design only        | G0 (partial answers suffice to start)                               |
| 01B   | Data contract: credential storage, session records, audit events; migration list; Gate 2 impact                                                                            | Design only        | 01A                                                                 |
| 01C   | Existing-customer migration plan: password creation after OTP, no duplicates, safe to repeat, no forced invalidation                                                       | Design only        | 01A, 01B                                                            |
| 01D   | API: registration, password login, recovery, session revocation, rate limits                                                                                               | Code and migration | 01A to 01C approved; release backlog settled (`0067`, D-C1 rollout) |
| 01E   | Web: public registration page, login, recovery, device and session list                                                                                                    | Code               | 01D                                                                 |
| 01F   | Business-QR path: sign in or register, review the business, explicit join choice, no OTP for a signed-in customer                                                          | Code               | 01D, 01E                                                            |
| 01G   | Remote enrollment from discovery                                                                                                                                           | Code               | BDPN-01 live, **D-18 amendment approved**, CA-06 and CA-07 decided  |
| 01H   | Certification: real-device tests, live security review, progressive rollout                                                                                                | Verification       | All code blocks                                                     |

Recommended order: G0, 01A, 01B and 01C (documentation only) now; 01D to 01F after the coordinated release is stable, so no two schema or authorization changes land together; 01G last.

---

## PART D — Dependencies and conflicts

- **D-18 (locked BDPN decision):** remote enrollment conflicts with it. A versioned amendment is required. This document does not change D-18.
- **Migration chain:** credentials and revocable sessions need new storage, so a migration and a Gate 2 re-pin will be required. `0067` is still pending in production and staging (read-only check, 2026-11-12), so the order matters.
- **D-C1 rollout:** independent workstream; it must not be blocked or reordered by this one.
- **Twilio:** outbound SMS costs money and uses a real external service. Testing needs an explicit credential and budget decision.
- **Community and NETWORK-00:** unchanged; customer navigation stays one Community tab.
- **Not relaxed:** the customer QR for cashier service, D-C2 (name or phone lookup), and all financial restrictions.

---

## PART E — Initial views on CA-01 to CA-10 (not decisions)

| ID    | Claude's initial view                                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| CA-01 | Reuse the existing PBKDF2 implementation for compatibility; design a path to Argon2id later. Separate customer credential storage |
| CA-02 | Short-lived access plus rotating refresh with a server-side session record and revocation, replacing the single 90-day token      |
| CA-03 | After OTP verification, offer to create a password; same customer row, no duplicate; old sessions honoured until expiry           |
| CA-04 | Owner decision needed. Options: a verified email, or support-assisted recovery with strict checks and audit                       |
| CA-05 | Minimal profile: verified phone and password; name optional                                                                       |
| CA-06 | A live published BDPN profile plus a plan rule (depends on D-24)                                                                  |
| CA-07 | Business opt-in for remote enrollment                                                                                             |
| CA-08 | Separate, versioned notices for the public and business-QR paths; no promotional consent required                                 |
| CA-09 | Progressive rollout with a kill switch; existing sessions remain valid until their expiry                                         |
| CA-10 | Required before activation: real devices, a security review, abuse and rate-limit testing                                         |
