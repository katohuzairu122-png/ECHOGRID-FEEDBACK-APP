import type { Repositories } from '../repositories';

/** Length of the card-less trial every new business starts on. A named
 * constant, not a magic number inlined below (see "avoid magic numbers") --
 * a starting estimate, not derived from real conversion data; revisit once
 * real trial-to-paid conversion is measurable. */
const TRIAL_PERIOD_DAYS = 14;

/**
 * Provisions the free, card-less trial every new business starts on --
 * mirrors RoleProvisioningService's shape exactly (repo-injected,
 * non-transactional, composable into whatever transaction the caller is
 * already running) and is invoked alongside it from
 * BusinessService.createBusiness's single transaction, so "business
 * created" and "business has a trial" can never disagree.
 *
 * Frictionless signup (no forced credit card at account creation) is a
 * deliberate product decision, not a missing feature -- it materially
 * improves signup conversion for a B2B SaaS product, and Stripe Checkout
 * remains exactly one click away whenever the business is ready to add a
 * payment method (billing.service.ts's createCheckoutSession).
 */
export class SubscriptionProvisioningService {
  constructor(
    private readonly repos: Pick<Repositories, 'subscriptionPlans' | 'businessSubscriptions'>,
  ) {}

  /** No-ops (does not throw) if the plan catalog hasn't been seeded yet --
   * same "skip rather than fail so business creation still succeeds"
   * defensive precedent as RoleProvisioningService.seedDefaultRoles. A
   * business that falls into this gap simply has no subscription row until
   * an operator runs the plan seed and this is re-triggered manually; it is
   * never left half-created or blocked from signing up. */
  async provisionTrial(businessId: string, createdBy: string): Promise<void> {
    const defaultPlan = await this.repos.subscriptionPlans.findDefaultTrial();
    if (!defaultPlan) return;

    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + TRIAL_PERIOD_DAYS);

    await this.repos.businessSubscriptions.create({
      businessId,
      planId: defaultPlan.id,
      status: 'trialing',
      trialEndsAt,
      createdBy,
    });
  }
}
