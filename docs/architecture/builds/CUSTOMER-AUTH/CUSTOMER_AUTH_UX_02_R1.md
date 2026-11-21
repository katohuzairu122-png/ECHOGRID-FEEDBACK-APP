# CUSTOMER-AUTH-UX-02-R1 — Legacy identity-upgrade error and race hardening

Date: 2026-11-21. Development-only follow-up to merged PR #550. No shared-environment changes are authorized.

## Baseline and scope

- Repository: `katohuzairu122-png/ECHOGRID-FEEDBACK-APP`.
- Main at R1 branch creation: `f2f9212d502607ee24af203dcb2fcf865a55b8ad` (merge commit for PR #550).
- R1 branch: `fix/customer-auth-ux-02-r1-identity-hardening`.
- The checkout used for this work had unrelated local edits on the old PR #550 branch. Those files were preserved; R1 uses an isolated worktree based on current `main`.
- Scope is limited to legacy phone-to-rotating-session identity resolution, its PostgreSQL regressions and this record. No schema change is planned.

## Root cause

`CustomerRepository.resolveExistingPhoneForCredentialUpgrade()` first found a verified owner or a sole eligible legacy phone-only row. For the latter it conditionally verified the same row and released unverified claims. A broad catch around both writes returned `undefined` for every exception. This was fail-closed for identity creation but also translated connection, timeout, permission, schema and cleanup failures into an ordinary invalid-identity result, hiding operational errors.

## R1 correction

The verified-phone claim update remains bound to the selected customer ID, exact phone, unverified state and non-deleted status. PostgreSQL error classification now catches only SQLSTATE `23505` for the existing `customers_phone_verified_unique` index and returns the established generic denial. The conditional update returning no row remains a safe concurrent-race denial. All other database errors are rethrown to the existing global error boundary, which logs server-side details and returns a sanitized generic 500. Unverified-claim cleanup is outside the uniqueness catch so cleanup errors are not reclassified as identity absence.

No fallback to `createIfAbsent()` is introduced in the upgrade resolver. Ordinary legacy OTP sign-in remains unchanged. No account merge, customer-ID change, session issuance or ownership transfer is introduced by the repository operation.

## Concurrency model

- The partial unique index `customers_phone_verified_unique` remains the database arbitration point for verified ownership.
- Upgrade writes are conditional on the same original row still holding the phone unverified and active.
- If another allowed phone-login path wins first, the upgrade can resolve the same verified owner or safely deny when its legacy-row predicate no longer matches. It cannot create or select another identity through the upgrade-only path.
- Regression tests use separate PostgreSQL clients to race two upgrades and an upgrade against ordinary phone login. They assert only the original ID can resolve and that one phone does not produce duplicate identity rows.

## Regression evidence

- Exact R1 branch head: `db9340bc0c562a4b6c00ae522dea5d0237b74209`.
- Focused API auth, route and PostgreSQL error-classifier tests: 40 passed.
- Full API unit suite: 263 files and 4,152 tests passed.
- API typecheck (application and test TypeScript projects): passed.
- ESLint on all changed TypeScript files: passed.
- Customer email-auth real-PostgreSQL integration file: 23 tests passed on PostgreSQL 16 and 23 passed on PostgreSQL 18. This includes unknown-phone no-create, same-ID resolution, no takeover of an unverified email-customer claim, parallel upgrades, upgrade vs ordinary phone login, preservation of customer ID/membership/loyalty balance, expected unique-index denial, and propagation of injected SQLSTATE `40001`.
- Exact-head hosted CI: 25/25 workflow runs passed, including main CI/CD and PG18 disposable compatibility. Hosted API integration reported 1,605 passed and 39 skipped; the separate R1 integration file ran all 23 tests. General Block14 Chromium reported 11 passed; this is not the customer-auth A–H suite.
- Local PostgreSQL was unavailable. The R1 PostgreSQL runs above used hosted disposable CI databases; no shared database was used.

## Security invariants

- Unknown phone ownership cannot create a customer through the credential-upgrade endpoint.
- A verified phone cannot take over a different email-credential identity.
- No automatic customer merge, balance transfer, membership reassignment or historical-data migration occurs.
- Operational database failures are not hidden as invalid proof/identity results.
- Customer-facing errors remain generic; raw SQL errors are handled only by the established server error boundary.
- Existing phone proof, password hashing, rotating session, revocation, replay, rate-limit, QR, tenant and authorization controls remain in force.

## Files and out-of-scope risks

Expected R1 files are `apps/api/src/repositories/customer.repository.ts`, focused customer-auth tests, the real-PostgreSQL customer email-auth flow integration test, and this document. No migration is needed.

These earlier issues remain separate and incomplete: R2 — pending-registration retention and rate-limit policy approvals; R3 — customer-auth Chromium A–H acceptance; R4 — staging flag/configuration reconciliation. This block does not modify or approve them. No production or staging flag, secret, deployment, database, customer identity, cashier, billing, Community, reward or membership resource may be changed.

## Release status

R1 implementation and required exact-head CI are merge-ready for review. PR #551 remains a draft under the requested workflow; no merge or deployment is authorized. Customer-auth Chromium A–H and the R2/R3/R4 matters listed above remain separate blocks and are not claimed complete here.
