# Gate 2 R21 — Composite tenant-key migration design and read-only pre-check

**DEVELOPMENT / DISPOSABLE EVIDENCE ONLY. A design plus a read-only data pre-check. NO migration is written or applied, NO staging or production database is accessed by this block, NO deployment, Hyperdrive or credential change, NO financial activation.**

## Baseline
Authoritative main `8fd2159d078ca8da6444cba9a0669894642298f7` (R20 merged). 67 migrations (0000–0066). Everything below was run on a fresh disposable PostgreSQL 18.6 replay of them.

Why this exists: R20 showed that row-level security and claim checks do not stop a tenant-confined login from writing a row whose foreign key points at another tenant's row, because foreign-key checks run as the parent table's owner. Migration 0047 (CE-1) already fixed this pattern for the partner-credit tables. This block extends the same pattern, safely, to the remaining tables.

## Correction to R20
R20 counted 37 single-column foreign keys between tenant-owned tables. **Four of them are already covered**: 0047 added composite keys for `partner_credit_reservations` (account, decision) and `billing_partner_credit_applications` (reservation, subscription); the single-column keys remain beside them. That leaves **33 uncovered candidates**, classified below. A composite key counts as coverage **only when validated**: a `NOT VALID` composite key says nothing about rows that already exist (found by the self-test; the pre-check's inventory enforces it).

## The 33 candidates, classified
| Class | Count | Meaning | Intended handling |
|---|---|---|---|
| STRAIGHT | 20 | child and parent `business_id` are both NOT NULL | composite foreign key on `(business_id, fk)` to the parent's `(business_id, id)` |
| OPTIONAL_FK_SET_NULL | 2 | as above, but the optional reference is cleared when the parent is deleted | composite key with `ON DELETE SET NULL (fk)` (column list, PostgreSQL 15+) |
| NULLABLE_TENANT_DECISION | 8 | the child or the parent may have no tenant (platform-owned rows) | **owner decision**, see below |
| SELF_REFERENCE | 1 | `community_point_transactions.reversal_of` | composite self-key; also tenant-nullable, so decided with the group above |
| FINANCIAL_DEFER | 2 | `partner_credit_multiunit_lot_allocations` | **not changed here**: financial table, needs its own reviewed block |
| GUARDED_BY_TRIGGER | 1 | `signed_evidence_events.evidence_id` | already tenant-checked by the DEV-15 event trigger; a composite key is optional later hardening |

| Child | Parent | FK column | Class |
|---|---|---|---|
| ai_usage_log | branches | branch_id | STRAIGHT |
| community_point_transactions | branches | branch_id | NULLABLE_TENANT_DECISION |
| community_point_transactions | community_point_transactions | reversal_of | SELF_REFERENCE |
| critical_incidents | branches | branch_id | STRAIGHT |
| critical_incidents | feedback | feedback_id | STRAIGHT |
| feedback | branches | branch_id | STRAIGHT |
| feedback | qr_codes | qr_code_id | STRAIGHT |
| feedback_summaries | branches | branch_id | STRAIGHT |
| fraud_signals | branches | branch_id | STRAIGHT |
| fraud_signals | feedback | feedback_id | STRAIGHT |
| loyalty_accounts | business_customer_memberships | membership_id | STRAIGHT |
| loyalty_accounts | loyalty_tiers | tier_id | OPTIONAL_FK_SET_NULL |
| loyalty_purchase_events | branches | branch_id | OPTIONAL_FK_SET_NULL |
| loyalty_purchase_events | business_customer_memberships | membership_id | STRAIGHT |
| loyalty_purchase_events | loyalty_accounts | loyalty_account_id | STRAIGHT |
| loyalty_rewards | branches | branch_id | STRAIGHT |
| partner_credit_multiunit_lot_allocations | partner_credit_accounts | account_id | FINANCIAL_DEFER |
| partner_credit_multiunit_lot_allocations | partner_credit_award_decisions | decision_id | FINANCIAL_DEFER |
| qr_codes | branches | branch_id | STRAIGHT |
| qr_scan_events | branches | branch_id | STRAIGHT |
| qr_scan_events | qr_codes | qr_code_id | STRAIGHT |
| refresh_tokens | branches | branch_id | NULLABLE_TENANT_DECISION |
| signed_evidence_events | signed_evidence_records | evidence_id | GUARDED_BY_TRIGGER |
| survey_campaigns | branches | branch_id | NULLABLE_TENANT_DECISION |
| survey_campaigns | surveys | survey_id | NULLABLE_TENANT_DECISION |
| survey_participations | branches | branch_id | NULLABLE_TENANT_DECISION |
| survey_participations | consent_grants | consent_grant_id | NULLABLE_TENANT_DECISION |
| survey_participations | survey_campaigns | campaign_id | NULLABLE_TENANT_DECISION |
| survey_participations | surveys | survey_id | NULLABLE_TENANT_DECISION |
| team_invitations | branches | branch_id | STRAIGHT |
| team_invitations | roles | role_id | STRAIGHT |
| user_business_roles | branches | branch_id | STRAIGHT |
| user_business_roles | roles | role_id | STRAIGHT |
| visit_sessions | branches | branch_id | STRAIGHT |

## The pattern (verified on PostgreSQL 18)
1. **Parent unique key.** `UNIQUE (business_id, id)` on each parent (always satisfiable: `id` is already the primary key). It builds an index and briefly locks writes to the parent; the CE-1 precedent applies it in a quiet window. Prefer separate named constraints.
2. **Add the composite key `NOT VALID`.** New and updated rows are checked immediately (verified: a cross-tenant insert is rejected, SQLSTATE 23503, even while `NOT VALID`); existing rows are not scanned, so there is no long lock.
3. **Pre-check, then decide.** Run the read-only pre-check (below) on staging and production. Any violating row is a business decision (re-parent, correct, archive, delete); the design never auto-repairs data.
4. **`VALIDATE CONSTRAINT`** in a separate step. It fails if and only if violating rows exist (verified: the pre-check count is the set that blocks validation, and validation passes once those rows are remediated). It takes a lock that allows normal reads and writes.
5. **Keep the single-column key.** Add, do not replace: the 0047 precedent keeps both; the `ON DELETE` action of the composite key must equal the existing one (CASCADE stays CASCADE, SET NULL stays SET NULL).
- **Nullable optional references** (`branch_id` may be NULL): the default `MATCH SIMPLE` skips the check when any referencing column is NULL, so an empty optional reference stays legal (verified).
- **`ON DELETE SET NULL` needs a column list.** A plain `SET NULL` on a composite key would also try to null `business_id` and fail with a NOT NULL violation (verified, SQLSTATE 23502); `ON DELETE SET NULL (fk_column)` clears only the reference and keeps the tenant (verified).
- **Drizzle.** A composite `foreignKey` and the unique constraint can be declared in the schema, but `NOT VALID` and the separate `VALIDATE` cannot; follow the 0047 approach (generate, then hand-edit the SQL, keep `db:check` green). Drizzle runs pending migrations in one transaction, so `CREATE INDEX CONCURRENTLY` is not available inside a migration file.
- **Order by exposure**, one reviewed migration per batch: (1) feedback, qr_codes, qr_scan_events, visit_sessions, critical_incidents, fraud_signals, feedback_summaries, ai_usage_log; (2) loyalty tables; (3) team_invitations, user_business_roles, loyalty_rewards. Not in these batches: the nullable-tenant group, the financial pair, the trigger-guarded table.

## Application impact (not yet audited)
A composite key turns a silently wrong cross-tenant write into a 23503 error. Before applying, audit every code path that inserts or updates these tables (for example feedback creation, where `business_id` should come from the same QR code or branch row it references) so a legitimate request cannot start failing, and add a regression test per path.

## Read-only pre-check
`apps/api/scripts/gate2-tenant-reference-precheck.mjs` (run by the OWNER; this block never touches live data):
```
DATABASE_URL=<read-only connection> node scripts/gate2-tenant-reference-precheck.mjs --label staging|production|disposable [--sample N]
```
- Opens one `BEGIN READ ONLY` transaction, verifies it is read-only before any query, sets statement and lock timeouts, runs only SELECT, and rolls back. Needs only SELECT; use a dedicated read-only login, not the owner role.
- Prints **counts only** by default: per foreign key the referencing rows, tenant mismatches, child-untenanted and parent-untenanted rows. `--sample N` (max 20) adds the child row UUIDs of mismatching rows, never row contents. It never prints the connection string.
- **Coverage self-check:** it compares its specification to the live catalog and fails (exit 2) if a foreign key is unclassified, stale, mis-classified, or references a key other than the one named, so a new table cannot slip past it.
- Exit codes: 0 no mismatch and full coverage; 1 mismatches found; 2 specification drift; 3 a safety check failed.
- `child_untenanted` and `parent_untenanted` are NOT mismatches. They are the rows behind the nullable-tenant decision.
- A clean result proves nothing about rows written after the run. That is what the composite keys are for.

## Owner decisions required
1. **Nullable-tenant group (7 keys + the self-reference):** for platform-owned rows, choose per table: (a) add a CHECK that a tenant is present whenever the reference is set, (b) separate platform and tenant rows, or (c) accept as is. A composite key alone does not constrain a row whose `business_id` is NULL.
2. **Remediation policy** if the pre-check finds violating rows (re-parent, correct, archive or delete), and who approves it. Data changes need a verified backup first, as in the Gate 2 remediation report.
3. **Financial and evidence tables:** whether to open separate blocks.
4. **Authorization to run the pre-check** on staging and production, and with which read-only login.

## Verification performed (disposable PostgreSQL 18 only)
- Self-test: 43 checks, all passing: the pre-check counts exactly the injected violations (no false positives), is counts-only, issues only read statements inside one read-only transaction, leaves no locks and changes no rows, and gives the same result to a SELECT-only login; specification drift fails closed (unclassified, stale and mis-classified cases); the CLI exits 0/1/2/3 as documented and prints no credentials.
- Composite-key pattern: `NOT VALID` checks new rows; `VALIDATE` fails exactly when violations exist and passes after remediation; the key enforces and cascades; `MATCH SIMPLE` allows an empty optional reference; a column-list `SET NULL` keeps the tenant while a plain one fails.
- Mutation testing of the pre-check: 11 of 11 mutants caught (validated-only coverage, mismatch operator, read-only begin, sample bound, label requirement, unclassified, stale, consistency, untenanted count, sample ids, drift verdict).

## Not established
- The data on staging and production (never queried here).
- Lock durations and index-build time at production scale.
- That no application path relies on a cross-tenant reference.
- The `notIdParent` coverage branch is exercised only by the catalog it covers today (the evidence table's own key); no synthetic test mutates a parent key.

## Restrictions
No migration is written or applied, no live database is read, no deployment, Hyperdrive or credential change, no merge. Financial activation remains NO-GO.
