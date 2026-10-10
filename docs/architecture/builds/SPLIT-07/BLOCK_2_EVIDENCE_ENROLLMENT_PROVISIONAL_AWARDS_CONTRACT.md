# ECHO GRID — SPLIT 07 BLOCK 2 GATED IMPLEMENTATION CONTRACT

**Status:** PREPARED; NOT AUTHORIZED TO ACTIVATE — Block 1 completion lock required
**Frozen reference:** `ECHO_GRID_SPLIT_07_PARTNER_LAYER_CREDITS_v1.0.md`
**Boundary:** Verified fulfillment evidence, explicit Partner enrollment, deterministic provisional-award evaluation only.

## Hard entry gate
No verified Block 1 completion-lock report is present on authoritative `main` at preparation time. A prior PR workflow succeeded after migration correction, but this is not full independent confirmation of real PostgreSQL append-only/permission/projection integrity. **Do not implement or enable monetary-like economic mutation until Block 1 lock is explicit.**

## Block 2 responsibilities
1. Consume `OrphanSettlementCompletionEvidence v1` by stable `settlementRef`; the untrusted request/queue payload must never itself authorize credit. Re-resolve settlement, claim and canonical `settlement_fulfilled` history transactionally and fail closed if a reversal exists or state is inconsistent.
2. Platform-controlled Partner enrollment: business acceptance of program terms, active/suspended/left state, exact business identity, actor and audit attribution. Explicitly reject retroactive award eligibility and self/origin business settlement.
3. Versioned, immutable `PC-ECON/1` policy decision: exactly 1 noncash Partner Credit per qualifying fulfilled settlement, no more than 10 awarded per receiving business per UTC calendar month **across every branch**. A `cap_exceeded` decision must never create an earning lot or credit. Snapshot policy and source fields.
4. Enforce one eligibility decision per `settlementRef` and exact idempotent replay; conflicting replay fails. Concurrency must serialize per business earning-month, including when its first account/decision does not yet exist. No scan-then-insert race.
5. Where permitted by the Block 1 completion lock, create provisional lot and append-only earning history together with account projection in a single PostgreSQL transaction. Hold for 14 complete days from fulfillment, never earlier than the decision instant. **Do not vest, spend, redeem, invoice-offset, or call Stripe in Block 2.**
6. On a reversal racing an award, the reversal wins eligibility unless the award has already atomically committed; any already committed provisional award must be handled by the separate compensating-reversal block, with fail-closed provisional availability until resolved.
7. Authorization: business actors cannot mint; customer QR and business QR carry no economic truth; platform evaluation is internal service only until an explicit admin/evidence-driven activation gate. Platform impersonation barred.

## Existing schema compatibility questions to resolve first
- `partner_program_enrollments` requires acceptedAt/effectiveAt and actor semantics for active participation, no silent pre-enrollment backfill.
- `partner_credit_award_decisions` unique settlement reference and business/month index do **not alone** enforce a 10-credit cap; require transaction-level locking or dedicated counter with fresh database integration tests.
- Partner Credit ledger update/delete denial trigger does not by itself enforce full account/lot reconciliation or prohibit direct SQL inserts. Use restricted DB writer privileges and invariants after Block 1 hardening.
- Freeze policy immutability must be enforced before policy activation; receipt of completion evidence does not change the settlement domain.
- Reversal after award must preserve append-only history. The later compensation block owns recovery; do not invent preemptive cash debt here.

## Mandatory tests for separate future implementation PR
- Valid fulfillment + enrolled partner + active PC-ECON/1 → one provisional unit, precise snapshot and 14-day vestAt.
- Reversed, stale, mismatched, incomplete, wrong-business, archived-source-ineligible or unverified fulfillment → no credit.
- Pre-enrollment historic settlement → no credit, no backfill.
- Replay same settlement/key → no duplicate; conflicting key → conflict.
- 11th concurrent award across branches in same UTC month → zero additional credit; month boundary UTC; denied awards do not roll forward.
- Reversal/award race serializable; rollback leaves no projection/orphan lot.
- Business staff/customer/impersonation cannot issue; no cross-tenant reads.
- No changes to loyalty, Community Points, orphan-settlement history, subscription plans/subscriptions or Stripe.
- Full Drizzle zero-drift, fresh PostgreSQL migration replay, integration, typecheck, unit, security, production build, browser and CI green on exact implementation head.

## Exit gate
Block 2 completion requires explicit passing evidence and dedicated merge. Split 08 still owns all subscription credit applications, invoices and Stripe mutations.
