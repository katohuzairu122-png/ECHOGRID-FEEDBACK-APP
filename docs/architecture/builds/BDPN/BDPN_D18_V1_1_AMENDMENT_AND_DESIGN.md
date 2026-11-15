# BDPN D-18 v1.1 — Amendment and Design

**Status: DESIGN PROPOSAL — DOCUMENTATION ONLY. Not approved. Nothing here implements anything.** No table, endpoint, plan key,
permission, notification, page, migration, deployment or merge is created or authorized by this document. Everything under
"proposal" is a proposal. Remote enrollment must not be implemented before this amendment receives an independent review and the
owner's approval (section 14).

- Amends: BDPN-01 decision **D-18** (`BDPN_01_OWNER_DECISION_RECORD.md`). Partially replaces **D-24**. Companion audit:
  `BDPN_D18_V1_1_RECONCILIATION_AUDIT.md` (classification and file-level evidence).
- Baseline: `origin/main` @ `c895edb2507f969387ce1f7cb27679bb003beff9`; latest migration `0072`.
- Version: D-18 **v1.1** (v1.0 = "informational join text only; no join button").
- Rule followed: the locked architecture is preserved. Where an owner decision conflicts with a locked decision, the conflict is
  listed in the audit (C-1 to C-15) and in the owner decision register (section 13), and is **not** silently superseded.

## 1. Owner product decisions (as given) and where each is handled

| # | Owner decision | Section |
| --- | --- | --- |
| 1 | Every active, approved, published participating business is discoverable, regardless of subscription | 3, 4 |
| 2 | QR-based enrollment remains available under existing business and customer eligibility rules | 3, 4, 10 |
| 3 | Remote enrollment requires a qualifying subscription entitlement **and** explicit business opt-in | 3, 4 |
| 4 | Remote enrollment and promotional publishing are independent entitlements, even when bundled | 4, 8 |
| 5 | Businesses without remote enrollment remain discoverable | 4 |
| 6 | Customers may express interest without creating a membership | 5, 6 |
| 7 | Businesses receive aggregated interest notifications, not customer identity | 6 |
| 8 | Upgrade guidance for ineligible businesses; enablement guidance for eligible-but-disabled | 6 |
| 9 | Promotional posts, discounts and survey discovery need a separate promotional entitlement and publication approval | 7 |
| 10 | Existing memberships, points, rewards, accounts, QR workflows, survey rights, consent and financial boundaries stay intact | 3, 10 |

## 2. What does not change (binding)

- Browsing remains **non-effectful**: viewing a list or a profile creates no membership, loyalty account, consent grant, Community
  Points movement, notification, message or view history (`BDPN_01D` binding non-effects). Only the two explicit customer actions in
  section 5 have effects.
- D-09 (signed-in customers only), D-10 (opaque handle; no internal business id), D-12 (`private, no-store`), D-17 (no view tracking),
  D-20 (off by default), D-25 (`/businesses/:id/public` unchanged) are kept.
- The business QR flow and its eligibility rules (business active; customer not limited) are unchanged. This amendment does **not**
  add a program-enabled or branch check to the QR path (OD-6, OD-11 concern only the new path).
- **Split 01 invariant 4 and Split 03 section 4** (joining requires an authorized business context; the physical branch QR is the canonical
  context) are **not** declared unaffected. Whether remote join satisfies them is an open owner ruling (OD-17, conflict C-10).
- Split 05: Community Points are never merged with business loyalty; no enrollment, remote or otherwise, silently creates a Community
  membership. Splits 06 to 08: no financial write, billing, Stripe, Partner Credit or settlement change.
- Existing memberships, points, rewards, consent history and survey participation are never altered by entitlement changes.

## 3. The D-18 v1.1 amendment (proposed text)

> **D-18 v1.1 — Join and interest affordances in discovery.** Discovery may present at most one of two explicit, customer-initiated
> actions on a discoverable business, chosen by the server from the business's state:
> 1. **Join (remote enrollment)** — only when the business holds a qualifying remote-enrollment entitlement, has explicitly opted in,
>    and (OD-6) has a loyalty program available. It creates a membership through the existing Split 01 membership service, with the
>    same consent and eligibility discipline as the QR join, and a distinct onboarding source.
> 2. **Express interest** — available when Join is not. It records the customer's interest and creates **no** membership, loyalty
>    account, consent grant, points or contact permission.
>
> The informational QR wording of D-18 v1.0 remains for every business that does not offer Join, and QR enrollment remains available
> to every business under its existing rules. Neither action is ever triggered by viewing, scrolling, searching or filtering.

> **D-24 (partial replacement, subject to OD-1).** Plan gating no longer decides whether a business is discoverable (owner decision 1).
> The reserved plan term in the eligibility predicate (`BDPN_01A` section 6) is **removed** for discoverability. Plan entitlement now
> gates two separate capabilities: remote enrollment and promotional publishing (section 8). D-24's constraint stays: an entitlement
> check may only **read** the current plan and subscription mirror and must never change billing, Stripe or subscription state.

> **Amended non-effects (BDPN-01C/01D).** "No join action in any response" and "no follow/save/share control" are amended to permit the
> two actions above, and only those. No tracking, ranking by interest, or advertising event is introduced.

