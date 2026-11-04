# Split 07/08 — TRUNCATE denial for the frozen financial evidence tables (migration 0054)

**Status: IMPLEMENTED for development only. ADDITIVE. NOT ACTIVATED. NOT DEPLOYED.** No row, column, constraint, or existing trigger is changed; migration 0054 has not been run against production or any shared database.

## The gap
The 0041/0042/0043/0047/0048 write guards are `FOR EACH ROW` triggers on `INSERT`/`UPDATE`/`DELETE`. PostgreSQL does not fire row-level triggers for `TRUNCATE`, so `TRUNCATE` (including `TRUNCATE businesses CASCADE`) could erase these tables, the Partner Credit ledger among them, past every guard. A catalog query on a freshly migrated database (guarded tables with no `BEFORE TRUNCATE` trigger) found **eleven** tables. The earlier figure of nine (and my D4 report's ten) undercounted: the eleventh is `stripe_subscription_tier_observations` (0043), an append-only Split 07 Stripe observation table, included because it is the same class of frozen evidence.

| Table | Migration of its write guard |
|---|---|
| `partner_credit_accounts`, `partner_credit_award_decisions`, `partner_credit_lots`, `partner_credit_ledger`, `partner_credit_recovery_obligations`, `partner_credit_reservations`, `billing_partner_credit_applications` | 0041/0042 |
| `partner_credit_multiunit_lot_allocations`, `partner_credit_multiunit_movements` | 0047 |
| `benefit_application_intents` | 0048 |
| `stripe_subscription_tier_observations` | 0043 |

Every other append-only evidence table (0045, 0048, 0049, 0050, 0051, 0052) already had a `BEFORE TRUNCATE` trigger.

## What 0054 does
One function `public.financial_evidence_deny_truncate()` (fixed `search_path = pg_catalog`, `EXECUTE` revoked from `PUBLIC`) raising `FINANCIAL_EVIDENCE_TRUNCATE_DENIED (<table>)`, and one `BEFORE TRUNCATE ... FOR EACH STATEMENT` trigger per table named `<table>_no_truncate`.
- **Unconditional.** No disposable-database exception: nothing legitimate truncates these tables, and disposable databases are dropped, not truncated.
- **`ENABLE ALWAYS`.** The trigger also fires when a session sets `session_replication_role = replica` (a normal `ENABLE ORIGIN` trigger is skipped there), and so also blocks a replicated `TRUNCATE`.
- **Atomic.** A `TRUNCATE ... CASCADE` that reaches any of these tables fails as a whole and removes nothing from any table.
- **No adoption.** Plain `CREATE FUNCTION`/`CREATE TRIGGER`: a database that already has these objects fails the migration, which runs in one transaction, and nothing is left behind.

## Evidence (disposable PostgreSQL only)
`apps/api/test/integration/financial-truncate-denial.integration.test.ts` (17 tests): every protected table has the trigger, statement-level and `ENABLE ALWAYS`; a structural guard that no table with an immutability/inert write guard may lack a `BEFORE TRUNCATE` trigger (a future table cannot regress the gap); per table, plain, `CASCADE` and `RESTART IDENTITY CASCADE` denial and a replica-role session; the new trigger fires for tables nothing references; a `TRUNCATE businesses CASCADE` from a normal and a replica-role session fails and leaves `businesses` and `partner_credit_accounts` intact; the row-level ledger guard is unchanged; the migration refuses to adopt pre-existing objects. Four injected defects (a missing trigger, `ENABLE ALWAYS` dropped, a function that does not raise, a trigger on the wrong event) are each caught.

## What this does not do
- **A table owner or superuser can still `ALTER TABLE ... DISABLE TRIGGER`.** Restricting that is database-role hardening, a separate block. The existing guards have the same property.
- **The older `*_no_truncate` triggers (0045, 0048, 0049, 0050, 0051) are `ENABLE ORIGIN`** and so do not fire under `session_replication_role = replica`; 0052's statement triggers are the same. They were not changed here (frozen migrations); making them `ENABLE ALWAYS` is a recommended follow-up.
- PostgreSQL itself refuses a plain `TRUNCATE` of a table that foreign keys reference, whether or not a trigger exists; `CASCADE` is what reaches the triggers, so the tests assert denial on the `CASCADE` and replica-role forms.
- No activation, provider write path, release path, or production change. Financial activation remains NO-GO.
