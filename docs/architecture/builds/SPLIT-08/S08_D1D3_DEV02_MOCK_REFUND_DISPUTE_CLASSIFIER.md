# S08-D1D3-DEV-02 — Mock refund and payment-dispute classifier (development record)

**Status: DEVELOPMENT ONLY, INERT. Pure function plus unit tests. No caller, route, queue, cron, database, migration, Stripe read or write, ledger, consumption, compensator or reservation change. Financial activation: NO-GO.**
Implements [the refund/dispute classifier specification](S08_D1D3_REFUND_DISPUTE_CLASSIFIER_SPEC.md) under owner decision [S08-D1D3/1](OWNER_DECISION_S08_D1_D3_ECONOMIC_AND_SETTLEMENT_2026-11-04.md) (D3-g). Baseline `main` `deeb063` (DEV-01, #220). It is an evidence statement only; it is **not connected** to the R10 unwind routine, the compensator, D4 consumption or any release path, and creates no recovery obligation.

## Files
- `apps/api/src/billing/refund-dispute.classifier.ts` — `classifyRefundDispute(context, evidence)`.
- `apps/api/src/billing/refund-dispute.classifier.test.ts` — 55 tests (the 40 required scenarios, adversarial, seeded randomized properties).
- `apps/api/src/billing/settlement-eligibility.classifier.ts` — **additive change only**: seven existing DEV-01 trust helpers gained the `export` keyword (`isInt`, `isNonNegInt`, `isStr`, `SAFE_REF`, `safeRef`, `DIGEST`, `assertsAuthority`) so DEV-02 reuses the authority-assertion scan and safe-reference rules instead of duplicating them. No logic changed; the DEV-01 tests pass unmodified.

## Contract
- **Trusted context**: injected clock, policy version, freshness window, and the expected business, invoice, payment, currency, provider account, provider mode and (informational) consumption time, all from configuration and persisted records, never from the evidence.
- **Evidence**: provenance (literal `MOCK_SYNTHETIC` kind, literal `independent_read` origin, snapshot ref and digest, observation time, provider outcome, completeness, two bracketing read fingerprints), tenant binding, provider account and mode, the payment (ref, invoice, currency, paid amount), the refund list (id, tenant, invoice, payment, currency, amount, finality, finalization time) and the dispute list (the same plus outcome, closing time and the provider-stated overlap with refunds).
- **Result**: class, ordered reason codes, advisories, safe evidence references, the evaluated identity (the trusted expected values, never the response), verified amounts (`paidMinor`, `lossMinor`, `extent`), `relativeToConsumption`, outstanding uncertainties, `manualReviewRequired`, `requiresReconciliation`, `mayQualifyForFutureRecoveryReview`, policy version, injected-clock timestamp and `grantsFinancialAuthority: false`. `mayQualifyForFutureRecoveryReview` is the D3-g statement that a full refund or fully lost dispute *may* qualify for a future, separately authorized process; it is an evidence statement, not an instruction, permission or authorization. No other authority, reversal, release or obligation field exists.

## Behavior (nine classes, fixed precedence)
1. `PROVIDER_UNREACHABLE`: provider outcome not ok; tenant, account, mode, snapshot-level invoice or payment mismatch; policy version missing or different; incomplete lists; freshness window absent, stale or future evidence; and every structurally invalid, missing, non-mock, non-independent or authority-asserting input. Nothing can be concluded.
2. `CONTRADICTORY_EVIDENCE`: unstable bracketing reads, currency mismatch, a record naming another invoice or payment, zero/negative amounts, amounts above the payment, the same id with different content, several disputes on one payment, a refund and lost dispute with unknown or inconsistent overlap, and combined loss above the payment.
3. `DISPUTE_OPEN`: an open dispute, or one with an unknown outcome (never a final loss).
4. `REFUND_PENDING`: any refund that is not a final success (pending, requires action, failed, canceled, unknown finality).
5. Verified final loss: `FULL_REFUND_VERIFIED`, `PARTIAL_REFUND_VERIFIED`, or `DISPUTE_LOST_VERIFIED` (extent full or partial) whenever a lost dispute is part of the loss, so it is never disguised as a refund.
6. `DISPUTE_WON_VERIFIED`: a won dispute with no loss; it does not itself reverse consumption.
7. `NO_REFUND`: complete, stable, fresh evidence showing no refund and no dispute.

Conservation: each refund id and each dispute id is counted once; identical repeats are an advisory, conflicting repeats are contradictory; losses are integer minor units; a refund and a lost dispute are summed only when the provider states they are different losses, counted once when the provider states they are the same loss with equal amounts, and are **never summed on unknown overlap**.

## Mapping decisions where the nine classes had no tenth (design choices to confirm, not owner decisions)
- Unverifiable, structurally invalid or untrusted evidence is `PROVIDER_UNREACHABLE`; evidence that parses but disagrees is `CONTRADICTORY_EVIDENCE`.
- Stale or future-dated evidence is `PROVIDER_UNREACHABLE` (current state cannot be asserted); the freshness window has no default (OQ-7), so without it no verified class is ever returned.
- A failed or canceled refund is `REFUND_PENDING` with `REFUND_NOT_SUCCEEDED` (the specification's provisional rule); more than one dispute on a payment is contradictory.

## New open question
**OQ-16:** how a refund and a lost dispute on one payment overlap, and how several disputes on one payment combine, is not established by the specification. The classifier fails closed (`LOSS_OVERLAP_UNDEFINED`, `MULTIPLE_DISPUTES_UNDEFINED`) and accepts a loss overlap only when the provider states it. Whether Stripe can state it is part of OQ-1.

## Acceptance-matrix coverage (the 24 refund/dispute rows)
**Covered (20):** D-N1, D-N2, D-N3, D-N4, D-N5, D-G1, D-G2, D-G3, D-G4, D-G5, D-G6, D-G7, D-G9, D-R1, D-R2, D-T1, D-M1, D-C1, D-A1, D-A2 (isolation by construction: the only import is the DEV-01 trust helpers).
**Partially covered (2):** D-G8 (a record naming another invoice is covered; the evidence model has no customer field, so a record naming another customer is not modelled); D-A3 (the result grants no authority and carries no instruction; the accounting authority's refusal to reverse from a classification belongs to the not-yet-built authorization record).
**Not covered (2), because there is no reversal wiring in this block:** D-R3 (full refund after a settlement reversal already unwound the credit), D-C2 (a full refund racing a settlement reversal and a revocation).

## PIC/1 scenarios touched
Covered at classifier level: wrong account or mode, cross-business substitution, incorrect invoice or currency, partial pagination (incomplete lists), unknown provider outcome and provider rate limitation (never a verified class), and recovery after process crash (deterministic, idempotent replay; no persistence). Partial: duplicate provider effect (duplicate refund/dispute events are analogous, not the benefit-line effect). Not covered here: reversal during application, concurrent final settlement, reservation expiry, multiple credits on one invoice (settlement or accounting concerns). All PIC/1 scenarios remain NOT CERTIFIED.

## Not done (separate blocks)
Refund-triggered reversal and the new unwind cause (OQ-12); the consumption settlement gate; verifier expansion and any Stripe read (OQ-9); snapshot persistence; reservation release (R10 Block 2); any migration. The classifier is not integrated with the settlement classifier's output either: a future block must tie `paidMinor` here to the settled amount there.

## Remediation 01
**F-2:** `provenance.complete`, `refunds.complete` and `disputes.complete` must each be exactly `true`; any other value (`"false"`, `1`, `{}`) is treated as incomplete (`PROVIDER_UNREACHABLE`, `INCOMPLETE_EVIDENCE`) and can never yield `NO_REFUND` or any verified class. Covered by an independent test per field.
