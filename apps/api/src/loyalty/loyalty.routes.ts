import { Hono, type Context } from 'hono';
import {
  recordPurchaseSchema,
  adjustPointsSchema,
  createTierSchema,
  updateTierSchema,
  createRewardSchema,
  updateRewardSchema,
  updateLoyaltySettingsSchema,
} from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import { createRepositories, type LoyaltySettings } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requirePermission } from '../middleware/require-permission';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { LoyaltyAccountService } from './loyalty-account.service';
import { LoyaltyTierService } from './loyalty-tier.service';
import { LoyaltyRewardService } from './loyalty-reward.service';
import { LoyaltyRedemptionService } from './loyalty-redemption.service';
import { NotificationService } from '../notifications/notification.service';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & TenantVariables & AuditVariables;
};

/**
 * Staff-facing loyalty management -- every route needs tenant context, same
 * shape as feedbackRoutes/branchRoutes. Split from loyalty-customer.routes.ts
 * (mounted separately at /loyalty/me) because the two use entirely different
 * auth: staff JWT + RBAC here, customer JWT there.
 */
export const loyaltyRoutes = new Hono<Env>();

loyaltyRoutes.use('*', authenticate, resolveTenantContext);

async function withDb<T>(c: Context<Env>, fn: (db: Database) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await fn(db);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

// ---- Accounts & points engine (Block 3) ---------------------------------

loyaltyRoutes.get('/accounts', requirePermission('loyalty:view'), async (c) => {
  const url = new URL(c.req.url);
  const limit = Number(url.searchParams.get('limit')) || undefined;
  const offset = Number(url.searchParams.get('offset')) || undefined;
  return withDb(c, async (db) => {
    const items = await new LoyaltyAccountService(db).listForBusiness(c.get('businessId'), { limit, offset });
    return ok(c, items);
  });
});

loyaltyRoutes.get('/accounts/:id', requirePermission('loyalty:view'), async (c) => {
  return withDb(c, async (db) => {
    const account = await new LoyaltyAccountService(db).getAccount(c.req.param('id'), c.get('businessId'));
    return ok(c, account);
  });
});

loyaltyRoutes.get('/accounts/:id/transactions', requirePermission('loyalty:view'), async (c) => {
  const url = new URL(c.req.url);
  const limit = Number(url.searchParams.get('limit')) || undefined;
  const offset = Number(url.searchParams.get('offset')) || undefined;
  return withDb(c, async (db) => {
    const items = await new LoyaltyAccountService(db).listTransactions(
      c.get('businessId'),
      c.req.param('id'),
      { limit, offset },
    );
    return ok(c, items);
  });
});

loyaltyRoutes.post('/accounts/:id/purchase', requirePermission('loyalty:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, recordPurchaseSchema);
  return withDb(c, async (db) => {
    const businessId = c.get('businessId');
    const accountId = c.req.param('id');
    const repos = createRepositories(db);

    // Fetched BEFORE the mutation so the tier comparison below has a real
    // "before" to compare against -- LoyaltyAccountService's return value is
    // only the "after" state, and tier-change detection needs both.
    const before = await new LoyaltyAccountService(db).getAccount(accountId, businessId);
    const account = await new LoyaltyAccountService(db).recordPurchase(
      businessId,
      accountId,
      body.purchaseAmount,
      c.get('userId'),
    );
    c.set('auditMetadata', { action: 'loyalty.purchase_recorded', entityType: 'loyalty_account', entityId: account.id });

    // Notification triggers run AFTER recordPurchase's own transaction has
    // committed, never inside it -- LoyaltyAccountService owns a
    // db.transaction() directly (see its own class comment), and enqueueing
    // to an external queue has no atomicity with that transaction. Firing
    // here means we only ever notify about a purchase that really landed.
    const pointsEarned = account.points - before.points;
    c.executionCtx.waitUntil(
      (async () => {
        const business = await repos.businesses.findById(businessId);
        if (!business || pointsEarned <= 0) return;
        const notifications = new NotificationService(repos, c.env.JOBS);
        await notifications.notify(
          businessId,
          { customerId: account.customerId },
          { eventType: 'points_earned', businessName: business.name, pointsEarned, newBalance: account.points },
        );
        if (account.tierId && account.tierId !== before.tierId) {
          const tier = await repos.loyaltyTiers.findById(account.tierId, businessId);
          if (tier) {
            await notifications.notify(
              businessId,
              { customerId: account.customerId },
              { eventType: 'tier_upgraded', businessName: business.name, tierName: tier.name },
            );
          }
        }
      })(),
    );

    return ok(c, account);
  });
});

loyaltyRoutes.post('/accounts/:id/adjust', requirePermission('loyalty:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, adjustPointsSchema);
  return withDb(c, async (db) => {
    const account = await new LoyaltyAccountService(db).adjustPoints(
      c.get('businessId'),
      c.req.param('id'),
      body.points,
      body.notes,
      c.get('userId'),
    );
    c.set('auditMetadata', { action: 'loyalty.points_adjusted', entityType: 'loyalty_account', entityId: account.id });
    return ok(c, account);
  });
});

// ---- Program settings (Block 3) ------------------------------------------

// Drizzle types `numeric` columns as string (arbitrary precision, no float
// rounding surprises), but shared-types' loyaltySettingsSchema promises
// callers a number -- this boundary is where that conversion happens, once,
// rather than every frontend caller re-parsing pointsPerCurrencyUnit itself.
function serializeSettings(settings: LoyaltySettings) {
  return { ...settings, pointsPerCurrencyUnit: Number(settings.pointsPerCurrencyUnit) };
}

loyaltyRoutes.get('/settings', requirePermission('loyalty:view'), async (c) => {
  return withDb(c, async (db) => {
    const settings = await createRepositories(db).loyaltySettings.getOrCreateDefaults(c.get('businessId'));
    return ok(c, serializeSettings(settings));
  });
});

loyaltyRoutes.patch('/settings', requirePermission('rewards:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, updateLoyaltySettingsSchema);
  return withDb(c, async (db) => {
    const settings = await createRepositories(db).loyaltySettings.update(
      c.get('businessId'),
      { ...body, pointsPerCurrencyUnit: body.pointsPerCurrencyUnit?.toString() },
      c.get('userId'),
    );
    c.set('auditMetadata', { action: 'loyalty.settings_updated', entityType: 'loyalty_settings', entityId: settings.id });
    return ok(c, serializeSettings(settings));
  });
});

// ---- Tiers (Block 4 -- program configuration) -----------------------------

loyaltyRoutes.get('/tiers', requirePermission('loyalty:view'), async (c) => {
  return withDb(c, async (db) => {
    const tiers = await new LoyaltyTierService(createRepositories(db)).list(c.get('businessId'));
    return ok(c, tiers);
  });
});

loyaltyRoutes.post('/tiers', requirePermission('rewards:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, createTierSchema);
  return withDb(c, async (db) => {
    const tier = await new LoyaltyTierService(createRepositories(db)).create(c.get('businessId'), body, c.get('userId'));
    c.set('auditMetadata', { action: 'loyalty.tier_created', entityType: 'loyalty_tier', entityId: tier.id });
    return ok(c, tier, 201);
  });
});

loyaltyRoutes.patch('/tiers/:id', requirePermission('rewards:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, updateTierSchema);
  return withDb(c, async (db) => {
    const tier = await new LoyaltyTierService(createRepositories(db)).update(
      c.req.param('id'),
      c.get('businessId'),
      body,
      c.get('userId'),
    );
    c.set('auditMetadata', { action: 'loyalty.tier_updated', entityType: 'loyalty_tier', entityId: tier.id });
    return ok(c, tier);
  });
});

loyaltyRoutes.delete('/tiers/:id', requirePermission('rewards:manage'), async (c) => {
  const id = c.req.param('id');
  return withDb(c, async (db) => {
    await new LoyaltyTierService(createRepositories(db)).remove(id, c.get('businessId'), c.get('userId'));
    c.set('auditMetadata', { action: 'loyalty.tier_removed', entityType: 'loyalty_tier', entityId: id });
    return c.body(null, 204);
  });
});

// ---- Rewards (Block 4) -----------------------------------------------------

loyaltyRoutes.get('/rewards', requirePermission('loyalty:view'), async (c) => {
  return withDb(c, async (db) => {
    const rewards = await new LoyaltyRewardService(createRepositories(db)).list(c.get('businessId'), {
      includeInactive: true,
    });
    return ok(c, rewards);
  });
});

loyaltyRoutes.post('/rewards', requirePermission('rewards:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, createRewardSchema);
  return withDb(c, async (db) => {
    const reward = await new LoyaltyRewardService(createRepositories(db)).create(c.get('businessId'), body, c.get('userId'));
    c.set('auditMetadata', { action: 'loyalty.reward_created', entityType: 'loyalty_reward', entityId: reward.id });
    return ok(c, reward, 201);
  });
});

loyaltyRoutes.patch('/rewards/:id', requirePermission('rewards:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, updateRewardSchema);
  return withDb(c, async (db) => {
    const reward = await new LoyaltyRewardService(createRepositories(db)).update(
      c.req.param('id'),
      c.get('businessId'),
      body,
      c.get('userId'),
    );
    c.set('auditMetadata', { action: 'loyalty.reward_updated', entityType: 'loyalty_reward', entityId: reward.id });
    return ok(c, reward);
  });
});

loyaltyRoutes.delete('/rewards/:id', requirePermission('rewards:manage'), async (c) => {
  const id = c.req.param('id');
  return withDb(c, async (db) => {
    await new LoyaltyRewardService(createRepositories(db)).remove(id, c.get('businessId'), c.get('userId'));
    c.set('auditMetadata', { action: 'loyalty.reward_removed', entityType: 'loyalty_reward', entityId: id });
    return c.body(null, 204);
  });
});

// ---- Redemption confirmation (Block 4) -------------------------------------

loyaltyRoutes.get('/redemptions/:code', requirePermission('loyalty:view'), async (c) => {
  return withDb(c, async (db) => {
    const transaction = await new LoyaltyRedemptionService(db).lookup(c.get('businessId'), c.req.param('code'));
    return ok(c, transaction);
  });
});

loyaltyRoutes.post('/redemptions/:code/confirm', requirePermission('loyalty:manage'), async (c) => {
  const businessId = c.get('businessId');
  return withDb(c, async (db) => {
    const repos = createRepositories(db);
    const transaction = await new LoyaltyRedemptionService(db).confirmRedemption(businessId, c.req.param('code'));
    c.set('auditMetadata', { action: 'loyalty.redemption_confirmed', entityType: 'loyalty_transaction', entityId: transaction.id });

    // Same "after commit, not inside the service's transaction" ordering as
    // the purchase handler above.
    c.executionCtx.waitUntil(
      (async () => {
        if (!transaction.relatedRewardId) return;
        const [account, reward, business] = await Promise.all([
          repos.loyaltyAccounts.findById(transaction.loyaltyAccountId, businessId),
          repos.loyaltyRewards.findById(transaction.relatedRewardId, businessId),
          repos.businesses.findById(businessId),
        ]);
        if (!account || !reward || !business) return;
        const notifications = new NotificationService(repos, c.env.JOBS);
        await notifications.notify(
          businessId,
          { customerId: account.customerId },
          { eventType: 'reward_redeemed', businessName: business.name, rewardName: reward.name },
        );
      })(),
    );

    return ok(c, transaction);
  });
});
