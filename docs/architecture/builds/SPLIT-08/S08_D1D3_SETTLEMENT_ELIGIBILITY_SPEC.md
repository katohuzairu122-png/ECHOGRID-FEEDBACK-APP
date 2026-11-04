# S08-D1D3 — Settlement eligibility specification (design only)

**Status: DESIGN ONLY. No code, schema, migration, provider call or ledger write is introduced or authorized. Financial activation: NO-GO.**
Baseline: `main` at `ae9740478c48075f2b5f65f1c33106e8b4fe82b2`.
Decision source: owner decision `S08-D1D3/1` is **PROPOSED, not merged policy**: it lives in draft PR #218 (head `ea7fdc77db13204128d4c25e6de6727f20a9546a`) and is not on `main`. Every rule below that cites D1-a to D3-g is a design proposal conditional on #218 being merged; if #218 changes, this specification must be revised. Companion documents: [refund/dispute classifier](S08_D1D3_REFUND_DISPUTE_CLASSIFIER_SPEC.md), [evidence and trust boundaries](S08_D1D3_EVIDENCE_AND_TRUST_BOUNDARIES.md), [acceptance matrix](S08_D1D3_ACCEPTANCE_MATRIX.md).

This is a design review against the repository, not executable integration certification. Nothing here has been run against Stripe, test mode or otherwise.

## 1. Purpose and scope

Define a deterministic, fail-closed **settlement eligibility classifier**: from independently verified provider evidence about one invoice and one frozen Partner Credit application, it answers only "what do these verified facts mean for final consumption of this credit?". It is pure: no I/O, no clock, no randomness beyond its inputs.

It does **not** consume credit, release a reservation, write a ledger entry, create a recovery obligation, call Stripe or authorize anything. See section 8 and the three-authority model in the trust-boundaries document.

Out of scope here: refunds and payment disputes (separate classifier), the provider write adapter, the release path, partial-refund policy, tax approval.

## 2. Outputs

```
SettlementVerdict = 'ELIGIBLE' | 'INELIGIBLE' | 'UNRESOLVED'
SettlementClassification = {
  verdict, reasonCodes[]            // ordered, machine codes, never free text from the provider
  snapshotDigest, classifierVersion // binds the verdict to the exact evidence and rule set
  frozenAllocationDigest, policyVersion
  manualReviewRequired: boolean
  heldReservation: true             // always true: the classifier never releases
}
```

The verdict is evidence about meaning. It has no financial effect by itself.

### 2.1 When a result is INELIGIBLE and when it is UNRESOLVED

Design principle (fail closed, no guessing):

- **INELIGIBLE** only when verified, complete, mutually consistent evidence shows a **conclusive contrary fact** for *this* invoice and application (for example the invoice is verified `void`; verified `uncollectible`; verified paid out of band; verified zero pre-benefit amount).
- **UNRESOLVED** whenever the facts are missing, incomplete, stale, unreachable, unstable, contradictory, not yet final, about the wrong scope, or when a policy question is open. Nothing is concluded; the reservation stays held and the obligation stays pending.
- **ELIGIBLE** only when every mandatory condition in section 3 is proven by verified evidence and no contrary evidence exists.

INELIGIBLE is **as of the snapshot**, not a permanent state: a later complete verified snapshot may classify differently (for example an uncollectible invoice later verified paid). Verdicts are never edited; a new snapshot produces a new classification row.

A missing or conflicting fact never produces ELIGIBLE, and never produces INELIGIBLE unless the contrary fact itself is verified. Wrong provider account or mode is UNRESOLVED (it is evidence about some other object and says nothing about this invoice) with mandatory manual review, because it indicates misconfiguration rather than a customer outcome. *This classification choice is a design proposal, not an owner decision.*

## 3. Mandatory conditions for ELIGIBLE

All must hold, each proven by the evidence snapshot (never by a webhook body, callback or client value):

