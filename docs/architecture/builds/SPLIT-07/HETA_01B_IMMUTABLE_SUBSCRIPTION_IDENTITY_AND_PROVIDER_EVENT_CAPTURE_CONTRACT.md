# HETA-01B — Immutable Subscription Identity and Provider Event Capture Contract

**ECHO GRID / Split 07–08 | Proposed, documentation-only, NON-ACTIVATING**  
**Baseline:** main @ `0e6d71842f071b614f095bf8faf6660dcce260eb`  
**No economic authorization:** `historicalTierVerified=false`, `issuanceAuthorized=false`; no credit redemption authority.

## Purpose and audited starting point

The current `stripe-webhook.routes.ts` verifies Stripe signatures, invokes `StripeWebhookService.processEvent` to update the mutable `business_subscriptions` mirror, then invokes `recordVerifiedStripeSubscriptionObservation`. The recorder requires identifiers to match that mutable mirror and may skip authentic yet unattributed events. The mirror upsert is not ordering-safe: a late older event may overwrite newer state. The recorder's migration-0043 observations are append-only candidates, **not** authoritative effective-time periods. `metadata.planId` is a read-mirror fallback, never provider-backed historical price authority.

The objective is reliable preservation and attributable provenance of subscription evidence, **not** certification of a tier at fulfillment or financial activation.

## Logical design (no schema or migration approved)

1. **Authenticated provider inbox.** Following Stripe raw-body signature verification, durably capture the event, original authenticated payload or lossless integrity-preserving representation, payload digest, Stripe account and livemode, event ID/type/API version, provider `event.created`, receipt timestamp, and verification provenance. Limit access to privileged billing/security services, protect sensitive provider data, and decide retention/deletion lawfully before implementation. No successful durable-capture acknowledgement until the database commit succeeds.
2. **Immutable tenant binding.** Independently associate Stripe account/mode, Customer ID, Subscription ID, ECHO GRID business ID, ownership evidence, creation/end of binding and provenance. A subscription must not be rebound across businesses using `metadata.businessId` alone. Bootstrap new Checkout subscriptions and provider-created/replacement subscriptions through separately reviewed verified bindings. All branches of a business share the business identity.
3. **Audited disposition stream.** Preserve the original event unchanged. Record append-only decisions such as `captured_unattributed`, `identity_verified`, `quarantined`, `reconciled_candidate`, `rejected_invalid`, with evidence IDs, reasons and processing time. Reassessment may promote quarantined data only after independent verification, never by editing authenticated original bytes.
4. **Safe current projection.** Updating `business_subscriptions` is separate from evidence capture and must not permit a late/stale webhook to roll the subscription backward. Neither event creation timestamp nor receipt order by itself establishes transition order; verify current state with supported provider semantics before projection. Maintain the existing tenant-scoped billing RBAC and external identifiers policy.
5. **No tier certification.** Provider event timestamps, subscription item period boundaries and editable schedules are insufficient alone to prove the exact price-effective time, especially for mid-cycle changes. Unknown intervals, gaps, conflicts and incomplete provider history fail closed.

## Mandatory identities and invariants

- Event deduplication key: **Stripe account + mode + event ID**. Identical replay is idempotent; same identity with conflicting digest is a quarantined security conflict, never a silent overwrite.
- Reject invalid signatures before accepting the event as trusted. Authenticated events with missing business/customer/subscription IDs, unknown price, unsupported/multi-item subscription, or cross-tenant/account/mode conflict should be **retained under restricted quarantine**, not assigned to a business or treated as an earning tier.
- Preserve distinct `event.created`, `receivedAt`, `processedAt`, independently provider-proven effective time (future gate), and Split 06 authoritative `fulfilledAt`. None is interchangeable.
- Distinguish successful durable capture from successful reconciliation. Retry transient failures safely and bound retries with operational visibility. The worker must not acknowledge durable capture before commitment.
- The current `stripe_subscription_tier_observations` table and migration 0043 remain unchanged until a separate additive compatibility migration is approved.
- No subscription metadata, current mirror, client-supplied evidence or retained Stripe event list may independently grant historical tier or issuance authority.

## Business/economic domain boundaries

**Split 06:** sole source of settlement fulfillment and reversal times. **HETA-01B/Stripe billing intake:** authentic event capture and tenant binding only. **Split 07:** earning/credit issuance decisions after independent historical tier certification and separate economic gate. **Split 08:** provider-authoritative invoice application and terminal redemption; PC-ECON/2-A01 limits proposed redemption to verified Growth and Business, not Starter, Free or unapproved Enterprise. Customer loyalty and Community Points remain isolated. No Stripe invoice write, credit mint/vest/reserve/redeem, backfill or cash conversion arises from an event.

**Never disable or bypass existing economic write-denial guards in migrations 0041, 0042 and 0044. PC-ECON/1 remains unchanged.**

## Required future test matrix

| Scenario | Expected |
| --- | --- |
| Valid event, independently verified tenant IDs | Immutable captured evidence; eligible for reconciliation only |
| Identical event replay | One canonical inbox record; no repeated financial effect |
| Same event ID, different payload | Quarantine and alert |
| Out-of-order webhook | Preserve original; do not roll back newer mirror |
| Event before mirror exists | Capture unattributed; later verified identity binding |
| Changed/replaced subscription | Retain both bindings with verified lifecycle |
| Misleading metadata/business/Customer or account/mode conflict | Quarantine, never cross-tenant assignment |
| Unknown Price or multiple items | Retain evidence, deny tier determination |
| Missing event/partial Stripe retention | Deny historical completeness |
| Invalid signature | Reject before trusted capture |
| Database commit failure | No acknowledgement of durable capture |
| Event/fulfillment on unproven transition boundary | Deny historical tier and award |

## Subsequent independent approval gates

**HETA-01C:** provider source-by-source price effective-time semantics (Checkout, Portal, Dashboard, external API, schedules). **HETA-01D:** validated completeness and nonoverlapping half-open `[effectiveFrom,effectiveTo)` intervals. **HETA-01E:** adversarial ordering, tenant, replay and failure tests. **HETA-01F:** independently authorized additive migration and disposable PostgreSQL/CI tests. **HETA-01G:** security, architecture and economic sign-off.

**Disposition:** Proposed design only. This document does not approve implementation, schema modification, positive historical tier verification, financial issuance, Stripe writes or production activation.
