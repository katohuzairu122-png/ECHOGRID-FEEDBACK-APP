# Split 07/08 — Progressive Partner Credit Earning & Redemption Economic Freeze Review

**State: draft economic amendment PC-ECON/2-DRAFT; NOT active, NOT executable.**
The user-approved strategic rules are: lower subscription tier receives more units per qualifying fulfilled orphan settlement; take the active tier at fulfillment as the immutable historical source, $1 USD per credit, business-requested full-threshold redemption, no more than 30% of eligible subscription fees discounted (at least 70% before applicable taxes paid).

## Actual platform catalog and proposal
Source: `apps/api/src/billing/subscription-catalog.ts`, not earlier illustrative prices.

| Plan key | Cached monthly USD | Candidate credits/settlement | Full-threshold max 30%-capped monthly units |
|--|--:|--:|--:|
| free | $0 | 0; ineligible | none |
| starter | $9 | 3 | 2 (max $2 discount; $7 remaining) |
| growth | $29 | 2 | 8 (max $8 discount; $21 remaining) |
| business | $59 | 1 | 17 (max $17 discount; $42 remaining) |
| enterprise | custom/uncertain | 0 pending negotiated contract | none |

Rates are **proposed mapping pending explicit sign-off**; no hardcoded rates are wired to the award service, billing or Stripe. Yearly invoices are excluded from this proposed quote until there is a separately authorized yearly-fee and tax rule. Monthly nominal catalog prices are not proof of a real Stripe invoice's eligible fee. $1 credit means 100 cents against eligible USD subscription fees only.

## Award rules to freeze
- One successful, independently authorized Split 06 fulfilled orphan settlement remains the earning event. Receiving business subscription's **historically active paid tier at the actual fulfillment time** determines rate; do not use current subscription after a plan change.
- Snapshot immutably: businessId, settlementRef, subscriptionId, planId, planKey, stripePriceId, stripeSubscriptionId, stripeCustomerId, billingInterval, actual fulfillment timestamp, provider-verified tier-effective period, policyVersion, earningRateUnits, earningMonthUtc, and normalized evidence reference. A current subscription mirror cannot reconstruct historical price/tier; a provider-reconciled historical subscription-period record or durable, verified fulfillment snapshot is required.
- Existing **10 units** per business per UTC month cap remains unchanged pending separately approved amendment. An award of 3 units when 8 are already earned **fails whole-award** rather than silently issuing 2 units. Cap is calculated by SUM(award_units), across all business branches.
- Preserve 14-day vest and 12-month post-vest expiry; credit values and earning snapshots may not be silently recomputed after upgrades/downgrades. Never backfill or retroactively mutate awards.
- Mandatory multi-unit structural redesign before economic execution: provisional decision unit contracts, policy schema, positive lot and available-unit balance, ledger original and negative compensation, multi-unit FIFO recovery/vesting/expiry, 0041 guards, settlement reversal, reservation lot split (current one reservation per lot and units=1), and idempotent invoice application. Existing one-unit PC-ECON/1 SQL/TypeScript MUST NOT be casually made to mint 2/3 units. Review conservation invariants, monthly cap concurrent branches and unit tests under disposable PostgreSQL.

## Redemption rules to freeze
- Every vested, unexpired, available credit corresponds to $1 USD of a **noncash, nonwithdrawable** eligible platform fee reduction.
- Maximum eligible discount in cents = floor(eligibleFeeCents × 30 / 100). The full-threshold count = floor(maxDiscountCents / 100) whole Partner Credits. No fractional unit.
- Business requests redemption only when at least that count is available; insufficient credits mean **no partial discount** and no consumption. Larger balances carry forward until expiration. If rounding leaves a fraction of $1, do not over-discount.
- The qualified Stripe invoice's actual eligible USD subscription-fee components, paid status, subscription/customer/business ownership, provider discount attribution, tax sequencing and pre/post-finalization amendment treatment must be independently reconciled. A calculated quote, cached plan price, paid invoice or application row is NOT provider application evidence.
- No cash-out, transfer, Community Points conversion or customer loyalty ledger use. Preserve invoice history; reversal of already applied credit requires independent terminal provider evidence and a separate future recovery obligation.

## Implementation disposition and remaining freeze gates
This PR adds **pure non-authorizing review helpers and tests only**. Each candidate returns `issuanceAuthorized:false` and each redemption quote returns `redemptionAuthorized:false`; snapshots explicitly return `historicalTierVerified:false`. No migration, API, Stripe write, terminal ledger, economic award, 0041/0042 trigger removal, live configuration or activation is performed.

**Blockers:** confirm tier mapping, agree exact whole-award cap rule and monthly-only eligibility, freeze Stripe tax/refund logic; then build immutable verified historical subscription-tier evidence and multi-unit ledger/lot/reversal design, full-threshold invoice application with provider proof and real PostgreSQL concurrency tests. Existing Split 07/08 completion freezes stay withheld.
