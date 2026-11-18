# BDPN-F1 — Business profile storage foundation (implementation record)

**Status: IMPLEMENTED — VALIDATION PENDING (draft PR). Development only. Nothing reads or writes these tables yet. No migration has been executed against any shared environment, nothing is deployed, and no feature is activated.**

- Baseline: `origin/main` @ `4fd02f87048997874b4d5edd7e6d04cc66560d4d` (journal 80, last `0079`). This block adds migration `0080_business_public_profiles` (journal 81).
- Implements: `BDPN_01A_DATA_CONTRACTS_AND_SCHEMA_PROPOSAL.md` sections 2 to 5 (entities, columns, guards, indexes). It is "G1A part 1" in `BDPN_PREREQUISITE_MATRIX_2026-11-16.md`.

## 1. Owner ruling recorded

**OD-24 approved by the owner on 2026-11-18: BDPN ships as independently versioned, per-block migrations** (not one single BDPN migration). This supersedes the single-migration wording of D-19 for BDPN. D-19's other requirement is unchanged: no environment step is executed without separate authorization. This is consistent with Split 09 ruling S9-D12 (per-block migrations, subject to the final BDPN migration ruling, which this now is).

Still open and **not** decided or modelled here: OD-1 / D-24 (plan-gated vs universal discovery; the model stores no entitlement), OD-14 (entitlement specification), D-16 (content policy approval and two named reviewers).

## 2. What this block contains

| Item | Detail |
| --- | --- |
| Schema | `apps/api/src/db/schema/business-profiles.ts`: `business_category_translations`, `business_profile_revisions`, `business_public_profiles`, `business_profile_revision_translations`, `business_profile_revision_locations` |
| Migration | `apps/api/drizzle/0080_business_public_profiles.sql` (generated tables, constraints and indexes, plus hand-written guard functions and triggers) with its snapshot and journal entry |
| Database guards | Publication state machine, revision immutability and legal status transitions, draft-only translations and locations, submission readiness (D-04), database-enforced submitter != reviewer, TRUNCATE denial on every guarded table, all triggers `ENABLE ALWAYS` |
| Tests | `apps/api/test/integration/business-profiles.integration.test.ts` (22 cases, real Postgres, direct SQL session) |

## 3. Deliberately not in this block (each needs its own authorization)

Profile permissions (`profile:edit`, `profile:submit`, the code-owned moderation permission), the handle generator, the canonical content digest function, the content validators, any service, route, discovery read model or UI, the category-translation seed (wording needs owner approval, N-4), the eligibility view, the plan-entitlement term, notifications, and any change to an existing table. No row is created for any existing business; registration creates nothing (ruling R3).

## 4. Differences from the BDPN-01A proposal (all tightenings; nothing loosened)

1. **Unique constraint, not a unique index,** on `business_profile_revisions (id, business_id)`. The composite tenant foreign keys need a constraint that exists when the keys are created (the repository's existing pattern); drizzle creates indexes after foreign keys.
2. **Submission evidence is a pair:** a non-draft revision must have both `submitted_by` and `submitted_at`; a draft has neither.
3. **Review evidence is exact:** `reviewed_by` and `reviewed_at` are present if and only if the status is `approved`, `rejected` or `superseded`; a reason code is present if and only if `rejected`.
4. **Suspension fields are exact:** present if and only if the profile is `suspended`, and cleared on any other state (BDPN-01A 4.1 "cleared").
5. **A published profile needs `published_at`.**
6. **Every transition (state change or pointer move) must increment `version` by exactly one**, enforced in the database.
7. **The live pointer moves only forward** while published, to a newer approved revision of the same business.
8. **Decided review evidence is immutable** once approved, rejected or superseded; `rejected` and `superseded` rows are final.

## 5. Consequences the owner should know

- **These tables can never be hard-deleted or truncated, and businesses have a `RESTRICT` foreign key to them.** Once a business has a profile row, that business can no longer be hard-deleted. This is the intended design (BDPN-01A 4.5: soft-delete, profile history is audit evidence). It means a future **test-data reset** (like the 2026-11-17 reset) cannot remove businesses that have profile rows; the supported path is soft-delete, or a separately authorized and documented reset procedure. No guard has been or will be disabled to make a reset easier.
- The migration adds five tables and changes no existing table. Rollback is additive: stop reading, then drop in reverse order (only valid before any row exists, because the guards deny deletes by design).
- Gate 2 scripts that enumerate all public tables at run time will pick the five new tables up automatically. **Runtime-role privilege and tenant-isolation behaviour for them must be proven on disposable PostgreSQL 18 in CI** (the Gate 2 workflows); a static review cannot prove it. This record does not certify that.

## 6. Verification evidence

- Local PostgreSQL 16: migration applies cleanly (journal 81); `db:check` reports no drift.
- Integration test: 22 of 22 pass, and pass again on a second run against the same database.
- API typecheck passes; the new files lint clean; the API unit suite passes (229 files, 3,642 tests), including the migration-governance tests once the migration is committed.
- Full local integration suite: the new file passes; other files fail in this sandbox for reasons unrelated to this change (duplicate fixtures from re-running on a used database, and Stripe keyring file-permission checks). Hosted CI on a fresh database is authoritative.
- Not run: PostgreSQL 18 Gate 2 workflows (they run in hosted CI).

## 7. Next independent blocks (not started)

BDPN-01B (validation, canonical digest, handle generation, permissions and the moderation authority), then the read model (BDPN-01C), each with its own migration if it needs one. Split 09 S9-A depends on this block and on 01B.
