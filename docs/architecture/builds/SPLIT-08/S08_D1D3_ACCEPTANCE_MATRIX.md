# S08-D1D3 — Acceptance matrix and open questions (design only)

**Status: DESIGN ONLY. These are required future acceptance scenarios; none has been run. Nothing is certified. Financial activation: NO-GO.**
Baseline: `main` at `f02be05`, which differs from the originally reviewed `ae9740478c48075f2b5f65f1c33106e8b4fe82b2` only by the added decision record. Decision source: owner decision [S08-D1D3/1](OWNER_DECISION_S08_D1_D3_ECONOMIC_AND_SETTLEMENT_2026-11-04.md), **merged to `main`** by PR #218 (merge commit `f02be05`); it authorizes architecture specifications and mock-provider development only, not implementation or any provider write. Companions: [settlement eligibility](S08_D1D3_SETTLEMENT_ELIGIBILITY_SPEC.md), [refund/dispute classifier](S08_D1D3_REFUND_DISPUTE_CLASSIFIER_SPEC.md), [evidence and trust boundaries](S08_D1D3_EVIDENCE_AND_TRUST_BOUNDARIES.md).

All scenarios run **only** on a mock provider and a disposable database until a separate owner authorization says otherwise. "Expected" is the required design behavior, not an observed result. Every scenario also asserts: the reservation is not released, no ledger/lot/account row changes, and no provider call is made by the classifier.

## 1. Settlement classifier

| ID | Kind | Scenario | Expected |
| --- | --- | --- | --- |
| S-N1 | normal | Paid invoice, remaining 0, verified benefit line equal to the frozen amount, correct account/mode, no refund | ELIGIBLE |
| S-N2 | normal | Zero-total invoice, frozen base proves positive pre-benefit amount | ELIGIBLE |
| S-N3 | normal | Two reservations on one invoice, each line equals its frozen share, aggregate within the frozen cap | ELIGIBLE |
| S-G1 | negative | Pre-benefit amount zero, total zero | INELIGIBLE `NO_ECONOMIC_BENEFIT` |
| S-G2 | negative | Status `open`/`draft` | UNRESOLVED `NOT_SETTLED` |
| S-G3 | negative | Partial payment (remaining above 0) | UNRESOLVED `PARTIAL_PAYMENT` |
| S-G4 | negative | Verified out-of-band settlement | INELIGIBLE `OUT_OF_BAND`, manual review |
| S-G5 | negative | Settlement source cannot be determined | UNRESOLVED `SETTLEMENT_SOURCE_UNKNOWN` |
| S-G6 | negative | Status `void` | INELIGIBLE `INVOICE_VOID` |
| S-G7 | negative | Status `uncollectible` | INELIGIBLE `INVOICE_UNCOLLECTIBLE`, manual review before any release |
| S-G8 | negative | Benefit line amount differs from frozen amount by one minor unit (above and below) | UNRESOLVED `ATTRIBUTION_MISMATCH` |
| S-G9 | negative | Benefit line matched by metadata only, no item-to-line parent correlation | UNRESOLVED `ATTRIBUTION_MISMATCH` |
| S-G10 | negative | Second effect for the same reservation; one effect reused for another reservation | UNRESOLVED `DUPLICATE_EFFECT` |
| S-G11 | negative | Line list truncated, page cap reached, or unpageable `hasMore` | UNRESOLVED `INCOMPLETE_PAGINATION` |
| S-G12 | negative | Currency differs from the frozen currency | UNRESOLVED `CURRENCY_MISMATCH` |
| S-G13 | negative | Observed total negative or benefit exceeds frozen cap | UNRESOLVED `AMOUNTS_INCONSISTENT` |
| S-G14 | negative | Non-benefit lines differ from frozen base evidence after freeze (including added proration) | UNRESOLVED `EVIDENCE_DRIFT`, manual review, no recomputation |
| S-G15 | negative | Policy version in the snapshot differs from the frozen allocation | rejected `POLICY_VERSION_MISMATCH` |
| S-G16 | negative | Settlement after the reservation expired | UNRESOLVED `SETTLED_AFTER_EXPIRY`, manual review (OQ-3) |
| S-G17 | negative | Invoice `paid` but a pending or final refund or any dispute exists | UNRESOLVED/INELIGIBLE per the refund classifier; never ELIGIBLE |
| S-R1 | replay | Identical evidence submitted twice | same digest and classification; no second row |
| S-R2 | replay | Same evidence after a process crash and restart | same digest; no duplicate effect or decision |
| S-R3 | replay | Out-of-order older snapshot arrives after a newer one | stored as history; the newer snapshot governs; verdict never regresses silently |
| S-T1 | cross-tenant | Intent names another business's reservation | rejected `TENANT_MISMATCH` before any provider read |
| S-T2 | cross-tenant | Snapshot row with another business id attached to an intent | refused by the composite foreign key |
| S-T3 | cross-tenant | Same invoice id under two businesses | two independent snapshots; no cross-read |
| S-M1 | cross-mode | Test-mode evidence in a live-configured environment | UNRESOLVED `SCOPE_MISMATCH`, manual review |
| S-M2 | cross-mode | Live-mode evidence in a test-configured environment | UNRESOLVED `SCOPE_MISMATCH`, manual review |
| S-M3 | cross-mode | Wrong provider account id | UNRESOLVED `SCOPE_MISMATCH`, manual review |
| S-C1 | concurrent | Two reconcilers observe the same invoice at once | one snapshot row (digest unique), one classification |
| S-C2 | concurrent | Invoice changes between the two bracketing reads | UNRESOLVED `EVIDENCE_UNSTABLE` |
| S-C3 | concurrent | Verdict ELIGIBLE older than the freshness window at consumption time | accounting authority refuses it; re-observe required |
| S-C4 | concurrent | A newer snapshot with a different verdict exists at consumption time | accounting authority refuses the older verdict |
| S-A1 | adversarial | Webhook body claims `paid` with no independent read | no classification; only schedules an observation |
| S-A2 | adversarial | Client supplies invoice id, amounts and status | ignored; identity comes from the tenant-checked intent |
| S-A3 | adversarial | Provider-supplied free text in an error | never stored or logged; redacted to code/type/status |
| S-A4 | adversarial | Attempt to set `providerVerified` or `consumptionAuthorized` from a verdict | impossible: classifier has no write handle; fields stay literal `false` |
| S-A5 | adversarial | Verdict ELIGIBLE presented to consumption with a reversed or non-`fulfilled` settlement | accounting authority refuses (existing settlement checks and R10 saga gate) |

