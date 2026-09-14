# Operations Runbook

Day-2 operations: monitoring, incident response, secret rotation, and queue
failure handling. [DEPLOYMENT.md](./DEPLOYMENT.md) covers getting a
deployment live and rolling it back; this covers running it afterward.
[ARCHITECTURE.md#risks--known-gaps](./ARCHITECTURE.md#risks--known-gaps) is
the authoritative list of known code-level gaps — this file does not
duplicate it.

## Logging & monitoring

- **Structured logging**: `[observability] enabled = true` is set in both
  `apps/api/wrangler.toml` and `apps/web/wrangler.toml` — Cloudflare Workers
  Logs captures every request, `console.error`, and unhandled exception
  automatically once deployed. No code change needed to enable this; it is
  already on.
- **Where to look**: Cloudflare Dashboard → Workers & Pages → each Worker →
  Logs (or `npx wrangler tail --name echo-grid-feedback-api` /
  `--name echo-grid-feedback-web` for a live stream).
- **Health check**: `GET /health` on the API (unauthenticated, outside all
  middleware) — wire this into whatever uptime monitor you use (Cloudflare's
  own, UptimeRobot, etc.). Returns `{ status: 'ok', environment, timestamp }`.
- **Background-work alerts**: `OPS_ALERT_WEBHOOK_URL` (optional secret, set
  via `npx wrangler secret put OPS_ALERT_WEBHOOK_URL`). When set, three
  classes of silent failure are announced to it — a job reaching the
  dead-letter queue, a cron sweep rejecting, and a cron firing that the
  Worker does not recognise. Point it at a Slack or Discord incoming
  webhook, a vendor ingest endpoint, or a Worker of your own: the payload
  carries `text` (Slack), `content` (Discord) and structured
  `event`/`severity`/`detail` fields, so one URL works for any of them.
  See `apps/api/src/lib/ops-alert.ts`.
  - **Unset is a supported state, not a broken one.** Every alert also goes
    to `console.error` unconditionally, which is where it went before this
    existed. Setting the secret is the whole improvement; nothing breaks
    without it.
  - The alert never throws and never retries. A destination that is down
    costs one extra log line, not a second incident.
- **Still not configured** (needs Cloudflare dashboard access, not a code
  change): Cloudflare's own notification rules on Worker error-rate
  thresholds, CPU time, and queue backlog. Worth adding on top of the
  webhook above for the failure classes application code cannot see —
  a Worker that fails to start, or 5xx from the edge before any handler
  runs.
- **Third-party error tracking** (e.g. Sentry): still not integrated as an
  SDK, deliberately. A Worker on the free plan has a 10ms CPU budget per
  invocation — this project already moved PBKDF2 into a Durable Object to
  live within it — so an instrumentation SDK is a poor trade for what was
  actually missing, which was notification rather than grouping. If grouping
  and trend analysis become worth it later, point `OPS_ALERT_WEBHOOK_URL` at
  the vendor's ingest endpoint rather than adding a client library.

## Database backup & restore

- **Backup**: Neon provides automatic point-in-time recovery on all plans
  (retention window varies by plan tier — confirm the actual window on the
  Neon project's own dashboard, since this is a Neon platform feature, not
  application code). No additional backup tooling needed for the primary
  safety net.
- **Restore procedure**: Neon Console → your project → Branches → "Restore"
  (creates a new branch at the chosen point in time, or restores in place —
  confirm current UI against Neon's own docs). **Never restore directly
  into production without first restoring into a scratch/staging branch and
  verifying the data.**
- **Restore drill**: perform at least one staging restore before production
  launch (required by [PRODUCTION-CHECKLIST.md](./PRODUCTION-CHECKLIST.md)).
  This has not yet been performed in this project — it requires an actual
  staging Neon project to exist first.
- **Migrations have no automated rollback** (documented in
  [DEPLOYMENT.md](./DEPLOYMENT.md#rollback) already): `pnpm db:migrate` has
  no down-migration tooling. A bad migration needs either a manual fix or a
  new forward migration undoing it — plan any schema change with this in
  mind, especially destructive ones (dropping/renaming a column).

## Deployment rollback

Covered in full in [DEPLOYMENT.md#rollback](./DEPLOYMENT.md#rollback):
`wrangler rollback` per Worker. Rehearse this at least once before
production (required by the production checklist) so the first real
rollback isn't also the first attempt.

## Queue failure & dead-letter handling

- `echo-grid-feedback-jobs` (binding `JOBS`) has a configured DLQ
  (`echo-grid-feedback-jobs-dlq`, `wrangler.toml`'s `dead_letter_queue`),
  `max_retries = 3`.
- The consumer (`apps/api/src/index.ts`'s `queue` export) acks/retries
  **per message**, not per batch — one malformed or genuinely-failing
  message never blocks the rest of a batch.
- Sentiment classification and AI summary failures already degrade
  gracefully to a `failed` status on the affected row rather than throwing
  — the DLQ exists to surface *systemic* failures (e.g. a Workers AI or
  Anthropic outage across many messages), not routine per-item errors.
- **The DLQ now has a consumer** (`wrangler.toml`'s second
  `[[queues.consumers]]`, handled by `index.ts`'s `handleDeadLetterBatch`).
  Until it did, the queue was declared and nothing read it: a job that
  exhausted its 3 retries landed there and sat, with no consumer, no alarm
  and nothing logged.
- **What the consumer does**: alerts per message (job type, message id,
  attempt count and the job body — ids and discriminants only, never
  customer prose), then **acks**. Acking discards the message, which is the
  deliberate trade: the alternative is redelivering forever to a handler
  that has already failed four times. **The alert is therefore the record** —
  keep it, because the message itself is gone.
- It opens no database connection, on purpose: this path has to work when
  the database is the thing that broke.
- **Operational action on a dead-letter alert**: diagnose the systemic cause
  (provider outage vs. a code bug) from the alert's `jobType` and `body`.
  The work itself is not recoverable from the queue, but most of it is
  reconstructible — a `classify_feedback` job's row is still in `feedback`
  with `analysis_status = 'failed'` and can be re-enqueued; a
  `generate_summary` period can be regenerated from the dashboard. A
  `send_notification` job is the one that is genuinely lost.

## Secret rotation procedure

1. Generate the new value (`openssl rand -base64 32` for JWT secrets; the
   provider's own dashboard for Twilio/Anthropic/Resend/Stripe).
2. `npx wrangler secret put <NAME>` — this updates the secret for **new**
   deployments/requests; already-running isolates may hold the old value
   briefly (Workers isolates are short-lived, so this self-resolves quickly,
   typically within minutes).
3. **`JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`/`CUSTOMER_JWT_SECRET`
   rotation invalidates every existing session** the moment it takes
   effect — every access and refresh token signed with the old secret stops
   verifying. This is a deliberate, all-or-nothing action (no dual-secret
   grace period is implemented); plan rotation for a low-traffic window and
   expect every logged-in user to be signed out.
4. `STRIPE_WEBHOOK_SECRET` rotation requires a **matching change in the
   Stripe Dashboard** (Developers → Webhooks → your endpoint → Roll secret)
   — rotating only the Workers secret without also rolling it in Stripe
   breaks webhook signature verification entirely until both sides match.
5. Confirm rotation succeeded: `GET /health` for a basic liveness check,
   then a real login attempt (for JWT secrets) or `stripe trigger` /a test
   webhook send (for the Stripe secret) before considering rotation done.

## Incident-response checklist

1. **Detect** — Workers Logs / `wrangler tail` / uptime monitor alert.
2. **Assess blast radius** — single business (check `audit_log` for the
   affected `businessId`) vs. platform-wide (check `/health`, error rate
   across all Workers Logs).
3. **Contain** — for a suspected compromised credential, rotate it
   immediately (see above) even before full root-cause is known; for a
   suspected malicious business/user, platform admin can suspend the
   business (`PATCH /platform/businesses/:id/status`) without a deploy.
4. **Communicate** — status update to affected users/business owners
   (channel/process to be defined by the owner — not yet established for
   this project).
5. **Fix** — code fix, config fix, or a `wrangler rollback` to the last
   known-good deployment, whichever is faster and safer for the specific
   incident.
6. **Verify** — re-run [DEPLOYMENT.md Step 8](./DEPLOYMENT.md#step-8--post-deploy-verification)
   post-fix.
7. **Record** — add the incident (cause, impact, fix, follow-up) to a
   running log; this project does not yet have a dedicated incident log —
   start one (even a simple dated Markdown file) with the first real
   incident.

## Data retention

Not yet configured as an explicit policy. Current behavior, by table:

- Soft-delete (`isDeleted`/`deletedAt`) is used throughout for
  businesses/branches/users/roles/etc. — no automatic hard-delete or purge
  job exists, so soft-deleted rows accumulate indefinitely.
- `audit_log` is append-only by design, with `ON DELETE SET NULL` (not
  cascade) on its business/user references — the trail is meant to survive
  even if the business or actor is later purged, and nothing currently
  purges it.
- No GDPR/CCPA-style "right to erasure" hard-delete flow exists yet. If the
  target jurisdiction requires one, this is a real product gap to close
  before launch there — flag to the owner alongside the legal-policy
  decision gate in [PRODUCTION-CHECKLIST.md](./PRODUCTION-CHECKLIST.md).

## Service-level targets (proposed, not yet committed to)

No SLOs have been formally adopted for this project. Reasonable starting
targets for a v1, to be confirmed/adjusted by the owner before production:

| Metric | Proposed target |
|---|---|
| API availability | 99.5% monthly (Cloudflare Workers' own platform SLA is higher; this accounts for this app's own bugs/deploys) |
| `GET /health` p99 latency | < 200ms |
| Mutating request p99 latency | < 1s (excludes async-queued work like AI summaries) |
| Queue message processing lag | < 5 min under normal load |
| Critical security patch turnaround | < 24h from discovery |
