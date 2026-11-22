# CUSTOMER-AUTH-UX-02-R3 — Isolated QR continuity acceptance

**Status: test foundation only. NOT customer-auth A–H acceptance and NOT deployment-ready.**

This block adds six opt-in Playwright checks: after a customer logs in using email/password with a `next` destination of `/loyalty/dashboard/qr`, the authenticated browser returns to the requested QR screen instead of losing the destination; a foreign-origin `next` parameter is rejected before credential submission; and unknown-email versus incorrect-password logins produce the same generic denial without issuing customer-session cookies; and protocol-relative/encoded backslash return-target smuggling is denied; signed-out direct QR entry retains its destination on login; and staff cookies do not bypass customer login.

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

The middleware now performs a narrowly scoped customer-cookie-presence preflight for direct `/loyalty/dashboard` entries. When there is no customer legacy, rotating-access or rotating-refresh cookie, the same-origin dashboard path and query are carried as a safe `next` parameter to `/loyalty/login`. This preflight does **not** assert authenticated identity; the dashboard layout still verifies customer-session presence, and its rejection of a stale or invalid existing cookie may still lose the original path. An explicitly isolated browser test covers the no-cookie case, not invalid-cookie recovery. No staff route or authorization policy was altered.
