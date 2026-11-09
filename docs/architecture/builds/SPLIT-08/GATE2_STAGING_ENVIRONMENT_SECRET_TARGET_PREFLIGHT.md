# Gate 2 — Staging GitHub Environment Protection and Connection Target Preflight

**2026-11-09. VERDICT: ENVIRONMENT PROTECTION BLOCKED.** No original staging migration, credential change, new Neon role, Cloudflare deployment or secret access performed in preparing this PR.

## Evidence from owner-supplied GitHub Settings screenshots

- GitHub environment `staging` contains a secret named `STAGING_DATABASE_URL`, last updated about two months earlier. Its encrypted value cannot be read from the screenshot.
- **Required reviewers unchecked**; **administrator bypass enabled**; deployment branches and tags set to **No restriction**. Wait timer unchecked. No screenshot proves review protection or branch restrictions are enforced.
- A secret's presence does **not** certify its database host, PostgreSQL user, branch, credentials or privileges.

## Neon source branch metadata independently inspected

- Staging Neon project `lucky-glitter-47218268`, default/primary branch `br-bold-water-aukjlvw3` (named `production` **within staging project**).
- Original staging PostgreSQL 18.6 `neondb`, 45 migration entries, all five original financial guard triggers enabled, snapshot `snap-still-queen-auxustvl` retained.
- Current source branch compute ID `ep-sparkling-hall-au6p04ch`; direct host `ep-sparkling-hall-au6p04ch.c-10.us-east-1.aws.neon.tech`, potential pooled host `ep-sparkling-hall-au6p04ch-pooler.c-10.us-east-1.aws.neon.tech`. Different isolated recovery branch compute `ep-steep-art-autpq92y`; it is **not allowlisted**.
- Host allowlisting plus exact journal proves much stronger consistency with the intended source branch, but **PostgreSQL itself does not attest a Neon branch ID**. Confirm in the Neon console independently before interpreting PASS as branch identity certification.

## Proposed manual, read-only proof — not executed in this draft PR

- `gate2-staging-secret-readonly-preflight.yml` permits only explicit `workflow_dispatch` on `main`, pinned `expected_commit`, exact `VERIFY_STAGING_TARGET` acknowledgement and `environment: staging`.
- Requires `STAGING_DATABASE_URL` as a GitHub environment secret **without printing it**, checks exact Neon endpoint hostname allowlist, port and database path, refuses arbitrary URL options, validates PostgreSQL 18 and uses `BEGIN READ ONLY`.
- Confirms exact current 45 Drizzle migration timestamps and SHA256 of all 45 repository SQL files, plus five enabled inert financial guards; returns PASS with **sanitized booleans/counts only**. No SQL INSERT/UPDATE/DELETE/DDL, and absolutely no `db:migrate` step. Unknown database driver errors are masked.
- This workflow must **not** be merged/run while the GitHub staging environment is unprotected. Its read-only SQL protects data from writes but **does not substitute for** proper secret access governance.
- Code is introduced as a **draft PR** for review. No dispatch or secret access is authorized by the PR itself.

## Owner-required GitHub configuration (UI)

1. In **Settings → Environments → staging**, enable **Required reviewers**, nominate a trusted reviewer able to approve your staging job, and ensure self-approval rules meet your account's available controls.
2. Uncheck **Allow administrators to bypass configured protection rules**, then save.
3. Under **Deployment branches and tags**, restrict to **Selected branches and tags** and permit **`main` only**, saving the restriction. Confirm the final UI state and effective enforcement.
4. If the repository plan or ownership does not support reviewer enforcement, do not pretend it works: use branch restriction plus separately enforced manual run and owner approval policy; independently verify the plan/feature gate before migration.
5. Independently check Neon source compute and Cloudflare Hyperdrive username/endpoint, without exposing any passwords.
6. After reviewing and merging this *read-only diagnostic only* under independent approval, manually dispatch it from `main` with exact main SHA and `VERIFY_STAGING_TARGET`. Report output. Do not dispatch the existing `migrate-staging.yml` yet.

## Remaining after PASS

The existing staging Worker may connect using `neondb_owner`, which has `BYPASSRLS`. Ordinary operational business tables do not have certified database tenant isolation. Neither this diagnostic nor the isolated 45→67 rehearsal approves a runtime cutover. A **separate owner decision** is necessary before actually migrating the source branch and before any application/runtime change.

**Current action: PREPARATION COMPLETE, LIVE PREFLIGHT NOT EXECUTED, ORIGINAL STAGING MIGRATION BLOCKED.**
