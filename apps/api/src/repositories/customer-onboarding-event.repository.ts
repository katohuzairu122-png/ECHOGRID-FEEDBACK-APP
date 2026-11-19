import { and, asc, eq, sql } from 'drizzle-orm';
import { customerOnboardingEvents } from '../db/schema';
import type { CustomerOnboardingEvent, NewCustomerOnboardingEvent } from '../db/schema';
import { BaseRepository } from './base.repository';

export type { CustomerOnboardingEvent, NewCustomerOnboardingEvent };

export interface OnboardingSummaryFilter {
  businessId: string;
  from?: Date;
  to?: Date;
  branchId?: string;
}

export interface OnboardingBucket {
  events: number;
  uniqueCustomers: number;
}
export interface OnboardingSummary {
  /**
   * `erasedEvents`: events whose personal links were severed by a controlled erasure (D2-R1). They are still counted as events, but no
   * customer can be attributed to them, so `uniqueCustomers` EXCLUDES them and under-counts by up to this many customers. It is never
   * estimated or back-filled: the distinct-customer figure for erased history is unavailable by design.
   */
  totals: OnboardingBucket & { rejoinEvents: number; withoutBranch: number; erasedEvents: number };
  bySource: Array<OnboardingBucket & { source: string }>;
  byBranch: Array<OnboardingBucket & { branchId: string | null; branchName: string | null }>;
  byCashier: Array<OnboardingBucket & { cashierUserId: string; displayName: string | null }>;
}

const n = (v: unknown): number => Number(v ?? 0);

/**
 * CASHIER-AUTH-02D. Insert and read only: the table is append-only at the database (guard trigger), and this class offers no way to
 * change a row. Counts distinguish onboarding EVENTS from UNIQUE CUSTOMERS, so a customer who left and re-joined is one customer
 * with two events.
 */
export class CustomerOnboardingEventRepository extends BaseRepository {
  async append(event: NewCustomerOnboardingEvent): Promise<CustomerOnboardingEvent> {
    const [row] = await this.db.insert(customerOnboardingEvents).values(event).returning();
    if (!row) throw new Error('Onboarding event was not recorded');
    return row;
  }

  /** True when a one-time invitation of this business has already onboarded someone (read-only, for the customer's preview). */
  async assistedInviteUsed(businessId: string, reference: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: customerOnboardingEvents.id })
      .from(customerOnboardingEvents)
      .where(and(eq(customerOnboardingEvents.businessId, businessId), eq(customerOnboardingEvents.source, 'cashier_assisted'), eq(customerOnboardingEvents.reference, reference)))
      .limit(1);
    return rows.length > 0;
  }

  async listForMembership(membershipId: string): Promise<CustomerOnboardingEvent[]> {
    return this.db
      .select()
      .from(customerOnboardingEvents)
      .where(eq(customerOnboardingEvents.membershipId, membershipId))
      .orderBy(asc(customerOnboardingEvents.occurredAt), asc(customerOnboardingEvents.recordedAt));
  }

  /**
   * Read-only aggregates for one business. Re-joins use the is_rejoin fact stored on each event, so a customer whose membership pre-dates
   * this table and who then re-joins is still counted correctly, with no history invented. Returns counts only: no customer identifier or
   * contact detail ever leaves this method. After a controlled erasure the personal links are NULL: distinct-customer counts exclude those
   * events (see `erasedEvents`), and an event whose cashier link was severed no longer appears in `byCashier` (it stays in every other total).
   */
  async summarize(filter: OnboardingSummaryFilter): Promise<OnboardingSummary> {
    const range = [
      filter.from ? sql`AND r.occurred_at >= ${filter.from}` : sql``,
      filter.to ? sql`AND r.occurred_at < ${filter.to}` : sql``,
      filter.branchId ? sql`AND r.branch_id = ${filter.branchId}` : sql``,
    ];
    const ranked = sql`WITH r AS (SELECT e.* FROM customer_onboarding_events e WHERE e.business_id = ${filter.businessId})`;
    const where = sql`WHERE true ${range[0]} ${range[1]} ${range[2]}`;
    const totals = await this.db.execute(sql`${ranked}
      SELECT count(*) AS events, count(DISTINCT r.customer_id) AS unique_customers,
             count(*) FILTER (WHERE r.is_rejoin) AS rejoin_events, count(*) FILTER (WHERE r.branch_id IS NULL) AS without_branch,
             count(*) FILTER (WHERE r.erased_at IS NOT NULL) AS erased_events
      FROM r ${where}`);
    const bySource = await this.db.execute(sql`${ranked}
      SELECT r.source, count(*) AS events, count(DISTINCT r.customer_id) AS unique_customers
      FROM r ${where} GROUP BY r.source ORDER BY r.source`);
    const byBranch = await this.db.execute(sql`${ranked}
      SELECT r.branch_id, b.name AS branch_name, count(*) AS events, count(DISTINCT r.customer_id) AS unique_customers
      FROM r LEFT JOIN branches b ON b.id = r.branch_id ${where}
      GROUP BY r.branch_id, b.name ORDER BY count(*) DESC, b.name NULLS LAST`);
    const byCashier = await this.db.execute(sql`${ranked}
      SELECT r.cashier_user_id, u.full_name AS display_name, count(*) AS events, count(DISTINCT r.customer_id) AS unique_customers
      FROM r JOIN users u ON u.id = r.cashier_user_id ${where}
      GROUP BY r.cashier_user_id, u.full_name ORDER BY count(*) DESC, u.full_name`);
    const t = (totals.rows[0] ?? {}) as Record<string, unknown>;
    return {
      totals: { events: n(t.events), uniqueCustomers: n(t.unique_customers), rejoinEvents: n(t.rejoin_events), withoutBranch: n(t.without_branch), erasedEvents: n(t.erased_events) },
      bySource: bySource.rows.map((r) => ({ source: String(r.source), events: n(r.events), uniqueCustomers: n(r.unique_customers) })),
      byBranch: byBranch.rows.map((r) => ({
        branchId: (r.branch_id as string | null) ?? null, branchName: (r.branch_name as string | null) ?? null,
        events: n(r.events), uniqueCustomers: n(r.unique_customers),
      })),
      byCashier: byCashier.rows.map((r) => ({
        cashierUserId: String(r.cashier_user_id), displayName: (r.display_name as string | null) ?? null,
        events: n(r.events), uniqueCustomers: n(r.unique_customers),
      })),
    };
  }
}
