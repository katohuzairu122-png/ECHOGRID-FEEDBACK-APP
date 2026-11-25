# Pre-staging batch 02: consolidated staging preparation (PREPARED, NOT EXECUTED)

Nothing below has been run against staging or production. Every step needs the Owner's explicit instruction.

## 1. PR dependency order
1. #590 CASHIER-FINAL-RECONCILIATION (no migration; independent of the rest).
2. BIZ-CLOSE-01 (#591) migration 0094.
3. TB-02 (migration 0095; includes 0094 until #591 merges), then TB-03 and TB-04 stacked on it. After each merge the next PR is updated from main.
Earlier batch: PRs #579-#589 are merged; migrations 0088-0093 are in main but pending on shared databases.

## 2. Consolidated migration manifest (apply in ONE ordered run)
| # | Tag | Nature | Content |
|---|---|---|---|
| 0088 | community_membership_consent | additive | Community consent tables |
| 0089 | customer_deletion_requests | additive | CUST-DEL-01 requests + guard |
| 0090 | community_pilot_eligibility | additive | pilot allowlist events |
| 0091 | network_business_posts | additive | business post class + guards |
| 0092 | network_follows | additive | voluntary follows + guards |
| 0093 | network_engagement_events | additive | append-only engagement events |
| 0094 | business_closure_requests | additive | closure request record + guard (BIZ-CLOSE-01) |
| 0095 | tentaship_badges | additive | definitions, versions, award ledger, revocations (TB-02) |
Shared ledger on staging/production records 0000-0087 (88 rows); 0088-0095 pending. All are create-only: no existing table or row is altered. Journal count after: 96 entries (0000-0095). Re-run `pnpm db:verify:production` read-only before applying, and `node scripts/runtime-role/generate.mjs --check`.

## 3. Feature-control inventory (all OFF; none set in any checked-in config)
`NETWORK_FEED_ENABLED`, `NETWORK_BUSINESS_PUBLISHING_ENABLED`, `NETWORK_BUSINESS_DISTRIBUTION_ENABLED`, `NETWORK_BUSINESS_DAILY_POST_CAP` (optional), `COMMUNITY_AGGREGATE_MIN_GROUP_SIZE` (floor 10), Community membership/pilot controls (`COMMUNITY_MEMBERSHIP_PILOT_REQUIRED`, join/rejoin/restore controls), **`TENTASHIP_BADGES_ENABLED` (new)**. Reserved, unimplemented: `TENTASHIP_SHUFFLE_ENABLED`, `TENTASHIP_DROPS_ENABLED`. BIZ-CLOSE-01 has no control: it is a record-only request with processing blocked.

## 4. Restore point (before any shared-database step)
Neon snapshot of the target branch (record snapshot id and time) plus a branch from it; confirm the restore procedure on a scratch branch. Rollback for 0094/0095: `rollback/0094_0095_rollback.sql` (destroys closure/badge data created after the upgrade) followed by removing the two newest ledger rows. 0088-0093 rollback is covered by the earlier BCOMM-06 preparation.

## 5. Staging procedure (Owner-run, in order)
1. Merge PRs in section 1 order (Owner). 2. Snapshot. 3. Dry run of migrations on a scratch branch restored from the snapshot. 4. Apply on staging in one transaction (`pnpm db:migrate` with the staging URL, Owner-supplied). 5. `pnpm db:seed` and `pnpm db:backfill-role-permissions` as required (no new permission is introduced by batch 02: closure reuses `business:delete`). 6. Deploy API then web to staging via the existing workflow with the Owner approval gate. 7. Controls stay OFF; enable `TENTASHIP_BADGES_ENABLED` on staging ONLY for the badge scenarios, then switch back.

## 6. Synthetic accounts (staging only)
Owner A and Owner B (two businesses), a Manager (A), a cashier (A, one branch), two customers (one with a pending survey decision), a platform admin, two platform moderators. No real person or business is used.

## 7. Acceptance scenarios
- Cashier: cashier PWA shows Serve, Redeem, Account only; `/cashier/invite` is 404; a cashier token is refused (403 CASHIER_ROUTE_DENIED) on customer lists, accounts, adjustments, reports, settlement, rewards, Community, cashier administration, closure, badges. Owner-facing Cashier App still manages accounts, sessions, activity.
- Closure: Owner files a request (wrong password, wrong name refused; correct accepted; second click idempotent); Manager cannot; platform admin sees it read-only; withdrawal works; business keeps operating; no data changes; a suspended business is refused.
- Badges (control on, synthetic only): platform admin creates and activates a definition; blocked metric refused; customer with 2 survey completions evaluates -> 1 badge; repeat -> none; revoke -> hidden and not re-issued; business with a moderated post gets its badge; with control off every badge path is 404 and the UI shows nothing; legacy Community Points unchanged.
- Cross-module: Community, loyalty points, redemptions and audit trail behave as before.

## 8. Production restrictions
Production deployment, migration and any control activation require separate explicit Owner instruction. `TENTASHIP_BADGES_ENABLED` must stay off in production until the Owner decisions in TB_02_03_04 are made. No real business is closed and no customer data deleted by any step here. CUST-DEL-03 stays on hold (needs a named privacy operator, named approver, approved retention and legal-hold policies, reviewed migration).
