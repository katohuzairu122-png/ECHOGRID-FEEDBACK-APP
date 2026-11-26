# Groups 01-03: final acceptance, security review and consolidated staging preparation (PREPARED, NOT EXECUTED)

Nothing here has been run against staging or production. Every shared-database, deployment and activation step needs the Owner's explicit instruction. Statuses use the Owner's classification set.

## 1. PR dependency order (all open PRs are drafts; CI pending where stated in the final report)
`main` already contains #590-#601 (incl. #596 deadlock fix, #597 security cases, #598/#599 qualification). Merge in THIS order, updating each from main after the previous merge:
1. #602 TSH-03 campaign foundation (migration 0098)
2. #603 TSH-04 isolated selection primitive (no migration; stacked on #602)
3. #604 TSH-05 synthetic invitations/entries/selection record (migration 0099; stacked)
4. #605 TDP-02 sponsorship and atomic inventory (migration 0100; stacked)
5. TDP-03 collection verification (no migration; stacked on #605)
Stacked PRs show earlier commits until their parents merge. `docs/.../TSH_*` documents are authoritative for their blocks.

## 2. Complete migration manifest (apply in ONE ordered run; all create-only)
| # | Tag | Nature | Content |
|---|---|---|---|
| 0088-0095 | see PRESTAGING_BATCH_02_STAGING_PREPARATION.md | additive | Community consent through Tentaship Badges |
| 0096 | customer_invitations | additive | Owner customer invitations + guard (adds one partial unique index on customer_onboarding_events) |
| 0097 | qualification_referrals | additive | closed-engine rule versions, evidence consumptions, referrals + events |
| 0098 | shuffle_campaigns | additive | campaigns, immutable versions (fixed not_released), eligibility snapshots |
| 0099 | shuffle_participation | additive | synthetic-only invitations, entries, held notification intents, hash-chained events, selection results |
| 0100 | drops_sponsorship_inventory | additive | sponsorships, immutable versions, inventory, reservations, hash-chained events (no payment fields) |
Journal on main = 98 entries (0000-0097); after the stack = 101 (0000-0100). The shared ledger on staging/production holds 0000-0087 (88 rows) per the earlier batches: pending range 0088-0100 (13 migrations). Verify the ACTUAL deployed ledger before applying (UNKNOWN from this environment). No other branch carries a migration above 0097.

Evidence (disposable databases only): fresh install of 0000-0100 on PG16 (`echogrid_test`) and PG18 (`echogrid_ci_pg18_r21`); upgrade from the 0097 baseline (rollback then re-apply: ledger 98 -> 101, 14 shuffle_/drop_ tables recreated); rollback `rollback/0098_0100_rollback.sql` removed all 14 tables and all functions; runtime-role manifest `--check` OK; tenant-reference pre-check on PG18 NO_TENANT_MISMATCH_FOUND with no unclassified references.
Rollback docs: `rollback/0094_0095_rollback.sql`, `0096_0097_rollback.sql`, `0098_0100_rollback.sql` (each destroys data created since upgrade: back up first).

## 3. Feature-control inventory (every control OFF; none set in any checked-in wrangler config; each exact-string `"true"` only, server-side, fail-closed)
- Community/network: `NETWORK_FEED_ENABLED`, `NETWORK_BUSINESS_PUBLISHING_ENABLED`, `NETWORK_BUSINESS_DISTRIBUTION_ENABLED`, `COMMUNITY_MEMBERSHIP_JOIN_ENABLED`, `COMMUNITY_MEMBERSHIP_REJOIN_ENABLED`, `COMMUNITY_MEMBERSHIP_RESTORE_ENABLED`, `COMMUNITY_MEMBERSHIP_CLEARANCE_ENABLED`.
- Tentaship: `TENTASHIP_BADGES_ENABLED`, `TENTASHIP_SHUFFLE_ENABLED`, `TENTASHIP_DROPS_ENABLED` (independent of each other and of every Community control; never `NETWORK_FEED_ENABLED`).
Other controls named in earlier batches (e.g. an optional daily post cap) are listed in PRESTAGING_BATCH_02_STAGING_PREPARATION.md. Control names above were taken from the source, not guessed.

## 4. Restore point and procedure (before any shared-database step)
Neon snapshot of the target branch (record id and time) and a branch from it; rehearse the restore on a scratch branch; dry-run the whole pending range on a scratch branch restored from the snapshot, confirm the ledger count (88 -> 101) and run the runtime-role verifier. Rollback = the three rollback files above in reverse, in a transaction, plus deleting the matching ledger rows.

## 5. Staging procedure (Owner-run, in order)
1. Owner merges section 1 PRs in order (CI green on each head). 2. Snapshot. 3. Dry run on a scratch branch. 4. Apply on staging. 5. Provision/verify the runtime role (`provision-runtime-role.sql`, `verify-runtime-role.sql`). 6. Deploy API then web. 7. Run the synthetic journeys below with every Tentaship control OFF, confirm 404s, then (only on a further Owner instruction) turn ONE control on for a synthetic run and off again. Activation of any control, real campaigns, real winners, real rewards and sponsor payments are NOT part of this procedure.

## 6. Synthetic acceptance journeys (staging, synthetic accounts and data only)
Customer registration (email first); business authentication; Cashier App (eight allow-listed routes only; invitation creation is Owner/Admin on the dashboard, never the cashier); Community controls closed; Owner invitation (single-use, revocable, 24h default / 168h max, no membership/consent/points/badges granted); referral attribution evidence; recorded purchase evidence; Badges (control on, synthetic definition); Shuffle platform harness (control on, synthetic customers, approved synthetic rule created ONLY in the disposable test database: in staging no approved rule exists so snapshots fail closed, which is the expected result); Drops platform harness (same); business closure request handling (request only, no execution); customer deletion request handling (request only; CUST-DEL-03 remains blocked).

## 7. Independent adversarial review: findings
| # | Area | Finding | Status |
|---|---|---|---|
| 1 | TSH-04 audit chain | `chainAudit` hashed with a top-level key-list JSON replacer, silently dropping nested event fields from the hash (nested evidence alterable undetected). | DEMONSTRATED, FIXED (canonical JSON at every depth, `verifyChain`, regression tests) |
| 2 | TSH-04 verifiability | A statistical test alone did not prove correctness; no replay verification existed. | FIXED: recorded draws are stored; `verifySelection` replays the algorithm and checks both commitments; honest scope documented (replay proves correct application to the recorded draws, not that the draws were random) |
| 3 | Shuffle acceptance | A rejection raised inside the transaction would have rolled back the recorded withdrawal. | FIXED before merge (error raised after commit); regression test |
| 4 | Inventory | Counter updates must not be reachable by the runtime role. | Verified: no UPDATE grant; trigger-only (nested trigger depth), direct UPDATE/DELETE/TRUNCATE refused in tests |
| 5 | Randomness primitive | Isolation: not imported by any route except the synthetic harness; uses Web Crypto only; bound/rejection-sampling reviewed (2^32 limit, no modulo bias). | Reviewed; unit tests incl. biased-tail rejection |
| 6 | Cashier | Cashier tokens denied on every Shuffle and Drops route (allow-list unchanged at eight). | Verified for Shuffle (test); Drops covered by the same global guard (route not on the allow-list) |
| 7 | Replay of recorded random draws | Draws are public to platform admins and stored, so a malicious admin who controls inputs could try to pre-compute; the harness cannot be reached by customers or sponsors. | OWNER/LEGAL: real execution needs L-1..L-6 and an operational separation-of-duties model (TSH-08) |
Not independently re-reviewed this batch: closure execution (blocked), badge ledger beyond existing tests, web UI (none added).

## 8. Block classification (evidence in the final report)
See the final report section F/G. In short: TSH-03, TSH-04, TSH-05, TDP-02, TDP-03 are IMPLEMENTED — VALIDATION PENDING (hosted CI). TSH-06, TSH-07, TSH-08, TSH-09, TDP-04 are not complete and are classified individually in the report.

## 9. Decisions and approvals still required
Legal L-1..L-6 (lottery/gambling classification, consumer protection, privacy, tax, sponsor contract terms, jurisdiction) and product D-3..D-5 are unchanged and unresolved in the repository. Also required before any real execution: approved qualification rules (D02-D06), sponsor onboarding and permission keys (`drops:*`, `shuffle:*`), notification/marketing-consent policy for Shuffle, Mode B no-reward wording, minimum aggregate group size, retention periods, fraud/dispute operating owners, fulfilment SLAs.
