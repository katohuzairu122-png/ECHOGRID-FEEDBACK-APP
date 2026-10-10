# Split 07 Block 2 — Atomic Provisional Award Engine: Implementation Candidate

**Status:** DRAFT — NO ECONOMIC ACTIVATION
**Dependencies:** Block 1 completion lock, frozen PC-ECON/1 policy, Split 06 fulfillment and reversal authority.

## Candidate implementation
The internal `PartnerProvisionalAwardService.decide` transaction verifies authoritative settlement and claim states, identity, canonical fulfillment event, and absence of reversal; it locks the settlement before locking the receiving business, matching Split 06 reversal's settlement-first ordering, then locks claim and enrollment. The receiving business lock serializes monthly cap evaluations across branches. Exact per-settlement idempotency keys and unique database indexes protect replay. The UTC month comes from authoritative fulfilledAt.

After enrollment and policy validation, exactly one qualifying unit can be provisionally recorded per settlement, up to ten units across a receiving business per UTC month. The decision, lot, ledger entry and account projection are in a single PostgreSQL transaction. The credit remains provisional, not available, for at least 14 days after fulfillment; delayed evaluation never vests before decision time. Cap-exceeded decisions have zero units and no lots/ledger writes.

## Critical activation restrictions
- **Migration 0041 denial triggers deliberately remain installed and enabled.** Under current database configuration, a qualifying award transaction will reject and roll back; this is intentional.
- This class has no HTTP route, queue consumer, cron job or other production invoker.
- No Stripe, invoice, subscription, loyalty, Community Point, or Split 06 state mutation.
- No migration to disable triggers is included. Such migration requires a separately gated, least-privilege stored procedure or other DB-enforced authorization contract, tested for direct writer bypass.
- No existing fulfilled settlement may be backfilled without a separate explicit enrollment and no-retroactivity review.
- Policy version and decision/lot/ledger conservation must be enforced during release.

## Mandatory verification remaining before release
1. Build actual Split 06 fulfilled fixtures; prove one valid provisional result end-to-end **after a separately authorized test-only database transition**, never by silently disabling 0041 in the shared test database.
2. Prove 11 parallel fulfillments across branches award at most 10 business-month units; test UTC boundaries, same settlement replay and transaction rollback.
3. Prove simultaneous settlement reversal vs award cannot create an unauthorized credit. Post-award reversal compensation belongs to a later independently frozen block.
4. Prove uniqueness, account projection = ledger/lot, reservation isolation, and database privilege denial.
5. CI typechecks and integration tests on exact head; test migration replay and zero Drizzle drift; only after passing gates propose narrowly scoped activation transition.
6. Reconcile account upsert/update restrictions and concurrent write transactions with DBA-reviewed stored routine; do not weaken inert guards directly.

## Important limitation
A test that asserts invalid evidence fails and triggers remain enabled is **not** a positive or concurrent award test. The present PR is the engine source and fail-closed foundation, not a completed operational award release.
