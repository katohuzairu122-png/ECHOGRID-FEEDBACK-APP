# 0088 migration and protected-release approval checklist

**DRAFT — LEGAL REVIEW REQUIRED — NOT APPROVED. No shared migration/release authorized.**
Read with [AR01's unexecuted runbook](../AR01/CONTROLLED_ACTIVATION_RUNBOOK.md),
[decisions D06/O6 and D10/O10](READINESS_AND_OWNER_DECISIONS.md) and
[isolated evidence](VALIDATION_EVIDENCE.md). Source baseline:
`34925e541af993a9a75f82f0ffa7480851aaf6e0`.

## Exact scope and runner behavior

The journal contains 0000–0088 (89 entries at this baseline). 0088 adds two empty
terms tables, purpose/state CHECKs, a restricted pointer FK, publication/current
ALWAYS guards and customer-scoped Community request uniqueness. It backfills no
customer, membership, consent or balance. Existing 0085 audit immutability and 0086
privacy handling are not edited. Runtime classification adds SELECT only for the
two new authority tables; this does not prove the actual connection role is safe.

`db:migrate` is `drizzle-kit migrate`, uses the configured journal/out folder and
`DATABASE_URL`, not a Worker Hyperdrive credential. Inspection of the installed
PostgreSQL dialect and actual isolated CLI confirms timestamp-based application of
the pending range. It is **not an 0088-only command**. Examples, conditional on a
valid exact prefix: through 0087 -> 0088 only; through 0079 -> 0080–0088; fresh ->
0000–0088. None is a claim about today's shared target.

`verify-production-migrations.mjs` checks presence of journal timestamps and
reports exact SQL hash matches; it intentionally does not reject historical hash
normalization mismatches or unexpected additional timestamps. Its success alone
is **not** an exact-prefix/hash attestation. The runner's latest-timestamp behavior
also makes gaps/future or unexpected ledger entries unsafe. Independently compare
ordered identity/count/hash records to the reviewed manifest. Any legacy normalized
hash exception needs its existing documented explanation and migration-owner
acceptance; never silently ignore unexplained drift or edit merged history.

AR02 used the actual Drizzle Kit to create a prefix through 0087 in disposable
PG16.16/PG18.7, seeded balanced synthetic business and Community history, then ran
the normal full journal. Exactly one new entry applied on each. All 89 fresh SQL
hashes matched and ten populated table fingerprints remained identical. This is
small isolated compatibility evidence, not a production lock/size certification.

## Prerequisites and approval checkpoints

| Hold                     | Evidence required before permission                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target attestation       | Exact environment/project/branch/database, deployed API/web SHAs, connection role and data classification. No secret values in tickets/output.                                                                                   |
| Prefix and scope         | Full ordered applied journal, reviewed manifest and explicit pending range. Stop on gap, unexpected timestamp/hash, wrong target or unapproved upstream security/privacy migration.                                              |
| Ownership                | Named migration executor and separate approving Owner; each pending workstream's prerequisites accepted. T2 does not authorize R8-G/D2/cashier cutover or arbitrary grants.                                                      |
| Backup/recovery          | Fresh approved recovery point, isolated restore, actual retention/access/cost and RPO/RTO; later-write and privacy reapplication plan. Old 0079 evidence is insufficient.                                                        |
| Lock/transaction budgets | Measure CHECK validation, table scans and non-concurrent unique index under approved representative load. Set approved lock/statement limits from evidence, not an invented number. Test cancellation/ambiguous-commit handling. |
| Handover containment     | Verified route control for old Join and clearance/mixed clients; NULL authority cannot protect old code. Proposed CONTROL-01 is not implemented.                                                                                 |
| Migration authorization  | Separate staging then production approval for the complete pending range and exact-main SHA; protected workflow confirmation is only a typo guard.                                                                               |
| Runtime grants           | Separately approved least-privilege executor; verify SELECT-only authority access and no mutator/guard bypass through the actual runtime role. No wholesale role provisioning assumed.                                           |
| Protected deployment     | Actual reviewers, self-review prevention, branch rules, environment-only credentials and exact SHA verified; independent API and web approvals. Source workflow existence is not enforcement proof.                              |
| Publication              | Approved legal/localized bundle, immutable hashes/version/dates, approved operator/transaction/evidence; stage non-current. No app publisher endpoint exists.                                                                    |
| Activation               | Distinct G8 target/publication/customer-scope authorization after G1–G7, verified containment/pilot mechanism and monitoring/support readiness. Feed configuration is a separate act.                                            |

## Read-only verification queries — review templates

**NOT EXECUTED ON SHARED DATABASES.** Only an approved investigator/operator may
run them there. They do not grant access or establish legal/operational approval.
Before 0088, use only target/ledger/object-presence inspection and compare the
approved prefix. The bundle below is **post-0088 only**; missing objects stop the
verification. Use a consistent read-only snapshot and approved time budget. Rows
are schema metadata or aggregate counts, not customer contacts/tokens. Do not
publish sensitive production output. Full artifact/hash validity is enforced by
the real authority, not approximated by these SQL checks.

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT current_database() AS database_name, current_user AS database_role,
       current_setting('server_version') AS postgres_version;
SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id;
SELECT to_regclass('public.community_terms_current') AS current_table,
       to_regclass('public.community_terms_publications') AS publications_table;
SELECT purpose, publication_id FROM public.community_terms_current;
SELECT count(*) AS publication_count FROM public.community_terms_publications;
SELECT conrelid::regclass::text AS table_name, conname, contype, convalidated,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN ('public.community_terms_current'::regclass,
                  'public.community_terms_publications'::regclass,
                  'public.community_memberships'::regclass,
                  'public.consent_grants'::regclass)
ORDER BY table_name, conname;
SELECT c.relname AS index_name, i.indisunique, i.indisvalid, i.indisready,
       pg_get_indexdef(i.indexrelid) AS definition
FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
WHERE c.relname IN ('consent_grants_community_request_key',
                   'community_memberships_customer_key',
                   'community_point_accounts_customer_key')
ORDER BY index_name;
SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgname IN ('community_terms_publication_guard',
                 'community_terms_publication_no_truncate',
                 'community_terms_pointer_guard','community_terms_pointer_no_truncate',
                 'audit_log_immutability_guard_trg','audit_log_no_truncate')
ORDER BY tgname;
SELECT m.status AS membership_status, a.status AS account_status, count(*) AS pairs
FROM public.community_memberships m
LEFT JOIN public.community_point_accounts a USING (customer_id)
GROUP BY m.status,a.status ORDER BY m.status,a.status;
SELECT count(*) AS incorrectly_scoped_community_grants
FROM public.consent_grants
WHERE purpose='community_membership'
  AND (business_id IS NOT NULL OR resource_type IS DISTINCT FROM 'community_membership'
       OR scope IS DISTINCT FROM 'community_membership');
COMMIT;
```

Fresh-migration expectations: one purpose/current-pointer row with NULL target,
zero seeded publications/Community grants, validated CHECK/FK/unique constraints,
valid/ready scoped indexes and six named guards enabled ALWAYS (`A`). Existing
legacy records remain identical; compare approved pre/post counts/fingerprints
and original account IDs, balances and ledger history. Normal paired states are
active/active, left/closed, suspended/suspended and inactive/closed. Any unexpected
legacy pair requires investigation, not automatic healing. Verify actual runtime
SELECT and mutation denials separately with the approved role; owner execution of
these catalog queries is not proof of runtime least privilege.

## Failure and forward recovery boundaries

Stop on unexplained prefix/hash, invalid index/constraint/guard, balance/history
change, missing table/read grant, new consent seeded by migration, unsafe mixed
application versions, missing backup or any unapproved upstream action. Treat a
lost connection as an **unknown commit outcome**: inspect journal/schema and data
before retry. Never mark a migration applied manually or delete journal entries.
The dialect uses transactional migration batches; bootstrap/transport and external
release steps are not an atomic deployment guarantee. Cancellation/lock behavior
still needs target-shaped rehearsal.

There is no down migration. Retain additive schema and immutable publications/
proof; prefer a compatible forward fix. Do not edit an approved publication or
roll back to a pre-T2 acceptance bypass. Database restore/cutover, Worker rollback,
route containment, pointer changes and reapplication of privacy decisions each
need their own approved authority. Detailed scenarios are in the
[operating/recovery draft](OPERATING_RECOVERY_MODEL.md).
