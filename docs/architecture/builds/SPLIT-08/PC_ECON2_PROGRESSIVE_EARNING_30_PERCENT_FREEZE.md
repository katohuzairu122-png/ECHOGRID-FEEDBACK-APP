# Split 07/08 — PC-ECON/2 Progressive Earnings and 30% Invoice Discount Review

**Status: proposed architecture freeze for review; not operationally frozen and not activated.**
**Base policy:** PC-ECON/1 currently enforces exactly one unit for each awarded settlement, ten units per business per UTC month, 14-day vesting and 12-calendar-month expiry. Do not change PC-ECON/1 or economic guards by inference.

## Confirmed business policy intent
- A smaller priced paid subscription earns more noncash Partner Credits per *qualifying fulfilled orphan settlement*. A business's tier is determined at fulfillment time and is preserved as an immutable historical snapshot when the authoritative reader exists; upgrades/downgrades never reprice past awards.
- One vested unit has a proposed USD 100-cent eligible fee benefit, not cash, debt, Stripe customer balance, or customer loyalty/Community Points.
- Maximum eligible subscription fee discount is **30%**, so at least **70% of eligible fees** remain undiscounted, before tax. Full-threshold redemption only: the business may request redemption when vested, unexpired, available units cover the entire count for this invoice. No partial discount. Unused units carry until expiry.
- Currency restricted to USD pending an explicit policy amendment.

## Existing authoritative subscription catalog — proposed rate mapping

| Catalog key | Catalog monthly price | Units per qualifying settlement (proposed) | Full 30% monthly fee threshold (whole $1 units) |
| --- | ---: | ---: | ---: |
| free | $0 | 0 — excluded | ineligible |
| starter | $9 | 3 | 2 (USD $2 maximum whole-credit discount) |
| growth | $29 | 2 | 8 (USD $8 maximum whole-credit discount) |
| business | $59 | 1 | 17 (USD $17 maximum whole-credit discount) |
| enterprise | custom, price is not represented by catalog row | 0 — approval required | not defined |

Subscription prices are cached catalog values, not proof of actual Stripe invoice fee. Quoting uses the **provider-confirmed eligible amount**, which may differ due to the billing period, taxes, discounts, proration, and price changes.

**Monthly billing is the only eligible interval in this proposal.** Annual-plan treatment remains a separate policy decision; do not divide an annual Stripe amount by 12 or assume a monthly price for benefit application.

## Ten-unit UTC-month earning cap
- Retain 10 **units** per business per UTC month, not 10 settlements. Count across all its branches and historical tier changes.
- If awarding the full tier rate would exceed the remaining monthly allowance, record **zero units/cap_exceeded**; do not create an undocumented partial award.
- Existing 1-unit lot, award ledger, vest, expiry, reservation, and reversal paths are **not compatible** with 2/3 units. Multi-unit issuance needs a separately reviewed atomic migration of lot conservation, full/partial recovery, reserve per-unit allocation, idempotency, expiry and concurrency tests.
- No retroactive backfill or revaluation of previously earned PC-ECON/1 units.

## Provider-backed immutable tier snapshot
At settlement fulfillment, freeze evidence with settlement/fulfillment identifier, business ID, local subscription row ID, Stripe customer/subscription/price IDs, authoritative plan ID/key, currency and interval, fulfillment UTC timestamp, provider plan effective window, original plan rate, policy version, and intended units. The current subscription mirror is mutable and cannot prove which tier was effective at a past fulfillment time. Missing/ambiguous period, customer mismatch, stale/retroactive webhook ordering or ineligible trial must **fail closed**.

The pure `inspectProgressiveAwardCandidate` helper only models candidate policy outcomes. It intentionally returns `historicalTierVerified:false` and `issuanceAuthorized:false` for all inputs. A client-supplied snapshot can never mint units.

## Full-threshold redemption formula
Given an independently verified **USD pre-tax eligible subscription fee** `F` in cents:

`required_units = floor((F * 30) / (100 * 100))`

`discount_cents = required_units * 100` only if available vested units >= required_units and required_units > 0; otherwise zero. Maximum full-unit discount <= 30% of `F`. No fractional credit or partial redemption. Quote is not a Stripe adjustment and always returns `providerAmountVerified:false`, `redemptionAuthorized:false`.

Tax treatment, proration, discounts, annual invoices, credits/credit notes, refunds and the final Stripe benefit mechanism are **not approved**. The account/ledger cannot be debited merely because quote arithmetic passed.

## Completion blockers
1. Approve/record PC-ECON/2 formally and explicitly resolve annual/enterprise/trial and cap boundary behavior.
2. Implement immutable provider-backed historical tier source and subscription-change race testing.
3. Design and migrate 2/3-unit award, ledger, lot, vest/expire/reverse/recovery and reservation per-unit integrity; preserve settlement-first locks.
4. Freeze Stripe invoice benefit adjustment semantics and reconcile the actual provider effect; implement atomic terminal consumption and consumed-credit reversal races.
5. Run isolated PostgreSQL tests, fresh migrations, full CI and independent billing review before any activation.

**Operational disposition:** No Stripe writes, migration, backfill, release of 0041/0042 triggers, economic issuance, or terminal consumption. Remain in draft review pending approval.

## Proposed amendment PC-ECON/2-A01 — Growth-and-above redemption eligibility (non-activating)

**Latest proposed eligibility overlay (not operationally frozen):** [PC-ECON/2-A01](../SPLIT-07/PC_ECON2_A01_GROWTH_AND_ABOVE_REDEMPTION_ELIGIBILITY.md) restricts **redemption** to provider-verified **Growth** and **Business** monthly USD subscriptions. **Starter may earn and retain**, but cannot redeem until eligible; **Free is excluded**; **Enterprise remains unapproved** until a separately negotiated policy. The plan-specific thresholds in the historical proposal tables above are illustrative economics, **not** Starter redemption authorization.

Earning remains tied to the provider-verified historical tier at fulfillment; redemption requires a separate provider-authoritative eligible tier at the applicable invoice benefit-application instant. Upgrades/downgrades do not reprice, reset expiry, or invalidate already-finalized discounts. Maintain all 0041/0042/0044 write-denial guards, fail-closed status, original PC-ECON/1 behavior, and independent Split 07/08 ownership. This is a **documentation-only amendment**, not economic activation.