## 2. Refund and payment-dispute classifier

| ID | Kind | Scenario | Expected |
| --- | --- | --- | --- |
| D-N1 | normal | Complete reads, no refunds, no disputes | `NO_REFUND` |
| D-N2 | normal | One final refund equal to the amount paid | `FULL_REFUND_VERIFIED` |
| D-N3 | normal | Several final refunds summing to the amount paid | `FULL_REFUND_VERIFIED` |
| D-N4 | normal | Dispute closed lost for the full amount | `DISPUTE_LOST_VERIFIED`, extent full |
| D-N5 | normal | Dispute closed won, no other loss | `DISPUTE_WON_VERIFIED` |
| D-G1 | negative | Final refund below the amount paid | `PARTIAL_REFUND_VERIFIED`, hold, manual review, no financial action |
| D-G2 | negative | Dispute lost for part of the amount | `DISPUTE_LOST_VERIFIED`, extent partial, behaves as partial refund |
| D-G3 | negative | Refund pending or requiring action | `REFUND_PENDING` |
| D-G4 | negative | Failed refund only | not `NO_REFUND` until final state is shown (`REFUND_NOT_FINAL`) |
| D-G5 | negative | Open dispute plus a final refund | `DISPUTE_OPEN` (dominates) |
| D-G6 | negative | Refunded plus lost amount exceeds the amount paid | `CONTRADICTORY_EVIDENCE` |
| D-G7 | negative | Refund currency differs from the invoice currency | `CONTRADICTORY_EVIDENCE`, no conversion |
| D-G8 | negative | Refund naming another invoice or customer | `CONTRADICTORY_EVIDENCE` (rejected, not classified) |
| D-G9 | negative | Read failed, rate limited or truncated | `PROVIDER_UNREACHABLE`; never `NO_REFUND` |
| D-R1 | replay | Same refund event and same re-read twice | same class and digest; no second row |
| D-R2 | replay | Refund then dispute events in either order | same final class from the combined snapshot |
| D-R3 | replay | Full refund observed after a settlement reversal already unwound the credit | classification stored; the future reversal path reports `already_reversed`; **no second obligation** |
| D-T1 | cross-tenant | Refund evidence for another business's payment | rejected |
| D-M1 | cross-mode | Refund evidence from the other mode or account | `PROVIDER_UNREACHABLE` `SCOPE_MISMATCH`, manual review |
| D-C1 | concurrent | Refund and dispute arrive during one reconciliation | one coherent snapshot; one class |
| D-C2 | concurrent | Full refund races a settlement reversal and a revocation | exactly one financial consequence via the canonical key (future path) |
| D-A1 | adversarial | Webhook claims a full refund with no independent read | no classification |
| D-A2 | adversarial | Stripe "dispute" confused with the S07 award-dispute hold | impossible: separate names, tables and codes; frozen S07 behavior unchanged |
| D-A3 | adversarial | Classification `FULL_REFUND_VERIFIED` presented as authority to reverse | refused: reversal needs the accounting-authority authorization record |

## 3. PIC/1 coverage (all 17 scenarios)

