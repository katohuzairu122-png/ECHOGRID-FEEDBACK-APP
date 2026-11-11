# ECHO GRID — Business Discovery & Promotion Network v1.0
**Owner-selected product architecture — design locked for review; development and activation NOT authorized**

- **Project:** Echo Grid / INFINICUS LLC
- **Repository:** `katohuzairu122-png/ECHOGRID-FEEDBACK-APP`
- **Decision date:** 2026-11-11
- **Baseline:** `main@9d92b33d1b226c9b27097b4df6711f3680c31c0a`
- **Scope:** Future Echo Grid platform-owned customer discovery and consent-based business promotion.
- **Status:** OWNER PRODUCT-SCOPE LOCK — DRAFT PR; only authoritative on `main` after separate owner-reviewed merge.
- **Execution authorization:** **DOCUMENTATION ONLY**. No API/schema/UI/notification implementation, marketing enrollment, outbound delivery, provider configuration, billing, production changes or deployments.

## 1. Product objective (locked)

Enable Echo Grid to introduce **Business B**, an approved newly joined business, to eligible Echo Grid customers who may have originally encountered the platform through **Business A**, **without** Business B gaining access to Business A's customer records, and **without** interpreting Business A's loyalty relationship or SMS OTP verification as consent to platform advertising.

Echo Grid is the publisher, audience eligibility decision-maker, sender and accountable operator. Businesses may request campaign placement but must not self-query or export the global customer audience.

**Canonical flow (future; NOT an implemented capability):**

```text
Business B joins and passes publication/moderation checks
  -> Published business discovery profile
  -> Echo Grid in-app discovery placement (published information only)
  -> Customer explicitly opts into platform discovery promotions, per channel
  -> Approved promotion campaign / eligibility policy
  -> Server-side recipient eligibility + current consent + suppression verification
  -> Capped, deduplicated, auditable delivery by Echo Grid
  -> Customer-controlled unsubscribe, suppression and aggregate delivery report
```

**A business joining alone must NEVER trigger automatic external broadcasts.**
The same customer may be enrolled with multiple businesses; dispatch must deduplicate by global customer identity/channel/campaign.

## 2. Authority and ownership boundaries (locked)

| Domain | Owner and permitted relationship |
| --- | --- |
| Global customer identity | Echo Grid identity domain; never a tenant-exportable audience |
| Customer relationship with Business A | Business A's existing membership/loyalty relationship, subject to tenant-scoped authorization |
| Customer relationship with Business B | Independent relationship; not created by an ad view, delivery, click or signup announcement |
| Business discovery profile | Platform-approved, publishable business metadata only, not private customer/tenant data |
| Platform advertising audience | Echo Grid-controlled recipient selection; requires independently recorded, applicable promotional consent for outbound marketing |
| Community membership and Community Points | Existing Split 05 domain; do not reuse membership as marketing permission or mutate its ledger |
| Business loyalty | Business-specific accounts and ledger; no automatic join or transfer |
| Orphan claims / settlement | Split 06 remains independent and consent-gated |
| Partner Credits / billing | Splits 07–08 remain independent, financially restricted; no awards, redemptions, Stripe adjustments or subscription discounts from promotions |
| B2B network / resource profiles | Separate future Split 09 architecture; this decision does not claim they already exist |
| Optional INFINICUS AdTech interoperability | Future separately specified integration; no dependency or access authorization is created here |

**Prohibitions:** no cross-tenant read, audience download, customer phone/email export, contact sharing, or direct business-to-business message initiation through an unrelated business's relationship. No reusing the existing business messaging endpoint to bypass its same-business enrollment gate.

## 3. Two different discovery modes (locked)

### Mode A — In-app business discovery (first delivery milestone)

- Display genuine **approved and published** business profiles in an Echo Grid-owned discovery feed, ideally within the customer Community Hub.
- A neutral platform directory may display published business facts subject to platform content/privacy rules. Any **personalization** using a customer's membership, purchase, location or engagement history requires a documented lawful basis, explicit product scope and appropriate preferences.
- Sponsored placements must be labeled clearly; never fabricate ratings, reach, popularity, campaign outcomes, offers, proximity or opening status.
- No automatic business loyalty enrollment, points award, financial reward, outbound SMS/email or direct merchant access to customers.
- Publishing a profile is a separate authorized action from registering a business.

### Mode B — Opt-in promotional notifications (later milestone)

- Promotional event types are new and separate from all existing transactional event types.
- **Default OFF / require affirmative opt-in**. A missing, stale, revoked, expired, ambiguous or business-only consent is **NOT** sufficient.
- Consent must distinguish **Echo Grid platform marketing** from individual business marketing and at least **email, SMS and future push** channels; record purpose, version, timestamp, scope, source/evidence and revocation.
- Do not infer consent from SMS OTP, Business A's enrollment, Community Hub participation, a generic transactional-notification default, a survey response, or a historical marketing grant whose scope does not expressly permit Echo Grid-wide discovery.
- Give customers clear preference and unsubscribe paths and respect current opt-outs at **send time**, not only when the campaign is created. Support applicable jurisdictional communication rules and suppression requirements.
- Email and SMS delivery modules exist for transactional notifications, but they are **not** an authorized promotional broadcaster. The enumerated `push` channel has no working provider path; do not claim push delivery.
- The current `notification_preferences` model is business-scoped with transactional default-on behavior. Promotional preferences require a separately reviewed contract/schema/authorization design (or an independently justified safe implementation) before coding.
- The current `consent_grants` model includes purpose `marketing` and nullable `business_id`, but **storage shape does not establish a valid platform-wide marketing consent or dispatch authorization**.
- Deduplication, rate limits, global and per-channel frequency caps, consent-version checks, quiet hours where required, inactive/suspended customer suppression, abuse monitoring, provider failures/retries, and campaign audit records must be designed before first outbound execution.