> **Exact amended texts (so that nothing is superseded silently).**
> - BDPN-01C section 3: "All are `GET` and read-only" becomes "The list, detail, category and status endpoints are `GET` and read-only. The
>   enrollment and interest endpoints (section 8.2) are the only writes under `/discovery`."
> - BDPN-01C section 4: the closed allow-list gains exactly one object, `enrollment { mode, myStatus }`, and nothing else about the business's
>   plan, entitlement or settings.
> - BDPN-01D section 5: "Loyalty: no loyalty read" becomes "no loyalty read except the caller's own membership status for `myStatus`".
> - D-17 / 01C/01D log rule: "logs never pair a customer with a handle" becomes "request logs never do; the interest row and the join audit
>   record necessarily do, are not exposed to businesses, and are covered by the retention in OD-7".
> - BDPN-01E T-14: "row counts of every customer-linked table unchanged" is limited to **browsing** requests; the two explicit actions are
>   expected to change `customer_enrollment_interests` or the membership tables, and nothing else.

What the amendment deliberately does **not** do: define plans or prices (economic, OD-2), define consent wording (legal, OD-9), rule on
Split 01 invariant 4 (OD-17), or change any Split 05/06/07/08 contract.

## 4. Business visibility and entitlement decision matrix

Predicates (proposal; all evaluated server-side, at request time, in the query, never from a stored flag):

- `discoverable(b)` = business `active` and not deleted ∧ published approved profile revision ∧ default-locale translation present
  (`BDPN_01A` section 6 **without** the plan term).
- `entitledRemote(b)` = subscription status accepted by OD-3 ∧ `plan.features.remoteEnrollment === true` (absent = false).
- `optedIn(b)` = `business_enrollment_settings.remote_enrollment_enabled = true`.
- `programReady(b)` = definition pending (OD-6).
- "Participating" in owner decision 1 is not defined by the existing predicate; this document reads it as `discoverable(b)` and asks the owner
  to confirm (OD-18).
- `entitledPromo(b)` = subscription status accepted by OD-3 ∧ `plan.features.promotions === true`.

| State of the business | Discoverable | QR enrollment | Customer sees | Business guidance |
| --- | --- | --- | --- | --- |
| Not active, deleted, suspended, unpublished, withdrawn, or no approved revision | No | Existing rules (unchanged) | Nothing; same "not found" as any unknown handle | None from this feature |
| Discoverable, **not** `entitledRemote` (any plan) | **Yes** | Yes | QR wording + **Express interest** | **Upgrade guidance** (owner decision 8) |
| Discoverable, `entitledRemote`, **not** `optedIn` | **Yes** | Yes | QR wording + **Express interest** | **Enablement guidance** |
| Discoverable, `entitledRemote`, `optedIn`, **not** `programReady` | **Yes** | Yes | QR wording + **Express interest** | Program-setup guidance |
| Discoverable, `entitledRemote`, `optedIn`, `programReady` | **Yes** | Yes | **Join** + QR wording | None |
| Entitlement lapses (downgrade, cancellation, non-payment per OD-3/OD-4) | **Yes** | Yes | Join disappears at the next read; **Express interest** returns | Upgrade guidance |
| Customer is already an active member | Yes | n/a | "You are a member" (own data only); no Join or Interest | None |

Independence (owner decision 4): `entitledRemote` and `entitledPromo` are separate keys. Every combination of the two is valid:

| `entitledRemote` | `entitledPromo` | Effect |
| --- | --- | --- |
| no | no | Discoverable, QR + interest only; no promotions |
| yes | no | Join available (with opt-in); no promotional posts, discount posts or promoted surveys |
| no | yes | Interest only; promotional content allowed after publication approval |
| yes | yes | Both; the two are still evaluated and revoked separately |

Interest is also offered for a business that already holds `entitledRemote` but has not opted in, so that demand reaches the business
as aggregated guidance (section 6).

**Opt-in persistence (OD-19).** A stored `remote_enrollment_enabled = true` would silently re-enable Join after a lapse and later
re-entitlement, which weakens "explicit opt-in" (owner decision 3). The design therefore requires a decision between (a) the opt-in
persists and (b) the business must re-confirm after any lapse; the proposal is (b), recorded by an explicit staff action, never by a write
from the read-only evaluator. The setting endpoint is denied for cashier-scoped tokens and impersonation and requires business-wide access
(same precedent as other business-wide settings).

**Visible state change (OD-20).** `mode = JOIN` tells every customer that the business holds a paid entitlement and has opted in, and a JOIN to
INTEREST flip tells them it lapsed. This is an accepted disclosure to be confirmed by the owner. To avoid broadcasting a payment hiccup, a
grace window or hysteresis for `past_due` is proposed (OD-3); `cancel_at_period_end` stays entitled until the period ends.

## 5. Customer discovery and enrollment interaction contracts

All customer endpoints sit behind the existing customer session, the discovery activation flag (default off), the per-**customer**
rate limiter (not the shared-IP limiter, see section 9 T-15) and `private, no-store`.

### 5.1 What discovery responses add (proposal)

Each list item and the detail response gains one closed object. It carries no plan, entitlement or opt-in names:

```json
{ "enrollment": { "mode": "JOIN" | "INTEREST", "myStatus": "NONE" | "MEMBER" | "INTERESTED" } }
```

