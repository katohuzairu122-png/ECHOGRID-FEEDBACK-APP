# CUSTOMER-AUTH-R6 — Consolidated final-acceptance reconciliation

**Status: DEVELOPMENT IN PROGRESS — NOT FULLY ACCEPTED; NOT DEPLOYMENT AUTHORITY.**

Baseline: `main` at `9609de466fba081ee9da371e50da6aef4436d9ea` (merged PR #564). The R5 browser contract remains **PROPOSED — OWNER APPROVAL REQUIRED**. Existing production email-auth enablement does not itself approve recovery, legacy upgrade, retention or numerical rate-limit policies.

## Evidence and gap matrix

| Domain | Verified earlier | R6 gap / disposition |
| --- | --- | --- |
| A Registration | R5 isolated Chromium registration and generic acknowledgment | Full approved contract still pending |
| B Email proof | R5 one-time proof, replay and forged proof rejection, fragment scrubbing | Browser expiry and historical compatibility not fully accepted |
| C Password login | R5 successful login, generic wrong-password/unknown-account denial | Complete abuse-budget approval still pending |
| D Sessions | R5 HttpOnly/Secure/SameSite, refresh rotation and logout revocation | Additional concurrent session and recovery revocation browser evidence required |
| E Recovery | Existing gated, purpose-bound S4-03 API and disposable PostgreSQL route integration | Customer-facing browser recovery, synthetic factor delivery, end-to-end session invalidation and operational gate remain unverified |
| F QR/business membership | R5 safe return destination and forged external redirect denial | Signed business enrollment, tenant/member access, consent and no unauthorized activation not covered by R5 fixture |
| G Security | R5 generic responses, delivery limiter, trusted source and proof replay | Full cross-customer/tenant resource authorization, all policy budgets and abuse boundaries remain unverified |
| H UX/accessibility | R5 mobile/desktop registration and en/fr/es/ar login with Arabic RTL | Recovery UI, keyboard, assistive technology and complete route/language matrix remain unverified |

This matrix records **test scope**, not owner approval or production readiness. R5's isolated fixture intentionally does not mount recovery, legacy OTP upgrade, SMS, profile, membership or business routes. A passing 10-test browser suite per PostgreSQL major cannot certify those missing paths.

## R6 first implementation: recovery route boundary

`apps/api/src/customer-auth/customer-recovery.routes.r6.test.ts` adds database-free regressions for:
- default-disabled recovery endpoints returning generic 404 without touching dependencies;
- untrusted callers failing closed before opening dependencies;
- caller-controlled phone/proof fields and invalid email rejected before database access;
- generic 202 initiation and no session cookies for known and unknown email selectors.

These are **not** browser recovery acceptance, proof-factor verification or production activation tests. Existing real-PostgreSQL recovery integration tests remain the authoritative deeper security evidence for the route.

## Required continuation without premature activation

1. Reconcile S4 recovery requirements and determine whether a customer-facing recovery experience has already been approved. If not, prepare an explicit UX/authority decision; do not silently invent a recovery flow.
2. Extend the existing isolated GitHub Actions R5 test setup for any approved recovery API/browser scenario, preserving disposable PostgreSQL 16/18 and synthetic, memory-only delivery. Never mount live providers or use real identities.
3. Inspect the independently authorized customer/business membership entry points before simulating F; no Community activation or changes to loyalty ledgers.
4. Complete cross-customer and cross-tenant denial assertions on actual protected resources, not generic mock identities alone.
5. Preserve disabled `CUSTOMER_RECOVERY_ENABLED` and `CUSTOMER_LEGACY_UPGRADE_ENABLED` in shared environments; inspect but never modify shared flags in this development block.
6. Maintain separate approval decisions for A–H acceptance, rate-limit budgets, retention policy, provider/delivery readiness and release.
7. Run exact-head CI and PostgreSQL 16/18/Chromium tests. Skips and unexecuted cases are not passes.

**Release state:** No shared migration, deployment, feature activation, live email delivery, customer identity modification, merge or automatic transition is authorized by this R6 work.
