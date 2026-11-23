# CUSTOMER-AUTH-UX-02 R5 — Provisional Browser Acceptance Contract

**Status: PROPOSED — OWNER APPROVAL REQUIRED. Not canonical and not acceptance certification.**

This proposal records the A–H domains from the CUSTOMER-AUTH-R3-R5 development brief and maps the executable browser foundation to existing product requirements. It does not approve new product policy, declare new activity gates, or replace the existing CUSTOMER-AUTH-UX-02 requirements.

## Decision required

The Owner must approve, revise, or reject the A–H scenario mapping and its expected behavior before the R3 acceptance gate can be marked complete. The domains below are a proposal, even where individual requirements are already approved elsewhere.

## Proposed traceability matrix

| Scenario | Proposed scope                                                                                                         | Authoritative source                                                     | Browser coverage in this branch                                                                                                                                         | Status                                       |
| -------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| A        | Name/email/password registration, password confirmation, pending registration, generic response and duplicate handling | `CUSTOMER_AUTH_UX_02.md`; existing customer email-auth API and signup UX | Mobile registration fields, confirmation mismatch, request acceptance, duplicate/unknown response comparison                                                            | PROPOSED — OWNER APPROVAL REQUIRED           |
| B        | Test-only proof delivery; expiry, single-use, invalid proof and activation                                             | `CUSTOMER_AUTH_S5_01_EMAIL_AUTH_API.md`; registration challenge contract | Test mailbox captures proof; browser completes once and rejects replay. Malformed and forged invalid proofs are rejected in Chromium. Expiry browser coverage remains absent.                                               | PROPOSED — OWNER APPROVAL REQUIRED           |
| C        | Password login, wrong credentials, protected route and anti-enumeration                                                | `CUSTOMER_AUTH_S5_01_EMAIL_AUTH_API.md`; existing login routes           | Wrong-password and unknown-account login denials are compared in Chromium; verified account signs in; QR deep-link login is preserved.                                 | PROPOSED — OWNER APPROVAL REQUIRED           |
| D        | Secure cookies, refresh rotation, logout, revocation, expiration and replay                                            | `CUSTOMER_AUTH_UX_02.md`; customer session lifecycle contract            | Secure HttpOnly/SameSite cookies, refresh rotation, logout and replayed-cookie denial                                                                                   | PROPOSED — OWNER APPROVAL REQUIRED           |
| E        | Recovery request, proof, reset, session invalidation and anti-enumeration                                              | CUSTOMER-AUTH-S4 recovery requirements and route specifications          | No recovery browser fixture in this branch; existing PostgreSQL/API recovery tests remain supporting evidence only.                                                     | PROPOSED — OWNER APPROVAL REQUIRED / BLOCKED |
| F        | Signed/expiring business QR, tenant/membership boundaries, consent and no unauthorized enrollment                      | CUSTOMER-AUTH-01 QR/enrollment roadmap; existing QR architecture         | Only safe QR destination continuity and return routing are exercised. Full business enrollment, consent and cross-tenant assertions are not provided by this fixture.   | PROPOSED — OWNER APPROVAL REQUIRED / BLOCKED |
| G        | Rate limits, cross-customer/tenant denial, forged proofs, trusted attribution, leakage                                 | CUSTOMER_AUTH_01D5_RATE_LIMITS.md; auth/session/tenant requirements      | Generic proof handling, delivery throttling, secure cookies and signed Web-to-API attribution are exercised. Cross-customer and cross-tenant resource tests are absent. | PROPOSED — OWNER APPROVAL REQUIRED / PARTIAL |
| H        | Registration/login navigation, accessible form labels, mobile/desktop and language behavior                            | Existing Echo Grid UI, localization and accessibility requirements       | Mobile registration, account-setup navigation, and four-locale mobile login navigation (including Arabic RTL) are exercised. Desktop language matrix and assistive-technology audit remain absent.               | PROPOSED — OWNER APPROVAL REQUIRED / PARTIAL |

## Runner boundaries

`customer-auth-r5-browser-fixture.ts` is a Node-only isolated API composition. It mounts the existing customer email-auth and rotating session route factories against a disposable database, injects a memory-only `@example.test` email sink, and accepts only signed Web-Worker attribution. Its rate limiter is a process-local test adapter for the route interface; it does not certify the production Durable Object runtime or approve the documented budgets. The fixture refuses to start unless CI is true, an explicit test-only switch is set, all database connections point to loopback, and the database name is exactly `echogrid_customer_auth_r5_test`.

The fixture does not mount legacy OTP upgrade, SMS, recovery, customer profile, business, Community, QR enrollment or membership mutation routes. It cannot certify those behaviors. Its mailbox endpoint is mounted only in this fixture and requires a per-run random bearer token. Chromium traces and screenshots are disabled to prevent credentials, cookies, proof URLs or tokens from being captured in workflow artifacts.

The dedicated GitHub Actions workflow runs the same provisional Chromium cases against disposable PostgreSQL 16 and 18. The generated per-run credentials are synthetic, short-lived workflow environment values. The workflow has no Cloudflare, Neon, Resend, Twilio or production credentials and performs no shared deployment or migration.

## Acceptance disposition

- The proposed A–H mapping is not approved by this document.
- Passing provisional tests would verify only the rows and assertions they execute.
- R3 acceptance remains blocked until the Owner approves the canonical contract and all approved scenarios execute with evidence.
- Retention policy and numerical rate-limit approvals remain separate outstanding decisions.
