# Split 07 Block 2 — Vested Recovery Obligations & Final Completion Gate Review

**Disposition: FINAL COMPLETION LOCK WITHHELD.** Implementation continues atop PR #92; this branch must not merge directly into main before its prerequisite is reconciled.

## Implemented
1. Provisional, unencumbered compensation in the same Split 06 reversal transaction: inherited from PR #92.
2. Vested **unencumbered available** one-credit lot: append -1 reverse ledger entry, mark lot/award reversed, atomically decrease available by one. It rejects an absent, reserved, consumed, expired, or inconsistent lot and never makes available negative.
3. PostgreSQL test simulates a vested/available lot only in isolated test DB, proves reversal and zeroed projections. Another test simulates consumption and proves Split 06 reversal rolls back atomically while status remains fulfilled.
4. Pure nonnegative offset plan: a future newly-vesting credit is used to reduce outstanding recovery obligations before any portion becomes available.

## Required consumed-credit obligation transition — NOT implemented
The frozen v1 contract mandates, for already consumed entitlements, a unique compensating reversal entry and obligation keyed by authoritative reversal event; the consumed history must not be altered. Existing `partner_credit_recovery_obligations` schema provides reversal_ref uniqueness and outstanding units, but there is **no approved Split 08 consumption reference, ledger entry type for consumption, lot allocation writer, or authoritative billed-application proof**. Treating a manually changed lot status as sufficient evidence for a debt would be incorrect.

Do **not** construct a real consumed-credit recovery obligation without:
- stable, verified Split 08 application/consumption reference and reversal mapping
- frozen offset FIFO/expiry ordering and nonnegative accounting
- append-only ledger conservation for partial consumption and repeated offsets
- an explicit exactly-once settlement/reversal transaction with reconciliation evidence
- PostgreSQL concurrency tests for consumed, reserved, expired and partially used credits
- approval of the accounting/audit semantics and a controlled release procedure

A consumed or reserved credit therefore makes Split 06 reversal **fail closed** (no partial Split 06 terminal reversal) until this separate domain handoff is frozen. The current pure offset arithmetic is not a vesting engine, not a posted obligation, and not proof of recovery settlement.

## No activation
The database's `0041` economic denial triggers remain untouched. The PR contains no SQL migration, Stripe, subscription, invoice write, booking entitlement application, or production credit activation. Final Block 2 completion requires actual vested/expiry lifecycle execution plus consumed-credit recovery and release-gate tests on fresh PostgreSQL.

## Lock decision
**BLOCK 2 NOT COMPLETE — no completion lock.** Split 07 implementation may continue only under the frozen domain boundaries. No retroactive awards or auto-Stripe credits.

CI routing: PR #93 targets main to activate the repository's main-only validation workflow. PR #92 must merge first; the #93 comparison includes #92 changes until then. Final completion lock is still denied.
