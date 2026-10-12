# ECHO GRID — PC-ECON/2-A01: Growth-and-Above Redemption Eligibility

**Status:** Proposed economic policy amendment; documentation-only; NOT operationally frozen, implemented or activated.  
**Authority:** Proposed amendment to PC-ECON/2-DRAFT only; does not alter frozen PC-ECON/1.  
**Scope:** Split 07 earning/credit eligibility boundary; Split 08 provider-authoritative invoice redemption.  
**Repository baseline:** `09182dd2a86748eec460d385b6d429de40dbecdb`.

## 1. Decision and plan matrix

The minimum **standard** subscription plan permitted to redeem vested Partner Credits is **Growth**. Earning and redeeming are independent eligibility decisions. Enterprise is **not** automatically entitled merely because it is commercially above Business.

| Standard plan | Proposed units per eligible, verified fulfilled orphan settlement | Eligible to redeem against monthly USD subscription fees? |
| --- | ---: | --- |
| Free | 0 | No |
| Starter | 3 | **No — earn and retain only** |
| Growth | 2 | **Yes, subject to independent Split 08/provider verification** |
| Business | 1 | **Yes, subject to independent Split 08/provider verification** |
| Enterprise | 0 until separate negotiated approval | **No until separate explicit approval** |

The proposed monthly **earning** cap remains 10 whole units per receiving business, across all branches and tier changes in a UTC month; no partial earning awards when the full tier award exceeds the cap. No retroactive awards, backfills, or repricing.

## 2. Eligibility times and immutable historical earning records

**Earning tier** is the provider-authoritatively verified paid tier effective at the actual Split 06 fulfillment instant. Split 07 must preserve the immutable earning-policy/tier snapshot, original units, fulfilled-at, vest-at, expiry, settlement reference, and evidence reference. Current subscription mirrors, `event.created`, subscription item period boundaries, or editable schedule phases cannot independently prove that historical tier.

**Redemption tier** is the independently provider-verified eligible tier **at the applicable Stripe invoice benefit-application time**, as defined by a separately frozen Split 08 terminal authority contract. Current plans, self-reported upgrade requests, cached price catalogs, invoice-paid indicators, and historical earning tier cannot confer redemption authority.

For any missing, ambiguous, conflicting, stale, incomplete or uncorroborated provider evidence, issuance and/or redemption must **fail closed**. This amendment does not itself establish the missing historical effective-time or invoice-application authority.

## 3. Upgrade, downgrade and expiry

- Starter to Growth/Business: existing **vested, unexpired, available, unreversed** units may be considered for **future** eligible invoice redemption; an upgrade alone never applies credits.
- Growth/Business to Starter/Free: deny any **new** redemption while ineligible; retain historical ledger and valid remaining units subject to normal expiry, recovery and suspension policy.
- Growth to Business, Business to Growth: do not alter previously earned units, vest/expiry dates, policy versions, or immutable evidence.
- Cancelled, inactive, trial, and unverified subscriptions: no new redemption authority until a separate approved contract expressly covers them.
- A later downgrade does not retroactively undo a previously provider-verified terminal discount. Refund/reversal and consumed-credit recovery follow separate Split 08 authority.
- Ineligible time does **not** pause, extend, or reset the existing 14-day vest and 12-calendar-month post-vest expiry.

## 4. Retained financial controls

PC-ECON/2-DRAFT retains the proposed noncash, nontransferable, nonwithdrawable **100 USD cents per unit** fee benefit, USD-only **monthly** eligible subscription fees, and at most **30%** of independently provider-confirmed eligible pre-tax fees. Full-threshold redemption only: `requiredUnits = floor((eligibleFeeCents * 30) / 10000)`; redeem exactly that positive whole-unit threshold only when enough vested, available, unexpired units exist, else redeem none. Remaining valid units carry until expiry. The actual eligible invoice amount, rather than cached catalog price, is authoritative.

Examples only (not provider-verified invoices): $29 Growth -> up to 8 whole units/$8; $59 Business -> up to 17 units/$17. The 10-unit **monthly earning** cap is **not** a lifetime or balance cap; example thresholds are only accessible if the business has accumulated enough unexpired units over time.

Enterprise negotiated eligibility, annual billing, tax sequencing, discounts, invoice proration, refunds, credits/notes, Stripe adjustment mechanism, and terminal consumption require separate explicit decisions. **No automatic Stripe writes, no cash balance, no points conversion.**

## 5. Architecture and non-activation safeguards

- Split 06 alone owns orphan settlement fulfillment/reversal authority.
- Split 07 alone owns partner enrollment, eligibility and earning decisions, lot/ledger state, vesting, expiry and compensating recovery. Branches share one business credit account; no business may self-issue or mutate another business's ledger.
- Split 08 alone owns verified subscription invoice eligibility, Stripe economic application, provider-side discount attribution, and terminal consumption/reconciliation.
- Business loyalty and Community Points remain segregated; Partner Credits are not settlement reimbursement.
- Preserve migrations **0041, 0042, 0044** and all their economic write-denial triggers; do not enable issuance, allocation movements, redemption, Stripe financial writes, trigger removal, migration, retroactive awards, or production configuration by this document.
- PC-ECON/1 is untouched. PC-ECON/2-A01 is a **proposal overlay** for future policy approval only and must not be mistaken for an operational rule.

## 6. Future acceptance gates (not authorized by this PR)

1. Policy owner signs off the Growth/Business-only redemption rule and explicit Enterprise, annual/trial, cancellation and invoice edge-case dispositions.
2. Independently prove complete historical tier effective-time authority at fulfillment; immutable trusted observations and replays/races fail closed.
3. Implement and test atomically committed 2/3-unit awards with business-wide cap, conservation, idempotency, concurrency, reversals, and 14-day vest/12-month expiry under a separately approved activation design.
4. Split 08 independently proves the eligible effective provider tier and applicable USD invoice fee, 30% threshold, unique terminal attribution, no partial redemption, refunds/reversals, and race-safe recovery.
5. Re-run fresh CI, disposable PostgreSQL integration, economic/security review, architecture guardrail acceptance, and obtain explicit separate financial activation approval.

**Disposition:** Documentation policy candidate only. `historicalTierVerified=false`, `issuanceAuthorized=false`, `redemptionAuthorized=false` continue to fail closed where defined. No production financial activation.
