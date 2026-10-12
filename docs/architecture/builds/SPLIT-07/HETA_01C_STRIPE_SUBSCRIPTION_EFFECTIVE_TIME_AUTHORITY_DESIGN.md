# HETA-01C — Stripe Subscription Price Effective-Time Authority Design

**ECHO GRID | Architecture proposal only | NON-ACTIVATING**  
**Baseline:** `main` at `e5781f13c5cc876fab7ee97c767b020a901a4a26` (HETA-01B merged).  
**Scope:** Stripe price/tier transition effective-time source classification and future verification contract.  
**No approval:** This design does not authorize implementation, positive historical tier results, credits, financial writes, migrations or activation.

## 1. Decision

At the authoritative Split 06 settlement `fulfilledAt` instant, a paid tier may be inferred **only** from an independently validated Stripe Price-to-plan mapping and an authenticated, identity-bound, complete historical price-effective interval. Do not substitute request time, event delivery time, `event.created`, customer portal navigation, Checkout Session creation, billing period boundaries or a current schedule phase for the price's actual effective time. If exact ordering against `fulfilledAt` is uncertain, return unverified.

HETA-01B defines signed-event capture, tenant-bound subscription identity, quarantine and replay-proof provenance. HETA-01C defines which provider operations may supply candidate effective-time evidence. **HETA-01D must independently certify interval completeness** before any positive result. A candidate receipt is not an award.

## 2. Audited ECHO GRID surfaces

- `apps/api/src/billing/billing.service.ts`: creates Stripe Checkout Sessions in subscription mode and Customer Portal sessions; never directly calls Stripe subscription update or schedule APIs. The Portal configuration, including enabled updates and scheduling, is external.
- `apps/api/src/billing/stripe-webhook.routes.ts`: verifies raw-body Stripe signature, processes subscription event, then records a subscription observation. Existing evidence pipeline is not immutable original-event inbox as proposed in HETA-01B.
- `apps/api/src/billing/stripe-webhook.service.ts`: upserts latest state for `customer.subscription.created/updated/deleted`; may use stale metadata `planId` fallback when Price ID mapping is absent. Neither mirror value nor that fallback is historical tier authority.
- `apps/api/src/billing/stripe-subscription-history.recorder.ts` and migration 0043: append-only signed-event observations conditional on matching mutable mirror, not proof of exact price-effective windows.
- `apps/api/src/partner-credits/historical-effective-time-authority.review.ts`: expressly rejects all input as historical authority. Existing read-only provider-history reconciliation likewise fails closed.
- No dedicated ECHO GRID Stripe subscription schedule mutation integration identified in the code audit; external Dashboard/Portal/API changes remain possible and must be inventoried from actual Stripe configuration before certification.

## 3. Source-by-source classification and evidence rule

| Provider change surface | Actual semantics / evidence caveat | HETA-01C finding |
| --- | --- | --- |
| New subscription via Checkout | Creating a session is intent, not subscription activation. Correlate completed workflow to created subscription, verified Customer/Subscription/Price and status, including any payment contingencies. | **Conditionally provable** only with certified provider creation/activation boundary and HETA-01D coverage. |
| Immediate subscription Price update | A Stripe update response/current state confirms an outcome, but request and response timestamps are not automatically exact effective-time authority. Proration or billing anchor may differ from activation. | **Conditionally provable** if supported provider operation semantics can prove a definite transition instant and persisted before/after states. |
| `pending_if_incomplete` / payment-dependent update | Subscription `pending_update` is not applied until required invoice payment; `customer.subscription.pending_update_applied` and `...expired` distinguish application/expiry events, not automatically exact microsecond boundaries. | **Conditionally provable** only with evidence of actual applied transition; pending or expired proposal is not a new effective tier. |
| Customer Portal upgrade/downgrade | Portal configuration controls whether changes are enabled, immediate or scheduled at period end. Live Portal configuration is not in repository. | **Unproven in this deployment** until config and each transition mechanism are audited; then conditional on verified source. |
| Stripe Dashboard/external API update | Changes may bypass ECHO GRID and lack HETA's provider-transition receipts. | **Unproven in this deployment**, reject affected windows absent complete independently corroborated evidence. |
| Subscription schedule | Schedule phases express intended dates; a schedule may be updated or released, and current phase representation is not immutable executed history. | **Conditionally provable** only with independently captured executed transition and completeness; future phase alone denied. |
| Renewal/billing-period boundary | Item `current_period_start/end` are item billing windows, not general plan-effective boundaries. | **Not sufficient alone** to certify tier transition. |
| Cancellation or cancel-at-period-end | `cancel_at_period_end` is intent until effective termination; historical provider state and actual cancellation proof must distinguish them. | **Conditionally provable** for termination boundary; date field alone not enough for all scenarios. |
| Retained provider event list | Stripe events listing provides up to approximately 30 days, and event `created` is an event timestamp. | **Insufficient alone** for full historical completeness or price-effective time. |

No source is labeled unconditionally proved for this deployment. Stripe API behavior and account configuration require explicit provider-version, test-mode and live-mode verification before implementation.

