import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { requestId } from 'hono/request-id';
import type { Bindings, PlatformJob } from './config/env';
import { errorHandler } from './lib/error-handler';
import { rateLimit } from './middleware/rate-limit';
import { auditTrail } from './middleware/audit';
import { authRoutes } from './auth/auth.routes';
import { businessRoutes } from './businesses/business.routes';
import { branchRoutes } from './branches/branch.routes';
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
import { createDb } from './db/client';
import { createRepositories } from './repositories';
import { createSentimentService } from './sentiment/sentiment.service';
import { createSummaryService } from './sentiment/summary.service';
import { enqueueSummaryGeneration } from './sentiment/sentiment-job';
import { computePeriodRange, formatPeriodLabel, type PeriodType } from './sentiment/period';
import { createEmailService } from './notifications/email.service';
import { createSmsService } from './customer-auth/sms.service';
import { NotificationDeliveryService } from './notifications/notification-delivery.service';
import { NotificationService } from './notifications/notification.service';

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
    origin: (origin, c) => {
      const allowed = (c.env.ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);
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
api.route('/qr', qrRoutes);
api.route('/feedback', feedbackRoutes);
api.route('/customer-auth', customerAuthRoutes);
api.route('/loyalty', loyaltyRoutes);
api.route('/loyalty/me', loyaltyCustomerRoutes);
api.route('/analytics', analyticsRoutes);
api.route('/notifications', notificationsRoutes);
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
 */
async function queue(batch: MessageBatch<PlatformJob>, env: Bindings, ctx: ExecutionContext): Promise<void> {
  const { db, close } = await createDb(env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    const sentimentService = createSentimentService(repos, env.AI);
    const summaryService = createSummaryService(
      repos,
      env.ENVIRONMENT,
      env.ANTHROPIC_API_KEY,
      env.ANTHROPIC_MODEL,
    );
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
        }
        message.ack();
      } catch (err) {
        console.error('Background job failed:', {
          messageId: message.id,
          jobType: message.body.type,
          error: err instanceof Error ? err.message : err,
        });
        message.retry();
      }
    }
  } finally {
    ctx.waitUntil(close());
  }
}

const CRON_PERIOD_MAP: Record<string, PeriodType> = {
  '0 0 * * 1': 'weekly',
  '0 0 1 * *': 'monthly',
};

/**
 * Cron consumer (wrangler.toml [triggers]) -- fires the weekly/monthly
 * automatic summary rollup. Deliberately thin: it only enqueues jobs
 * (paginating through every business so this scales past however many
 * businesses fit in one page, per "design for global scale"); the actual
 * LLM work happens in `queue` above, on the same retry/DLQ infrastructure
 * as every other background job, not a separate one-off code path.
 */
async function scheduled(event: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
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

export default {
  fetch: app.fetch,
  queue,
  scheduled,
};
