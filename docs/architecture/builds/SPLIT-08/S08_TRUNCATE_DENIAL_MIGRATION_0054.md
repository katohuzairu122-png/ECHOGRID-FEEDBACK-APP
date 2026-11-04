# Split 07/08 — TRUNCATE denial for the frozen financial evidence tables (migration 0054)

**Status: IMPLEMENTED for development only. ADDITIVE. NOT ACTIVATED. NOT DEPLOYED.** No row, column, constraint, or existing trigger is changed; migration 0054 has not been run against production or any shared database.

## The gap
The 0041/0042/0043/0047/0048 write guards are `FOR EACH ROW` triggers on `INSERT`/`UPDATE`/`DELETE`. PostgreSQL does not fire row-level triggers for `TRUNCATE`, so `TRUNCATE` (including `TRUNCATE businesses CASCADE`) could erase these tables, the Partner Credit ledger among them, past every guard. A catalog query on a freshly migrated database (guarded tables with no `BEFORE TRUNCATE` trigger) found **twelve** Split 07/08 financial tables. The earlier figure of nine (and my D4 report's ten) undercounted: `stripe_subscription_tier_observations` (0043) is an append-only Split 07 Stripe observation table, and `partner_credit_policies` is the frozen Split 07 policy table (published economics immutable, found by independent review), both included as the same class of frozen evidence. Two further tables have row triggers but are not financial evidence (`business_subscriptions`, `feedback`); they are deliberately left alone and named in the structural test.

| Table | Migration of its write guard |
|---|---|
| `partner_credit_accounts`, `partner_credit_award_decisions`, `partner_credit_lots`, `partner_credit_ledger`, `partner_credit_recovery_obligations`, `partner_credit_reservations`, `billing_partner_credit_applications` | 0041/0042 |
| `partner_credit_multiunit_lot_allocations`, `partner_credit_multiunit_movements` | 0047 |
| `benefit_application_intents` | 0048 |
| `partner_credit_policies` | Split 07 policy economics lock |
| `stripe_subscription_tier_observations` | 0043 |

The other append-only evidence tables (0045, 0048, 0049, 0050, 0051, 0052) already had a `BEFORE TRUNCATE` trigger, but seventeen of them as `ENABLE ORIGIN` triggers (see below).

## What 0054 does
One function `public.financial_evidence_deny_truncate()` (fixed `search_path = pg_catalog`, `EXECUTE` revoked from `PUBLIC`) raising `FINANCIAL_EVIDENCE_TRUNCATE_DENIED (<table>)`, and one `BEFORE TRUNCATE ... FOR EACH STATEMENT` trigger per table named `<table>_no_truncate`.
- **Unconditional.** No disposable-database exception: nothing legitimate truncates these tables, and disposable databases are dropped, not truncated.
- **`ENABLE ALWAYS`.** The trigger also fires when a session sets `session_replication_role = replica` (a normal `ENABLE ORIGIN` trigger is skipped there), and so also blocks a replicated `TRUNCATE`.
- **Earlier truncate-only triggers made `ENABLE ALWAYS` too.** The seventeen truncate-only triggers of 0045, 0048, 0049, 0050 and 0051 were `ENABLE ORIGIN` and so skipped under `session_replication_role = replica` (independent review: TRUNCATE succeeded there on `benefit_provider_observations`, `partner_credit_dispute_events`, `heta_record_revisions` and others). 0054 only changes their enablement; their definitions and the frozen migrations are untouched. The 0052 statement triggers (`s08_allocation_*_deny`, which also guard INSERT/UPDATE/DELETE) are deliberately **not** changed: the disposable fixtures forge allocation rows on a replica-role connection, so making them `ENABLE ALWAYS` would break them. A replica-role `TRUNCATE` of the two 0052 allocation tables therefore still succeeds; that needs the fixture approach reworked first (follow-up).
- **Atomic.** A `TRUNCATE ... CASCADE` that reaches any of these tables fails as a whole and removes nothing from any table.
- **No adoption.** Plain `CREATE FUNCTION`/`CREATE TRIGGER`: a database that already has these objects fails the migration, which runs in one transaction, and nothing is left behind.

## Evidence (disposable PostgreSQL only)
`apps/api/test/integration/financial-truncate-denial.integration.test.ts` (47 tests): every protected and every earlier truncate-only trigger is statement-level and `ENABLE ALWAYS`; a structural guard that every table with a row-level write guard has a `BEFORE TRUNCATE` trigger except the two named non-evidence tables (a future guarded table cannot regress the gap); **per table (twelve new, seventeen earlier), with every other table's truncate trigger disabled, the table's own trigger denies `TRUNCATE ... CASCADE` in a normal and a replica-role session** (so a trigger wired to a no-op on any one table is caught); plain, `CASCADE`, `RESTART IDENTITY` denial and a replica-role session; a `TRUNCATE businesses CASCADE` from a normal and a replica-role session fails and leaves `businesses` and `partner_credit_accounts` intact; the row-level ledger guard is unchanged; the function and each `CREATE TRIGGER` statement individually refuse to adopt a pre-existing object. Injected defects (a missing trigger, `ENABLE ALWAYS` dropped, a function that does not raise, a trigger on the wrong event, one parent table wired to a no-op, a legacy trigger left `ENABLE ORIGIN`) are each caught.

## What this does not do
- **A table owner or superuser can still `ALTER TABLE ... DISABLE TRIGGER`.** Restricting that is database-role hardening, a separate block. The existing guards have the same property.
- **The two 0052 allocation tables still allow a replica-role `TRUNCATE`** (see above); every other protected table denies it.
- PostgreSQL itself refuses a plain `TRUNCATE` of a table that foreign keys reference, whether or not a trigger exists; `CASCADE` is what reaches the triggers, so the tests assert denial on the `CASCADE` and replica-role forms.
- No activation, provider write path, release path, or production change. Financial activation remains NO-GO.
