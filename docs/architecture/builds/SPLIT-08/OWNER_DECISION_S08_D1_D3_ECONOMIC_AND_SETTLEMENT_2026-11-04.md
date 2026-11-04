# Owner decision: Split 08 D1 (economic/tax) and D3 (settlement evidence) — 2026-11-04

**Decision ID: S08-D1D3/1. Status: approved for architecture specification and mock-provider development only. Financial activation: NO-GO.**

## Approval evidence

The repository owner answered the D1/D3 decision register in the current work session (recorded 2026-11-04; this is the effective date for D1-c). The answers below are the owner's, recorded here as given; D3-g is the owner's change to the proposed default. This record is not a production authorization or a separate identity attestation. It supplements [S08-INSTRUMENT/1](OWNER_DECISION_S08_NEGATIVE_INVOICE_ITEM_2026-10-25.md) and [S08-TIMING/1](OWNER_DECISION_S08_DRAFT_INVOICE_TIMING_2026-10-25.md), which are unchanged.

## Decisions

| ID | Answer | Decision |
| --- | --- | --- |
| D1-a | A | The negative Invoice Item is treated as reducing the taxable base **for development simulation only**. Jurisdiction-specific tax-adviser confirmation is required before any live use. Stripe tax defaults must not be silently relied on. |
| D1-b | A | The eligible base is calculated **after existing invoice discounts**. The Partner Credit benefit is non-discountable and must never produce a negative invoice total. |
| D1-c | ACCEPT | Policy version `PC-BENEFIT/1` is preserved and immutable. It applies prospectively, to invoices created after 2026-11-04 (the recorded approval date). One verified Stripe mode per environment is enforced. |
| D3-a | ACCEPT | Final credit consumption requires independently verified invoice settlement: paid status, amount remaining zero, matching invoice/account/mode, a verified benefit line and the required settlement evidence. A provider response alone is insufficient. |
| D3-b | A | A zero-total invoice is eligible only when its pre-benefit amount was positive and every other settlement and attribution condition holds. |
| D3-c | ACCEPT | Partial payment does not authorize consumption. Hold for reconciliation. |
| D3-d | ACCEPT | Out-of-band settlement is ineligible by default. Any exception needs a separate owner decision. |
| D3-e | ACCEPT | The benefit applies only to the invoice identified by the frozen intent. No retroactive recomputation. Proration lines are excluded from the eligible base. |
| D3-f | ACCEPT | Cancellation, void or uncollectible status before payment cannot consume credits. Provider evidence is preserved, and release happens only after independently verified release authority exists. |
| D3-g | **CHANGE** | A fully refunded payment or a lost dispute may initiate the existing approved consumed-credit reversal and recovery-obligation process **after independent verification**. Partial refunds and partially lost disputes are **held for reconciliation** with no automatic credit restoration, consumption reversal or balance adjustment. A separate owner-approved partial-refund policy is required. |

## Authorization boundary

These decisions authorize architecture specifications and mock-provider development tests only. They do **not** authorize: real Stripe writes (including Stripe test-mode writes); production or shared database changes; financial activation; automatic credit consumption, release or recovery execution; deployment or automatic merging; or progression into any unrelated development block. Implementation requires explicit authorization of the specific development block.

## Still open after this decision (nothing here decides them)

- **Partial-refund / partial-dispute policy** (D3-g): a separate owner decision.
- **Out-of-band settlement exceptions** (D3-d): none exist until separately decided.
- **Tax-adviser confirmation** (D1-a): required before live use; the development simulation is not tax advice.
- **D4:** frozen-compatible transactional consumption and compensation; unchanged by this record.
- **Release authority** (D3-f): does not exist yet (`SPLIT08_RELEASE_AUTHORITY_NOT_ESTABLISHED`); it belongs to R10 Block 2.
- **Refund/dispute event wiring:** no code maps a Stripe refund or dispute to the consumed-credit reversal (the compensator is called only by the Split 06 settlement reversal). Connecting them, with independent verification, is a future authorized block.
- Authenticated provider identity binding, the real Stripe test-mode run, and the 17 S08-PIC/1 scenarios remain NOT CERTIFIED.

## Development implications (for the future blocks above; none is started)

A settlement-eligibility check, an eligible-base calculation (post-discount, excluding proration, never below zero) and a refund/dispute classifier (full vs partial) would each be pure, mock-provider-testable components. They would be specified and built only in a separately authorized block.
