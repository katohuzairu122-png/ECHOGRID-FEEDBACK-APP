import { describe, expect, it, vi } from 'vitest';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import type {
  SubscriptionPlan,
  SubscriptionPlanRepository,
} from '../repositories/subscription-plan.repository';
import type { BusinessSubscriptionRepository } from '../repositories/business-subscription.repository';

const freePlan = { id: 'free-plan-id', key: 'free' } as SubscriptionPlan;

function createService(free: SubscriptionPlan | null | undefined = freePlan) {
  const reconcileCatalog = vi.fn().mockResolvedValue(undefined);
  const findByKey = vi.fn().mockResolvedValue(free ?? undefined);
  const transitionAllExpiredCardlessTrials = vi.fn().mockResolvedValue(3);

  const service = new SubscriptionLifecycleService({
    subscriptionPlans: {
      reconcileCatalog,
      findByKey,
    } as unknown as SubscriptionPlanRepository,
    businessSubscriptions: {
      transitionAllExpiredCardlessTrials,
    } as unknown as BusinessSubscriptionRepository,
  });

  return {
    service,
    reconcileCatalog,
    findByKey,
    transitionAllExpiredCardlessTrials,
  };
}

describe('SubscriptionLifecycleService', () => {
  it('moves expired card-less trials to the Free plan', async () => {
    const now = new Date('2026-09-29T00:00:00.000Z');
    const context = createService();

    await expect(context.service.expireCardlessTrials(now)).resolves.toBe(3);
    expect(context.reconcileCatalog).toHaveBeenCalledOnce();
    expect(context.findByKey).toHaveBeenCalledWith('free');
    expect(context.transitionAllExpiredCardlessTrials).toHaveBeenCalledWith(
      'free-plan-id',
      now,
    );
  });

  it('fails visibly when the Free plan cannot be resolved', async () => {
    const context = createService(null);

    await expect(
      context.service.expireCardlessTrials(new Date()),
    ).rejects.toThrow('Free plan is missing');
    expect(context.transitionAllExpiredCardlessTrials).not.toHaveBeenCalled();
  });
});
