# Customer authentication — acceptance and activation reconciliation

Baseline: `b881933a56ea4897a902fea63d4f49334337d480` (main, merged PR #569).

D01 approves A–H development acceptance. D02–D06 govern request budgets, retention, cancellation, phone risk and provider boundaries. Test completion, observed configuration and release approval are separate facts.

## Current activation observations

Read-only Cloudflare inspection on 2026-11-24 queried active deployments and each deployed version, then independently queried script settings. Only an explicit allowlist of non-secret flags was returned. Account: `cf205213947e3617297373060fe4c15f`. [Raw non-secret evidence](evidence/activation-read-2026-11-24.json).

| Worker | Active version (100% traffic) | Email auth | Recovery | Legacy upgrade |
| --- | --- | --- | --- | --- |
| `echo-grid-feedback-api` | `e9b6d8b1-5b63-47a0-aa25-6f598ef0bbf9` | `true` | absent | absent |
| `echo-grid-feedback-web` | `c3601071-0062-44c2-88db-0aa3b7aa2e61` | `true` | absent | absent |
| `echo-grid-feedback-api-staging` | `d4ab22db-db16-4824-b398-b908ec99ab7e` | `true` | absent | absent |
| `echo-grid-feedback-web-staging` | `cbf27d99-3041-45f3-b1b1-18b3c8cb6d0b` | `true` | absent | absent |

Active-version flags agree with independently read script settings. Absence was checked across all binding types, including secret bindings; no secret values were retrieved. Source recovery and legacy-upgrade gates require explicit `true` in addition to email auth. No flag was changed.

All four versions were created on 2026-11-22, before the 2026-11-24 recovery/remediation merges. A repository merge does not prove deployment. Deployed Git commit, shared-database migration readiness, real provider delivery and owner release approval were not established by this read. Observed email enablement does not supply missing authorization.

Earlier assertions that shared email auth is disabled, including the D01–D06 activation paragraph and R4's final operating note, are superseded by this observation. Earlier proposed-contract and unexecuted-branch passages are superseded by D01 and PR #569's exact-head evidence. Their remaining historical content is not current activation evidence.

## Automated acceptance traceability

The Chromium workflow uses disposable PostgreSQL 16/18, synthetic email/OTP, per-run secrets and actual API services/routes. Its configuration and fixture independently refuse non-loopback or incorrectly named databases. Added cases are in `apps/web/e2e/customer-auth-acceptance-completion.spec.ts`; original cases remain in `customer-auth-r5-provisional.spec.ts`.

| Domain | Added path | Complementary evidence |
| --- | --- | --- |
| A/B | Expired proof denies activation; fresh registration; existing replay/forgery coverage | Registration/challenge PostgreSQL and unit suites |
| C | Real login, return from signed branch QR, customer/staff principal separation | Existing wrong/unknown credential and budget tests |
| D | Access refresh through BFF; idle/absolute/refresh expiry; one concurrent refresh winner; stale replay revokes only its session | Session policy and PostgreSQL suites |
| E | Real Settings code issue/revoke with password reauthentication; email+code and phone+code holds; cancellation/consumed-code replay; existing email+phone reset/session revocation | Recovery suites cover races, rollback, holds, missing factors and secrecy |
| F | Real signed QR resolution; no enrollment on scan; explicit versioned consent; idempotency; legacy printed claims; expired/forged/revoked/foreign-scope QR denials | Membership, consent and token suites |
| G | Real protected membership/account isolation; forged selectors/tenant headers; staff-principal and untrusted-source denials | Existing route isolation and budget denials |
| H | Public and authenticated auth routes in en/fr/es/ar at 360/768/1440px; labels, accessible-tree semantics, keyboard and RTL | Existing components and browser tests |

Current execution results are the [exact-head checks on PR #570](https://github.com/katohuzairu122-png/ECHOGRID-FEEDBACK-APP/pull/570/checks), with run links and totals recorded in its completion report. This mapping alone is not a claim that an unexecuted case passed. Automated semantics/keyboard checks do not claim manual screen-reader or universal WCAG certification.

The fixture previously refused recovery-code issue/revoke through stubs, while production code-management keys incorrectly used an email-only digest. The updated fixture invokes the real code service and the same shared domain-separated source/customer HMAC limiter as production composition. Approved 5-per-15-minute ceilings, current-password checks, live sessions, fresh reauthentication, one-time codes and the high-risk 24-hour hold remain enforced.

## Release and operational boundaries

- No deployment, merge, shared migration, flag change, provider message or live identity mutation occurred.
- No financial activation, Partner Credit issuance, Community enrollment, points grant or redemption follows from sign-in or scanning. Tests assert unchanged economic and Community state for scans/denials.
- D03 cleanup remains unscheduled; no cadence is invented.
- D05 recency/recycled-number signals remain unavailable; the conservative high-risk hold remains the disposition.
- Provider readiness and shared schema compatibility need separately authorized operational verification. No database or provider credentials were accessed.
- A later approved release must identify its reviewed commit, schema/provider readiness and intended flags. Green tests and historical enabled flags never authorize release.
