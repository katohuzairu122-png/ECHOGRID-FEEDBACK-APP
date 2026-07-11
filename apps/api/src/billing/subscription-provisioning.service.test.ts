import { describe, it, expect } from 'vitest';
import { SubscriptionProvisioningService } from './subscription-provisioning.service';
import type { SubscriptionPlan } from '../repositories/subscription-plan.repository';
import type {
  NewBusinessSubscription,
  BusinessSubscription,
} from '../repositories/business-subscription.repository';

/** Minimal fakes, same "just enough of the repository's interface" spirit
 * as branch.service.test.ts's createFakeBranchRepo. */
function createFakePlanRepo(defaultPlan: SubscriptionPlan | undefined) {
  return {
    async findDefaultTrial(): Promise<SubscriptionPlan | undefined> {
      return defaultPlan;
    },
  };
}

function createFakeSubscriptionRepo() {
  const created: NewBusinessSubscription[] = [];
  return {
    created,
    async create(input: NewBusinessSubscription): Promise<BusinessSubscription> {
      created.push(input);
      return { id: 'sub-1', ...input } as BusinessSubscription;
    },
  };
}

const FAKE_PLAN: SubscriptionPlan = {
  id: 'plan-1',
  key: 'starter',
  name: 'Starter',
  description: null,
  priceMonthlyCents: 2900,
  priceYearlyCents: 29000,
  currency: 'usd',
  stripePriceIdMonthly: null,
  stripePriceIdYearly: null,
  maxBranches: 1,
  maxUsers: 3,
  features: null,
  isActive: true,
  isDefaultTrial: true,
  sortOrder: 0,
  createdAt: new Date(),
  createdBy: null,
  updatedAt: new Date(),
  updatedBy: null,
};

describe('SubscriptionProvisioningService', () => {
  it('provisions a trialing subscription on the default-trial plan', async () => {
    const subscriptionRepo = createFakeSubscriptionRepo();
    const service = new SubscriptionProvisioningService({
      subscriptionPlans: createFakePlanRepo(FAKE_PLAN),
      businessSubscriptions: subscriptionRepo,
    });

    await service.provisionTrial('business-1', 'user-1');

    expect(subscriptionRepo.created).toHaveLength(1);
    expect(subscriptionRepo.created[0]).toMatchObject({
      businessId: 'business-1',
      planId: 'plan-1',
      status: 'trialing',
      createdBy: 'user-1',
    });
  });

  it('sets trialEndsAt roughly 14 days out', async () => {
    const subscriptionRepo = createFakeSubscriptionRepo();
    const service = new SubscriptionProvisioningService({
      subscriptionPlans: createFakePlanRepo(FAKE_PLAN),
      businessSubscriptions: subscriptionRepo,
    });

    const before = Date.now();
    await service.provisionTrial('business-1', 'user-1');
    const trialEndsAt = subscriptionRepo.created[0].trialEndsAt as Date;

    const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
    // A window, not an exact match -- the test itself takes nonzero time to
    // run between reading `before` and the service computing its own `now`.
    expect(trialEndsAt.getTime()).toBeGreaterThan(before + fourteenDaysMs - 5000);
    expect(trialEndsAt.getTime()).toBeLessThan(before + fourteenDaysMs + 5000);
  });

  it('does nothing -- and does not throw -- when no default-trial plan is seeded yet', async () => {
    const subscriptionRepo = createFakeSubscriptionRepo();
    const service = new SubscriptionProvisioningService({
      subscriptionPlans: createFakePlanRepo(undefined),
      businessSubscriptions: subscriptionRepo,
    });

    // Mirrors RoleProvisioningService's own "catalog not seeded yet, skip
    // rather than fail" contract -- business creation must never fail just
    // because the plan catalog seed script hasn't run yet.
    await expect(service.provisionTrial('business-1', 'user-1')).resolves.toBeUndefined();
    expect(subscriptionRepo.created).toHaveLength(0);
  });
});
