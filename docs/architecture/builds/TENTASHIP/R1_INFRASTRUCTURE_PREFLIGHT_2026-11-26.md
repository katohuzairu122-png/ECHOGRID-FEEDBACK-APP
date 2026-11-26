# R1 — Infrastructure preflight and R2 staging authorization package (2026-11-26)

Read-only. Nothing in this record migrated, deployed, restored, created, purchased, activated or modified anything. Facts are separated from recommendations and from evidence that could not be obtained. Secrets are not reproduced.

## 1. Verified facts (read-only, 2026-11-26)
| Item | Finding |
|---|---|
| `main` | `e940ddb4f7f01ee740611964c8753f1a89f850c4` |
| Open pull requests | 0 |
| CI on `main` | `e940ddb`, `e1f5a8b`, `e1aea46` completed/success (the push workflow runs the single job "Typecheck & Test"; the full PG18 and Chromium set runs on pull requests) |
| Journal | 0000–0106, 107 entries; `db:check` OK; runtime-role check OK; fresh install of the whole chain on a disposable database reached 107 ledger rows |
| Staging ledger (Neon project `lucky-glitter-47218268`, branch `br-bold-water-aukjlvw3`) | 88 rows, last `created_at` 1795250000000; none of the checked Tentaship/Community/deletion tables present |
| Production ledger (project `divine-voice-54333763`, branch `br-blue-paper-atrcoge1`) | 88 rows, last `created_at` 1795250000000; none of those tables present |

## 2. Ordered ledger identity and hash comparison (read-only)
Each target's ledger rows (ordered by id) were joined to the 88 baseline journal entries (0000–0087) by position, comparing the 12-character hash prefix and the timestamp.
| Target | Rows | Timestamp matches | Hash matches | Hash-mismatch positions |
|---|---|---|---|---|
| Staging | 88 | **88 / 88** | 75 / 88 | 0, 1, 2, 3, 4, 5, 6, 11, 12, 18, 19, 20, 21 |
| Production | 88 | **88 / 88** | 80 / 88 | 0, 6, 11, 12, 18, 19, 20, 21 |
These are exactly the positions already documented in `CF2_MIGRATION_RECONCILIATION.md` (production 8, staging 13): early files were normalised after being applied. The migrator decides by timestamp, and every timestamp matches. **No new drift.** The comparison must be repeated immediately before authorization.

## 3. GitHub protections
| Item | Result |
|---|---|
| Required status checks on `main` | **UNVERIFIED.** Classic branch protection returned 403 to the available token; the rulesets API returned no rules for `main`. |
| Environment reviewers for `staging` and `production` | **UNVERIFIED.** The environments API is blocked through the proxy. Workflows reference environments `staging` (migrate, deploy) and `production` (migrate, deploy, cashier, web-only). |
**Manual verification (Owner, GitHub → Settings):**
1. *Branches / Rulesets → `main`:* require a pull request; require status checks (recommend at least: Typecheck & Test; PG18 clean replay and read-only security catalog; PG18 synthetic prefix and 22-migration upgrade; Chromium provisional acceptance (PostgreSQL 18); PostgreSQL 18 restricted broker role and use-time authorization; Nonowner tenant RLS and restricted role audit); block force pushes and deletion.
2. *Environments → `staging` and `production`:* required reviewers set; "prevent self-review" on; deployment branches limited to `main`.
3. *Environments → secrets (names only, never values):* `STAGING_DATABASE_URL` under `staging`; `PRODUCTION_DATABASE_URL` under `production`; Cloudflare account id and API token present where the workflows reference them.

