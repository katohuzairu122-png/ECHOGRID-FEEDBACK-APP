# ECHO GRID — SPLIT 07 BLOCK 1 COMPLETION LOCK AND BLOCK 2 AUTHORIZATION

**Decision:** BLOCK 1 INERT FOUNDATION COMPLETE — LOCK CANDIDATE; effective only after this report merges into main.
**Code baseline:** `7d8f6879ed4894d3b4d1eb77fa961041dc0e0923`
**CI evidence:** GitHub Actions workflow `38016173590`, job `114106813628`; status **success** for PR #85 commit `a83816692ba806eab33e1cf173890e54889d3601`.
**Scope of authorization:** BLOCK 2 IMPLEMENTATION DEVELOPMENT ONLY. No operational issuance or activation authorization.

## Verified gates
- `0041_split07_block1_integrity_guards.sql` merged on `main`, preserving 0040 Partner Credit schema.
- CI explicitly logged `[migration-drift] OK -- drizzle/ is up to date with src/db/schema/.`
- CI executed `db:migrate`, `db:seed`, API/web typechecks and the integration test suite successfully.
- Dedicated `partner-credit-foundations-hardening.integration.test.ts`: 5 tests passed against CI PostgreSQL, covering zero-balance and one-account-per-business, forbidden account mutation, ledger insertion denial, published-policy parameter immutability, permission catalog and absence of automatic grants in the CI seed.
- `0040` ledger rejects UPDATE/DELETE by trigger; `0041` keeps economic mutations unavailable during the foundation stage.
- Existing Partner Credit read repository takes a business scope; there is no separately authorized Partner Credit business read route yet. Permission `partner_credits:view` is present and not broadly granted by seed.

## Deliberate limitations — must not be misrepresented
- CI pass is **not** evidence of production deployment or production database migration; deployment jobs were skipped.
- Dedicated test currently does not attempt ledger UPDATE/DELETE, lot INSERT, award decision INSERT, reversal recovery INSERT, all unique key scenarios, or concurrent transaction serialization. These require explicit tests before enabling Block 2 economic writes.
- No authenticated business credit inspection route has been activated; branch-only staff and other businesses must be denied by tested access checks when one is introduced.
- Account/lot conservation under an active award transition is not established by inert-data tests; Block 2 must establish atomic ledger-plus-projection invariants.
- Draft economic policy parameters are editable by authorized database writers; published economics cannot be edited by the new guard. Block 2 must create only a frozen published version matching `PC-ECON/1` values.

## Lock scope / preservation
**Lock the inert foundations**: seven-table contract, shared Zod types, 0040 and 0041 migrations, permission catalog, safe read-only repository, ledger immutability and disabled mutation defaults. The freeze of business loyalty, Community Points, Split 06 orphan settlement ownership and Split 08 billing/Stripe authority remains unchanged.

## Explicit Block 2 authorization (conditional on merge)
Once this report is merged with passing branch checks:
1. Authorize separate Block 2 PRs implementing trusted Split 06 fulfillment evidence revalidation and explicit Partner enrollment under platform-admin rules.
2. Authorize implementation and tests for deterministic provisional award decisions, 10-credit UTC business-month cap, 14-day provisional holding period, strict one-award-per-settlement and transaction-safe idempotency/concurrency.
3. Authorize development of narrowly controlled atomic PostgreSQL award transaction and revision of the inert barriers, **only on a gated implementation branch** with tests; never remove Block 1 barriers unconditionally.
4. **Do not activate production minting**, process existing settlements, run data backfills, execute vesting, consume credits, alter invoices, or write to Stripe absent separate security, concurrency, reversal and production cutover gates.
5. Block 2 release must test denied direct writes, positive valid award transaction, rollback, 11 concurrent awards across branches, past enrollment, reversal races and tenant/role isolation. Locking audit must be repeated against exact final head.

## Status
Block 1 code is integrated and its *inert-foundation* validation has passed. This record is the formal completion-lock decision for that limited scope, pending merge of this report. It does not authorize economic activation.
