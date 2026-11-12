# NETWORK-00 — Content Model, Ownership and Access

**Status: DESIGN PROPOSAL — DOCUMENTATION ONLY. No table, endpoint, permission or UI is created.** Names are proposals.
Baseline `origin/main` @ `7fd8bfe`. Parent record: `decisions/ECHO_GRID_NETWORK_ARCHITECTURE_AMENDMENT_V1_PROPOSED.md` (`N-xx` decisions). BDPN references: `builds/BDPN/` (`D-xx`, 01A schema, 01B moderation, 01C API).
The model deliberately **reuses the BDPN-01 patterns** (immutable revisions plus a live pointer, opaque handle, content digest, state-machine and immutability triggers, composite tenant foreign keys) so the platform has one publication discipline, not two.

## 0. Customer Community composition — owner direction (2026-11-12)

- The future Network Feed is a **subsection of the existing Community tab**, not a second customer primary navigation item. The customer entry point remains `/loyalty/dashboard/community`.
- Preserve Split 05's read-only membership and Community Points presentation as the `Points & Membership` subsection. A future nested `/loyalty/dashboard/community/feed` route is a **proposal**, not an approved route implementation.
- All post, follow, moderation and report entities remain `network_*` and all feed APIs remain `/network/*`. There is no direct join to Community Points, loyalty, memberships, feedback, consent or business-private customer tables.
- When the Feed is disabled or inaccessible, the existing Community experience must remain usable; hide the Feed subsection instead of exposing disabled or unauthorized content.
- Only NETWORK-02, after its own authorization, may introduce the integrated customer sub-navigation. No UI/navigation is changed by this document.

## 1. Content classes (v1 and later)

| Class                        | Author                     | v1                                          | Intended audience       | Notes                                                     |
| ---------------------------- | -------------------------- | ------------------------------------------- | ----------------------- | --------------------------------------------------------- |
| `official`                   | Echo Grid (platform admin) | **Yes**                                     | All signed-in customers | Visible official badge; two-person approval (N-09)        |
| `business_post`              | Authorized business user   | **Yes**                                     | All signed-in customers | Needs a live published BDPN profile (N-06)                |
| `customer_post`              | Customer                   | **No** (gated by N-15, moderation capacity) | Customer-chosen         | Reserved class value only; not writable in v1             |
| `sponsored`                  | Eligible business          | **No** (N-13)                               | Approved placement      | Not in schema in v1                                       |
| `b2b_listing` / `b2b_thread` | Business                   | **No**                                      | Business Network only   | **Separate storage (Split 09)**; never in the feed tables |

## 2. Content object contract (design)

Every network content object, in every class, must carry:

| Field                                            | Purpose                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Opaque `handle`                                  | Public identifier (22 characters, as BDPN D-10); internal id never exposed                                                                  |
| `author_kind` and author identity                | `platform` or `business` (later `customer`); the acting user id kept internal                                                               |
| `business_id` (nullable)                         | Tenant ownership for business posts; null for official                                                                                      |
| `content_class`                                  | Section 1                                                                                                                                   |
| `body` (plain text), optional `link_url` (https) | N-07 limits; no HTML, markdown, media, mentions or hashtags                                                                                 |
| `content_locale`                                 | N-16; stored per post                                                                                                                       |
| `visibility_scope`                               | `signed_in_customers` in v1; the enum must reject any other value until its block exists                                                    |
| Moderation status                                | `draft, submitted, approved, rejected, superseded` (revisions) and `unpublished, published, suspended, withdrawn` (post), mirroring BDPN-01 |
| `content_digest`                                 | SHA-256 of the canonical NFC text, same method as BDPN-01B, so approved equals shown                                                        |
| Reviewer and submitter                           | Different users (CHECK plus service), mirroring the BDPN rule                                                                               |
| Created, modified, reviewed times and actors     | Evidence                                                                                                                                    |
| Reason code (rejections and removals)            | Code-owned list, extended from the BDPN interim policy                                                                                      |
| Report counters (internal only)                  | Never shown to customers or businesses                                                                                                      |

