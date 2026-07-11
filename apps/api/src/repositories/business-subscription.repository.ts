import { eq, sql } from 'drizzle-orm';
import { businessSubscriptions, subscriptionPlans } from '../db/schema';
import { BaseRepository } from './base.repository';

export type BusinessSubscription = typeof businessSubscriptions.$inferSelect;
export type NewBusinessSubscription = typeof businessSubscriptions.$inferInsert;

export type BusinessSubscriptionWithPlan = BusinessSubscription & {
  plan: import('./subscription-plan.repository').SubscriptionPlan;
};

export type BusinessSubscriptionWithDetails = BusinessSubscription & {
  businessName: string;
  planName: string;
};

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

/** Fields a Stripe webhook event can legitimately update -- deliberately
 * excludes businessId/planId identity fields from the general patch shape;
 * planId is resolved separately by the caller (billing/stripe-webhook.service.ts)
 * since it requires a price-ID lookup, not a direct field passthrough. */
export type StripeSyncPatch = Pick<
  NewBusinessSubscription,
  | 'planId'
  | 'stripeCustomerId'
  | 'stripeSubscriptionId'
  | 'status'
  | 'billingInterval'
  | 'currentPeriodStart'
  | 'currentPeriodEnd'
  | 'cancelAtPeriodEnd'
  | 'canceledAt'
>;

export class BusinessSubscriptionRepository extends BaseRepository {
  async findByBusiness(businessId: string): Promise<BusinessSubscription | undefined> {
    return this.db.query.businessSubscriptions.findFirst({
      where: eq(businessSubscriptions.businessId, businessId),
    });
  }

  /** Hydrated with plan details in one query (Drizzle relational query, same
   * `with:` pattern as AuditLogRepository.listAllWithDetails) -- the billing
   * page needs the plan's name/price/limits alongside the subscription's own
   * status/dates, and there is exactly one caller for the unhydrated
   * variant's data (none, currently), so this is the only read method this
   * repository needs -- no separate lean version to maintain in parallel. */
  async findByBusinessWithPlan(businessId: string): Promise<BusinessSubscriptionWithPlan | undefined> {
    return this.db.query.businessSubscriptions.findFirst({
      where: eq(businessSubscriptions.businessId, businessId),
      with: { plan: true },
    }) as Promise<BusinessSubscriptionWithPlan | undefined>;
  }

  async create(input: NewBusinessSubscription): Promise<BusinessSubscription> {
    const [row] = await this.db.insert(businessSubscriptions).values(input).returning();
    return row;
  }

  /**
   * The webhook sync's single write path (billing/stripe-webhook.service.ts).
   * Upserts by businessId -- the row's own unique index -- so a replayed or
   * out-of-order Stripe event is a harmless overwrite of current state, not
   * a duplicate row or an error. `businessId` must already be known (resolved
   * from the Stripe subscription's metadata by the caller) since it is the
   * conflict target, not something this method can derive on its own.
   */
  async upsertFromStripe(businessId: string, patch: StripeSyncPatch): Promise<BusinessSubscription> {
    const [row] = await this.db
      .insert(businessSubscriptions)
      .values({ businessId, ...patch })
      .onConflictDoUpdate({
        target: businessSubscriptions.businessId,
        set: { ...patch, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  async findByStripeSubscriptionId(stripeSubscriptionId: string): Promise<BusinessSubscription | undefined> {
    return this.db.query.businessSubscriptions.findFirst({
      where: eq(businessSubscriptions.stripeSubscriptionId, stripeSubscriptionId),
    });
  }

  /**
   * Cross-tenant subscription list (Billing Block 10) -- same hydration/
   * pagination shape as AuditLogRepository.listAllWithDetails. Unlike that
   * method, businessName/planName are never null here: business_subscriptions'
   * FKs are CASCADE (businessId) and RESTRICT (planId), so a row can never
   * outlive either parent -- see the schema's own comment on why, and
   * platformBusinessSubscriptionSchema's comment on the resulting DTO
   * contrast with the audit log entry's genuinely-nullable equivalents.
   */
  async listAllWithDetails(
    filters: { status?: string } = {},
    pagination: { limit?: number; offset?: number } = {},
  ): Promise<BusinessSubscriptionWithDetails[]> {
    const limit = Math.min(pagination.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const rows = await this.db.query.businessSubscriptions.findMany({
      where: filters.status ? eq(businessSubscriptions.status, filters.status) : undefined,
      limit,
      offset: pagination.offset ?? 0,
      orderBy: (s, { desc }) => [desc(s.createdAt)],
      with: { business: true, plan: true },
    });

    return rows.map(({ business, plan, ...subscription }) => ({
      ...subscription,
      businessName: business.name,
      planName: plan.name,
    }));
  }

  /**
   * Platform-wide MRR (Billing Block 10) -- a real SQL SUM/COUNT aggregate,
   * not a fetch-every-row-and-reduce-in-JS approach, per "design for global
   * scale": this stays a single fast query regardless of how many active
   * subscriptions exist. Yearly subscriptions are normalized to their
   * monthly-equivalent contribution (price / 12); see
   * platformMrrSummarySchema's comment for the v1 single-currency caveat.
   *
   * Postgres SUM()/COUNT() return bigint, which node-postgres surfaces as a
   * JS string (avoiding silent precision loss past Number.MAX_SAFE_INTEGER)
   * -- explicitly Number()'d below since MRR in cents will never realistically
   * approach that boundary and the DTO contract is a plain number.
   */
  async calculateMrr(): Promise<{ mrrCents: number; activeSubscriptionCount: number }> {
    const [result] = await this.db
      .select({
        mrrCents: sql<string>`COALESCE(SUM(
          CASE WHEN ${businessSubscriptions.billingInterval} = 'year'
            THEN ${subscriptionPlans.priceYearlyCents} / 12
            ELSE ${subscriptionPlans.priceMonthlyCents}
          END
        ), 0)`,
        activeSubscriptionCount: sql<string>`COUNT(*)`,
      })
      .from(businessSubscriptions)
      .innerJoin(subscriptionPlans, eq(businessSubscriptions.planId, subscriptionPlans.id))
      .where(eq(businessSubscriptions.status, 'active'));

    return {
      mrrCents: Number(result?.mrrCents ?? 0),
      activeSubscriptionCount: Number(result?.activeSubscriptionCount ?? 0),
    };
  }
}
