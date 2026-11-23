# NETWORK-15-T2-AR01 — activation-readiness audit

**UNAPPROVED — DRAFT AUDIT. Observations below are evidence, not legal, operational or activation approval.**
Date: 2026-11-23 (Kuwait). Scope: repository inspection and documentation only.

**Verdict: NOT READY — CRITICAL BLOCKERS. No activation sequence was executed.**
Companions: [proposed runbook](CONTROLLED_ACTIVATION_RUNBOOK.md) and
[unapproved owner decisions](OWNER_DECISIONS.md).

## Authoritative baseline

- Current main: `aa7c016b7a3cd4aca4769414b4f18242ea2cc7fe`.
- [Implementation PR #562](https://github.com/katohuzairu122-png/ECHOGRID-FEEDBACK-APP/pull/562): **OPEN, DRAFT, NOT MERGED**, head `f1efc9d3f8c639dbfa1493bb58e0dee0c8335779`; GitHub reports mergeable. `merged=false` and `merged_at=null`. A prospective merge-commit field is not evidence of an actual merge.
- PR #553 is merged. Its D2 assertion correction is already included on main.
- #562 differs from main in 52 files. The new consent purpose, registry/migration 0088, inactive state and final fresh-Restore implementation are **PR-head findings**, not current-main implementation claims. No #562 source was copied into this documentation branch.
- Main journal ends at 0087; the reviewed PR journal ends at 0088. Shared applied journals, deployed Worker versions, live flags, database roles and current policy pointer were **NOT VERIFIED** and were not queried.
- Source was reviewed in an isolated checkout at the exact PR head; all evidence links below are commit-pinned. No production/staging infrastructure was inspected or changed.

## G1–G8 gates

| Gate | Result | Evidence / smallest remaining action |
| --- | --- | --- |
| G1 Development verified and merged | BLOCKED | Reviewed implementation is verified; #562 is still draft/unmerged. Human review and separately authorized merge are required. |
| G2 Database reviewed and approved | BLOCKED | 0088 source and disposable PG16/18 evidence reviewed; target journal, full pending range, runtime grants, lock budget, backup and migration approval remain outstanding. |
| G3 Legal | BLOCKED | Membership draft explicitly unapproved; approved version/effective date absent. General legal pages do not approve Community consent or retention. |
| G4 Translation | BLOCKED | Four-language UI and synthetic browser flows verified; approved canonical legal text and reviewed en/fr/es/ar legal artifacts are absent from the shipped authority. |
| G5 Security invariants | PASS — reviewed implementation only | Exact-head real middleware/PG/concurrency/Chromium evidence verifies the implemented boundaries. This is not live-runtime certification or independent security sign-off; those remain release prerequisites. |
| G6 Operations | BLOCKED | Generic procedures exist, but Community containment, support/dispute, alerts, recovery objectives, named operators and evidence/retention handling are not approved or demonstrated for T2. |
| G7 Protected release | BLOCKED | Manual exact-main workflows exist; actual environment protection, credential isolation, target/schema compatibility and release authorization NOT VERIFIED. |
| G8 Activation | BLOCKED | No separate explicit Owner activation authorization. This audit, green CI, merge, policy review or deployment cannot grant it. |

## Implementation-to-requirement matrix

`VERIFIED` below means reviewed PR source and the specified isolated evidence, not live activation.

| Requirement | Classification | Evidence |
| --- | --- | --- |
| Explicit Join and strict current-version consent | VERIFIED | I1/I4; T1 tests missing/forged/stale consent and direct-service legacy denial. |
| Fresh terminated-membership Rejoin | VERIFIED | I1; T1 six-way Rejoin preserves account IDs and writes one new acceptance. |
| Every Restore requires fresh customer acceptance | VERIFIED | I2; D1-FRESH-01/02/04. Platform clearance is inactive/closed and cannot consent for the customer. |
| Atomic grant, immutable evidence and activation | VERIFIED | I1/I3; forced membership/grant/audit failures roll back in T1. |
| Duplicate/replay and Restore/Leave protection | VERIFIED | I1/I2/I3; D1-FRESH-02/04/05 and publication lock-contention regressions. |
| Historical consent evidence | VERIFIED | Append-only audit under 0085; revocable projection is distinct. New clearance/acceptance never rewrites older proof. |
| Active identity, phone, session and live-role checks | VERIFIED | I1/I6; actual HTTP negative cases and T1/T3. Verified phone never grants platform permission. |
| Business/customer isolation and separate accounting | VERIFIED | Customer context, Community-specific purpose/resource, businessId=null; bystander denial, original account/balance and loyalty non-effects in T1/T3. |
| No consent inferred from views/authentication/phone/QR | VERIFIED — boundary/source scope | I1 has the only customer activation gateway and requires literal acceptance. GET/page paths do not mutate; T3 checks page/reload non-effects. No separate real QR/login browser scenario was rerun by this audit. |
| Existing QR/business-loyalty terms | NOT APPLICABLE to new Community enrollment | No QR authorization, business-join consent or business membership is created/relaxed by T2. Existing business policy legal approval was not certified here. |
| Publication/hash/locale/effective rules | VERIFIED | I4/I5; missing, draft, future, changed, malformed or missing-locale authority fails closed. |
| Genuine approved membership policy | BLOCKED | P1 says approved version/date none; no real approved artifact is seeded by I5. |
| Localized consent controls | VERIFIED technically | I8; 12 required UI keys and three bindings checked in each of four locales; T3 covers unchecked controls and RTL. |
| Legal translation equivalence | BLOCKED | Synthetic fixtures and UI text are not reviewed legal artifacts or native-speaker/legal approval. |
| 0088 forward compatibility | PARTIALLY VERIFIED | Full disposable PG16/18 replay passed. Shared journal/current role, production-shaped lock timing and target readiness NOT VERIFIED. |
| Operational readiness and release protection | PARTIALLY VERIFIED | O1/O2 describe generic controls. Current live enforcement, Community monitoring, named ownership and approved recovery NOT VERIFIED. |
| Consent dispute/withdrawal handling | PARTIALLY VERIFIED | Atomic owned withdrawal/Leave is implemented. Investigation access, support SOP, legal retention and dispute handling need approval. |
| Customer posting/reactions/advertising/new point rules | NOT APPLICABLE | Not part of T2 and not authorized by activation. |

## Policy, language and privacy findings

P1 is an **English-only review draft**, candidate `community-membership-v1.0`, approved version **none**, effective date **none**. It discusses Join/Rejoin and platform restoration, but lacks reviewed customer fresh-Restore wording and its evidence mapping. Do not obtain consent to this draft. Do not silently amend legal text through UI labels.

The en/fr/es/ar `loyalty.json` files contain consent controls and Restore labels. Actual legal text comes from immutable registry artifacts, not those UI translations. The authority validates exact UTF-8 hashes, a canonical locale-sorted manifest, version, approval reference/time, publication/effective dates and current pointer; missing legal translations do not fall back. There is no preselected checkbox. Browser evidence uses explicitly synthetic text, not approved legal wording.

P2 supplies general `/terms` and `/privacy`; `LegalPage` displays `30 September 2026`. That display date is **not** a Community policy identifier, legal approval reference or effective registry publication. No legal approval record for the new Community evidence/Restore wording was established.

P3 explicitly leaves retention, legal basis, jurisdiction, operator/processor responsibilities and backup reapplication open. D2 has implemented anonymization/holds and a disabled retention framework; this does not implement an approved Community-consent retention schedule. The implemented retention execution category is onboarding events, not a generic consent deletion engine. Never add a duration, cascade-delete proof or bypass immutable audit to fill the gap.

Already-active legacy memberships are not backfilled with fictional consent or subjected to an invented material-change rule. Materiality, notices, reacceptance timing and nonacceptance effects need the existing separate policy decision. Community Leave/revocation does not erase the global account or business loyalty.

## Actual activation controls and limits

| Control | Actual effect / limit |
| --- | --- |
| `NETWORK_FEED_ENABLED === "true"` | Controls Network Feed and official publishing/moderation routes. Disabled/unset fails closed for those surfaces. It is not checked by Community membership Join or platform Community-point Restore. Live value NOT VERIFIED. |
| Current terms pointer + immutable approved/effective publication | On deployed T2 code, required for successful Join/Rejoin/customer Restore. Empty/missing/invalid authority disables those acceptances; no approved publication is shipped. Source seed is not a claim about a live database. |
| Platform Community Restore | Authorized moderation clearance to inactive/closed, even with no approved current terms. It does not activate membership, accept terms or release awards. |
| Customer session, phone and actual roles | Necessary but never sufficient consent. Existing feature/session routing remains unchanged. |
| Migration 0088 + runtime read rights | Required schema/SELECT privileges for the new authority. No publication writer endpoint exists; publication needs separately authorized privileged operator handling. |
| Dedicated membership rollout/kill flag | **NOT IMPLEMENTED / none found in reviewed source.** Do not invent `COMMUNITY_MEMBERSHIP_ENABLED` or assume Feed-off stops enrollment. |

The current-main legacy `/join` accepts a policy-version string. An empty new registry cannot contain that old API, because old code does not consult it. The paired production workflow deploys API then web, not atomically. Empty authority on new T2 API can hold new acceptance, but platform clearance can introduce `inactive` while an old web/API parser does not understand it. Approved, verified **route-level containment during migration/API-web handover** is therefore an activation/recovery prerequisite, not a feature flag this PR supplies. If no approved existing mechanism is available, stop and obtain a separate dispatch; AR01 implements no gate.

Clearing the current pointer on fully deployed T2 code is only acceptance containment, not a universal Community stop: it does not remove Feed rights, terminate existing memberships, halt independent points processing, delete evidence or undo committed acceptances/awards. The exclusive pointer lock serializes against in-flight acceptance transactions; post-commit award reevaluation may still finish. Any pointer change needs its own approval.

## Migration and recovery assessment

0088 adds two empty authority tables, purpose/state CHECK extensions, version uniqueness, restricted FK, immutable ALWAYS publication/pointer triggers and a customer/purpose-scoped request-digest index. It performs no balance/ledger/customer backfill or consent fabrication. Existing 0085 audit immutability and 0086 privacy semantics remain.

`db:migrate` is `drizzle-kit migrate`, targeting `DATABASE_URL`, not the Worker Hyperdrive binding, and applies the **pending journal**, not automatically just 0088. Verify the exact environment, committed prefix/hashes, entire pending range and every upstream owner's approval. If the target still has older security/privacy migrations pending, their inclusion is a separate cross-workstream dependency; this audit does not authorize them or prescribe production's present ledger.

Database guards are not a complete publication JSON/hash/localization validator; the runtime authority provides the strict validation. A malformed approved row can fail closed at runtime but remain immutable, so the operator must validate the full approved payload before publishing, rather than treating a successful SQL write as legal or integrity approval.

CHECK changes and the non-concurrent index can take blocking locks and scan existing data. Disposable success does not establish production timing; rehearse with approved representative shape and define measured lock/statement budgets. Review affected rows and role privileges before and after; runtime gets SELECT only on authority tables. No down migration exists. Do not delete 0088 journal entries, drop retained evidence or roll back to a legacy application that bypasses fresh consent or rejects inactive state. Prefer compatible forward recovery; destructive restore/cutover needs independent approval and later-write/erasure reconciliation.

O3 records a successful isolated snapshot restore on 2026-11-19 at migration 0079. It is historical evidence, not a current 0088 recovery certificate. O1's older blanket statements that no restore drill/erasure flow exists are superseded in part by O3/P3. Neither source proves current PITR retention, a fresh recoverable snapshot, restore capacity, RPO/RTO, consent-history recovery or approved cutover. Live backup/role/settings were not inspected.

## Operations required before activation

- Name release, migration, policy publisher, localization, security, support, incident and recovery operators; existing O2 roles do not identify current people/approval assignments.
- Approve Community-specific monitoring for unavailable/stale authority, acceptance/clearance failures, unexpected state pairs, idempotency conflicts, audit failures and award reevaluation failures. Propose metric categories only; thresholds/on-call/SLO values are Owner decisions. Generic queue/cron alerts do not prove these are observed.
- Approve dispute investigation using restricted read access to exact artifact/version/hash, transition sequence, immutable acceptance and non-consent clearance; never export customer contacts/tokens or put production evidence into public CI.
- For failed Restore, first inspect authoritative state/evidence. A pre-commit failure should leave inactive/closed; post-commit pending-award failure may leave an already valid active membership. Do not create another acceptance, edit evidence or credit points to “repair” it.
- Approve retry guidance, restoration/Leave handling, incident containment, backup access/retention and reapplication of completed privacy decisions after recovery. No live notifications or customer support messages are sent by AR01.

## Evidence catalog

All repository observations are pinned; no external service plan, live configuration or legal approval is inferred from documentation.

| ID | Source |
| --- | --- |
| I1 | [Membership service](https://github.com/katohuzairu122-png/ECHOGRID-FEEDBACK-APP/blob/f1efc9d3f8c639dbfa1493bb58e0dee0c8335779/apps/api/src/community/community-membership.service.ts), same-commit `community-customer.routes.ts` and `index.ts` |
| I2 | [Platform state service](https://github.com/katohuzairu122-png/ECHOGRID-FEEDBACK-APP/blob/f1efc9d3f8c639dbfa1493bb58e0dee0c8335779/apps/api/src/community/community-platform-state.service.ts) and canonical `NETWORK_15_T2_D1_APPROVED.md` |
| I3 | [Consent persistence](https://github.com/katohuzairu122-png/ECHOGRID-FEEDBACK-APP/blob/f1efc9d3f8c639dbfa1493bb58e0dee0c8335779/apps/api/src/community/community-consent.persistence.ts), owned consent withdrawal and existing audit guards |
| I4 | [Terms authority](https://github.com/katohuzairu122-png/ECHOGRID-FEEDBACK-APP/blob/f1efc9d3f8c639dbfa1493bb58e0dee0c8335779/apps/api/src/community/community-terms-authority.ts) and shared-types `community-points.ts` |
| I5 | [0088 SQL](https://github.com/katohuzairu122-png/ECHOGRID-FEEDBACK-APP/blob/f1efc9d3f8c639dbfa1493bb58e0dee0c8335779/apps/api/drizzle/0088_community_membership_consent.sql), snapshot/journal and runtime-role manifest/generated SQL |
| I6 | Same-commit `middleware/customer-authenticate.ts`, `customer-auth/customer-session.service.ts`, `middleware/require-platform-role.ts`, `platform/community-permissions.ts`, `platform/community-point-adjustments.routes.ts` |
| I7 | Same-commit `network/network-flag.ts`, `community/community-feed.routes.ts`, `config/env.ts`, `index.ts`, both wrangler configs and customer membership routes |
| I8 | Same-commit `apps/web/src/app/loyalty/dashboard/community/enrollment-controls.tsx`, `membership-controls.tsx`, `page.tsx`, `apps/web/src/app/layout.tsx`, `apps/web/messages/{en,fr,es,ar}/loyalty.json` |
| P1 | [Unapproved Community terms](https://github.com/katohuzairu122-png/ECHOGRID-FEEDBACK-APP/blob/aa7c016b7a3cd4aca4769414b4f18242ea2cc7fe/docs/architecture/builds/NETWORK/NETWORK-15-T1/COMMUNITY_MEMBERSHIP_TERMS_DRAFT.md), T1 decision register and final PR D1 ruling |
| P2 | Main-pinned `apps/web/src/app/terms/page.tsx`, `privacy/page.tsx`, `components/legal/legal-page.tsx` |
| P3 | Main-pinned `docs/privacy/DRAFT-POLICY-PACK.md`, `docs/architecture/builds/CASHIER/CASHIER-PROD-D2-FINAL-PRIVACY-LIFECYCLE.md` |
| O1 | Main-pinned `docs/OPERATIONS.md`, `docs/DEPLOYMENT.md`, `docs/PRODUCTION-CHECKLIST.md` |
| O2 | Main-pinned `docs/RELEASE-OWNERSHIP.md`, `docs/PRODUCTION-RELEASE.md`, `docs/MIGRATION-GOVERNANCE.md`, `.github/workflows/{deploy-production,migrate-production}.yml` |
| O3 | Main-pinned `docs/architecture/builds/CASHIER/CASHIER_PROD_P2R_RESTORE_DRILL_RECORD.md` and older `builds/SPLIT-08/GATE2_R19_STAGING_BACKUP_RESTORE_READINESS.md` |
| T1 | [Exact-head main CI logs](https://github.com/katohuzairu122-png/ECHOGRID-FEEDBACK-APP/actions/runs/45168279706): API 4,233; web 1,306; PG16 1,654 passed/40 skipped; runtime consent 40; D2 privacy 35. All passed counts exclude skipped tests. |
| T2 | [Exact-head PG18](https://github.com/katohuzairu122-png/ECHOGRID-FEEDBACK-APP/actions/runs/45168279734): 1,654 passed/40 skipped; 135 files passed, one skipped. |
| T3 | [Exact-head HTTP/Chromium](https://github.com/katohuzairu122-png/ECHOGRID-FEEDBACK-APP/actions/runs/45168279644): HTTP 52 passed/19 browser-only skipped; Chromium 19 passed/17 non-browser filtered, including four-locale fresh Restore. |

## AR01 validation and limits

Re-fetched exact-head CI: **27/27 successful**, no failed/pending workflows at audit. Re-read completed job logs, not just completion reports. Prior implementation PostgreSQL/Chromium results above were verified from those logs, **not rerun as AR01 shared-environment tests**.

Fresh local checks at the exact PR head: frozen-lockfile install PASS; offline attempt initially lacked a cached tarball, ordinary frozen install succeeded without a lockfile change. Vitest **148 passed, zero failed/skipped**, three files: terms authority, deployment governance and migration governance. The locale inspection verified 12 required UI keys and three bindings in each of en/fr/es/ar. Documentation/link/scope validation is recorded in the AR01 PR/completion report.

AR01 did not execute a migration, database rehearsal, browser session, infrastructure probe, deployment, flag change, policy publication, real acceptance, notification or recovery. No new implementation defect requiring code modification was established; missing approvals/live proof and the containment/compatibility plan are the activation blockers. Do not treat this draft as operational authorization.
