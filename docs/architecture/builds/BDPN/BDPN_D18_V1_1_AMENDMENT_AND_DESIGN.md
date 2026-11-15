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
  listed in the audit (C-1 to C-9) and in the owner decision register (section 13), and is **not** silently superseded.

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

What the amendment deliberately does **not** do: define plans or prices (economic, OD-2), define consent wording (legal, OD-9), or
alter any Split 01/03/05/06/07/08 contract.

## 4. Business visibility and entitlement decision matrix

Predicates (proposal; all evaluated server-side, at request time, in the query, never from a stored flag):

- `discoverable(b)` = business `active` and not deleted ∧ published approved profile revision ∧ default-locale translation present
  (`BDPN_01A` section 6 **without** the plan term).
- `entitledRemote(b)` = subscription status accepted by OD-3 ∧ `plan.features.remoteEnrollment === true` (absent = false).
- `optedIn(b)` = `business_enrollment_settings.remote_enrollment_enabled = true`.
- `programReady(b)` = definition pending (OD-6).
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

## 5. Customer discovery and enrollment interaction contracts

All customer endpoints sit behind the existing customer session, the discovery activation flag (default off), the per-**customer**
rate limiter (not the shared-IP limiter, see section 9 T-15) and `private, no-store`.

### 5.1 What discovery responses add (proposal)

Each list item and the detail response gains one closed object. It carries no plan, entitlement or opt-in names:

```json
{ "enrollment": { "mode": "JOIN" | "INTEREST", "myStatus": "NONE" | "MEMBER" | "INTERESTED" } }
```

`mode` is derived by the server from section 4. The customer never learns *why* a business is `INTEREST` (no tier or setting leaks).
`myStatus` is the caller's own state only.

### 5.2 Join (remote enrollment) contract

| Step | Contract |
| --- | --- |
| Entry | Detail page shows a **Join** control only when `mode = JOIN` and `myStatus = NONE`. |
| Notice | Before the request the customer sees the versioned enrollment notice (`noticeId`, `noticeVersion`, rendered text) for this path (CA-08, OD-9). The notice states that joining creates a loyalty membership with this business and what the business receives. It is **not** a promotional-consent prompt; promotional consent is never bundled. |
| Request | One explicit confirm sends `{ noticeId, noticeVersion, idempotencyKey }` for the profile handle. |
| Server checks (one transaction) | Discovery on; handle resolves to a `discoverable` business; `entitledRemote` ∧ `optedIn` ∧ `programReady` **re-evaluated now**; customer active and not limited (`assertCustomerNotLimited('join_business')`); per-customer daily remote-join cap (OD-7); then the existing membership service logic (reactivate a `left` membership, otherwise create; one active `join_loyalty` consent; loyalty-account consistency). |
| Writes | Same rows as the QR join: membership (`onboarding_source = 'remote_discovery'`), one `join_loyalty` consent grant carrying `noticeId`/`noticeVersion` in its metadata, loyalty account. **No points, no Community membership, no notification to the customer, no marketing consent.** |
| Idempotency | Same key returns the original result; a duplicate join returns the existing membership, never an error that reveals state to a third party. |
| Responses | `201` created / `200` already a member or idempotent replay; `404 NOT_AVAILABLE` for any non-discoverable handle (identical for unknown, unpublished, suspended); `409 REMOTE_ENROLLMENT_UNAVAILABLE` when the business is discoverable but no longer offers Join (the UI falls back to Interest); `403 CUSTOMER_LIMITED`; `429`. |

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
| Interest summary (staff) | Aggregated counts only: distinct interested customers in standard windows (7 and 30 days), and conversions. Counts below a minimum threshold K are shown as "fewer than K" (OD-8). No identities, no timestamps finer than a day, no per-customer export, no filtering by customer attributes. |
| Digest notification (staff) | A staff notification event (proposed `enrollment_interest_digest`) delivered through the existing `NotificationService.notifyBusinessStaff` to holders of the new permission, at most once per day per business, only when the count meets K, containing the count, the window and the guidance state. It respects the existing business kill switches and the per-business email/SMS settings. |

### 6.2 Privacy rules

- Interest rows hold the customer id for de-duplication and conversion only; **no business endpoint reads them row by row**. Business
  reads go through a single aggregate query scoped by tenant context.
- The aggregate cannot be used to single out a customer: the K threshold, whole-day buckets and no "new since" deltas below K.
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
Placement and ownership of this authority are OD-14 (conflict C-6). Adding the two feature keys to the catalog is an economic
decision (OD-2); `features` is open jsonb, so no migration is needed, but `subscription-catalog.ts` and its seed are the approved catalog.