| ID | Condition |
| --- | --- |
| C1 | Provider identity verified: account id equals the expected account, read through an approved verifier path. |
| C2 | Mode verified: `livemode` equals the environment's single configured mode (D1-c). The expected mode comes from configuration, never from the response. |
| C3 | Invoice binding: invoice id, customer and subscription equal the identity frozen in the persisted intent; currency equals the frozen currency. |
| C4 | Reservation binding: the authorized intent, reservation, business and decision match the tenant-checked records; the frozen allocation (`S08-AGG-ROUND/1`) exists for this invoice and reservation. |
| C5 | Benefit line verified: exactly one negative Invoice Item for this reservation exists on this invoice; its generated invoice line is correlated through provider-reported parent identity (not metadata alone); amount equals the frozen per-reservation amount exactly; currency matches; the item is non-discountable; no second effect for this reservation and no reuse of this effect by another reservation. |
| C6 | Invoice status is `paid`. |
| C7 | `amount_remaining` equals 0 (and amount due, paid and total are mutually consistent; section 5). |
| C8 | Valid settlement evidence: settlement came through Stripe (not out of band, D3-d) and the settlement facts the owner approves (D3-a) are present and consistent. |
| C9 | No contradictory evidence: no void, uncollectible-after-paid, cancellation, refund (any extent), pending refund or open/lost dispute on the settling payment (the refund/dispute classifier must report `NO_REFUND`, or `DISPUTE_WON_VERIFIED` with no other loss). |
| C10 | Evidence is complete (all pages read, no cap hit) and stable (bracketed read equal, section 6.2) and fresh (section 6.1). |
| C11 | Accounting prerequisites are *known to be checkable*: the classifier records the facts the accounting authority needs (settlement `fulfilled`, reservation state and expiry, frozen allocation, dispute-hold state); it does not evaluate or grant them. |
| C12 | Pre-benefit value was positive when the invoice total is zero (D3-b). |

## 4. D1 benefit economics (preserved, not extended)

Recorded as proposed in #218 and preserved without addition:

- **Instrument (S08-INSTRUMENT/1, approved for development):** one negative Invoice Item per reservation, explicitly attached to the draft invoice named by the persisted intent, with idempotency key `benefit-apply:v1:<reservationId>`. No pending item for a future invoice, no other invoice, no subscription change.
- **D1-a (proposed):** the item is treated as reducing the taxable base **for development simulation only**. No live-tax approval; jurisdiction-specific adviser confirmation required before any live use. The classifier verifies amounts, never tax outcomes; it must not infer tax compliance from Stripe defaults.
- **D1-b (proposed):** the eligible base is after existing invoice discounts; the benefit item is non-discountable; the invoice total can never be negative. The classifier verifies the proven benefit line does not exceed the frozen amount and that the observed invoice total is not negative.
- **D1-c (proposed):** policy `PC-BENEFIT/1`, immutable after certification, prospective from the recorded approval date (proposed 2026-11-04), one verified Stripe mode per environment. The classifier takes `policyVersion` from the frozen allocation and refuses a snapshot whose policy version differs.
- **D2:** `S08-AGG-ROUND/1`. **No recomputation after the allocation freeze.** The classifier compares provider evidence to the frozen artifact; it never recalculates a benefit.

**Unresolved provider/tax behavior (not assumed):** how Stripe computes tax on a negative Invoice Item, how it interacts with existing discounts and tax inclusivity, and whether a non-discountable negative item keeps the total non-negative in every case are unverified for API version `2026-05-27.dahlia`. The specification requires these to be proven in a separately authorized test-mode run before any implementation claims compliance. Stripe defaults do not establish policy compliance.

## 5. Settlement facts required from the provider (provisional field mapping)

The repository's read path today retrieves only: invoice `id`, `livemode`, customer, subscription, `currency`, `status`, `amount_remaining`, and invoice line `id`/`amount`/`currency`/`metadata`. The classifier needs strictly more, all **read-only**:

| Fact | Used for | Note |
| --- | --- | --- |
| status, amount due, amount paid, amount remaining, subtotal/total | C6, C7, C12, consistency | consistency rule: `amount_paid + amount_remaining` and totals reconcile with lines; else UNRESOLVED (`AMOUNTS_INCONSISTENT`) |
| status transitions (finalized, paid, voided, marked uncollectible times) | ordering, freshness, contradictions | exact field names: to verify |
| discounts applied | D1-b base | to verify |
| invoice lines with parent identity (item to line correlation), proration flag, pagination completeness | C5, D3-e | metadata alone is insufficient |
| the settling payment identity (charge or payment intent) and whether settlement was out of band | C8, D3-d | **the field that distinguishes out-of-band settlement in API `2026-05-27.dahlia` is not known to this design and must be established in test mode** |

All Stripe field names and enumerations in this document are provisional. Where this design needs a fact but does not know how Stripe exposes it, it says so; it never assumes.

## 6. Freshness, stability and replay

### 6.1 Freshness
A classification is a snapshot judgement. Accounting must not rely on it unless the evidence snapshot is no older than a freshness window `F` and no newer snapshot with a different verdict exists. `F` is a parameter. **Proposal for owner/operations: 15 minutes for ELIGIBLE; the value is not decided.** UNRESOLVED and INELIGIBLE verdicts never expire into ELIGIBLE; only a new verified snapshot can change the verdict.

### 6.2 Bracketed read
One coherent snapshot is: read the invoice, read the complete line list, read the invoice again. The two invoice reads must be equal on status, amounts, status-transition times and line count/ids. If they differ, the verdict is UNRESOLVED (`EVIDENCE_UNSTABLE`) and the snapshot is stored as such.

### 6.3 Replay
The snapshot digest is computed over a canonical, minimal projection of the verified evidence (no secrets, no raw provider payload). Re-processing the same evidence yields the same digest and the same classification and writes nothing new (idempotent). A different digest for the same invoice is a new observation, not a replacement; earlier snapshots are never edited.

## 7. Classification matrix (D3 cases)

Legend. **Consume**: whether this verdict can *support* a consumption decision (accounting authority still decides). **Reservation** is always held by the classifier. **Release**: the classifier never authorizes release; "candidate" means the situation is one where a release could later be considered, which still needs release authority that does not exist (`SPLIT08_RELEASE_AUTHORITY_NOT_ESTABLISHED`, R10 Block 2). **Recovery**: "proposed" means a recommendation only; "existing path" means the already-approved consumed-credit reversal could be invoked by a separately authorized future execution. **Manual** is whether human review is mandatory.

