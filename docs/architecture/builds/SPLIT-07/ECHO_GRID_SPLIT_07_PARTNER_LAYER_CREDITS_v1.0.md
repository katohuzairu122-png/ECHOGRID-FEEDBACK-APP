# ECHO GRID — SPLIT 07: PARTNER LAYER & PARTNER CREDITS

**Version:** v1.0 — ARCHITECTURE FREEZE CANDIDATE  
**Status:** REVIEW ONLY — NOT YET FROZEN  
**Repository:** `katohuzairu122-png/ECHOGRID-FEEDBACK-APP`  
**Target:** `main`  
**Predecessors:** Splits 01–06 (preserve their locked interfaces)  
**Next:** Split 08 billing integration — separate freeze required

## 1. Governing authority and scope

This specification adds a platform-administered Partner Layer for receiving businesses that fulfill qualifying orphan settlements. The business receives a Partner Credit *entitlement* under Split 07 policy; customers do not receive Partner Credits. Partner Credits are non-cash, nontransferable, nonwithdrawable platform service benefit units, **not** reimbursement of the retail cost of a fulfilled reward, business loyalty points, Community Points, invoice money, or a Stripe balance.

Split 07 owns enrollment, eligibility, policy versioning, issuance decisions, provisional/available credits, append-only credit history, reversal/recovery obligations, benefit eligibility statements, and business-facing inspection. It owns **no** subscription charges, invoices, discounts applied, Stripe state, cash conversions, business loyalty, Community Point mutations, or orphan settlement transitions.

This document is an architecture-only review candidate. Its numerical settings are approved for architecture review by the project request, but become operational policy only after formal architecture freeze, implementation, tests, operational approvals, and separate Split 08 freeze for billing application.

## 2. Existing repository reconciliation

- `businesses` is the business identity; `branches` are scoped operational contexts. Exactly one Partner Credit account per **business**, shared across its branches.
- Existing business RBAC uses global `permissions`, business/branch role assignments and permission seeds. Add business capability `partner_credits:view` for authorized business-level visibility; no business-side issuance, reversal, amount editing, or policy administration. A branch-only operator must not see aggregate business finances by default.
- `users.platformRole` currently defines `support`, `billing`, `admin`. Platform permissions are explicit route allowlists, not automatic role inheritance. Credit issuance/reversal/correction/policy changes require fresh authenticated, active **platform admin** authority or dedicated future platform permissions frozen separately; platform billing staff may have read access only if expressly granted. Never infer platform authority from business ownership, a JWT claim alone, or impersonation.
- `subscription_plans` contains cached currency and monthly/yearly prices; Stripe Prices are authoritative for actual billables. `business_subscriptions` is one record per business and a **read-optimized mirror**, not a balance or invoice source. Do not modify either for Split 07.
- Split 06 has `OrphanSettlementCompletionEvidence v1` and `OrphanSettlementReversalEvidence v1`, each keyed by `settlementRef`. Consumers must re-resolve authoritative state and append-only settlement events. A supplied evidence JSON alone cannot authorize an award.
- Split 05 Community Points and Split 03 loyalty are strictly independent; neither ledger is read as a credit denomination or written by this module.
- No existing Partner Credit table/ledger or Split 07 frozen implementation was found in repository code search prior to this PR. Final migrations must use the **next actual free migration sequence** from the then-current main, not a guessed number.

## 3. Canonical flow

```text
Split 06: fulfilled settlement + completion evidence v1
  → Split 07: server-resolved, verified evidence + active partner enrollment
  → one versioned eligibility/award decision per settlementRef
  → provisional Partner Credit (14 days)
  → recheck still fulfilled / unreversed at vest
  → available Partner Credit in append-only ledger
  → Split 08 future: eligible service-benefit reservation/application
  → Stripe / actual invoice only in Split 08

Split 06: settlement reversal evidence v1
  → Split 07: verify authoritative reversal
  → unique compensating credit reversal / recovery obligation
  → Split 08 separately owns consequences of already-applied billing benefit
```

No business can force Partner Credit issuance by submitting a QR token, customer action, reward price, or settlement ID. No credit is minted by the Split 06 fulfillment transaction.

## 4. Frozen-candidate economic policy (PC-ECON/1)

| Property | Policy |
| --- | --- |
| Award | **1 Partner Credit** per eligible verified fulfilled settlement |
| Denomination | **1 non-cash platform benefit unit**, not a fixed monetary amount |
| Monthly earning cap | **10 earned credits** per receiving business, summed over branches, per **UTC calendar month** |
| Excess eligible completions | Decision recorded as `cap_exceeded`; **no deferred award** |
| Provisional hold | **14 complete days** from authoritative fulfillment time, never earlier than successful eligibility decision |
| Vest | Server re-resolves active, unreversed fulfillment, eligibility and policy; provisional credits become available only once |
| Expiry | **12 calendar months after vest** (UTC; explicitly persisted) for unconsumed, unreversed credits |
| Redemption applicability | Not implemented by Split 07; Split 08 must authorize and reserve/apply only then-valid credits |
| Recommended monthly billing benefit | Each applied credit reduces **1%** of an *eligible monthly base subscription fee*, capped at **10% total** per eligible invoice period |
| Cash/transfer | No cash-out, gift, business-to-business transfer, customer points conversion, refunds or cash liability by default |