## 4. Cloudflare
| Item | Result |
|---|---|
| Account holding the application Workers | "Katohuzairu122@gmail.com's Account" (the INFINICUS LLC account lists only `infinicus-voice` Workers) |
| Workers present | `echo-grid-feedback-api`, `-web`, `-cashier` (production); `-api-staging`, `-web-staging`, `-cashier-staging` |
| Last modified | production API 2026-11-24T22:18Z, production web 2026-11-24T22:23Z; staging API/web 2026-11-22T10:01Z — all **before** the Tentaship code merged to `main`, so the deployed builds do not contain the Tentaship routes |
| Hyperdrive separation | Two configurations: production `542dd173…` → a Neon host in the `c-9` proxy family (matches project `divine-voice…`); staging `fdf77795…` → a `-pooler` host in the `c-10` family (matches `lucky-glitter…`). Separated. Caching disabled on both. |
| Repository configuration | distinct Worker names and Hyperdrive ids for staging and production (test-enforced); no feature control in any Worker config or workflow (test-enforced) |
| **Actual deployed runtime variables** | **UNAVAILABLE.** The connector returns only a Worker's name and id. Because the deployed builds predate the Tentaship code, the Tentaship controls cannot currently take effect, but the Community controls cannot be confirmed from here. |
**Manual verification (Owner, Cloudflare dashboard → Workers → each Worker → Settings → Variables):** confirm none of `TENTASHIP_BADGES_ENABLED`, `TENTASHIP_SHUFFLE_ENABLED`, `TENTASHIP_DROPS_ENABLED`, `NETWORK_FEED_ENABLED`, `NETWORK_BUSINESS_PUBLISHING_ENABLED`, `NETWORK_BUSINESS_DISTRIBUTION_ENABLED`, `COMMUNITY_MEMBERSHIP_JOIN_ENABLED`, `COMMUNITY_MEMBERSHIP_REJOIN_ENABLED`, `COMMUNITY_MEMBERSHIP_RESTORE_ENABLED`, `COMMUNITY_MEMBERSHIP_CLEARANCE_ENABLED` is set to the exact string `true` on either environment.

## 5. Hazards noted
- The default branch of the **staging** Neon project is named `production` (`br-bold-water-aukjlvw3`). Operators must use the project id, not the branch name, to tell environments apart.
- The staging Hyperdrive origin is a pooled endpoint; production's is not. Migrations use the environment secret's connection string, not Hyperdrive.

## 6. Backup and recovery feasibility (O-6 targets; definitions kept apart)
**Facts**
| Item | Staging | Production |
|---|---|---|
| PITR (history window) retention | 86,400 s (24 h) | 21,600 s (6 h) |
| Automated backup schedule | none | none |
| Manual snapshots | 16 (latest `snap-solitary-snow-aueajoiy`, 2026-11-26T13:10:38Z) | 6 (latest `snap-purple-frog-atnwlwi4`, 2026-11-20T18:53:17Z) |
| Snapshot restores previously exercised | yes (staging records restores from snapshots on 2026-11-09, 2026-11-18, 2026-11-19) | yes (restores recorded 2026-11-09 and 2026-11-19) |
| Plan | not shown for this project | billing record for production shows plan **launch** (Oct 2026); same organization |
| Restore time ever measured end to end | no | no |
No RPO or RTO had been approved before this ruling; the earlier "RPO ≤ 24 h / RTO ≤ 4 h" were proposals, and a 6-hour window is not by itself an RPO failure.

**Neon capabilities (documentation read today)**: history window maximum 7 days on Launch, 30 days on Scale (retained history billed at $0.20/GB-month); daily, weekly or monthly backup schedules on paid plans, scheduled-snapshot retention 1 hour to 35 days, scheduled snapshots do not count toward the 100-manual-snapshot limit, snapshot storage $0.09/GB-month (first scheduled snapshot full size, later ones incremental); manual snapshots never expire unless an expiry is set.

**Assessment against the targets**
| Target | Achievable on the existing plan? | Notes |
|---|---|---|
| PITR retention 7 days | Yes — exactly the Launch maximum | change production `history_retention_seconds` 21,600 → 604,800; cost grows with change volume; not estimable without the change rate (database logical size is about 44 MB) |
| Daily automated backups | Yes | add a daily schedule on the production branch |
| Backup retention 30 days | Yes (limit 35 days) | `retention_seconds` 2,592,000 |
| Verified pre-release restore points | Yes, as a process | a snapshot plus a restore into a scratch branch to compare ledger and fingerprints; each scratch branch is billable and needs authorization |
| RPO ≤ 1 h | **Only for logical or application errors detected inside the PITR window** | inside the window a restore point can be chosen by timestamp or LSN; beyond 7 days only the daily snapshots remain (up to ~24 h of change); a provider- or region-level failure is not covered by in-platform features and **no off-platform logical backup is evidenced** |
| RTO ≤ 4 h | **Unproven** | an in-place restore keeps the branch name and connection string, but the full path (decide, restore, verify, application check) has never been timed; a timed drill is required |
**No plan upgrade is required for the targets above. Any change is a separate authorization; none was made.**
**Recorded infrastructure changes (not performed):** (1) production history window to 7 days; (2) daily backup schedule with 30-day retention on production (staging optional); (3) a timed restore drill; (4) an Owner decision on an off-platform logical backup for provider-level failure; (5) confirm cost against actual billing after (1) and (2).

