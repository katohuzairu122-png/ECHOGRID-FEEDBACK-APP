import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requirePermission } from '../middleware/require-permission';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { createCheckoutSessionSchema, createPortalSessionSchema } from '@echo-grid-feedback/shared-types';
import { createStripeClient } from './stripe-client';
import { BillingService } from './billing.service';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & TenantVariables & AuditVariables;
};

export const billingRoutes = new Hono<Env>();

/** Every billing route is business-scoped, same mounting pattern as
 * branchRoutes -- there is no "bootstrapping" billing action analogous to
 * POST /businesses, since a business (and its trial subscription) already
 * exists by the time any of these routes can be reached. */
billingRoutes.use('*', authenticate, resolveTenantContext);

billingRoutes.get('/plans', requirePermission('billing:view'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new BillingService(createRepositories(db), createStripeClient(c.env.STRIPE_SECRET_KEY));
    const plans = await service.listPlans();
    return ok(c, plans);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

billingRoutes.get('/subscription', requirePermission('billing:view'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new BillingService(createRepositories(db), createStripeClient(c.env.STRIPE_SECRET_KEY));
    const subscription = await service.getSubscription(c.get('businessId'));
    return ok(c, subscription ?? null);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

billingRoutes.post('/checkout', requirePermission('billing:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, createCheckoutSessionSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    const user = await repos.users.findById(c.get('userId'));
    if (!user) {
      throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
    }

    const service = new BillingService(repos, createStripeClient(c.env.STRIPE_SECRET_KEY));
    const result = await service.createCheckoutSession(c.get('businessId'), user.email, body);

    c.set('auditMetadata', {
      action: 'subscription.checkout_started',
      entityType: 'business_subscription',
      details: { planId: body.planId, interval: body.interval },
    });

    return ok(c, result);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

billingRoutes.post('/portal', requirePermission('billing:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, createPortalSessionSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new BillingService(createRepositories(db), createStripeClient(c.env.STRIPE_SECRET_KEY));
    const result = await service.createPortalSession(c.get('businessId'), body);
    return ok(c, result);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
