# Production release (HETA-01-F1 B3)

Merging to `main` runs CI and **deploys nothing**. Production is released only by the manually dispatched
`.github/workflows/deploy-production.yml`.

## Flow

1. **Integrate** — merge to `main`; `ci-cd.yml` runs `verify` only (no credential, no deploy step).
2. **Authorize** — Actions → *Deploy production* → *Run workflow* from `main` with:
   - `expected_commit`: the full 40-hex SHA of the **current tip of `main`** (a stale or non-main SHA is refused);
   - `confirmation`: `DEPLOY_PRODUCTION_RELEASE` (a typo guard, **not** approval).
3. **Verify** — the complete `ci-cd.yml` gate is re-run inside the release run; skipped, cancelled or failed means no deploy.
4. **Approve** — `deploy-api` and `deploy-web` run in the `production` environment and pause for its **Required reviewers**.
5. **Deploy** — API first, then web, each checked out at, and re-verified against, the authorized SHA.
6. **Verify the release** — Blocks 2E–2H (runtime smoke, deployment operations, commercial boundaries, attestation) run only
   after a successful web deployment from this path.

## Live enforcement: PENDING OWNER ACTION

Code ready; **live deployment approval gate not yet certified.** The workflow can only *name* the `production` environment; the
independent approval is a repository setting this change does not (and must not) alter. The owner must:

1. Settings → Environments → `production`: enable **Required reviewers** with at least one reviewer who is not the person
   dispatching, and turn on *Prevent self-review*. Restrict *Deployment branches* to `main`.
2. Move `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from repository secrets to the `production` environment's secrets
   (repository secrets are readable by any workflow on this repository). Use a token scoped to Workers edit only.
3. Settings → Branches: protect `main` (pull request + required `Typecheck & Test` check) and require *Do not allow bypassing*
   for administrators if the owner wants admin merges and dispatches subject to the same rule.
4. Dispatch a no-op release once and confirm the run **waits for review** before `deploy-api` starts.

Until step 1 is done, a repository writer who can dispatch workflows can release after the typed phrase alone. Administrators
can change environment protection or the workflow file itself; that residual risk is why step 3 and CODEOWNERS on
`.github/workflows/` are recommended. The static tests (`apps/api/src/deployment-governance.test.ts`) check workflow text only and
cannot prove any of these settings.

## API and web are not atomic

Two independent Cloudflare deployments, ordered API then web:

| Outcome | State | Handling |
|---|---|---|
| API fails | nothing deployed | fix and re-dispatch |
| API ok, web fails | API on the new commit, web on the old | web does not deploy; re-dispatch the **same SHA** (idempotent) or owner-authorize a rollback |
| both ok, post-deploy checks fail | both on the new commit, runtime verification failed | treat as failed release; owner decides rollback or forward fix |

Provenance per Worker (`release-provenance-api`, `release-provenance-web` artifacts): commit, outcome, run id, actor, time (and
the Cloudflare deployment URL for the API). Cloudflare version ids are not captured; read them from the dashboard. **Rollback is
not automated**: it is an owner decision (versions, database compatibility) documented in `docs/DEPLOYMENT.md` and
`docs/RELEASE-OWNERSHIP.md`.

## Migrations stay separate

`migrate-production.yml` remains its own authorization. A release never migrates. Before authorizing a release the owner confirms:
the actual production migration level, code/schema compatibility (see `runStripeEvidenceHeartbeat`, which touches evidence tables only
when capture is enabled), backup availability, and that the Partner Credit write-denial guards and conservation constraints and the
`historicalTierVerified`, `issuanceAuthorized`, `redemptionAuthorized` = `false` restrictions are unchanged. A green release is not database
certification and authorizes no financial activation.
