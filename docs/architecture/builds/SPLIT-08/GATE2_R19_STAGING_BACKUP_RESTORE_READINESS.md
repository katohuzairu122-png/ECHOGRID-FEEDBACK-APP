# ECHO GRID — Gate 2 R19 and Controlled Staging Backup/Restore Readiness

**Date:** 2026-11-09. **Mode:** development / read-only inventory and procedural preparation. **No live snapshot, restore, migration, production action, database permission change, or deployment authorized by this document.**

## Scope and authoritative baseline

- Repo main at R19 branch creation: `ff5e496685d1fb0ae244ce20d8f0e14bff1db7e6`; R14–R18 are independent unmerged draft PRs. R19 does not copy their files or assume they are approved.
- Staging project verified read-only: `echo-grid-staging`, ID `lucky-glitter-47218268`, region `aws-us-east-1`, PostgreSQL `18.6`.
- The project default branch is `br-bold-water-aukjlvw3`, with the misleading name `production`. It is **inside the staging project**. Do not confuse it with a separate production project.
- Database `neondb` has **45 committed migration entries of 67** and **zero public RLS-enabled tables**, confirmed by read-only SQL on 2026-11-09. Remaining entries are `0045`–`0066`, provided journal identity is unchanged on recheck.
- The default branch is currently **unprotected**, with `block_public_connections=false` and an empty configured IP allowlist. These settings are not proof of unauthenticated access but require independent environmental controls.
- Neon list_snapshots returned **none**; snapshot schedule for the default branch returned **empty**. Project history retention is 86,400 seconds. No verified restorable backup exists today.
- An archived branch `split07-concurrency-audit` exists, but cannot be assumed a current restore point. Do not repurpose, delete, or overwrite it.

## R19: proof and limitations

R19 adds a CI-only isolated PostgreSQL 18 nonce registry, unique key, atomic insert with `ON CONFLICT DO NOTHING`, and tests of 24 simultaneous attempts from a pooled set of independent clients. It also checks denial of cross-tenant replay, disallowed operation, expired/overlong assertions, durable row visibility and rollback/retry semantics.

**Caveat:** This does not verify real signatures, customer/actor session binding, nonce expiration cleanup, authorization atomicity with a business write, service identity, persistent production key custody or actual Hyperdrive pooling. It does not create production nonce tables or migration files. Passing CI remains a disposable feasibility result only.

## Actual staging snapshot / restoration preparation — HOLD POINTS

1. **Target attestation:** Confirm selected Neon project and exact staging branch, physical region, database, applied migration journal, current main SHA and owner. Confirm Cloudflare Hyperdrive points only to this environment; do not print, export or log database credentials.
2. **Data classification:** Review whether staging contains real business, user or customer data. A restored branch preserves data and may be subject to legal/privacy duties. No sensitive data may be copied into weaker environments, public CI, external storage or a different organization without documented safeguards.
3. **Protect environment:** Define who can snapshot, restore, branch, run migrations and change Hyperdrive secrets; protect the relevant staging environment and prevent accidental production targeting. Record that the branch is unprotected until reviewed. No change authorized here.
4. **Recovery objectives:** Owner must approve RPO/RTO targets, snapshot retention, audit and deletion expectations, maintenance window, costs and who can authorize rollback; the 24-hour Neon history retention is *not* itself a verified backup.
5. **Snapshot creation (future separately authorized action):** Record pre-snapshot project ID, exact branch ID, server version, migration count, table/RLS/guard trigger inventory and logical scope. Create a **named staging snapshot** from `br-bold-water-aukjlvw3` using Neon snapshot controls. Capture returned snapshot ID, creation timestamp, expiry, and evidence **without any secret values**. Do not create a snapshot in this development PR.
6. **Isolated restore (future separately authorized action):** Restore that snapshot to a **NEW, explicitly named branch** in the staging project, never overwriting the default branch. Use separate compute credentials, deny application routing and external webhook/provider effects. A restore branch may retain real customer data; enforce appropriate access controls and an approved retention plan.
7. **Restore validation:** Confirm source/target identifiers, PostgreSQL version, table count, key schema/policy inventory, journal 45/67, inert financial guard triggers, representative non-sensitive integrity counts and selective nonfinancial checks. Never assume source branch name `production` authorizes prod actions. Confirm the restore has a valid independently recoverable timestamp.
8. **Migration rehearsal (future separate approval):** On the isolated restored branch only, run the pinned 0045–0066 upgrade with a restricted migration identity, verify 67/67 entries, RLS/grants, critical triggers, cross-tenant denials, lock duration, failures and rollback rehearsal. All tests must be read-only or synthetic unless staging data handling is approved.
9. **Rollback acceptance:** Restore into a **new validation branch** or independently tested recovery target. Demonstrate reproducible rollback and document downtime, DNS/routing/connection steps, integration retries and no economic effect activation. Do not overwrite original until a separate approved recovery event.
10. **Owner decision gate:** Submit snapshot ID, successful isolated restore evidence, DB diff, test outcomes, recovery objectives, customer-data handling and security reviewer signoff. **Only after separate explicit owner approval** may the actual staging migration workflow be run at an exact reviewed main SHA. Never activate customer onboarding, settlement, Partner Credits or production Stripe effects automatically.

## Stop conditions

Stop if wrong project or branch; any actual production resource; backup unavailable; unresolved customer privacy; unexpected migration journal drift; missing guard trigger; database privilege escalation; untested recovery; or no approved staging maintenance and security plan.

**Current decision: LIVE STAGING BACKUP/RESTORE NOT EXECUTED. MIGRATION NOT AUTHORIZED.**
