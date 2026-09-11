import { Hono } from 'hono';
import { submitFeedbackSchema, generateFollowUpQuestionSchema } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { rateLimit } from '../middleware/rate-limit';
import { QrCodeService } from './qr-code.service';
import { FeedbackService } from '../feedback/feedback.service';
import { createFollowUpQuestionGenerator } from '../feedback/follow-up-question-generator';
import { enqueueClassification } from '../sentiment/sentiment-job';
import { NotificationService } from '../notifications/notification.service';
import { runInBackground } from '../lib/background-db';
import {
  VelocityTracker,
  FEEDBACK_DEVICE_VELOCITY,
  FEEDBACK_IP_VELOCITY,
  FEEDBACK_COOLDOWN_SECONDS,
} from '../fraud/velocity-tracker';
import {
  shouldRaiseDuplicateTextSignal,
  duplicateTextSeverity,
  DUPLICATE_TEXT_SIGNAL_TYPE,
  DUPLICATE_TEXT_REASON_CODE,
} from '../fraud/duplicate-text-signal';
import {
  shouldRaiseNearDuplicateSignal,
  nearDuplicateSeverity,
  NEAR_DUPLICATE_SIGNAL_TYPE,
  NEAR_DUPLICATE_REASON_CODE,
} from '../fraud/near-duplicate';
import { VisitSessionService } from '../visits/visit-session.service';

/**
 * The platform's only fully anonymous write surface -- no authenticate /
 * resolveTenantContext anywhere in this file, matched with the stricter
 * PUBLIC_RATE_LIMITER stacked on top of index.ts's global API_RATE_LIMITER
 * (same stacking pattern auth.routes.ts uses for signup/login). Reached
 * exclusively through the web app's Server Actions (BFF pattern), never
 * called directly from a browser.
 */
export const qrRoutes = new Hono<{ Bindings: Bindings }>();

qrRoutes.use('*', rateLimit('PUBLIC_RATE_LIMITER'));

