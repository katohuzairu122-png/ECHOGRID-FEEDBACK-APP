import { Hono, type Context } from 'hono';
import {
  joinLoyaltyProgramSchema,
  checkinSchema,
  redeemRewardSchema,
  updateNotificationPreferencesSchema,
  CUSTOMER_NOTIFICATION_EVENT_TYPES,
} from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import { createRepositories } from '../repositories';
import { customerAuthenticate, type CustomerAuthVariables } from '../middleware/customer-authenticate';
import { rateLimit } from '../middleware/rate-limit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { runInBackground } from '../lib/background-db';
import { QrCodeService } from '../qr/qr-code.service';
import {
  VelocityTracker,
  CHECKIN_DEVICE_VELOCITY,
  CHECKIN_IP_VELOCITY,
  CHECKIN_COOLDOWN_SECONDS,
} from '../fraud/velocity-tracker';
import { VisitSessionService } from '../visits/visit-session.service';
import { LoyaltyAccountService } from './loyalty-account.service';
import { LoyaltyRewardService } from './loyalty-reward.service';
import { LoyaltyRedemptionService } from './loyalty-redemption.service';
import { LoyaltyTierService } from './loyalty-tier.service';
import { NotificationService } from '../notifications/notification.service';

type Env = { Bindings: Bindings; Variables: CustomerAuthVariables };

/**
 * Customer-facing loyalty surface, mounted at /loyalty/me -- guarded by
 * customerAuthenticate (CUSTOMER_JWT_SECRET), never the staff authenticate/
 * resolveTenantContext pair. Also carries PUBLIC_RATE_LIMITER: a
 * compromised/leaked customer token shouldn't be able to hammer these
 * endpoints any harder than the anonymous QR surface can.
 */
export const loyaltyCustomerRoutes = new Hono<Env>();

loyaltyCustomerRoutes.use('*', customerAuthenticate, rateLimit('PUBLIC_RATE_LIMITER'));

