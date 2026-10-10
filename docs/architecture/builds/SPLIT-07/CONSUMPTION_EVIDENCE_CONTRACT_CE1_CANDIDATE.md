# ECHO GRID — Split 07 / Split 08 Consumption Evidence Interface
## Contract candidate CE-1 — NOT YET FROZEN, NO BILLING MUTATIONS

**Status:** Architecture gate and explicit fail-closed handoff only. This document does NOT authorize consumed-credit obligations, consumption writes, invoice adjustments, cash recovery, Stripe activity, or activation of migration 0041 economic mutations.

### Authority boundary
Split 07 owns the credit ledger, credit lots, reservations, recovery obligations, vesting, and expiration. Split 08 exclusively owns invoice/application success and Stripe financial state. Split 06 owns terminal settlement and reversal evidence. Split 07 may accept a consumption **confirmation** only from an authenticated, trusted, transactionally verifiable Split 08 application record; a JSON payload, client message, webhook alone, or administrator claim cannot establish consumption. An invoice preview never creates consumption.

### Proposed future trusted CE-1 reference, pending Split 08 freeze
- `evidenceVersion: 'partner-consumption/1'`
- `applicationRef`: unique immutable Split 08 successful application record ID, with confirmed/terminal status, invoice reference, and unchanged historical applied benefit
- `businessId`, `creditDecisionId`, `lotId`, `unitsApplied` (positive integer, no greater than remaining reservation), and `appliedAt`
- `policyVersion`, `idempotencyKey`, reserved-lot correlation ID, exact application reference, and server audit actor/authorization provenance
- `settlementRef` resolved from the credit decision, never independently accepted as an economic authority
- DB read under lock: Split 08 record must match the authenticated business, committed application state, unique invoice application, exact reserved lot and immutable application evidence. **No generated data structure is evidence by itself.**

### Recovery obligation contract (future writer, not built)
When Split 06 validly reverses a settlement whose credits have verifiably been consumed, the same database transaction must validate the immutable Split 08 application record, append one unique compensating `reverse` ledger entry, mark the origin lot/decision reversed while preserving consumed billing history, insert one obligation keyed by authoritative reversal event ID, and increase business `recoveryDue` projection. An obligation is never a cash debt.

When a *new* qualified lot vests, future offset processing must use `recoveryDue` obligations before making any of the new credit available; create idempotent `recovery_offset` ledger entries, reduce `unitsOutstanding` and `recoveryDue`, preserve the original billing application, and never drive `available` negative. Order by obligation creation time, then ID, under an account lock. Every partial offset must reconcile lot units with obligation units and appended history. Under this version's **one-unit awards**, consumption is at most one unit per lot, but future designs must not infer partial-consumption permissions.

### Current fail-closed implementation
Until a frozen Split 08 application/consumption contract is implemented and transactionally queryable, the Split 07 reversal compensator rejects consumed, reserved, or ambiguous lots. It does **not** invent an obligation. The vesting service likewise rejects any existing recovery debt pending a verified offset writer. No external route, queue handler, or cron runs the lifecycle service; migration 0041 denial triggers remain installed.

### Required remaining gates
1. Freeze Split 08 application evidence and database constraints with responsible domain-owner approval.
2. Implement reservation and consumption writer with verified terminal invoice success.
3. Implement exactly-once consumed-credit obligation writer and future vesting offsets, with independent reconciliation and rollback tests.
4. Validate 14 complete days, actual vesting timestamp, UTC 12-month anniversary/leap-year clamp, expiry/vesting races, unencumbered/reversed lots, replays, time provenance, and account/ledger/lot conservation.
5. Review and authorize controlled economic activation separately. No credit may be spent or applied to Stripe through this document.
