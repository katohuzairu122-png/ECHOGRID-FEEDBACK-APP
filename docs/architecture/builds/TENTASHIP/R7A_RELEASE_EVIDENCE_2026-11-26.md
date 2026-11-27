# R7-A — Release evidence record (migrations 0088–0106, build cded1a7), 2026-11-26

Documentation only. This record does not migrate, deploy, activate or modify anything. It records what was done and verified on 2026-11-26 and what was **not** verified. Where a fact rests on the Owner's statement or pasted output rather than on a check made by the release operator, it is labelled **Owner-attested**.

Pinned release commit: `cded1a75965cee80bacc190d9d6e3614d6504e28` (`main`). Environments: staging (Neon project `lucky-glitter-47218268`, branch `br-bold-water-aukjlvw3`; the branch is named `production`, use the project id), production (Neon project `divine-voice-54333763`, branch `br-blue-paper-atrcoge1`).

## 1. Workflow runs (read from GitHub on 2026-11-27)
| Step | Workflow | Run | Result | Start (UTC) |
|---|---|---|---|---|
| R2 | Migrate staging database | 45870553730 | success | 2026-11-26 17:46 |
| R3 | Deploy staging | 45871976214 | success | 2026-11-26 17:57 |
| R6 | Migrate production database | 45879986818 | success | 2026-11-26 18:57 |
| R6b | Deploy production | 45880663386 | success | 2026-11-26 19:03 |
All four: `workflow_dispatch` on `main`, head SHA `cded1a75965c`, dispatched by the Owner's account. The production workflows waited at the `production` environment approval gate.

## 2. Restore points
| Environment | Restore point | Notes |
|---|---|---|
| Staging | `snap-solitary-snow-aueajoiy` | Created 2026-11-26T13:10:38Z, reused for R2 (Owner waived an additional isolated rehearsal). |
| Production | `snap-summer-rain-atowc6mn` | Created 2026-11-26T18:56:58Z (45,629,440 bytes), taken immediately before R6. |
A restore of either snapshot was **not** exercised on this release. Earlier snapshot restores (not this release) are recorded in R1 §6.

## 3. Database state after the release
| Item | Staging | Production |
|---|---|---|
| Migration ledger | 88 → **107** rows | 88 → **107** rows |
| New tables (migrations 0088–0106) | **42 of 42** present | **42 of 42** present |
| `db:verify:production` exact hash matches | 94 | 99 |
| Hash differences vs repository | only the documented reconciliation set (`CF2_MIGRATION_RECONCILIATION.md`) | same |
| Grants to PUBLIC on the new tables | none | none |
The ledger on both environments was later confirmed at 107 (the journal now has 108 entries; migration 0107 is on `main` and was **not** applied to either environment).

## 4. Data-preservation evidence (counts before and after the migration)
- Staging: audit log 522, users 50, customers 3 — unchanged by the migration.
- Production: users 5 and customers 1 unchanged; audit log 244 → 246 (ordinary activity during the window); every new Tentaship table empty.
Note: on 2026-11-27 the Owner separately authorised an account reset (production and staging snapshots `snap-calm-hall-at00dpm3` and `snap-raspy-forest-aus3039q`); those later counts are not release evidence.

## 5. Route containment evidence
| Check | Method | Result | Class |
|---|---|---|---|
| Staging gated routes after R3 | Unauthenticated probes from the release operator | all Tentaship route families answer a generic 404; API health OK; the web host answers 404 for the cashier login | **Unauthenticated route-gate verification** |
| Staging Badges control (R4) | Owner set `TENTASHIP_BADGES_ENABLED` on the staging API, then removed it | Badges families moved 404 → 401 (gate opened, authentication required); Shuffle, Drops and governance stayed 404; after removal everything 404 again at 18:48:53Z | **Unauthenticated route-gate verification** |
| Production after R6b | Probes run from the Owner's machine (the release session's proxy blocks the production hosts) | all seven Tentaship route families 404; health OK; cashier login on the web host 404 (one probe printed 000, a re-run printed 404) | **Unauthenticated route-gate verification, Owner-attested** |
All ten Tentaship feature controls were unset or off at every point except the single Badges staging test above.

## 6. What was NOT verified (do not read the above as functional acceptance)
- **Authenticated functional acceptance of Tentaship Badges: SKIPPED** by Owner decision (no staging token was available: the web session is a cookie). Badge retrieval, qualification, award behaviour and authorization on a deployed environment were **not** exercised. The only functional evidence is the repository's local PostgreSQL integration tests. This is not classified as passed.
- No authenticated acceptance of Shuffle, Drops, Community, governance or sponsor capabilities (all off).
- The restricted runtime role `echogrid_app_runtime` was **not provisioned** on either environment; the Workers connect as the table owner (see R7-B).
- The deployed Worker variables and secrets were not readable by the release operator (the Cloudflare connector returns only a Worker's name and id).

## 7. GitHub branch protection (read on 2026-11-27)
- `main`: `protected: true`; required status check **`Typecheck & Test`** (enforcement: everyone). The rulesets API returns no rules.
- Details **not** readable with the available token (classic protection returned 403): required reviews, "require branches up to date", force-push and deletion rules, administrator enforcement.
- GitHub environments `staging` and `production` (required reviewers, self-review prevention, deployment-branch limits) and their secrets: **Owner-attested** (the Owner stated they are protected; the environments API is blocked through the proxy). Observed behaviour: the production workflows waited at the `production` approval gate.

## 8. Owner-approved exceptions and waivers
1. Additional isolated snapshot rehearsal before R2: waived.
2. Remaining manual Cloudflare inspections: deferred, not certified as passed.
3. Production point-in-time retention of 6 hours (target 7 days) and no automated backup schedule: accepted for this release (the recovery gap is addressed in R7 §recovery).
4. Authenticated Badges run: skipped (§6).
5. The password the Owner pasted into chat on 2026-11-26 was reported as exposed; the Owner was told to rotate it. Rotation is **not verified** by the release operator (no value was requested).
6. Standalone "TENTA" label in the web UI: left for BRAND-01 (not authorised).

## 9. Classification
- R2, R3, R6, R6b: **VERIFIED COMPLETE** (workflow results, ledger and table checks, data counts).
- Containment: **verified unauthenticated**; **not** authenticated.
- Badges functional acceptance: **NOT PERFORMED**.
- Runtime-role verification: **NOT PERFORMED** (role not provisioned).
- Activation of any feature: **NOT AUTHORISED**.
