# Split 07 Block 2 — Isolated PostgreSQL Positive Award and Concurrency Gate

**Status: TEST IMPLEMENTATION ONLY; RELEASE GATE NOT PASSED.**
This test suite is appended to draft PR #91, not deployed or merged into main at preparation time.

## Test isolation
`partner-provisional-award-concurrency.integration.test.ts` is skipped unless `PARTNER_AWARD_TEST_DATABASE_URL` is configured. That variable must designate a **separate, disposable, migrated PostgreSQL database**, not `DATABASE_URL` and never production. The test temporarily disables only four Block 1 economic-denial triggers in that **isolated database**, then restores them in `afterAll`. No application migration disables those triggers. Because an interrupted process could skip teardown, the correct cleanup is to **destroy the entire disposable test database**, not reuse it for normal testing. The runner must provision fresh state for each invocation.

## Coverage added
1. Positive end-to-end fixture through existing Split 06 orphan qualification, access authorization, receiving-business acceptance, customer completion and fulfillment services.
2. Exactly one provisional unit, one decision, one lot, one append-only ledger movement and an account projection with zero available credits; identical replay yields unchanged decision.
3. Eleven simultaneous fulfillment decisions distributed across two branches after a separate initial award: exactly ten total monthly awarded units, with cap-exceeded decisions of zero units.
4. Transaction rollback after a forced ledger idempotency-key conflict leaves no decision/lot for the failed settlement.
5. Previously reversed fulfilled settlement cannot be awarded.

## Unresolved and non-negotiable
- **No CI proof of positive path until explicitly executed against isolated database.** Standard CI skips the isolated suite by design. A green default CI is NOT evidence that 11-way concurrency passed.
- **Post-award reversal is not economically compensated yet.** Existing Split 06 reversal only changes Split 06 settlement/claim/events; it does not invoke Split 07 provisional cancellation or append a Partner Credit reversal. Therefore an award can commit and subsequently be reversed without a matching compensating credit record. Do NOT authorize activation until a separately reconciled, atomic or otherwise fail-closed compensating protocol is implemented and tested with actual parallel award-versus-reversal operations. Do not unilaterally mutate Split 06 ownership or redefine the frozen 14-day policy.
- Lock-order, cap and idempotency guarantees in the candidate writer still require a fresh review on the exact tested head; assert the ledger/lot/account balance invariant after all parallel operations and test distinct settlements in adjacent UTC months.
- The isolated test's override of database barriers is not an activation migration, security policy or deploy mechanism. Preserve 0041 on main, normal CI and production.
- No subscription or Stripe integration in Split 07.

**Decision:** TEST CODE SUBMITTED, runtime validation pending; Block 2 completion lock withheld and live issuance disabled.
