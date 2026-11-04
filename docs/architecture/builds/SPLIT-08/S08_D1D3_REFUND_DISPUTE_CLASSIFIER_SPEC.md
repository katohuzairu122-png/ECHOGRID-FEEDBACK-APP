# S08-D1D3 — Refund and payment-dispute classifier specification (design only)

**Status: DESIGN ONLY. No code, schema, migration, provider call or ledger write is introduced or authorized. Financial activation: NO-GO.**
Baseline: `main` at `f02be05`, which differs from the originally reviewed `ae9740478c48075f2b5f65f1c33106e8b4fe82b2` only by the added decision record. Decision source: owner decision [S08-D1D3/1](OWNER_DECISION_S08_D1_D3_ECONOMIC_AND_SETTLEMENT_2026-11-04.md), **merged to `main`** by PR #218 (merge commit `f02be05`); it authorizes architecture specifications and mock-provider development only, not implementation or any provider write. Companions: [settlement eligibility](S08_D1D3_SETTLEMENT_ELIGIBILITY_SPEC.md), [evidence and trust boundaries](S08_D1D3_EVIDENCE_AND_TRUST_BOUNDARIES.md), [acceptance matrix](S08_D1D3_ACCEPTANCE_MATRIX.md). A design review is not executable integration certification.

## 1. Naming: "dispute" here is a Stripe payment dispute

In this repository "dispute" already names the **frozen Split 07 award-dispute hold** (`partner_credit_dispute*`, `hasActiveDisputeHold`, resolve-once rows). That architecture is frozen and is **not touched** by this design. This document concerns **Stripe payment disputes** (chargebacks) only. The two must never share tables, codes or code paths. All codes here use the prefix `PAYMENT_DISPUTE_` or the class names below.

## 2. Purpose

An **evidence-only** classifier. From independently verified provider evidence about the payment(s) that settled one invoice, it names what the refunds and disputes mean. It grants no financial authority and calls nothing. In this block it is **not connected to the compensator** or to any ledger path.

## 3. Output

```
RefundDisputeClass =
  'NO_REFUND' | 'FULL_REFUND_VERIFIED' | 'PARTIAL_REFUND_VERIFIED' | 'REFUND_PENDING'
| 'DISPUTE_OPEN' | 'DISPUTE_LOST_VERIFIED' | 'DISPUTE_WON_VERIFIED'
| 'CONTRADICTORY_EVIDENCE' | 'PROVIDER_UNREACHABLE'
RefundDisputeClassification = {
  class, extent: 'none'|'partial'|'full',      // for loss-bearing classes; DISPUTE_LOST_VERIFIED with extent partial is treated exactly like a partial refund
  lostMinor, paidMinor, currency,              // verified amounts; lostMinor = settled refunds + lost disputes, never double counted
  relativeToConsumption: 'before'|'after'|'unknown',
  reasonCodes[], snapshotDigest, classifierVersion,
  manualReviewRequired: boolean
}
```

## 4. Inputs (all from an approved read-only independent verification, never from a webhook body)

Invoice identity (id, customer, subscription, currency); the settling payment identity (charge or payment intent) obtained from the provider and tied to **this** invoice; the complete list of refunds and disputes for that payment; each refund's id, amount, currency, status; each dispute's id, amount, currency, status; invoice amount paid; account id and mode; completeness flags for every list; observation time. Stripe enumerations below are **provisional** and must be confirmed against API version `2026-05-27.dahlia` in a separately authorized test-mode run.

## 5. Finality definitions (provisional)

- A refund **counts as final** only when its provider status is succeeded. Pending, requires-action, failed and canceled refunds are not final losses. A failed or canceled refund is recorded but never counts; whether a failed refund can later be retried by the provider is **unverified**, so a failed refund keeps the classification from ever being `NO_REFUND` until a later complete snapshot shows the final state (reason `REFUND_NOT_FINAL`).
- A dispute is **lost** only when closed with a lost outcome, **won** only when closed with a won outcome, **open** in every other status (needs response, under review, warning states). Whether warning-only states constitute a dispute is **unverified**; the design treats them as open (fail closed).
- Amounts are integer minor units in the invoice currency. A currency different from the invoice currency is `CONTRADICTORY_EVIDENCE`, never converted.

## 6. Classification rules and precedence

Evaluated in this fixed order; the first rule that applies decides the class. Higher rules dominate lower ones.

