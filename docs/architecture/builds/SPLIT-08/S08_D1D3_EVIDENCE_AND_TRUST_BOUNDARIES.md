# S08-D1D3 — Evidence provenance, trust boundaries and proposed contracts (design only)

**Status: DESIGN ONLY. No code, schema, migration, provider call or ledger write is introduced or authorized. Financial activation: NO-GO.**
Baseline: `main` at `f02be05`, which differs from the originally reviewed `ae9740478c48075f2b5f65f1c33106e8b4fe82b2` only by the added decision record. Decision source: owner decision [S08-D1D3/1](OWNER_DECISION_S08_D1_D3_ECONOMIC_AND_SETTLEMENT_2026-11-04.md), **merged to `main`** by PR #218 (merge commit `f02be05`); it authorizes architecture specifications and mock-provider development only, not implementation or any provider write. Companions: [settlement eligibility](S08_D1D3_SETTLEMENT_ELIGIBILITY_SPEC.md), [refund/dispute classifier](S08_D1D3_REFUND_DISPUTE_CLASSIFIER_SPEC.md), [acceptance matrix](S08_D1D3_ACCEPTANCE_MATRIX.md). A design review is not executable integration certification.

## 1. The three authorities (kept separate)

| Authority | Question it answers | Who/what | Never does |
| --- | --- | --- | --- |
| **Classification** | What do these verified facts mean? | the pure settlement and refund/dispute classifiers | grant accounting or execution authority; set `providerVerified` or `consumptionAuthorized`; call a provider; write a ledger |
| **Accounting** | Is this financial transition permitted now? | the existing transactional consumption under its frozen lock order (settlement, decision, lot, account, reservation) and any future authorization record | re-interpret provider evidence; accept an unclassified or stale verdict |
| **Execution** | Perform the permitted transition | existing guarded writers (consumption, the shared `unwindCredit` routine); future release executor (R10 Block 2) | act without an accounting-authority decision; act from a webhook |

A verdict is an input to accounting authority, never a substitute. The classifier cannot reach the database writers: it is a pure function and is given no transaction handle.

## 2. Evidence trust tiers

| Tier | Source | May establish |
| --- | --- | --- |
| T0 untrusted | client payloads, browser values, callbacks, caller-supplied tuples | nothing; used only to find which records to look up |
| T1 signal | a signature-verified Stripe webhook body | only "re-read this invoice/payment now". Even a verified webhook is never a settlement or refund fact. (Repository fact: `stripe-webhook.service.ts` handles only `customer.subscription.created`, `.updated` and `.deleted`; invoice, payment-method and dispute events are deliberately unhandled. Whether provider events are separately captured as evidence is governed by the HETA evidence tables and is not relied on here.) |
| T2 independent read | a read-only call through an approved verifier path, scope-verified (account, mode, object ids) | the provider facts used by the classifiers, once stored as a snapshot |
| T3 immutable snapshot | an append-only stored projection of T2 evidence with digest and provenance | the only input a classifier consumes |
| T4 authorization | an accounting-authority decision referencing a T3 snapshot and classification | permission for one financial transition |

Only T3 snapshots feed classifiers; only T4 records permit transitions.

## 3. Provenance record (every snapshot)

Business id; intent, reservation and invoice references; provider account id; mode; pinned API version; read start and completion times; the verifier inventory id and revision that approved the read (S08-STRIPE-PRIVATE-TEST-VERIFIER inventory model); completeness flags (all pages read, no cap hit); bracketed-read equality result; canonical payload digest (SHA-256 over a minimal canonical projection; no secrets, no raw provider payload, no customer personal data); an opaque evidence reference. A snapshot missing any of these cannot be classified ELIGIBLE.

## 4. Tenant, account and mode separation