## 7. Existing staging restore point `snap-solitary-snow-aueajoiy`
| Check | Result |
|---|---|
| Environment and source | staging project `lucky-glitter-47218268`, source branch `br-bold-water-aukjlvw3` — correct |
| Availability | listed as a manual snapshot, created 2026-11-26T13:10:38Z; no expiry was set, so it is kept until deleted |
| Migration baseline | ledger was 88 rows at snapshot time and still 88 when re-read — **inferred**, not proven by restoring it |
| Recoverability | the snapshot restore method has been used successfully on staging before; **this snapshot has not been restored** |
| Data protection | holds staging data; protect like staging; size 43,122,688 bytes |
| Compatibility with 0088–0106 | it is a pre-migration state at 0087, which is the required baseline |
| Freshness | re-read the ledger and confirm no staging writes of value since 13:10Z, or take a new snapshot at authorization time |
**Recovery caveat from the Neon documentation:** a branch created by restoring a snapshot cannot use instant (point-in-time) restore for now. So the preferred recovery from a failed migration is an instant restore to a timestamp just before the dispatch (staging window 24 h, preserving the pre-restore state under a name); the snapshot is the fallback. **Do not restore over the existing staging branch without instruction.**
**Isolated scratch-branch rehearsal procedure (not executed; needs authorization because it creates a billable branch):** (1) create a branch from the snapshot or from the staging branch at a recorded timestamp; (2) run the same pinned `migrate-staging.yml` steps against that branch's connection string through a temporary environment secret, or run `db:migrate` locally against it; (3) compare ledger = 107, table presence and emptiness, runtime-role verify SQL; (4) delete the scratch branch; (5) record the elapsed time (this also measures RTO for part of the path).

## 8. R2 — staging migration authorization package (REFRESHED from 0088–0090 to 0088–0106; NOT EXECUTED)
**Authorization request (for the Owner to sign):**
> I authorize applying migrations `0088_community_membership_consent` through `0106_shuffle_notification_deliveries` (19 migrations; ledger 88 → 107) to the STAGING database only (Neon project `lucky-glitter-47218268`, branch `br-bold-water-aukjlvw3`), using the protected workflow `migrate-staging.yml` pinned to the full commit SHA `<40-hex SHA of main at dispatch>` with the typed confirmation `MIGRATE_STAGING`, with restore point `<snapshot id and time>` confirmed. No production resource, deployment, feature control, operator assignment or data change is authorized.

- *Current SHA:* `e940ddb4f7f01ee740611964c8753f1a89f850c4`. If documentation merges first, `main` moves; use the new SHA after confirming `git diff e940ddb..<new> -- apps/api/drizzle apps/api/src/db` is empty.
- *Workflow:* checks the 40-hex SHA equals `main`, the typed phrase, runs `db:check`, `db:migrate`, `db:verify:production` under environment `staging`.
- *Pre-checks (immediately before dispatch):* ordered ledger comparison (§2) repeated; CI green on the pinned SHA; restore point re-confirmed (§7); GitHub and Cloudflare manual checks (§3, §4) done.
- *Expected result:* ledger 107, last `created_at` 1795677278079; new tables exist and are empty; no feature control set.
- *Post-verification (read-only SQL):* `select count(*) from drizzle.__drizzle_migrations` = 107; each of `shuffle_campaigns`, `drop_sponsorships`, `governance_cases`, `governance_operators`, `governance_decision_policies`, `sponsor_applications`, `drop_fulfilment_policies`, `shuffle_drop_allocations`, `shuffle_notification_deliveries` exists with 0 rows; runtime-role verification SQL passes.
- *Failure:* the batch runs in one transaction and rolls back (ledger stays 88). Do not patch by hand.
- *Recovery (only on instruction):* instant restore to the timestamp before dispatch (record it), else snapshot restore with an explicit target branch.
- *Stop conditions:* any pre-check mismatch; any unexplained ledger difference; CI not green; restore point not confirmed.

