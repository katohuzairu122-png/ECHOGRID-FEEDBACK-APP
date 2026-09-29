import type { Repositories } from '../repositories';
import { APPROVED_SUBSCRIPTION_CATALOG } from './subscription-catalog';

export class SubscriptionLifecycleService {
  constructor(
    private readonly repos: Pick<
      Repositories,
      'subscriptionPlans' | 'businessSubscriptions'
    >,
  ) {}

  async expireCardlessTrials(now: Date): Promise<number> {
    await this.repos.subscriptionPlans.reconcileCatalog(APPROVED_SUBSCRIPTION_CATALOG);
    const freePlan = await this.repos.subscriptionPlans.findByKey('free');
    if (!freePlan) {
      throw new Error('The active Free plan is missing from the approved catalog.');
    }
    return this.repos.businessSubscriptions.transitionAllExpiredCardlessTrials(
      freePlan.id,
      now,
    );
  }
}
