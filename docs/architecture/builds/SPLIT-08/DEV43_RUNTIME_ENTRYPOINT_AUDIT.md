# DEV-43 — Runtime Authorization Entry-Point Audit

**Scope:** development-only, read-only repository inspection of the authoritative `main` branch on 2026-11-07. This is an evidence-based **partial entry-point inventory**, not a comprehensive runtime security certification. No credentials, database state, GitHub environment settings, Cloudflare resources, or Stripe accounts were accessed. No execution, migrations or deployment authorized.

## Verified source inventory

| Entry point | Observed execution capability | Existing guard in repository | Remaining verification / risk |
|---|---|---|---|
| `.github/workflows/migrate-staging.yml` | Manual `db:migrate` and post-migration hash verification against `STAGING_DATABASE_URL` | `workflow_dispatch`, full 40-hex `expected_commit`, `MIGRATE_STAGING` phrase, checkout `main`, SHA equality, `environment: staging`, serialized migration concurrency, migration-chain check | Actual staging environment reviewers, branch restrictions and secret isolation **not verified**. Phrase is a typo guard, not independent authorization. Workflow performs real writes. |
| `.github/workflows/migrate-production.yml` | Manual production `db:migrate` and post-migration verification | Same exact-SHA/phrase/environment/concurrency pattern, using `PRODUCTION_DATABASE_URL` | Production reviewer settings and database URL isolation **not verified**. Separate owner authorization required; never use for Tuesday's staging exercise. |
| `.github/workflows/deploy-staging.yml` | Cloudflare API and web deploy; staging health smoke | Manual dispatch, full SHA equality, `DEPLOY_STAGING` phrase, `environment: staging`, API before web | Does not itself establish that staging reviewers or credentials are correctly configured. No DEV-34–42 evidence/authorization linkage. Real deployment, not a dry run. |
| `.github/workflows/deploy-production.yml` | Cloudflare API then web deploy; post-deploy verification | Manual exact SHA, current main check, CI gate, `environment: production` per deploy job | `docs/PRODUCTION-RELEASE.md` explicitly marks reviewer/secret protections **PENDING OWNER ACTION / UNVERIFIED**. Not atomic; no automatic rollback. |
| `apps/api/package.json` scripts `db:generate`, `db:migrate`, `db:seed*` | Direct local CLI schema generation, migration and seed writes | No owner authorization contract observed in package script definitions | Operator can invoke CLI outside GitHub Actions with a configured `DATABASE_URL`; environment and credential safety must be separately established. |
| `apps/api/scripts/provision-stripe-catalog.mjs` | `--test --apply` or `--live --apply` creates Stripe products/prices; `--connect` updates `subscription_plans` in configured DB | Requires explicit mode, `--apply`, matching `sk_test_`/`sk_live_` prefix, `DATABASE_URL` for `--connect`, validates returned prices | `--apply` is a CLI acknowledgement, not owner identity verification; live mode is implemented and MUST NOT be used in staging. Database destination is not independently proven isolated by this script. |
| `apps/api/src/deployment-governance.test.ts` | Static CI assertions for workflow policy | Checks manual production release and workflow properties | Static tests cannot verify GitHub environment protection or secret placement; do not interpret green tests as runtime approval. |
| `tools/dev34-*.mjs` through `tools/dev42-*.mjs` | Offline preflight, report, and denial prototypes | Deny authorization and report non-execution | **Not wired to real execution entry points.** They provide no runtime enforcement and do not authenticate supplied evidence or reviewer identity. |

## High-priority gaps and owner decisions

**G1 — External environment protection:** Read GitHub environment settings for `staging` and `production` and verify required reviewers, prevent-self-review, deployment branch policy, and environment-specific secrets. Do not infer settings from workflow YAML.

**G2 — Credential provenance:** Verify that `STAGING_DATABASE_URL`, `PRODUCTION_DATABASE_URL`, Cloudflare tokens, and Stripe test credentials are environment-specific and never cross production/staging boundaries. Inspect secret **names and scopes only**, never values in reports. Check for repository-level secret fallback per `docs/PRODUCTION-RELEASE.md`.

**G3 — Entry-point authorization:** Decide whether to add a trusted, independently verifiable, action-scoped approval mechanism for staging migrations/deployments and direct CLI operations. Offline DEV-34–42 output must never be accepted as authorization. Any design must bind exact SHA, environment, action, approver, expiry and audit evidence.

**G4 — Staging readiness:** Before first authorized execution, validate current main SHA, exact-head CI, dedicated Neon staging DB, Hyperdrive/R2/KV/Queues, test-only Stripe keys and webhook, staging origin, isolation and migration hash state. Existing `docs/STAGING-CHECKLIST.md` remains authoritative operational guidance.

**G5 — Financial and tenant controls:** Separately inspect actual Hono billing/feedback/loyalty routes, queue consumers, cron handlers, RLS and D4/R10 ledger boundaries before claiming a complete runtime audit. This DEV-43 inventory **does not certify** those areas.

**G6 — Execution safety:** Staging and production migration workflows apply real writes. Require explicit owner authorization for each action, independent preflight, and a rollback/forward-fix decision plan. Do not run any workflows under DEV-43.

## Verdict

**PARTIAL AUDIT COMPLETE — RUNTIME AUTHORIZATION NOT CERTIFIED.**

Existing manual controls and static tests are valuable, but DEV-34–42 cannot confer permission to execute them. GitHub environment configuration, secret provenance, and actual runtime financial/tenant entry points remain unverified.

## Recommended DEV-44

Development-only, read-only inventory of actual API routes, queue/cron consumers, and financial write boundaries. Document gaps before authorizing any middleware changes. Tuesday 2026-11-10 is a target date, **not** standing execution authorization.