- Every proposed row carries `business_id`, enforced by composite foreign keys to the intent/reservation of the same business (the repository's existing pattern), so another business's snapshot cannot be attached.
- Account and mode are **configuration**, one verified Stripe mode per environment (owner decision D1-c). The expected values are never taken from the provider response. A test-mode snapshot can never classify a live-mode environment and vice versa; the mismatch is a stored UNRESOLVED snapshot, never silently dropped.
- Classifier inputs are tenant-checked before any provider read: a request naming another business's reservation is rejected before a read is made.

## 5. Proposed future contracts (illustrative; no migration, no code)

Append-only tables, each with the repository's usual update/delete/truncate denial triggers (truncate trigger ENABLE ALWAYS), `business_id` composite foreign keys and unique digests:

- `s08_settlement_evidence_snapshots` — provenance fields above; `UNIQUE (business_id, intent_id, payload_digest)` gives idempotent replay.
- `s08_settlement_classifications` — `snapshot_id`, `classifier_version`, `verdict`, `reason_codes`, `frozen_allocation_digest`, `policy_version`, `manual_review_required`, `classified_at`; `UNIQUE (snapshot_id, classifier_version)`.
- `s08_refund_dispute_snapshots` and `s08_refund_dispute_classifications` — same shape; class, extent, amounts, `relative_to_consumption`.
- A **separate** credit-transition authorization record (accounting authority) is out of scope and undecided (OQ-4); the classification tables must not carry authorization columns.

Pure interfaces (types only): `classifySettlement(snapshot, frozenAllocation, expectedScope) -> SettlementClassification` and `classifyRefundDispute(snapshot, expectedScope, consumptionTime) -> RefundDisputeClassification`. No I/O, no clock argument beyond the snapshot's own observation time.

## 6. Provider read surface (read-only; extension needs approval)

Approved today (private verifier inventory): `GET /v1/account` and `GET /v1/invoices/{id}` only. The classifiers also need the complete invoice line list with parent identity, the settling payment, refunds and disputes for that payment. Each is a read-only call, but **none is currently approved**; extending the approved-method inventory is an independently authenticated control-plane decision (OQ-9). No write method is proposed or permitted anywhere in this design.

## 7. Error and rejection taxonomy

- **Input/tenant** (reject before any read): `INPUT_INVALID`, `TENANT_MISMATCH`, `POLICY_VERSION_MISMATCH`, `ALLOCATION_NOT_FROZEN`.
- **Scope** (existing codes reused): `ACCOUNT_MISMATCH`, `LIVEMODE_MISMATCH`, `INVOICE_ID_MISMATCH`, `CUSTOMER_MISMATCH`, `SUBSCRIPTION_MISMATCH`, `CURRENCY_MISMATCH`, `INVOICE_NOT_FOUND`.
- **Provider** (existing classes reused, redacted to code, type and status): retryable, rate limited (retry-after honoured), permanent.
- **Evidence**: `INCOMPLETE_PAGINATION`, `EVIDENCE_UNSTABLE`, `AMOUNTS_INCONSISTENT`, `ATTRIBUTION_MISMATCH`, `DUPLICATE_EFFECT`, `EVIDENCE_DRIFT`, `SETTLEMENT_SOURCE_UNKNOWN`, `NOT_SETTLED`, `PARTIAL_PAYMENT`, `REFUND_NOT_FINAL`, `CONTRADICTORY_EVIDENCE`.
No taxonomy entry carries provider message text, headers, payloads or credentials.

## 8. Reconciliation lifecycle

`PENDING_OBSERVATION -> OBSERVED (snapshot stored) -> CLASSIFIED (verdict stored)`, then: ELIGIBLE -> `ACCOUNTING_REVIEW` -> `AUTHORIZED` -> `EXECUTED` (the last two belong to accounting and execution authority, not designed here); UNRESOLVED -> `RETRY` (new observation) or `MANUAL_REVIEW`; INELIGIBLE -> `HELD` (release candidate; release needs authority that does not exist). Every transition is a new appended row; none edits a prior one. A webhook only schedules `PENDING_OBSERVATION`.

## 9. Idempotency and concurrency

- Snapshot and classification inserts are idempotent by digest; replays write nothing.
- Classification is pure and takes no locks on credit tables, so it cannot deadlock with the settlement-first consumption order or the saga's reservation-then-intent order.
- At the moment of use, the **accounting transaction** (not the classifier) re-reads the latest classification under its existing locks and requires: verdict ELIGIBLE, snapshot age within the freshness window, and no newer snapshot with a different verdict. This closes the window between classification and consumption without adding a lock.
- Concurrent final settlement remains governed by the existing unique constraints and lock order (at most one terminal application and consumption).
- A reversal triggered by a future refund path shares the canonical key `partner-reversal:v1:<settlementRef>` with settlement reversal and revocation, so racing causes yield exactly one financial consequence.

## 10. Audit and operator visibility

A read-only operator view lists UNRESOLVED and INELIGIBLE items with reason codes, snapshot age, manual-review flag and the digest, redacted as above, scoped per business. Operators cannot edit or override a classification; the only way to change an outcome is a new verified snapshot, or a decision by the accounting authority.

## 11. Repository review findings (read-only review of this design against `main`)

| ID | Finding | Effect on this design |
| --- | --- | --- |
| R-1 | The pure benefit calculator denies `INVOICE_NOT_PAID` when the invoice is not paid or paid below due. That predates the draft-invoice timing decision (benefit applied to a draft invoice, consumption after settlement). | Two phases must be distinguished: computing the benefit on a draft/open invoice, and settlement before consumption. Whether the calculator's gate must change is OQ-13; this design neither changes nor relies on it. |
| R-2 | The calculator's default `eligibleIntervals` is month only, flagged owner-unspecified. | Annual-invoice eligibility is undecided (OQ-5); the settlement classifier does not re-evaluate it. |
| R-3 | `PartnerCreditStripeInvoiceAuthorityAdapter` requires `livemode === true`. | Incompatible with one verified mode per environment (including test mode). Expected mode must be configuration; a future change is required and is not made here. |
| R-4 | No consumption-path code checks invoice `paid` or `amount_remaining`; consumption requires the saga's confirmed effect, a terminal application and a `fulfilled` orphan settlement. | D3-a (invoice settlement) is a **new gate** for a future block; today a confirmed effect on a draft invoice can reach consumption without invoice payment evidence. This is the largest functional gap. |
| R-5 | The provider read path exposes only status, `amount_remaining`, livemode, customer, subscription, currency and line id/amount/currency/metadata. | Extending the read interface (read-only) is required (section 6). |
| R-6 | The private verifier approves only account and single-invoice reads. | Refund, dispute, payment and line-list reads need approval (OQ-9). |
| R-7 | The allocation freeze stores `providerVerified` and `consumptionAuthorized` as literal `false`. | The classifier must not set them; a verdict and an authorization remain separate records. |
| R-8 | `UnwindCause` has no refund or dispute cause. | A third cause is a future code change with an immutable evidence-snapshot reference (OQ-12). |
| R-9 | "Dispute" collides with the frozen S07 award-dispute hold. | Distinct naming and code paths mandated (refund/dispute spec, section 1). |
| R-10 | The pinned Stripe API version is `2026-05-27.dahlia`; this design does not know that version's field shapes for payments, out-of-band settlement, refunds or disputes. | Every Stripe field name here is provisional; test-mode proof is required before implementation (OQ-1). |
| R-11 | The existing saga/reconciliation outcomes (`confirmed`, `rejected`, `disputed`, `unresolved`) and observation classes already hold on unattributed, mismatched, duplicate and unreachable evidence. | The classifiers' UNRESOLVED reasons align with, and never weaken, these holds. |

**Checks performed (design vs repository):** no conflict found with D1/D2/D3/D4 as recorded; no change to tax policy (the design preserves D1-a as development simulation only); no release authority introduced (release is only ever a candidate, blocked on R10 Block 2); no provider write path; no financial execution or ledger change; no duplicate recovery mechanism (the existing routine and canonical key are reused, a new cause is only identified as future work); Stripe behavior is **not** assumed where unknown (R-10). These are document-level checks, not executed integration tests.