async function withDb<T>(c: Context<Env>, fn: (db: Database) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await fn(db);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

loyaltyCustomerRoutes.get('/accounts', async (c) => {
  return withDb(c, async (db) => {
    const accounts = await new LoyaltyAccountService(db).listForCustomer(c.get('customerId'));
    return ok(c, accounts);
  });
});

loyaltyCustomerRoutes.get('/accounts/:businessId', async (c) => {
  return withDb(c, async (db) => {
    const summary = await new LoyaltyAccountService(db).getSummary(c.get('customerId'), c.req.param('businessId'));
    if (!summary) {
      throw new AppError('You are not enrolled in this loyalty program yet.', 404, 'LOYALTY_ACCOUNT_NOT_FOUND');
    }
    return ok(c, summary);
  });
});

loyaltyCustomerRoutes.post('/join', async (c) => {
  const body = await parseJsonBody(c.req.raw, joinLoyaltyProgramSchema);
  return withDb(c, async (db) => {
    const account = await new LoyaltyAccountService(db).enroll({
      customerId: c.get('customerId'),
      businessId: body.businessId,
    });
    return ok(c, account, 201);
  });
});

/** The one loyalty action reached via an anonymous QR token rather than a
 * businessId path param -- a customer scans the same physical code used for
 * feedback, so the token (not a business selection screen) is the natural
 * input here. */
loyaltyCustomerRoutes.post('/checkin', async (c) => {
  const body = await parseJsonBody(c.req.raw, checkinSchema);
  return withDb(c, async (db) => {
    const repos = createRepositories(db);
    const qrCode = await new QrCodeService(repos, {
      QR_TOKEN_SECRET: c.env.QR_TOKEN_SECRET,
      QR_TOKEN_SECRET_PREVIOUS: c.env.QR_TOKEN_SECRET_PREVIOUS,
    }).resolveToken(body.qrToken);
    const customerId = c.get('customerId');

    // Continuing Development Block 4.1 (S5.4/S5.5). Same velocity pattern as
    // qr.routes.ts's feedback submit -- see fraud/velocity-tracker.ts for why
    // this is a KV layer distinct from this router's own PUBLIC_RATE_LIMITER.
    const velocity = new VelocityTracker(c.env.CACHE, c.env.FRAUD_DETECTION_SALT);
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';

    const breach = await velocity.checkVelocity({
      eventType: 'loyalty_checkin',
      ip,
      deviceSignal: body.deviceSignal,
      deviceLimits: CHECKIN_DEVICE_VELOCITY,
      ipLimits: CHECKIN_IP_VELOCITY,
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
      throw new AppError('Too many check-in attempts. Please try again later.', 429, 'VELOCITY_LIMITED');
    }

    // Continuing Development Block 4.3.2 (S5.3 visit verification). Runs
    // once here, before the cooldown branch below (which has two different
    // exit paths -- early return on cooldown, or fall through to
    // recordCheckin) rather than after -- keeps this check independent of
    // which path check-in takes instead of duplicating it in both branches
    // or restructuring the existing cooldown return. Advisory only, same
    // "never blocks, log only the failure" reasoning as qr.routes.ts's own
    // feedback-submit wiring -- see that file's comment for the full
    // reasoning (no reward system exists yet for verification to gate).
    // feedbackId: null, matching every other fraud signal already recorded
    // on this route -- a check-in isn't feedback, there is no row to link.
    //
    // Block 5.2 (S5.7) reads the verified session id out of `metadata` and
    // carries it into recordCheckin below, for the one-reward-per-visit
    // dedup. `metadata` is `Record<string, unknown>` by design --
    // VisitVerificationResult is a provider-agnostic contract, see
    // visit-verification.ts's own doc comment -- so `sessionId` is narrowed
    // with a runtime `typeof` check rather than trusted as `string`; a
    // future provider that omits or reshapes it just leaves visitSessionId
    // undefined instead of throwing.
    let visitSessionId: string | undefined;
    if (body.visitProof) {
      const verification = await new VisitSessionService(repos).verify(
        qrCode.businessId,
        qrCode.branchId,
        body.visitProof,
      );
      if (verification.verified) {
        const sessionId = verification.metadata?.sessionId;
        visitSessionId = typeof sessionId === 'string' ? sessionId : undefined;
      } else {
        await repos.fraudSignals.create({
          businessId: qrCode.businessId,
          branchId: qrCode.branchId,
          feedbackId: null,
          signalType: 'visit_verification',
          reasonCode: verification.reasonCode ?? 'invalid_or_expired',
          severity: 'low',
          metadata: { proof: body.visitProof },
        });
      }
    }

    // Cooldown IS enforced here, unlike feedback's signal-only cooldown --
    // see CHECKIN_COOLDOWN_SECONDS's doc comment: check-in points are real,
    // already-live value today (unlike feedback, which has no reward yet to
    // withhold), so a rapid repeat scan must not mint more of them. Keyed by
    // customerId, not device -- this is the one call site with an actual
    // verified identity (customerAuthenticate), and the real fraud pattern
    // is "the same loyalty member scanning repeatedly," not "the same
    // device" (a shared family device checking in two different members'
    // accounts back to back is legitimate and must not cool either down).
    // Scoped to branchId, not businessId (S5.5 lists branch as its own
    // cooldown dimension) -- a customer checking in at a DIFFERENT branch of
    // the same multi-branch business a few hours later is a genuinely
    // separate real visit and must not be suppressed by the first branch's
    // cooldown; only a repeat scan at the SAME branch should cool down.
    const cooldown = await velocity.checkAndStartCooldown({
      eventType: 'loyalty_checkin',
      subjectValue: `${customerId}:${qrCode.branchId}`,
      windowSeconds: CHECKIN_COOLDOWN_SECONDS,
    });

    if (cooldown.inCooldown) {
      const existing = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, qrCode.businessId);
      if (!existing) {
        // Unreachable in the normal flow -- an active cooldown can only
        // exist once an earlier check-in REQUEST already reached the
        // recordCheckin call below and that transaction committed,
        // auto-enrolling this customer. Fails closed instead of silently
        // falling through to recordCheckin (which would just award points
        // anyway, defeating the point of the cooldown) on the narrow chance
        // the KV cooldown key outlived a rolled-back DB transaction.
        throw new AppError('Loyalty account not found.', 404, 'LOYALTY_ACCOUNT_NOT_FOUND');
      }
      await repos.fraudSignals.create({
        businessId: qrCode.businessId,
        branchId: qrCode.branchId,
        feedbackId: null,
        signalType: 'cooldown',
        reasonCode: 'checkin_cooldown',
        severity: 'low',
        metadata: { customerId, windowSeconds: CHECKIN_COOLDOWN_SECONDS },
      });
      return ok(c, existing);
    }

    const account = await new LoyaltyAccountService(db).recordCheckin(
      customerId,
      qrCode.businessId,
      qrCode.id,
      visitSessionId,
    );
    return ok(c, account);
  });
});

/** Tier ladder for a business -- the customer app needs this to render "N
 * points to Gold" progress, not just the account's currently-assigned tier.
 * No permission gate (unlike the staff GET /loyalty/tiers) since any
 * authenticated customer viewing their own account should see the full
 * ladder they're progressing through. */
loyaltyCustomerRoutes.get('/tiers/:businessId', async (c) => {
  return withDb(c, async (db) => {
    const tiers = await new LoyaltyTierService(createRepositories(db)).list(c.req.param('businessId'));
    return ok(c, tiers);
  });
});

loyaltyCustomerRoutes.get('/rewards/:businessId', async (c) => {
  return withDb(c, async (db) => {
    const rewards = await new LoyaltyRewardService(createRepositories(db)).list(c.req.param('businessId'));
    return ok(c, rewards);
  });
});

loyaltyCustomerRoutes.post('/accounts/:businessId/redeem', async (c) => {
  const body = await parseJsonBody(c.req.raw, redeemRewardSchema);
  const businessId = c.req.param('businessId');
  return withDb(c, async (db) => {
    const result = await new LoyaltyRedemptionService(db).redeem(c.get('customerId'), businessId, body.rewardId);

    // Notify STAFF, not the customer -- a staff member needs to know a code
    // is waiting to be confirmed at the counter. Same "after the redeem()
    // transaction has committed" ordering as every other trigger in this
    // module. loyalty:manage is held by all four default roles (including
    // Staff -- confirming a redemption is a front-counter task), so no
    // permission filter narrows this broadcast. Uses its own fresh
    // connection (runInBackground), not the outer `repos` -- see that
    // helper's doc comment for why reusing it races withDb's own close().
    c.executionCtx.waitUntil(
      runInBackground(c.env.HYPERDRIVE, async (repos) => {
        const [reward, business] = await Promise.all([
          repos.loyaltyRewards.findById(body.rewardId, businessId),
          repos.businesses.findById(businessId),
        ]);
        if (!reward || !business) return;
        const notifications = new NotificationService(repos, c.env.JOBS);
        await notifications.notifyBusinessStaff(businessId, {
          eventType: 'redemption_pending',
          businessName: business.name,
          rewardName: reward.name,
          redemptionCode: result.redemptionCode,
        });
      }),
    );

    return ok(c, result, 201);
  });
});

// ---- Notification preferences (Notifications Block 4) ---------------------
// Self-service, no permission concept for customers (there is no RBAC on
// this identity system at all, see ARCHITECTURE.md's Multi-Tenancy Model) --
// any authenticated customer manages their own preferences, scoped per
// business the same way loyalty accounts already are.

loyaltyCustomerRoutes.get('/notification-preferences/:businessId', async (c) => {
  return withDb(c, async (db) => {
    const repos = createRepositories(db);
    const service = new NotificationService(repos, c.env.JOBS);
    const preferences = await service.listMaterializedPreferences(
      c.req.param('businessId'),
      { customerId: c.get('customerId') },
      CUSTOMER_NOTIFICATION_EVENT_TYPES,
    );
    return ok(c, preferences);
  });
});

loyaltyCustomerRoutes.patch('/notification-preferences/:businessId', async (c) => {
  const body = await parseJsonBody(c.req.raw, updateNotificationPreferencesSchema);
  const businessId = c.req.param('businessId');
  return withDb(c, async (db) => {
    const repos = createRepositories(db);
    const recipient = { customerId: c.get('customerId') };

    for (const pref of body.preferences) {
      await repos.notificationPreferences.setPreference(
        businessId,
        recipient,
        pref.eventType,
        pref.channel,
        pref.enabled,
      );
    }

    const service = new NotificationService(repos, c.env.JOBS);
    const preferences = await service.listMaterializedPreferences(
      businessId,
      recipient,
      CUSTOMER_NOTIFICATION_EVENT_TYPES,
    );
    return ok(c, preferences);
  });
});
