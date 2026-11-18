# Split 01 development acceptance — 2026-11-18

Status: development corrections implemented; final acceptance BLOCKED. This is
an implementation evidence record, not an amendment to the frozen specification.
It supersedes the residual dispositions in Addendum A1 where explicitly noted.

## Repository and recovered delivery

Reconciliation started at main `2a40dc497b36df2c566a60e0d0e07d923aeb956a`.
Main subsequently advanced to `3c91b835568f54623c5e8a5a2cac0d9bbcd7f152`
(NETWORK-11, PR #513). Both main revisions were merged without conflicts in an
isolated `dev/split01-acceptance` worktree. Community changes were preserved.

The supplied `echogrid-split01-complete.zip` contains the Git bundle, seven
patches, README-APPLY, manifest, SHA256SUMS and 59 source-file copies. Every
checksum passed. The bundle passed `git bundle verify`; all 59 copied file
blobs matched the bundle. The separately named inspection and completion
reports were not included in this ZIP and are not claimed as recovered.

Exact imported source history:

- Base: `e620dec48a47a7db8f7386dfe7906be44a37572d`.
- C7 tip: `8366bd6408a04df10042a5b98f4a2fd77fe3f0ce`.
- C7 tree: `0f057ab4fee6a6b0160739be3f36423b6ef60ded`.
- Local preserved ref: `import/split01-claude-c1-c7`.
- Delivery: 59 files, 5,044 insertions, 133 deletions.

Authenticated Git push was unavailable. GitHub connector publication recreates
commit metadata and therefore commit SHAs. Each published commit's **tree SHA**
was checked against its exact local source tree. The final report records the
source/published mapping. This does not claim that original commit objects were
pushed unchanged. The original bundle remains the exact-commit delivery.

## C1–C7 verification

| Block | Evidence and disposition |
| --- | --- |
| C1 | Real check-in membership-gate integration; ineligible membership is refused before cooldown/velocity reservation. |
| C2 | Real concurrent join integration; per-customer/business transaction advisory lock; replay and conflicting consent inputs tested. |
| C3 | Actual Drizzle regression creates legacy-shaped rows before migration 0034, applies it and all later migrations, checks mappings and economic preservation; reconciliation invariants tested with corrupt synthetic fixtures. |
| C4 | Both HTTP join contracts require literal `consentAccepted: true` and approved `consentVersion`; API negatives and localized component tests executed. |
| C5 | Real join/leave/rejoin/withdrawal, earning, redemption and issue tests; balances/history preserved. Suspension races corrected below. |
| C6 | Customer DTOs, malformed identifier handling and customer-scoped generic authorization issuance tested. Consent listing narrowed further below. |
| C7 | Addendum and API reference inspected. Addendum's claimed architecture exceptions are qualified below; they are not independently verified owner approvals. |

## Verified security defects and corrections

Before correction, the 13-test PostgreSQL regression had 10 failures and three
passes. Positive adjustments could earn against missing/inactive memberships;
staff earning ignored suspended accounts; both redemption and issue could
authorize from an account snapshot read before waiting on a membership lock.
The latter was demonstrated using two connections, an uncommitted account
suspension and a real PostgreSQL row-lock wait.

Staff positive adjustments and purchases now lock the current membership
`FOR SHARE` before the tenant-scoped account `FOR UPDATE`, then evaluate the
existing membership gate using the locked rows. Negative/zero administrative
corrections retain their prior semantics and take only the account lock.

Redemption and issue use membership SHARE → reward UPDATE → account UPDATE.
They re-read account status and balance after blocking locks and revalidate the
existing gate. No ledger history is rewritten. No lifecycle states or permissions
are introduced.

The expanded 18-test real-PostgreSQL regression verifies inactive/missing
memberships, suspended accounts, tenant denial, idempotent purchase replay,
preserved negative corrections, suspension/leave races, and simultaneous earning,
purchase, redemption, issue and leave. All 18 passed locally. The concurrency
test rejects deadlock/statement-timeout errors and reconciles points against the
inserted transactions; it does not claim a formal proof for every possible writer.

`GET /consents` now returns an explicit closed DTO. Internal metadata,
idempotency keys, customer identifiers and bookkeeping fields are excluded.
The HTTP regression checks exact JSON fields and authenticated-customer scope
despite a foreign-customer query parameter. `docs/API.md` documents this change.

Two imported list-route unit tests requested an unsupported trailing slash.
Their requests now use the documented canonical endpoint; status and DTO
assertions are retained.

## R1–R7 disposition (owner request numbering)

| Item | Status | Smallest remaining action |
| --- | --- | --- |
| R1 nullable membership link | BLOCKED | Frozen migration order requires strengthening after validation; nullable linkage remains and Addendum A1 acknowledges it. Owner must approve the exact constraint/legacy-writer plan and reconcile Gate 2 expectations before any new migration. No journal or schema change is included. |
| R2 referral integration | NOT APPLICABLE to mandatory frozen scope | Frozen DoD does not require referral wiring. The deprecated enrollment path's referral logic is not expanded here. |
| R3 staff earning bypass | PASS | Positive earning requires eligible membership and account; adversarial PostgreSQL tests above. Existing staff RBAC remains in force. |
| R4 localized consent | Automated checks PASS; external review BLOCKED | Localized interfaces and key behavior are tested. Native-speaker and legal acceptance are not inferred from automated tests. Supply review sign-off if required for final acceptance. |
| R5 Split 07 global authorization keys | External security dependency | Settlement access/completion derive globally unique keys from client keys; callers check authorization binding and fail closed. Generic issuance is customer-scoped. Economic service files were not changed; coordinate a separately owned key-scoping/binding correction. |
| R6 consent DTO | PASS | Closed DTO and adversarial HTTP regression; no raw metadata or idempotency keys. |
| R7 historical soft-deleted backfill | BLOCKED for environment acceptance | Migration 0034 has no soft-delete filter and is unchanged. Synthetic regression detects this invariant violation. No staging/production inspection or historical correction is claimed. Obtain read-only environment evidence and an approved correction strategy for any violating rows. |

## Constraint-strengthening design — proposal only

1. Approve whether all rows, including archived accounts, require non-null links;
   reconcile the frozen strengthening requirement and historical backfill policy.
2. Enumerate and remove or adapt remaining legacy account-creation writers before
   enforcing the constraint. Preserve balances and transactions.
3. Run read-only reconciliation and verify zero unmapped/misaligned accounts on
   each approved target. Remediate historical anomalies under a separate plan.
4. Reserve a fresh migration number against then-current main. Reconcile Gate 2
   journal/count/hash, upgrade/restore fixtures and tenant-key expectations.
5. In disposable PostgreSQL, validate a staged non-null CHECK and then set the
   column NOT NULL, retaining existing referential/tenant constraints. Assess
   locking and timeout behavior before proposing an operational rollout.
6. Submit that migration separately for approval. No executable migration,
   historical migration edit, journal change or live execution is authorized here.

## Architecture acceptance conflict

The frozen specification says sensitive actions **use** short-lived consumable
authorization. Addendum A1 D1 says customer redemption instead retains a
90-day customer JWT plus counter confirmation and calls that an accepted
deviation. No independently attributable owner amendment was recovered.
The primitive's existence and passing counter-confirmation tests do not satisfy
the frozen usage requirement. This is a mandatory acceptance blocker. Owner must
provide an explicit amendment or authorize a separate compliant implementation;
this branch does not invent a new customer step or alter that contract.

Addendum A1 D2 describes withdrawal ending membership while preserving points.
That implemented behavior is tested; the addendum's decision attribution is not
independent owner-signoff evidence. Claims about empty production/staging data
also remain unverified. The frozen specification and historical completion report
were not edited.

## Validation and final gate

Supported local toolchain: Node 22.23.5, pnpm 11.9.0; frozen-lockfile install.
Actual disposable PostgreSQL 16.15 is used, including independent connections.
Unit/component tests use Vitest; mocked tests are not presented as PostgreSQL
or browser evidence. Typechecks, ESLint and API/web builds passed locally.
Exact counts, full PostgreSQL result, final-head hosted CI and mergeability are
recorded in the final report/PR after completion, rather than claiming pending
checks as successful.

The read-only reconciliation CLI exited zero against a fresh migrated disposable
database (zero rows). Nonempty legacy mapping and corruption detection are
verified by the C3 migration test; the empty CLI run is not live-data evidence.

LOCKED COMPLETE remains BLOCKED by the architecture/constraint/environment
acceptance items above even if hosted CI is green. No production/staging data,
secrets, deployments or migrations were changed. No PR was automatically merged.
No B2B, Community or Split 07 economic service development was performed.