### 8.2 Customer endpoints (behind `/discovery`, customer session, activation flag, per-customer limiter, `no-store`)

| Proposal | Request | Responses |
| --- | --- | --- |
| `POST /discovery/businesses/{profileId}/enrollment` | `{ noticeId, noticeVersion, idempotencyKey }` | `201/200` membership summary (own data); `404 NOT_AVAILABLE`; `409 REMOTE_ENROLLMENT_UNAVAILABLE`; `403 CUSTOMER_LIMITED`; `429` |
| `PUT /discovery/businesses/{profileId}/interest` | none | `204`; `404`; `409 JOIN_AVAILABLE` (use Join); `403`; `429` |
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
| Notification | staff event `enrollment_interest_digest`; counts only; per-business-per-day idempotency | Added to the staff event set |

## 9. Security, privacy, abuse and tenant-isolation threat analysis

| ID | Threat | Mitigation (design) |
| --- | --- | --- |
| T-1 | **Enrollment bombing**: a script remote-joins a customer to many businesses, or many fake customers join one business | OTP-verified customer required; one membership per customer-business (existing unique index); per-customer daily remote-join cap and per-customer rate limit; limited/suspended customers blocked; remote joins counted separately so abuse is visible |
| T-2 | **Entitlement bypass or race** (join after downgrade; opt-in toggled mid-request) | `entitledRemote`, `optedIn`, `programReady` re-evaluated in the join transaction; client-supplied flags ignored; the server derives `mode` |
| T-3 | **Plan/tier leak** through discovery responses or error codes | Only `mode` and `myStatus` are exposed; no plan, entitlement or setting names; uniform `404` for non-discoverable |
| T-4 | **Identity inference** from small counts or differencing | K threshold, whole-day buckets, no per-customer rows to businesses, no deltas below K, no export |
| T-5 | **Cross-tenant read** of interest data | Business reads only via the tenant-scoped aggregate; customers read only their own interests; no customer-keyed business endpoint |
| T-6 | **IDOR** through identifiers | Opaque handle only (D-10); the server resolves handle to business; clients never pass a business id |
| T-7 | **Interest spam / flip-flopping** to manipulate counts | One active interest per business; per-customer cap; cooldown after withdrawal; expiry; conversion removes the interest |
| T-8 | **Consent integrity**: joining without informed consent, or replay | Versioned notice id recorded on the consent grant; idempotency key; promotional consent never bundled; legal review of the wording (OD-9) |
| T-9 | **Scraping or enumeration of the business directory** | Customer session required (D-09); `no-store`; per-customer limiter; uniform not-found; activation flag off by default |
| T-10 | **Misleading promotions / discount fraud** | Pre-moderation, offer terms required, reviewer ≠ submitter, plain-text rendering, display-only discounts with no machine redemption |
| T-11 | **Financial boundary crossing** (enrollment awarding points, creating credits, touching Stripe) | Enrollment awards nothing; no Community membership auto-created; evaluator is read-only; no write to billing, Partner Credits or settlements; Splits 05-08 unchanged |
| T-12 | **Notification abuse** (spamming staff or customers) | Staff digests only, at most daily and above K; no customer notification introduced; existing business kill switches and SMS caps apply |
| T-13 | **Moderator over-exposure** | D-22 safeguards unchanged; no customer or interest data in moderation views |
| T-14 | **Entitlement authority drift** (a business-controlled value becomes entitlement) | Source is the Stripe-mirrored subscription plus the approved catalog only; never business-supplied metadata (matches the partner-credit reconciler rule) |
| T-15 | **Shared-egress rate-limit collapse**: customer endpoints behind the web Worker share one IP bucket | Limiters keyed by customer id (`rateLimitByCustomer`), as BDPN-01C already requires; never the IP bucket (see the staff-login findings in `STAFF-LOGIN-THROTTLING-DESIGN.md`) |
| T-16 | **Audit gaps** | Audit rows for remote joins (success and refusal), setting changes and promotion moderation; the global `auditTrail` coverage of customer routes is UNKNOWN today and must be verified before the join block |
| T-17 | **Downgrade surprise** (members or content disappearing) | Existing memberships are never altered (owner decision 10); only the Join control and promotional visibility change, at read time |

Tenant isolation summary: no business-facing endpoint can return a customer-level record from this feature; every business read passes
through tenant context and a permission; every customer read is limited to the caller.

