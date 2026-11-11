# Split 09 reconciliation against the locked Discovery & Promotion Network (BDPN v1.0)

**Status: DOCUMENTATION ONLY. Reconciliation of existing records and code. No code, schema, endpoint, UI, provider or
deployment change. Nothing here authorizes implementation, marketing or financial activation (all remain NO-GO).**

- Baseline: `origin/main` @ `df81911` (includes merged #352 to #359). Open at the time of writing: #360 (P1 Partner terms screen).
- Reconciles: `docs/architecture/decisions/ECHO_GRID_BUSINESS_DISCOVERY_PROMOTION_NETWORK_V1.md` (merged #353, "BDPN v1.0")
  with `docs/B2B-ARCHITECTURE-RECONCILIATION.md` (merged #352) and the current repository.
- Evidence rule: every repository claim below was checked in source on this baseline. Unverified items are marked.

## 1. Naming: what "Split 09" is, and what it is not

| Term | Meaning in the repository | Source |
|---|---|---|
| **Split 09** | The deferred **B2B business resource/service profile** work. Split 02 explicitly defers it. **No Split 09 specification exists in the repository.** | Split 02 deferral; B2B reconciliation section 1 |
| **BDPN v1.0 (BDPN-00 to 06)** | Echo Grid-owned **customer discovery and opt-in promotion**. It states the B2B network and resource profiles are a "separate future Split 09 architecture" and lists B2B/AdTech only as optional BDPN-06. | BDPN sections 2 and 5 |

**Conclusion:** BDPN is **not** Split 09 and does not supersede it. They overlap in one place only: both need a
**published business profile** (BDPN Mode A shows published profiles to customers; Split 09 describes a business's
resources and services to other businesses). Whether they share one profile entity is an **open owner decision** (section 6, D-A).

## 2. BDPN section 6 claims checked against current main

| BDPN claim | Verdict | Evidence on this baseline |
|---|---|---|
| Customers are global; loyalty/member relationships are per business | VERIFIED | `customers` has no business column; `loyalty_accounts` and `customer_memberships` are business-scoped |
| `ConversationService.getOrCreateForCustomer` needs a same-business enrolled customer | VERIFIED | Requires an existing loyalty account for that customer and business |
| Notification event types are transactional; no promotion event | VERIFIED | `notificationEventTypeSchema` lists feedback, summary, redemption, points, tier, reward, message and critical-alert events only |
| Deliverable channels are email and SMS; push has no provider path | VERIFIED | `DELIVERABLE_NOTIFICATION_CHANNELS = ['email','sms']`; `push` only enumerated |
| `notification_preferences` is business-scoped, transactional default-on, and requires opt-in for any promotional event | VERIFIED | Schema and its own comment say a promotional event must default to false |
| `consent_grants` has a `marketing` purpose; matching opt-in workflow not verified | VERIFIED, **and stronger** | Purposes: `join_loyalty, marketing, survey_participation, settlement_access, contact_sharing`. The only code paths that **create** grants are loyalty join (`customer-membership.service`) and orphan settlement access. **Nothing creates a `marketing` grant.** The customer consent routes only list and revoke. |
| No campaign send API, approved discovery feed, B2B directory UI or campaign management exists | VERIFIED | Only `GET /businesses/:id/public` (one business, by id) exists for customers; the only business list is the platform-admin directory (`platform-business-directory`), which is staff-only |
| "Community Hub H1 is being developed in draft PR #352" | **STALE** | #352 is merged; the hub is read-only at `/loyalty/dashboard/community` and has no discovery area |
| Baseline `main@9d92b33` | STALE (expected) | Main has moved; section 3 lists what changed |

## 3. Merged work since the BDPN baseline that interacts with it

| Merged | Interaction with BDPN |
|---|---|
| Community Hub H1 (#352) | Read-only; membership and points only. BDPN says discovery should "ideally" live in the Community Hub: that is a placement option, not an existing surface. **Community membership must not be reused as marketing permission** (BDPN section 2) |
| Customer language preference (#355) | Adds `customers.preferred_locale` (migration 0067, **not applied anywhere**) and a customer-level `GET/PUT /customer-language`. Useful later for localizing promotional content, but it is **not** a promotional preference and must not be used to infer consent |
| Customer Surveys H2 (#359) | Survey participation uses consent purpose `survey_participation`. A survey response must not be treated as marketing consent (BDPN section 3). Surveys still have **no "available to me" list endpoint**; discovery is by business QR or link only |
| Cashier tab, landing facts band (#356 to #358) | No BDPN interaction |
| P1 Partner terms (#360, open) | Read-only terms view; no enrollment or credit effect. Independent of BDPN |

## 4. Gaps that block BDPN-01 (the first delivery milestone)

BDPN-01 is "public business profile/publication and in-app discovery read model, only real published data".

1. **No publication state exists.** `businesses` has `status` (default `active`) but no published flag, moderation
   state, description, logo or approved-claims fields. The public DTO is only `id, name, defaultLocale, defaultCurrency,
   defaultTimezone, categoryKey`. A real "approved and published" profile needs new data.
2. **No customer-facing list endpoint exists.** Discovery needs one authorized read model; none can be built UI-only.
3. **Migration pipeline is the practical constraint.** Staging is at 45 migrations and Gate 2 now pins 68 (including
   0067). Any BDPN schema (publication state, consent contract) adds migrations, each requiring another Gate 2
   re-pin and extending the unapplied backlog. A batching and gating policy for the pending migrations should be
   decided **before** BDPN-01/02 schema work.
4. **No web-only slice is honest.** A neutral directory of real businesses cannot be rendered from existing endpoints
   without exposing all active businesses, which is a product and privacy decision, not a UI task.

## 5. Mapping the seven D3 B2B capabilities to existing code and to BDPN

| D3 capability | Existing | BDPN | Split 09 |
|---|---|---|---|
| Business discovery, profiles, resources/services | Per-id public DTO only | BDPN-01 (customer-facing published profile) | Resource/service profiles for B2B (unspecified) |
| Community Point redemption partnerships | Ledger reserves `redeem`; no service | None | Not specified |
| Orphan reward settlement collaboration | Split 06 (built) | None | None |
| Survey hosting / cross-business research | Split 04 surveys (platform/business owned); customer UI (#359) | None | Not specified |
| Offers and business campaigns | None (only survey and reward campaigns) | BDPN-03/04 (moderated, consent-gated) | Not specified |
| Partner Credits visibility | Splits 07 to 08 (frozen); terms read (#360) | None | None |
| Marketing priority services | None | BDPN-05 (sponsored placement, needs billing authority) | Not specified |

Ledgers stay separate in every row (loyalty, Community Points, orphan claims, Partner Credits, billing).

## 6. Owner decisions needed (not decided here)

- **D-A. One profile or two?** A single publishable business profile entity extended by capability (Mode A discovery
  and Split 09 resources), versus separate entities. Recommendation: one entity, owned by BDPN-01, with Split 09 adding
  capability sections later, so publication and moderation exist once.
- **D-B. Neutral directory or personalized discovery** (BDPN open decision): neutral first avoids needing a lawful basis
  for personalization.
- **D-C. Migration batching and gating.** How pending migrations (23 on staging) are authorized and applied, and whether
  BDPN schema waits for them.
- **D-D. Is a Split 09 specification to be written**, and before or after BDPN-01.
- **D-E. Marketing consent wording, jurisdictions and the existing opt-in base** (BDPN section 7): unchanged and still open.
  The readiness of any live customer opt-in base is **unknown**; nothing is assumed contactable.
- **D-F. Whether enrollment-status and "surveys available to me" read endpoints** (both blocked today) are authorized
  as part of one customer/business read-model block.

## 7. Recommended sequence (each a separate authorization; none auto-advances)

1. **BDPN-01 design block (documentation + contract only):** profile and publication fields, moderation states, the
   read-model endpoint shape, privacy rules and the migration list. No code.
2. Decide D-A to D-D, then authorize BDPN-01 **backend** (schema, publication workflow, read model) with its own Gate 2 plan.
3. Only then a customer-facing discovery UI (Community Hub placement) on real published data.
4. BDPN-02 (platform marketing consent contract) only after its own security and privacy review. No sends in any step.

## 8. Unchanged NO-GO

Outbound marketing and automatic business-join broadcasts; customer-list extraction or cross-tenant reads; Partner Credit,
Stripe, billing or subscription effects; production configuration changes, migrations and deployments without separate
explicit owner authorization.