For determinism, the award decision snapshots `policyVersion`, the business ID, `settlementRef`, effective rule, award quantity, earning-month UTC, fulfilled-at, vest-at, and expiry formula. Monthly cap is enforced atomically across branch activity and concurrent decisions; rejected, duplicate, and cap-exceeded decisions do not mint credits.

**Economic qualifier:** the 1% subscription benefit is a proposed future **Split 08 policy**, **not** a promise that Split 07 can modify invoices, and **not** an intrinsic conversion rate (1 credit ≠ $X). A 10-credit application on an eligible $100 monthly base fee would provide at most $10 of future invoice reduction *only after Split 08 contract, tax/rounding policies and payment-provider integration are frozen*.

Subscription plans billed yearly, trials, free plans, invoice timing, taxes, add-ons, price changes, refunds, multi-currency, minimum charges, proration and Stripe discounts are **not eligible for automatic application in v1**. Split 08 must separately freeze those cases. Until then application is disabled even if credits are available.

## 5. Partner enrollment and participation

Partner enrollment is a platform-controlled, audited business eligibility record with explicit business acceptance of published participation terms. Enrollment alone cannot expose customer orphan data or create credits. The receiving business must have been eligible under an active policy at fulfillment; qualification decisions never assume prior membership solely from acceptance of a Split 06 settlement. Revoked/suspended partners cannot earn new awards, but existing history persists. Treatment of previously vested credits on suspension requires an explicit platform disposition; do not silently confiscate them.

**Backward-eligibility ruling:** settlements fulfilled before a business is enrolled, before the effective PC-ECON/1 rule, or before Split 07 is activated **do not retroactively earn credits**. A future backfill requires a separately approved versioned policy and audited migration plan.

## 6. Durable schema proposal (additive; not yet implemented)

1. `partner_program_enrollments`: business_id unique; acceptance/policy version, status, accepted_by_user_id, accepted_at, effective_at, suspended_at; lifecycle audit.
2. `partner_credit_policies`: immutable versions; effective windows, award/cap/vest/expiry parameters, activation/retirement actor and timestamps, change reason.
3. `partner_credit_accounts`: exactly one per business, unit `partner_credit`, derived/projection buckets `provisional`, `available`, `reserved_for_billing`, and `recovery_due`; no free-form money field. Account balances derive from ledger/allocations and must reconcile.
4. `partner_credit_award_decisions`: UNIQUE `settlement_ref` per policy program; business_id, eligibility result, policy version, award quantity, source evidence references, earning UTC month, timestamps, reason and idempotency key. This is the one-time eligibility decision source.
5. `partner_credit_ledger`: append-only, id, account_id, business_id, decision_id nullable, `settlement_ref` nullable, entry_type, signed integer units, reference, idempotency_key unique, occurred_at, metadata; no delete/update of settled history.
6. `partner_credit_reservations` (forward contract only; implementation must not activate before Split 08 freeze): references credit lots, billing correlation/idempotency, status and expiration. Split 07 may expose safe reservation interfaces later, but not apply invoice discounts.
7. `partner_credit_recovery_obligations`: unique originating reversal reference, consumed quantity to recover, outstanding quantity, audit/status; never present as customer cash debt.
8. Prefer explicit lot records or immutable allocations if needed to prove 14-day vest and 12-month expiry across partial billing consumption. Never infer expiry from account aggregate.

Enforce FK integrity, idempotent uniqueness, row locking, business-scoped indexes, nonnegative available/reserved projections and recovery invariants, and immutable event history. No table above is to be created by this **architecture-only** PR.

## 7. State machines and conservation

Award decision: `ineligible | cap_exceeded | provisional | vested | reversed` (names may be refined before implementing, semantics may not).

Lot: `provisional → available → reserved_for_billing → consumed`; may instead transition to `expired` when unconsumed and past expiry, or compensate via `reversed`. All transition evidence is immutable and idempotent.

Available for new billing reservations = vested unexpired unreserved units after applying recovery-offset obligations. No negative **available** balance. Recovery is accounted separately rather than deleting or overdrawing history. Consumption cannot exceed vested, valid, unencumbered quantity.

Late evidence reversal after consumption must: (a) append a unique compensating entry; (b) freeze any unconsumed units of the original award; (c) create a uniquely keyed recovery obligation for previously consumed units; (d) direct future newly vesting credits to satisfy that obligation before they become available; (e) preserve original billing history unchanged. **Split 08** must separately decide whether an applied invoice needs an accounting adjustment; Split 07 may not debit a payment method or mutate Stripe.

Reversed settlements are never awarded again by replay or retroactive requalification under PC-ECON/1.

## 8. Evidence validation and failure closure

On evaluation: re-read Split 06 settlement and claim, verify same receivingBusinessId, authoritative `settlement_fulfilled` event, matching fields/time/policy, current state `fulfilled` and no authoritative reversal. Use `settlementRef` as uniqueness root, not customer-provided metadata. A reversal always requires authoritative `settlement_reversed` and state `reversed`. Reject mismatch or inaccessible source; do not create provisional credit.

