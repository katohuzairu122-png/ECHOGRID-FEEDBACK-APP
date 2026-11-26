import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLog, businessClosureRequests, businesses } from '../db/schema';
import { AppError } from '../lib/errors';
import {
  CLOSURE_OBLIGATION_KEYS, confirmationMatches, emptyObligations, evaluateClosureEligibility,
  type ClosureEligibility, type ClosureObligations,
} from './closure-eligibility';

export type ClosureRequestView = {
  id: string;
  status: 'pending' | 'cancelled' | 'processed';
  requestedAt: string;
  cancelledAt: string | null;
};
const toView = (r: typeof businessClosureRequests.$inferSelect): ClosureRequestView => ({
  id: r.id, status: r.status, requestedAt: r.requestedAt.toISOString(), cancelledAt: r.cancelledAt?.toISOString() ?? null,
});

export type AuditContext = { actorUserId: string; ipAddress?: string | null; userAgent?: string | null };

/**
 * BIZ-CLOSE-01. Everything here is a request record plus read-only checks: no business, customer, loyalty, subscription, session or
 * Community row is changed or deleted, and no closure is ever processed. Callers own authentication, owner-only authorization
 * (`business:delete`, business-wide) and the fresh re-authentication proof; this service enforces confirmation, idempotency,
 * concurrency safety and audit evidence, and always scopes by the business id the caller has already proven.
 */
export class BusinessClosureService {
  constructor(private readonly db: Db) {}

  /** Read-only aggregate counts of what a closure policy would have to resolve. Counts only; no customer identity leaves this query. */
  async obligations(businessId: string, db: Db = this.db): Promise<ClosureObligations> {
    const rows = await db.execute<Record<string, string | number | null>>(sql`
      select
        (select count(*) from loyalty_transactions lt join loyalty_accounts la on la.id = lt.loyalty_account_id
          where la.business_id = ${businessId} and lt.type = 'redemption' and lt.issuance_status = 'pending') as pending_redemptions,
        (select count(*) from loyalty_accounts where business_id = ${businessId} and is_deleted = false and points > 0) as customer_point_balances,
        (select coalesce(sum(points), 0) from loyalty_accounts where business_id = ${businessId} and is_deleted = false) as customer_points_outstanding,
        (select count(*) from business_customer_memberships where business_id = ${businessId} and status in ('pending','active','suspended')) as active_memberships,
        (select count(*) from orphan_reward_claims where origin_business_id = ${businessId} and status in ('available','reserved')) as open_orphan_reward_claims,
        (select count(*) from business_subscriptions where business_id = ${businessId} and status in ('trialing','active','past_due','unpaid','incomplete')) as active_subscriptions,
        (select count(*) from refresh_tokens where client = 'cashier' and business_id = ${businessId} and revoked_at is null and expires_at > now()) as active_cashier_sessions,
        (select count(distinct user_id) from user_business_roles where business_id = ${businessId}) as staff_members,
        (select count(*) from network_posts where content_class = 'business' and business_id = ${businessId} and state in ('published','suspended')) as published_community_posts,
        (select count(*) from network_follows where business_id = ${businessId}) as community_followers,
        (select count(*) from drop_sponsorships where business_id = ${businessId} and status in ('submitted','under_review','approved','scheduled','available','suspended')) as active_sponsorships,
        (select count(*) from drop_reservations r join drop_sponsorships ds on ds.id = r.sponsorship_id where ds.business_id = ${businessId} and r.status in ('reserved','allocated')) as units_awaiting_collection,
        (select count(*) from governance_cases gc where gc.status <> 'closed' and gc.sponsorship_id in (select id from drop_sponsorships where business_id = ${businessId})) as open_governance_cases
    `);
    const row = rows.rows?.[0] ?? {};
    const out = emptyObligations();
    const columns: Record<(typeof CLOSURE_OBLIGATION_KEYS)[number], string> = {
      pendingRedemptions: 'pending_redemptions', customerPointBalances: 'customer_point_balances',
      customerPointsOutstanding: 'customer_points_outstanding', activeMemberships: 'active_memberships',
      openOrphanRewardClaims: 'open_orphan_reward_claims', activeSubscriptions: 'active_subscriptions',
      activeCashierSessions: 'active_cashier_sessions', staffMembers: 'staff_members',
      publishedCommunityPosts: 'published_community_posts', communityFollowers: 'community_followers',
      activeSponsorships: 'active_sponsorships', unitsAwaitingCollection: 'units_awaiting_collection', openGovernanceCases: 'open_governance_cases',
    };
    for (const key of CLOSURE_OBLIGATION_KEYS) out[key] = Number(row[columns[key]] ?? 0);
    return out;
  }

