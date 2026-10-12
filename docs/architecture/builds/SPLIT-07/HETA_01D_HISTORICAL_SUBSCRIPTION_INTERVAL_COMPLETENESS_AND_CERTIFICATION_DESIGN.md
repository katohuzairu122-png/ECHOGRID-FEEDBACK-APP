# HETA-01D — Historical Subscription Interval Completeness and Certification Design

**Status:** Proposed architecture specification; documentation-only; NON-ACTIVATING.
**Audited baseline:** main @ `eec1ffc967c1f130c35a4891999d0e4a34b35c0d`, incorporating merged HETA-01B (#127) and HETA-01C (#128).
**Disposition:** Independent architecture/security/economic review required before implementation. Merge of predecessor documentation is not evidence of operational approval.
**Runtime authority remains:** `historicalTierVerified=false`, `issuanceAuthorized=false`, `redemptionAuthorized=false` wherever those contracts exist.

## 1. Decision and reconciliation

HETA-01B supplies proposed immutable provider capture and tenant binding. HETA-01C classifies candidate provider effective-time sources; none is unconditionally proved for this deployment. HETA-01D defines a separate logical completeness certificate. Authenticity, exact transition boundaries, and absence of omitted transitions are three separate obligations. None implies the others.

A certificate describes a finite, identity-bound historical window and evidence revision only. Its logical state may be certified without authorizing a runtime positive tier result or financial action. This document introduces no reader, API, schema, migration, configuration or activation.

Normative predecessor references:
- [HETA-01B](HETA_01B_IMMUTABLE_SUBSCRIPTION_IDENTITY_AND_PROVIDER_EVENT_CAPTURE_CONTRACT.md): account/mode/event deduplication, immutable binding, quarantine, independent current projection.
- [HETA-01C](HETA_01C_STRIPE_SUBSCRIPTION_EFFECTIVE_TIME_AUTHORITY_DESIGN.md): source classification, transition receipt candidates, uncertain boundary denial.
- [PC-ECON/2-A01](PC_ECON2_A01_GROWTH_AND_ABOVE_REDEMPTION_ELIGIBILITY.md): proposed earning and redemption eligibility are independent; not an operational policy.
- [Historical tier/accounting reconciliation](HISTORICAL_TIER_AUTHORITY_MULTI_UNIT_ACCOUNTING_RECONCILIATION_DRAFT.md): immutable fulfillment snapshot, business-wide cap and separate accounting gates.

PC-ECON/1 is untouched. Proposed PC-ECON/2 earning rates remain Free 0, Starter 3, Growth 2, Business 1; Enterprise unresolved. Starter earning does not permit redemption; only Growth/Business are proposed standard redemption tiers. Preserve the ten whole-unit business-wide UTC monthly earning cap, whole-award rejection, 14-day vest, 12-calendar-month post-vest expiry, no backfill/repricing, and separate USD monthly 30% full-threshold invoice rules. Certification cannot approve any of these proposals.

## 2. Audited implementation and compatibility boundary

At the baseline:
- BillingService creates Checkout and Portal sessions; external Portal, Dashboard, API and schedule modification paths are not exhaustively inventoried by repository code.
- stripe-webhook.routes.ts verifies the raw signature, runs the mutable mirror update, then records an observation. This is not the proposed HETA-01B durable original-event inbox.
- stripe-subscription-history.recorder.ts may skip events lacking a matching current mirror, supports only three subscription event types and one item, and deduplicates by event ID alone. Its retained subscription object is not the complete original event envelope/account-mode conflict contract.
- stripe-webhook.service.ts updates current state; its metadata plan fallback and arrival-dependent mirror cannot establish historical ownership, ordering or price.
- HistoricalSubscriptionTierReader reads at most 100 business observations and always denies authority. A truncated query cannot establish completeness.
- ProviderSubscriptionEventReconciler corroborates individual events and still returns EFFECTIVE_WINDOW_UNPROVEN.
- assessPriceTimeline, reconstructSchedulePriceIntervals, stripe-subscription-change.evidence.ts and reviewHistoricalEffectiveTimeAuthority remain candidate/screening contracts. Contiguous schedule phases, corroboration flags, immutable receipts and a caller's completeFromSubscriptionInception boolean do not establish completeness.

These limitations are explicit compatibility gaps for later approved work, not changes made here. Migration 0043 observations remain unchanged and must not be relabeled certified.

## 3. Identity and scope contract (logical fields only)

Each assessment binds:
- Provider, Stripe account, test/live mode, business ID, immutable binding revision, Customer ID, Subscription ID, subscription item ID and verified subscription lifecycle.
- Requested coverage window W = [from,to), source precision/time basis, evidence cutoff and manifest revision; from < to and both finite UTC instants.
- Versioned historical Price-to-plan mapping, currency, billing interval, quantity/item cardinality, status, trial/payment contingencies and eligibility exclusions.
- Original authenticated capture references/digests, provider retrieval/operation references, HETA-01C rule/API version and independently adjudicated executed transition receipts.

Do not combine accounts/modes, businesses, replacement subscriptions or items. Subscription replacement requires separate lifecycle evidence and proof of a unique applicable subscription for the business at the query instant; overlapping subscriptions must not be resolved by selecting the latest mirror. Multiple items are unsupported until a separate contract defines them. Metadata, user claims and current catalog values cannot repair identity or historical mapping.

Binding inception/end must itself be proven. No arbitrary reset or later checkpoint may erase unproved prior history. The default proof starts at verified subscription inception and follows the chain through W. A later trusted anchor could support only a bounded suffix if a separately reviewed provider mechanism proves its complete initial state and the entire subsequent mutation history; no such mechanism is approved here.

## 4. Provider effective boundary obligations

Carry forward HETA-01C classifications for Checkout creation/activation, immediate updates, payment-dependent pending application/expiry, Portal changes, Dashboard/external API edits, schedule execution/release/edit and actual cancellation. Include status, trial, quantity/item and eligibility changes even when Price ID does not change.

Each executed transition must prove identity, before/after state, correlation and exact effective boundary under a validated provider rule. Request/response time, event.created, receivedAt, period start/end, invoice paid, cancellation intent and future schedule dates are not substitutes. Pending/expired changes do not become applied tiers.

Record provider precision and uncertainty explicitly. If a transition is only known to lie within a range, do not invent an exact point or round fulfillment time to seconds. Any query whose ordering is unresolved fails closed. Equal timestamps require proven execution order or equivalent consistent final state; event IDs and receipt order are not tie-break authorities. A same-instant chain may produce one final state only when its ordering is independently proven.

## 5. Trustworthy coverage and completeness proof

A proposed certificate requires a reproducible proof bundle, not a boolean:
1. Immutable identity/lifecycle and independently verified initial state.
2. A complete inventory of enabled mutation surfaces throughout W and its required predecessor history: Checkout, Portal, Dashboard, every API credential/integration, schedules and payment-driven/status operations. Capture configuration/permission changes with provenance. An unknown or unobservable path defeats proof.
3. Source-by-source coverage attestations demonstrating why every relevant executed transition is included, including failed capture, processing backlogs, outages, quarantines and delayed delivery. Evidence authenticity alone cannot establish absence.
4. Exhaustive reconciliation manifest: bounded retrieval scope, pages/cursors, API version, account/mode, retrieval cutoff, counts/digests, retry/error/truncation records and source limitations. Successful pagination or an empty event list is not a provider guarantee of complete mutation history.
5. Closed transition chain: independently proven inception/anchor, all intervening state changes, exact applicable boundaries and a justified upper coverage boundary. The proof includes changes affecting W even if received later.
6. Independent verification of manifest integrity, historical catalog mapping, no unresolved conflicts, and a deterministic interval partition/result tied to the proof digest and rule version.

A quiet period, matching start/end snapshots, no observed change, current provider fetch, event retention window, reconciliation success or local queue watermark alone cannot prove there was no intermediate change. A local watermark proves only local processing. No finite wait is declared provider finality.

A finite upper coverage boundary must have a documented source completeness guarantee covering transitions up to that boundary, including latency/retention semantics. This deployment has not established such a guarantee. If a source cannot prove absence of omitted updates, the assessment remains unproven/incomplete. Do not extrapolate the last known state to now, infinity or beyond the certified to boundary.

Late evidence triggers reassessment/supersession, never a promise of irreversible historical truth. Retrieval loss beyond retention is a coverage gap, not permission to synthesize history. Retained local events need independently proved capture continuity; HETA-01B durability alone is insufficient.

## 6. Nonoverlapping half-open intervals

For one scoped identity/revision, build state intervals [effectiveFrom,effectiveTo) only from independently executed boundaries. Store full relevant state, not Price ID alone. All intervals are finite, ordered and positive length; reject inverted/zero-length intervals. Adjacent intervals meet exactly; overlap is forbidden. Gaps remain explicit missing coverage, never filled by nearest observation.

For W, the union of validated state intervals must cover W exactly after clipping, with each instant represented once. Ineligible/canceled/trial states remain explicit states rather than deleted intervals. Do not merge adjacent equal-price intervals if status, mapping revision or eligibility differs; preserve all source references even where equivalent state permits coalescing.

At a proved boundary b, the old interval excludes b and the new interval includes b. For example Growth [a,b), Starter [b,c): fulfillment at b maps to Starter candidate state. Fulfillment at c is outside coverage. For uncertain b, neither half-open syntax nor rounding establishes the ordering.

Validate identity and full partition before querying from <= fulfilledAt < to. Require exactly one matching interval and a trustworthy Split 06 timestamp. A unique local candidate without completeness remains denied. A certificate for one bounded subwindow must not imply certification of the whole lifecycle or other windows.

## 7. Logical assessment states (all non-activating)

| State | Required meaning | Treatment |
| --- | --- | --- |
| certified | All identity, boundary, mapping, coverage and partition obligations independently validated for the explicit W and revision | Logical proof result only; runtime/economic flags stay false |
| incomplete | A known missing segment/source/page/capture, retention loss, unresolved backlog or unclosed chain prevents full proof | Enumerate affected ranges and required evidence; deny |
| conflicted | Incompatible authenticated identity, digest, state, boundary, mapping or interval claims remain unresolved | Quarantine conflicting references; deny affected assessment |
| unproven | Evidence exists or is absent but trustworthy semantics/absence guarantee/precision has not been established | Record unmet obligations; deny |

Retain all findings. For one aggregate assessment use conflicted before incomplete before unproven; certified requires no unresolved defect. Invalid input is rejected before trusted assessment. Unsupported states and unmapped prices remain explicit denial findings; they cannot be inferred eligible.

No public endpoint or caller-supplied certified value is defined. A future consumer would need trusted certificate identity, digest, current effective revision, exact query scope and independent verification under a separately approved runtime contract. Certification is not an award, reservation, invoice benefit, terminal consumption or permission to backfill.

## 8. Append-only audit and supersession

Proposed audit records carry assessment ID, scope, state, all reason codes, immutable evidence manifest/digest, rule/mapping/binding versions, reviewer provenance, assessedAt, cutoff, interval digest and supersedes references. Capture time, assessment time, provider effective time and Split 06 fulfillment time remain distinct.

Never edit/delete original authenticated evidence, earlier assessments or intervals to resolve conflict. Append resolution evidence and a new assessment. Supersession must reference the exact earlier revision and affected scope, prevent cycles/forks from yielding multiple effective certificates, and require serialized expected-head comparison in later implementation. Unresolved competing successors fail closed.

New contrary evidence can supersede certified with conflicted/incomplete/unproven. Preserve the prior result as historical audit only; future consumers must check effective revision and unresolved challenges. Scope reduction cannot hide a defect: explicitly invalidate the affected former scope and state any separately proved unaffected suffix/subwindow.

Do not rewrite immutable award snapshots or financial records. If later evidence contradicts a previously used certificate, record an incident and hand off to separately authorized Split 07/08 compensation/recovery rules. No automatic debit, re-award, repricing or restoration.

## 9. Proposed verification matrix (not implemented)

| Scenario | Expected proof behavior |
| --- | --- |
| Verified inception, complete observable mutation paths, exact executed receipts, finite closure | Logical certified only; authority flags false |
| Missing middle event, matching endpoints, upgrade then downgrade | incomplete if gap known; unproven if absence cannot be proved |
| All pages retrieved but source lacks completeness guarantee | unproven |
| Capture outage, skipped authentic event, retention loss, 100-row truncation | incomplete; no inferred continuity |
| Duplicate identical payload / same scoped ID differing digest | Idempotent proof / conflicted and quarantine |
| Late or reordered event; stale current mirror | Deterministic reassessment; supersession without original mutation |
| Portal config unknown, Dashboard/API bypass, schedule edited/released | unproven affected history |
| Pending unpaid/expired update, delayed applied update | No intent-based tier; require executed boundary/payment semantics |
| Same price but trial/status/item changes | Split state intervals; deny unsupported eligibility |
| Exact before/at/after boundary; seconds-vs-milliseconds uncertainty | Half-open unique candidate only when ordering proved |
| Gap, overlap, zero length, infinite tail, equal timestamp ambiguity | Deny partition or ordering |
| Account/mode/tenant mismatch, replacement subscriptions overlap | conflicted; no latest-subscription shortcut |
| Unknown historical Price mapping, annual/non-USD/multi-item/Enterprise | No approved economic eligibility |
| Concurrent supersession and certificate read; contradictory late evidence | One effective revision or fail closed; audit retained |
| Certificate replay across settlement/business/window/revision | Deny; preserve original Split 06 reference |
| Any logical state including certified | No code path or economic write authorized |

Later HETA-01E should include adversarial ordering/replay/failure tests and isolated provider experiments. HETA-01F requires independently approved additive persistence design and fresh disposable PostgreSQL checks; HETA-01G requires independent security/architecture/economic sign-off. These are proposals, not tests executed by this documentation PR.

## 10. Domain boundaries, guards and open gates

Split 06 solely owns verified settlement fulfillment/reversal and its timestamps. Billing/Split 08 supplies trusted provider evidence and independently verified invoice application/terminal consumption. Split 07 owns earning decisions, immutable policy/tier snapshots, cap, lots/ledger, vesting, expiry and compensation. HETA certification belongs at the provider evidence boundary and cannot assume either domain's financial authority. Branches share business identity/account. Customer loyalty, Community Points, settlement reimbursement and Partner Credits remain isolated.

Preserve migrations:
- **0041:** immutable published policy economics, zero-only inert account initialization, lot/projection mutation denial, ledger/award/recovery insertion denial.
- **0042:** inert reservation/application write denial and existing one-unit structural constraints; stored applied evidence alone is not terminal provider authority.
- **0044:** inert allocation/movement writes, exact multi-unit conservation and month-lock foundation; locking does not grant issuance/spending authority.

Never edit, disable, replace or bypass these guards through certification, flags, session settings or privileged application paths. No app code, SQL, config, migrations, Stripe operations or financial writes in this PR.

Open blockers before implementation:
1. Independently prove exact HETA-01C semantics for every enabled live mutation path and timestamp precision.
2. Establish a provider-backed completeness/closure mechanism; none is currently demonstrated. If impossible, affected historical windows remain denied.
3. Implement HETA-01B capture/binding gaps only in a separately authorized change, with compatibility/privacy/retention review.
4. Approve versioned mapping, unsupported-state dispositions, supersession concurrency and future consumer contracts.
5. Obtain independent architecture/security/economic review, then separate HETA-01E/F/G and explicit implementation/activation authorization.

**Stop boundary:** Documentation proposal only. Do not merge or implement automatically. CI success verifies repository checks, not historical proof, independent approval or financial activation.
