# NETWORK-01 — Official publishing foundation (development only)

**Status:** development and testing. Not deployed, not activated, migration `0077` applied to disposable PostgreSQL only. Baseline `origin/main` @ `341e15a`. Builds on `NETWORK_00_*` (design proposals); every value below marked *provisional* comes from the owner's development dispatch of 2026-11-16 and is **not** a final approval.

## 1. Scope actually implemented
Platform-**official** posts only: author -> submit -> two distinct approvers -> published (30-day default expiry) -> suspend / lift / withdraw / pin, with a restricted read-only feed for authenticated customers. Disabled by default behind `NETWORK_FEED_ENABLED`.

| Dispatch item | Result |
|---|---|
| 1 additive `network_*` schema | `network_posts`, `network_post_revisions`, `network_revision_approvals` (migration 0077, additive, empty) |
| 2 author/business identity boundaries | Authors are platform `admin` users (code-owned `network:author`); business identity **blocked** (section 3) |
| 3 draft lifecycle | draft -> submitted -> approved/rejected; edits open revision n+1; live revision stays until the new one is approved |
| 4 official two-person approval | Two **distinct** non-author approvers (service + trigger); author can never approve |
| 5 moderation states and audit | published/suspended/withdrawn; reject/suspend need a code-owned reason; every action sets an `audit_log` event |
| 6 customer-visible eligibility | published AND live revision approved AND not expired (database clock) |
| 7 read-only FeedSource | `createNetworkFeedSource`: SELECT only, closed DTO, keyset cursor, no totals |
| 8 flag enforcement | Exactly `"true"` enables; otherwise every `/network/feed` and `/platform/network-moderation/*` path is a generic 404 and `/network/status` says `enabled:false`; the Feed section is hidden |
| 9 rate limits / expiry | Customer-keyed rate limit on reads (existing limiter); expiry in the query. Author-side caps: see section 3 |
| 10 isolation tests | Real PostgreSQL suite (section 5) |

## 2. Reconciliation with NETWORK-00 and owner policy
| Provisional value | NETWORK-00 / existing | Verdict |
|---|---|---|
| Platform-official + verified business authors | Business posts need a live published BDPN profile (N-06); official first | **Conflict for business authors** - blocked |
| Two distinct approvers for official | N-09: author + ONE different admin | **Stricter than N-09**; implemented as author + two distinct approvers; confirm |
| Platform-wide moderation | Code-owned platform permission pattern | Matches; `admin` role only |
| Business-scoped author management | `network:post` business permission, business-wide only | **Blocked** with business posts |
| Authenticated customer audience | `signed_in_customers` only in v1 | Matches |
| No cross-business advertising | Out of scope (BDPN / sponsored) | Matches; nothing built |
| 2,000 characters | N-07 / C-2 left open ("short text") | Provisional; enforced in code and as a CHECK |
| Five business posts/day | C-2 daily cap | **Blocked** with business posts (not implemented) |
| https links only | Matches; C-3 proposed a domain restriction for business links | https-only enforced (no credentials, <= 2048); domain rule not applied to official posts |
| 30-day default expiry | C-4 optional expiry | Implemented as the default for every post |
| One pinned post per business | C-5: one pinned **official** item, platform-controlled | Implemented as one pinned official post platform-wide; per-business pin waits for business posts |
| Disabled by default; hide Feed when off | NETWORK-00 section 0 and NT-17 | Implemented |

## 3. Stopped portions (owner decision or prerequisite needed)
1. **Business-authored posts** (items 2, 9 in part): no BDPN profile / identity-verification table exists, so there is nothing to join the composite tenant key to. `content_class` is constrained to `official` by a CHECK; a later block widens it with the BDPN foreign key.
2. **Five business posts per day**: meaningless without business posts; not implemented.
3. **Author-side rate limit for official posts**: no approved budget; not invented. Official authoring is limited by the two-approver rule and the platform-admin population.
4. **Moderation UI**, reports, follows, platform notifications: not built (NETWORK-02).

## 4. Security properties
- Pre-moderation: nothing is visible before two distinct non-author approvals; enforced by trigger as well as service.
- Immutable revisions with SHA-256 digest recomputed at submission and approval; published content cannot be edited in place.
- Reviewer is never the author (CHECK, trigger, service); approvals are append-only; no deletes; TRUNCATE denied; every guard is `ENABLE ALWAYS` (also holds under `session_replication_role = replica`).
- Plain text only: no `<`/`>`, control characters, mentions, hashtags, emails or phone numbers; one https link without credentials.
- Closed DTO: no internal ids, author, reviewer, reason or counts. Feed query takes no customer or business id and reads no loyalty, points, feedback, survey, consent or messaging table (non-effect test).
- Generic 404 when disabled; customer routes need an active customer session; platform routes need an `admin` re-resolved per request (impersonation refused by `requirePlatformRole`).
- No privileged database fallback: the feed uses the existing runtime connection and SELECTs only.

## 5. Tests
Unit: content rules and digest, permission matrix, moderation routes (flag off x 6 values x 11 routes, role matrix, strict bodies), feed routes, worker boundary. Integration (real PostgreSQL, 29 tests): lifecycle, separation of duties, rejection, edit/supersede, content rules, direct-SQL attempts (publish unapproved, self-approve, tamper, delete, truncate, replica role), visibility/expiry/suspension, single pin, keyset paging, closed DTO, concurrent final approvals, non-effect counts. A mutation check (dropping each trigger) fails the intended tests.

## 6. Owner decisions required
1. Confirm "author + two approvers" versus N-09 "author + one approver".
2. Confirm 2,000 characters, 30-day default expiry and one platform-wide pinned official post.
3. Content policy for posts and two named platform admins (NETWORK-00 section 6) before enabling anywhere.
4. Whether business posts (after BDPN) get the five-per-day cap and a domain restriction (C-3).
5. Authorize an environment flag rollout (staging first, internal accounts) and a separate migration authorization for 0077.

## 7. Release
Deploy dark: migration 0077 is additive and empty; flag unset. Rollback = unset the flag (no data change). No Gate 2 re-pin was needed (no hard-pinned reference to the previous last tag exists).
