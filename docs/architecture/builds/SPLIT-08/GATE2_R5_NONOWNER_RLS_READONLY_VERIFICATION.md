# Gate 2 R5 — Effective non-owner PostgreSQL 18 RLS boundary

**Development verification only. Not staging certification.**

The existing 0061 and 0062 migrations define tenant-scoped read roles and FORCE RLS for settlement and Stripe-read authorization data. Previous R2/R3/R4 verified the presence of policy metadata, synthetic migration and logical backup/restore. R5 checks actual execution under a disposable **LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE** principal, with membership only in the intended read roles.

The new PR-only workflow uses a fresh disposable PostgreSQL 18 service at a hardcoded local host, port, user and database. It replays 67 migrations, creates a temporary least-privilege login and tests SELECT grants on actual protected tables; INSERT, UPDATE and DELETE remain unavailable. It checks active RLS, FORCE RLS, expected tenant predicates referring to `echogrid.tenant_id`, and executes read queries under two transaction-local tenant contexts.

This **does not** prove row-level cross-tenant filtering against populated financial records because the procedure deliberately does not fabricate settlement authority or Stripe provider evidence. That would risk weakening the locked financial evidentiary system. Nor does this verify the real staging Hyperdrive login, staging data, effective memberships, nonfinancial tenant tables, platform customer journeys, backup policy, provider activation or a production deployment.

A green PR run can support the **disposable non-owner security subgate only**. Stage Gate 2 remains BLOCKED until the owner separately approves staging clone/data-handling tests, runtime credentials/RLS/tenant isolation certification and backup/recovery controls. Financial authority remains NOT_GRANTED. No automatic merge.
