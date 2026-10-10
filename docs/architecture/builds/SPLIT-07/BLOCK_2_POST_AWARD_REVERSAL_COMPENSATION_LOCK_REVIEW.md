# Split 07 Block 2 — Post-Award Reversal Compensation & Completion Lock Gate

**Disposition: PARTIAL IMPLEMENTATION. BLOCK 2 COMPLETION LOCK WITHHELD.**

## Provenance and domain boundary
Split 06 remains authoritative for settlement reversal state and reversal evidence. Split 07 alone owns Partner Credit compensating ledger and projections. In the authoritative Split 06 reversal transaction, after the reversal event is inserted and before the transaction commits, the new Split 07 compensator is invoked. Failure in Split 07 rolls back Split 06 settlement, claim, event and audit mutations as a unit.

## Provisional-only compensation
With a matching provisional award, reversal requires its exact business, one-unit provisional lot, original one-unit provisional ledger entry, and nonnegative account projection. It creates one **append-only -1 reverse ledger entry**, changes the lot and decision to reversed and deducts exactly one from account provisional. Replay of a fully compensated decision is checked for the reversal ledger entry; reversal of a zero-unit cap-exceeded outcome requires no credit adjustment. A settlement that has never received an award incurs no Partner Credit mutations.

All decisions, lots, ledger and projection mutations take place in the same transaction. The settlement row was locked before this method is invoked; the award writer locks settlement first as well. This resolves the simultaneous **award versus reversal of an unvested credit** race.

## Critical outstanding restrictions
- **Vested, reserved, consumed or expired credits are NOT recoverable yet.** The compensator rejects unsupported states and fails the entire Split 06 reversal closed. A separately frozen recovery-obligation and offset policy is required for a complete workflow. This implementation MUST NOT be described as general reversal safety.
- A reversal after an award decision becomes `vested` or its lot is no longer `provisional` is intentionally blocked. Define account nonnegative guarantees, recovery ordering, multi-credit reservation impacts and compensating ledger policy before changing this.
- The frozen policy and Block 1 migration `0041` remain unchanged. Standard database guards still prohibit economic writes. All positive test execution must happen exclusively against the isolated disposable PostgreSQL CI database.
- Verify domain ownership/architecture approval for the Split 06→Split 07 integration call; Split 06 now coordinates the two domains in one transaction but does not itself calculate or mutate credit economics.
- No queue, scheduled vesting job, production mint route, Stripe integration or subscription credit application is introduced.

## Verification required before approval
Run positive award/replay, 11-way monthly cap, rollback, post-award provisional compensation, concurrent award-versus-reversal, reversal-before-award and unchanged Block 1 guard tests on the exact PR head. Confirm full GitHub Actions CI and independently review that reversing vested/consumed credits remains impossible rather than silently generating a negative available balance.

**Next mandatory block:** Split 07 Block 2 — Vested Credit Recovery Obligations & Ledger Conservation; then completion freeze/review. Economic issuance remains disabled.
