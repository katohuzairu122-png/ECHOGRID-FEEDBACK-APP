import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { requestId } from 'hono/request-id';
import type { Bindings, PlatformJob } from './config/env';
import { errorHandler } from './lib/error-handler';
import { parseAllowedOrigins } from './lib/allowed-origins';
import { rateLimit } from './middleware/rate-limit';
import { auditTrail } from './middleware/audit';
import { authRoutes } from './auth/auth.routes';
import { businessRoutes } from './businesses/business.routes';
import { branchRoutes } from './branches/branch.routes';
import { visitSessionRoutes } from './visits/visit-session.routes';
import { qrRoutes } from './qr/qr.routes';
import { feedbackRoutes } from './feedback/feedback.routes';
import { customerAuthRoutes } from './customer-auth/customer-auth.routes';
import { loyaltyRoutes } from './loyalty/loyalty.routes';
import { loyaltyCustomerRoutes } from './loyalty/loyalty-customer.routes';
import { analyticsRoutes } from './analytics/analytics.routes';
import { notificationsRoutes } from './notifications/notifications.routes';
import { platformBusinessRoutes } from './platform/business-directory.routes';
import { platformAuditLogRoutes } from './platform/audit-log.routes';
import { platformBillingPlansRoutes } from './platform/billing-plans.routes';
import { platformBillingSubscriptionsRoutes } from './platform/billing-subscriptions.routes';
import { billingRoutes } from './billing/billing.routes';
import { stripeWebhookRoutes } from './billing/stripe-webhook.routes';
import { messagingRoutes } from './messaging/messaging.routes';
import { messagingCustomerRoutes } from './messaging/messaging-customer.routes';
import { fraudSignalRoutes } from './fraud/fraud-signal.routes';
import { createDb } from './db/client';
import { createRepositories } from './repositories';
import { createSentimentService } from './sentiment/sentiment.service';
import { createSummaryService } from './sentiment/summary.service';
import { enqueueSummaryGeneration } from './sentiment/sentiment-job';
import { enqueueEscalation } from './feedback/critical-alert-job';
import { computePeriodRange, formatPeriodLabel, type PeriodType } from './sentiment/period';
import { createEmailService } from './notifications/email.service';
import { createSmsService } from './customer-auth/sms.service';
import { NotificationDeliveryService } from './notifications/notification-delivery.service';
import { NotificationService } from './notifications/notification.service';
import { computeRetryDelaySeconds } from './lib/backoff';

// Durable Object classes must be exported from the Worker's main module for
// wrangler to find them (see wrangler.toml's durable_objects.bindings /
// migrations entries, and auth/password-hasher.do.ts's own doc comment).
export { PasswordHasherDurableObject } from './auth/password-hasher.do';

/**
 * Root Hono application for the Echo Grid Feedback CEP API.
 *
 * /health stays unversioned and outside the /api/v1 sub-app on purpose: it's
 * an infrastructure probe (load balancers, uptime monitors) hit far more
 * often than real traffic, so it skips CORS/rate-limit/security-header
 * middleware rather than paying their cost or risking a monitor tripping
 * the rate limiter. Everything else is mounted under /api/v1.
 *
 * All errors -- thrown AppErrors and unexpected ones alike -- flow through
 * errorHandler (lib/error-handler.ts), so every response uses the same
 * { success, data } / { success, error } envelope (lib/response.ts).
 */
const app = new Hono<{ Bindings: Bindings }>();

app.onError(errorHandler);

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'echo-grid-feedback-api',
    environment: c.env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
  }),
);

// Billing Block 8 -- unversioned and outside /api/v1 for the same reason
// /health is: Stripe calls this unauthenticated and its own signature check
// is the security boundary, so it skips CORS/rate-limit/auth entirely
// rather than paying their cost or fighting a body-already-consumed
// conflict with global middleware. See stripe-webhook.routes.ts.
app.route('/webhooks/stripe', stripeWebhookRoutes);

