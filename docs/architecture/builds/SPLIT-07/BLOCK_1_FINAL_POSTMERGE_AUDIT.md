# ECHO GRID — SPLIT 07 BLOCK 1 FINAL POST-MERGE AUDIT

**Status: PARTIAL PASS — COMPLETION LOCK WITHHELD**
**Authoritative baseline:** `main` @ `7e70ba9a30c6d20b622d4420fb0717ea2333924f`
**Verified workflow:** `37988941994` / Typecheck & Test job `114017883736`, completed SUCCESS on snapshot commit `652a3a531370e026cbacbf88e30ed48a210b0cae`.

## Verified PASS
1. `0040_snapshot.json` exists on `main` with the seven Split 07 foundation tables.
2. Log explicitly states `[migration-drift] OK -- drizzle/ is up to date with src/db/schema/.`
3. Workflow ran `pnpm --filter @echo-grid-feedback/api db:migrate` successfully against CI PostgreSQL.
4. API and web typechecks executed successfully.
5. Existing integration suite executed successfully as part of the green job.
6. Existing Partner Credit ledger migration contains a trigger blocking ledger UPDATE/DELETE operations.
7. No Split 08 subscription or Stripe mutation introduced in Block 1.

## Remaining completion-lock blockers
1. **Missing dedicated real-Postgres Partner Credit integrity tests.** Existing run exercised general migrations/integration tests, but not dedicated `partner_credit_*` database tests demonstrating duplicate account/decision/reversal keys, ledger trigger UPDATE/DELETE denial, policy immutability, rollback, account/lot/ledger reconciliation.
2. **Business-wide financial permission boundary remains unproven.** `partner_credits:view` is seeded on merged `main`; it is deliberately not granted to default branch roles. Current repository methods accept a supplied businessId and filter by it; no exposed Partner Credit route currently authorizes callers. A future view route must resolve trusted business-wide authority and demonstrate negative tenant/branch tests.
3. **Policy immutability and balance conservation protections:** policy rows can currently be modified after activation via SQL; account/lot projections can be changed independently of ledger history. Before any economic award service or Block 2 issuance, close these controls and test DB boundaries.
4. **Operational activation:** Block 1 must remain inert; no award service, vesting, consumption, backfill, billing discount or Stripe call.

## Resolution path
- Add dedicated `partner-credit-foundations.integration.test.ts` against real Postgres; verify 0040 checks, immutable ledger trigger, uniqueness, transaction rollback, no cross-domain side effects.
- Enforce policy-version immutability after activation; either add hard DB guarantees or protected write paths with explicit provable tests; protect projections against uncontrolled direct mutations.
- Prove permissions and trusted-tenant enforcement before exposing business read routes.
- Run fresh full CI on exact candidate SHA and record each gate with its reference.
- Issue **Block 1 LOCKED COMPLETE** only after all checks pass; then authorize a separate Block 2 implementation PR.

## Block 2 linkage
The separately proposed `BLOCK_2_EVIDENCE_ENROLLMENT_PROVISIONAL_AWARDS_CONTRACT.md` defines eligibility, enrollment and provisional decisions only. It may be reviewed while Block 1 remains under audit but cannot activate minting or Stripe/billing operations.

**Outcome: MIGRATION COMPATIBILITY PASS; FULL BLOCK 1 COMPLETION LOCK NOT ISSUED.**
