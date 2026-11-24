# CUSTOMER-AUTH-UX-02 R5 — Owner-Approved A–H Acceptance Contract

**Contract status: OWNER APPROVED under CUSTOMER-AUTH-FINAL-CLOSURE D01 on 2026-11-24.**
**Product acceptance status: INCOMPLETE until each mandatory scenario has executed and passed.**

The Owner approved these A–H domains as the canonical final development-acceptance framework. This approval does not make unexecuted cases pass, invent new activity gates, or replace existing product/security requirements.

## Approved domains and current test mapping

## Traceability matrix

| Scenario | Proposed scope                                                                                                         | Authoritative source                                                     | Browser coverage in this branch                                                                                                                                         | Status                                       |
| -------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| A        | Name/email/password registration, confirmation, sealed pending setup, generic response and duplicate handling | `CUSTOMER_AUTH_UX_02.md`; email-auth API and signup UX | Registration form, proof activation/replay and duplicate/unknown response cases have Chromium evidence; invalid/expired proof coverage is partial. | APPROVED CONTRACT / PARTIAL TEST EVIDENCE |
| B        | Email ownership, expiry, single use, invalid proof and activation | `CUSTOMER_AUTH_S5_01_EMAIL_AUTH_API.md`; registration challenge contract | Test mailbox and one-use completion/replay are covered. Expiry is covered at API/integration level; browser expiry remains outstanding. | APPROVED CONTRACT / PARTIAL TEST EVIDENCE |
| C        | Password login, wrong credentials, protected route and anti-enumeration | `CUSTOMER_AUTH_S5_01_EMAIL_AUTH_API.md`; login routes | Generic wrong-password/unknown-account responses, successful login and safe destination handling are covered. Full approved-route matrix remains outstanding. | APPROVED CONTRACT / PARTIAL TEST EVIDENCE |
| D        | Secure cookies, refresh rotation, logout, revocation, expiration and replay | `CUSTOMER_AUTH_UX_02.md`; session lifecycle contract | HttpOnly/Secure/SameSite cookies, refresh rotation, logout and replay denial are covered; complete expiry/idle/absolute timeout matrix remains outstanding. | APPROVED CONTRACT / PARTIAL TEST EVIDENCE |
| E        | Recovery request, factors, reset, session invalidation, cancellation, codes, holds and anti-enumeration | CUSTOMER-AUTH-S4 recovery requirements | PG16/18 Chromium covers synthetic recovery factors/reset/session revocation. Recovery-code cancellation replay and all hold paths still need acceptance. | APPROVED CONTRACT / PARTIAL TEST EVIDENCE |
| F        | Signed/expiring QR, tenant/membership boundary, consent and no unauthorized enrollment | Customer QR/enrollment architecture and membership consent | Deep-link destination continuity is covered. Actual signed QR validation, purchase/session checks, consent and membership remain unverified. | APPROVED CONTRACT / PARTIAL TEST EVIDENCE |
| G        | Rate limits, cross-customer/tenant denial, forged proof, trusted attribution and leakage | `CUSTOMER_AUTH_01D5_RATE_LIMITS.md`; auth/session/tenant requirements | Rate-limit and proof denial slices pass; actual customer resource isolation and the final exact-budget matrix remain to be executed. | APPROVED CONTRACT / PARTIAL TEST EVIDENCE |
| H        | Registration, login, verification, recovery and Settings; mobile/desktop, languages, keyboard and focus | Echo Grid UI, localization and accessibility requirements | Mobile/desktop registration and en/fr/es/ar login with Arabic RTL are covered. Full route matrix, Settings/phone flows, keyboard and assistive technology remain unverified. | APPROVED CONTRACT / PARTIAL TEST EVIDENCE |

## Runner boundaries

`customer-auth-r5-browser-fixture.ts` is a Node-only isolated API composition. It mounts customer email-auth, rotating sessions and synthetic recovery against a disposable database, injects memory-only email and fake OTP adapters, and accepts only signed Web-Worker attribution. Its rate limiter is a process-local test adapter; it does not certify production Durable Object behavior. The fixture refuses to start unless CI is true, an explicit test-only switch is set, all database connections point to loopback, and the database name is exactly `echogrid_customer_auth_r5_test`.

The fixture does not mount legacy OTP upgrade, customer profile/phone routes, business QR enrollment, Community or membership mutation routes. It cannot certify those behaviors. Its mailbox and test-helper endpoints require per-run synthetic credentials. Chromium traces and screenshots are disabled to prevent credentials, cookies, proof URLs or tokens from being captured in workflow artifacts.

The dedicated GitHub Actions workflow runs the same provisional Chromium cases against disposable PostgreSQL 16 and 18. The generated per-run credentials are synthetic, short-lived workflow environment values. The workflow has no Cloudflare, Neon, Resend, Twilio or production credentials and performs no shared deployment or migration.

## Acceptance disposition

- D01 approval makes A–H the canonical development-acceptance framework.
- A test is evidence only for the scenario it actually executes; unrun cases remain NOT VERIFIED.
- D02–D06 are recorded in `CUSTOMER_AUTH_FINAL_CLOSURE_DECISIONS_2026_11_24.md`.
- Development acceptance remains blocked until the mandatory customer journeys and security cases execute successfully.