On vest/redeem handoff: repeat live authoritative reversal checks. Handle races (reversal versus award, vest, billing reservation) using locks and deterministic retry rules; a transaction that loses the race fails closed. Queue delivery is never proof of eligibility, a source of truth, or reason to double-award.

## 9. Authorization

Business proposed capabilities: `partner_credits:view` (aggregate account/ledger and self-award detail only), optional later `partner_program:accept` with trusted business authority. Neither implies `settlement:view` or permission to read unrelated customer/origin reward history.

Platform operations: initial policy create/activate/pause/retire, eligibility corrections, approved account adjustments, reversals/recovery review; active platform admin, fresh DB recheck, explicit allowlist, immutable semantic audit, reason, idempotency. Billing staff may view a constrained financial operational projection only by explicit platform permission; support roles are not entitled to full economic records by default. Impersonation cannot grant credit-administration authority.

Customer has **no** Partner Credit account or balance. Public/QR payloads never include credit balance, economic valuation or authorization outcome.

## 10. Future Split 08 handoff (not activated)

Split 07 may expose authenticated credit balance, lot/expiry, recovery debt and eligibility snapshots, and an auditable, idempotent reservation/consumption protocol **after Split 08 contract freeze**. Split 08 alone chooses: eligible invoice-period/base amount, provider reconciliation, exact percentage calculation, monetary currency, cent rounding, tax treatment, proration, billing interval, yearly plans, concurrency, cancellation/refund treatment, Stripe API and webhook replay.

No credit may be considered consumed solely because an invoice was estimated or a discount was requested. Commit consumption only against durable Split 08 application success/reference, with retry/release semantics and reconciliation. Credits are not Stripe customer balances. Business `billing:manage` must not grant Partner Credit mint authority.

## 11. Security / abuse safeguards

- One verified settlement → at most one award; one reversal reference → at most one compensation.
- Ten-per-UTC-month business cap enforced transactionally with lock/unique key; branch hopping does not increase cap.
- No self-settlement: originating business and receiving business must differ, consistent with Split 06.
- Flag suspicious rapid repeat source/customer/business patterns for platform review; fraud signals may block an award only under explicit versioned hold policy, not unreviewed auto confiscation.
- Credit policy changes are prospective; historical awards snapshot immutable policy version.
- Prefer narrowly scoped DTOs; block cross-business IDs, branch spoofing, unauthorized customer details and source enumeration.
- Log economic administrator actions with actor, scope, reason, policy, before/after projection, evidence link.

## 12. Test and rollout gates

Before any implementation PR: architecture PR merged with explicit finance/product approval of rates, caps, expiry, vesting and recovery; migrations sequenced from live main; permissions matrix agreed.

Implementation CI must prove: migration drift and fresh Postgres replay; account uniqueness and branch aggregation; double-award and concurrency; 10-credit monthly cap across branches; UTC month boundary; 14-day vest and exactly-once delivery; anniversary expiry and partial usage; pre/post-vest reversal; reversal-after-billing-consumption debt; immutable ledger projection; policy version immutability; denial under wrong role/branch/impersonation; no loyalty, Community, orphan settlement, subscription or Stripe writes; backend/frontend typechecks, tests, production builds and browser checks.

Do not expose financial benefit redemption or write Stripe state before **separate Split 08 architecture freeze, implementation and full testing**. Roll out enrollment/earn/view behind server-controlled feature activation. Initial balance should be zero. Existing Split 06 completions are not automatically backfilled.

## 13. Freeze rulings / explicit exclusions

- **R1:** receiving business earns 1 credit for an eligible fulfillment, maximum 10 monthly across branches; no claim-value-based pricing.
- **R2:** Partner Credit is a platform-defined non-cash service-benefit unit, not a customer asset, cash claim, payment, or origin loyalty equivalent.
- **R3:** Split 07 governs credit lifecycle; Split 08 exclusively interprets monetary subscription benefit.
- **R4:** Proposed 1% of eligible monthly base subscription fee per applied credit, capped at 10%, is **reserved for Split 08 approval** and not executable in Split 07.
- **R5:** Completion evidence grants no credit unless live authority, partner enrollment, eligibility, cap and policy version all validate.
- **R6:** Reversal is append-only, unique and compensating; applied benefits are reconciled in Split 08 only.
- **R7:** No automatically retroactive awards, raw loyalty conversion, Community Point conversion, Stripe state change, or business-minted credits.
- **R8:** Business-level account, platform-administered, strict RBAC. One QR model unchanged.
- **R9:** Unresolved contract-level operational interpretation (yearly plans, taxes, actual invoices, recovery application) must fail closed, not be invented during coding.

## 14. Freeze process

This PR is **architecture only**, not an implementation or activation authorization. Review this proposal against economic margin exposure and operational obligations. After approval, merge to main with required CI/reviews, record freeze commit and set status to `FROZEN FOR IMPLEMENTATION` through an explicit documentation change if needed. Only then plan additive Split 07 implementation blocks; Split 08 remains separately gated.
