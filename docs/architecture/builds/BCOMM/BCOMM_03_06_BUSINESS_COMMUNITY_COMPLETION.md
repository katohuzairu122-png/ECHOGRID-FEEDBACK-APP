# BCOMM-03 to BCOMM-06 — Tentaship Business Community: technical completion record and staging preparation

Status: DEVELOPMENT COMPLETE — LOCAL INTEGRATION ACCEPTANCE ONLY. Nothing here was deployed, migrated on a shared database, or activated. Baseline: main `9e31499` (BCOMM-02 merged). Stack: PR #585 (BCOMM-03) → #586 (BCOMM-04) → #587 (BCOMM-05) → BCOMM-06 PR. Brand: Tentaship (Echo Grid identifiers, logo, palette and design system untouched; no BRAND-01, Badges, Shuffle or Drops work).

## 1. Reconciliation (what already existed and was reused, not rebuilt)
- NETWORK-01 `network_*` tables, revision/digest discipline, moderation reason codes, content rules (`network-post.ts`), platform moderation service and routes, Feed route/DTO/source, saved drafts.
- BDPN business public profile storage (migration 0080) and its transition service: the published-profile predicate is the only gate for business content.
- BCOMM-01 hub shell and permission gate, BCOMM-02 aggregate suppression (group size 10, configuration upward only).
- Customer deletion (CUST-DEL-01/02), pilot eligibility and Community enrollment controls: untouched. Customer verified-phone rule for the Feed is reused for follows and engagement.
- No second business identity, feed, moderation system, permission system or analytics store was introduced. Conflicts with approved architecture: the prompt's wide audience list (loyalty customers, followers, geography) conflicts with NETWORK-00 §2 (business posts are visible to all signed-in customers); the approved rule was implemented and the rest recorded as owner decisions (§7).

## 2. What each block delivers
| Block | Capability | Data | Key rules |
| ----- | ---------- | ---- | --------- |
| BCOMM-03 | Business post authoring (draft, edit, preview, submit, archive, own status incl. moderator reason), My Posts UI | migration **0091** (no new table: `network_posts.business_id`, class `business`, trigger: ONE platform approver for business posts, two for official, publish only while profile published and business active) | `network:post` (Owner/Admin by default, business-wide, never cashier/Manager), control `NETWORK_BUSINESS_PUBLISHING_ENABLED`, impersonation read-only, daily cap 5 (config 1–100), plain text, https link only to the business's own published website (C-3 safer default), audit never stores text |
| BCOMM-04 | Business posts in the canonical Feed; voluntary follows; customer Following filter | migration **0092** (`network_follows`) | control `NETWORK_BUSINESS_DISTRIBUTION_ENABLED` (plus the Feed flag), visibility predicate re-evaluated per query, deterministic order, follow ≠ membership/consent/notification, unfollow always allowed, deleted with the customer |
| BCOMM-05 | Server-recorded engagement events; thresholded Insights (impressions, reach, link opens, new/current followers, per-post) | migration **0093** (`network_engagement_events`, append-only) | one event per customer, post and UTC day, no business write path, figures only from ≥10 distinct customers, profile visits and loyalty attribution explicitly NOT measured |
| BCOMM-06 | Integrated acceptance, containment tests, deletion regression, migration manifest, staging preparation, cross-block review | none | see §5, §6 |

## 3. Control inventory (all default OFF; none set in any wrangler config or workflow)
| Control | Gates | Closing it |
| ------- | ----- | ---------- |
| `NETWORK_FEED_ENABLED` (existing) | the whole customer Feed, follows, engagement | customer surface 404s; nothing deleted |
| `NETWORK_BUSINESS_PUBLISHING_ENABLED` | business create/edit/submit/archive | writes 404; the business can still READ its own posts and moderation status |
| `NETWORK_BUSINESS_DISTRIBUTION_ENABLED` | business posts in the Feed, following, engagement recording | business posts vanish from customers at once; existing follows can still be removed; no rows deleted |
| `NETWORK_BUSINESS_DAILY_POST_CAP` | posts per business per 24h (default 5, 1–100) | n/a |
| `COMMUNITY_AGGREGATE_MIN_GROUP_SIZE` (BCOMM-02, reused) | minimum group for every aggregate | can only be raised above 10 |
Exact string `"true"` only; anything else (`TRUE`, `1`, empty, unset) is closed (tested). The Community enrollment, membership, consent, restoration and pilot controls are independent and unchanged.

