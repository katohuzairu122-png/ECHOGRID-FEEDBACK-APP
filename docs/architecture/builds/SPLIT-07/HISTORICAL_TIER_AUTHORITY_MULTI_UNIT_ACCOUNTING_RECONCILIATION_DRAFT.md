# Split 07/08 — Historical Tier Authority & Multi-Unit Partner Credit Accounting Reconciliation

**Status:** DRAFT architecture reconciliation only; **not** PC-ECON/2 approval, economic implementation, migration, or activation.
**Inspected base:** `main` at `6d296ed06081306b5159439bbbe7fd51433ac939` (PR #107 merged; its branch CI passed, post-merge main CI pending during inspection).
**Domain ownership:** Split 06 owns authoritative orphan settlement/fulfillment/reversal; Split 07 owns Partner Credit decisions/accounts/lots/ledger/vesting/expiry/recovery; Split 08 owns subscription invoice benefit, Stripe provider reconciliation, and terminal consumption. Stripe owns invoice/payment truth.

## 1. Economic contracts that MUST remain unchanged

PC-ECON/1 retains exactly one unit/award until separately superseded by a signed policy and migration gate. PC-ECON/2-DRAFT proposes Starter = 3, Growth = 2, Business = 1 whole units per verified fulfilled settlement; Free excluded; Enterprise unresolved; UTC business-wide earning cap = 10 **units**, not ten awards. No partial award when the full 2/3-unit earning would exceed cap. Tier and rate snapshot at actual fulfillment (not award execution), 14-day vest, 12-calendar-month post-vest expiry, no historical repricing/backfill, no inter-business transfer, no cash or Community Points exchange. Proposed USD 100 cents/unit and whole-threshold redemption <= 30% of independently verified pre-tax eligible monthly subscription fee, only on explicit business request. Unresolved annual, trial, tax, refund, provider discount application and Enterprise policy MUST fail closed.

## 2. Inspected authority gap and required immutable evidence

`business_subscriptions` is a mutable Stripe webhook mirror, with one row per business. `StripeWebhookService` performs an absolute-state upsert using `customer.subscription.*`; the webhook service comments acknowledge out-of-order event overwrite risk. Thus neither its current `plan_id` nor a current Stripe subscription fetch can independently prove a historical plan/tier at a past Split 06 fulfillment timestamp.

**Proposed authority boundary (design, not implemented):**
1. Split 06 supplies settlement ID, receiving business ID, immutable fulfillment event ID and trusted occurred-at UTC instant after verification under the settlement-first transaction lock.
2. Split 08 independently attests a provider-backed subscription price/tier effective at *that instant*. Candidate inputs include a verified persisted provider subscription-change timeline with each Stripe subscription item/price ID and effective period, source event ID plus event-created UTC, provider object identity and actual observed effective timestamps, business/customer identity, currency/interval/status, effective-window provenance, and reconciliation/retrieval timestamp. Stripe event receipt time alone is **not** price-effective time. A latest subscription state is **not** a historical timeline.
3. Split 07 persists an append-only award-tier evidence record tied one-to-one to the settlement/decision, with settlement fulfillment event ID/time, business/subscription/customer/price/plan identifiers, authenticated source evidence references, effective window, policy version, proposed rate, resulting decision units and verification result. Reject snapshot replay across businesses or fulfillment references. Freeze it as part of award decision atomicity.
4. Require trustworthy coverage for the fulfillment instant with a single effective price, non-overlapping provider windows and no unresolved delayed/out-of-order change events. Validate authoritative plan catalog mapping to price ID at the event instant (not editable current catalog pricing), paid active eligibility, approved monthly USD interval and no ineligible trial. Where Stripe cannot establish an exact retroactive effective window, **deny issuance**; never infer from the webhook receipt time, mutable mirror or client state.
5. Distinguish verified historical tier evidence from immutable business rate snapshot; snapshot is the result of verification, not a standalone authority. Persist a digest/version and audit reference for reconciliation, not merely `historicalTierVerified: true` caller input.

**Decision still needed:** whether fulfillment-time verified provider evidence must be captured synchronously versus allowing delayed awards from a complete provider change timeline. The latter must fail closed on unprovable historical intervals, and no speculative awards/backfills are permitted.

## 3. One-unit assumptions discovered (source audit)

| Component | Current limitation | Required redesign before execution |
|---|---|---|
| `partner-provisional-award.planner.ts` | `policy.awardUnits !== 1`; emits one unit | Verified historical tier rate, business-wide ten-unit whole-award cap under transaction lock |
| `partner-provisional-award.service.ts` | `AwardResult.units: 1`, fixed decision/lot/provisional ledger/account +1; replay expects 1 | Immutable tier evidence; decision, lot, ledger and provisional projection in **N** units; replay checks captured policy/rate rather than current tier |
| `partner-credit-lifecycle.service.ts` | Vest checks unit=1 and updates account +/-1; expire requires exactly one available unit | Vest N units, apply recovery offsets, expire precisely eligible unencumbered remainder without destroying consumed/reserved history |
| `partner-recovery-offset.service.ts` | Calls multi-unit-capable `planPartnerRecoveryOffset` with `newlyVestingUnits:1` | Pass actual N; deterministic FIFO debt allocation, no negative debt or available balance |
| `partner-provisional-reversal.compensator.ts` | Requires unit=1 and entire lot unencumbered | Atomic reversal of unencumbered remainder; provider-confirmed consumed portion requires a separately authorized recovery obligation, never an implicit reclaim |
| `partner-credit-reservation.service.ts` | `availableUnits === 1`; reserves one lot and decrements one unit | Whole-invoice threshold allocation across multiple lots, deterministic FIFO/expiry priority and per-lot unit allocations |
| `partner_credit_lots` schema | One lot/decision; status enum is whole-lot, `available_units` is partial projection only | Per-lot conservation components; explicit available/reserved/consumed/expired/reversed/recovered allocations or equivalent subledger |
| `partner_credit_reservations` migration 0042 | Unique `lot_id`; `units = 1`; unique business/invoice intent | Parent invoice-intent reservation plus distinct per-lot allocations, with unique active allocation/idempotency constraints; no overlapping claims |
| `billing_partner_credit_applications` migration 0042 | `units_applied = 1`, single reservation | Provider-attested whole-threshold multi-unit evidence; atomic terminal consuming of exact allocations once only |
| `partner_credit_policies` schema | Single `award_units` field; published economics immutable | Separate versioned tier-rate mapping/snapshot; do not mutate existing published PC-ECON/1 values |
| `partner_credit_ledger` schema | Signed integer exists but no visible reservation/consume entries in entry-type check | Typed append-only multi-unit movement categories and reconciliation; separately reviewed migration required |

`partner-recovery-offset.plan.ts` already accepts integer `newlyVestingUnits`, but its caller remains hardcoded to 1. Integer SQL fields **do not** prove the surrounding state machine supports multi-unit partial allocation.

## 4. Required accounting invariants (proposed contract)

Represent each immutable N-unit lot via nonnegative, disjoint unit buckets; at any time:

`issued_N = provisional + available + reserved + consumed + expired + reversed + recovery_offset_applied`

This is **a proposed canonical allocation accounting model**, not an assertion that current schema already implements these buckets. A bucket transition moves N units exactly once, with append-only typed events; avoid double counting vested units or reversal/recovery offsets. If recovery offsets are represented as consumed rather than a separate terminal bucket, define one representation and prove the same conservation invariant without duplicates.

Business account projections must equal the sum of the matching per-lot states under the same transaction boundary; recovery_due tracks unpaid recovery obligations separately and may not be treated as spendable credit. Successful vesting moves provisional N into available `N - offset`; recovery offsets satisfy FIFO obligation units exactly once. Expiry only moves unreserved, unconsumed, unexpired available units; reserve moves available to reserved per allocation; successful provider-authorized terminal application moves reserved to consumed; failed/expired invoice release returns eligible units to available **only if** still unexpired and provider-confirmed unused, otherwise to expired. A consumed amount never becomes available through replay.

**Important reversal nuance:** do not mark an entire 3-unit lot reversed while one of its units is consumed/reserved. Reverse only unencumbered allocations; an already consumed portion requires provider-authorized recovery evidence or a hold, not a second ledger debit. Reservation-vs-reversal requires an explicit serialized conflict policy. Current `partnerCreditAwardDecisions.state` is coarse and cannot alone describe partially reversed multi-unit positions.

Monthly cap: for a given business and UTC month, serialize awards across branches via existing business-row lock, sum historically **issued/awarded** positive award decisions (including subsequently reversed awards unless an explicit different policy is approved), require `used + N <= 10`, and reject the entire candidate otherwise. Document the treatment of reversal relative to cap as a policy approval question; do not silently recycle reversed cap units. Immutable award snapshots protect upgrade/downgrade replay.

## 5. Safe transactional design and idempotency

Global order: Split 06 settlement lock -> claim/fulfillment/reversal verification -> business lock for cap -> decision -> lots in deterministic order -> account -> reservation/application and obligation rows in stable order. Review against existing Split 06 reversal and Split 08 flows before finalizing lock order; never introduce contradictory reverse lock acquisition.

- One business + settlement = at most one award decision and immutable tier snapshot; competing fulfillment, reversal and award transactions serialize, with idempotency keys checked on exact immutable payloads.
- One invoice-intent + business = at most one reservation parent; per-lot allocation unique to that parent, sum allocated units equals full threshold; no partial application if threshold unmet.
- Expiry/recovery/consumption writes lock every affected lot, check nonnegative balances and compare version/ledger event uniqueness; no optimistic stale balances.
- Receipt of Stripe webhook, invoice status `paid`, or local application record **alone** never authorizes consumption. Require provider-confirmed actual benefit attribution and verified eligible USD fee/discount math; consumption only once on terminal confirmation.
- Use a new additive, reviewed migration for any new evidence and allocation tables, policy mapping, and triggers. **Never edit published 0041/0042 migration history or remove their deny-write protections in this block.**

## 6. Required verification matrix before any later activation

1. Tier change immediately before/at/after fulfillment; asynchronous webhook delivery; duplicate/out-of-order provider events; ambiguous overlap or missing historical coverage -> reject.
2. Business/customer/subscription/price mismatch; unknown price, multiple subscription items, unpaid/canceled/trial period, non-USD/annual/Enterprise -> reject unless separately authorized.
3. Under cap: Starter at 7 -> 10 allowed, at 8 -> whole 3-unit award rejected; Growth at 9 -> whole 2-unit award rejected; cap concurrent across branches and tier changes.
4. Vesting 3 with recovery due 0/1/2/3/>3; expiry with 3/2/1/0 available units and concurrent reservation; no negative projection or lost unit.
5. Full-threshold reservation spreads across lots and rejects partial balance; one lot reused on multiple invoices; duplicate/reordered requests; simultaneous reversal/expiry/reserve/release/consume.
6. Provider success/failure/late reversal/refund vs local atomic terminal transition; no 2x consumption or spendable credit returned after provider-applied benefit.
7. PostgreSQL 16 on fresh migrated disposable database, real concurrent transactions and trigger checks, re-run CI typecheck/tests, independent financial/provider review.

## 7. Architecture decisions / explicit gates still open

- Approve historical effective-window evidence source and how to handle unprovable retroactive Stripe tier changes.
- Resolve policy interpretation for monthly cap consumption following a later reversal, and whether ineligible decisions reserve cap (proposed: only units actually awarded count).
- Approve per-lot bucket model vs an immutable per-unit allocation/event model; define terminal partial reversal semantics and ledger event taxonomy.
- Approve multi-lot full-invoice threshold reservations and terminal provider adjustment mechanism with refund/tax treatment.
- Formally approve PC-ECON/2 tier mapping and provider billing treatment; test new migration in isolated PostgreSQL and audit 0041/0042 protections before separate activation authorization.

**Disposition:** Reconciliation review artifact only. No implementation of tier reader, new tables, issuance, reservation, provider writes, migrations, guard removal, or production activation. Stop at this block for architecture sign-off.
