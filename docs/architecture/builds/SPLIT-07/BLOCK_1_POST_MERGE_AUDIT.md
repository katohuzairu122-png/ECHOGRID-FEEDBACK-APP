# ECHO GRID — SPLIT 07 BLOCK 1 POST-MERGE AUDIT

**Audit status: FAIL — COMPLETION LOCK WITHHELD**  
**Authority:** Split 07 v1.0 frozen architecture / Block 1 foundation contract  
**Observed on main:** Block 1 merged, migration 0040 present  
**CI source:** PR #80 head `afa6e43ba8f150546fdb4157701ebdd23ab9d20f`, workflow run `37983273796`, job `113998842161`.

## Findings

### P0: Migration drift confirmed — FAIL
GitHub Actions Typecheck & Test failed at `pnpm --filter @echo-grid-feedback/api db:check`. The actual drift guard reported:
```
[migration-drift] Schema changes have no migration.
  would create  drizzle/0041_chilly_mandarin.sql
  would create  drizzle/meta/0041_snapshot.json
  would modify  drizzle/meta/_journal.json
```
The manually authored `0040_split07_partner_credit_foundations.sql` and journal registration do **not** include the generator's matching schema snapshot. Do not blindly commit the generated `0041`: inspect its proposed operations versus the manual 0040 and reconcile the snapshot in a single, unambiguous migration history. Do not allow duplicate CREATE TABLE on migration replay.

### P1: Missing partner view permission — FAIL
`apps/api/src/db/seed/permissions.seed.ts` does not include `partner_credits:view`. Freeze contract requires business-wide financial visibility scoped separately from ordinary branch operational access. Do not automatically grant branch managers or settlement permission holders aggregate partner financial visibility.

### P1: Database-conservation proof absent — INCOMPLETE
Merged schema enforces one account per business, one award per settlement, nonnegative account projections and a ledger UPDATE/DELETE-denial trigger. However, current tests establish only shared Zod shape constraints. Fresh PostgreSQL replay, insert/rollback/uniqueness/immutability tests and balance-versus-ledger invariant proof are not evidenced by the failed CI run. Rows can be inserted directly via SQL despite absent earning service; application-level no-route is not the same as a DB-enforced zero-credit activation policy.

### P1: Authorization proof incomplete
Repository lookup methods filter by supplied `businessId`, but the caller's trusted tenant/role authorization must be verified at future route boundary; no Partner Credit read route is currently active. Do not claim repository filtering alone enforces access control.

### P1: Database policy immutability / runtime transitions
`partner_credit_policies` currently allows UPDATE to historical economic parameters. Formal production policy immutability and account/lot projection reconciliation need explicit controls or tests prior to any economic mutation service. The append-only trigger covers the ledger only.

### P1: Split 08 isolation preserved in examined foundation
No Partner Credit earning/vesting or Stripe mutation route was identified in the merged Block 1 files. No billing activation is authorized.

## Lock decision

**BLOCK 1 LOCK: REJECTED PENDING REMEDIATION.**

Required before lock:
1. Reconcile Drizzle's 0040 SQL and snapshot/journal history; rerun `db:check` with zero drift.
2. Replay full migrations on fresh PostgreSQL and verify 0040 schema constraints/triggers; forbid duplicate 0041 table creation.
3. Add `partner_credits:view` to catalog/seed and explicitly scope role assignments; negative tenant/branch tests.
4. Add real-Postgres tests for unique accounts/settlement decisions/reversal refs, immutable ledger, rollback and projection integrity.
5. Lock/version active economic policy semantics without creating live earning rights.
6. Run full PR CI: lint, API/web typechecks, tests, builds, browser and security gates. Review exact green commit SHA.
7. Re-audit evidence and issue explicit **PASS** lock report in a separate follow-up. No Block 2 implementation until then.

**Immutable boundaries:** No changes to Splits 01–06, no raw point/Community/loyalty conversions, no award service activation, no Split 08 billing or Stripe writes.