## 4. Proposed transition receipt contract

Logical fields only; **no SQL schema design approval**:

- `stripeAccountId`, `livemode`, verified `businessId`, `stripeCustomerId`, `stripeSubscriptionId`, provider `subscriptionItemId`.
- `previousPriceId`, `newPriceId`, currency and interval, mapped versioned ECHO GRID plan key; fail if unknown, ambiguous or mismatched.
- `transitionKind`: creation, immediate price update, pending applied/expired, schedule executed, cancellation, renewal/status transition.
- Distinct `requestedAt`, `providerEventCreatedAt`, `receivedAt`, `effectiveAtCandidate`, `effectiveAtAuthorityType`; never treat timestamps as synonyms.
- References to original signed event in HETA-01B, provider operation/receipt, transition correlation IDs, before/after subscription snapshots, payment dependency evidence if relevant, and the documentation/API-version rule under which `effectiveAtCandidate` is meaningful.
- Explicit `authorityState`: `candidate`, `unproven`, `conflicted`, `rejected`; immutable source records, append-only adjudication. **No `certified` outcome under HETA-01C alone.**
- `historyCoverageState` must remain `unproven` until HETA-01D validates continuity from a trusted beginning through `fulfilledAt`, including external modification surfaces.

Only HETA-01D may later produce exact non-overlapping half-open intervals `[effectiveFrom, effectiveTo)`, supported by actual executed transitions, complete coverage and deterministic boundary treatment. Existing historical reader remains `historicalTierVerified:false` and `issuanceAuthorized:false`.

## 5. Required future experiments and acceptance tests

Test against an isolated Stripe test account/configuration and isolated application database only, with traceable provider receipts; do not use a live financial account to test transitions.

1. Checkout started vs subscription created/active, first payment incomplete, abandoned Checkout and delayed fulfillment.
2. Mid-cycle Starter→Growth and Growth→Starter with immediate update, proration variation and independently verified before/after state.
3. Pending update: unpaid, paid-and-applied, expired, delayed payment and duplicate notification. Neither pending nor expired case may retroactively change earning tier.
4. Portal update enabled/disabled, immediate and scheduled variants; confirm actual configuration and recorded execution boundary.
5. Dashboard/manual API edits, out-of-band updates and unfamiliar webhook origin; never silently mark complete.
6. Schedule altered, released, executed, canceled and phase edited after initial creation; intended phase timestamp alone never grants historical proof.
7. Late, duplicate, reordered and missing webhooks, event retention gaps and DB outage/recovery.
8. Price/customer/subscription/account/test-live mismatch; multi-item unsupported cases; stale metadata `planId`.
9. Settlement fulfillment exactly on or near candidate transition time, including timestamp resolution mismatch; ambiguous ordering fails closed.
10. Multiple tier changes within one billing period; no period-start shortcut, no overlap/gap, no later repricing of earlier settlement.
11. Verify the provider API version in use, event payload version, webhooks enabled, Portal rules, external administrator/API permissions and actual available provider-side transition evidence.

**Pass criterion:** An independently reviewed source-classification evidence matrix with precise trusted timestamp semantics, verified operation identity and negative-path behavior for every enabled modification path. **Not a positive issuance test.** If any supported operation cannot yield an exact authoritative time, affected intervals remain unprovable.

## 6. Source references and limitations

Stripe documentation reviewed:
- Event listing (approximately 30-day window): https://docs.stripe.com/api/events/list
- Event object (timestamp and immutable event-data representation): https://docs.stripe.com/api/events/object
- Subscription `pending_update` (payment contingent): https://docs.stripe.com/api/subscriptions/object
- Pending-update applied/expired events: https://docs.stripe.com/api/events/types
- Portal configuration (immediate vs scheduled updates): https://docs.stripe.com/api/customer_portal/configurations/create
- Schedule edits and phases: https://docs.stripe.com/api/subscription_schedules/update
- Item-level period migration: https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end

These documents describe available Stripe semantics but **do not attest** to ECHO GRID's specific live Stripe account setup or prove that a response/event timestamp is a universal exact effective-time receipt. The relevant Stripe API version and account-level enabled features must be verified independently.

## 7. Domain and economic guardrails

Split 06 owns settlement fulfillment/reversal timestamps. HETA-01B/C own only provider evidence capture/classification. Split 07 retains earning, vesting, expiry and recovery; historical tier verified is only one separately approved input to issuance. Split 08 alone owns Stripe billing application and provider-verified terminal credit consumption; PC-ECON/2-A01 proposes redemption for Growth/Business only, not Starter, Free or unapproved Enterprise. Customer loyalty and Community Points remain separate.

Retain PC-ECON/1 and all financial write-denial triggers from migrations **0041, 0042 and 0044**. No change to economic source of truth, tenant/RBAC, current migrations, financial tables, product behavior or production configuration. No tier certification, Partner Credit issuance, reservation, credit consumption, Stripe invoice adjustment or production activation is authorized by this document.

**Review disposition requested:** Documentation-only architecture proposal; after doc-scope and CI verification, obtain independent architecture/security/economic review before merging. Stop before HETA-01D or implementation.