| # | Scenario | Authoritative evidence required | Class | Consume | Reservation | Release | Recovery | Manual |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Fully paid invoice with verified benefit | all of C1 to C12 | ELIGIBLE | supported | held until accounting acts | no | none | no |
| 2 | Zero-total invoice, positive pre-benefit value | C1 to C5, status `paid`, remaining 0, total 0, frozen allocation proves pre-benefit base was positive (D3-b) | ELIGIBLE if every other condition holds | supported | held | no | none | no |
| 2b | Zero-total invoice, pre-benefit value zero | same evidence shows no positive pre-benefit amount | INELIGIBLE (`NO_ECONOMIC_BENEFIT`) | no | held | candidate | none | yes |
| 3 | Partially paid | status not `paid` or remaining above 0; amounts consistent | UNRESOLVED (`PARTIAL_PAYMENT`) | no (D3-c) | held | no | none | no unless unchanged beyond threshold (open) |
| 4 | Paid outside Stripe | positive evidence of out-of-band settlement | INELIGIBLE (`OUT_OF_BAND`, D3-d) | no | held | candidate | none | **yes** (any exception is a separate owner decision) |
| 4b | Settlement mode cannot be established | field absent or ambiguous | UNRESOLVED (`SETTLEMENT_SOURCE_UNKNOWN`) | no | held | no | none | yes |
| 5 | Annual subscription invoice | the same invoice-level evidence | classified like the matching case above; **interval eligibility is decided at intent/allocation time** (calculator default: month only, owner-unspecified) and is not re-evaluated here | per matching case | held | no | none | no |
| 6 | Prorated lines | frozen base excludes proration (D3-e); live invoice non-benefit lines equal the frozen base evidence | equal: classify normally; **differs after freeze: UNRESOLVED (`EVIDENCE_DRIFT`)** (no recomputation) | no when drifted | held | no | none | yes when drifted |
| 7 | Void before settlement | verified status `void` with transition time | INELIGIBLE (`INVOICE_VOID`) | no | held | candidate | none; preserve any provider effect evidence | yes if a benefit effect exists |
| 8 | Uncollectible | verified status `uncollectible` (non-terminal: Stripe may allow later payment, to verify) | INELIGIBLE (`INVOICE_UNCOLLECTIBLE`) for now; a later verified `paid` snapshot may classify ELIGIBLE | no | held | candidate, review first | none | **yes** before any release |
| 9 | Cancellation before payment | invoice evidence decides: subscription cancellation alone does not change the invoice | invoice still open: UNRESOLVED (`NOT_SETTLED`); invoice verified void/uncollectible: cases 7/8 | no | held | no unless 7/8 | none | yes |
| 10 | Provider temporarily unreachable | classified provider error (retryable, rate limited) | UNRESOLVED (`PROVIDER_UNREACHABLE`) | no | held | no | none | no (retry with existing backoff); persistent threshold open |
| 11 | Account, mode or identity mismatch | verified scope mismatch reason (`ACCOUNT_MISMATCH`, `LIVEMODE_MISMATCH`, customer, subscription, invoice id, currency) | UNRESOLVED (`SCOPE_MISMATCH`) | no | held | no | none | **yes** |
| 12 | Benefit-line attribution mismatch | wrong amount, currency, invoice, missing item to line correlation, metadata-only match | UNRESOLVED (`ATTRIBUTION_MISMATCH`), saga outcome `disputed` | no | held | no | none | **yes** |
| 13 | Duplicate or replayed observation | same snapshot digest | same classification, no new decision row | unchanged | held | no | none | no |
| 14 | Evidence changes during reconciliation | bracketed reads differ | UNRESOLVED (`EVIDENCE_UNSTABLE`) | no | held | no | none | no (re-observe); repeated instability: yes |
| 15 | Settlement after reservation expiry | paid evidence plus reservation expiry earlier than settlement | UNRESOLVED (`SETTLED_AFTER_EXPIRY`) | no | held | no | none | **yes**; PIC/1 requires an owner decision where frozen rules do not determine the outcome (OQ-3) |
| 16 | Full refund after consumption | refund classifier `FULL_REFUND_VERIFIED` | settlement verdict at consumption time is historical and never rewritten; the refund is a new fact | already consumed, no re-consume | consumed | not applicable | **existing path** may be invoked by separately authorized future execution (D3-g), never by this classifier | per accounting policy (OQ-4) |
| 16b | Full refund **before** consumption | same, credit not yet consumed | INELIGIBLE (`REFUNDED`) | no | held | candidate | none | yes |
| 17 | Partial refund after consumption | `PARTIAL_REFUND_VERIFIED` | no settlement change | already consumed | consumed | no | **none** (hold for reconciliation; no automatic restoration, reversal or adjustment; separate owner policy required) | **yes** |
| 18 | Lost payment dispute | `DISPUTE_LOST_VERIFIED`, extent full | as case 16 | as 16 | as 16 | no | existing path (D3-g); a partially lost dispute is held (case 17) | per accounting policy; partial: yes |
| 19 | Open payment dispute | `DISPUTE_OPEN` | UNRESOLVED (`DISPUTE_OPEN`) if before consumption; after consumption: no action, watch | no | held | no | none | yes |
| 20 | Contradictory provider evidence | any two verified facts that cannot both be true | UNRESOLVED (`CONTRADICTORY_EVIDENCE`) | no | held | no | none | **yes** |

## 8. Authority boundary

The classifier is the **classification authority** only. A verdict ELIGIBLE does not consume a credit; the **accounting authority** (the existing transactional consumption under its frozen lock order, plus any future authorization record) decides whether a transition is permitted; the **execution authority** performs it. The allocation freeze keeps `providerVerified` and `consumptionAuthorized` as the literal `false`; the classifier must not set them. See the trust-boundaries document.

## 9. Open questions

Not decided here; see the acceptance matrix, section "Open owner questions".