`mode` is derived by the server from section 4. The customer is never told *why* a business is `INTEREST`, but `mode` itself discloses the
business's entitlement state (OD-20). `myStatus` is the caller's own state only and needs one membership read per list page, batched, with no
other loyalty data (amended 01D section 5). `myStatus` values: `NONE`, `MEMBER`, `INTERESTED`, and `UNAVAILABLE` (the customer's membership is
`suspended`, `business_exited`, `closed` or `pending`): in that state neither Join nor Interest is shown and the page shows a neutral message.

### 5.2 Join (remote enrollment) contract

| Step | Contract |
| --- | --- |
| Entry | Detail page shows a **Join** control only when `mode = JOIN` and `myStatus = NONE`. |
| Notice | Before the request the customer sees the versioned enrollment notice (`noticeId`, `noticeVersion`, rendered text) for this path (CA-08, OD-9). The notice states that joining creates a loyalty membership with this business and what the business receives. It is **not** a promotional-consent prompt; promotional consent is never bundled. |
| Request | One explicit confirm sends `{ noticeId, noticeVersion, idempotencyKey }` for the profile handle. |
| Server checks (one transaction) | Discovery on; handle resolves to a `discoverable` business; `entitledRemote` ∧ `optedIn` ∧ `programReady` **re-evaluated now under row locks** (a share lock on the settings and subscription rows); customer active and not limited (`assertCustomerNotLimited('join_business')`); per-customer daily remote-join cap enforced **in the database** under a per-customer advisory lock (the Cloudflare limiter supports only 10 s / 60 s periods and a count-then-insert would race); then the membership service logic (reactivate a `left` membership; otherwise create; loyalty-account consistency). A concurrent duplicate join hits the membership unique index and the handler returns the existing membership. |
| Writes | Same rows as the QR join: membership (`onboarding_source = 'remote_discovery'`, `onboarding_reference` = the **public handle**, never the internal profile id, because `CustomerMembershipDto` returns the reference to the customer), a `join_loyalty` consent grant carrying `noticeId`/`noticeVersion`, loyalty account. **No points, no Community membership, no notification to the customer, no marketing consent.** *Implementation requirement:* today the service creates a consent grant only when no active `join_loyalty` grant exists, so a customer who left and rejoins would not record the new notice; the remote path must revoke the earlier grant and create a new one (there is no leave endpoint or revoke-on-leave today). |
| Idempotency | `consent_grants.idempotency_key` is **globally unique** (`consent-grants.ts:46`), so the server derives the stored key from `(customerId, businessId, clientKey)` and never uses the client key raw (otherwise a reused key or a cross-customer collision is a unique violation). There is no response replay store: repeating a join returns `200` with the existing membership; this is new behaviour, not an "existing idempotency rule". |
| Responses | `201` created / `200` already a member or idempotent replay; `404 NOT_AVAILABLE` for any non-discoverable handle (identical for unknown, unpublished, suspended); `409 MODE_CHANGED` (carrying the current `mode`) when the business is discoverable but no longer offers Join (the UI falls back to Interest); `403 CUSTOMER_LIMITED`; `409 MEMBERSHIP_NOT_REACTIVATABLE` (the existing service refuses `suspended`, `business_exited`, `closed` and `pending` memberships); `429`. |

**What joining gives the business (must be in the notice, OD-9, and decided in OD-21).** Today staff with `messages:send` can open a
conversation with any enrolled customer (`api/messaging/conversation.service.ts:50-52`) and `message_received` notifications default to enabled
email/SMS. A remote join therefore gives the business an immediate outbound channel to a customer who never visited. The notice must say so, or
remote-joined members are non-messageable until the customer initiates contact (proposal; this changes the messaging gate and is flagged).

### 5.3 Express interest contract

| Aspect | Contract |
| --- | --- |
| Effect | Records at most one **active** interest per (customer, business). Creates no membership, loyalty account, consent grant, points, contact permission, or customer-visible notification. |
| Request | `PUT` to express, `DELETE` to withdraw. The customer first sees a short notice: "The business is told only how many customers are interested, never who." |
| Server checks | Discovery on; handle resolves to a `discoverable` business; `mode = INTEREST` at this moment; customer active and not limited; per-customer active-interest cap and re-submit cooldown (OD-7). |
| Customer view | `GET` of the customer's own interests (their data only). |
| Conversion | If the customer later joins the same business (QR or remote), the interest is marked converted; it then stops counting toward "interested" totals. |
| Expiry | Interest expires after a fixed period (OD-7) so counts reflect current demand. |
| Non-goals | No ranking, recommendation, advertising, or sharing of interest with any other business. |

### 5.4 UI states (additions to `BDPN_01D` section 4)

Card and detail: `Join` (mode JOIN), `I'm interested` / `Interest recorded · Withdraw` (mode INTEREST), `You are a member`, plus
loading, 401 (redirect to customer login), 429/5xx ("could not be completed right now"), and 404 (the existing single not-found screen).
All copy lives in the existing four-language namespace (`en, fr, es, ar`, RTL-safe), reviewed like the rest of discovery.

## 6. Business enrollment-interest and notification design

### 6.1 What the business sees