## 4. Business B announcement contract (future)

**Eligible campaign example**: “Business B has joined Echo Grid. Explore its published profile and available offers.”

An announcement requires all of:
1. Business B is active and profile publication approved; all promotional claims and offer terms independently verified.
2. Echo Grid approves campaign content, sponsor identity, intended channels, timing, geographic/audience policy and budget (if any).
3. Each recipient is an active global customer with **current explicit Echo Grid promotional consent for the specific channel and permitted scope**.
4. Current suppression/opt-out, channel availability, frequency cap, regional rules and deduplication checks pass.
5. Recipient routing, delivery and aggregate results are audited without exposing private recipient identities to Business B.
6. Failure or unavailable consent **fails closed**; no broad fallback to all Business A customers.

**Business B must not see the customer list, customer identities, another business's enrollment history, or private individual-level delivery metrics.** Business-visible reporting is aggregate and privacy-thresholded, with disclosure only under a separately approved lawful customer action.

## 5. Implementation roadmap (future separate approvals)

| Block | Goal | Boundary / release status |
| --- | --- | --- |
| BDPN-00 | This architectural decision, consent/security review and owner scope freeze | DOCUMENTATION ONLY; draft PR; no runtime changes |
| BDPN-01 | Public business profile/publication and Community Hub in-app discovery read model | Separate authorized development; only real published data; no outbound promotions |
| BDPN-02 | Platform marketing-consent contract, customer preference UI, revocation and suppression; provider/channel requirements | Separate security/privacy review; no sends |
| BDPN-03 | Moderated campaigns and authorized audience-selection dry run with aggregate estimates only from actual verifiable records | No contacting customers; no tenant customer-list exposure |
| BDPN-04 | Capped outbound email/SMS delivery behind independent owner-controlled activation gate and provider compliance checks | Requires explicit owner approval and staging proof, THEN separate production authorization |
| BDPN-05 | Audited campaign reporting, sponsor placement terms and optional paid monetization | Requires independent contracts, billing authority and product decisions |
| BDPN-06 | Optional B2B and AdTech interoperability | Separate architecture freeze; never merges customer/credit/loyalty ledgers |

No block may auto-advance, auto-merge or auto-deploy. A passing CI suite cannot activate marketing or waive regulatory/privacy review.

## 6. Existing repository reconciliation (snapshot at baseline)

- `customers` are globally identifiable, but loyalty/member relationships remain scoped to each business.
- `ConversationService.getOrCreateForCustomer` requires an enrolled customer in that **same** business. It is **not** a global marketing send function.
- `NotificationService.notifyBusinessStaff` broadcasts transactional messages to authorized staff at one business, **not** advertising to all Echo Grid customers.
- `notificationEventTypeSchema` and `notification-templates.ts` contain transactional events, no new-business promotion event. `DELIVERABLE_NOTIFICATION_CHANNELS = ['email','sms']`; push is not implemented.
- Business-scoped `notification_preferences` default to enabled for transactional events; its code explicitly requires **opt-in** for any future promotional event.
- `consent_grants` has a `marketing` purpose, but a matching opt-in workflow and Echo Grid-wide campaign eligibility authority are **not verified**.
- Community Hub H1 is separately being developed in draft PR #352 and is read-only; this record **does not extend or amend** its implementation scope.
- No campaign send API, approved business-discovery feed, B2B directory UI or authenticated marketing campaign management interface is confirmed at this baseline.

## 7. Required pre-implementation decisions (OPEN, not silently decided)

- Marketing consent wording, jurisdictional compliance, minimum age/eligibility, verified lawful use of customer information, notice and suppression retention.
- Exact platform-wide preference schema and revocation propagation; transaction vs promotion segregation at enqueue/delivery.
- Whether initial in-app discovery is a neutral directory or personalized; which published profile fields are verified.
- Geographic targeting model (no inference of precise location without an appropriate basis), channel pricing, sending caps and quiet hours.
- Marketing spend/billing and campaign advertiser controls: not part of this freeze.
- Readiness of the live production customer opt-in base: **unknown**; no assumption that any existing customer can be contacted.
- Abuse, unfair targeting, content moderation, accuracy claims and aggregate reporting privacy thresholds.

## 8. Acceptance / change control

This document is the **canonical product scope proposal** for future BDPN implementation once merged, not a shipped feature or approval to transmit messages. Every implementation block must:
- Fetch and reconcile latest main and earlier decisions.
- Produce its own focused PR, threat/consent review, tests, nonproduction verification, exact-head CI and owner completion report.
- Maintain global identity / tenant isolation / customer permission, existing ledger and financial restrictions.
- Treat missing approvals or unsafe authorization as an explicit STOP.
- Change this decision only through a new owner-reviewed, versioned decision record describing the superseded sections.

**CURRENT NO-GO: outbound marketing, automatic business-join broadcast, customer-list extraction, Partner Credit or Stripe effects, production configuration changes.**
