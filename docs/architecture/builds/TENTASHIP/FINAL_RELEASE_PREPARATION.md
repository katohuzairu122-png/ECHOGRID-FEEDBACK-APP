# Final release preparation record (G1–G12)

Date: 2026-11-26. **Preparation only. Nothing in this document has been executed against any shared environment.** No merge, deployment, staging or production migration, remote branch, Cloudflare change, activation, real campaign, real operator assignment or legal publication has been performed.

## 1. Repository state this record describes
`main` = `bafed5c` (TSH-04, #613, merged by the Owner). Open stack of draft PRs (each stacked on the previous; CI for stacked PRs runs only when a PR targets `main`, so hosted CI results exist only for #614 and #618 until the parents merge):

| PR | Group | Head | Base | Migration |
|---|---|---|---|---|
| #614 | G5 operator assignments + decision policies | `{{614}}` | main | 0104 |
| #615 | G6 sponsor onboarding + fulfilment policy | `{{615}}` | #614 | 0105 |
| #616 | G2 notification delivery persistence | `{{616}}` | #615 | 0106 |
| #617 | G4 acquisition evidence reader | `{{617}}` | #616 | none |
| #618 | G3 contained governance/sponsor components | `{{618}}` | main | none |
| #619 | G8/G9 deletion readiness + closure obligations | `{{619}}` | #617 | none |
| #620 | G10 legal drafts, config tests, rehearsal script, registers + this record | `{{620}}` | #619 | none |
Suggested merge order: #614 → #615 → #616 → #617 → #619 → #620, and #618 at any time. After each squash merge, merge `main` into the next branch (the content is identical, so it merges cleanly) and retarget it to `main` so hosted CI runs; verify the net diff against `main` before the Owner merges.

## 2. Migration manifest (pending range on shared environments: 0088 → 0106 = 19 migrations; ledger 88 → 107)
Hashes are SHA-256 (first 16 hex) of the committed SQL files. A shared-environment ledger is verified by the READ-ONLY procedure in §4, never assumed.

| idx | migration | sha256 (16) | additive? | rollback evidence (not executed) |
|---|---|---|---|---|
| 88 | 0088_community_membership_consent | 2a9dd536afacd36b | yes | CF2 reconciliation |
| 89 | 0089_customer_deletion_requests | 3ce8df8edd63f6a3 | yes | CF2 reconciliation |
| 90 | 0090_community_pilot_eligibility | e124c9cdf90eab46 | yes | CF2 reconciliation |
| 91 | 0091_network_business_posts | 96add276985436d7 | yes | — |
| 92 | 0092_network_follows | 3c07f1eb1ea8eecb | yes | — |
| 93 | 0093_network_engagement_events | e23aaa8e37b43d83 | yes | — |
| 94 | 0094_business_closure_requests | 15ff54c291a07be7 | yes | 0094_0095_rollback.sql |
| 95 | 0095_tentaship_badges | 924d312808727cca | yes | 0094_0095_rollback.sql |
| 96 | 0096_customer_invitations | 3a37f1203bc94563 | yes | 0096_0097_rollback.sql |
| 97 | 0097_qualification_referrals | f9a8ae915355a293 | yes | 0096_0097_rollback.sql |
| 98 | 0098_shuffle_campaigns | 9f105af84af13fb0 | yes | 0098_0100_rollback.sql |
| 99 | 0099_shuffle_participation | e937b28677920a1d | yes | 0098_0100_rollback.sql |
| 100 | 0100_drops_sponsorship_inventory | d0ff110a41c8fccb | yes | 0098_0100_rollback.sql |
| 101 | 0101_governance_cases_overrides | ac005e6b3f265c86 | yes | 0101_rollback.sql |
| 102 | 0102_governance_fraud_signals_dedup | 486b20fd1642c596 | yes | 0102_rollback.sql |
| 103 | 0103_shuffle_drop_allocations | b71892133e6e683b | yes | 0103_rollback.sql |
| 104 | 0104_governance_operator_lifecycle_decision_policies | 059f0f6538af7609 | yes (replaces 0101 guard functions) | 0104_rollback.sql |
| 105 | 0105_sponsor_applications_fulfilment_policies | 51673be575db00a5 | yes (replaces 0100 guard functions) | 0105_rollback.sql |
| 106 | 0106_shuffle_notification_deliveries | fdda2ac3d98347d7 | yes | 0106_rollback.sql |
{{G12_MIGRATION_ROW}}
Rollback files are in `docs/architecture/builds/TENTASHIP/rollback/`. They are evidence, are NOT executed by any workflow and need the Owner's instruction, a restore point and a transaction.

## 3. Local verification evidence (disposable PostgreSQL 16, synthetic data; hosted results are separate)
{{EVIDENCE}}

## 4. Read-only verification of an actual deployed ledger (to be run by the Owner or on the Owner's instruction)
```sql
SELECT count(*) AS rows, max(created_at) AS last_created_at FROM drizzle.__drizzle_migrations;
```
Expected baseline before this range: 88 rows. The Drizzle migrator decides by the journal `when` timestamp against the latest applied `created_at` (older stored hashes may differ because early files were normalised after being applied; see CF2_MIGRATION_RECONCILIATION.md). Do not assume; compare, then proceed.

## 5. Restore point and scratch-branch rehearsal (instructions only; NOT executed)
1. Record the `main` tip SHA (40 hex). 2. Create a restore point of the staging Neon branch (snapshot id and time recorded). 3. Create a scratch branch from that restore point (a remote action: needs the Owner). 4. Dispatch the existing protected `migrate-staging.yml` for that exact SHA against the scratch branch first. 5. Verify read-only: ledger = 107, the new tables exist and are empty, `governance_operators`, `governance_decision_policies`, `sponsor_applications`, `drop_fulfilment_policies` and `shuffle_*` tables hold no rows, no control is set. 6. Re-run the local rehearsal (§6) and compare counts. 7. Only then consider staging. Production is a separate instruction.

## 6. Local rehearsal (executed here on disposable databases)
`REHEARSAL_PG_URL=postgresql://user:pass@localhost:5432 node apps/api/scripts/release/local-release-rehearsal.mjs` (loopback only; refuses anything else): clean install; upgrade from the 0000–0087 baseline to head; runtime-role drift check; every committed rollback file newest-first on a clone. Last local result: REHEARSAL_PASSED_LOCAL_DISPOSABLE_ONLY (ledger 107).

## 7. Runtime-role provisioning
`apps/api/scripts/runtime-role/` (manifest, generated provision/verify SQL, `generate.mjs --check`). New tables are runtime SELECT-only except `shuffle_drop_allocations` and `shuffle_notification_deliveries` (INSERT, SELECT). The operator, policy, sponsor-application and fulfilment-policy tables are SELECT-only for the runtime: their writers are Owner-side privileged tooling, never an HTTP route.

## 8. Controls-off acceptance (all of it must hold with NO control set)
- `TENTASHIP_BADGES_ENABLED`, `TENTASHIP_SHUFFLE_ENABLED`, `TENTASHIP_DROPS_ENABLED`, `NETWORK_*` and `COMMUNITY_*` controls are absent from every committed Worker config and workflow (test: `controls-off-in-repo-config.test.ts`); they are set only by the Owner outside the repository, exact string "true".
- Every Tentaship route family answers a generic 404 before authentication when its control is off (existing suites per family); the allocation orchestration needs BOTH Shuffle and Drops.
- Production tables for operators, policies, sponsors and fulfilment policies are empty, so decisions, overrides, sponsor reservations and collection-policy interfaces are refused or unavailable.
- No customer-visible component is routed (contained components only); no notification can leave (empty class-policy registry, synthetic providers only).

## 9. Individual-control synthetic acceptance (disposable environments only)
Each control is switched on alone, in a disposable stack with synthetic data, in this order, checking that families stay independent: Badges → Shuffle (configuration, participation) → Drops (sponsorship, inventory) → governance (needs Shuffle or Drops, each family its own control) → allocation orchestration (needs both). The integration suites named in `GROUPS_01_03_FINAL_ACCEPTANCE_AND_STAGING_PREPARATION.md` plus `shuffle-drop-allocation`, `governance-operators-policies`, `sponsor-onboarding-fulfilment`, `shuffle-notification-delivery`, `acquisition-evidence`, `business-closure-tentaship` and `customer-data-inventory` cover this; none runs against a shared database.

## 10. Staging deployment instructions (NOT AUTHORIZED; separate Owner instruction required)
Follow `PRESTAGING_BATCH_02_STAGING_PREPARATION.md` and `CF2_*` documents: verify ledger, restore point, scratch rehearsal, `migrate-staging.yml` with the typed confirmation for the exact SHA, read-only verification, controls still off, then controls-off acceptance (§8). Feature activation is a further instruction, one control at a time.

## 11. Production prerequisites (all external)
Owner decisions G-D1..G-D11 and D01–D14 relevant to the control being activated; legal L-1..L-6 for any customer-visible text; operational assignments O-1..O-12; translation approvals H-2/H-3/H-4; a verified restore point; a successful scratch-branch rehearsal; hosted CI green on the exact merge SHA of `main`. See `FINAL_CONSOLIDATED_REGISTERS.md`.
