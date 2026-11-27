import { Hono, type Context } from 'hono';
import {
  recordPurchaseSchema,
  adjustPointsSchema,
  createTierSchema,
  updateTierSchema,
  createRewardSchema,
  updateRewardSchema,
  updateLoyaltySettingsSchema,
  resolveCustomerQrSchema,
  lookupCustomerSchema,
  lookupPurchaseSchema,
} from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import type { LoyaltyPurchaseChannel } from '../db/schema/loyalty-purchase-events';
import type { CashierSessionBinding } from '../cashier-sessions/session-binding';
import { createRepositories, type LoyaltySettings } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requirePermission } from '../middleware/require-permission';
import { requireBusinessWideAccess } from '../middleware/require-business-wide-access';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { runInBackground } from '../lib/background-db';
import { LoyaltyAccountService } from './loyalty-account.service';
import { LoyaltyTierService } from './loyalty-tier.service';
import { LoyaltyRewardService } from './loyalty-reward.service';
import { LoyaltyRedemptionService } from './loyalty-redemption.service';
import { NotificationService } from '../notifications/notification.service';
import { LoyaltyActionResolver } from './loyalty-action-resolver';
import { LoyaltyProgramService } from './programs/program.service';
import { listAvailableEntitlements, redeemAccountEntitlement } from './programs/entitlement.service';
import { assertRewardCanChange } from './programs/reward-usage.service';
import { previewPurchases, isProgramAvailable } from '@echo-grid-feedback/shared-types';
import { z } from 'zod';
import { CustomerLookupService, LOOKUP_PURCHASE_AUDIT } from './customer-lookup.service';
import { AppError } from '../lib/errors';

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

// ---- Core QR action resolution (Split 03) ---------------------------------

loyaltyRoutes.post('/actions/resolve-customer', requirePermission('loyalty:serve'), async (c) => {
  const body = await parseJsonBody(c.req.raw, resolveCustomerQrSchema);
  return withDb(c, async (db) => {
    const result = await new LoyaltyActionResolver(createRepositories(db), {
      QR_TOKEN_SECRET: c.env.QR_TOKEN_SECRET,
      QR_TOKEN_SECRET_PREVIOUS: c.env.QR_TOKEN_SECRET_PREVIOUS,
    }).resolveCustomerForStaff({
      customerQrToken: body.customerQrToken,
      businessId: c.get('businessId'),
      permissions: c.get('permissions'),
      ...(c.get('branchId') ? { branchId: c.get('branchId') } : {}),
    });
    // LPC-06: the card also lists the programme rewards this member has earned and not yet received, so the cashier can hand them over.
    if (result.card && result.loyaltyAccountId) {
      const earned = await listAvailableEntitlements(db, {
        businessId: c.get('businessId'), accountId: result.loyaltyAccountId, branchId: c.get('branchId'),
      });
      result.card = { ...result.card, earnedRewards: earned.map((e) => ({ id: e.id, name: e.rewardName, expiresAt: e.expiresAt })) };
    }
    return ok(c, result);
  });
});

// CASHIER-FINAL-RECONCILIATION: the cashier-issued onboarding-invite route was withdrawn (Invite Customers is not a cashier function).
// Customer acceptance of an invitation (customer-memberships/join-assisted) is unchanged.

// ---- Accounts & points engine (Block 3) ---------------------------------

loyaltyRoutes.get('/accounts', requirePermission('loyalty:accounts:view'), requireBusinessWideAccess, async (c) => {
  const url = new URL(c.req.url);
  const limit = Number(url.searchParams.get('limit')) || undefined;
  const offset = Number(url.searchParams.get('offset')) || undefined;
  return withDb(c, async (db) => {
    const items = await new LoyaltyAccountService(db).listForBusiness(c.get('businessId'), { limit, offset });
    return ok(c, items);
  });
});

