# BDPN D-18 v1.1 — Reconciliation Audit

**Status: DOCUMENTATION ONLY. READ-ONLY AUDIT. Nothing here implements anything, authorizes a migration, endpoint, page,
notification, entitlement, deployment or merge.** Companion: `BDPN_D18_V1_1_AMENDMENT_AND_DESIGN.md`.

- Baseline: `origin/main` @ `c895edb2507f969387ce1f7cb27679bb003beff9` (includes #439). Latest migration `0072`.
- Method: file-level inspection of the repository by four parallel read-only passes (BDPN/discovery code; QR enrollment and
  membership; subscription and entitlement; Community, notifications, surveys, promotions), plus reading the design documents
  named in each section. Line numbers come from those passes; they were not all re-read in full, so a few are approximate.
  Anything not found by search is classified NOT PRESENT or UNKNOWN, never assumed.
- Classification: **IMPLEMENTED** (code, wired, reachable), **PARTIAL** (some of it exists), **DESIGN ONLY** (documents, no
  code), **BLOCKED** (cannot proceed without a decision or prerequisite), **UNKNOWN** (not established by this audit).
- Paths are relative to the repository root. `api` = `apps/api/src`, `web` = `apps/web/src`.

## 1. Headline findings

1. **No BDPN feature code exists.** No profile, revision, publication, moderation, handle, discovery route, activation flag or web
   surface. Only the pre-BDPN `GET /businesses/:id/public` and the `business_categories` lookup exist. All of BDPN is DESIGN ONLY.
2. **QR enrollment is fully implemented** (`POST /customer-memberships/join`). It checks that the business is active and the
   customer is not limited. It does **not** check that a loyalty program is enabled and it **drops the QR's branch**.
3. **There is no entitlement layer.** Plan data is stored; only monthly responses and team seats are enforced. No plan key exists for
   remote enrollment, promotions, discovery, surveys or community.
4. **"Split 08 subscription and entitlement authority" does not match the repository.** In the repository, Split 08 is partner-credit
   settlement and Stripe evidence. No document or code defines an entitlement authority (see conflict C-6).
5. **No customer interest/follow/wishlist concept exists**, and no business-facing aggregated notification exists.
6. **Promotions, the Network feed and survey discovery by customers do not exist.** They are DESIGN ONLY or PARTIAL as listed below.
7. **The owner's decision 1 conflicts with a locked BDPN decision (D-24)**, and decision 6/7 conflict with BDPN-01C/01D binding
   non-effects. These are flagged, not silently superseded (section 4).

## 2. Capability classification

### 2.1 BDPN and business discovery

| Capability | Class | Evidence |
| --- | --- | --- |
| Business public profile (rich content) | DESIGN ONLY | `docs/architecture/builds/BDPN/BDPN_01_BUSINESS_PROFILE_DISCOVERY_SPEC.md`, `BDPN_01A_...`. No profile table in `api/db/schema/` or migrations `0000-0072`. |
| Profile revisions, drafts, submit, publish, withdraw | DESIGN ONLY | `BDPN_01A_DATA_CONTRACTS_AND_SCHEMA_PROPOSAL.md` sections 2-4. No code. |
| Platform moderation of profiles | DESIGN ONLY | `BDPN_01B_VALIDATION_AND_MODERATION_DESIGN.md`. The only moderation code is customer moderation: `api/platform/customer-directory.routes.ts:27,223`, migrations `0069`, `0070` (unrelated). |
| Discovery list/detail/categories endpoints | DESIGN ONLY | `BDPN_01C_DISCOVERY_API_DESIGN.md` section 3. `api/index.ts` has no discovery mount. |
| Opaque public handle | DESIGN ONLY | D-10. `GET /businesses/:id/public` takes the raw business UUID (`api/businesses/business.routes.ts:76-98`). |
| Eligibility predicate ("discoverable") | DESIGN ONLY | `BDPN_01A` section 6; reserves a plan term pending D-24. |
| Activation flag (`DISCOVERY_ENABLED`) | DESIGN ONLY | `BDPN_01E_SECURITY_MIGRATION_RELEASE_PLAN.md:41` (T-20). `api/config/env.ts` has no such flag (only `PLATFORM_IMPERSONATION_ENABLED`, line 34). |
| Profile permissions (edit/submit/moderate) | DESIGN ONLY | D-02, D-03. No keys under `api/rbac`. |
| Web profile editor / discovery pages / hub entry card | DESIGN ONLY | `BDPN_01D_COMMUNITY_HUB_INTEGRATION_DESIGN.md`. `web/app/landing-claims.test.ts:7,23` forbids public copy about discovery until it ships. |
| Business categories | PARTIAL (pre-BDPN) | `api/db/schema/business-categories.ts:3-20`; migration `0035_split02_business_branch.sql`; route `api/businesses/business-category.routes.ts` mounted `api/index.ts:155`. |
| `GET /businesses/:id/public` | IMPLEMENTED (minimal, not a BDPN profile) | `api/businesses/business.routes.ts:76-98`. No publication gate; any existing business is returned. D-25 leaves it unchanged. |

### 2.2 Customer identity, enrollment and membership (Splits 01 and 03, CUSTOMER-AUTH-01)

| Capability | Class | Evidence |
| --- | --- | --- |
| Business QR resolution | IMPLEMENTED | `api/qr/qr-code.service.ts:75-103`; public `GET /qr/:token` `api/qr/qr.routes.ts:49-94`. |
| QR join / enroll | IMPLEMENTED | `POST /customer-memberships/join` `api/customer-relationships/customer-membership.routes.ts:48-68`; service `customer-membership.service.ts:23-91`; alias `POST /loyalty/me/join` `api/loyalty/loyalty-customer.routes.ts:99-120`. Web calls `/customer-memberships/join` (`web/lib/actions/loyalty-customer.ts:18`). |
| Join request schema | IMPLEMENTED | `packages/shared-types/src/customer-relationships.ts:22-26` (`qrToken`, `consentVersion`, optional `idempotencyKey`). |
| `customers`, `business_customer_memberships`, `loyalty_accounts`, `consent_grants` tables | IMPLEMENTED | `api/db/schema/customers.ts:17-47`; `business-customer-memberships.ts:65-91` (unique customer+business `:83`); `loyalty-accounts.ts:115-143`; `consent-grants.ts:161-199`. |
| Membership `onboarding_source` | IMPLEMENTED (free text) | `business-customer-memberships.ts:30` `text('onboarding_source')`; migration `0034` line 11. A new source value needs **no** migration. |
| Eligibility: business active | IMPLEMENTED | `customer-membership.service.ts:26-29` (409 `BUSINESS_NOT_AVAILABLE`). |
| Eligibility: customer not limited | IMPLEMENTED | `customer-membership.service.ts:33-35` via `api/lib/customer-limits.ts:26-41` (403 `CUSTOMER_LIMITED`). |
| Eligibility: customer status active | PARTIAL (upstream) | `api/middleware/customer-authenticate.ts:39-42` (401). |
| Eligibility: loyalty program enabled | NOT PRESENT | `api/db/schema/loyalty-settings.ts:20-40` has no enabled flag. |
| Eligibility: branch context | NOT PRESENT | QR carries `branchId` (`qr-code.service.ts:98`); join uses only `businessId` (`customer-membership.routes.ts:59`). |
| Customer leave a business membership | NOT PRESENT | `left` status and `reactivate` exist (`customer-membership.service.ts:44-53`); no leave endpoint. (`/community/me/leave` is Community Points, `api/community/community-customer.routes.ts:95`.) |
| Customer interest / follow / wishlist | NOT PRESENT | No schema, migration, route or web code. Membership status `pending` exists in the enum but no code creates it. |
| Customer OTP auth + 90-day JWT | IMPLEMENTED | `api/customer-auth/customer-auth.routes.ts:60,70`; `customer-jwt.ts:24`; `middleware/customer-authenticate.ts:20-49`. |
| Password auth domain + sessions | PARTIAL (service only) | `api/customer-auth/customer-password-auth.service.ts`, `customer-session.service.ts`; no HTTP routes, nothing mounted in `api/index.ts`. |
| `login_email` columns (0072) | IMPLEMENTED (schema only) | `drizzle/0072_customer_verified_login_email.sql`; `api/db/schema/customer-credentials.ts:34-37,59-63`. |
| Check-in requires membership | IMPLEMENTED | `api/loyalty/loyalty-account.service.ts:98-121` (409 `MEMBERSHIP_REQUIRED`); Split 01 removed silent auto-enrollment (`:84-85`). |
| Legacy `LoyaltyAccountService.enroll` | PARTIAL (legacy) | `loyalty-account.service.ts:39-72`; no non-test caller found. |
| Customer QR (cashier service) | IMPLEMENTED | `GET /loyalty/me/customer-qr` `loyalty-customer.routes.ts:59`; `loyalty/loyalty-action-resolver.ts:160-161` emits `JOIN_LOYALTY`. |

CUSTOMER-AUTH-01 open questions touched by this amendment: CA-06 (remote enrollment eligibility), CA-07 (selected programs),
CA-08 (consent language, notice and versioning). Their status after the amendment is in section 12 of `BDPN_D18_V1_1_AMENDMENT_AND_DESIGN.md`.

### 2.3 Subscription and entitlement

| Capability | Class | Evidence |
| --- | --- | --- |
| Plan tables, seeds, approved catalog | IMPLEMENTED | `api/db/schema/subscription-plans.ts:23-78`; `api/billing/subscription-catalog.ts:3-75`; seed `api/db/seed/subscription-plans.seed.ts`; `features` is an open jsonb (`subscription-plans.ts:52`). Plans: `free`, `starter`, `growth`, `business`, `enterprise`. Feature keys: `monthlyResponses`, `aiSummaries`, `customBranding` (plus `maxBranches`, `maxUsers` columns). |
| Business subscription status mirror | IMPLEMENTED | `api/db/schema/business-subscriptions.ts:31-75` (Stripe is the system of record; webhook-synced mirror). |
| Response-allowance entitlement | IMPLEMENTED | Postgres trigger `echo_grid_apply_response_allowance()` in `drizzle/0030_response_allowance_queue.sql:14-65`. |
| Team-seat limit | IMPLEMENTED | `api/team/team.routes.ts:38-46`. |
| Branch limit | PARTIAL | Column only; `api/branches/branch.service.test.ts:133` asserts it is not consulted. |
| `aiSummaries`, `customBranding` enforcement | PARTIAL | Seeded; no enforcement in `apps/api/src`. `apps/web` was not searched. |
| Generic entitlement evaluator (`requireEntitlement`/`hasFeature`) | NOT PRESENT | `api/middleware/` holds only authenticate, require-permission, require-platform-role, require-business-wide-access, tenant-context, cashier-scope, rate-limit, customer-authenticate, audit. |
| Status-aware gating, grace period | NOT PRESENT | Nothing branches on subscription status except a platform admin list filter. |
| Downgrade behaviour | PARTIAL | `api/billing/subscription-lifecycle.service.ts:13-21` only moves expired card-less trials to Free. |
| Per-business opt-in/feature-flag settings | NOT PRESENT | Existing settings tables are notification and loyalty numeric settings only. |
| Entitlement for remote enrollment / promotions / discovery / surveys / community | NOT PRESENT | No plan key, flag or check. D-24 (discovery plan gating) is design only and undecided. |
| "Split 08 entitlement authority" | UNKNOWN / CONFLICT | `docs/architecture/builds/SPLIT-08/` is a flat directory of partner-credit and Stripe-evidence gates. No entitlement specification exists there (conflict C-6). |

Financial constraints an entitlement check must respect (quoted from the repository):
- `BDPN_01_OWNER_DECISION_RECORD.md` D-24 constraint: "an entitlement check may **read** the business's current plan, but must not change billing, Stripe or subscription state."
- `SPLIT-07/HETA_01G_...GATE.md:20`: "No actor may bypass the existing 0041/0042/0044 financial write denials."
- `SPLIT-08/GATE2_R20_TENANT_REFERENCE_AND_TRIGGER_FINDINGS.md:90`: financial guard triggers are not to be converted to definer rights without their own reviewed block.
- `api/partner-credits/provider-subscription-event.reconciler.ts:49`: do not turn business-controlled metadata into entitlement authority.

### 2.4 Community, notifications, surveys, promotions

| Capability | Class | Evidence |
| --- | --- | --- |
| Customer Community nav item and read-only hub | IMPLEMENTED | `web/app/loyalty/dashboard/layout.tsx:43`; `web/app/loyalty/dashboard/community/page.tsx`; `community-hub-view.tsx`; `web/lib/community-hub.ts`. |
| Community Points membership/points API | IMPLEMENTED | `api/index.ts:186-187`; `api/community/community-customer.routes.ts:61,71,95`; `community-point-customer.routes.ts:100,109`. |
| Network Feed (`/community/feed`) | DESIGN ONLY | `NETWORK/NETWORK_00_CONTENT_MODEL_AND_ACCESS.md:9-12` ("a proposal, not an approved route"). |
| "Discover businesses" hub entry card | DESIGN ONLY | `BDPN_01D_...:60-100` (shown only when the API reports discovery enabled). |
| Split 05 boundaries | IMPLEMENTED (code) / locked (doc) | `api/db/schema/community-points.ts:62-231`; doc `SPLIT-05/ECHO_GRID_SPLIT_05_COMMUNITY_POINTS_v1.0.md:29,31,33,124,125,170`: membership never silently created; Community Points never merged with business loyalty; stop-and-report on conflict. |
| NotificationService (`notify`, `notifyBusinessStaff`) | IMPLEMENTED | `api/notifications/notification.service.ts:39,54,120`. |
| Event types | IMPLEMENTED | `packages/shared-types/src/notifications.ts`: 9 events; staff set of 5, customer set of 4. |
| Delivery channels | PARTIAL | Email and SMS delivered; push enum exists, no implementation (`api/notifications/notification-job.ts:15-20`). |
| Preferences and business kill switches | IMPLEMENTED | `api/db/schema/notification-preferences.ts`; `business_notification_settings`; checks at `notification.service.ts:70-84`. |
| Consent gating of notifications | PARTIAL | `notify()` does not consult `consent_grants`; the preferences schema comment says any future promotional event must default opt-in. |
| Business-facing aggregated notification | NOT PRESENT | Only per-event staff events. |
| Surveys: contracts, audiences, consent, participation | IMPLEMENTED | `packages/shared-types/src/surveys.ts`; `api/db/schema/surveys.ts`; `api/surveys/survey-customer.routes.ts:105-143`; eligibility `survey-participation.service.ts:124-190`. |
| Customer survey **discovery** (list eligible campaigns) | PARTIAL / NOT PRESENT | No endpoint lists eligible campaigns; the UI shows participation history and takes a campaign id. |
| Promotions, posts, offers, discounts | DESIGN ONLY | No model, route or migration. `NETWORK/NETWORK_00_CONTENT_MODEL_AND_ACCESS.md` header: documentation only; `qr-codes.ts:30` comment: promotions are later modules. |
| Promotion moderation | DESIGN ONLY | `NETWORK_00_MODERATION_AND_GOVERNANCE.md:26,50` (offer terms required; pre-moderation). |
| Consent-based promotion (NETWORK-06) | DESIGN ONLY | `NETWORK_00_PHASING_THREATS_AND_TESTS.md:17`. |

## 3. Locked decisions that bear on this amendment

| ID | Locked decision | Source | Effect of the owner's decisions |
| --- | --- | --- | --- |
| D-09 | Signed-in customers only | `BDPN_01_OWNER_DECISION_RECORD.md` | **Kept.** Discovery stays behind customer authentication. |
| D-10 | Opaque handle; internal id never exposed | same | **Kept.** Interest and enrollment use the handle. |
| D-12 | `private, no-store` on discovery | same | **Kept**, also for the new endpoints. |
| D-17 | No view tracking in v1 | same | **Kept.** Interest is an explicit action, not tracking; see conflict C-2. |
| D-18 | Informational join text only; no join button | same | **Amended** (proposal). |
| D-20 | Off by default, internal testing first | same | **Kept**, extended to the new endpoints. |
| D-23 | Split 09 reliance on "discoverable" deferred | same | **Stays deferred**; flagged because decision 1 defines "discoverable". |
| D-24 | Publication only on certain plans (follow-ups open) | same | **Conflict C-1** with the owner's decision 1. |
| D-25 | `/businesses/:id/public` unchanged | same | **Kept.** |

## 4. Conflicts and mismatches (flagged, not resolved here)

| ID | Conflict | Where | Handling in the amendment |
| --- | --- | --- | --- |
| C-1 | Owner decision 1 (every active, approved, published business is discoverable **regardless of subscription**) vs D-24 (publication only on certain plans) | `BDPN_01_OWNER_DECISION_RECORD.md` D-24; `BDPN_01A` section 6 reserved plan term | Amendment proposes that D-24's plan gating **no longer applies to discoverability** and moves to the two new entitlements. Needs the owner's explicit confirmation that D-24 is replaced (OD-1). |
| C-2 | Owner decisions 5-7 (interest expression, aggregated business notification) vs BDPN-01C/01D binding non-effects ("browsing creates no membership, ... notification, message, view history"; "no follow, save ... control") and D-17 | `BDPN_01D:92`, `BDPN_01C` section 1 | Browsing stays non-effectful. Interest is a separate, explicit customer action; the non-effects are amended to name it. |
| C-3 | Remote joining vs D-18 and `BDPN_01C` "no join action in any response" | `BDPN_01C` section 1 | The amendment defines the restricted remote-enrollment contract the CUSTOMER-AUTH-01 roadmap section 8 asked for. |
| C-4 | `BDPN_01D:92` "no loyalty read or write" vs remote enrollment writing membership, consent and loyalty rows | `BDPN_01D` section 5 | Enrollment runs through the existing Split 01 membership service, not through discovery code. Discovery reads stay read-only. |
| C-5 | Survey discovery vs `BDPN_01D` "Surveys H2: no coupling; no survey link on a profile" | `BDPN_01D` section 5 | Amendment allows a promoted-survey card only for businesses with the promotional entitlement and an approved publication. Participation rules stay as implemented. |
| C-6 | "Split 08 subscription and entitlement authority" is not a repository concept | `docs/architecture/builds/SPLIT-08/` | Proposes a new, read-only entitlement evaluator over the existing subscription mirror; a documentation owner must decide where it is specified. |
| C-7 | The QR join has no program-enabled or branch check; remote enrollment needs a definition of "loyalty program available" | `customer-membership.service.ts` | OD-6. The existing QR path is **not** changed by this amendment. |
| C-8 | `NETWORK` docs require a published BDPN profile for business posts; owner decision 9 adds a promotional entitlement | `NETWORK_00_CONTENT_MODEL_AND_ACCESS.md` N-06 | Both are required; the amendment states the combined predicate. |
| C-9 | CA-08 (consent language, notice, versioning) is still open for the remote path | `CUSTOMER_AUTH_01_REQUIREMENTS_AND_ROADMAP.md` section 9 | The amendment specifies a notice contract; the wording and legal review stay open (OD-9). |

## 5. What the audit could not establish (UNKNOWN)

- Whether `apps/web` uses `aiSummaries` / `customBranding` flags.
- What the global `auditTrail` middleware records for customer routes (request-level audit may apply to the join).
- Authentication of `/customer-language` (not inspected).
- Production state of any migration or feature switch (this audit reads the repository only).
- Whether staging or production plan rows match the repository catalog.