| P | Rule | Class |
| --- | --- | --- |
| 1 | Any required read failed, was rate limited, hit a page cap or was truncated, or the account/mode scope could not be verified | `PROVIDER_UNREACHABLE` (reason says which). A wrong account or mode is reported as `PROVIDER_UNREACHABLE` with `SCOPE_MISMATCH` and mandatory manual review. Completeness is a precondition for any "nothing happened" conclusion. |
| 2 | Evidence is internally contradictory: refund or dispute not tied to this invoice's payment; amounts or currency inconsistent; refunded plus lost amount exceeds the paid amount; two different final outcomes for one dispute; bracketed reads differ | `CONTRADICTORY_EVIDENCE` |
| 3 | Any dispute is open | `DISPUTE_OPEN` (it can change the amount at stake, so it dominates refund finality) |
| 4 | Any refund is not final (pending, requires action, failed-but-unresolved) | `REFUND_PENDING` |
| 5 | Final loss exists: `lostMinor` is the sum of final refunds plus lost disputes on the payment, each amount counted once per payment and capped at the payment amount | if `lostMinor >= paidMinor`: `FULL_REFUND_VERIFIED` when the cause is refunds, `DISPUTE_LOST_VERIFIED` (extent full) when a lost dispute is part of it; if `0 < lostMinor < paidMinor`: `PARTIAL_REFUND_VERIFIED` (a partially lost dispute is `DISPUTE_LOST_VERIFIED` with extent partial and behaves identically) |
| 6 | Only won disputes, no loss | `DISPUTE_WON_VERIFIED` (informational; no loss consequence) |
| 7 | Complete, stable reads show no refunds and no disputes | `NO_REFUND` |

Idempotent: the same verified evidence yields the same class and digest. Multiple events for one payment are always evaluated together from one coherent snapshot; the classifier never acts on a single event in isolation.

## 7. Required controls

Exact invoice and payment identity (an event naming another invoice, customer or payment is rejected, not classified); correct account and mode from configuration; verified amounts and currency; refund finality and dispute outcome per section 5; idempotent processing keyed on the snapshot digest; immutable evidence references (rows are append-only, never edited); tenant isolation (every snapshot carries `business_id` and is read only through the tenant-checked intent); independent reconciliation (a webhook is only a **signal to re-read**); no duplicate reversal or recovery obligation (section 9).

## 8. Partial refunds and partially lost disputes

Classification and **reconciliation hold only** (D3-g). The classifier reports `PARTIAL_REFUND_VERIFIED` (or `DISPUTE_LOST_VERIFIED` extent partial) with mandatory manual review. No automatic restoration, consumption reversal or balance adjustment is permitted, designed or proposed. A separate owner-approved partial-refund policy is required before any handling beyond holding (open question OQ-11).

## 9. Future boundary for triggering the consumed-credit reversal (not connected in this block)

D3-g (owner decision, development only): a fully refunded payment or lost dispute **may** initiate the existing consumed-credit reversal and recovery-obligation process after independent verification. This design fixes only the boundary a future, separately authorized block must respect.

**Preconditions (all required, checked by the accounting authority under the existing lock order, not by the classifier):**
1. A stored immutable classification of `FULL_REFUND_VERIFIED` or `DISPUTE_LOST_VERIFIED` with extent full, from a fresh complete snapshot (freshness window per the settlement specification), with no newer snapshot of a different class.
2. The credit is in the state the existing routine handles for an invoice-consumed credit: decision `vested`, lot `consumed` with a consumed reservation bound to **this** invoice, applied terminal application and `consume` ledger entry present.
3. The decision is not already `reversed`. If a settlement reversal or revocation already unwound it, the routine's canonical key `partner-reversal:v1:<settlementRef>` makes the new request `already_reversed`: **no second obligation**; the verified refund evidence is still stored.
4. A separate authorization record exists for this reversal (who authorized, when, evidence snapshot reference). The approver model (number of approvers, roles, any waiting period after a dispute is lost, since reversal is irreversible in the current design) is **not decided** (OQ-4).
5. Execution uses the existing `unwindCredit` routine. **Repository fact:** its `UnwindCause` today has only `settlement_reversal` and `revocation`. A refund or dispute cause does not exist; adding one (with an immutable evidence-snapshot id as the cause reference, so the obligation `reversal_ref` and the ledger metadata join the audit) is a code change for a future authorized block (OQ-12). It is not made here, and the compensator is not connected.
6. The recovery obligation amount is the credit's one consumed unit, independent of the refund fraction (full only).

**Never:** the classifier calling the routine; a webhook triggering it; automatic restoration of balances; release of a reservation; a provider write.

## 10. Before-consumption refunds

A full refund or lost dispute observed **before** the credit is consumed makes the settlement verdict INELIGIBLE (`REFUNDED` / `PAYMENT_DISPUTE_LOST`), the reservation stays held, and no reversal is needed because nothing was consumed. Release remains a candidate only, pending release authority (R10 Block 2).
