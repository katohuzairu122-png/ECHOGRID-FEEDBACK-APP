# SPLIT 07 BLOCK 1 — MIGRATION COMPATIBILITY CORRECTION

**Status:** INCOMPLETE — BLOCKED ON DRIZZLE-GENERATED SNAPSHOT AND FRESH POSTGRESQL REPLAY

## Confirmed CI failure
PR #80 head `afa6e43ba8f150546fdb4157701ebdd23ab9d20f`, run `37983273796`, failed during `pnpm --filter @echo-grid-feedback/api db:check` with:
```text
[migration-drift] Schema changes have no migration.
would create drizzle/0041_chilly_mandarin.sql
would create drizzle/meta/0041_snapshot.json
would modify drizzle/meta/_journal.json
```

This is caused by `0040_split07_partner_credit_foundations.sql` and `0040` journal registration being committed without a matching Drizzle `0040_snapshot.json` state. Existing latest snapshot is `0039_snapshot.json`.

## Corrective procedure — required before this PR can merge
1. Checkout this branch in an environment with pnpm/node dependencies installed.
2. Execute `pnpm --filter @echo-grid-feedback/api db:generate` only in a disposable working tree to inspect the proposed `0041` SQL + snapshot.
3. Compare every generated table/index/constraint with `0040_split07_partner_credit_foundations.sql`. Resolve naming/type/check/index mismatches explicitly.
4. **Do not blindly ship the generated `0041`**: it will attempt to recreate already-migrated Block 1 objects. Establish one consistent chain with `0040` representing the schema state produced by the manual migration, recording a matching complete `0040_snapshot.json` and preserving `0040` journal tag. A generated or validated snapshot is required; do not invent a partial snapshot.
5. Run `pnpm --filter @echo-grid-feedback/api db:check` and require **no drift**.
6. Replay migrations 0000–0040 against a fresh PostgreSQL 16+ DB and assert the ledger UPDATE/DELETE trigger rejects both operations; verify idempotency/account/award/recovery uniqueness, tenant FKs and all CHECK constraints.
7. Verify exactly one `partner_credits:view` permission seed record and **no broad default role grant**. Demonstrate permission checks in actual caller before a read route becomes active.
8. Enforce effective Partner Credit policy immutability before any award service. Evaluate DB-level protections against direct SQL balance/lot edits; avoid unsafe activation in the meantime.
9. Re-run full CI and review exact passing SHA before Block 1 lock.

## Progress committed here
- Missing read capability seeded without role assignment.
- Added focused noncash contract tests.
- **Migration drift is NOT fixed by these commits.**
- No Partner Credit issuance service, vesting, consumption or Stripe/subscription mutation.

## Gate
Do not merge this remediation as a completion fix or unlock Block 2 until items above are done. Frozen Split 07 architecture remains authoritative.
