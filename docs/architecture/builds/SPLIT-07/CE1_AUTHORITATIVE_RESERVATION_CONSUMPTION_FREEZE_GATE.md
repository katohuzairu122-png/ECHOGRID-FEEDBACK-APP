# ECHO GRID — CE-1 Consumption Authority Freeze Gate & Recovery Obligation Implementation Decision

**Status: PROPOSED INTERFACE — FREEZE NOT GRANTED.**
**Dependent authority: Split 08 (invoice/application), Split 07 (credit accounting), Split 06 (settlement/reversal).**

## Reconciliation findings
The merged repository currently has Split 07 award/vest/expiry/reversal and recovery-offset preparation, but no persisted, authoritative Split 08 terminal consumption/application record with reliable lot/reservation and billing references. Do not infer authority from a JSON payload, UI form, webhook, `lot.status = 'consumed'`, Stripe customer balance, invoice preview, or an admin message.

## CE-1 freeze requirements
A separately reviewed Split 08 implementation must establish one unique, immutable terminal application for a billing period, including:
- `applicationRef`, `reservationRef`, `invoiceRef`, `businessId`, `lotId`, `decisionId`, `unitsApplied`, `appliedAt`, subscription identity, policy version, provider success reference, and idempotency key;
- verified active/eligible subscription and correct invoice finalization and application success, with status and provider evidence **resolved server-side** from authoritative Split 08 tables;
- verifiable association to a valid Split 07 reservation, immutable allocation and unexpired vested lot; no replay of the same lot or invoice period;
- clear lock order: settlement first for Split 06 reversal, then Partner Credit decision, lot and account, then trusted application reference and obligation; reservation/consumption flows must be designed to respect compatible ordering;
- an append-only service benefit application history; financial reversals and Stripe invoice adjustments belong to Split 08 only.

A proposed TypeScript CE-1 interface is NOT sufficient. Split 08 must approve exact table constraints, transaction isolation, provider reconciliation and privileged access, and establish a database-queryable evidence verifier before Split 07 is allowed to post consumed-credit obligations.

## Split 07 recovery-obligation writer — DENIED for now
An eventual writer receives only an **authoritative settlement reversal event reference** and resolves the relevant award and terminal Split 08 application inside a single transaction. It must:
1. enforce platform-admin reversal authority via the existing Split 06 service and lock the settlement;
2. validate exactly one settled claim, matching award decision, one-unit lot, and terminal Split 08 application/allocation;
3. preserve the already-applied billing history, append a unique negative compensating Partner Credit ledger entry, mark the source credit reversed and insert one recovery obligation uniquely keyed by reversal event;
4. update `recoveryDue` atomically and prove account/lot/obligation/ledger conservation with rollback, replay and concurrent consumption tests;
5. refuse missing, stale or conflicting application evidence and all unsupported partial/reserved/expired states.

No obligation writer or fake proof adapter is implemented in this PR. The current provisional and available-lot reversal paths remain unchanged. The already-merged FIFO offset writer can consume a legitimately originated obligation when a new credit vests, but the present system has **no authorized mechanism to originate obligations for consumed billing credits**.

## Conservation contract and test scope
This PR introduces a read-only, pure prebilling conservation inspector and negative tests for fake CE-1 data, duplicate lot IDs, invalid amounts, mismatched available/provisional account buckets, recoveryDue mismatch and unsupported reserved/consumed lots. Its valid result is **only a local consistency check for unreserved states**, not evidence that the append-only credit ledger and every award reconcile. The full gate must independently verify event-level ledger conservation, allocation references, immutable application evidence, exactly-once reversals, FIFO offsets and replay after restart.

## Final gate
**NOT COMPLETE / NO FREEZE / NO LIVE ECONOMIC ACTIVATION.**
- No migration `0041` changes, database-barrier removal, HTTP or queue minting routes, billing application, subscription write, invoice adjustment, or Stripe changes.
- Approval required: Split 08 consumption source and authority freeze; Split 07 consumed-credit obligation writer; end-to-end Postgres concurrency, billing-provider audit and final economic reconciliations.
- Keep Split 07 Block 2 completion lock withheld.

**Next implementation slice:** Split 08 authoritative credit reservation and terminal application source of truth, including its own evidence contract and negative replay tests. Only after this is merged and frozen should Split 07 obligation creation be connected.
