# Split 07 Block 2 — Concurrent Provisional Award Preparation

**Not enabled.** The Block 1 migration 0041 denial triggers remain in place. No award path, ledger mutation, projection writer, Stripe or invoice integration is introduced in this slice.

## Candidate atomic transaction design
- Internal actor only; client evidence is an untrusted settlement locator.
- Begin PostgreSQL transaction with a consistent lock order. Lock receiving business row for update (serializes all its branches and avoids a missing-account race), then authoritative settlement row, then claim row. Do not trust the result of a prior read-only verification outside this transaction.
- Lock and validate active Partner enrollment, accepted policy/version, effective times, and canonical Split 06 fulfillment event; test reversal concurrently with same settlement locking discipline.
- Resolve existing decision by unique settlementRef before evaluating again; duplicate identical attempts return the persisted outcome, mismatched claims fail closed.
- Determine UTC month from authoritative settlement.fulfilledAt. Under business lock count awarded (not rejected) units for that business+month. At 10, append one permanent cap_exceeded decision with zero units, never backfill.
- Eligible award: insert single provisional decision, single credit lot, append-only ledger movement and account projection atomically. Protect all writes behind narrowly scoped stored transaction authority; replace 0041 inert denial guards only after full integration and privilege audit.
- Fourteen-day hold begins at fulfillment but never permits vesting in the past on late processing. No immediate available credit.
- Abort transaction on constraint conflict or midstream failure. Handle serialization/deadlock retry with bounded server-side policy, never duplicate credit.
- The reversal integration needs an explicit lock-order proof and compensating lifecycle; Split 06 cannot be mutated to simplify credit logic.

## Required acceptance gates
- Proven authenticated consent event at a trusted route, with displayed terms version and SHA-256 digest; audit actor attribution and revocation model. A caller-supplied authenticatedUserId is not independently proof of the actual session.
- Positive and denial PostgreSQL enrollment scenarios, including double enrollment, changing role privileges, policy mismatch and platform impersonation.
- Authoritative fulfilled/reversed evidence integration with real, properly authorized Split 06 fixtures, not only an unknown-UUID rejection test.
- Simultaneous 11th settlement across multiple branches, rollback/replay/race, 14-day hold, double-award prevention, business isolation.
- Explicit separation from billing/Stripe and historical enrollment backfill.

**Current state:** proposal and pure UTC eligibility utilities only. No production economic activation authority.