  async eligibility(businessId: string): Promise<ClosureEligibility> {
    return evaluateClosureEligibility(await this.obligations(businessId));
  }

  async status(businessId: string): Promise<{ request: ClosureRequestView | null; eligibility: ClosureEligibility }> {
    const [pending] = await this.db.select().from(businessClosureRequests)
      .where(and(eq(businessClosureRequests.businessId, businessId), eq(businessClosureRequests.status, 'pending'))).limit(1);
    return { request: pending ? toView(pending) : null, eligibility: await this.eligibility(businessId) };
  }

  /**
   * Idempotent: a second call while a request is pending returns that request (created=false) and writes nothing. Concurrency-safe: the
   * partial unique index admits one pending row per business, and the insert and its audit row commit together (no request without
   * evidence, no evidence without a request).
   */
  async file(businessId: string, typedConfirmation: string, ctx: AuditContext): Promise<{ request: ClosureRequestView; created: boolean }> {
    const [business] = await this.db.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
    if (!business) throw new AppError('Business not found.', 404, 'BUSINESS_NOT_FOUND');
    if (!confirmationMatches(business.name, typedConfirmation)) {
      throw new AppError('Type the business name exactly to confirm.', 422, 'CONFIRMATION_MISMATCH');
    }
    return this.db.transaction(async (tx) => {
      const obligations = await this.obligations(businessId, tx as unknown as Db);
      const [row] = await tx.insert(businessClosureRequests)
        .values({ businessId, requestedByUserId: ctx.actorUserId, obligationsSnapshot: obligations })
        .onConflictDoNothing()
        .returning();
      if (!row) {
        const [existing] = await tx.select().from(businessClosureRequests)
          .where(and(eq(businessClosureRequests.businessId, businessId), eq(businessClosureRequests.status, 'pending'))).limit(1);
        if (!existing) throw new Error('Closure request neither inserted nor found');
        return { request: toView(existing), created: false };
      }
      await tx.insert(auditLog).values({
        businessId, actorUserId: ctx.actorUserId, action: 'business.closure_requested', entityType: 'business_closure_request',
        entityId: row.id, metadata: { outcome: 'success', processing: 'blocked', obligations },
        ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null,
      });
      return { request: toView(row), created: true };
    });
  }

  /** pending -> cancelled only. Returns null when nothing is pending (idempotent). Audit row commits with the change. */
  async withdraw(businessId: string, ctx: AuditContext): Promise<ClosureRequestView | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(businessClosureRequests)
        .set({ status: 'cancelled', cancelledAt: new Date(), cancelledByUserId: ctx.actorUserId })
        .where(and(eq(businessClosureRequests.businessId, businessId), eq(businessClosureRequests.status, 'pending')))
        .returning();
      if (!row) return null;
      await tx.insert(auditLog).values({
        businessId, actorUserId: ctx.actorUserId, action: 'business.closure_withdrawn', entityType: 'business_closure_request',
        entityId: row.id, metadata: { outcome: 'success' }, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null,
      });
      return toView(row);
    });
  }

  /** Platform-admin visibility: pending requests, newest first, with business names. Read-only. */
  async listPending(limit = 50): Promise<Array<ClosureRequestView & { businessId: string; businessName: string }>> {
    const rows = await this.db
      .select({ r: businessClosureRequests, name: businesses.name })
      .from(businessClosureRequests)
      .innerJoin(businesses, eq(businesses.id, businessClosureRequests.businessId))
      .where(eq(businessClosureRequests.status, 'pending'))
      .orderBy(desc(businessClosureRequests.requestedAt))
      .limit(Math.min(Math.max(limit, 1), 200));
    return rows.map(({ r, name }) => ({ ...toView(r), businessId: r.businessId, businessName: name }));
  }

  /** Platform-admin detail: request plus the CURRENT eligibility evaluation (blocked state). */
  async detail(requestId: string): Promise<{ request: ClosureRequestView & { businessId: string }; eligibility: ClosureEligibility } | null> {
    const [r] = await this.db.select().from(businessClosureRequests).where(eq(businessClosureRequests.id, requestId)).limit(1);
    if (!r) return null;
    return { request: { ...toView(r), businessId: r.businessId }, eligibility: await this.eligibility(r.businessId) };
  }
}