| Surface | Contract |
| --- | --- |
| Readiness card (staff) | One of `INELIGIBLE`, `ELIGIBLE_DISABLED`, `PROGRAM_NOT_READY`, `ENABLED`, each with a guidance code. `INELIGIBLE` → upgrade guidance; `ELIGIBLE_DISABLED` → enablement guidance (an "enable remote enrollment" action for holders of the new permission); `PROGRAM_NOT_READY` → setup guidance. The card never names other businesses or customers. |
| Interest summary (staff) | Aggregated counts only: distinct interested customers in **non-overlapping calendar weeks**, rounded into buckets once at or above K, and shown as "fewer than K" below it (OD-8). **Every figure obeys K**; conversions are not shown (the business already holds its member list and join times, so a conversion count would identify who had been interested). No identities, no timestamps finer than a week, no per-customer export, no filtering by customer attributes. |
| Digest notification (staff) | A staff notification event (proposed `enrollment_interest_digest`) delivered through `NotificationService.notifyBusinessStaff` to holders of the new permission, at most **once per week** per business, only when the bucketed count meets K, containing the bucket, the week and the guidance state. Email by default; SMS only if the business already enabled it, and then it counts against `maxSmsPerDay`. It respects the existing kill switches. `NotificationService` has no per-business idempotency and no scheduler today; both are new work (section 10). |

### 6.2 Privacy rules

- Interest rows hold the customer id for de-duplication and conversion only; **no business endpoint reads them row by row**. Business
  reads go through a single aggregate query scoped by tenant context.
- The aggregate is designed to make singling out a customer hard, **not impossible**: K, whole-week non-overlapping windows, buckets, no
  conversions and no "new since" deltas. Residual risk: staff can create customer accounts, so K-1 colluding accounts plus one target defeats any K.
  The platform's own upsell signal can also be inflated this way; bursts of interest are monitored (T-19).
- No customer contact detail, phone, name or email is ever part of an interest payload or notification.
- Withdrawal and customer deletion remove the interest (cascade). Retention is the expiry in OD-7.

### 6.3 Why aggregate-only

Owner decision 7 forbids unrestricted customer identity access. Aggregates are also what makes the feature safe to offer to
businesses that cannot (yet) act on it: guidance, not leads.

## 7. Promotion entitlement and moderation design

Scope (owner decision 9): promotional posts, discounts and survey discovery. Separate from remote enrollment (owner decision 4).

| Aspect | Design |
| --- | --- |
| Entitlement | `plan.features.promotions === true` and an accepted subscription status (OD-3), evaluated at read time. No entitlement ⇒ promotional content is not shown, never deleted. |
| Prerequisite | A **published, approved discovery profile** (`NETWORK_00_CONTENT_MODEL_AND_ACCESS.md` N-06). Both the profile and the promotional entitlement are required (conflict C-8). |
| Content classes (v1) | `business_post` only, as the NETWORK documents define; `sponsored`, customer posts and B2B listings remain out of scope. |
| Discounts | A discount in a post is **display text only**. It cannot create or change a price, voucher, reward, credit, points or invoice, cannot be machine-redeemed, and cannot reference loyalty rewards. Offer terms must be in the text (NETWORK moderation rule). |
| Promoted survey | A reference to an **existing** survey campaign, shown to customers who already meet that campaign's audience rules, evaluated at read time with the existing audience semantics (no participation is created by viewing). Participation, consent and Community-points evidence stay exactly as implemented. Requires entitlement and an approved publication (conflict C-5). |
| Moderation | The NETWORK moderation model: revisions `draft/submitted/approved/rejected/superseded`; posts `unpublished/published/suspended/withdrawn`; reviewer must differ from the submitter; content digest; pre-moderation for promotions; platform admins only (D-03). Moderators see no customer data. |
| Lapse | Entitlement lost ⇒ content hidden at the next read; restored without re-review if the approved digest is unchanged and the entitlement returns (mirrors D-13), subject to OD-4. |
| Notifications | Promotional customer notifications are **out of scope**: they would need per-channel opt-in consent (NETWORK-06, `consent_grants.purpose = 'marketing'`) and remain a later block. |
| Survey rights | Customers' existing survey rights are unaffected; gating applies only to **discovery of** a survey through the Network surface (owner decisions 9 and 10). |

## 8. Proposed API and data contracts (PROPOSALS — nothing here exists)

### 8.1 Entitlement evaluator (read-only)

A single pure function over the existing subscription mirror and plan row; no schema change:

```
entitlementsFor(businessId) -> { remoteEnrollment: boolean, promotions: boolean }
  reads business_subscriptions.status and subscription_plans.features (jsonb)
  true only when status is in the accepted set (OD-3) AND the feature key is exactly true
  never writes; never calls Stripe; never changes subscription state; absent key = false
```

It is evaluated inside the same transaction as the action it guards (join), and inside the read query for discovery flags.
Specified inputs the evaluator must handle: no subscription row (the existing allowance trigger treats this as the Free plan); an inactive plan
(`is_active = false`); `cancel_at_period_end`; expired card-less trials (moved to Free with status `active`); new businesses start `trialing` on
`starter`. **Authority hazard:** `subscription_plans.features` can be edited by platform `billing`/`admin` through `PATCH /platform/billing/plans/:id`
(`api/platform/billing-plans.routes.ts:101`), and `reconcileCatalog` (`api/repositories/subscription-plan.repository.ts:104-141`) overwrites DB
features from the code catalog on billing calls and the trial-expiry job, so a catalog edit reaches production without a migration gate and a platform
PATCH can grant the entitlement transiently. Granting an entitlement is therefore an audited, owner-controlled act (OD-2, OD-14).
Placement and ownership of this authority are OD-14 (conflict C-6). Adding the two feature keys to the catalog is an economic
decision (OD-2); `features` is open jsonb, so no migration is needed, but `subscription-catalog.ts` and its seed are the approved catalog.

