# Migration Plan for 0067 and the BDPN Schema — and Correction of the "Backlog" Statements

**Status: DESIGN PROPOSAL AND CORRECTION — DOCUMENTATION ONLY. No migration is applied, authorized, dispatched or changed.
Nothing here authorizes a database operation, a deployment, a merge or any production change.**

- Baseline: `origin/main` @ `b2f85ac097e5c3b945dc586df046513494525705`
- Purpose: (1) correct a factual error about migration state that appears in earlier BDPN documents and in earlier reports
  from this session; (2) give the written plan that decision D-19 requires before any migration is applied.
- Evidence rule: repository documents are quoted as **recorded evidence with a date**, not as live verification. **No live database
  was queried by this block.** Anything that needs a live check is listed in section 3 as a task for an authorized operator.

## 1. Correction (read this first)

### 1.1 What was said, and what the repository record actually shows

| Earlier statement (my documents and reports)                                                  | What the repository record shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Staging is at 45 migrations; 23 are pending (45 to 68)" and "apply the 23-migration backlog" | The 45 came from a **historical test fixture** in `staging-migration-preflight.test.ts` (`appliedCount: 45`), which "reproduces independently observed staging drift". A later record, `GATE2_POSTMIGRATION_PRODUCTION_STAGING_ACCEPTANCE_2026_11_09.md` (commit `52b990c`, 2026-11-09), states that **both the production and the staging Neon databases "now report 67 Drizzle journal entries with unique timestamps"** and that "the production migration preserved 66 businesses, 20 branches, 69 users and 232 refresh-token rows". Verdict recorded there: "SCHEMA MIGRATION PASS; RUNTIME/FINANCIAL RELEASE NOT CERTIFIED" |
| "Migration 0067 is the 23rd of 23 pending"                                                    | On that record, **`0045` to `0066` were already applied** to both databases on or before 2026-11-09. The only migration the repository holds beyond that record is **`0067_customer_preferred_locale`** (merged today by #355)                                                                                                                                                                                                                                                                                                                                                                                                     |
| "The backlog needs a large, careful plan"                                                     | The "backlog" is **one small additive migration**, `0067`, **unless** a live check (section 3) shows otherwise                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 1.2 What is still true

- `0067` is merged into main. **I have not applied it anywhere**, and no migration workflow has been run by me. Whether the
  owner or another operator applied it since is **UNKNOWN** from the repository alone.
- The release deployed today (Web run #5) does not need `0067`: the language selector falls back to a cookie, and the saved-language
  API is not part of a Web-only release.
- Gate 2 still pins the journal at 68 entries ending in `0067`.

### 1.3 Where the wrong statement appears (errata added in this PR)

`BDPN_01_BUSINESS_PROFILE_DISCOVERY_SPEC.md` (sections 0 and 8), `BDPN_01_IMPLEMENTATION_SEQUENCE.md` (section 3),
`BDPN_01A_DATA_CONTRACTS_AND_SCHEMA_PROPOSAL.md` (section 8), `BDPN_01_OWNER_DECISION_RECORD.md` (D-19 and its notes, N-2), and
`BDPN_01C_DISCOVERY_API_DESIGN.md` (open PR #365, which does not state the count but says 0067 is "not applied anywhere"; it is
reworded here as "not applied by me, live state unverified"). Each now carries a short erratum pointing here.

### 1.4 Effect on decision D-19

D-19 ("apply the existing backlog first, then ship BDPN as one new migration") **stands**, but its content changes: the
"existing backlog" is `0067` (plus verifying that the earlier 22 are in fact applied). That makes the sequence much simpler:
`0067` first, then one BDPN migration. No owner re-decision is needed; this record makes the substance clear.

### 1.5 A second thing the record shows (a risk to keep in view)

The same acceptance record states the inspected database login is `neondb_owner` with `rolbypassrls = true`, that application
tenant isolation is enforced **in application middleware, not by a certified limited database login**, and that the
runtime release is "NOT CERTIFIED". This does not block `0067` (an additive column), but it shapes the BDPN design (see 01E):
database privilege separation cannot be relied on until the Gate 2 runtime-role work is done, so BDPN's safeguards rest on
checks, composite keys and triggers, which fire for the owner role too.

## 2. What `0067` does (read from the merged file)

`ALTER TABLE "customers" ADD COLUMN "preferred_locale" text;` and
`ALTER TABLE "customers" ADD CONSTRAINT "customers_preferred_locale_check" CHECK (preferred_locale IS NULL OR preferred_locale IN ('en','es','fr','ar'));`

- Additive. Nullable, no default, no backfill. Existing rows become `NULL` ("no saved language").
- Adding a nullable column without a default is a metadata-only change. **Adding the `CHECK` validates every existing
  `customers` row** and holds a lock on the table while it does. The table is small in the recorded evidence, so this is brief,
  but the actual row count must be confirmed (section 3) before a production window.
- No data in any other domain changes. No financial, billing, loyalty, Community Points or Stripe table is touched.

## 3. Live checks to be done by an authorized operator before any apply (none done here)

| #   | Check                                                                                                                                                                                                                                                                  | Why                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | Confirm the exact Neon project and branch for staging and for production (identifiers in the 2026-11-09 record: staging branch `br-bold-water-aukjlvw3`, which is **named `production` but lives in the staging project**; production project `divine-voice-54333763`) | The record itself warns the staging default branch carries the misleading name "production"       |
| 2   | Read-only: read `drizzle.__drizzle_migrations`; confirm 67 entries and last migration `0066`, or whether `0067` is already there                                                                                                                                       | Decides whether anything is pending                                                               |
| 3   | Read-only: `SELECT count(*) FROM customers`                                                                                                                                                                                                                            | Sizes the `CHECK` validation lock                                                                 |
| 4   | Confirm a restorable backup path (snapshot or point-in-time) and its retention, and who may restore                                                                                                                                                                    | The R19 record (2026-11-09) found **no snapshots and 24 hours of history**; that may have changed |
| 5   | Confirm the environment protection and required reviewers on `staging` and `production` GitHub environments                                                                                                                                                            | The migration workflows rely on them                                                              |
| 6   | Confirm which database role the migration workflow uses and that Hyperdrive points at the intended database                                                                                                                                                            | Avoids a wrong-target run                                                                         |

## 4. Procedure for `0067` (proposal; every step is a separate owner authorization)

The repository already has guarded workflows; nothing new is proposed. Both are manual, require the exact main commit SHA and a typed phrase,
run in a protected GitHub environment, and serialize through a concurrency group.

| Step | Action                                               | Workflow and guard                                                                                                                                                                                                                                                           |
| ---- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | **Staging apply** of `0067`                          | `migrate-staging.yml`: inputs `expected_commit` (full SHA of main) and `confirmation = MIGRATE_STAGING`; runs `db:check` (repository chain), `db:migrate`, then `db:verify:production`, which compares **every journal entry's SQL hash and timestamp** against the database |
| S2   | **Staging verification**                             | The script's pass is the schema proof. Then application smoke on staging: `PUT` then `GET /api/v1/customer-language` for a test customer; confirm `customers` still loads; confirm no change in other tables' row counts                                                     |
| S3   | **Deploy the API to staging** so the endpoint exists | `deploy-staging.yml` (a separate authorization; the production release workflow states that migrations are never run by it)                                                                                                                                                  |
| S4   | **Production apply** of `0067`                       | `migrate-production.yml`: `expected_commit`, `confirmation = MIGRATE_PRODUCTION`, `production` environment approval                                                                                                                                                          |
| S5   | **Production verification**                          | `db:verify:production` pass; the same smoke test with a test customer; no other table changed                                                                                                                                                                                |
| S6   | **Production API deploy**                            | `deploy-production.yml` (full release: API and web, with its own checks and approvals). Web is already live and tolerates the endpoint being absent                                                                                                                          |

Ordering rule: **migration before the API that uses it**, and the Web release never depends on it. If the API were deployed before the
migration, the endpoint would fail on the missing column, so S3 follows S1 and S6 follows S4.

Main-must-not-move rule: each workflow pins an exact main commit; merging anything between the dispatch and the approval makes
the pinned check fail (this is what failed run #4). Plan each step as dispatch, approve, finish, then merge.

## 5. Rollback

| Situation                                            | Action                                                                                                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0067` applied, no customer has saved a language yet | Safe to reverse by dropping the constraint and the column in a reviewed forward fix. There is no data to lose                                             |
| `0067` applied and languages were saved              | Prefer to **stop using** the column and keep it (it is harmless and nullable); a forward fix is safer than removing data                                  |
| Migration run fails midway                           | Drizzle records applied migrations; re-running after the cause is fixed is the normal path. Do not edit an applied migration file                         |
| Catastrophic                                         | Restore from the confirmed backup path into a **new** branch, validate, then decide. This depends on check 4 in section 3, which is **not yet confirmed** |

## 6. Sequencing with the BDPN migration (D-19)

1. Apply `0067` through S1 to S6 and verify it.
2. Only then open the BDPN implementation block (separately authorized). Its single migration (proposed name in 01A, number 68 on this baseline)
   goes through the **same** S1 to S6 sequence.
3. Because the Gate 2 scripts, workflows and release tests hard-pin the journal, the BDPN migration PR must **re-pin 68 to 69 in the same PR**
   (22 files match a broad search; regenerate the list at that time).
4. No BDPN table is created, and no BDPN feature is switched on, before step 1 is verified in the target environment.

## 7. Owner authorizations required (none requested here)

- A read-only live inspection of the staging and production migration state (section 3, checks 1 to 4), or confirmation that the owner will do it.
- Each of S1 to S6, one at a time, per environment.
- Confirmation of the backup and recovery objectives (RPO and RTO) before production.

## 8. Risks and open items

- **State not verified live.** Everything about "what is applied" comes from the 2026-11-09 record. It is the best repository evidence and is
  probably correct for `0045` to `0066`, but the real state must be read before acting.
- The runtime database login recorded as the owner role with row-level-security bypass is a pre-existing Gate 2 finding and is not changed by `0067`.
- The staging default branch is named `production` inside the staging project. Wrong-target risk: check 1 exists for this reason.
- Whether `0067` was already applied by someone since 2026-11-09 is unknown.
