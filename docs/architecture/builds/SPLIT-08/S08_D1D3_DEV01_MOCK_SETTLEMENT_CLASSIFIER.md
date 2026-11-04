# S08-D1D3-DEV-01 — Mock settlement eligibility classifier (development record)

**Status: DEVELOPMENT ONLY, INERT. Pure function plus unit tests. No caller, route, queue, cron, database, migration, Stripe read or write, ledger or consumption change. Financial activation: NO-GO.**
Implements [the settlement eligibility specification](S08_D1D3_SETTLEMENT_ELIGIBILITY_SPEC.md) under owner decision [S08-D1D3/1](OWNER_DECISION_S08_D1_D3_ECONOMIC_AND_SETTLEMENT_2026-11-04.md) (merged #218, specs merged #219; baseline `main` `2c1163f`). It is a classification authority only: `ELIGIBLE` is never permission to consume, release or write.

## Files
- `apps/api/src/billing/settlement-eligibility.classifier.ts` — `classifySettlement(context, evidence)`. Type-only import of the frozen allocation contract; nothing else.
- `apps/api/src/billing/settlement-eligibility.classifier.test.ts` — 56 tests (the 30 required scenarios, adversarial, determinism, purity, mutation-hardening).

## Contract
- **Trusted context** (`SettlementClassifierContext`): injected clock, policy version, policy effective instant, freshness window, and the expected business, reservation, intent, invoice, customer, subscription, currency, provider account, provider mode, reservation expiry and the frozen allocation (`S08-AGG-ROUND/1`, reused as-is, never recalculated). Expected values come from configuration and persisted records, never from the evidence.
- **Evidence** (`MockSettlementEvidence`): provenance (kind, snapshot ref and digest, observation time, provider outcome, completeness, two bracketing read fingerprints), binding, provider identity and mode, invoice, invoice lines (with provider-reported parent item and key), the benefit item, settlement source, and refund/dispute/cancellation events. Its provenance kind is the literal `MOCK_SYNTHETIC`; any other kind is refused, so it cannot impersonate a real verifier capability.
- **No authority field exists.** Any truthy `consumptionAuthorized`, `providerVerified`, `authorized`, `trusted`, `verified`, `eligible`, `approved`, `settlementAuthorized` or `financialAuthority` anywhere in the evidence or context makes the result UNRESOLVED (`CALLER_AUTHORITY_ASSERTED`). The frozen allocation's literal `false` flags are the only permitted values.
- **Result**: verdict, ordered reason codes, advisories, unresolved requirements, safe evidence references (identifier-shaped strings only), policy version, injected-clock timestamp, manual-review flag, `reservationHeld: true` and `grantsFinancialAuthority: false`. No provider text, payload or secret is returned, and malformed input never throws.

## Rule order (first phase that finds anything returns)
P1 tenant, reservation, intent, frozen allocation; P2 provider outcome; P3 account, mode, invoice, customer, subscription, currency; P4 policy version and effective instant; P5 completeness; P6 stability of the bracketing reads; P7 arithmetic coherence and duplicate lines; P8 invoice state, settlement source, policy applicability, zero-total rule (the only phase that can return INELIGIBLE, after the trust phases passed); P9 refund, dispute, cancellation; P10 benefit line, correlation, amount, currency, discountability, unexpected benefit lines, frozen-base drift; P11 reservation expiry and freshness. Otherwise ELIGIBLE.

## Decided behavior implemented
D1-b (benefit non-discountable, never a negative total, base after discounts as frozen), D1-c (policy pinned to `PC-BENEFIT/1`, prospective from an injected instant), D3-a (paid, remaining zero, verified benefit line), D3-b (zero-total needs positive pre-benefit value), D3-c (partial payment UNRESOLVED), D3-d (out-of-band INELIGIBLE), D3-e (proration excluded from the base), D3-f (void and uncollectible INELIGIBLE, reservation always held), D3-g (full refund and lost dispute are INELIGIBLE here; partial and pending are UNRESOLVED with manual review).

## Undecided behavior represented as UNRESOLVED (not invented)
- **Freshness window (OQ-7):** a policy dependency with no default. Absent, null or invalid means the classifier can never return ELIGIBLE (`FRESHNESS_POLICY_UNAVAILABLE`). The value used in the tests is a test fixture, not policy. Age exactly equal to the window is treated as fresh; that boundary is an implementation choice to be confirmed with the window.
- **Settlement after reservation expiry (OQ-3):** UNRESOLVED with manual review. The boundary mirrors the reservation convention (expired when `expires_at <= now`), so settlement at the expiry instant is already late.
- **Settlement source (OQ-1):** the real Stripe field that distinguishes out-of-band settlement is unknown; the mock input exposes a plain `source` and an unknown source is UNRESOLVED.
- **Policy effective instant:** D1-c says "after the recorded approval date" without an instant or time zone. It is an injected input, not hardcoded; the boundary instant itself applies (`createdAt >= effectiveFrom`). To be confirmed.
- **Wrong account or mode (OQ-15):** UNRESOLVED with manual review (specification proposal).
- **Annual invoices (OQ-5):** classified like any other invoice; the interval is an advisory only.

## Specification ambiguity surfaced by implementation
Matrix row **S-G14** says non-benefit lines differing from the frozen base after the freeze, "including added proration", are drift. D3-e says proration lines are excluded from the eligible base. The implementation follows D3-e: only a change in the **recurring base** lines is drift, an added proration line leaves the base unchanged and the invoice stays eligible, and an invoice whose only base-like lines are proration is `PRORATION_ONLY_BASE` (UNRESOLVED). The owner should confirm which reading is intended.

## Acceptance-matrix coverage (the 38 settlement rows; the 24 refund/dispute rows are out of scope)
**Covered (26):** S-N1, S-N2, S-N3, S-G1, S-G2, S-G3, S-G4, S-G5, S-G6, S-G7, S-G8, S-G9, S-G10, S-G11 (as the modeled `complete` flag), S-G12, S-G15, S-G16, S-R1, S-T1, S-M1, S-M2, S-M3, S-C2, S-A2, S-A3, S-A4.
**Partially covered (6):**
- S-G13: negative total covered; the cap is structural (every benefit line is pinned to one allocation and the allocations are checked to sum to the aggregate), so there is no separate over-cap branch.
- S-G14: see the ambiguity above.
- S-G17: refund, dispute and cancellation enter as already-classified states because the refund/dispute classifier is not built.
- S-T3: the tenant check rejects another tenant's evidence; there is no persistence to show two tenants' snapshots stay independent.
- S-A1: the input has no webhook channel; tests show asserted facts and authority keys do not make an invoice eligible.
- S-C3: the classifier refuses stale evidence; the accounting transaction's re-check of freshness is not exercised.
**Not covered (6), because this block is pure and persistence-free and does not touch consumption:** S-R2 (crash recovery), S-R3 (out-of-order snapshots), S-T2 (composite foreign key), S-C1 (concurrent reconcilers), S-C4 (newer snapshot with a different verdict), S-A5 (an ELIGIBLE verdict presented to consumption with a reversed or non-fulfilled settlement: the consumption path is unchanged, and its existing settlement checks plus the R10 saga gate are the relevant controls).

## Not done (separate blocks)
Refund/dispute classifier; the consumption settlement gate (the existing D4 path still has none: finding R-4); verifier expansion and any Stripe read; persistence of snapshots; refund-triggered reversal; reservation release (R10 Block 2); any migration.
