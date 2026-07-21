import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import { StripeWebhookService } from './stripe-webhook.service';
import type { SubscriptionPlan, SubscriptionPlanRepository } from '../repositories/subscription-plan.repository';
import type {
  BusinessSubscription,
  BusinessSubscriptionRepository,
  StripeSyncPatch,
} from '../repositories/business-subscription.repository';
import type { NewAuditLogEntry, AuditLogRepository } from '../repositories/audit-log.repository';

/** Same minimal in-memory fake spirit as branch.service.test.ts. The fakes
 * implement only the subset each repository the service uses; the return is
 * cast to the repository type (intersected with the test-only inspection
 * props the assertions read) so it satisfies the service's injected shape. */
function createFakePlanRepo(plans: SubscriptionPlan[]): SubscriptionPlanRepository {
  return {
    async findByStripePriceId(priceId: string): Promise<SubscriptionPlan | undefined> {
      return plans.find((p) => p.stripePriceIdMonthly === priceId || p.stripePriceIdYearly === priceId);
    },
  } as unknown as SubscriptionPlanRepository;
}

function createFakeSubscriptionRepo(): BusinessSubscriptionRepository & {
  upserts: Array<{ businessId: string; patch: StripeSyncPatch }>;
} {
  const upserts: Array<{ businessId: string; patch: StripeSyncPatch }> = [];
  return {
    upserts,
    async upsertFromStripe(businessId: string, patch: StripeSyncPatch): Promise<BusinessSubscription> {
      upserts.push({ businessId, patch });
      return { id: 'sub-row-1', businessId, ...patch } as BusinessSubscription;
    },
  } as unknown as BusinessSubscriptionRepository & {
    upserts: Array<{ businessId: string; patch: StripeSyncPatch }>;
  };
}

function createFakeAuditLogRepo(
  opts: { throwOnRecord?: boolean } = {},
): AuditLogRepository & { records: NewAuditLogEntry[] } {
  const records: NewAuditLogEntry[] = [];
  return {
    records,
    async record(entry: NewAuditLogEntry): Promise<void> {
      if (opts.throwOnRecord) throw new Error('simulated audit log write failure');
      records.push(entry);
    },
  } as unknown as AuditLogRepository & { records: NewAuditLogEntry[] };
}

const GROWTH_PLAN: SubscriptionPlan = {
  id: 'plan-growth',
  key: 'growth',
  name: 'Growth',
  description: null,
  priceMonthlyCents: 9900,
  priceYearlyCents: 99000,
  currency: 'usd',
  stripePriceIdMonthly: 'price_monthly_growth',
  stripePriceIdYearly: 'price_yearly_growth',
  maxBranches: 5,
  maxUsers: 20,
  features: null,
  isActive: true,
  isDefaultTrial: false,
  sortOrder: 1,
  createdAt: new Date(),
  createdBy: null,
  updatedAt: new Date(),
  updatedBy: null,
};

/** Builds a plain object shaped like enough of Stripe.Subscription for
 * syncSubscription's field mapping, then casts -- same "hand-written fake,
 * cast when the real SDK type surface is irrelevant to what's under test"
 * convention as billing.service.test.ts's fake Stripe client. */
function makeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_test_123',
    customer: 'cus_test_123',
    status: 'active',
    metadata: { businessId: 'business-1', planId: GROWTH_PLAN.id },
    cancel_at_period_end: false,
    canceled_at: null,
    items: {
      data: [
        {
          price: { id: 'price_monthly_growth', recurring: { interval: 'month' } },
          current_period_start: 1750000000,
          current_period_end: 1752678400,
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function makeEvent(type: string, subscription: Stripe.Subscription): Stripe.Event {
  return { type, data: { object: subscription } } as unknown as Stripe.Event;
}

describe('StripeWebhookService', () => {
  describe('event routing', () => {
    it('syncs on customer.subscription.created', async () => {
      const subscriptionRepo = createFakeSubscriptionRepo();
      const service = new StripeWebhookService({
        subscriptionPlans: createFakePlanRepo([GROWTH_PLAN]),
        businessSubscriptions: subscriptionRepo,
        auditLog: createFakeAuditLogRepo(),
      });

      await service.processEvent(makeEvent('customer.subscription.created', makeSubscription()));

      expect(subscriptionRepo.upserts).toHaveLength(1);
      expect(subscriptionRepo.upserts[0]!.businessId).toBe('business-1');
    });

    it('syncs on customer.subscription.updated', async () => {
      const subscriptionRepo = createFakeSubscriptionRepo();
      const service = new StripeWebhookService({
        subscriptionPlans: createFakePlanRepo([GROWTH_PLAN]),
        businessSubscriptions: subscriptionRepo,
        auditLog: createFakeAuditLogRepo(),
      });

      await service.processEvent(makeEvent('customer.subscription.updated', makeSubscription({ status: 'past_due' })));

      expect(subscriptionRepo.upserts).toHaveLength(1);
      expect(subscriptionRepo.upserts[0]!.patch.status).toBe('past_due');
    });

    it('ignores unhandled event types (e.g. invoice.paid) without throwing', async () => {
      const subscriptionRepo = createFakeSubscriptionRepo();
      const service = new StripeWebhookService({
        subscriptionPlans: createFakePlanRepo([GROWTH_PLAN]),
        businessSubscriptions: subscriptionRepo,
        auditLog: createFakeAuditLogRepo(),
      });

      await expect(
        service.processEvent(makeEvent('invoice.paid', makeSubscription())),
      ).resolves.toBeUndefined();
      expect(subscriptionRepo.upserts).toHaveLength(0);
    });
  });

  describe('field mapping', () => {
    it('resolves the plan via Stripe price ID and maps interval/period/cancellation fields', async () => {
      const subscriptionRepo = createFakeSubscriptionRepo();
      const service = new StripeWebhookService({
        subscriptionPlans: createFakePlanRepo([GROWTH_PLAN]),
        businessSubscriptions: subscriptionRepo,
        auditLog: createFakeAuditLogRepo(),
      });

      await service.processEvent(makeEvent('customer.subscription.created', makeSubscription()));

      const { patch } = subscriptionRepo.upserts[0]!;
      expect(patch.planId).toBe(GROWTH_PLAN.id);
      expect(patch.stripeCustomerId).toBe('cus_test_123');
      expect(patch.stripeSubscriptionId).toBe('sub_test_123');
      expect(patch.billingInterval).toBe('month');
      expect(patch.currentPeriodStart).toEqual(new Date(1750000000 * 1000));
      expect(patch.currentPeriodEnd).toEqual(new Date(1752678400 * 1000));
      expect(patch.cancelAtPeriodEnd).toBe(false);
    });

    it('maps a yearly price to billingInterval "year"', async () => {
      const subscriptionRepo = createFakeSubscriptionRepo();
      const service = new StripeWebhookService({
        subscriptionPlans: createFakePlanRepo([GROWTH_PLAN]),
        businessSubscriptions: subscriptionRepo,
        auditLog: createFakeAuditLogRepo(),
      });

      const subscription = makeSubscription({
        items: {
          data: [
            {
              price: { id: 'price_yearly_growth', recurring: { interval: 'year' } },
              current_period_start: 1750000000,
              current_period_end: 1781536000,
            },
          ],
        },
      });

      await service.processEvent(makeEvent('customer.subscription.created', subscription));

      expect(subscriptionRepo.upserts[0]!.patch.billingInterval).toBe('year');
      expect(subscriptionRepo.upserts[0]!.patch.planId).toBe(GROWTH_PLAN.id);
    });

    it('falls back to subscription.metadata.planId when the price ID cannot be resolved against the catalog', async () => {
      const subscriptionRepo = createFakeSubscriptionRepo();
      const service = new StripeWebhookService({
        subscriptionPlans: createFakePlanRepo([]), // catalog empty -- price lookup will miss
        businessSubscriptions: subscriptionRepo,
        auditLog: createFakeAuditLogRepo(),
      });

      const subscription = makeSubscription({ metadata: { businessId: 'business-1', planId: 'plan-fallback' } });

      await service.processEvent(makeEvent('customer.subscription.created', subscription));

      expect(subscriptionRepo.upserts).toHaveLength(1);
      expect(subscriptionRepo.upserts[0]!.patch.planId).toBe('plan-fallback');
    });

    it('skips the sync (no upsert, no throw) when businessId is missing from metadata', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const subscriptionRepo = createFakeSubscriptionRepo();
      const service = new StripeWebhookService({
        subscriptionPlans: createFakePlanRepo([GROWTH_PLAN]),
        businessSubscriptions: subscriptionRepo,
        auditLog: createFakeAuditLogRepo(),
      });

      const subscription = makeSubscription({ metadata: {} });

      await expect(
        service.processEvent(makeEvent('customer.subscription.created', subscription)),
      ).resolves.toBeUndefined();
      expect(subscriptionRepo.upserts).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('skips the sync (no upsert, no throw) when no plan can be resolved by price ID or metadata fallback', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const subscriptionRepo = createFakeSubscriptionRepo();
      const service = new StripeWebhookService({
        subscriptionPlans: createFakePlanRepo([]), // empty catalog, no price match
        businessSubscriptions: subscriptionRepo,
        auditLog: createFakeAuditLogRepo(),
      });

      const subscription = makeSubscription({ metadata: { businessId: 'business-1' } }); // no planId fallback either

      await expect(
        service.processEvent(makeEvent('customer.subscription.created', subscription)),
      ).resolves.toBeUndefined();
      expect(subscriptionRepo.upserts).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });
  });

  describe('cancellation handling', () => {
    it('customer.subscription.deleted forces status to canceled regardless of the payload\'s own status field', async () => {
      const subscriptionRepo = createFakeSubscriptionRepo();
      const service = new StripeWebhookService({
        subscriptionPlans: createFakePlanRepo([GROWTH_PLAN]),
        businessSubscriptions: subscriptionRepo,
        auditLog: createFakeAuditLogRepo(),
      });

      const subscription = makeSubscription({ status: 'active' }); // Stripe payload may still say active momentarily

      await service.processEvent(makeEvent('customer.subscription.deleted', subscription));

      expect(subscriptionRepo.upserts[0]!.patch.status).toBe('canceled');
    });

    it('customer.subscription.deleted uses "now" for canceledAt even when the payload has its own canceled_at', async () => {
      const subscriptionRepo = createFakeSubscriptionRepo();
      const service = new StripeWebhookService({
        subscriptionPlans: createFakePlanRepo([GROWTH_PLAN]),
        businessSubscriptions: subscriptionRepo,
        auditLog: createFakeAuditLogRepo(),
      });

      // An old timestamp -- if the service used this instead of "now", the
      // assertion below (a tight 5s window) would fail.
      const subscription = makeSubscription({ canceled_at: 1700000000 });

      const before = Date.now();
      await service.processEvent(makeEvent('customer.subscription.deleted', subscription));
      const canceledAt = subscriptionRepo.upserts[0]!.patch.canceledAt as Date;

      expect(canceledAt.getTime()).toBeGreaterThan(before - 5000);
      expect(canceledAt.getTime()).toBeLessThan(before + 5000);
    });

    it('a non-deleted update prefers the payload\'s own canceled_at over "now" (e.g. cancel-at-period-end scheduling)', async () => {
      const subscriptionRepo = createFakeSubscriptionRepo();
      const service = new StripeWebhookService({
        subscriptionPlans: createFakePlanRepo([GROWTH_PLAN]),
        businessSubscriptions: subscriptionRepo,
        auditLog: createFakeAuditLogRepo(),
      });

      const subscription = makeSubscription({ cancel_at_period_end: true, canceled_at: 1700000000 });

      await service.processEvent(makeEvent('customer.subscription.updated', subscription));

      expect(subscriptionRepo.upserts[0]!.patch.canceledAt).toEqual(new Date(1700000000 * 1000));
      expect(subscriptionRepo.upserts[0]!.patch.cancelAtPeriodEnd).toBe(true);
    });

    it('canceledAt is null when the payload has neither canceled_at nor forceCanceled', async () => {
      const subscriptionRepo = createFakeSubscriptionRepo();
      const service = new StripeWebhookService({
        subscriptionPlans: createFakePlanRepo([GROWTH_PLAN]),
        businessSubscriptions: subscriptionRepo,
        auditLog: createFakeAuditLogRepo(),
      });

      await service.processEvent(makeEvent('customer.subscription.updated', makeSubscription({ canceled_at: null })));

      expect(subscriptionRepo.upserts[0]!.patch.canceledAt).toBeNull();
    });
  });

  describe('audit logging', () => {
    it('writes an audit log entry after a successful sync', async () => {
      const auditLogRepo = createFakeAuditLogRepo();
      const service = new StripeWebhookService({
        subscriptionPlans: createFakePlanRepo([GROWTH_PLAN]),
        businessSubscriptions: createFakeSubscriptionRepo(),
        auditLog: auditLogRepo,
      });

      await service.processEvent(makeEvent('customer.subscription.created', makeSubscription({ status: 'active' })));

      expect(auditLogRepo.records).toHaveLength(1);
      expect(auditLogRepo.records[0]).toMatchObject({
        businessId: 'business-1',
        action: 'subscription.active',
        entityType: 'business_subscription',
      });
    });

    it('a failed audit log write does not undo or throw past a successful sync', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const subscriptionRepo = createFakeSubscriptionRepo();
      const service = new StripeWebhookService({
        subscriptionPlans: createFakePlanRepo([GROWTH_PLAN]),
        businessSubscriptions: subscriptionRepo,
        auditLog: createFakeAuditLogRepo({ throwOnRecord: true }),
      });

      await expect(
        service.processEvent(makeEvent('customer.subscription.created', makeSubscription())),
      ).resolves.toBeUndefined();
      // The sync itself already committed before the audit write was attempted.
      expect(subscriptionRepo.upserts).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });
  });
});
