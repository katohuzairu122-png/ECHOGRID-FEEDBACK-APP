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
    const qrCode = await new QrCodeService(repos).resolveToken(body.qrToken);
    const account = await new LoyaltyAccountService(db).recordCheckin(
      c.get('customerId'),
      qrCode.businessId,
      qrCode.id,
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