### 8.2 Customer endpoints (behind `/discovery`, customer session, activation flag, per-customer limiter, `no-store`)

| Proposal | Request | Responses |
| --- | --- | --- |
| `POST /discovery/businesses/{profileId}/enrollment` | `{ noticeId, noticeVersion, idempotencyKey }` | `201/200` membership summary (own data); `404 NOT_AVAILABLE`; `409 MODE_CHANGED`; `403 CUSTOMER_LIMITED`; `429` |
| `PUT /discovery/businesses/{profileId}/interest` | none | `204`; `404`; `409 MODE_CHANGED` (carries the current `mode`; the same single code is used by the enrollment endpoint instead of two separate oracle codes); `403`; `429` |
| `DELETE /discovery/businesses/{profileId}/interest` | none | `204` (idempotent) |
| `GET /discovery/me/interests` | none | the caller's own active interests (handle, display name only) |

### 8.3 Business endpoints (staff, tenant context, new permission, audited)

| Proposal | Purpose |
| --- | --- |
| `GET /loyalty/enrollment-readiness` | State and guidance code (section 6.1) |
| `PUT /loyalty/remote-enrollment-setting` `{ enabled }` | Opt in or out. Rejected unless `entitledRemote`; writes an audit row; never touches billing |
| `GET /loyalty/enrollment-interest/summary` | Aggregated counts with the K floor |

New permission keys (proposal): `enrollment:remote:manage` (setting), `enrollment:interest:view` (summary and digest). Owners and Admins
by default, consistent with D-02 (OD-8).

### 8.4 Data (proposal)

| Object | Shape | Notes |
| --- | --- | --- |
| `business_enrollment_settings` | `business_id` (pk, fk), `remote_enrollment_enabled boolean not null default false`, `updated_by`, `updated_at` | One row per business; default off |
| `customer_enrollment_interests` | `id`, `customer_id` (fk, cascade), `business_id` (fk), `status` (`active`/`withdrawn`/`converted`/`expired`), `created_at`, `withdrawn_at`, `converted_membership_id` (nullable) | Partial unique index on `(customer_id, business_id)` where `status = 'active'`; index on `(business_id, created_at)`; never read row-wise by business routes |
| Plan features | `remoteEnrollment`, `promotions` (booleans in the existing jsonb) | No migration; catalog change is OD-2 |
| Membership | `onboarding_source = 'remote_discovery'`; `onboarding_reference` = internal profile id | The column is free `text` (migration `0034`); **no migration** for the new value |
| Consent grant | `purpose = 'join_loyalty'`, `consentVersion = noticeVersion`, metadata `{ onboardingSource, noticeId, noticeVersion, membershipId }` | Existing table and idempotency rules |
| Notification | staff event `enrollment_interest_digest`; counts only; per-business-per-week idempotency (new; the service has none today) | Added to the staff event set; needs the CHECK-constraint changes in section 10 |

## 9. Security, privacy, abuse and tenant-isolation threat analysis