Scenario names are those of `S08_PIC_1_READINESS_REVIEW.md`. "Affected" means the proposed classifiers change what must be proven. The scenarios remain **NOT RUN / NOT CERTIFIED**.

| PIC/1 scenario | Affected | Classifier behavior | Acceptance rows |
| --- | --- | --- | --- |
| Duplicate submission | write side only | none; observation replay is idempotent | S-R1, S-R2 |
| Concurrent application attempts | saga only | none | S-C1 |
| Timeout after successful provider mutation | yes | unreachable gives UNRESOLVED; a later complete bracketed read classifies the recovered effect | S-C2, D-G9 |
| Provider rate limitation | yes | UNRESOLVED (`PROVIDER_UNREACHABLE`, retry-after honoured); no credit movement | D-G9 |
| Wrong account or mode | yes | UNRESOLVED `SCOPE_MISMATCH`, manual review | S-M1 to S-M3, D-M1 |
| Cross-business substitution | yes | rejected before any read | S-T1 to S-T3, D-T1 |
| Incorrect invoice or currency | yes | scope or currency mismatch, UNRESOLVED | S-G12 |
| Wrong benefit amount | yes | UNRESOLVED `ATTRIBUTION_MISMATCH` | S-G8 |
| Unattributed benefit | yes | UNRESOLVED; metadata alone insufficient | S-G9 |
| Partial pagination | yes | UNRESOLVED `INCOMPLETE_PAGINATION` | S-G11 |
| Unknown provider outcome | yes | UNRESOLVED; no fabricated success or one-read absence | D-G9, S-C2 |
| Duplicate provider effect | yes | UNRESOLVED `DUPLICATE_EFFECT` | S-G10 |
| Reservation expiry | yes | UNRESOLVED `SETTLED_AFTER_EXPIRY`, manual review; owner decision required (OQ-3) | S-G16 |
| Reversal during application | boundary only | verdict never overrides the existing settlement and saga gates | S-A5 |
| Multiple credits targeting one invoice | yes | each line equals its frozen share; aggregate within the frozen cap | S-N3 |
| Recovery after process crash | yes | digest-keyed idempotent snapshots | S-R2 |
| Concurrent final settlement | boundary | accounting transaction re-checks freshness and newer snapshots under existing locks | S-C3, S-C4 |

## 4. Open owner questions (not decided; nothing here invents an answer)

| ID | Question | Design default if unanswered |
| --- | --- | --- |
| OQ-1 | How does Stripe API `2026-05-27.dahlia` expose settlement facts, out-of-band settlement, the settling payment, refund and dispute states? | none: field mapping stays provisional; a separately authorized test-mode proof is required |
| OQ-2 | Tax behavior of the negative Invoice Item (D1-a residual); jurisdiction-specific adviser confirmation | development simulation only; live use blocked |
| OQ-3 | Required behavior when settlement occurs after the reservation expired (PIC/1: stop for an owner decision where frozen rules do not determine the outcome) | UNRESOLVED, manual review |
| OQ-4 | Approval model for a refund- or dispute-triggered consumed-credit reversal: manual or automatic, number of approvers, wait period after a dispute is lost (reversal is irreversible today) | no reversal path exists |
| OQ-5 | Annual invoices: is the calculator's month-only default intended? | not re-evaluated at settlement |
| OQ-6 | Does an open dispute before consumption block consumption? | blocks (UNRESOLVED); also required by the mandatory "no contradictory dispute evidence" condition |
| OQ-7 | Freshness window `F` for an ELIGIBLE verdict | proposal 15 minutes, undecided |
| OQ-8 | Escalation thresholds for long-lived UNRESOLVED items | no automatic action; manual review flag only |
| OQ-9 | Extend the approved verifier methods (invoice lines, settling payment, refunds, disputes, all read-only) | no extension; classifiers cannot run live |
| OQ-10 | Uncollectible invoices that are later paid: how, and when, may a reservation be released or honored? | held; manual review before any release |
| OQ-11 | Partial refund and partially lost dispute policy | hold only |
| OQ-12 | Add a provider refund or dispute cause to the shared unwind routine, with an immutable evidence-snapshot id as the cause reference | not added; compensator not connected |
| OQ-13 | Should the calculator's `INVOICE_NOT_PAID` gate apply to a draft-invoice benefit computation? | unchanged; not relied on |
| OQ-14 | Out-of-band settlement exceptions | none exist |
| OQ-15 | Confirm that wrong account/mode evidence is UNRESOLVED (not INELIGIBLE) | UNRESOLVED, manual review (design proposal) |

## 5. What this matrix does not cover

R10 Block 2 (release authority, withdrawal, three-person execution, the R7 detector), any provider write adapter, real Stripe test-mode runs, tax approval, and any ledger or schema change. The certification of PIC/1 requires executing these scenarios; this document only defines them.
