# DEV-44 — API, Queue, Cron and Financial Write-Boundary Audit

**Development-only, read-only source audit — 2026-11-07.** Inspected repository `main` source paths listed below. No external service or database was contacted. This is a **targeted source inventory**, not a comprehensive proof of tenant isolation, financial correctness, authorization, or staging readiness.

## Confirmed entry points and boundaries

| Entry point / evidence | Behavior identified | Existing boundary visible in source | Follow-up required |
|---|---|---|---|
| `apps/api/src/index.ts` | Exports `fetch: app.fetch`, `queue`, and `scheduled`; mounts `/api/v1` and separate root `/webhooks/stripe` | HTTP middleware and worker event handlers are separate trust paths | Trace every queue job dispatch and cron side effect; HTTP auth does not automatically apply to queue/cron |
| `apps/api/src/billing/stripe-webhook.routes.ts` | Root-level unauthenticated webhook receives Stripe events, invokes `StripeWebhookService.processEvent` and subscription observation recorder; optional enforced evidence capture | Stripe signature verification is intended as security boundary; raw body is read before verification; route deliberately bypasses JWT and browser middleware | Independently test invalid signature, duplicate events, capture-off/enforced paths, idempotency, DB transaction outcomes and replay |
| `apps/api/src/billing/billing.service.ts` | Creates Stripe Checkout sessions; subscription plan reads can reconcile catalog | Payment processor calls and repository writes are potential side effects | Trace `billing.routes.ts` auth, tenant resolution, plan ownership, Stripe key realm and failure recovery |
| `apps/api/src/loyalty/loyalty.routes.ts` | Staff-facing points/rewards/account mutations | `authenticate`, `resolveTenantContext`, `requirePermission`, `requireBusinessWideAccess` appear in source | Test every write route for permission/branch scoping and transaction/ledger invariants; middleware presence alone is not proof |
| `apps/api/src/index.ts` queue consumer | Handles platform job batches, including a dead-letter path and database-backed jobs | Queue origin and job type must be independently trusted; source comments note DLQ path runs before DB connection | Enumerate every job kind, payload validation, retries, poison message handling, idempotency and cross-business authorization |
| `apps/api/src/index.ts` scheduled consumer | Periodic summaries, incident escalation, stale AI usage, OTP pruning, Stripe evidence heartbeat, orphan settlement expiry | Multiple independent `waitUntil` tasks and failure alerts; heartbeat conditional on capture configuration | Verify scheduled triggers and database writes in isolated tests; especially orphan settlement expiry and Stripe evidence state |
| `apps/api/src/billing/stripe-evidence/persisted-reconciliation.ts` | Enqueues persisted reconciliation work with a dedupe key | Repository inserts use dedupe construction; actual end-to-end exactly-once not established | Inspect durable transaction boundaries, retries and terminal states |
| `apps/api/src/billing/stripe-read/read-authorization.ts` and `durable-authorization.ts` | Separate test-realm read-authorization design | Unavailable store is documented to fail closed | Confirm whether any actual route/queue invokes these capabilities; read permission does not imply financial write authority |
| `apps/api/src/deployment-governance.test.ts` and DEV-34–42 tools | Static deployment checks and offline readiness prototypes | No live authorization middleware from these tools | Do not use readiness outputs as permission for side effects |

## Priority findings

**F1 — Separate trust boundaries:** HTTP routes, Stripe webhook, Cloudflare queue, scheduled cron, GitHub Actions, and local CLIs are distinct execution surfaces. No single DEV-34–42 readiness function intercepts them all.

**F2 — Stripe webhook:** The root webhook is intentionally outside JWT middleware. Signature verification, replay safety and durable idempotency require independent exact-path tests before staging.

**F3 — Financial effects:** Checkout creation, subscription synchronization, loyalty points/redemptions, partner credits, and orphan settlement require separate action-specific authority and accounting checks. This audit does not establish their full correctness or completion.

**F4 — Background jobs:** Cron/queue work can mutate database state without a browser request. Confirm trusted job producers, validated payloads, tenant scope, retry and DLQ behavior. The `scheduled` handler explicitly runs an orphan settlement expiry sweep.

**F5 — Deployment controls:** DEV-43 identified manual staging/production workflows and unverified GitHub environment protection. No additional authorization may be inferred from this DEV-44 report.

## Required next evidence

1. Build a complete handler-to-service-to-repository trace for all mutating billing, loyalty, partner-credit, orphan-settlement and Stripe evidence paths.
2. Map every queue job type and cron expression to its producer, consumer, database tables and external provider calls.
3. Review RLS/tenant isolation and D4/R10 revoked-award recovery controls with real isolated regression evidence.
4. Verify GitHub staging environment reviewer policy and secret scopes outside repository text (names/scopes only).
5. Require explicit action-specific owner approval and isolated test credentials before staging execution.

## Verdict

**PARTIAL RUNTIME AUDIT COMPLETE — FINANCIAL / TENANT / BACKGROUND EXECUTION NOT CERTIFIED.**

No runtime code, migrations, secrets, infrastructure or provider state changed. The audit does not grant staging or production authority. Proposed DEV-45: development-only exhaustive job/cron and financial write-call graph with targeted static assertions. No integration or migration before separate explicit authorization.