| ID | Threat | Mitigation (design) |
| --- | --- | --- |
| T-1 | **Enrollment bombing**: a script remote-joins a customer to many businesses, or many fake customers join one business | OTP-verified customer required; one membership per customer-business (existing unique index); per-customer remote-join cap enforced **in the database** under an advisory lock (a count-then-insert would let parallel requests exceed it) plus the per-customer rate limit; limited/suspended customers blocked; remote joins counted separately so abuse is visible |
| T-2 | **Entitlement bypass or race** (join after downgrade; opt-in toggled mid-request) | `entitledRemote`, `optedIn`, `programReady` re-evaluated in the join transaction **with share locks on the settings and subscription rows** (READ COMMITTED alone lets a concurrent opt-out or downgrade interleave); client-supplied flags ignored; the server derives `mode`; a concurrent duplicate join returns the existing membership |
| T-3 | **Plan/tier and payment-state leak** through discovery | **Not fully prevented.** `mode` itself discloses that a business holds the entitlement and opted in, and a JOIN to INTEREST flip signals a lapse or non-payment to every customer, including competitors. Mitigations: no plan or setting names, one `MODE_CHANGED` code instead of two oracle codes, uniform `404`, a `past_due` grace window; the residual disclosure is an owner decision (OD-20) |
| T-4 | **Identity inference** from small counts, differencing or conversions | K applies to every figure; whole-week non-overlapping windows; buckets; **no conversion figure** (the business already holds member join times); no per-customer rows to businesses; no export. Residual: colluding or staff-created accounts can defeat any K (T-19) |
| T-5 | **Cross-tenant read** of interest data | Business reads only via the tenant-scoped aggregate; customers read only their own interests; no customer-keyed business endpoint |
| T-6 | **IDOR** through identifiers | Opaque handle only (D-10); the server resolves handle to business; clients never pass a business id |
| T-7 | **Interest spam / flip-flopping** to manipulate counts | One active interest per business; per-customer cap; cooldown after withdrawal; expiry; conversion removes the interest |
| T-8 | **Consent integrity**: joining without informed consent, or replay | Versioned notice id recorded on the consent grant; idempotency key; promotional consent never bundled; legal review of the wording (OD-9) |
| T-9 | **Scraping or enumeration of the business directory** | Customer session required (D-09); `no-store`; per-customer limiter; uniform not-found; activation flag off by default |
| T-10 | **Misleading promotions / discount fraud** | Pre-moderation, offer terms required, reviewer ≠ submitter, plain-text rendering, display-only discounts with no machine redemption |
| T-11 | **Financial boundary crossing** (enrollment awarding points, creating credits, touching Stripe) | Enrollment awards nothing; no Community membership auto-created; evaluator is read-only; no write to billing, Partner Credits or settlements; Splits 05-08 unchanged |
| T-12 | **Notification abuse** (spamming staff or customers) | Staff digests only, at most weekly and above K; no customer notification introduced; existing business kill switches and SMS caps apply |
| T-13 | **Moderator over-exposure** | D-22 safeguards unchanged; no customer or interest data in moderation views |
| T-14 | **Entitlement authority drift** (a business-controlled value becomes entitlement) | Source is the Stripe-mirrored subscription plus the approved catalog only; never business-supplied metadata (matches the partner-credit reconciler rule) |
| T-15 | **Shared-egress rate-limit collapse**: customer endpoints behind the web Worker share one IP bucket | Limiters keyed by customer id (`rateLimitByCustomer`), as BDPN-01C already requires; never the IP bucket (see the staff-login findings in `STAFF-LOGIN-THROTTLING-DESIGN.md`) |
| T-16 | **Audit gaps** | Established fact: the audit middleware records no successful customer mutation (it returns when there is no staff `userId`, `api/middleware/audit.ts:173-174`) and `audit_log.actor_user_id` references `users` only. The join block therefore needs an explicit record (customer id in metadata or a new column) for success and refusal, stored so that **refusals are not visible in the business's own audit log** (a refusal row would tell a business about a non-member's attempt), plus setting-change and promotion-moderation rows (OD-22) |
| T-17 | **Downgrade surprise** (members or content disappearing) | Existing memberships are never altered (owner decision 10); only the Join control and promotional visibility change, at read time |
| T-18 | **Contactability without presence**: a remote join gives the business a messaging channel (`messages:send`, default-on `message_received` email/SMS) and the customer's entry in its member directory, with no visit | The notice states it; remote-joined members are non-messageable until the customer initiates contact (proposal, OD-21); the BDPN v1.0 lock forbids using messaging to bypass the enrollment gate (`architecture/decisions/ECHO_GRID_BUSINESS_DISCOVERY_PROMOTION_NETWORK_V1.md:50,59`) |
| T-19 | **Gaming through presence-free membership**: mass remote join reaches the `business_member` survey audience (`api/surveys/survey-participation.service.ts:139-158`), whose completions feed Community Points evidence; sybil interest inflates the "upgrade" signal and can push a business over K | OD-23 (whether remote-joined members are excluded from `business_member` survey eligibility until a first visit); interest caps, cooldown and expiry; burst monitoring; the platform treats interest counts as guidance, never as billing evidence |

Tenant isolation summary: no business-facing endpoint can return a customer-level record from this feature; every business read passes
through tenant context and a permission; every customer read is limited to the caller.

## 10. Compatibility and migration-impact assessment

| Area | Impact |
| --- | --- |
| QR enrollment, `POST /customer-memberships/join`, `POST /loyalty/me/join` | **Unchanged.** The remote path reuses the membership service logic (extracted behind identical behavior in the implementation block, with the existing QR tests as the regression gate). Whether remote join satisfies Split 01 invariant 4 is OD-17. |
| Memberships, loyalty accounts, points, rewards, consent history | Unchanged data; one new value in the free-text `onboarding_source` column (no CHECK; nothing branches on it) |
| Customer auth | Unchanged; discovery and the new actions use the existing OTP JWT session. Password-auth routes remain unmounted |
| Split 05 Community, Splits 06-08 | No contact; the evaluator is read-only |
| `GET /businesses/:id/public` | Unchanged (D-25) |
| Surveys | Participation unchanged; only Network discovery of a survey is gated. A promoted survey reads surveys and memberships (conflict C-13) |
| Notifications | A new staff event type is **not** free: it changes the shared `notificationEventTypeSchema` and requires dropping and re-adding two CHECK constraints (`notifications_event_type_check`, `notification_preferences_event_type_check`, migration `0005`; `api/db/schema/notifications.ts:61`, `notification-preferences.ts:65`). `NotificationService` also has no per-business-per-day idempotency and there is no digest scheduler: both are new |
| Permissions | New permission keys must be granted to existing businesses' Owner/Admin roles: a data backfill using the separately gated reconcile-seed precedent (`api/rbac/loyalty-permissions.ts`, `role-provisioning.service.ts:144-145`) |
| Audit | Customer-attributed rows need a convention or a new column; today's middleware records none (T-16) |
| Database | At least one migration for `business_enrollment_settings` and `customer_enrollment_interests`, plus the notification CHECK changes and the permission reconcile. B6/B7 additionally need the NETWORK tables and a survey-reference store. This conflicts with the BDPN "single migration" statements (D-19, 01E M1, `NETWORK:142`; conflict C-14, OD-24). The BDPN-01 schema migration must still land first |
| Messaging | Only if OD-21 chooses non-messageable remote members: a change to the conversation-open gate (`api/messaging/conversation.service.ts:50-52`) |
| Migration governance | Gate 2 count pins are derived from the journal (MIGRATION-GOV-01), so adding migrations needs no pin edits |
| Gate 2 / financial guards | Not touched. Any new table must pass the Gate 2 tenant and RLS audits like the rest |
| Rollout | Every new endpoint and the Join/Interest controls sit behind the existing discovery activation flag (D-20), default off; remote enrollment additionally defaults off per business. Customer endpoints use `rateLimitByCustomer`, which already exists; the `DISCOVERY_RATE_LIMITER` named in BDPN-01C does not exist yet |
| Rollback | Switch off the flag; `remote_enrollment_enabled` defaults false; existing memberships remain valid |

