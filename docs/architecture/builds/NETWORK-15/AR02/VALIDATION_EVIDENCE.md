# AR02 isolated verification and evidence boundaries

**DRAFT — LEGAL REVIEW REQUIRED — NOT APPROVED.** Test results are technical
observations, not legal/publication/release/activation approvals. Baseline:
`34925e541af993a9a75f82f0ffa7480851aaf6e0`.

## Fresh executed checks

| Check                                    | Result and scope                                                                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen-lockfile local install            | PASS, pnpm 11.9/Node 22; no dependency/lockfile change committed.                                                                                                                                             |
| Terms-authority tests                    | 55 passed, zero failed/skipped; actual module, not a stand-in validator.                                                                                                                                      |
| Protected-deployment governance tests    | 22 passed, zero failed/skipped; static source checks, not live protection certification.                                                                                                                      |
| Migration-governance tests               | 71 passed, zero failed/skipped. Combined unit run: 148 across three files.                                                                                                                                    |
| PostgreSQL 16.16                         | 52 passed, zero failed/skipped: runtime consent 40, platform lifecycle 7, storage design 5.                                                                                                                   |
| PostgreSQL 18.7                          | Same 52 passed, zero failed/skipped, separate fresh disposable cluster.                                                                                                                                       |
| Exact upgrade rehearsal on each PG major | Actual Drizzle Kit prefix through 0087, then normal full journal applied exactly one new entry (0088); 89 fresh SQL hashes matched.                                                                           |
| Synthetic populated-data preservation    | All-column fingerprints/counts of ten populated tables unchanged across 0088 on both majors; business ledger/projection 42 and separate Community ledger/projection 73 retained. No prior consent fabricated. |
| Documented read-only SQL bundle          | PASS on fresh PG16/18: 12 statements, six ALWAYS guards and three valid/ready indexes; no shared target.                                                                                                      |
| Post-upgrade authority/guards/index      | Empty current pointer, zero publications/Community grants; six expected guards ALWAYS; scoped unique index valid/ready; preserved legacy active membership.                                                   |

The ten synthetic tables were customers, businesses, business_customer_memberships,
loyalty_accounts, loyalty_transactions, community_memberships,
community_point_accounts, community_point_transactions, consent_grants and audit_log.
Fixtures are clearly synthetic and confined to loopback disposable databases;
these are not real customer enrollments, legal approvals or financial activation.
The original repository journal/SQL was not edited: a temporary isolated prefix
folder/config selected the 0087 test baseline; normal full-journal migration then
proved the pending-range behavior. No down migration was executed.

Additional documentation/locale/SQL-template checks and final documentation-head
hosted CI are recorded in this PR's completion evidence. The read-only SQL bundle
is validated only against disposable targets, not shared production/staging.

## Existing evidence reused, not falsely rerun as AR02 browser acceptance

The reviewed T2 head f1efc9d had 27/27 hosted workflows successful: API units 4,233;
web units 1,306; PG16 and PG18 each 1,654 passed/40 skipped; Community HTTP 52 passed/
19 browser-only skipped; Chromium 19 passed/17 non-browser filtered, including
Join/Rejoin/fresh Restore in en/fr/es/ar at 375px/1280px. AR01's documentation head
had 25/25 green. Both PRs are now merged, and the runtime tree is unchanged by AR01.

AR02 does not claim a new native-language/legal/accessibility certification or a
new T2 Chromium run. Automatic documentation CI may run repository baseline tests
separately; its exact results are not substituted for these implementation-head
browser results. Skipped/not-run tests are never counted as passes.

## Not performed / not verified

No shared target connection, production/staging migration, deployment, live flag,
role/secret change, legal publication, real acceptance, notification or recovery
cutover. Shared journal/role/protection/backup, approved legal text, translations,
retention, named operators and runtime containment remain unverified/unapproved.
No CONTROL-01 flag, endpoint, permission, schema or feature is implemented by AR02.
AR01's dated historical findings are preserved, with a dated follow-up link. Tests use small synthetic data;
production-scale lock timing, backup recovery objectives and actual operator
procedures still require separate approvals and rehearsal.