## 4. Migration manifest for the future staging operation (PREPARED, NOT EXECUTED)
Repository journal: 0000–0093 = 94 entries. Production and staging were last recorded with a ledger of **88** applied rows (0000–0087). **Verify the real ledger before acting** (checksum comparison, not assumption). The migrator applies every pending entry in one transaction, so the batch is **0088 → 0093 in this order**:
| # | Tag | Effect | Restore note |
| - | --- | ------ | ------------ |
| 0088 | community_membership_consent | consent/terms tables | snapshot first |
| 0089 | customer_deletion_requests | deletion request table + guard | |
| 0090 | community_pilot_eligibility | pilot allowlist + events | |
| 0091 | network_business_posts | `network_posts.business_id`, widened class, replaced post guard trigger | additive; old rows keep `official` and a null business |
| 0092 | network_follows | new table + guard trigger | drop only while empty |
| 0093 | network_engagement_events | new append-only table + triggers | drop only while empty |
Required before applying: a Neon snapshot/branch of the target, the target's exact-prefix check, runtime-role provisioning review (`network_follows`: SELECT/INSERT/DELETE; `network_engagement_events`: SELECT/INSERT — manifest and generated SQL are updated, drift check clean), then `db:seed` (adds `network:post`) and `db:backfill-role-permissions` for existing Owner/Admin roles, both on explicit instruction only. Compatibility: the previous API version ignores the new column/tables, so web and API can deploy API-first; a rolled-back API leaves the additive schema harmlessly in place.

Verified locally on disposable PostgreSQL 16.15 (PostgreSQL 18 runs in the hosted `community-pg18-acceptance` and gate2 jobs): (a) fresh chain 0000→0093 = 94 ledger rows; (b) populated 0087→0093 upgrade (users, businesses, customers, loyalty accounts and official posts intact, hashes unchanged, new column null, trigger replaced); (c) incremental 0090→0093 on a populated test database.

## 5. Staging preparation (instructions only)
1. Snapshot staging; confirm ledger and prefix. 2. Apply 0088–0093 in one authorized run; record the ledger and checksums. 3. Provision the runtime role from the generated SQL, `db:seed`, backfill roles. 4. Deploy API then web from the merged main. 5. Set flags only on the staging environment: `NETWORK_FEED_ENABLED`, `NETWORK_BUSINESS_PUBLISHING_ENABLED`, `NETWORK_BUSINESS_DISTRIBUTION_ENABLED` plus the Community enrollment controls it needs; never on production. 6. Synthetic accounts: one business owner, one admin, one manager, one cashier, two platform moderators, at least 11 verified customers (insights threshold), a second business with its own owner. 7. Acceptance scenarios: the 16-step journey in the BCOMM-06 test (`bcomm-06-integrated-acceptance`), then the same through the browser; disabled journey; each control closed in turn; customer deletion request with follows/events present. 8. Rollback: close the three controls (instant containment), keep the additive schema, restore from the snapshot only for a failed migration. 9. Production: not authorized; needs the Owner's separate instruction, legal approval of content policy and promotional terms, and the remaining decisions below.
Feature flag inventory for the operation: the five rows of §3. Required environment variables: none new beyond the flags (no secret added).

## 6. Verification recorded (all synthetic data, disposable databases)
API unit; PostgreSQL integration: business posts (lifecycle, one-approver publication, self-approval, link-domain rule, cap race, direct-SQL bypass, cross-tenant, authorization, impersonation, controls, audit), distribution and follows (visibility matrix incl. suspended business, withdrawn/suspended/unpublished profile, control values, follows isolation/privacy, DB trigger, pagination), engagement and insights (idempotency, visibility, thresholds, ranges, tenant isolation, append-only, cascade, non-effect), integrated acceptance (journey, containment, deletion regression, disabled journey); web unit; real Chromium (desktop, mobile, French, Spanish, Arabic RTL) for the hub, My Posts and Insights. The runtime-role drift check and migration governance tests pass. Hosted CI results are recorded on each PR; local integration is not staging acceptance.

## 7. Owner decisions that remain (not assumed)
- **Product policy:** audience beyond "all signed-in customers" (loyalty-only, followers-only, geography); whether a follow may ever carry notification consent; Community enrollment required to see business posts; the attribution model (direct/assisted/unattributed; window; which events) and whether profile visits get a customer profile surface; engagement event retention period; whether insights may include business-timezone presentation; link rule (own website only is the current safer default).
- **Legal:** content policy and reviewer appointments (D-16), promotional/offer wording rules, marketing consent for any outbound notification, deletion/retention treatment of engagement evidence (CUST-DEL-03 policy).
- **Operational:** two named platform moderators and SLAs, moderation history view for business posts, who may suspend a business post.
- **Infrastructure / release:** the staging operation itself, production migration, activation, PG18 hosted confirmation for the new migrations.

## 8. Limitations and cross-block review findings
- Moderation of business posts reuses the platform routes by handle; the moderation HISTORY screen still lists official posts only (decisions are in the audit log). Moderators now see the business name in the queue.
- Impressions are best-effort (a failed write never fails the feed); totals are therefore a lower bound under failures.
- Deleting a customer removes that customer's follows and events, so historical aggregates can shrink; this is the safe default pending the retention decision.
- No media, comments, likes, paid distribution, notifications, Shuffle or Drops exist or were added.
- Self-review (duplicate routes/services, migration collisions, permission consistency, moderation bypass, privacy leakage, analytics accuracy, consent, deletion, brand): the review found and fixed (1) two existing integration tests pinned to the old constraint name/trigger message (caught by hosted CI on #585), (2) unrestricted post links (now own-website only), (3) moderators lacked business context (added). No duplicate route, migration, permission or identity system remains.