The earlier statement "1 migration, 2 tables, 0 altered columns, 0 backfills" is **withdrawn**: the corrected, still unverified, minimum is stated above.

## 11. Independently gated development blocks

None starts without its own explicit owner authorization. Each ends with verification, a completion report and a stop.

| Block | Scope | Depends on | Gate |
| --- | --- | --- | --- |
| **G0** | Independent review and owner approval of this amendment (documentation only) | nothing | Required before any block below |
| **P** (prerequisite) | The existing BDPN-01 implementation blocks (schema, moderation, discovery API, Community entry card) and the migration backlog plan (D-19) | G0, D-16, D-19 | Existing BDPN gates |
| **E0** | Read-only entitlement evaluator, the two catalog feature keys, tests (no schema change) | G0, OD-2, OD-3, OD-4, OD-14 | Owner economic decision |
| **B2** | Business setting, readiness endpoint and card, new permissions, audit | E0, P | Independent review |
| **B3** | Interest storage, customer interest endpoints, expiry, caps (needs `mode`, hence E0 and B2) | P, E0, B2, OD-7, OD-25 | Independent review |
| **B4** | Aggregated summary and weekly digest, including the notification CHECK migration, scheduler and per-business idempotency | B3, OD-8, OD-24 | Privacy review |
| **B5** | Remote enrollment endpoint (shared membership logic, notice contract, caps, locks, audit, interest conversion marking) | B2, B3, E0, OD-6, OD-9, OD-11, OD-12, OD-17, OD-21, OD-22 | **Independent security review** plus all QR join tests green |
| **B6** | Promotion entitlement, `business_post`, moderation | E0, P, NETWORK moderation design | Content-policy and legal review |
| **B7** | Promoted survey discovery (and a customer "eligible surveys" read) | B6, OD-16 | Independent review |
| **C** | Threat-test and live-device certification, staging verification | all of the above | Owner |

Dependencies are acyclic; B5 is last among the enrollment blocks. B6 also depends on OD-26 (NETWORK-05/BDPN-05 phasing) and B7 on OD-23.

## 12. Status of CUSTOMER-AUTH-01 open questions after this amendment

| ID | Question | Status |
| --- | --- | --- |
| CA-06 | Remote enrollment eligibility incl. plan and publication | **Answered in design, pending inputs** (owner decisions 1, 3, 4: published + entitlement + opt-in); the plan list (OD-2) and status semantics (OD-3) are still open |
| CA-07 | Limited to selected programs? | **Answered in design, pending inputs**: per-business explicit opt-in (owner decision 3); "program ready" (OD-6) is undefined |
| CA-08 | Consent language, notice, versioning | **Still open**: the amendment fixes the contract (versioned notice id on the consent grant) but not the wording or legal review (OD-9). The QR path still hard-codes `consentVersion: 'v1'`, so CA-08 also covers the QR path |

## 13. Owner decision register

