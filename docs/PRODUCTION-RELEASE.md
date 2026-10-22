# Production release (HETA-01-F1 B3)

Merging to `main` runs CI and **deploys nothing**. Production is released only by the manually dispatched
`.github/workflows/deploy-production.yml`. **A dispatch performs real Cloudflare deployments; it is never a dry run or a no-op.**

## Flow

1. **Integrate** — merge to `main`; `ci-cd.yml` runs `verify` only (no credential, no deploy step).
2. **Authorize** — Actions → *Deploy production* → *Run workflow* from `main` with:
   - `expected_commit`: the full 40-hex SHA of the **current tip of `main`** (a stale or non-main SHA is refused);
   - `confirmation`: `DEPLOY_PRODUCTION_RELEASE` (a typo guard, **not** approval).
3. **Verify** — the complete `ci-cd.yml` gate is re-run inside the release run; skipped, cancelled or failed means no deploy.
4. **Approve** — `deploy-api`, then `deploy-web`, each run in the `production` environment and each pauses for that
   environment's **Required reviewers**.
5. **Deploy** — API first, then web, each checked out at, and re-verified against, the authorized SHA.
6. **Verify the release** — Blocks 2E–2H (runtime smoke, deployment operations, commercial boundaries, attestation) run only
   after a successful web deployment from this path.

## Approval sequencing

| Question | Answer |
|---|---|
| Who approves? | The `production` environment's required reviewers (not the typed phrase). |
| How many approvals? | Expected **two**: each job that references a protected environment requests its own review (API, then web). Not verified until the owner observes it. |
| Approval denied for `deploy-api` | Nothing has deployed; `deploy-web` and the 2E–2H jobs are skipped. |
| API deployed, web rejected or failed | API on the new commit, web on the old. Not atomic and not rolled back automatically: re-dispatch the **same SHA** (idempotent), or the owner authorizes a rollback. |
| Does the approved commit stay fixed? | Yes. Every job after `authorize` uses the SHA that `authorize` output and re-asserts `HEAD == that SHA`. A later push to `main` cannot change what a running release deploys. |
| `main` advances while the release waits for review | `deploy-api` re-checks, **after approval and before anything deploys**, that the authorized SHA is still the tip of `main`; if not it fails closed and a fresh dispatch is required. `deploy-web` does not re-check (the pair must finish from one commit). Reviewers should still compare the SHA shown in the run with the one they intended. |
| Cloudflare version ids | Not captured (separate improvement). Read them from the Cloudflare dashboard. |

## Environment protection contract

Statuses used below: **CONFIGURED** (the GitHub setting exists), **VERIFIED** (evidence shows it enforces the restriction),
**PENDING OWNER ACTION** (cannot be verified from the repository or needs an owner change).

| Protection | Required | Status |
|---|---|---|
| Required reviewers on `production` | at least one reviewer who is not the dispatcher | PENDING OWNER ACTION |
| Prevent self-review | enabled | PENDING OWNER ACTION |
| Deployment branches | `main` only | PENDING OWNER ACTION |
| Cloudflare credentials | environment secrets of `production` only | PENDING OWNER ACTION |
| No deploy from an ordinary merge or PR | workflow files | VERIFIED (static tests; text only) |

Effective production protection is **UNVERIFIED**. This change neither inspects nor modifies GitHub settings, and the typed
phrase must never be treated as owner approval.

### Read-only verification the owner can perform (no deployment)

1. Settings → Environments → `production`: confirm the reviewers, *Prevent self-review* and *Deployment branches*.
   CLI equivalent: `gh api repos/<owner>/<repo>/environments/production` (read-only; shows `protection_rules` and `deployment_branch_policy`).
2. Settings → Secrets and variables → Actions: list the names under *Environment secrets → production* and *Repository secrets*.
   Names only; never display or copy values.
3. Settings → Branches: confirm the `main` rule.
4. Run `pnpm --filter @echo-grid-feedback/api exec vitest run src/deployment-governance.test.ts` (static workflow checks) and
   `actionlint` over `.github/workflows` (both execute nothing remote).

**Demonstrating that the approval gate actually pauses a run requires dispatching the real deployment workflow, so it is
NOT VERIFIED — REQUIRES SEPARATE PRODUCTION RELEASE AUTHORIZATION.** No production-affecting test is run to prove it. The first
authorized release is the live test: the owner watches for the pending review on `deploy-api` before approving, and denies it if
anything is unexpected.

## Credential isolation

Referenced credentials (names only):

