# BDPN-01E — Security, Migration and Release Plan

**Status: PLAN — DOCUMENTATION ONLY. No migration is created or applied, no workflow is changed or dispatched, no flag is set, no deployment is made.
Nothing here authorizes implementation, a migration, a merge or a release.**

- Baseline: `origin/main` @ `b2f85ac097e5c3b945dc586df046513494525705`
- Companions: `BDPN_MIGRATION_PLAN_AND_STATE_CORRECTION.md` (backlog 0067, rollout procedure S1–S6), 01A (schema), 01B (validation, moderation), 01C (API), 01D (UI).
- Where an input is still a draft (01C, open PR #365), names are the proposed ones.

## 1. Scope and rule of this plan

This plan fixes the **order, gates, evidence, activation and rollback** for the whole discovery feature, so no later block has to invent them. It adds no new product behavior.

Rule: **no BDPN implementation block begins before** (a) the migration backlog (0067) is reconciled with every environment (D-19), (b) the owner has answered the open questions in 01A, 01B, 01C and 01D that affect that block, and (c) the owner has explicitly authorized that block.

## 2. Threat-to-test matrix

Each threat has a control and a test that must exist before activation. "Layer" is where the control lives.

| ID   | Threat                                                                         | Control                                                                                                                     | Layer     | Required test                                                                                                         |
| ---- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| T-01 | An unpublished, suspended, withdrawn or disabled business appears in discovery | Eligibility predicate evaluated in the query itself, never cached                                                           | API / DB  | Integration: every excluded state gives no list entry and the same 404 on detail                                      |
| T-02 | Existence leak by status (404 vs 403, timing)                                  | One uniform not-found for every non-visible cause; DTO closed                                                               | API       | Contract test comparing bodies and status for all causes                                                              |
| T-03 | Cross-tenant write or read of another business's profile                       | Composite tenant foreign keys, tenant context on every staff route                                                          | API / DB  | Cross-tenant attempts fail; DB rejects a mismatched tenant row                                                        |
| T-04 | Self-approval of a revision                                                    | Reviewer must differ from submitter (CHECK plus service)                                                                    | DB / API  | A same-actor approval is rejected at both layers                                                                      |
| T-05 | Illegal state transition (for example approved to draft)                       | State-machine trigger plus service transition table                                                                         | DB / API  | Every illegal pair rejected; legal pairs pass                                                                         |
| T-06 | Editing an approved or superseded revision                                     | Immutability trigger                                                                                                        | DB        | Update and delete of frozen rows fail, including from a direct SQL session                                            |
| T-07 | Edit bypass: live profile changed without review                               | Every edit creates a new revision (D-14); live pointer moves only through the service                                       | API / DB  | A direct pointer change without an approved revision is rejected                                                      |
| T-08 | Stored script or markup in profile text                                        | Plain-text policy, rejected character classes (01B), output escaping (01D)                                                  | API / UI  | Fixtures with HTML, script, control, bidi and zero-width characters are rejected or rendered inert                    |
| T-09 | Unsafe website link (javascript, data, credentials in URL)                     | https-only validation at write; scheme re-check at render; `nofollow noopener noreferrer`                                   | API / UI  | A table of hostile URLs rejected; non-https shown as text                                                             |
| T-10 | Enumeration of businesses by id                                                | Opaque 22-character handle, no internal id exposed (D-10)                                                                   | API       | No response field equals an internal id; handles are not sequential                                                   |
| T-11 | Scraping of the directory                                                      | Signed-in only (D-09), dedicated limiter, page size cap, no total count                                                     | API       | Anonymous request gets 401; limiter returns 429 past the quota                                                        |
| T-12 | One customer exhausting a shared limiter, or one bucket for everyone           | Limiter keyed on the customer, not on the client address                                                                    | API       | Two customers do not share a bucket; verified against a Worker-to-Worker call path (open item O-E1)                   |
| T-13 | Caching exposes stale or private data                                          | `no-store` on every response (D-12); no CDN rule; service worker bypass                                                     | API / web | Header assertion; browser check that a profile withdrawn is gone on the next request                                  |
| T-14 | Tracking of customer browsing                                                  | No view counters, no analytics events, no per-customer logging of handles (D-17)                                            | API / web | Row counts of every customer-linked table unchanged after a browse session; network capture shows only the read calls |
| T-15 | Impersonated session approves or edits                                         | Impersonation denied on profile submit and moderate (precedent: partner consent denial)                                     | API       | Impersonated calls are rejected with the same error class                                                             |
| T-16 | Moderator over-reach into data beyond the review bundle                        | Bundle limits in 01B (D-22), code-owned permission, audit of each access                                                    | API       | A moderator cannot read fields outside the bundle; every access writes an audit row                                   |
| T-17 | Idempotency failure creating duplicate revisions on retry                      | Idempotency key (8–200 characters) with a unique constraint                                                                 | API / DB  | The same key replays the stored result and creates no second row                                                      |
| T-18 | Concurrent edits lose an update                                                | `expectedVersion` with row locking                                                                                          | API / DB  | Two concurrent saves: one succeeds, one gets a conflict                                                               |
| T-19 | Digest mismatch: approved content differs from submitted content               | SHA-256 of canonical NFC JSON stored at submit and recomputed at approve                                                    | API       | The 01B test vector reproduces; a tampered row fails approval                                                         |
| T-20 | Discovery switched on before it is safe                                        | `DISCOVERY_ENABLED` defaults to false, per environment (D-20)                                                               | Config    | With the flag off, every discovery route answers as not enabled                                                       |
| T-21 | A failure shown as an empty directory                                          | Distinct unavailable, empty and no-match states                                                                             | UI        | Section-state tests in 01D                                                                                            |
| T-22 | Moderation reason text abused or leaked to other tenants                       | Reason codes are a code-owned list (D-16 pending); free text bounded and visible only to the owning business and moderators | API       | A cross-tenant read of a rejection reason fails                                                                       |

## 3. Database privilege stance (do not over-claim)

- The runtime database login is recorded as `neondb_owner` with `BYPASSRLS` (acceptance record). **Row-level security would not constrain it**, so no discovery control relies on RLS or on role separation.
- Controls that **do** hold under that login: CHECK constraints, unique and partial unique indexes, composite foreign keys and triggers (state machine, immutability, reviewer ≠ submitter). Triggers and constraints fire for every role.
- Consequently this feature uses the ordinary-tenant-table pattern (application scoping plus composite foreign keys), **not** the forced-RLS financial pattern of 0061–0066.
- The runtime login is **not certified** by this plan. Introducing a least-privilege runtime role is a separate decision (O-E2).

## 4. Migration plan (one migration, after the backlog)

| Step | Content                                                                                                                                                                      | Gate                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| M0   | Reconcile backlog: confirm live migration state of each environment, then apply 0067 per `BDPN_MIGRATION_PLAN_AND_STATE_CORRECTION.md` (S1–S6)                               | Owner authorization per environment; read-only live check first             |
| M1   | Author one migration (next free number after 0067) creating the five tables of 01A with their constraints, indexes and triggers. Additive only: no change to existing tables | Owner approves 01A open questions O-1..O-6 and amendment A-1 first          |
| M2   | Update Gate 2 pins (journal length and last tag) and the release tests that hard-pin them, in the same change                                                                | Existing tests must stay green; job names unchanged                         |
| M3   | Apply to staging with the staging migration workflow, then verify                                                                                                            | Owner authorization; evidence in section 7                                  |
| M4   | Apply to production with the production migration workflow                                                                                                                   | Separate owner authorization; backup and rollback readiness confirmed first |

Rules: the migration has no data backfill and creates no rows; it is empty on arrival. It is additive and is applied **before** any code that reads it, and the code is deployed **dark** (flag off).

## 5. Release and activation sequence

1. Backlog reconciled (M0).
2. 01A migration authored and verified in CI (M1, M2). **Merge is an owner action.**
3. Applied to staging (M3), then to production (M4) with separate authorization each.
4. Implementation blocks merge in the order 01B (service), 01C (API), 01D (UI), each its own authorized block, each deployed with the flag **off**.
5. Staging activation: flag on in staging only, internal accounts only (D-20); run the section 7 evidence.
6. Owner approves the interim content policy (D-16) and the reason-code list before any business can submit.
7. Production activation is a **separate, explicit owner decision**: flag on in production, first for internal use, then wider. The flag is an environment setting, not a code change.
8. Web-only release workflow is used for UI-only changes; the full release for API changes. Neither runs migrations. No merge to main between dispatch and approval (run #4 lesson).

## 6. Rollback

| Layer            | Rollback                                                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activation       | Turn the flag off; discovery answers as not enabled; the entry card disappears. No data change, immediate                                                                                                 |
| Code             | Redeploy the previous release through the same workflow                                                                                                                                                   |
| Schema           | Tables are new and additive: with the flag off and no readers, they can stay. Dropping them is a separate, authorized, backed-up operation, only valid while they are empty or the data is exported first |
| Content          | Suspend or withdraw individual profiles through moderation; no schema action needed                                                                                                                       |
| Migration record | A journal entry already applied cannot be removed; a corrective migration is the only forward path                                                                                                        |

Backup before M3 and M4: record the Neon restore point (branch or snapshot) and its identifier in the evidence.

## 7. Evidence required before each gate

- **Pre-migration (M0, M3, M4):** read-only state check of the target (journal count, last hash), the workflow run id, the commit sha, and the restore point.
- **Post-migration:** the verification script result, table and constraint listing, trigger listing, and a negative test per trigger run in a transaction that rolls back.
- **Pre-activation (staging):** the full T-01..T-22 matrix executed with outputs; the 01D non-effects row-count comparison; accessibility and contrast measurements; Arabic layout check.
- **Pre-production-activation:** owner sign-off on content policy and copy in four languages; limiter keying confirmed (O-E1); moderator staffing named; a tested rollback (flag off then on).
- All evidence is recorded in a completion report with actual outputs. Anything not run is reported as NOT RUN.

## 8. CI and workflows

- Existing Gate 2 jobs (PG18) cover migration SQL, journal pins and release tests. They will need the pin update (M2).
- Job `name:` lines must not change.
- A new CI job (for example a dedicated discovery integration job) is **not** assumed. Proposing one needs owner approval, and it must not rename or weaken any existing job.
- No workflow file is edited by this plan.

## 9. D-24 (plan-limited availability): reserved, undecided

The owner said availability applies to "only certain plans". Which plans, and the behavior on downgrade, are **not decided**. The design keeps a single, code-owned eligibility term in the query predicate so a plan rule can be added without schema change.
No billing, entitlement or pricing behavior is introduced until the owner decides (economic policy, owner gate).

## 10. Open questions (not decided)

| ID   | Question                                                                                                                                       | Author's view                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| O-E1 | Does the customer-keyed limiter work through the Worker-to-Worker call path, and do existing customer endpoints share an address-keyed bucket? | Verify with operations and a test before activation; this is an observation, unverified in production |
| O-E2 | Introduce a least-privilege runtime database role?                                                                                             | Separate decision; this feature does not depend on it                                                 |
| O-E3 | Dedicated CI job for discovery integration tests                                                                                               | Reuse existing jobs first; propose a job only if runtime exceeds the budget                           |
| O-E4 | Staging data: seed synthetic profiles for the evidence run?                                                                                    | Yes, synthetic only, removed afterward; no real business data                                         |
| O-E5 | Who staffs moderation at launch and what response time is promised?                                                                            | Owner decision; no timeframe is promised in the product (D-15)                                        |

## 11. Owner gate and acceptance

- **Owner gate:** answers to O-E1..O-E5, approval of the section 4 and 5 order, and authorization of each block and each environment action separately.
- **Acceptance met by this document:** every threat has a control and a test; the privilege limit is stated honestly; migration, release, activation and rollback are ordered with gates; D-24 is explicitly left open.
- No migration, release, activation or implementation is authorized by this document.