const api = new Hono<{ Bindings: Bindings }>();

api.use('*', requestId());
api.use(
  '*',
  cors({
    // Reads the allow-list from ALLOWED_ORIGINS (config/env.ts's Bindings,
    // wrangler.toml's [vars]) instead of a hardcoded array -- a new
    // environment's origin is now a config edit + redeploy, not an
    // application-code change. Hono's cors() origin callback receives the
    // request Context as its second argument specifically so cases like
    // this can read c.env per request (confirmed against Hono's own docs,
    // 2026-07-11) -- this is NOT evaluated once at startup, so it always
    // reflects the currently-deployed value. Fails closed (empty allow-list,
    // not "allow everything") if ALLOWED_ORIGINS is ever unset.
    // Parsing moved to lib/allowed-origins.ts once the billing redirect
    // validator became a second consumer of this same list. Two independent
    // parsers of one security-relevant config value is a hole waiting to
    // open: an origin this layer rejects but that validator accepts.
    origin: (origin, c) => {
      const allowed = parseAllowedOrigins(c.env.ALLOWED_ORIGINS);
      return allowed.includes(origin) ? origin : null;
    },
    allowHeaders: ['Content-Type', 'Authorization', 'X-Business-Id', 'X-Branch-Id'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE'],
  }),
);
api.use('*', secureHeaders());
api.use('*', rateLimit('API_RATE_LIMITER'));
api.use('*', auditTrail);

api.route('/auth', authRoutes);
api.route('/businesses', businessRoutes);
api.route('/branches', branchRoutes);
// Continuing Development Block 4.3.1 (S5.3) -- a second file at the same
// prefix, same "two files, one prefix, split by concern" precedent as the
// platform/billing route pairs below. See visit-session.routes.ts's own
// doc comment for why this isn't folded into branchRoutes.
api.route('/branches', visitSessionRoutes);
api.route('/qr', qrRoutes);
api.route('/feedback', feedbackRoutes);
api.route('/customer-auth', customerAuthRoutes);
api.route('/loyalty', loyaltyRoutes);
api.route('/loyalty/me', loyaltyCustomerRoutes);
api.route('/analytics', analyticsRoutes);
api.route('/notifications', notificationsRoutes);
api.route('/messaging', messagingRoutes);
api.route('/messaging/me', messagingCustomerRoutes);
// Continuing Development Block 5.1 (S7.1 minimal manual review) -- reads
// fraud_signals (Block 3.1), which every detector since (3.2, 4.1, 4.3.2)
// has been writing to with no staff-facing surface until now.
api.route('/fraud-signals', fraudSignalRoutes);
api.route('/billing', billingRoutes);
// Platform Admin Console (Blocks 2-3) -- cross-tenant, gated by
// requirePlatformRole, not resolveTenantContext. Two files, one prefix each,
// matching the loyalty/loyalty-customer split's precedent of separate route
// files per concern within the same feature.
api.route('/platform/businesses', platformBusinessRoutes);
api.route('/platform/audit-log', platformAuditLogRoutes);
// Billing Block 10 -- two files, one prefix each, same split precedent as
// businesses/audit-log above.
api.route('/platform/billing/plans', platformBillingPlansRoutes);
api.route('/platform/billing/subscriptions', platformBillingSubscriptionsRoutes);

app.route('/api/v1', api);

/**
 * Queue consumer for `echo-grid-feedback-jobs` (binding `JOBS`) -- added in
 * Sentiment Analytics Block 2, extended in Notifications Block 2 to handle
 * `send_notification` alongside the two sentiment job types (see
 * config/env.ts's `PlatformJob` union). One shared DB connection per batch
 * (not per message) since Hyperdrive-fronted Postgres connections are fast
 * to open but not free; a batch of up to 10 messages (wrangler.toml) sharing
 * one connection matches how a single HTTP request already does the same
 * thing per createDb() call.
 *
 * Explicit per-message ack()/retry() (not batch-level) so one malformed or
 * genuinely-failing message never blocks the rest of the batch from
 * succeeding -- consistent with SentimentService already degrading a single
 * classification failure to analysisStatus='failed' rather than throwing
 * all the way up; retry() here is for transient infra failures (Workers AI
 * hiccup, DB connection drop, email/SMS provider outage), not classification
 * or delivery errors, which are already handled and acked as "processed,
 * marked failed."
 *
 * S4 roadmap Block 6 (S4.3 "retry with bounded exponential backoff") --
 * retry() now passes an explicit, growing delaySeconds (lib/backoff.ts)
 * instead of retrying immediately with Cloudflare Queues' bare default.
 * Applies uniformly to every job type through this one shared catch block,
 * not just generate_summary's Anthropic calls -- see this block's own
 * completion notes for why a per-job-type schedule isn't justified today.
 */
async function queue(batch: MessageBatch<PlatformJob>, env: Bindings, ctx: ExecutionContext): Promise<void> {
  const { db, close } = await createDb(env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    const sentimentService = createSentimentService(repos, env.AI);
    const summaryService = createSummaryService(repos, env.ENVIRONMENT, env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL, {
      // S4.2 spend-limit guardrails (Continuing Development S4, Block 1) --
      // raw wrangler [vars] are strings; parsed here, the one call site,
      // matching how ALLOWED_ORIGINS is also parsed at its point of use
      // rather than in config/env.ts.
      dailyLimitUsd: Number(env.ANTHROPIC_DAILY_SPEND_LIMIT_USD),
      monthlyLimitUsd: Number(env.ANTHROPIC_MONTHLY_SPEND_LIMIT_USD),
    });
    const notificationDelivery = new NotificationDeliveryService(
      repos,
      createEmailService(env.ENVIRONMENT, {
        apiKey: env.RESEND_API_KEY,
        fromAddress: env.RESEND_FROM_ADDRESS,
      }),
      createSmsService(env.ENVIRONMENT, {
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        fromNumber: env.TWILIO_FROM_NUMBER,
      }),
    );
    const notificationService = new NotificationService(repos, env.JOBS);

    for (const message of batch.messages) {
      try {
        if (message.body.type === 'classify_feedback') {
          await sentimentService.classifyAndStore(message.body.feedbackId, message.body.businessId);
        } else if (message.body.type === 'generate_summary') {
          // Sentiment Analytics Block 3 -- shares this consumer rather than
          // a second queue, since both job types are lightweight, bounded
          // background work off the same feedback data; a second queue
          // would be infrastructure duplication with no isolation benefit
          // at this platform's current scale.
          const periodStart = new Date(message.body.periodStart);
          const periodEnd = new Date(message.body.periodEnd);
          await summaryService.generateForPeriod({
            businessId: message.body.businessId,
            branchId: message.body.branchId,
            periodType: message.body.periodType,
            periodStart,
            periodEnd,
          });

          // Notifications Block 3 -- fires only after generateForPeriod has
          // actually persisted the new feedback_summaries row. Filtered to
          // analytics:view holders (Owner/Admin/Manager) -- Staff doesn't
          // hold that permission by default, matching the same exclusion
          // already enforced on the analytics API itself.
          const business = await repos.businesses.findById(message.body.businessId);
          if (business) {
            await notificationService.notifyBusinessStaff(
              message.body.businessId,
              {
                eventType: 'summary_ready',
                businessName: business.name,
                periodLabel: formatPeriodLabel(periodStart, periodEnd),
              },
              'analytics:view',
            );
          }
        } else if (message.body.type === 'send_notification') {
          // Notifications Block 2 -- same "shares this consumer, not a new
          // queue" reasoning as generate_summary above.
          await notificationDelivery.deliver(message.body);
        } else if (message.body.type === 'escalate_critical_incident') {
          // Automated Feedback Sorting -- the per-incident half of critical
          // escalation; the sweep that decides WHICH incidents qualify runs
          // in `scheduled` below. Re-notifies (escalated:true framing) then
          // marks escalated so the same incident is never re-enqueued by a
          // later sweep -- markEscalated's own WHERE escalatedAt IS NULL
          // guard also makes this whole branch idempotent against an
          // at-least-once redelivery of this exact message.
          const incident = await repos.criticalIncidents.findById(
            message.body.incidentId,
            message.body.businessId,
          );
          if (incident && !incident.escalatedAt) {
            const [branch, business] = await Promise.all([
              repos.branches.findById(incident.branchId, incident.businessId),
              repos.businesses.findById(incident.businessId),
            ]);
            if (branch && business) {
              await notificationService.notifyBusinessStaff(
                incident.businessId,
                {
                  eventType: 'critical_feedback_alert',
                  businessName: business.name,
                  branchName: branch.name,
                  matchedSignals: incident.matchedSignals,
                  escalated: true,
                },
                'feedback:manage',
              );
            }
            await repos.criticalIncidents.markEscalated(incident.id);
          }
        }
        message.ack();
      } catch (err) {
        console.error('Background job failed:', {
          messageId: message.id,
          jobType: message.body.type,
          attempt: message.attempts,
          error: err instanceof Error ? err.message : err,
        });
        message.retry({ delaySeconds: computeRetryDelaySeconds(message.attempts) });
      }
    }
  } finally {
    ctx.waitUntil(close());
  }
}

const CRON_PERIOD_MAP: Record<string, PeriodType> = {
  '0 0 * * *': 'daily',
  '0 0 * * 1': 'weekly',
  '0 0 1 * *': 'monthly',
};

// A P0_CRITICAL incident un­acknowledged this long gets escalated -- see
// critical-alert-job.ts. 15 minutes against a 5-minute sweep interval means
// an incident is checked 2-3 times before crossing the threshold, so a
// sweep that happens to run a little late never causes a premature
// escalation right at the boundary.
const CRITICAL_ESCALATION_CRON = '*/5 * * * *';
const ESCALATION_WINDOW_MINUTES = 15;

/**
 * S4 roadmap Block 9 (S4.3) -- how long an ai_usage_log row may sit
 * 'pending' before the sweep below treats it as abandoned.
 *
 * Deliberately its own constant rather than reusing
 * ESCALATION_WINDOW_MINUTES above, despite both being "15-ish minute"
 * windows on the same cron: that one encodes how long a *human* may take to
 * acknowledge an incident, this one how long a *machine* attempt could
 * still plausibly be in flight. They would drift apart for entirely
 * unrelated reasons, and sharing a constant would silently couple a
 * staffing decision to an infrastructure timeout.
 *
 * 30 minutes is roughly two orders of magnitude beyond any legitimate
 * attempt: generateForPeriod is five concurrent reads plus one Anthropic
 * call, and Cloudflare's own wall-clock ceiling for an invocation is far
 * below this anyway -- so a row this old cannot still be running, whatever
 * happened to it. Erring long costs only detection latency (the sweep runs
 * every 5 minutes regardless); erring short would risk marking a live
 * attempt abandoned and then having it resolve() afterwards, which the
 * `status = 'pending'` guard would reject, leaving a real success recorded
 * as abandoned and its cost permanently missing from the ledger.
 */
const STALE_PENDING_MINUTES = 30;

/**
 * Cron consumer (wrangler.toml [triggers]) -- fires the daily/weekly/monthly
 * automatic summary rollup, and separately the critical-incident escalation
 * sweep. Deliberately thin in both cases: it only enqueues jobs (paginating
 * through every business/incident so this scales past however many fit in
 * one page, per "design for global scale"); the actual work happens in
 * `queue` above, on the same retry/DLQ infrastructure as every other
 * background job, not a separate one-off code path.
 *
 * A day that matches more than one registered cron expression (e.g. every
 * Monday matches both "0 0 * * *" and "0 0 * * 1") correctly fires this
 * function once per matching expression, as separate invocations each with
 * their own `event.cron` -- not a conflict, and not de-duplicated: a Monday
 * genuinely produces both a daily and a weekly feedback_summaries row, by
 * design (S4.1 roadmap Block 3).
 */
async function scheduled(event: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
  if (event.cron === CRITICAL_ESCALATION_CRON) {
    // Two independent sweeps share this cron rather than registering a
    // fourth trigger -- both are cheap, neither depends on the other, and
    // "every 5 minutes" is already the right cadence for each. They are
    // deliberately NOT awaited together in one waitUntil: a failure in
    // either must not prevent the other from running, and Promise.all
    // would short-circuit on the first rejection.
    ctx.waitUntil(sweepUnacknowledgedCriticalIncidents(env));
    ctx.waitUntil(sweepStalePendingAiUsage(env));
    return;
  }

  const periodType = CRON_PERIOD_MAP[event.cron];
  if (!periodType) {
    console.error(`Unrecognized cron expression, skipping: ${event.cron}`);
    return;
  }

  const { periodStart, periodEnd } = computePeriodRange(periodType);
  const { db, close } = await createDb(env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    const PAGE_SIZE = 100;
    let offset = 0;

    for (;;) {
      const page = await repos.businesses.list({ limit: PAGE_SIZE, offset });
      if (page.length === 0) break;

      await Promise.all(
        page.map((business) =>
          enqueueSummaryGeneration(env.JOBS, {
            businessId: business.id,
            periodType,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
          }),
        ),
      );

      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  } finally {
    ctx.waitUntil(close());
  }
}

/**
 * S4 roadmap Block 9 (S4.3 "mark processing pending or failed"). Moves
 * ai_usage_log rows that have been 'pending' longer than
 * STALE_PENDING_MINUTES to the terminal 'abandoned' state.
 *
 * Block 7 made a killed-mid-flight attempt *visible* as a stuck 'pending'
 * row instead of leaving no trace; nothing yet made it *terminal*, which
 * this closes. Until now such a row stayed pending forever -- resolve() is
 * only reachable from inside the very invocation that died, and a queue
 * retry writes a fresh row rather than adopting the orphan.
 *
 * The count is logged rather than merely discarded because it is the only
 * observable measure of how much spend the ledger may be under-counting
 * (see ai-usage-log.ts's 'abandoned' note for why the cost itself is left
 * NULL rather than estimated). A steady zero is the expected state; a
 * sustained non-zero count means invocations are dying mid-flight and is
 * worth investigating on its own, independently of the summaries it
 * affects.
 *
 * No throw on failure: this runs inside waitUntil on a 5-minute cron, so a
 * transient database error simply means the next run picks up the same
 * rows -- they are, by definition, not going anywhere.
 */
async function sweepStalePendingAiUsage(env: Bindings): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_PENDING_MINUTES * 60 * 1000);
  const { db, close } = await createDb(env.HYPERDRIVE);
  try {
    const abandoned = await createRepositories(db).aiUsageLog.abandonStalePending(cutoff);
    if (abandoned > 0) {
      // Counts only -- no business/branch identifiers, matching this
      // codebase's existing caution about what reaches logs.
      console.warn(
        `Abandoned ${abandoned} ai_usage_log row(s) still pending after ${STALE_PENDING_MINUTES} minutes.`,
      );
    }
  } finally {
    await close();
  }
}

async function sweepUnacknowledgedCriticalIncidents(env: Bindings): Promise<void> {
  const cutoff = new Date(Date.now() - ESCALATION_WINDOW_MINUTES * 60 * 1000);
  const { db, close } = await createDb(env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    const overdue = await repos.criticalIncidents.findUnacknowledgedOlderThan(cutoff);
    await Promise.all(
      overdue.map((incident) =>
        enqueueEscalation(env.JOBS, { incidentId: incident.id, businessId: incident.businessId }),
      ),
    );
  } finally {
    await close();
  }
}

export default {
  fetch: app.fetch,
  queue,
  scheduled,
};