loyaltyRoutes.get('/accounts/:id', requirePermission('loyalty:accounts:view'), requireBusinessWideAccess, async (c) => {
  return withDb(c, async (db) => {
    const account = await new LoyaltyAccountService(db).getAccount(c.req.param('id'), c.get('businessId'));
    return ok(c, account);
  });
});

loyaltyRoutes.get('/accounts/:id/transactions', requirePermission('loyalty:accounts:view'), requireBusinessWideAccess, async (c) => {
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

/** CASHIER-AUTH-02C: the verified session binding of a cashier token (absent for any other caller), for the in-transaction ordering guard. */
function sessionBindingOf(c: Context<Env>): { cashierSession?: CashierSessionBinding } {
  const cashier = c.get('cashier');
  return cashier?.sessionId ? { cashierSession: { userId: c.get('userId'), sessionId: cashier.sessionId, branchId: cashier.branchId } } : {};
}

type PurchaseInput = {
  purchaseAmount: number;
  idempotencyKey: string;
  externalReference?: string | undefined;
  channel: LoyaltyPurchaseChannel;
};

/**
 * Records one purchase and fires the post-commit notifications. Shared by the account-id route (customer
 * identified by a scanned QR) and the lookup route (customer identified by phone lookup), so the two can never
 * drift apart. Only the audit entry differs.
 */
async function recordPurchaseAndNotify(
  c: Context<Env>,
  db: Database,
  accountId: string,
  body: PurchaseInput,
  audit: { action: string; details?: unknown },
) {
  const businessId = c.get('businessId');

  // Fetched BEFORE the mutation so the tier comparison below has a real
  // "before" to compare against -- LoyaltyAccountService's return value is
  // only the "after" state, and tier-change detection needs both.
  const before = await new LoyaltyAccountService(db).getAccount(accountId, businessId);
  const purchase = await new LoyaltyAccountService(db).recordPurchase({
    businessId,
    ...(c.get('branchId') ? { branchId: c.get('branchId') } : {}),
    accountId,
    purchaseAmount: body.purchaseAmount,
    idempotencyKey: body.idempotencyKey,
    ...(body.externalReference !== undefined ? { externalReference: body.externalReference } : {}),
    channel: body.channel,
    staffUserId: c.get('userId'),
    ...sessionBindingOf(c),
  });
  const account = purchase.account;
  c.set('auditMetadata', {
    action: audit.action,
    entityType: 'loyalty_account',
    entityId: account.id,
    ...(audit.details !== undefined ? { details: audit.details } : {}),
  });

  // Notification triggers run AFTER recordPurchase's own transaction has
  // committed, never inside it -- LoyaltyAccountService owns a
  // db.transaction() directly (see its own class comment), and enqueueing
  // to an external queue has no atomicity with that transaction. Firing
  // here means we only ever notify about a purchase that really landed.
  // Uses its own fresh connection (runInBackground), not the outer
  // `repos` -- see that helper's doc comment for why reusing it races
  // withDb's own close().
  const pointsEarned = purchase.inserted ? account.points - before.points : 0;
  c.executionCtx.waitUntil(
    runInBackground(c.env.HYPERDRIVE, async (repos) => {
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
    }),
  );

  return account;
}

loyaltyRoutes.post('/accounts/:id/purchase', requirePermission('loyalty:serve'), async (c) => {
  const body = await parseJsonBody(c.req.raw, recordPurchaseSchema);
  return withDb(c, async (db) => {
    const account = await recordPurchaseAndNotify(c, db, c.req.param('id'), body, {
      action: 'loyalty.purchase_recorded',
    });
    return ok(c, account);
  });
});

// ---- LPC-05: cashier hands over earned programme rewards ---------------------------------------------------------
// The cashier works from the scanned customer's account; they can list and redeem earned rewards but never change a programme.
loyaltyRoutes.get('/accounts/:id/entitlements', requirePermission('loyalty:serve'), async (c) => {
  const accountId = z.uuid().parse(c.req.param('id'));
  return withDb(c, async (db) => ok(c, await listAvailableEntitlements(db, {
    businessId: c.get('businessId'), accountId, branchId: c.get('branchId'),
  })));
});

loyaltyRoutes.post('/accounts/:id/entitlements/:entitlementId/redeem', requirePermission('loyalty:serve'), async (c) => {
  const accountId = z.uuid().parse(c.req.param('id'));
  const entitlementId = z.uuid().parse(c.req.param('entitlementId'));
  return withDb(c, async (db) => {
    const redeemed = await redeemAccountEntitlement(db, {
      businessId: c.get('businessId'), accountId, entitlementId, redeemedBy: c.get('userId'), branchId: c.get('branchId'),
    });
    c.set('auditMetadata', { action: 'loyalty.entitlement_redeemed', entityType: 'loyalty_account', entityId: accountId, details: { entitlementId, rewardId: redeemed.rewardId } });
    return ok(c, { id: redeemed.id, rewardId: redeemed.rewardId, status: 'redeemed' });
  });
});

// ---- Cashier phone lookup (D-C2) -------------------------------------------
// Finds an ACTIVE member of this business by exact phone number. Controls (design section 4): a dedicated rate
// limit keyed by business and cashier, a miss throttle, an audit row per lookup (HMAC of the phone, never the
// number), a short-lived signed token as the only handle, and no reward redemption through a lookup.

loyaltyRoutes.post('/actions/lookup-customer', requirePermission('loyalty:serve'), async (c) => {
  const { success } = await c.env.LOOKUP_RATE_LIMITER.limit({
    key: `${c.get('businessId')}:${c.get('userId')}`,
  });
  if (!success) throw new AppError('Too many requests. Please try again shortly.', 429, 'RATE_LIMITED');

  const body = await parseJsonBody(c.req.raw, lookupCustomerSchema);
  return withDb(c, async (db) => {
    const result = await new CustomerLookupService(createRepositories(db), {
      QR_TOKEN_SECRET: c.env.QR_TOKEN_SECRET,
      QR_TOKEN_SECRET_PREVIOUS: c.env.QR_TOKEN_SECRET_PREVIOUS,
    }).lookup({
      phone: body.phone,
      businessId: c.get('businessId'),
      staffUserId: c.get('userId'),
      ipAddress: c.req.header('cf-connecting-ip') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
      cashier: c.get('cashier') ? { branchId: c.get('cashier')?.branchId ?? null } : undefined,
    });
    // The service wrote the audit row itself (hits and misses), so the generic request audit is skipped.
    c.set('auditAlreadyRecorded', true);
    return ok(c, result);
  });
});

loyaltyRoutes.post('/actions/lookup-purchase', requirePermission('loyalty:serve'), async (c) => {
  const body = await parseJsonBody(c.req.raw, lookupPurchaseSchema);
  return withDb(c, async (db) => {
    const { accountId } = await new CustomerLookupService(createRepositories(db), {
      QR_TOKEN_SECRET: c.env.QR_TOKEN_SECRET,
      QR_TOKEN_SECRET_PREVIOUS: c.env.QR_TOKEN_SECRET_PREVIOUS,
    }).resolvePurchaseTarget({
      lookupToken: body.lookupToken,
      businessId: c.get('businessId'),
      staffUserId: c.get('userId'),
    });
    // The loyalty account id is never returned to the cashier on this path: the token is the only handle.
    await recordPurchaseAndNotify(
      c,
      db,
      accountId,
      {
        purchaseAmount: body.purchaseAmount,
        idempotencyKey: body.idempotencyKey,
        channel: 'other',
      },
      { action: LOOKUP_PURCHASE_AUDIT, details: { identifiedBy: 'lookup' } },
    );
    return ok(c, { success: true });
  });
});

// Manual balance changes are an administrative correction, not counter service. They need the dedicated
// `loyalty:adjust` permission, which the front-counter Staff role never holds (D-C1). Role reconciliation
// grants it only to roles that held BOTH loyalty:manage and rewards:manage before, which is exactly who could
// adjust balances before D-C1, so no existing administrator loses the capability and no cashier gains it.
loyaltyRoutes.post(
  '/accounts/:id/adjust',
  requirePermission('loyalty:adjust'),
  requireBusinessWideAccess,
  async (c) => {
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
  },
);

// LPC-08: reverse one confirmed purchase (refund or mistaken receipt). Owner and managers only (loyalty:adjust, business-wide); a cashier token is
// refused by the cashier route allow-list. Owner-approved rules: the balance never goes below zero, unused rewards are revoked, and a reward already
// handed over stays given and is flagged for review.
const reversePurchaseSchema = z.object({ reason: z.string().trim().min(3).max(200) }).strict();
loyaltyRoutes.post('/purchases/:purchaseEventId/reverse', requirePermission('loyalty:adjust'), requireBusinessWideAccess, async (c) => {
  const purchaseEventId = z.uuid().parse(c.req.param('purchaseEventId'));
  const body = await parseJsonBody(c.req.raw, reversePurchaseSchema);
  return withDb(c, async (db) => {
    const result = await new LoyaltyAccountService(db).reversePurchase({
      businessId: c.get('businessId'), purchaseEventId, reason: body.reason, actorUserId: c.get('userId'),
    });
    c.set('auditMetadata', {
      action: 'loyalty.purchase_reversed',
      entityType: 'loyalty_account',
      entityId: result.accountId,
      details: {
        purchaseEventId,
        pointsReversed: result.pointsReversed,
        pointsShortfall: result.pointsShortfall,
        revokedRewards: result.progress.revokedEntitlements,
        rewardsAlreadyUsed: result.progress.usedEntitlementIds,
      },
    });
    return ok(c, {
      purchaseEventId,
      pointsReversed: result.pointsReversed,
      pointsShortfall: result.pointsShortfall,
      revokedRewards: result.progress.revokedEntitlements,
      rewardsAlreadyUsed: result.progress.usedEntitlementIds.length,
      needsReview: result.progress.usedEntitlementIds.length > 0 || result.pointsShortfall > 0,
    });
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

loyaltyRoutes.get('/settings', requirePermission('loyalty:view'), requireBusinessWideAccess, async (c) => {
  return withDb(c, async (db) => {
    const settings = await createRepositories(db).loyaltySettings.getOrCreateDefaults(c.get('businessId'));
    return ok(c, serializeSettings(settings));
  });
});

loyaltyRoutes.patch('/settings', requirePermission('rewards:manage'), requireBusinessWideAccess, async (c) => {
  const body = await parseJsonBody(c.req.raw, updateLoyaltySettingsSchema);
  return withDb(c, async (db) => {
    const settings = await createRepositories(db).loyaltySettings.update(
      c.get('businessId'),
      { ...body, pointsPerCurrencyUnit: body.pointsPerCurrencyUnit?.toString() },
      c.get('userId'),
    );
    c.set('auditMetadata', { action: 'loyalty.settings_updated', entityType: 'loyalty_settings', entityId: settings.id });
    // An existing (legacy) business keeps earning under the rates it edits here: they become a new version of its legacy programme.
    await new LoyaltyProgramService(db).syncLegacySettings(c.get('businessId'), c.get('userId'), {
      pointsPerCurrencyUnit: settings.pointsPerCurrencyUnit,
      pointsPerCheckin: settings.pointsPerCheckin,
    });
    return ok(c, serializeSettings(settings));
  });
});


// ---- Primary loyalty programmes (LOYALTY-PROGRAMME-COMPLETION, Group 01) ---------------------------------------------------------------
// Configuration needs rewards:manage and business-wide access (a cashier holds neither). Activating, pausing, switching and retiring are
// additionally limited to the business Owner by the service. Programme resolution for earning is server-side and never reads these routes.

const programmeIdParam = z.uuid();
const createProgrammeSchema = z.strictObject({ type: z.string().min(1).max(10), config: z.record(z.string(), z.unknown()) });
const saveProgrammeConfigSchema = z.strictObject({ config: z.record(z.string(), z.unknown()) });
const previewProgrammeSchema = z.strictObject({
  type: z.string().min(1).max(10),
  config: z.record(z.string(), z.unknown()),
  amounts: z.array(z.string().min(1).max(20)).min(1).max(10),
});
const confirmSchema = z.strictObject({ confirm: z.literal(true) });

loyaltyRoutes.get('/programmes', requirePermission('loyalty:view'), requireBusinessWideAccess, async (c) => {
  return withDb(c, async (db) => {
    const service = new LoyaltyProgramService(db);
    const [programmes, setupState] = await Promise.all([service.list(c.get('businessId')), service.setupState(c.get('businessId'))]);
    return ok(c, { registry: service.registry(), setupState, programmes });
  });
});

loyaltyRoutes.post('/programmes', requirePermission('rewards:manage'), requireBusinessWideAccess, async (c) => {
  const body = await parseJsonBody(c.req.raw, createProgrammeSchema);
  return withDb(c, async (db) => {
    const programme = await new LoyaltyProgramService(db).createDraft(c.get('businessId'), c.get('userId'), body);
    c.set('auditMetadata', { action: 'loyalty.programme_created', entityType: 'loyalty_program', entityId: programme.id });
    return ok(c, programme, 201);
  });
});

loyaltyRoutes.post('/programmes/preview', requirePermission('rewards:manage'), requireBusinessWideAccess, async (c) => {
  const body = await parseJsonBody(c.req.raw, previewProgrammeSchema);
  return withDb(c, async (db) => {
    const service = new LoyaltyProgramService(db);
    const checked = await service.checkConfig(c.get('businessId'), body.type, body.config);
    return ok(c, { config: checked.config, currency: checked.currency, examples: isProgramAvailable(body.type) ? previewPurchases(body.type, checked.config, checked.currency, body.amounts) : [] });
  });
});

loyaltyRoutes.get('/programmes/:id', requirePermission('loyalty:view'), requireBusinessWideAccess, async (c) => {
  const id = programmeIdParam.parse(c.req.param('id'));
  return withDb(c, async (db) => ok(c, await new LoyaltyProgramService(db).get(c.get('businessId'), id)));
});

loyaltyRoutes.get('/programmes/:id/history', requirePermission('loyalty:view'), requireBusinessWideAccess, async (c) => {
  const id = programmeIdParam.parse(c.req.param('id'));
  return withDb(c, async (db) => ok(c, await new LoyaltyProgramService(db).history(c.get('businessId'), id)));
});

loyaltyRoutes.put('/programmes/:id/config', requirePermission('rewards:manage'), requireBusinessWideAccess, async (c) => {
  const id = programmeIdParam.parse(c.req.param('id'));
  const body = await parseJsonBody(c.req.raw, saveProgrammeConfigSchema);
  return withDb(c, async (db) => {
    const programme = await new LoyaltyProgramService(db).saveConfig(c.get('businessId'), c.get('userId'), id, body.config);
    c.set('auditMetadata', { action: 'loyalty.programme_config_saved', entityType: 'loyalty_program', entityId: id });
    return ok(c, programme);
  });
});

loyaltyRoutes.post('/programmes/:id/validate', requirePermission('rewards:manage'), requireBusinessWideAccess, async (c) => {
  const id = programmeIdParam.parse(c.req.param('id'));
  return withDb(c, async (db) => {
    const programme = await new LoyaltyProgramService(db).validate(c.get('businessId'), c.get('userId'), id);
    c.set('auditMetadata', { action: 'loyalty.programme_validated', entityType: 'loyalty_program', entityId: id });
    return ok(c, programme);
  });
});

loyaltyRoutes.post('/programmes/:id/activate', requirePermission('rewards:manage'), requireBusinessWideAccess, async (c) => {
  const id = programmeIdParam.parse(c.req.param('id'));
  await parseJsonBody(c.req.raw, confirmSchema);
  return withDb(c, async (db) => {
    const result = await new LoyaltyProgramService(db).activate(c.get('businessId'), c.get('userId'), id);
    c.set('auditMetadata', { action: 'loyalty.programme_activated', entityType: 'loyalty_program', entityId: id, details: { replaced: result.previous?.id ?? null } });
    return ok(c, result);
  });
});

loyaltyRoutes.post('/programmes/:id/deactivate', requirePermission('rewards:manage'), requireBusinessWideAccess, async (c) => {
  const id = programmeIdParam.parse(c.req.param('id'));
  await parseJsonBody(c.req.raw, confirmSchema);
  return withDb(c, async (db) => {
    const programme = await new LoyaltyProgramService(db).deactivate(c.get('businessId'), c.get('userId'), id);
    c.set('auditMetadata', { action: 'loyalty.programme_deactivated', entityType: 'loyalty_program', entityId: id });
    return ok(c, programme);
  });
});

loyaltyRoutes.post('/programmes/:id/retire', requirePermission('rewards:manage'), requireBusinessWideAccess, async (c) => {
  const id = programmeIdParam.parse(c.req.param('id'));
  await parseJsonBody(c.req.raw, confirmSchema);
  return withDb(c, async (db) => {
    const programme = await new LoyaltyProgramService(db).retire(c.get('businessId'), c.get('userId'), id);
    c.set('auditMetadata', { action: 'loyalty.programme_retired', entityType: 'loyalty_program', entityId: id });
    return ok(c, programme);
  });
});

// ---- Tiers (Block 4 -- program configuration) -----------------------------

loyaltyRoutes.get('/tiers', requirePermission('loyalty:view'), requireBusinessWideAccess, async (c) => {
  return withDb(c, async (db) => {
    const tiers = await new LoyaltyTierService(createRepositories(db)).list(c.get('businessId'));
    return ok(c, tiers);
  });
});

loyaltyRoutes.post('/tiers', requirePermission('rewards:manage'), requireBusinessWideAccess, async (c) => {
  const body = await parseJsonBody(c.req.raw, createTierSchema);
  return withDb(c, async (db) => {
    const tier = await new LoyaltyTierService(createRepositories(db)).create(c.get('businessId'), body, c.get('userId'));
    c.set('auditMetadata', { action: 'loyalty.tier_created', entityType: 'loyalty_tier', entityId: tier.id });
    return ok(c, tier, 201);
  });
});

loyaltyRoutes.patch('/tiers/:id', requirePermission('rewards:manage'), requireBusinessWideAccess, async (c) => {
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

loyaltyRoutes.delete('/tiers/:id', requirePermission('rewards:manage'), requireBusinessWideAccess, async (c) => {
  const id = c.req.param('id');
  return withDb(c, async (db) => {
    await new LoyaltyTierService(createRepositories(db)).remove(id, c.get('businessId'), c.get('userId'));
    c.set('auditMetadata', { action: 'loyalty.tier_removed', entityType: 'loyalty_tier', entityId: id });
    return c.body(null, 204);
  });
});

// ---- Rewards (Block 4) -----------------------------------------------------

loyaltyRoutes.get('/rewards', requirePermission('loyalty:view'), requireBusinessWideAccess, async (c) => {
  return withDb(c, async (db) => {
    const rewards = await new LoyaltyRewardService(createRepositories(db)).list(c.get('businessId'), {
      includeInactive: true,
    });
    return ok(c, rewards);
  });
});

loyaltyRoutes.post('/rewards', requirePermission('rewards:manage'), requireBusinessWideAccess, async (c) => {
  const body = await parseJsonBody(c.req.raw, createRewardSchema);
  return withDb(c, async (db) => {
    const reward = await new LoyaltyRewardService(createRepositories(db)).create(c.get('businessId'), body, c.get('userId'));
    c.set('auditMetadata', { action: 'loyalty.reward_created', entityType: 'loyalty_reward', entityId: reward.id });
    return ok(c, reward, 201);
  });
});

loyaltyRoutes.patch('/rewards/:id', requirePermission('rewards:manage'), requireBusinessWideAccess, async (c) => {
  const body = await parseJsonBody(c.req.raw, updateRewardSchema);
  return withDb(c, async (db) => {
    // LPC-09: a reward the active programme pays out cannot be switched off, or changed to a type the programme does not allow, from under it.
    const current = await createRepositories(db).loyaltyRewards.findById(c.req.param('id'), c.get('businessId'));
    const switchedOff = body.status !== undefined && body.status !== 'active' && body.status !== current?.status;
    const retyped = body.type !== undefined && current !== undefined && body.type !== current.type;
    if (switchedOff || retyped) {
      await assertRewardCanChange(db, { businessId: c.get('businessId'), rewardId: c.req.param('id'), change: 'deactivate' });
    }
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

loyaltyRoutes.delete('/rewards/:id', requirePermission('rewards:manage'), requireBusinessWideAccess, async (c) => {
  const id = c.req.param('id');
  return withDb(c, async (db) => {
    await assertRewardCanChange(db, { businessId: c.get('businessId'), rewardId: id, change: 'remove' });
    await new LoyaltyRewardService(createRepositories(db)).remove(id, c.get('businessId'), c.get('userId'));
    c.set('auditMetadata', { action: 'loyalty.reward_removed', entityType: 'loyalty_reward', entityId: id });
    return c.body(null, 204);
  });
});

// ---- Campaign dashboard (Block 6.7.2, S6.3) --------------------------------

// Read-only, gated on loyalty:view (programme configuration) -- matches GET /rewards's own permission
// rather than rewards:manage, since this reports on a campaign but changes
// nothing. Returns the CampaignDashboard shape straight from the service
// with no serialization step, same as GET /rewards above: the reward row's
// Date/numeric-string fields already JSON-serialize correctly on their
// own, and stats' fields are already plain numbers by the time the
// service returns them (see campaignDashboardSchema's own comment in
// shared-types/src/loyalty.ts for why that split exists).
loyaltyRoutes.get('/rewards/:id/dashboard', requirePermission('loyalty:view'), requireBusinessWideAccess, async (c) => {
  return withDb(c, async (db) => {
    const dashboard = await new LoyaltyRewardService(createRepositories(db)).getCampaignDashboard(
      c.req.param('id'),
      c.get('businessId'),
    );
    return ok(c, dashboard);
  });
});

// ---- Redemption confirmation (Block 4) -------------------------------------

loyaltyRoutes.get('/redemptions/:code', requirePermission('loyalty:serve'), async (c) => {
  return withDb(c, async (db) => {
    const transaction = await new LoyaltyRedemptionService(db).lookup(c.get('businessId'), c.req.param('code'));
    return ok(c, transaction);
  });
});

loyaltyRoutes.post('/redemptions/:code/confirm', requirePermission('loyalty:serve'), async (c) => {
  const businessId = c.get('businessId');
  // Continuing Development Block 6.3 (S6.8 "eligible branch") -- optional,
  // same as resolveTenantContext's own c.get('branchId'): set only when the
  // confirming request carried X-Branch-Id, undefined for a business-wide
  // staff session. See LoyaltyRedemptionService.confirmRedemption's doc
  // comment for why this belongs here and not on redeem()/issue().
  const branchId = c.get('branchId');
  return withDb(c, async (db) => {
    const transaction = await new LoyaltyRedemptionService(db).confirmRedemption(businessId, c.req.param('code'), branchId, sessionBindingOf(c).cashierSession);
    c.set('auditMetadata', { action: 'loyalty.redemption_confirmed', entityType: 'loyalty_transaction', entityId: transaction.id });

    // Same "after commit, not inside the service's transaction" ordering as
    // the purchase handler above, and the same runInBackground fresh-
    // connection reasoning.
    c.executionCtx.waitUntil(
      runInBackground(c.env.HYPERDRIVE, async (repos) => {
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
      }),
    );

    return ok(c, transaction);
  });
});
