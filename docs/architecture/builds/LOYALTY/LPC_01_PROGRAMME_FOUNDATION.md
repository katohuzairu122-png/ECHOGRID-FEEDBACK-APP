# LPC-01: loyalty programme foundation (Group 01)

**Status: IMPLEMENTED, VALIDATION PENDING (local disposable PostgreSQL 16 and unit suites; hosted CI not yet run).** Development only. Nothing here is merged, migrated on a shared database or deployed. All ten runtime controls are untouched. Builds on `REWARD/REWARD_01_RECONCILIATION.md` (RW-D1 to RW-D8) and `FEATURES-04-06/REWARD_CONFIG_01_DESIGN.md`; no approved decision is reopened.

## What exists now
- **Migration `0107_loyalty_programs_foundation`** (additive): `loyalty_programs` (draft, validated, active, inactive, retired; partial unique index = one active programme per business), `loyalty_program_versions` (immutable configuration versions), `loyalty_program_events` (activation history), `loyalty_program_setup` (Configure Later marker), `loyalty_program_progress` and `loyalty_program_progress_events` (per-account counters with a unique source key), `loyalty_program_entitlements` (earned single-use rewards), plus two nullable provenance columns on `loyalty_transactions` (`program_id`, `program_version`, both-or-neither).
- **Database guards:** legal lifecycle transitions only, immutable type and business, no deletion, append-only history, composite tenant foreign keys, tenant checks in triggers, truncation denied, LP-08 can never be active.
- **Legacy backfill (same migration):** every existing business gets one active LEGACY LP-03 programme reproducing its `loyalty_settings` (or the table defaults), so earning is identical on release day. Evidence: `scripts/release/lpc-backfill-evidence.mjs` (existing rows byte-identical; programme per business; no business with two active).
- **Shared pure rules** (`packages/shared-types`): `loyalty-money` (exact BigInt decimals, KWD three digits, no floats) and `loyalty-programs` (registry, per-type configuration validation, earning, preview). The web preview and the API use the same code.
- **API:** `GET/POST /loyalty/programmes`, `GET /:id`, `GET /:id/history`, `PUT /:id/config`, `POST /:id/validate|activate|deactivate|retire`, `POST /preview`. Configuration needs `rewards:manage` and business-wide access; activation, pausing, switching and retiring are additionally **Owner-only** (system Owner role, business-wide) inside the service.
- **Earning:** the purchase and check-in paths resolve the active programme on the server (no caller input). LP-03 and LP-02 are available; every other type is listed as unavailable. Settings edits on a legacy business become a new version of its legacy programme (future events only).

## Decisions taken here (flagged so the Owner can overrule)
1. **Resolution rule.** A business with a programme row earns under its active programme; one with none and no setup marker (a pre-programme business created outside the registration flow) keeps earning exactly as before; one that chose Configure Later, or paused every programme, earns nothing and the ledger row says so. This keeps every existing business and fixture unchanged.
2. **Inactive programmes can be re-activated** (pause and resume); retired ones never. Editing an inactive programme is refused.
3. **Money.** Amounts beyond the currency's precision are refused, never rounded. Until the storage columns are widened (separate block, RW-D7 migration), a KWD amount whose third decimal is not zero is refused with `AMOUNT_PRECISION_NOT_SUPPORTED`. The old float expression's rare one-point artefacts are not reproduced.
4. **Provenance.** Programme-generated ledger rows carry the programme and version; adjustments, redemptions and the referral and birthday overlays carry none.

## Open Owner decisions (REWARD-CONFIG-01 section 11; not invented here)
Configure Later default (this block implements the recommended "earn nothing until a programme is active"); LP-01 entitlement mechanism and stamp expiry and reset values; the re-onboarding model document for switching (progress-based programmes enrol on first qualifying purchase until it is cited); stacking configuration; whether a draft may run beside the active programme.

## Not in this block
LP-01, LP-04 to LP-07 engines; LP-08 (blocked on item-level evidence, RW-D3); the KWD three-decimal storage migration; registration selector and Programme screens; customer card adaptation; tiers and reward catalogue reconciliation.

## Rollback
`docs/architecture/builds/TENTASHIP/rollback/0107_rollback.sql` (refuses to run if any programme-generated history exists). Not executed anywhere shared.
