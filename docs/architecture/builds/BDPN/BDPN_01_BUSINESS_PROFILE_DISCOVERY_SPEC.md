# BDPN-01 — Published Business Profiles & Customer Discovery: Architecture & Contract Specification

**Status: DESIGN PROPOSAL — DOCUMENTATION ONLY. Nothing here is implemented, and nothing here authorizes
implementation, a migration, an endpoint, a page, a notification, marketing, a merge or a deployment.**

- Project: Echo Grid — INFINICUS LLC
- Block: BDPN-01 — Architecture & Contract Freeze (design only)
- Baseline: `origin/main` @ `443739e95ef0b993647f31ff8c529ef44eb1b72e` (verified identical to the owner's last-observed SHA)
- Companions: `BDPN_01_SECURITY_AND_CONSENT_BOUNDARIES.md`, `BDPN_01_IMPLEMENTATION_SEQUENCE.md` (contains the decision register)
- Locked inputs (not amended here): `ECHO_GRID_BUSINESS_DISCOVERY_PROMOTION_NETWORK_V1.md` (BDPN v1.0),
  `SPLIT-09/SPLIT09_BDPN_RECONCILIATION.md`, Splits 01, 02, 05, 07, 08.
- Wording: **"proposed"** means a design choice made by this document for owner review. **"OPEN"** means an owner
  decision this document deliberately does not make; each is numbered `D-xx` in the decision register.

## 0. Verified repository status (checked on the baseline)

| Item                                     | Verified result                                                                                                                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PR #353 (BDPN v1.0 decision)             | MERGED                                                                                                                                                                                                                                                                         |
| PR #360 (Partner terms screen)           | MERGED                                                                                                                                                                                                                                                                         |
| PR #361 (Split 09 / BDPN reconciliation) | MERGED                                                                                                                                                                                                                                                                         |
| Community Hub H1                         | Implemented and merged (#352): read-only membership and Community Points at `/loyalty/dashboard/community`. It has **no discovery area**.                                                                                                                                      |
| Customer Surveys H2                      | Implemented and merged (#359): history and take-survey pages at `/loyalty/dashboard/surveys`. No "available to me" list exists.                                                                                                                                                |
| Open pull requests                       | None. No other branch, document or PR specifies business profiles or discovery, so there is no conflicting or duplicate specification.                                                                                                                                         |
| Migration sequence                       | 68 migrations, `0000`–`0067`; the last is `0067_customer_preferred_locale` (merged, **not applied** to staging or production). Staging is at 45.                                                                                                                               |
| Gate 2 constraints                       | Scripts, three workflows and release tests hard-pin the journal at **68 entries ending in `0067`** (18 files matched by a pattern search on this baseline; the authoritative list must be regenerated at implementation time). Any new migration requires a re-pin.            |
| Existing public business data            | `GET /businesses/:id/public` returns `id, name, defaultLocale, defaultCurrency, defaultTimezone, categoryKey` for **any business that exists**, by id, with only a rate limit. It is **not publication-gated** and must not become the discovery source (see Security doc §3). |
| Public-profile storage                   | **None exists.** `businesses` has `name, slug, legalName, industry, categoryId, defaultLocale/Currency/Timezone, status` (`active                                                                                                                                              | suspended | archived`) and soft-delete columns. There is no description, logo, contact, website, media, publication or moderation state. |
| Media storage                            | An R2 binding `UPLOADS` is declared in `wrangler.toml` and typed in `env.ts`, but **no source file uses it**. No upload, validation or serving pipeline exists.                                                                                                                |
| Consent                                  | `consent_grants` purposes: `join_loyalty, marketing, survey_participation, settlement_access, contact_sharing`. Nothing creates a `marketing` grant. Not used by this design.                                                                                                  |
| Moderation precedent                     | Platform authority is code-owned platform permissions layered on `requirePlatformRole` (see `platform/community-permissions.ts`), re-resolved from the database on every request. This is the proposed pattern for moderation.                                                 |
| Audit precedent                          | `audit_log` (`business_id`, `actor_user_id`, `action`, `entity_type`, `entity_id`, `metadata`). Platform audit routes exist for `support                                                                                                                                       | billing   | admin`.                                                                                                                      |

No locked architectural decision is contradicted by this design. Where a rule is binding, the document says which one.

## 1. Owner rulings incorporated

| Ruling                   | How this design applies it                                                                                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 Business identity     | `businesses` remains the only business identity. New tables reference `business_id`; there is no second business entity. The public profile and the future Split 09 resource profile are **separate contracts** that both reference it (section 6). |
| R2 Neutral discovery     | Discovery is ordered and filtered only by public profile data the business has had approved. No loyalty, purchase, survey, location-inference or cross-business customer data is read. No personalization.                                          |
| R3 Explicit publication  | Registration never publishes. Publication has its own state machine with submit, approve, reject, suspend, withdraw (section 3).                                                                                                                    |
| R4 Community integration | Discovery is a customer-facing Community Hub module that shows only approved, published information. Community membership is not advertising consent (section 5).                                                                                   |
| R5 Marketing opt-in/off  | No notification, no event type, no consent grant and no send path is introduced. Transactional notification preferences are untouched.                                                                                                              |
| R6 B2B separation        | Split 09 owns B2B resource and service participation; BDPN owns customer discovery. They share only the approved public profile, read-only (section 6).                                                                                             |
| R7 No migration          | No migration file or pin is created. Proposed schema and Gate 2 impact are documented only (sections 7 and 8 and the sequence document).                                                                                                            |

## 2. Published Business Profile contract (proposal)

### 2.1 Structure

A profile is **content owned by the business but published only by platform approval**. To make "controlled review
of updates" possible without ever exposing unapproved text, content is held as **immutable revisions**, and a
separate **publication record** points at the one approved revision that is live.

```text
businesses (existing, canonical)
   1 ── 0..1  business_public_profiles   (publication state + pointer to the live revision)
   1 ── 0..n  business_profile_revisions (immutable content snapshots, one lifecycle each)
                 1 ── 1..n business_profile_revision_translations (per-locale text)
                 1 ── 0..n business_profile_revision_media        (logo, later media; references only)
                 1 ── 0..n business_profile_revision_locations    (opt-in public places)
```

Why revisions (a **proposal**, decision D-01): (a) an edit can never alter what customers see until a moderator
approves exactly that content; (b) the approval is bound to an immutable digest, so there is no
approve-then-edit race; (c) rejected, superseded and withdrawn history stays as audit evidence; (d) it avoids a
second "pending copy" column set on one row. The cost is more tables and a read path that joins the live revision.

### 2.2 Field contract

"Exists" means present in the repository today. Everything marked **New** needs storage that is not authorized
by this block. **No field may be synthetic**: a field with no approved value is omitted, never defaulted to a
made-up value.

| Field                                | Exists?                                                                             | Proposed storage                                                                                                         | Validation (proposed)                                                                                                                               | Translatable                       | Edited by                                | Public when published                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------- | --------------------------------------------------------- |
| Canonical business reference         | Yes (`businesses.id`)                                                               | `business_id` FK on every profile table                                                                                  | Must equal the caller's tenant                                                                                                                      | No                                 | System                                   | Never exposed as such (D-10)                              |
| Public display name                  | No (`businesses.name` is operational, `legal_name` is private)                      | Revision translation `display_name`                                                                                      | 2–80 chars, plain text, no markup, no URL/phone/email patterns, NFC-normalized                                                                      | Yes                                | Business                                 | Yes                                                       |
| Short summary                        | No                                                                                  | Translation `summary`                                                                                                    | 0–160 chars, plain text                                                                                                                             | Yes                                | Business                                 | Yes (list card)                                           |
| Description                          | No                                                                                  | Translation `description`                                                                                                | 0–1000 chars, plain text, line breaks only                                                                                                          | Yes                                | Business                                 | Yes (detail)                                              |
| Category                             | Yes (`businesses.category_id` → `business_categories.key`)                          | Reuse existing; not copied into the revision                                                                             | Must reference an **active** platform category                                                                                                      | Name is localized from the catalog | Business via existing settings           | Yes (`categoryKey` + localized name)                      |
| Approved subcategories               | **No taxonomy exists** (`business_categories` has only `group_key`)                 | Deferred (D-08)                                                                                                          | n/a                                                                                                                                                 | n/a                                | n/a                                      | Not in v1 unless decided                                  |
| Public location (detail level: D-06) | Partial: `branches` hold address and latitude/longitude (internal operational data) | Revision location rows, **opt-in, not copied automatically**                                                             | Country code ISO 3166-1; city/region text; an optional street address only if the business opts in; **never raw branch coordinates**                | Labels yes                         | Business                                 | Yes, only the opted-in fields                             |
| Service area                         | No                                                                                  | Revision location row of type `service_area` (free text label and/or country codes)                                      | 0–120 chars, plain text                                                                                                                             | Yes                                | Business                                 | Yes                                                       |
| Approved contact details             | No (user email and phone are private account data)                                  | Revision contact fields: `website_url`, `public_phone`, `public_email`                                                   | `https` URL only, no credentials or tracking params; E.164 phone; syntactically valid email; each independently optional and independently approved | No                                 | Business                                 | Yes, only if provided and approved (D-07 on verification) |
| Logo / media references              | No. `UPLOADS` R2 binding exists but is unused                                       | Revision media rows holding an R2 object key, content type, byte size, dimensions, content hash, alt text (translatable) | Allow-list content types, size cap, server-side re-encode, strip metadata; no remote-URL images                                                     | Alt text yes                       | Business                                 | Yes, via short-lived signed URL (D-05)                    |
| Publication status                   | No                                                                                  | `business_public_profiles.publication_state`                                                                             | Enumerated state machine (section 3)                                                                                                                | No                                 | Platform                                 | Never as a raw value                                      |
| Moderation authority and notes       | No                                                                                  | Revision review columns (reviewer, decision, reason code, timestamp) and `audit_log`                                     | Reason from a controlled list; free-text notes are internal-only                                                                                    | No                                 | Platform                                 | Never                                                     |
| Visibility and withdrawal            | No                                                                                  | `publication_state` plus `visibility_version` counter                                                                    | See section 3                                                                                                                                       | No                                 | Business (withdraw) / Platform (suspend) | n/a                                                       |
| Publication timestamps               | No                                                                                  | `published_at`, `last_approved_at`, `withdrawn_at`, `suspended_at`                                                       | Server-set, never client-supplied                                                                                                                   | No                                 | System                                   | `publishedAt` only                                        |
| Audit history                        | Partial (`audit_log` exists)                                                        | New action names (Security doc §6)                                                                                       | Append-only by convention and by DB privilege                                                                                                       | No                                 | System                                   | Never                                                     |

### 2.3 Multilingual presentation

- Supported locales are the platform's closed set (`en, es, fr, ar`).
- Each revision carries text **per locale**. The business's `default_locale` text is **required** for submission;
  other locales are optional.
- Resolution order for a request: requested locale, then the business default locale, then `en`. Resolution is **per
  field**, and the response states which locale each text field came from.
- **No machine translation** is introduced. Right-to-left rendering is a presentation concern for the UI.
- Public category names come from the platform category catalog, which has its own localization decision (D-11).

### 2.4 Ownership

The business owns the **content** and may edit drafts. The platform owns the **decision to publish**, and owns
suspension. The customer owns nothing here and may only read. No business can edit another business's profile,
and no business can write a state transition that publishes.

## 3. Publication lifecycle (proposal)

### 3.1 States that are genuinely necessary

Two state sets, because content review and public visibility are different questions.

**Revision status** (one per immutable revision): `draft` → `submitted` → `approved` | `rejected`; an approved
revision becomes `superseded` when a newer approved revision goes live, and the live one may be `withdrawn`.

**Publication state** (one per business): `unpublished` (default, covers "never published"), `published`,
`suspended`, `withdrawn`.

Each state earns its place:

| State                   | Needed because                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `draft`                 | The business must be able to prepare content privately without anyone reviewing half-finished text.                      |
| `submitted`             | Content is frozen and queued; this freeze is what prevents approve-then-edit races.                                      |
| `approved` / `rejected` | The two outcomes of review; `rejected` carries a reason the business can act on.                                         |
| `superseded`            | A newer approved revision replaced it; kept as history, never shown.                                                     |
| `unpublished`           | The safe default; registration lands here and nothing is visible.                                                        |
| `published`             | Exactly one approved revision is live.                                                                                   |
| `suspended`             | **Platform-imposed**, for policy or safety. The business cannot lift it.                                                 |
| `withdrawn`             | **Business-imposed**, a voluntary exit. The business may re-enter, so it differs from `suspended` in who may reverse it. |

A separate `archived` or `deleted` publication state is **not** needed: a business whose canonical `status` is not
`active`, or that is soft-deleted, is excluded by the eligibility predicate (3.4) without a profile state change.

### 3.2 Legal transitions

| #   | From → To                                                         | Trigger                             | Authorized actor                               | Preconditions                                                                                                           | Audit action                         |
| --- | ----------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| T1  | (none) → revision `draft`                                         | Business creates or edits a profile | Business user with `profile:edit` (proposed)   | Business active; caller's tenant matches                                                                                | `business_profile.draft_saved`       |
| T2  | `draft` → `submitted`                                             | Business submits                    | Business user with `profile:submit` (proposed) | Minimum required fields present (D-04); validation passes; no other revision already `submitted` for this business      | `business_profile.submitted`         |
| T3  | `submitted` → `approved`                                          | Moderator approves                  | Platform moderator, `profile:moderate`         | Reviewer is **not** the submitter; the approval names the exact revision id and content digest; business still `active` | `business_profile.approved`          |
| T4  | `submitted` → `rejected`                                          | Moderator rejects                   | Platform moderator                             | A controlled reason code is supplied                                                                                    | `business_profile.rejected`          |
| T5  | `rejected` → new `draft`                                          | Business revises                    | Business user                                  | The rejected revision stays immutable; the new draft is a new revision                                                  | `business_profile.draft_saved`       |
| T6  | publication `unpublished`/`withdrawn` → `published`               | First approval, or re-publish       | System, as part of T3                          | The approved revision is set live in the **same transaction** as the state change                                       | `business_profile.published`         |
| T7  | `published` + new approved revision → `published` (pointer moves) | Update approved                     | System, as part of T3                          | Previous live revision becomes `superseded` in the same transaction                                                     | `business_profile.updated`           |
| T8  | `published` → `withdrawn`                                         | Business withdraws                  | Business user with `profile:submit`            | None; takes effect immediately                                                                                          | `business_profile.withdrawn`         |
| T9  | `withdrawn` → `published`                                         | Business re-publishes               | Business user                                  | Re-review required or not is **D-13**; at minimum the eligibility predicate must pass                                   | `business_profile.republished`       |
| T10 | `published`/`unpublished`/`withdrawn` → `suspended`               | Platform suspends                   | Platform moderator with `profile:moderate`     | Reason code and note required                                                                                           | `business_profile.suspended`         |
| T11 | `suspended` → `unpublished`                                       | Platform lifts suspension           | Platform moderator                             | Reason recorded; the profile is **not** auto-republished and needs the normal path                                      | `business_profile.suspension_lifted` |

**Everything not listed is illegal and is rejected server-side with a conflict error**, including: publishing
without approval, approving a `draft`, approving your own submission, a business lifting a suspension,
editing a `submitted` or `approved` revision, and moving the live pointer to a revision that is not `approved`
for the same business.

### 3.3 Update review

Editing live content never changes what customers see. An edit creates a new draft revision (T1/T5); it is
submitted (T2), reviewed (T3/T4) and, if approved, replaces the live revision (T7). Until then the previously
approved revision stays live. Whether **every** edit needs review or only material ones is **D-14**; the
proposed default is every edit, because a "trivial edit" classifier is itself a policy decision.

### 3.4 Eligibility predicate (the only definition of "discoverable")

A business is discoverable if and only if **all** hold, evaluated by the read query itself (not by a cached flag):

1. `business_public_profiles.publication_state = 'published'`;
2. `published_revision_id` references a revision with status `approved` and the same `business_id`;
3. `businesses.status = 'active'` and `businesses.deleted_at IS NULL` (suspending or archiving a business hides it automatically);
4. its default-locale translation exists.

Failure of any term means **not discoverable** (fail closed). There is no denormalized "is_public" flag that can drift.

### 3.5 Trust boundaries and failure behavior

- Business-side code can write only drafts and the two business transitions (submit, withdraw/re-publish).
  It can never set `approved`, `published_revision_id`, or `suspended`.
- Platform-side code is the only writer of approval, rejection and suspension, behind a code-owned permission
  re-resolved from the database per request (impersonation must **not** be able to moderate or approve; mirrors the
  existing rule that impersonation cannot accept Partner terms).
- Every transition is one database transaction: lock the publication row, validate the transition, write the
  state, write the audit row. If any step fails the whole transition rolls back.
- If the audit write fails, the transition fails (no unaudited state change).
- On any inconsistency detected at read time (pointer to a non-approved revision, missing default locale), the
  business is **omitted** from discovery and the inconsistency is logged for operators; it is never shown.

## 4. Discovery read model (proposal)

All endpoints below are **design proposals only**. Names, paths and shapes are not frozen until BDPN-01C.

### 4.1 Candidate endpoints

| Proposed endpoint                      | Auth                    | Purpose                                                                                 |
| -------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `GET /discovery/businesses`            | Customer session (D-09) | Paged list of discoverable businesses                                                   |
| `GET /discovery/businesses/:profileId` | Customer session        | One published profile                                                                   |
| `GET /discovery/categories`            | Customer session        | Categories that currently have at least one discoverable business, with localized names |

Query parameters for the list: `category` (a category key), `q` (search text), `cursor`, `limit` (1–50, default 20),
`locale` (optional override of the session language). Unknown parameters are rejected.

### 4.2 DTOs (design only)

```ts
// List card. Nothing here is fabricated, computed from behavior, or personalized.
interface DiscoveryBusinessListItemDto {
  profileId: string; // opaque public handle, NOT businesses.id (D-10)
  displayName: string;
  summary: string | null;
  categoryKey: string | null;
  categoryName: string | null; // localized from the catalog
  logoUrl: string | null; // short-lived signed URL, or null
  locationLabel: string | null; // only the opted-in public label
  contentLocale: 'en' | 'es' | 'fr' | 'ar'; // locale the text was served in
}

interface DiscoveryBusinessProfileDto extends DiscoveryBusinessListItemDto {
  description: string | null;
  contact: { websiteUrl: string | null; publicPhone: string | null; publicEmail: string | null };
  locations: { kind: 'place' | 'service_area'; label: string; countryCode: string | null }[];
  publishedAt: string;
}

interface DiscoveryListDto {
  items: DiscoveryBusinessListItemDto[];
  nextCursor: string | null; // opaque; no total count (see 4.4)
}
```

**Explicitly absent from every DTO:** internal `businessId`, `slug`, legal name, branch ids, branch coordinates,
customer counts, loyalty program details or balances, Community Point values, ratings, reviews, reach,
popularity, rank scores, offers, opening hours or open-now status, distance or proximity, sponsored flags,
campaign data, Partner Credit data, and any customer-derived field. If a value cannot be verified from approved
data, it is not in the contract.

### 4.3 Behavior

| Concern                | Proposed rule                                                                                                                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filtering              | Exact match on `category` key, validated against the active catalog. An unknown key is a validation error, not an empty list.                                                                                                                                                           |
| Search                 | Case- and accent-insensitive **substring match on the approved display name only** (and optionally the localized category name), minimum 2 and maximum 64 characters, LIKE metacharacters escaped. No full-text search over description or contact. Search never reads private columns. |
| Deterministic order    | Primary: normalized `display_name` ascending (collation fixed in the query); tiebreak: `profileId` ascending. **No ranking, boosting or randomization.** The same data always yields the same order.                                                                                    |
| Pagination             | Keyset (cursor) pagination over `(sort_key, profileId)`. The cursor is opaque and tamper-checked. No `offset`. No total count (cost and enumeration-aid reasons); `nextCursor` is null at the end.                                                                                      |
| Multilingual           | Per 2.3. The response states `contentLocale`. Sorting uses the resolved display name.                                                                                                                                                                                                   |
| Empty vs error         | Four distinct states, never conflated: **no discoverable businesses at all**; **filters matched nothing**; **forbidden** (customer not active); **unavailable** (retryable). A failure is never rendered as an empty list.                                                              |
| Unknown vs unpublished | A request for a handle that is unknown, unpublished, withdrawn, suspended or ineligible returns the **same** not-found response (no state oracle).                                                                                                                                      |
| Caching                | See 4.4.                                                                                                                                                                                                                                                                                |

### 4.4 Caching and invalidation

- **Proposed v1:** every discovery response carries `Cache-Control: private, no-store`. This is the only setting
  that makes "disappears immediately when unpublished" true without extra machinery, and it matches the existing
  precedent of `no-store` on sensitive reads.
- **Possible later optimization (D-12, not decided):** a short TTL keyed to a global `discovery_epoch` counter that
  is incremented, in the same transaction, by **every** publication-state change (approve, withdraw, suspend,
  business-status change). Entries tagged with an older epoch are discarded. Signed media URLs are short-lived and
  non-guessable. No shared (CDN) caching of customer-session responses.
- Unpublishing must make the profile and its media unreachable to new requests immediately; an in-flight signed
  media URL may live at most its short TTL (the value is a decision, D-12).

## 5. Community Hub integration (proposal)

### 5.1 Placement

- A **"Discover businesses"** module reached from the Community Hub (H1). Proposed routes under the existing
  customer area: `/loyalty/dashboard/community/businesses` (list) and `/loyalty/dashboard/community/businesses/[profileId]`
  (detail). The existing "Community" navigation item is reused; **no new top-level navigation item** is proposed.
- It reads only the discovery endpoints in 4.1. It does not read the Community membership, points or ledger data.

### 5.2 Interaction with existing modules

| Module                  | Rule                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Community Hub H1        | The hub page gains an entry card linking to discovery. Membership and points display are unchanged. Discovery is available to an authenticated customer **regardless** of Community membership status (membership is not a precondition and is not created).                                                                                                                                           |
| Surveys H2              | No coupling in v1. A profile page does not list surveys. Surveys remain reachable only through the existing QR or link flows. Any "surveys from this business" link is a later, separately decided feature.                                                                                                                                                                                            |
| Loyalty and rewards     | Viewing a profile **never** joins the business, creates a loyalty account, creates a membership, records a check-in, or grants points. Joining continues to require the existing authorized business context and an explicit `JOIN_LOYALTY` consent (Split 01 invariants 4 and 5). Whether a profile may show "how to join" text is D-18; it must not contain a join action that bypasses the QR flow. |
| Customer authentication | The existing customer JWT and `customerAuthenticate` are reused unchanged. Anonymous browsing is **not** part of v1 (D-09).                                                                                                                                                                                                                                                                            |
| Navigation              | Discovery adds no auto-redirects, banners, pop-ups or notifications.                                                                                                                                                                                                                                                                                                                                   |
| Language                | Presentation language follows the customer language precedence already shipped (saved preference, cookie, business default, English) for UI strings; profile **content** follows 2.3.                                                                                                                                                                                                                  |

### 5.3 Non-effects (binding)

Browsing public business profiles must **not**: enroll the customer; create a loyalty account or a membership;
grant, reserve or move Community Points; create or modify any consent grant; create a notification or send any
message; record per-customer view history; or initiate advertising. These are acceptance criteria for BDPN-01D.

## 6. B2B interoperability boundary (proposal)

BDPN owns **customer discovery of the public profile**. Split 09 (not yet specified) owns **business-to-business
resource and service participation**. They may consume the same approved profile; they must not share data
stores or authority beyond that.

| Information                                                | Public profile (BDPN) | Split 09 may read it                             | Stays private to the business / platform                          |
| ---------------------------------------------------------- | --------------------- | ------------------------------------------------ | ----------------------------------------------------------------- |
| Profile handle, display name, summary, description         | Yes                   | Yes (read-only, from the live approved revision) |                                                                   |
| Category key                                               | Yes                   | Yes                                              |                                                                   |
| Public location label, service area                        | Yes                   | Yes                                              |                                                                   |
| Logo                                                       | Yes                   | Yes (read-only)                                  |                                                                   |
| Public contact fields                                      | Yes (if approved)     | Yes (read-only)                                  |                                                                   |
| Legal name, tax or billing identity                        |                       |                                                  | **Private**                                                       |
| Branch addresses and coordinates, branch list              |                       |                                                  | **Private**                                                       |
| Staff, roles, emails, phones of users                      |                       |                                                  | **Private**                                                       |
| Customers, memberships, loyalty configuration and balances |                       |                                                  | **Private** (never crosses tenants)                               |
| Community Points and Partner Credit data                   |                       |                                                  | **Private** (separate ledgers)                                    |
| B2B resources, services, rates, availability               |                       | Split 09 only                                    | Never part of the public profile unless a future decision says so |

Rules: Split 09 never writes the public profile; BDPN never reads Split 09 resource data; neither can create or
read the other's permissions or workflows; a Split 09 feature may **require** that a business is currently
discoverable as an eligibility rule (D-23) but it reads that fact from the eligibility predicate, not from its own
copy. This block implements no B2B marketplace, no business campaigns and no Partner Credit functionality.

## 7. Proposed schema (documentation only — no migration is created)

All names are proposals. Every table is additive; **no existing table is altered** by this proposal.

| Table                                    | Key columns (proposed)                                                                                                                                                                                                                         | Integrity (proposed)                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `business_public_profiles`               | `business_id` (PK, FK `businesses`), `publication_state`, `published_revision_id`, `published_at`, `withdrawn_at`, `suspended_at`, `suspended_by`, `suspension_reason`, `visibility_version`, `profile_handle` (unique, random), audit columns | `CHECK` on `publication_state`; composite FK `(business_id, published_revision_id)` to `business_profile_revisions(business_id, id)` so the live pointer can only reference a revision of the **same** business; `CHECK` that `published` requires a non-null pointer |
| `business_profile_revisions`             | `id`, `business_id`, `revision_no`, `status`, `content_digest`, public contact fields, `submitted_by/at`, `reviewed_by/at`, `review_reason_code`, `review_note_internal`, audit columns                                                        | Unique `(business_id, revision_no)` and `(business_id, id)`; `CHECK` on `status`; partial unique index allowing at most one `submitted` revision per business; content columns **immutable after `submitted`** (enforced by a DB guard, not only application code)    |
| `business_profile_revision_translations` | `revision_id`, `locale`, `display_name`, `summary`, `description`                                                                                                                                                                              | PK `(revision_id, locale)`; `CHECK` locale in the supported set; length checks                                                                                                                                                                                        |
| `business_profile_revision_media`        | `id`, `revision_id`, `kind`, `object_key`, `content_type`, `byte_size`, `width`, `height`, `content_hash`, alt text per locale                                                                                                                 | Allow-listed `kind` and `content_type`; object key namespaced by business                                                                                                                                                                                             |
| `business_profile_revision_locations`    | `id`, `revision_id`, `kind`, `branch_id` (optional reference only), `label`, `city`, `region`, `country_code`, optional street address                                                                                                         | Branch, if referenced, must belong to the same business (composite FK); **no coordinates column**                                                                                                                                                                     |

Row-level security, grants and the non-owner role audit for these tables must follow the existing Gate 2
contract (tenant-owned writes by the application role; platform moderation through an explicitly granted path;
read model through a view or query that applies the eligibility predicate). Details and the verification plan are
in the Security and Sequence documents.

## 8. Migration and Gate 2 implications (documentation only)

- The migration chain would grow from 68 to the next number(s), **each** requiring a re-pin of the Gate 2 scripts,
  workflows and release tests (18 files matched on this baseline, to be regenerated at the time).
- A single batched migration for all BDPN-01 tables (recommended in D-19) means one re-pin instead of several.
- Staging is at 45 migrations with 23 pending; BDPN-01 schema extends that backlog. Ordering and authorization of the
  backlog is owner decision D-19.
- All changes are additive and create new tables only; rollback is "stop reading and drop the new tables" with no
  data loss in existing domains.

## 9. Compatibility with locked architecture

| Locked rule                                                                                                           | Compliance                                                                                            |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Split 01: one global customer identity; relationships are explicit; QR/check-in never silently creates a relationship | Discovery creates no relationship (5.3).                                                              |
| Split 02: `businesses` is the tenant root; categories are platform-owned; B2B profile is Split 09                     | Reuses `businesses` and categories; B2B profile stays out (section 6).                                |
| Split 05: Community Points are platform-wide, never converted automatically; membership is separate                   | Discovery touches no points; membership is not consent or a precondition.                             |
| Split 07/08: Partner Credits and billing are separate and restricted                                                  | No credit, billing, Stripe or subscription effect (D-24 records the unresolved plan-gating question). |
| BDPN v1.0: no personalization, no outbound promotion, no tenant customer exposure, fail closed                        | Sections 4, 5 and the Security document.                                                              |

## 10. Out of scope (unchanged NO-GO)

Personalized recommendations; sponsored or paid placement; offers or campaigns; any marketing or notification send;
creation or modification of consent grants; B2B marketplace functionality; Partner Credit or Stripe effects;
loyalty or Community Point changes; and any production configuration, migration or deployment.

> **Erratum (2026-11-12).** The statements in this document that staging is "at 45" or that "23 migrations are pending" are **superseded**. The repository record dated 2026-11-09 (commit 52b990c) reports both the production Neon project and the staging branch at 67 journal entries; only `0067` is beyond that record. The live state of each environment is **not verified**. See `BDPN_MIGRATION_PLAN_AND_STATE_CORRECTION.md`. The D-19 principle (backlog first, then one BDPN migration) stands; the backlog is `0067`.