qrRoutes.get('/:token', async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    const qrCode = await new QrCodeService(repos, {
      QR_TOKEN_SECRET: c.env.QR_TOKEN_SECRET,
      QR_TOKEN_SECRET_PREVIOUS: c.env.QR_TOKEN_SECRET_PREVIOUS,
    }).resolveToken(c.req.param('token'));

    const [branch, business] = await Promise.all([
      repos.branches.findById(qrCode.branchId, qrCode.businessId),
      repos.businesses.findById(qrCode.businessId),
    ]);
    // Same check-and-404 pattern every other lookup in this codebase uses
    // (e.g. BranchService.getBranch). FK cascades make branch/business
    // being missing here practically unreachable, but the check is also
    // what satisfies the type checker on findById's T | undefined return
    // without a non-null assertion.
    if (!branch || !business) {
      throw new AppError('This QR code is no longer valid.', 404, 'QR_CODE_NOT_FOUND');
    }

    return ok(c, {
      branchId: branch.id,
      branchName: branch.name,
      businessName: business.name,
      defaultLocale: business.defaultLocale,
      defaultCurrency: business.defaultCurrency,
      defaultTimezone: business.defaultTimezone,
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * Stateless -- no DB write. Given the rating+comment the customer already
 * entered, returns ONE AI-generated follow-up question to show before they
 * submit. Errors bubble to the global errorHandler like every other route;
 * the *client* action (apps/web) is what swallows failure, so the customer
 * is never blocked by an Anthropic outage or a rate limit here -- the
 * follow-up is a nice-to-have, never a blocker. Guarded by its own rate
 * limit (stacked on top of this router's PUBLIC_RATE_LIMITER) since every
 * successful call is a real Anthropic API charge, unlike a free submission.
 */
qrRoutes.post('/:token/follow-up-question', rateLimit('FOLLOWUP_QUESTION_RATE_LIMITER'), async (c) => {
  const body = await parseJsonBody(c.req.raw, generateFollowUpQuestionSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    // Same token-validity check every other route on this router performs --
    // keeps a revoked/expired QR code from triggering a paid Anthropic call
    // for a link nobody should be able to submit through anymore.
    await new QrCodeService(repos, {
      QR_TOKEN_SECRET: c.env.QR_TOKEN_SECRET,
      QR_TOKEN_SECRET_PREVIOUS: c.env.QR_TOKEN_SECRET_PREVIOUS,
    }).resolveToken(c.req.param('token'));

    const generator = createFollowUpQuestionGenerator(c.env.ENVIRONMENT, c.env.ANTHROPIC_API_KEY, c.env.ANTHROPIC_MODEL);
    const result = await generator.generate({ rating: body.rating, comment: body.comment });
    return ok(c, result);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

qrRoutes.post('/:token/feedback', async (c) => {
  const body = await parseJsonBody(c.req.raw, submitFeedbackSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    const qrCode = await new QrCodeService(repos, {
      QR_TOKEN_SECRET: c.env.QR_TOKEN_SECRET,
      QR_TOKEN_SECRET_PREVIOUS: c.env.QR_TOKEN_SECRET_PREVIOUS,
    }).resolveToken(c.req.param('token'));

    // Continuing Development Block 4.1 (S5.4 device/IP velocity, S5.5
    // cooldown) -- deliberately placed AFTER resolveToken (needs a trusted
    // qrCode.businessId/branchId to scope fraud_signals) and BEFORE
    // FeedbackService.submit (a velocity breach must reject before any
    // feedback row exists, same "reject before feedback exists" precedent
    // fraud-signals.ts's own doc comment already establishes for QR-token
    // rejection). See fraud/velocity-tracker.ts for why this is a KV-backed
    // layer distinct from PUBLIC_RATE_LIMITER above.
    const velocity = new VelocityTracker(c.env.CACHE, c.env.FRAUD_DETECTION_SALT);
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';

    const breach = await velocity.checkVelocity({
      eventType: 'feedback_submit',
      ip,
      deviceSignal: body.deviceSignal,
      deviceLimits: FEEDBACK_DEVICE_VELOCITY,
      ipLimits: FEEDBACK_IP_VELOCITY,
    });
    if (breach) {
      await repos.fraudSignals.create({
        businessId: qrCode.businessId,
        branchId: qrCode.branchId,
        feedbackId: null,
        signalType: 'velocity',
        reasonCode: `${breach.subjectType}_velocity_exceeded`,
        severity: 'medium',
        metadata: {
          subjectType: breach.subjectType,
          subjectHash: breach.subjectHash,
          count: breach.count,
          windowSeconds: breach.windowSeconds,
          threshold: breach.threshold,
        },
      });
      throw new AppError('Too many submissions. Please try again later.', 429, 'VELOCITY_LIMITED');
    }

    // Cooldown is signal-only for feedback (S5.5: "may be stored but must
    // not automatically generate another reward") -- there is no reward yet
    // to withhold, so this never blocks. Only checked when a deviceSignal
    // was actually supplied; there is nothing meaningful to key a
    // per-device cooldown on otherwise (IP is deliberately excluded here --
    // an IP-only cooldown would suppress every OTHER customer on the same
    // shared WiFi, not just the repeat submitter). Recorded against the
    // feedback row below once it exists, not here -- see fraud_signals'
    // own schema comment on why a signal prefers a feedbackId when one is
    // available.
    const cooldown = body.deviceSignal
      ? await velocity.checkAndStartCooldown({
          eventType: 'feedback_submit',
          subjectValue: `${body.deviceSignal}:${qrCode.branchId}`,
          windowSeconds: FEEDBACK_COOLDOWN_SECONDS,
        })
      : null;

    // Continuing Development S5-C. Hashed here rather than inside the
    // service because hashing needs the velocity salt from the environment,
    // and the same salted value already keys the KV velocity counters above
    // -- one hashing convention, not two. Only meaningful when the client
    // actually sent a deviceSignal.
    const deviceHash = body.deviceSignal ? await velocity.hashSubject(body.deviceSignal) : undefined;

    const created = await new FeedbackService(repos).submit(qrCode, body, { deviceHash });

    if (cooldown?.inCooldown) {
      // Awaited directly on the outer `repos`, NOT backgrounded via
      // waitUntil -- unlike the notification blocks below, which
      // deliberately open their own fresh connection (runInBackground) for
      // exactly this reason: this handler's own `finally` also
      // waitUntil's this same connection's close(), and a backgrounded
      // write here could race that close(). One small INSERT is cheap
      // enough to just await before responding.
      await repos.fraudSignals.create({
        businessId: qrCode.businessId,
        branchId: qrCode.branchId,
        feedbackId: created.id,
        signalType: 'cooldown',
        reasonCode: 'feedback_cooldown',
        severity: 'low',
        metadata: { subjectHash: cooldown.subjectHash, windowSeconds: FEEDBACK_COOLDOWN_SECONDS },
      });
    }

    // Continuing Development S5-B (S5.6 "fraud reason codes and
    // manual-review routing"). S5-A recorded HOW OFTEN this exact text has
    // been submitted at this branch; this is the first code to act on it.
    //
    // Raised here rather than inside FeedbackService.submit for the same
    // reason the cooldown block above is: the service stays Repositories-
    // shaped around only `feedback`/`criticalIncidents` so its unit tests
    // keep using in-memory fakes (see feedback.service.ts's own note), and
    // this route already owns the "signal against the row that was just
    // created" pattern for two other detectors.
    //
    // Awaited on the outer `repos` for the reason spelled out in the
    // cooldown block: this handler's `finally` waitUntil's this connection's
    // close(), so a backgrounded write could race it.
    if (shouldRaiseDuplicateTextSignal(created.duplicateTextCount)) {
      await repos.fraudSignals.create({
        businessId: qrCode.businessId,
        branchId: qrCode.branchId,
        feedbackId: created.id,
        signalType: DUPLICATE_TEXT_SIGNAL_TYPE,
        reasonCode: DUPLICATE_TEXT_REASON_CODE,
        severity: duplicateTextSeverity(created.duplicateTextCount),
        // normalizedTextHash, never the comment itself: it lets a reviewer
        // group every signal sharing one piece of text without this
        // append-only log holding a second copy of customer prose (S4.2's
        // data-minimization principle, applied to fraud metadata too). The
        // comment is one join away on the feedback row if a reviewer needs
        // to read it.
        metadata: {
          duplicateTextCount: created.duplicateTextCount,
          normalizedTextHash: created.normalizedTextHash,
        },
      });
    }

    // Continuing Development S5-C (S5.6 near-duplicate + repeated-template
    // detection). Suppressed when the exact-text signal above already fired:
    // an exact duplicate is also, trivially, a near-duplicate, and two
    // fraud_signals rows describing one finding would double-count the
    // review queue S5-B just created. The exact signal is the more specific
    // of the two, so it wins.
    if (
      !shouldRaiseDuplicateTextSignal(created.duplicateTextCount) &&
      shouldRaiseNearDuplicateSignal(created.nearDuplicateCount)
    ) {
      await repos.fraudSignals.create({
        businessId: qrCode.businessId,
        branchId: qrCode.branchId,
        feedbackId: created.id,
        signalType: NEAR_DUPLICATE_SIGNAL_TYPE,
        reasonCode: NEAR_DUPLICATE_REASON_CODE,
        severity: nearDuplicateSeverity(created.nearDuplicateCount),
        // The salted device hash, never the raw signal, and no comment text
        // -- a reviewer needs to know WHICH device repeated itself and how
        // often, and can read the comments from the feedback rows themselves
        // (S4.2 data minimization, same rule the duplicate-text signal
        // follows).
        metadata: {
          nearDuplicateCount: created.nearDuplicateCount,
          deviceHash: created.deviceHash,
        },
      });
    }

    // Continuing Development Block 4.3.2 (S5.3 visit verification).
    // Advisory only, same "signal-only" precedent as the cooldown block
    // just above: nothing today withholds a reward on a failed or missing
    // proof -- no reward system exists yet (S5.7/S6 are Blocks 5 and
    // 10-14) -- so this never blocks submission, whatever the outcome.
    // Only the FAILURE case is recorded, matching velocity/cooldown's own
    // "log the exceptional case, stay silent otherwise" convention.
    // Recorded against the feedback row (feedbackId: created.id), not
    // pre-submission, for the same reason the cooldown signal above is:
    // fraud_signals' own schema comment prefers a feedbackId when one is
    // available. `metadata.proof` stores the code as-is, unlike
    // device/IP -- S5.4's salted-hashing requirement is scoped to those
    // identifying fingerprints, and a visit-session code is already
    // plain-text everywhere else it's stored (visit_sessions.code), so
    // there's nothing to redact and real value in a reviewer being able to
    // see which code was attempted.
    if (body.visitProof) {
      const verification = await new VisitSessionService(repos).verify(
        qrCode.businessId,
        qrCode.branchId,
        body.visitProof,
      );
      if (!verification.verified) {
        await repos.fraudSignals.create({
          businessId: qrCode.businessId,
          branchId: qrCode.branchId,
          feedbackId: created.id,
          signalType: 'visit_verification',
          reasonCode: verification.reasonCode ?? 'invalid_or_expired',
          severity: 'low',
          metadata: { proof: body.visitProof },
        });
      }
    }

    // Fire-and-forget: classification is background work, never something
    // the customer's own submit response waits on. waitUntil keeps the
    // Worker alive long enough to actually send after the response returns.
    c.executionCtx.waitUntil(enqueueClassification(c.env.JOBS, created.id, created.businessId));

    // Notification trigger runs AFTER submit() has already succeeded and
    // committed, never inside it -- FeedbackService.submit isn't
    // transaction-owning, but this ordering is the same principle applied
    // everywhere a notification follows a write in this module: never risk
    // notifying about something that didn't actually happen. Broadcasts to
    // every active staff member -- feedback:view is held by all four
    // default roles, so no permission filter narrows this one. Uses its own
    // fresh connection (runInBackground), not the outer `repos` -- see that
    // helper's doc comment for why reusing it races withDb's own close().
    c.executionCtx.waitUntil(
      runInBackground(c.env.HYPERDRIVE, async (repos) => {
        const [branch, business] = await Promise.all([
          repos.branches.findById(qrCode.branchId, qrCode.businessId),
          repos.businesses.findById(qrCode.businessId),
        ]);
        if (!branch || !business) return;
        const notifications = new NotificationService(repos, c.env.JOBS);
        await notifications.notifyBusinessStaff(qrCode.businessId, {
          eventType: 'feedback_received',
          businessName: business.name,
          branchName: branch.name,
          rating: created.rating,
          comment: created.comment ?? undefined,
        });
      }),
    );

    // Critical-feedback alert -- separate from the feedback_received
    // broadcast above: this one is filtered to feedback:manage holders
    // (Owner/Admin/Manager, not Staff), matching the spec's "alert
    // authorized branch or business managers." Fires only when
    // FeedbackService.submit's synchronous Level 1 detection already
    // flagged this row P0_CRITICAL -- never waits on Level 2's async AI
    // classification. Own fresh connection, same runInBackground reasoning
    // as the block above.
    if (created.urgency === 'P0_CRITICAL') {
      c.executionCtx.waitUntil(
        runInBackground(c.env.HYPERDRIVE, async (repos) => {
          const [branch, business, incident] = await Promise.all([
            repos.branches.findById(qrCode.branchId, qrCode.businessId),
            repos.businesses.findById(qrCode.businessId),
            repos.criticalIncidents.findByFeedbackId(created.id, qrCode.businessId),
          ]);
          if (!branch || !business) return;
          const notifications = new NotificationService(repos, c.env.JOBS);
          await notifications.notifyBusinessStaff(
            qrCode.businessId,
            {
              eventType: 'critical_feedback_alert',
              businessName: business.name,
              branchName: branch.name,
              matchedSignals: incident?.matchedSignals ?? 'unspecified',
            },
            'feedback:manage',
          );
        }),
      );
    }

    return ok(c, { id: created.id }, 201);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
