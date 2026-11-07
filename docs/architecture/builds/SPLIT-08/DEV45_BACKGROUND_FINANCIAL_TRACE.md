# DEV-45 — Background Jobs and Financial Write-Path Verification

**Status: development-only targeted source tracing; not integration certification.** Source reviewed on main, 2026-11-07. No database, Stripe, Cloudflare or live jobs contacted.

## Worker job execution trace

`apps/api/src/config/env.ts` defines `PlatformJob = SentimentJob | SendNotificationJob | EscalateCriticalIncidentJob`. `apps/api/src/index.ts` exports the Cloudflare `queue` handler and dispatches these observed message discriminants:

| Type | Consumer | Effect | Retry / trust concern |
|---|---|---|---|
| `classify_feedback` | `sentimentService.classifyAndStore(feedbackId,businessId)` | AI classification and persistence | Validate producer authenticity, business scoping and retry idempotency |
| `generate_summary` | `summaryService.generateForPeriod`, then `notificationService.notifyBusinessStaff` | Summary database write, AI cost, notification enqueue | `onExisting: 'reuse'` is explicitly passed to avoid repeated AI generation on notification retries; verify with isolated tests |
| `send_notification` | `notificationDelivery.deliver` | External email/SMS delivery | Verify duplicate-delivery semantics and provider retry behavior |
| `escalate_critical_incident` | `criticalIncidents.findById`, `notifyBusinessStaff`, `markEscalated` | Escalation notifications and DB write | `escalatedAt` check and conditional mark are present; independently test concurrent duplicate delivery |

Dead-letter batches are handled before DB initialization; errors in normal job processing trigger `message.retry` with backoff; successful messages call `message.ack()`.

**Important observed gap:** The current queue dispatch has no explicit final `else` rejecting an unknown `message.body.type` before `message.ack()`. A malformed/unrecognized message could therefore be acknowledged without processing. TypeScript's `PlatformJob` union does not validate untrusted runtime queue payloads. This is a **candidate remediation**; DEV-45 does not modify the consumer. Also confirm behavior for missing/malformed message bodies.

## Scheduled side effects

`apps/api/src/index.ts` contains `scheduled` with critical incident escalation, stale AI usage sweep, Stripe evidence heartbeat, orphan settlement expiry, daily OTP pruning and summary enqueue. Additional helper `expireCardlessTrials` exists but call-site reachability was not established by this audit. Each mutating path needs its own isolated test and correct database environment.

## Financial boundaries

- `apps/api/src/billing/billing.service.ts`: `stripe.checkout.sessions.create` is a real provider write.
- `apps/api/src/billing/stripe-webhook.routes.ts`: root webhook intentionally bypasses staff JWT middleware and uses Stripe signature verification; its service and evidence recorder can mutate subscription/evidence state.
- `apps/api/src/billing/stripe-evidence/persisted-reconciliation.ts`: durable reconciliation queue uses a database dedupe key, leased work and fencing. Its own comment says application invocation is not yet established. Do not confuse this DB-backed work queue with the active Cloudflare `JOBS` consumer.
- `apps/api/src/loyalty/loyalty.routes.ts`: staff-facing loyalty routes use authenticate/tenant context and route-level permissions; individual write path and RLS correctness remain unverified.
- Orphan settlement expiry runs in cron. D4/R10 revoked-award recovery policy must be checked separately before any execution involving awards, credit, settlement or reversal.

## Offline tool

`tools/dev45-source-audit.mjs` produces a non-authoritative static source-shape report. `node --test tools/dev45-source-audit.test.mjs` exercises fixtures and local file inspection. The audit is **heuristic**, not a TypeScript AST, semantic security scan or proof of runtime behavior. It never grants authorization.

## Next action — DEV-46

Implement a narrow, separately reviewed fail-closed **runtime queue payload validation** and unknown-job rejection with regression tests, preserving DLQ behavior, idempotency, existing job types and producer contracts. Before changing the queue, inspect the exact worker test harness and message ack/retry expectations.

**Verdict:** Targeted audit documented; unrecognized job acknowledgement requires remediation review. No migrations, financial execution, deployment or staging authorization.
