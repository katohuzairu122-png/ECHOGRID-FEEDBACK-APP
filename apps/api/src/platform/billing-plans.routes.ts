import { Hono } from 'hono';
import {
  createSubscriptionPlanSchema,
  updateSubscriptionPlanSchema,
  type PlatformSubscriptionPlanDto,
} from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories, type SubscriptionPlan } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { requirePlatformRole, type PlatformVariables } from '../middleware/require-platform-role';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & PlatformVariables & AuditVariables;
};

export const platformBillingPlansRoutes = new Hono<Env>();

platformBillingPlansRoutes.use('*', authenticate);

function toPlatformSubscriptionPlanDto(plan: SubscriptionPlan): PlatformSubscriptionPlanDto {
  return {
    id: plan.id,
    key: plan.key,
    name: plan.name,
    description: plan.description,
    priceMonthlyCents: plan.priceMonthlyCents,
    priceYearlyCents: plan.priceYearlyCents,
    currency: plan.currency,
    stripePriceIdMonthly: plan.stripePriceIdMonthly,
    stripePriceIdYearly: plan.stripePriceIdYearly,
    maxBranches: plan.maxBranches,
    maxUsers: plan.maxUsers,
    isActive: plan.isActive,
    isDefaultTrial: plan.isDefaultTrial,
    sortOrder: plan.sortOrder,
    createdAt: plan.createdAt.toISOString(),
  };
}

/**
 * Read access matches the business directory's own precedent: every
 * platform role, including support -- billing's read-only visibility is a
 * superset of support's (see db/schema/users.ts's PLATFORM_ROLES comment),
 * and support benefits from seeing the catalog while debugging a business's
 * account (e.g. "what does this business's plan actually include").
 * Includes retired plans (isActive=false), unlike billing.routes.ts's
 * business-facing GET /billing/plans -- an admin managing the catalog needs
 * to see and potentially reactivate a retired plan.
 */
platformBillingPlansRoutes.get('/', requirePlatformRole(['support', 'billing', 'admin']), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const plans = await createRepositories(db).subscriptionPlans.listAll();
    return ok(c, plans.map(toPlatformSubscriptionPlanDto));
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * Catalog mutations are billing/admin only, matching PLATFORM_ROLES' "billing
 * inherits support's access, PLUS billing/subscription management" design --
 * support explicitly does not get this (see db/schema/users.ts).
 */
platformBillingPlansRoutes.post('/', requirePlatformRole(['billing', 'admin']), async (c) => {
  const body = await parseJsonBody(c.req.raw, createSubscriptionPlanSchema);

  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);

    // Pre-checked here (rather than left to surface as a raw constraint
    // violation, see SubscriptionPlanRepository.create's comment) so a
    // duplicate key is a clean 409, same UX as BranchService's slug check.
    const existing = await repos.subscriptionPlans.findByKey(body.key);
    if (existing) {
      throw new AppError(`Plan key "${body.key}" is already in use.`, 409, 'PLAN_KEY_TAKEN');
    }

    const plan = await repos.subscriptionPlans.create({ ...body, createdBy: c.get('userId') });

    c.set('auditMetadata', {
      action: 'subscription_plan.created',
      entityType: 'subscription_plan',
      entityId: plan.id,
      details: { key: plan.key, name: plan.name },
    });

    return ok(c, toPlatformSubscriptionPlanDto(plan), 201);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

platformBillingPlansRoutes.patch('/:id', requirePlatformRole(['billing', 'admin']), async (c) => {
  const id = c.req.param('id');
  const body = await parseJsonBody(c.req.raw, updateSubscriptionPlanSchema);

  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const plan = await createRepositories(db).subscriptionPlans.update(id, body, c.get('userId'));
    if (!plan) {
      throw new AppError('Plan not found.', 404, 'PLAN_NOT_FOUND');
    }

    c.set('auditMetadata', {
      action: 'subscription_plan.updated',
      entityType: 'subscription_plan',
      entityId: plan.id,
      details: { fields: Object.keys(body) },
    });

    return ok(c, toPlatformSubscriptionPlanDto(plan));
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
