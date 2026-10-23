# Release preparation: Next.js fix, migration 0047 preflight, Neon certification checklist (2026-10-23)

**Status: PREPARATION ONLY. Nothing here was executed.** No production database, Neon, Cloudflare, GitHub-environment or Stripe resource was read or changed while writing this; every "owner runs" item below needs your explicit authorization and access I do not have. Items are labelled **VERIFIED** (established by me in this repository or in CI), **OWNER TO CONFIRM** (needs live access), or **NOT DONE**.

## 1. Next.js security release (preparation)

Fix: `next` 16.3.8 → 16.4.2 (critical RCE GHSA-2464-fhr4-w9xw and GHSA-673q-mjm6-r5xr, high Server Actions DoS; patched >= 16.4.1). Merged in #159.

| Check | Status |
|---|---|
| Fix is on `main`, `pnpm audit --prod --audit-level high` clean, web typecheck / 266 tests / `next build` pass | VERIFIED (CI on #159 and on main) |
| Release workflow exists, is manual, binds to the exact `main` tip, re-runs the full CI gate, deploys API then web | VERIFIED statically (`deploy-production.yml`, 18 governance tests, actionlint). **Never run**; artifact sharing across the called workflow is UNRESOLVED until the first release |
| `production` environment has required reviewers, prevent-self-review, deployment branches = `main` | OWNER TO CONFIRM (`docs/PRODUCTION-RELEASE.md`) |
| Cloudflare credentials are production-only environment secrets (repository-level copies removed) | OWNER TO CONFIRM |
| Rollback readiness: previous Worker versions available in Cloudflare; owner decides rollback (not automated) | OWNER TO CONFIRM |
| API/web compatibility: both deploy from the same SHA, API first | VERIFIED by design; web does not deploy unless the API did |
| Whether the live app actually uses SVG image optimization or `use cache` (the exploitable paths) | NOT ASSESSED |

Note: the same release also ships everything merged since the last release: heartbeat capture-off fix (B1), and the new pure Split 07/08/HETA code, none of which is wired to a route. Migrations are separate (section 2).

## 2. Migration 0047 preflight

`migrate-production.yml` applies **every pending migration**, not only 0047. If production's last migration run (2026-10-16, journal then at 0044) is still the latest, one dispatch applies **0045 (evidence tables, inert), 0046 and 0047**. Confirm the live level first.

Verified in the repository:

| Item | Value |
|---|---|
| File | `apps/api/drizzle/0047_split08_ce1_composite_tenant_integrity.sql` |
| SHA-256 (what Drizzle records) | `2af51afe3df438cce9dffbf2722b999349421909dee75b38cc68c657ad1039ea` |
| Journal | index 47, `when` = 1792694651254, 48 entries; 0046 `when` = 1792564476401, 0045 = 1792396452019, 0044 = 1791777600000 |
| Content | 5 `UNIQUE (id, ...)` constraints (parents), then 5 composite foreign keys on the inert reservation/application tables. No trigger, guard, existing constraint or data is touched |
| Tested | applies from an empty database; re-applied over populated parent tables (25 decisions, 13 accounts, 23 lots, 5 subscriptions) with all 10 constraints validated; full integration suite; 5 guards + 4 constraints enabled afterward |

Owner runs, **read-only**, against production before authorizing (use a read-only transaction; none of these write):

```sql
-- 1. live migration level (expect to see which of 0045/0046 are missing)
SELECT count(*) AS applied, max(created_at) AS latest FROM drizzle.__drizzle_migrations;
SELECT created_at FROM drizzle.__drizzle_migrations WHERE created_at IN (1791777600000, 1792396452019, 1792564476401, 1792694651254) ORDER BY 1;

-- 2. prior migrations the economic guards depend on (expect 5 rows 'O' and 4 validated)
SELECT tgname, tgenabled FROM pg_trigger WHERE tgname IN ('partner_credit_lots_inert_guard','partner_credit_ledger_insert_disabled','partner_credit_reservations_inert_guard','pc_multiunit_allocation_inert_guard','pc_multiunit_movement_inert_guard') ORDER BY 1;
SELECT conname, convalidated FROM pg_constraint WHERE conname IN ('pc_multiunit_exact_conservation','pc_multiunit_lot_once','pc_multiunit_decision_once','partner_credit_multiunit_movements_idempotency_key_key') ORDER BY 1;

-- 3. existing data that could violate the new keys (expect 0 everywhere; the tables are write-denied, so they should be empty)
SELECT (SELECT count(*) FROM partner_credit_reservations) AS reservations, (SELECT count(*) FROM billing_partner_credit_applications) AS applications;
SELECT count(*) FROM partner_credit_reservations r LEFT JOIN partner_credit_award_decisions d ON d.id=r.decision_id AND d.business_id=r.business_id WHERE d.id IS NULL;
SELECT count(*) FROM partner_credit_reservations r LEFT JOIN partner_credit_accounts a ON a.id=r.account_id AND a.business_id=r.business_id WHERE a.id IS NULL;
SELECT count(*) FROM partner_credit_reservations r LEFT JOIN partner_credit_lots l ON l.id=r.lot_id AND l.decision_id=r.decision_id AND l.account_id=r.account_id WHERE l.id IS NULL;
SELECT count(*) FROM billing_partner_credit_applications p LEFT JOIN partner_credit_reservations r ON r.id=p.reservation_id AND r.business_id=p.business_id WHERE r.id IS NULL;
SELECT count(*) FROM billing_partner_credit_applications p LEFT JOIN business_subscriptions s ON s.id=p.subscription_id AND s.business_id=p.business_id WHERE s.id IS NULL;

-- 4. sizes (lock duration scales with these; all four are small tables)
SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE relname IN ('business_subscriptions','partner_credit_accounts','partner_credit_award_decisions','partner_credit_lots');
```

Locks and operations: `ADD CONSTRAINT UNIQUE` builds an index and takes a brief `ACCESS EXCLUSIVE` lock on `business_subscriptions`, `partner_credit_accounts`, `partner_credit_award_decisions`, `partner_credit_lots`, `partner_credit_reservations`; the foreign keys take `SHARE ROW EXCLUSIVE` on the referenced and referencing tables. With the table sizes above this should be sub-second, but `business_subscriptions` is read by live billing traffic: apply in a quiet window and watch for lock waits. Drizzle runs all pending migrations in one transaction, so a failure rolls back all of them together.

Backup and response: create a restore point first (a Neon branch or snapshot of production) and record its id. 0047 is forward-only; if it must be undone the owner-run recovery is to drop the ten added constraints by name (FKs before uniques). That recovery never touches a guard. **OWNER TO CONFIRM** the backup exists and who may restore.

After applying, `db:verify:production` (already a workflow step) confirms every journal entry is applied; also re-run query 2 above. Never disable a guard to apply 0047; it does not need to.

**NOT DONE:** none of the queries above were run; `migrate-production.yml` was not dispatched.

## 3. Neon clean-replay certification checklist

Each of A, B, C needs your separate authorization; I performed none of them.

- **A. Database.** New isolated Neon branch for the audit (not derived from production or staging data; never the Split 07 certification database). Empty database `echogrid_heta01_f1_cert_<suffix>` on the **direct** endpoint (no `-pooler`, host ends `.neon.tech`). A dedicated role for this database only. It must be completely empty: no tables, no extra schemas, no extension other than `plpgsql`.
- **B. Credential.** URL `postgresql://<role>:<password>@<direct-host>/<database>?sslmode=require` — `sslmode` is the only allowed query parameter, exactly once. Store as repository secret `HETA_F1_CERT_DATABASE_URL`, preferably in a dedicated protected environment. Never paste it in chat or logs.
- **C. Dispatch.** Actions → *HETA-01-F1 clean-database certification* with `expected_commit` = the full current `main` tip, `confirmation` = `HETA_F1_CERTIFY_CLEAN_DATABASE_ONLY`, the exact direct host, and the exact database name.

Expected on a pass: 48 migrations applied and equal to the journal (derived, not hard-coded), 5 guards enabled, 4 constraints validated, 6 evidence tables matching the contract, the evidence-schema, isolation and lock steps passing, no credential in the logs. A pass certifies a **clean replay only** — not live production, RLS/role effectiveness, tenant isolation or Stripe completeness. The workflow has never been dispatched on Neon; the F4 baseline rule fails closed, so a Neon database with extra extensions would be refused (visible only on the real run).
