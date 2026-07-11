import { Hono } from 'hono';
import type { PlatformBusinessSubscriptionDto } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories, type BusinessSubscriptionWithDetails } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { requirePlatformRole, type PlatformVariables } from '../middleware/require-platform-role';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & PlatformVariables;
};

export const platformBillingSubscriptionsRoutes = new Hono<Env>();

platformBillingSubscriptionsRoutes.use('*', authenticate);

const VALID_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'unpaid',
] as const;

function toPlatformBusinessSubscriptionDto(
  subscription: BusinessSubscriptionWithDetails,
): PlatformBusinessSubscriptionDto {
  return {
    id: subscription.id,
    businessId: subscription.businessId,
    businessName: subscription.businessName,
    planId: subscription.planId,
    planName: subscription.planName,
    status: subscription.status as PlatformBusinessSubscriptionDto['status'],
    billingInterval: subscription.billingInterval as PlatformBusinessSubscriptionDto['billingInterval'],
    currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
    trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    createdAt: subscription.createdAt.toISOString(),
  };
}

/**
 * Cross-tenant subscription list -- read access matches billing-plans.routes.ts
 * (every platform role; see PLATFORM_ROLES comment). No mutation routes here
 * on purpose: changing a specific business's plan/status is a business-facing
 * self-service action (dashboard/billing) or a support/impersonation-driven
 * one, not a bulk platform-admin edit surface -- there is no legitimate
 * "platform admin directly overwrites business X's subscription" workflow
 * this console needs yet.
 */
platformBillingSubscriptionsRoutes.get(
  '/',
  requirePlatformRole(['support', 'billing', 'admin']),
  async (c) => {
    const url = new URL(c.req.url);
    const statusParam = url.searchParams.get('status');
    if (statusParam && !VALID_STATUSES.includes(statusParam as (typeof VALID_STATUSES)[number])) {
      throw new AppError(
        `Invalid status filter: ${statusParam}. Must be one of ${VALID_STATUSES.join(', ')}.`,
        400,
        'INVALID_STATUS_FILTER',
      );
    }
    const limit = Number(url.searchParams.get('limit')) || undefined;
    const offset = Number(url.searchParams.get('offset')) || undefined;

    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      const subscriptions = await createRepositories(db).businessSubscriptions.listAllWithDetails(
        { status: statusParam ?? undefined },
        { limit, offset },
      );
      return ok(c, subscriptions.map(toPlatformBusinessSubscriptionDto));
    } finally {
      c.executionCtx.waitUntil(close());
    }
  },
);

platformBillingSubscriptionsRoutes.get(
  '/mrr',
  requirePlatformRole(['support', 'billing', 'admin']),
  async (c) => {
    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      const { mrrCents, activeSubscriptionCount } = await createRepositories(db).businessSubscriptions.calculateMrr();
      // See platformMrrSummarySchema's comment -- v1 assumes a single
      // reporting currency rather than doing real FX conversion.
      return ok(c, { mrrCents, currency: 'usd', activeSubscriptionCount });
    } finally {
      c.executionCtx.waitUntil(close());
    }
  },
);