## 10. Compatibility and migration-impact assessment

| Area | Impact |
| --- | --- |
| QR enrollment, `POST /customer-memberships/join`, `POST /loyalty/me/join` | **Unchanged.** The remote path reuses the membership service logic (refactored behind the same behavior only in the implementation block, with the existing QR tests as the regression gate). |
| Memberships, loyalty accounts, points, rewards, consent history | Unchanged; one new `onboarding_source` value in an existing free-text column |
| Customer auth | Unchanged; discovery and the new actions use the existing OTP JWT session. Password-auth routes remain unmounted |
| Split 05 Community, Splits 06-08 | No contact; evaluator is read-only |
| `GET /businesses/:id/public` | Unchanged (D-25) |
| Surveys | Participation unchanged; only Network discovery of a survey is gated |
| Notifications | One new staff event type; transactional customer events unchanged |
| Database | **Two new small tables** and no change to existing tables. They belong to the same migration chain as BDPN: BDPN-01's own schema migration (D-19) must land first. Plan features need no migration |
| Migration governance | Gate 2 count pins are now derived from the journal (MIGRATION-GOV-01), so adding migrations needs no pin edits |
| Gate 2 / financial guards | Not touched. Any new table must pass the Gate 2 tenant and RLS audits like the rest |
| Rollout | Every new endpoint and the Join/Interest controls sit behind the existing discovery activation flag (D-20), default off; remote enrollment additionally defaults off per business |
| Rollback | Switch off the flag; `remote_enrollment_enabled` defaults false; existing memberships remain valid |

Migration-impact numbers (proposal, not verified): 1 migration, 2 tables, 0 altered columns, 0 data backfills.

## 11. Independently gated development blocks

None starts without its own explicit owner authorization. Each ends with verification, a completion report and a stop.

| Block | Scope | Depends on | Gate |
| --- | --- | --- | --- |
| **G0** | Independent review and owner approval of this amendment (documentation only) | nothing | Required before any block below |
| **P** (prerequisite) | The existing BDPN-01 implementation blocks (schema, moderation, discovery API, Community entry card) and the migration backlog plan (D-19) | G0, D-16, D-19 | Existing BDPN gates |
| **E0** | Read-only entitlement evaluator, the two catalog feature keys, tests (no schema change) | G0, OD-2, OD-3, OD-4, OD-14 | Owner economic decision |
| **B2** | Business setting, readiness endpoint and card, new permissions, audit | E0, P | Independent review |
| **B3** | Interest storage, customer interest endpoints, expiry, caps | P, OD-7 | Independent review |
| **B4** | Aggregated summary and daily digest | B3, OD-8 | Privacy review |
| **B5** | Remote enrollment endpoint (shared membership logic, notice contract, caps, audit) | B2, E0, OD-6, OD-9, OD-11, OD-12 | **Independent security review** plus all QR join tests green |
| **B6** | Promotion entitlement, `business_post`, moderation | E0, P, NETWORK moderation design | Content-policy and legal review |
| **B7** | Promoted survey discovery (and a customer "eligible surveys" read) | B6, OD-16 | Independent review |
| **C** | Threat-test and live-device certification, staging verification | all of the above | Owner |

Dependencies are acyclic; B3/B4 and B2 are independent of each other; B5 is last among the enrollment blocks.

## 12. Status of CUSTOMER-AUTH-01 open questions after this amendment

| ID | Question | Status |
| --- | --- | --- |
| CA-06 | Remote enrollment eligibility incl. plan and publication | **Answered in design** by owner decisions 1, 3, 4: published + entitlement + opt-in; plan list is OD-2 |
| CA-07 | Limited to selected programs? | **Answered in design**: per-business explicit opt-in (owner decision 3); program readiness OD-6 |
| CA-08 | Consent language, notice, versioning | **Still open**: the amendment fixes the contract (versioned notice id on the consent grant) but not the wording or legal review (OD-9) |

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

## 14. Review and approval gate

1. This document is a proposal. It is not in force until an **independent review** (not by the author of this document) and the
   owner's explicit approval, recorded as a new version of the BDPN decision record.
2. **Remote enrollment must not be implemented before that approval**, and block B5 additionally needs its own independent security review.
3. Nothing in this PR changes code, schema, configuration, secrets, staging or production.
4. If review finds a conflict with a locked decision not listed in the audit, it is added to the audit and the register; it is not resolved by editing the locked document.