| Workflow | Credential | Context |
|---|---|---|
| `ci-cd.yml` (PRs and pushes) | none | verification only |
| `deploy-production.yml` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | `deploy-api`, `deploy-web` only, in `environment: production` |
| `deploy-staging.yml` | the same two names | `environment: staging` |
| `migrate-production.yml` | `PRODUCTION_DATABASE_URL` | `environment: production`, separate authorization |
| `heta-f1-certification.yml` | `HETA_F1_CERT_DATABASE_URL` | manual only; repository-level, not environment-bound |

Findings:

- Adding `environment: production` does **not** stop a job from reading a repository-level secret of the same name; the job
  simply resolves an environment secret first if one exists. **Isolation exists only once the secrets live in the environment
  and the repository-level copies are removed.** Until then effective isolation is UNVERIFIED.
- While the Cloudflare secrets are repository-level, any collaborator who can push a branch can open a same-repository pull
  request whose modified workflow file references them (pull-request runs use the PR's own workflow file). Only environment
  secrets guarded by a branch restriction and required reviewers prevent that. Fork pull requests receive no secrets.
- Staging and production reference the **same secret names**. If both are repository-level they are the same token, so a
  staging run holds a production-capable credential. Use a distinct, least-privilege token per environment.
- Tokens should be scoped to *Edit Cloudflare Workers* on this account only (no zone, DNS or billing edit). Token permissions
  are UNVERIFIED (not inspected).

### Owner checklist: repository secrets → environment secrets (no value is ever shown)

1. In Cloudflare create two API tokens (production, staging), each limited to the Workers permissions the deploy needs and the
   single account; do not reuse the existing one for both.
2. In GitHub, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as **environment secrets** on `production` and, separately,
   on `staging`.
3. Set the `production` reviewers, *Prevent self-review* and *Deployment branches = main* **before** relying on the secrets.
4. Authorize one release/staging run and confirm it succeeds using the environment secrets (the owner decides when).
5. Only then delete the repository-level `CLOUDFLARE_*` secrets, and revoke the old Cloudflare token.
6. Move `HETA_F1_CERT_DATABASE_URL` into a dedicated protected environment before the certification workflow is first used.
7. Record the result; effective isolation is VERIFIED only after step 5 and a successful run.

## API and web are not atomic

Two independent Cloudflare deployments, ordered API then web:

| Outcome | State | Handling |
|---|---|---|
| API fails | nothing deployed | fix and re-dispatch |
| API ok, web fails | API on the new commit, web on the old | web does not deploy; re-dispatch the **same SHA** or owner-authorize a rollback |
| both ok, post-deploy checks fail | both on the new commit, runtime verification failed | treat as a failed release; owner decides rollback or forward fix |

Provenance per Worker (`release-provenance-api`, `release-provenance-web` artifacts): commit, outcome, run id, actor, time (and the
Cloudflare deployment URL for the API). **Rollback is not automated**: it is an owner decision (versions, database compatibility) recorded in
`docs/DEPLOYMENT.md` and `docs/RELEASE-OWNERSHIP.md`.

## Reusable workflow and artifacts

`verify` calls `ci-cd.yml` with `uses: ./.github/workflows/ci-cd.yml`, which makes its job part of the **same workflow run**.
Artifacts it uploads (`block-2e-static-evidence`, `block-2f-release-inputs`, `block-2g-static-evidence`, `block-2h-static-evidence`,
`block-2d-evidence`) therefore belong to the release run, and the Block 2E–2H jobs download them by name with
`actions/download-artifact`. `actionlint` reports no error on any workflow. **Whether artifact visibility across the
called-workflow boundary behaves as documented is UNRESOLVED until the first authorized release**, because it cannot be exercised
without dispatching the real workflow. If it fails there, the failing step is a post-deployment verification job, after the
deployments; fix it forward, do not widen permissions.

`ci-cd.yml` and the release job use `permissions: contents: read`; the called workflow cannot exceed the caller. The caller's
concurrency group is `production-release`; the called workflow's group includes the event name, so they never share a group.

## Migrations stay separate

`migrate-production.yml` remains its own authorization. A release never migrates. Before authorizing a release the owner confirms:
the actual production migration level, code/schema compatibility (see `runStripeEvidenceHeartbeat`, which touches evidence tables only
when capture is enabled), backup availability, and that the Partner Credit write-denial guards and conservation constraints and the
`historicalTierVerified`, `issuanceAuthorized`, `redemptionAuthorized` = `false` restrictions are unchanged. A green release is not database
certification and authorizes no financial activation.
