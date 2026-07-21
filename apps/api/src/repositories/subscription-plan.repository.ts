import { eq, or, and, ne } from 'drizzle-orm';
import { subscriptionPlans } from '../db/schema';
import { BaseRepository } from './base.repository';

export type SubscriptionPlan = typeof subscriptionPlans.$inferSelect;
export type NewSubscriptionPlan = typeof subscriptionPlans.$inferInsert;

/**
 * Global catalog, not business-scoped -- every method reads across the
 * whole platform (see schema comment on subscription-plans.ts), unlike
 * RoleRepository's businessId-scoped precedent.
 */
export class SubscriptionPlanRepository extends BaseRepository {
  async listActive(): Promise<SubscriptionPlan[]> {
    return this.db.query.subscriptionPlans.findMany({
      where: eq(subscriptionPlans.isActive, true),
      orderBy: (p, { asc }) => [asc(p.sortOrder)],
    });
  }

  /** Includes retired (isActive=false) plans on purpose -- a future
   * platform-admin plan management screen (Block 10) must still see and
   * edit them, and this ordering (by sortOrder) is what that screen needs. */
  async listAll(): Promise<SubscriptionPlan[]> {
    return this.db.query.subscriptionPlans.findMany({
      orderBy: (p, { asc }) => [asc(p.sortOrder)],
    });
  }

  async findById(id: string): Promise<SubscriptionPlan | undefined> {
    return this.db.query.subscriptionPlans.findFirst({
      where: eq(subscriptionPlans.id, id),
    });
  }

  async findByKey(key: string): Promise<SubscriptionPlan | undefined> {
    return this.db.query.subscriptionPlans.findFirst({
      where: eq(subscriptionPlans.key, key),
    });
  }

  /** The single card-less trial default (see schema's isDefaultTrial
   * comment). Returns undefined, never throws, if the catalog hasn't been
   * seeded yet -- mirrors RoleProvisioningService's "catalog not seeded
   * yet, skip rather than fail" defensive precedent. */
  async findDefaultTrial(): Promise<SubscriptionPlan | undefined> {
    return this.db.query.subscriptionPlans.findFirst({
      where: eq(subscriptionPlans.isDefaultTrial, true),
    });
  }

  /**
   * Resolves a plan from a Stripe Price ID, checking both the monthly and
   * yearly columns -- used by the webhook sync (Billing Block 8) to derive
   * which plan a subscription's current price corresponds to, since Stripe
   * events carry price IDs, not this table's own plan IDs.
   *
   * Deliberately NOT filtered to isActive=true: a retired plan must stay
   * resolvable for its existing (grandfathered) subscribers -- that's the
   * whole reason plans are retired via isActive rather than deleted. Only a
   * NEW subscription (billing.service.ts's checkout flow) should be
   * restricted to active plans.
   */
  async findByStripePriceId(priceId: string): Promise<SubscriptionPlan | undefined> {
    return this.db.query.subscriptionPlans.findFirst({
      where: or(
        eq(subscriptionPlans.stripePriceIdMonthly, priceId),
        eq(subscriptionPlans.stripePriceIdYearly, priceId),
      ),
    });
  }

  /** Seeds a plan by key if it doesn't already exist, otherwise updates its
   * editable fields in place -- safe to re-run from the seed script on
   * every deploy, same idempotent-seed shape as PermissionRepository.ensure().
   * Never touches isActive: a redeploy of the seed script must not
   * silently un-retire a plan an operator deliberately deactivated. */
  async ensure(input: NewSubscriptionPlan): Promise<SubscriptionPlan> {
    const existing = await this.findByKey(input.key);
    if (!existing) {
      const [row] = await this.db.insert(subscriptionPlans).values(input).returning();
      if (!row) throw new Error('Insert returned no row');
      return row;
    }
    const { isActive: _ignoredIsActive, key: _ignoredKey, ...editable } = input;
    const [row] = await this.db
      .update(subscriptionPlans)
      .set(editable)
      .where(eq(subscriptionPlans.id, existing.id))
      .returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  /** Platform admin plan creation (Block 10) -- key uniqueness is enforced
   * by the DB (subscription_plans_key_key); a duplicate is left to surface
   * as a raw constraint error here, same as BusinessService relying on
   * businesses_slug_key rather than pre-checking twice for creates that
   * aren't already in a transaction the way BusinessService.createBusiness
   * is. billing-plans.routes.ts pre-checks findByKey instead, for a clean
   * 409 -- see that file for why the check lives at the route layer here. */
  async create(input: NewSubscriptionPlan): Promise<SubscriptionPlan> {
    const [row] = await this.db.insert(subscriptionPlans).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  /**
   * Platform admin plan editing (Block 10). When promoting a plan to
   * isDefaultTrial=true, first demotes whatever plan currently holds that
   * flag, in the same transaction -- without this, a second promotion would
   * hit subscription_plans_one_default_trial_idx (the partial unique index)
   * as a raw, unfriendly Postgres constraint violation instead of the clean
   * "there can only be one" swap an admin actually intends.
   */
  async update(
    id: string,
    patch: Partial<Omit<NewSubscriptionPlan, 'id' | 'key'>>,
    updatedBy: string,
  ): Promise<SubscriptionPlan | undefined> {
    if (patch.isDefaultTrial) {
      return this.db.transaction(async (tx) => {
        await tx
          .update(subscriptionPlans)
          .set({ isDefaultTrial: false })
          .where(and(eq(subscriptionPlans.isDefaultTrial, true), ne(subscriptionPlans.id, id)));
        const [row] = await tx
          .update(subscriptionPlans)
          .set({ ...patch, updatedBy, updatedAt: new Date() })
          .where(eq(subscriptionPlans.id, id))
          .returning();
        return row;
      });
    }

    const [row] = await this.db
      .update(subscriptionPlans)
      .set({ ...patch, updatedBy, updatedAt: new Date() })
      .where(eq(subscriptionPlans.id, id))
      .returning();
    return row;
  }
}
