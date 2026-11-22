# CUSTOMER-AUTH-UX-02-R3 — Isolated QR continuity acceptance

**Status: test foundation only. NOT customer-auth A–H acceptance and NOT deployment-ready.**

This block adds four opt-in Playwright checks: after a customer logs in using email/password with a `next` destination of `/loyalty/dashboard/qr`, the authenticated browser returns to the requested QR screen instead of losing the destination; a foreign-origin `next` parameter is rejected before credential submission; and unknown-email versus incorrect-password logins produce the same generic denial without issuing customer-session cookies; and protocol-relative/encoded backslash return-target smuggling is denied.

## Activation and isolation

- Opt in via `E2E_CUSTOMER_AUTH_ISOLATED=1`.
- Provide `E2E_CUSTOMER_EMAIL` ending `@example.test` and its synthetic `E2E_CUSTOMER_PASSWORD`.
- Playwright `baseURL` **must** use `localhost` or `127.0.0.1`; the test skips other hosts.
- The isolated Web/API Workers, disposable PostgreSQL schema, feature flag and synthetic credentials must be provisioned by an authorized test operator. This PR provisions none of them.
- No staging or production tests, deployments, secrets, migrations, feature-flag changes or real identities are authorized.
- Skipped tests are not passed acceptance.

## Scope boundary

This test only checks email/password return-login navigation and secure session cookie properties. It is **not** full QR-token/business enrollment continuity, tenant isolation, consent, membership, phone verification, legacy upgrade or cross-customer denial.

The following acceptance remains **NOT RUN** until an isolated stack and synthetic proof facilities are available: full registration and proof delivery; replay denial in a browser; session lifecycle; business-bound QR continuation; Settings phone verification; existing phone identity upgrade; cross-customer authorization denial.

R2 inactive retention cleanup is separately tracked in draft PR #554. Its CI pass does not approve retention policy or an execution schedule.

## Release gates

Require completed and recorded customer-auth A–H Chromium evidence, agreed retention and rate-limit policies, migration/provider readiness, environment reconciliation, security review and owner authorization. No merge, deployment or activation is authorized here.

## Additional discovered acceptance gap — direct authenticated-page entry

The existing customer dashboard layout redirects an unauthenticated direct request for `/loyalty/dashboard/qr` to `/loyalty/login` without carrying an explicit `next` destination. The new tests exercise **login URL supplied with a safe next target**, not an unauthenticated direct QR page entry. Therefore do not claim the latter preserves context. A separate product/redirect contract decision, implementation and regression test are needed before accepting direct-deep-link preservation. This PR does not change the layout or related auth middleware.
