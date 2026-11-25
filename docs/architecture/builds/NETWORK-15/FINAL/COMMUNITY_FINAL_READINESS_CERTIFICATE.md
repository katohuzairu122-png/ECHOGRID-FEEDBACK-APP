# ECHO GRID — COMMUNITY FINAL READINESS CERTIFICATE

Prepared 2026-11-25 for the Owner. **This certificate grants no approval.** It does not migrate, deploy, publish, activate or issue anything.
Supporting records (same folder): [G2 staging migration authorization record](G2_STAGING_MIGRATION_AUTHORIZATION_RECORD.md) · [G3/G4 legal and localization matrix](G3_G4_LEGAL_AND_LOCALIZATION_APPROVAL_MATRIX.md) · [G5–G8 containment, operations, release and activation decision](G5_G6_G7_G8_CONTAINMENT_OPERATIONS_RELEASE_ACTIVATION.md). Historical packages: [AR01](../AR01/ACTIVATION_READINESS.md), [AR02](../AR02/READINESS_AND_OWNER_DECISIONS.md), [CONTROL-01](../CONTROL-01/IMPLEMENTATION.md).

## 1. Current `main` SHA
`1ef2145ffbd46254e8bacacf9634b1c57e477a79` (merge of #576, CUST-DEL-01). Journal 0000–0089 (90 entries).

## 2. Development PR and final head SHA
Consolidated draft PR **#578** (`docs/community-final-readiness`). All evidence below was produced on head `26c02472222a73c76493580e4c912cc287993b9f` (the code under test); the final head differs from it only by this certificate's evidence update (documentation, no code). Contents: three decision/approval records, this certificate, and one disposable workflow `community-pg18-acceptance.yml`. **No application code changed**: no defect was demonstrated (section 4).

## 3. Verified completed functionality (inspected on `main`)
- Explicit, independent Community membership: Join, Rejoin and fresh-consent Restore are separate, state-derived operations (#562); Restore always needs fresh customer consent; platform clearance is inactive and never customer consent.
- Containment: four independent fail-closed controls (#566); opaque operation-bound permits on every membership write; only two services write memberships.
- Consent: immutable evidence, publication id/version/hash binding, idempotency (customer-scoped request key), customer/account locks, stale-publication denial.
- Community Points: separate ledger accounting (awards, reversals, admin adjustment, rules), unaffected by membership containment.
- Feed: gated by `NETWORK_FEED_ENABLED` only for Feed/moderation routes; the enrollment path never reads it.
- Loyalty membership is separate: no code path enrolls a customer in Community when they join a business loyalty program.
- Interfaces: Community hub, membership controls and Feed in four languages with Arabic RTL.

## 4. Remaining technical defects
**None demonstrated.** Observations that are not product defects:
1. Test isolation: the Community Points integration suites use fixed rule version numbers and fail if re-run on a database that already ran them (seen locally; every hosted job uses a fresh database). Not changed.
2. Verification gap closed by this PR: before it, the Community integration suites ran on PostgreSQL 16 only (see section 12).
3. The pending migration range is **0088 and 0089** (AR02 assumed 0088 alone); see G2.
4. Production and staging both lack 0088/0089 (section 6); the deployed API fails closed (503 `COMMUNITY_TERMS_UNAVAILABLE`) when the terms table is absent.

## 5. G1–G8 matrix
| Gate | Result | Basis |
|---|---|---|
| G1 Implementation verified | **PASS** | Merged code inspected; unit, integration and browser suites pass; no defect found. Verified on PG16 and hosted PG18.7 (section 12) |
| G2 Migration approved and target verified | **BLOCKED** | Engineering preparation complete (exact range 0088+0089, manifest, risk, post-checks). Owner authorization and execution outstanding |
| G3 Legal documents approved | **BLOCKED** | Drafts exist; no qualified approval, version or effective date |
| G4 Legal translations approved | **BLOCKED** | Technical localization PASS (section 11); legal equivalence unreviewed |
| G5 Runtime security and containment | **BLOCKED** | Code and tests PASS; **live flag state NOT VERIFIED** (tooling returns no variables); live adversarial check needs the deployed build with 0088 |
| G6 Operations approved | **BLOCKED** | Procedures drafted; no operators, thresholds or retention approved |
| G7 Protected deployment authorized | **BLOCKED** | Workflow controls verified in source; environment reviewer settings NOT VERIFIED; authority not given |
| G8 Separate activation authorization | **BLOCKED** | Not requested; decision record is blank |

## 6. Migration 0088 readiness
Read-only observation 2026-11-25: staging and production each have ledger 88 (through 0087), no 0088/0089 objects, `community_memberships` 0 rows, `consent_grants` 3 (staging) / 0 (production). 0088 is additive and non-destructive (two empty tables, two CHECK swaps, guards, one partial unique index; no backfill or delete). Lock/validation risk is negligible at these sizes. **Pending range is 0088 then 0089**; approving 0088 alone is not possible with the normal runner. Manifest hashes and the approval block: G2 record. Not executed anywhere shared.

## 7. CONTROL-01 containment
Implemented (#566), not merely specified: join, rejoin, restore and clearance each have their own server flag, enabled only by the exact string `"true"`; disabled answers 503 `COMMUNITY_MEMBERSHIP_OPERATION_DISABLED`; repository permits prevent bypass; Feed flag is independent. Tests: 6 PG integration tests in `community-membership-controls.integration.test.ts`, unit suite `community-membership-controls.test.ts`, and the four-language browser test. Residual limits (raw SQL, old app versions, owner-role runtime) are listed in G5.

## 8. Community consent acceptance
`community-consent-runtime.integration.test.ts` (21 tests) and the browser journeys cover explicit acceptance, fresh Restore consent, publication/version/hash binding, expiry, replay (idempotency) and revocation (Leave) on real PostgreSQL. All passed in the 2026-11-25 clean-database run. Legal text is **unapproved**.

## 9. Community Points integrity
Ten `community-point-*` integration suites (awards, reversals, adjustments, rules, ledger platform, customer reads) passed on the clean database; conservation and idempotency are asserted there. No Community Points were issued on any shared database (production: 0 rules, 0 members).

## 10. Feed authorization and moderation
`community-feed.routes.test.ts`, `community-feed-contract.test.ts`, the `network-*` integration suites and the browser journeys (missing/expired/non-customer credentials, phone re-verification, flag fail-closed, moderation withdraw/suspend/pin, pagination) all passed.

## 11. Four-language acceptance
Technical: **PASS**. 116 Community keys identical across en/fr/es/ar; `dir="rtl"` for Arabic; real Chromium Join/Rejoin/Restore containment journey in all four locales at 375 px and 1280 px passed; i18n unit suites 6 files/99 tests; web Community unit suites 4 files/41 tests. Legal equivalence: **unreviewed** (G4 matrix).

## 12. PostgreSQL 16 / 18 evidence
- **PG16 (local, 2026-11-25):** fresh database 0000–0089; Community+Network integration 181 passed / 20 skipped (the 20 are the browser journeys, run separately below); full API integration 1710 passed / 41 skipped (earlier on the CUST-DEL-01 head); runtime-role security integration 16 passed.
- **PG16 (hosted):** `ci-cd.yml` uses `postgres:16`.
- **PG18 migration chain (hosted):** `gate2-pg18-*` jobs replay the full journal on `postgres:18` at each PR head (includes 0088/0089).
- **PG18.7 Community integration + browser (new workflow, hosted):** `community-pg18-acceptance.yml`, run `45560710158` on head `26c0247`, container `PostgreSQL 18.7`: Community+Network integration **17 files, 181 passed, 20 skipped (the browser journeys), 0 failed**; real-Chromium journeys **20 passed, 0 failed** (30 non-browser tests filtered out). Before this PR no PG18 integration job existed; the gap is closed.
- **Unit (local, readiness branch):** API 270 files / 4316 tests passed; web 166 files / 1337 tests passed.
Skipped tests are never counted as passes.

## 13. Chromium evidence
Local, real Chromium via the repo's own journeys: `network-draft-publication.integration.test.ts -t "browser"` → **20 passed**, 0 failed (30 non-browser tests filtered out, not counted). Substitution: the sandbox's installed Chromium build is 1243 while the repo's Playwright expects 1228; a scratch-directory shim pointed at the installed build, repository untouched. Hosted (GitHub Actions, PostgreSQL 18.7): the same 20 journeys passed (run `45560710158`), using the repo's pinned Playwright browser, so the local build substitution does not affect the hosted result.

## 14. Hosted CI results (exact head)
Head `26c02472222a73c76493580e4c912cc287993b9f`: **26 of 26 checks succeeded** (0 failed, 0 pending, 0 cancelled) at the time of reading, including the new PG18 workflow (run `45560710158`, job `lifecycle`: migrate, seed, 181 integration tests, web build, 20 Chromium journeys — all steps success) and the `gate2-pg18-*` jobs that replay the full 0000–0089 journal on PostgreSQL 18. A manual `workflow_dispatch` re-run of the PG18 workflow (`45562683301`) was also started on the same head; it is redundant and not relied on. The later commit that records this evidence changes documentation only.

## 15. Legal approvals outstanding
L1–L7 and the four-language artifacts (G3/G4 matrix): all outstanding; no reviewer named.

## 16. Operator approvals outstanding
O-1 to O-7 (G5–G8 record): owner/release operator, legal and language reviewers, support owner, incident lead, alert thresholds, retention, RPO/RTO, pilot scope. None named or assumed.

## 17. Deployment prerequisites
G2 executed and verified on staging, then production (separate records, fresh restore points); staging app is still an old build; GitHub protected-environment settings confirmed by the Owner; runtime-role cutover is separate and not required for Community but changes the containment boundary.

## 18. Activation prerequisites
Every G8 line (legal, translations, migration, operators, flags, monitoring, recovery, scope); then a distinct explicit instruction. Rollback = unset/`false` the flags; consent evidence and memberships are retained.

## 19. Definitive development verdict
**DEVELOPMENT COMPLETE — OWNER APPROVALS PENDING.** All mandatory technical functionality is implemented and verified on PostgreSQL 16 and 18.7 and in real Chromium; no defect was demonstrated; the one verification gap found (no PG18 integration job) was closed by this PR. Legal, operational, migration and release decisions remain with the Owner. This is not a production-readiness statement.

## 20. Definitive production-readiness verdict
**NOT PRODUCTION-READY, and not certifiable from CI.** G2–G8 are open: no migration executed, no legal text approved, no operator named, live flag state unread, no activation authorized. Community stays disabled.