| ID | Decision needed | Why it matters |
| --- | --- | --- |
| OD-1 | Confirm D-24 is replaced for discoverability (no plan gating of visibility) | Conflict C-1; changes the locked D-24 and `BDPN_01A` section 6 |
| OD-2 | Which plans include `remoteEnrollment` and which include `promotions`; whether bundled | Economic; edits the approved catalog |
| OD-3 | Which subscription statuses count as entitled (`active`, `trialing`; `past_due` grace?) | Nothing in code branches on status today |
| OD-4 | Behaviour on downgrade/cancel: confirm Join disappears, members stay, interest retained, promotions hidden not deleted | Owner decision 10 vs entitlement loss |
| OD-5 | Names of the two feature keys and the permission keys | Contract stability |
| OD-6 | Definition of "loyalty program available" for remote enrollment; whether a program-enabled flag is added | The QR path has no such check today; adding it to QR is out of scope here |
| OD-7 | Interest limits: max active interests per customer, cooldown, expiry; remote-join daily cap | Abuse and data minimization |
| OD-8 | Digest threshold K, frequency, recipients and permission | Aggregation privacy |
| OD-9 | Notice wording for the remote path and whether counsel reviews it | CA-08, consent integrity |
| OD-10 | Whether an interested customer is told when the business starts offering Join (needs a customer event and opt-in) | Out of scope unless chosen |
| OD-11 | Branch context for remote enrollment (the QR carries a branch; the remote path has none) | Membership and consent have no branch column today |
| OD-12 | Confirm remote enrollment awards nothing automatically (same as QR) | Financial boundary |
| OD-13 | Split 09 reliance on "discoverable" (D-23 stays deferred) | Decision 1 now defines "discoverable" without plans |
| OD-14 | Where the entitlement authority is specified and owned (C-6) | No such specification exists in the repository |
| OD-15 | v1 promotion scope: `business_post` only, display-only discounts; moderation staffing | Content policy |
| OD-16 | Eligibility display rule for promoted surveys; whether a customer "eligible surveys" list is built | Survey discovery does not exist today |
| OD-17 | Does published profile + entitlement + explicit opt-in count as the "authorized business context" Split 01 invariant 4 and Split 03 section 4 require for joining? | Conflict C-10; the QR is currently the canonical context |
| OD-18 | Meaning of "participating" in owner decision 1 | Not defined by the eligibility predicate |
| OD-19 | Opt-in persistence after an entitlement lapse and return: persists, or must be re-confirmed | Owner decision 3 says "explicit" |
| OD-20 | Accept that `mode` discloses the business's entitlement state, and a lapse signal; grace window for `past_due` | Tier and payment-state disclosure (T-3) |
| OD-21 | Messaging reach of remotely joined members: allow, or non-messageable until the customer initiates | Remote join creates an outbound channel without presence (T-18) |
| OD-22 | Where customer-attributed join and refusal audit records are stored and who can read them | Today's middleware records none; refusals must not appear in the business's audit log |
| OD-23 | Whether remotely joined members are excluded from the `business_member` survey audience until a first visit | Presence-free route to survey eligibility (T-19) |
| OD-24 | Amend the "single BDPN migration" rule (D-19, 01E M1) or accept additional migrations | Conflict C-14 |
| OD-25 | Reuse the NETWORK `network_follows` design for interest instead of a new relation | Avoids two parallel customer-to-business relations (C-13) |
| OD-26 | May plan-gated promotions precede NETWORK-05 and BDPN-05 as scheduled | Phasing conflict (C-13) |

## 14. Review and approval gate

1. This document is a proposal. It is not in force until an **independent review** (not by the author of this document) and the
   owner's explicit approval, recorded as a new version of the BDPN decision record.
2. **Remote enrollment must not be implemented before that approval**, and block B5 additionally needs its own independent security review.
3. Nothing in this PR changes code, schema, configuration, secrets, staging or production.
4. If review finds a conflict with a locked decision not listed in the audit, it is added to the audit and the register; it is not resolved by editing the locked document.

## 15. Independent review record and dispositions

A separate model session that did not write these documents reviewed PR #441 (head `2c7e6726`) and returned **APPROVE WITH CHANGES**. It is not a
human review; the owner may require one. Each finding was checked against the repository before it was applied; the factual claims verified
(Split 01 invariant 4, BDPN-01C section 3, `network_follows`, the messaging gate, the global idempotency index, the audit early return, the notification
CHECK constraints and the line-number corrections) were correct.

| Finding | Disposition |
| --- | --- |
| H1 Split 01 invariant 4 / Split 03 | Added C-10 and OD-17; removed the claim that Split 01/03 are unaffected |
| H2 BDPN-01C read-only and closed DTO, D-17, 01D no-loyalty-read, 01E T-14 | Added C-11, C-12 and exact amended texts (section 3) |
| H3 NETWORK isolation, `network_follows`, phasing, BDPN v1.0 lock | Added C-13, OD-25, OD-26 |
| H4 Plan and payment-state leak | T-3 rewritten as a residual disclosure; `MODE_CHANGED`; grace window; OD-20 |
| H5 Identity inference | Conversions removed; K on every figure; weekly non-overlapping windows; sybil residual stated (T-4, T-19) |
| H6 Contactability | Notice requirement; T-18; OD-21 |
| H7 Consent contract | New grant on rejoin; server-derived idempotency key; no replay store stated; `MEMBERSHIP_NOT_REACTIVATABLE` and `UNAVAILABLE` state added |
| H8 Migration and contract impact | Section 10 rewritten; the earlier numbers withdrawn; C-14, OD-24 |
| M1 Audit coverage | Established as a fact (audit report section 6); T-16; OD-22 |
| M2 Entitlement authority | Evaluator inputs and the platform PATCH / `reconcileCatalog` hazard added (section 8.1) |
| M3 Races | Share locks and database-enforced cap (5.2, T-1, T-2) |
| M4 D-10 erosion | `onboarding_reference` = public handle |
| M5 Opt-in persistence, setting-endpoint guards | Section 4 and OD-19 |
| M6 Presence-free abuse | T-19, OD-23, SMS counting for the digest |
| M7 Block graph, CA status | Section 11 and 12 corrected |
| Low: citation errors, `status` branching, branch wording, middleware list | Corrected in the audit |

Not verified by the review (unchanged): whether any code creates a `pending` membership, the absence of a non-test caller of
`LoyaltyAccountService.enroll`, that migrations `0069`/`0070` are customer moderation, `apps/web` beyond the files read, and production state.