## 3. Proposed tables (sketch, not a contract)

Ordinary-tenant pattern (application scoping plus composite foreign keys). **No row-level security or role separation is relied on**, because the recorded runtime database login is `neondb_owner` with `BYPASSRLS` (acceptance record); triggers, CHECK constraints and unique indexes still fire for every role.

| Table                    | Content                                                                                                   | Key constraints                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network_posts`          | One row per post: handle, class, business reference, live revision pointer, publication state, timestamps | Unique handle; composite FK `(business_id, profile)` to the BDPN profile; CHECK: official has no business, business post has one                                    |
| `network_post_revisions` | Immutable revisions: body, link, locale, digest, status, submitter, reviewer, reason code                 | Immutability trigger on approved or superseded rows; reviewer differs from submitter; state-machine trigger; partial unique index: at most one `submitted` per post |
| `network_follows`        | `(customer_id, business_id)` follow                                                                       | Unique pair; business must be live published; deleted with the customer account                                                                                     |
| `network_reports`        | Reporter kind and id, post, reason code, status                                                           | Rate-limited at the service; no reporter identity exposed to the post author                                                                                        |
| Audit                    | **Existing `audit_log`**                                                                                  | Actions listed in the moderation companion; no new audit table                                                                                                      |

No media table, no comment table, no like table in v1 (Phase 3 and N-15).

## 4. Visibility predicate (evaluated in the query, never cached)

A post is visible to a customer **only if all** are true:

1. The customer session is valid and the customer is active.
2. The post publication state is `published` and its live revision is `approved`.
3. The author business has a **live, published, eligible BDPN profile** (or the post is `official`).
4. The business is active (not suspended) and the platform has not suspended the post.
5. The feature flag for the Feed is on in this environment.

Anything else, including a stale or missing fact, returns "not found" with the **same response for every cause** (BDPN uniform not-found rule).

## 5. Access matrix (proposed)

Business permissions would be new keys in the business role catalog (proposals: `network:post`, `network:submit`), business-wide only, mirroring `requireBusinessWideAccess`. Platform moderation follows the **code-owned platform permission** pattern (`requirePlatformRole` plus a code-owned permission list), re-resolved from the database on every request.

| Actor                                       | View own posts and status | Draft and submit                        | Withdraw | Approve or reject                    | Suspend or remove | Report  | Read feed                                   |
| ------------------------------------------- | ------------------------- | --------------------------------------- | -------- | ------------------------------------ | ----------------- | ------- | ------------------------------------------- |
| Business Owner or Admin with `network:post` | Own business only         | Yes                                     | Yes      | **No**                               | **No**            | Yes     | Yes (as customer account, if they hold one) |
| Business staff without the permission       | No                        | No                                      | No       | No                                   | No                | Yes     | n/a                                         |
| Branch-scoped business user                 | No (business-wide only)   | No                                      | No       | No                                   | No                | Yes     | n/a                                         |
| Platform admin with moderation permission   | Any                       | **No** (cannot author business content) | No       | Yes, never own submissions           | Yes               | Yes     | n/a                                         |
| Platform admin authoring `official`         | Own                       | Yes                                     | Yes      | **No** (second admin approves, N-09) | No                | n/a     | n/a                                         |
| Platform support (read only, if granted)    | Read                      | No                                      | No       | No                                   | No                | n/a     | n/a                                         |
| Impersonating session                       | **Read only**             | **No**                                  | **No**   | **No**                               | **No**            | **No**  | n/a                                         |
| Active signed-in customer                   | n/a                       | No (v1)                                 | n/a      | n/a                                  | n/a               | **Yes** | **Yes**                                     |
| Suspended or inactive customer              | n/a                       | No                                      | n/a      | n/a                                  | n/a               | No      | **No**                                      |
| Anonymous visitor                           | n/a                       | No                                      | n/a      | n/a                                  | n/a               | No      | **No** (D-09)                               |

Rules:

- Authorization is re-resolved from the database on every request, never trusted from the token.
- Impersonation cannot author, submit, withdraw or moderate (the existing impersonation precedent).
- Moderators see only the post and the minimum business context defined for BDPN (D-22 applies to profiles; posts add no extra private data).
- A business user can never obtain moderation authority through a business role.

## 6. Follows (v1) in detail

- A customer follows or unfollows a **published business** by its opaque profile handle.
- A follow never creates a membership, loyalty account, consent grant, conversation or notification.
- The business sees a **follower count** at most (N-08, and only if a later block authorizes any analytics); never identities.
- The customer sees and manages their own follows; deleting the account deletes the follows.
- Following requires no payment and has no financial effect.

## 7. Proposed API shape (names are proposals; closed DTOs)

All customer endpoints: signed-in customer only, `Cache-Control: private, no-store`, customer-keyed rate limit (not address-keyed, see BDPN-01E open item O-E1), `locale` passed by the web layer, cursor pagination without totals.

| Endpoint                                     | Purpose                    |
| -------------------------------------------- | -------------------------- |
| `GET /network/status`                        | Is the Feed enabled here   |
| `GET /network/feed?filter=all                | following&cursor=`         | Deterministic reverse-chronological page of visible posts |
| `GET /network/posts/:handle`                 | One visible post           |
| `PUT/DELETE /network/follows/:profileHandle` | Follow, unfollow           |
| `GET /network/follows`                       | The customer's own follows |
| `POST /network/posts/:handle/reports`        | Report a post              |

Staff and platform:

| Endpoint                         | Purpose                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `/network/business-posts/*`      | Draft, submit, withdraw, own status (permission `network:post`)                  |
| `/platform/network-moderation/*` | Queue, approve, reject, suspend, lift, remove (code-owned moderation permission) |
| `/platform/network-official/*`   | Draft and approve official posts (two-person rule)                               |

Idempotency keys (8 to 200 characters), expected-version locking and a transition service mirror BDPN-01B.

## 8. Closed DTO principles

Feed items expose only: handle, class and official badge, display name and category of the business (from the published profile), body, link (https, validated again at render), content locale, published time. **Never** internal ids, business ids, reviewer or submitter identities, moderation reasons, report counts, follower identities, or timestamps beyond published time.

## 9. Tenant isolation and privacy rules specific to the Network

1. Every feed query joins to the BDPN eligibility predicate; there is no query that returns posts of a business that is not eligible.
2. A business can read only its own posts, drafts and statuses.
3. Reports are visible to platform moderators only; the post author never learns who reported.
4. Posts may not name or identify customers. A moderation rule rejects obvious personal data patterns (emails, phone numbers) and a report reason covers doxxing.
5. No customer-list or follower export exists.
6. The Feed never reads loyalty, points, feedback, survey or messaging tables.

## 10. Migration implications (no migration is authorized)

- Additive only, new tables; no change to existing tables; empty on arrival; deployed dark (flag off).
- Follows BDPN decision D-19: the live migration backlog (0067) is reconciled first, then BDPN-01's single migration, then a **separate** Network migration for NETWORK-01 (the first block that needs tables).
- Each migration needs the Gate 2 journal and last-tag re-pin (hard-pinned in scripts, three workflows and release tests; job `name:` lines unchanged).
- Rollback: flag off; tables stay or are dropped only while empty or after export, as a separate authorized operation.

## 11. Open questions for the owner

| ID  | Question                                                              | Author's view                                                                     |
| --- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| C-1 | Do official posts need the same revision tables or a lighter model?   | Same tables, one discipline                                                       |
| C-2 | Maximum post length and rate (posts per business per day)             | Short text, a low daily cap, set after a pilot                                    |
| C-3 | May a post link to the business's own website only, or any https URL? | Any https URL on the business's published website domain in v1, to limit phishing |
| C-4 | Should posts expire automatically?                                    | Optional expiry date set by the business, applied in the visibility predicate     |
| C-5 | Pinned official post?                                                 | One pinned official item, platform-controlled                                     |
