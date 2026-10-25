# Owner decision: Split 08 draft-invoice timing — 2026-10-25

**Decision ID: S08-TIMING/1. Status: approved for development only.**

## Decision evidence and scope

In this repository work session, the assistant presented:

> 1. Before payment: reduce the specific draft invoice, then consume credits only after reconciliation and settlement. This requires replacing the paid-only testing assumption.

The repository owner replied **“1”**. This records that selection only. It does not assert a separately authenticated production approval, a signer identity beyond this work-session user, or approval of unresolved economic details.

The reviewed repository baseline is `4a206bf82c6d961f6e6f41eac9feb6b7e688c7c9`. The approved development model applies to future design and non-activating development after this decision; it changes no historical application, policy or ledger entry.

## Selected lifecycle

1. Bind a persisted, authorized application intent to the specific business, reservation, invoice, subscription, customer, provider account/mode, currency, policy and stable idempotency identity required by S08-PIC/1.
2. The intended benefit targets **that invoice while it is draft, before finalization/payment**. Immediately before any future authorized mutation, revalidate its lifecycle and full identity. Do not silently substitute an invoice or subscription if it has changed.
3. A provider operation response is an operation reference only. Independently retrieve complete instrument-specific evidence and reconcile the exact attributed amount/currency.
4. Final Partner Credit consumption remains a separate authorized database transaction, gated on both independent benefit reconciliation **and invoice settlement**, plus every section D identity, dispute, reversal, compensation, idempotency and accounting invariant.
5. If the invoice finalizes or changes before a planned adjustment, do not reinterpret this timing decision as permission for a different instrument, late write or replacement invoice. If an earlier operation may have taken effect, preserve the existing obligation and reconcile it; do not retry it as a fresh economic action.

These are lifecycle requirements, not an implemented workflow. No provider writer or final ledger consumer is added by this decision.

## What the paid-only testing assumption means now

The [2026-10-23 development baseline](../OWNER_DECISIONS_2026-10-23.md) used fully paid invoices as a conservative eligibility default for testing.

For this approved development model, **being paid is not a prerequisite to the intended draft-invoice benefit adjustment**. Settlement is still a prerequisite to final credit consumption. Existing read-only reconciliation stays authoritative; it does not gain settlement-authorizing powers.

This supersedes only the timing interpretation of that testing default for future development. It does not silently approve treatment of annual periods, zero/partial payments, proration, taxes, refunds, cancellation or unsettled obligations. Do not rewrite existing tests to suggest an activated financial path.

## Remaining owner decisions

| Area | Resolved by this choice | Still unresolved |
| --- | --- | --- |
| D1: instrument and attribution | Target the specific draft invoice before payment. | Exact Stripe object/operation, independently retrieved effect reference, authenticated reservation attribution, tax/economic treatment and policy version. The candidate negative-line extractor is not approved by selecting timing. |
| D2: allocation and rounding | Nothing further. | Aggregate versus per-credit flooring; deterministic residual allocation; exact per-reservation amount and aggregate cap enforcement. |
| D3: settlement evidence | Consumption follows independent reconciliation and settlement, rather than adjustment requiring an already-paid invoice. | Authoritative settlement fields and qualification rules, including zero/partial payment, out-of-band settlement, annual periods, proration, refunds and cancellation. |
| D4: accounting and compensation | No direct provider-response ledger mutation; keep final consumption separate. | Frozen-compatible transactional implementation, ledger vocabulary, conservation/lock-order details and separately authorized compensation. |

Full authenticated provider identity remains an implementation gap. Nothing in this record permits trusting a caller-supplied tuple or manufacturing provider evidence.

## Examples and acceptance implications

- **Draft invoice, no effect yet:** the future adapter may be designed to target this exact invoice after full authorization checks; this decision permits no actual Stripe write.
- **Invoice already finalized at preflight:** this approval supplies no alternative adjustment path. Do not move the benefit to another invoice.
- **Reconciled benefit but invoice unpaid:** retain the obligation; no final Partner Credit consumption.
- **Invoice paid but benefit unverified:** no final Partner Credit consumption.
- **Benefit reconciled and settlement evidenced:** still enforce all six section D conditions; this decision alone never grants consumption authority.
- **Unknown result followed by invoice finalization:** preserve the original operation identity and reconcile any existing effect; do not submit a replacement action to compensate for a lost response.

The eventual acceptance suite must exercise finalization racing adjustment, settlement racing final consumption, unknown operation outcomes, and balance conservation under the approved instrument. None is certified by this record.

## Restrictions preserved

The owner approved option 1 **for development only**, in response to a timing choice. S08-PIC/1 remains Proposed. No Stripe benefit writes (test or live), financial activation, credit consumption, compensating financial execution, production migration, deployment or certification is authorized.

No route, cron, queue, schema, production role, credential, guard or authorization flag changes. `historicalTierVerified`, `issuanceAuthorized` and `redemptionAuthorized` remain unchanged. Stop dependent implementation at unresolved instrument, economic or frozen-architecture decisions under section G.

Related: [component coverage and owner decisions](S08_PIC_1_COMPONENT_COVERAGE_AND_OWNER_DECISIONS.md), [readiness review](S08_PIC_1_READINESS_REVIEW.md), [S08-PIC/1](PROVIDER_INTEGRATION_CONTRACT_S08_PIC_1.md).