**Manifest (SHA-256, first 16 hex, of the committed SQL files):**
| idx | migration | sha256 (16) | additive? | rollback evidence (not executed) |
|---|---|---|---|---|
| 88 | 0088_community_membership_consent | 2a9dd536afacd36b | yes | CF2 reconciliation |
| 89 | 0089_customer_deletion_requests | 3ce8df8edd63f6a3 | yes | CF2 reconciliation |
| 90 | 0090_community_pilot_eligibility | e124c9cdf90eab46 | yes | CF2 reconciliation |
| 91 | 0091_network_business_posts | 96add276985436d7 | yes | — |
| 92 | 0092_network_follows | 3c07f1eb1ea8eecb | yes | — |
| 93 | 0093_network_engagement_events | e23aaa8e37b43d83 | yes | — |
| 94 | 0094_business_closure_requests | 15ff54c291a07be7 | yes | 0094_0095_rollback.sql |
| 95 | 0095_tentaship_badges | 924d312808727cca | yes | 0094_0095_rollback.sql |
| 96 | 0096_customer_invitations | 3a37f1203bc94563 | yes | 0096_0097_rollback.sql |
| 97 | 0097_qualification_referrals | f9a8ae915355a293 | yes | 0096_0097_rollback.sql |
| 98 | 0098_shuffle_campaigns | 9f105af84af13fb0 | yes | 0098_0100_rollback.sql |
| 99 | 0099_shuffle_participation | e937b28677920a1d | yes | 0098_0100_rollback.sql |
| 100 | 0100_drops_sponsorship_inventory | d0ff110a41c8fccb | yes | 0098_0100_rollback.sql |
| 101 | 0101_governance_cases_overrides | ac005e6b3f265c86 | yes | 0101_rollback.sql |
| 102 | 0102_governance_fraud_signals_dedup | 486b20fd1642c596 | yes | 0102_rollback.sql |
| 103 | 0103_shuffle_drop_allocations | b71892133e6e683b | yes | 0103_rollback.sql |
| 104 | 0104_governance_operator_lifecycle_decision_policies | 059f0f6538af7609 | yes (replaces 0101 guard functions) | 0104_rollback.sql |
| 105 | 0105_sponsor_applications_fulfilment_policies | 51673be575db00a5 | yes (replaces 0100 guard functions) | 0105_rollback.sql |
| 106 | 0106_shuffle_notification_deliveries | fdda2ac3d98347d7 | yes | 0106_rollback.sql |

## 9. R3–R7 prerequisites
- **R3 Controls-off staging deployment:** R2 verified; separate staging deployment instruction; every control unset. Verify gated routes answer a generic 404, no notification can be sent. Failure: any gated route reachable. Recovery: redeploy the previous build, unset controls. Stop: unexpected reachability.
- **R4 Synthetic feature acceptance:** R3 verified; clearly marked synthetic operators, policies and test text in staging only; individual authorization per control; one control at a time; controls restored to off afterwards. Stop: any cross-family leakage or unexpected state change.
- **R5 Production readiness:** R4 passed; relevant rulings satisfied (not merely approved); legal L-1…L-6 and translations H-1…H-4 for any customer-visible use; operational names O-1…O-12; the O-6 infrastructure changes authorized and in place; a verified production restore point for this range.
- **R6 Production release:** separate production record; `migrate-production.yml` (typed `MIGRATE_PRODUCTION`) then `deploy-production.yml` (typed `DEPLOY_PRODUCTION_RELEASE`, CI gate, `production` environment approval per job); fresh production snapshot and ledger comparison immediately before.
- **R7 Feature activation:** one control at a time, each by individual instruction, only after its own legal, operational and decision prerequisites are satisfied. All ten controls stay unset or disabled otherwise.
