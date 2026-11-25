import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLog, branches, customerInvitations, customerOnboardingEvents } from '../db/schema';
import { AppError } from '../lib/errors';
import { DEFAULT_INVITATION_HOURS, MAX_INVITATION_HOURS } from './invitation-token';

export type InvitationStatus = 'active' | 'expired' | 'revoked' | 'accepted';
export type InvitationView = { id: string; branchId: string; branchName: string; status: InvitationStatus; createdAt: string; expiresAt: string; revokedAt: string | null; acceptedAt: string | null };
export type IssueContext = { actorUserId: string; ipAddress?: string | null; userAgent?: string | null };

const statusOf = (row: { expiresAt: Date; revokedAt: Date | null }, acceptedAt: Date | null, now: Date): InvitationStatus =>
  acceptedAt ? 'accepted' : row.revokedAt ? 'revoked' : row.expiresAt <= now ? 'expired' : 'active';

/**
 * OWNER-INVITE-01: issuing, listing and revoking owner-issued customer invitations. Callers own authentication and authorization
 * (`cashier:manage`, business-wide, never a cashier credential). Everything is pinned to the business the caller has proven; the branch
 * must be an active branch of that business. Issue/revoke write their audit rows in the same transaction. Listing shows NO customer
 * identity: an accepted invitation shows only that, and when, it was accepted.
 */
export class CustomerInvitationService {
  constructor(private readonly db: Db) {}

  async issue(businessId: string, input: { branchId: string; expiresInHours?: number | undefined; requestKey?: string | undefined }, ctx: IssueContext) {
    const hours = input.expiresInHours ?? DEFAULT_INVITATION_HOURS;
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_INVITATION_HOURS) throw new AppError(`Expiry must be 1 to ${MAX_INVITATION_HOURS} hours.`, 400, 'VALIDATION_ERROR');
    return this.db.transaction(async (tx) => {
      const [branch] = await tx.select({ id: branches.id }).from(branches)
        .where(and(eq(branches.id, input.branchId), eq(branches.businessId, businessId), eq(branches.isDeleted, false), eq(branches.status, 'active'))).limit(1);
      if (!branch) throw new AppError('Choose an active branch of this business.', 422, 'INVITATION_BRANCH_INVALID');
      const expiresAt = new Date(Date.now() + hours * 3_600_000);
      const [row] = await tx.insert(customerInvitations)
        .values({ businessId, branchId: input.branchId, issuedByUserId: ctx.actorUserId, requestKey: input.requestKey ?? null, expiresAt })
        .onConflictDoNothing().returning();
      if (!row) { // idempotent repeat of the same request key: the same invitation, no second row, no second audit
        const [existing] = await tx.select().from(customerInvitations).where(and(
          eq(customerInvitations.businessId, businessId), eq(customerInvitations.issuedByUserId, ctx.actorUserId), eq(customerInvitations.requestKey, input.requestKey ?? ''))).limit(1);
        if (!existing) throw new Error('Invitation neither inserted nor found');
        if (existing.branchId !== input.branchId) throw new AppError('That request key was used for a different branch.', 409, 'REQUEST_KEY_CONFLICT');
        return { invitation: existing, created: false };
      }
      await tx.insert(auditLog).values({
        businessId, actorUserId: ctx.actorUserId, action: 'customer_invitation.issued', entityType: 'customer_invitation', entityId: row.id,
        metadata: { outcome: 'success', branchId: input.branchId, expiresInHours: hours }, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null,
      });
      return { invitation: row, created: true };
    });
  }

  async list(businessId: string, limit = 100): Promise<{ invitations: InvitationView[]; counts: Record<InvitationStatus, number> }> {
    const rows = await this.db.select({ i: customerInvitations, branchName: branches.name, acceptedAt: sql<Date | null>`(select min(e.occurred_at) from customer_onboarding_events e where e.business_id = ${customerInvitations.businessId} and e.source = 'remote_invitation' and e.reference = ${customerInvitations.id}::text)` })
      .from(customerInvitations).innerJoin(branches, eq(branches.id, customerInvitations.branchId))
      .where(eq(customerInvitations.businessId, businessId)).orderBy(desc(customerInvitations.createdAt)).limit(Math.min(Math.max(limit, 1), 200));
    const now = new Date();
    const counts: Record<InvitationStatus, number> = { active: 0, expired: 0, revoked: 0, accepted: 0 };
    const invitations = rows.map(({ i, branchName, acceptedAt }) => {
      const accepted = acceptedAt ? new Date(acceptedAt) : null;
      const status = statusOf(i, accepted, now);
      counts[status] += 1;
      return { id: i.id, branchId: i.branchId, branchName, status, createdAt: i.createdAt.toISOString(), expiresAt: i.expiresAt.toISOString(), revokedAt: i.revokedAt?.toISOString() ?? null, acceptedAt: accepted?.toISOString() ?? null };
    });
    return { invitations, counts };
  }

  /** Idempotent: revoking a revoked invitation returns it unchanged. An ACCEPTED invitation cannot be revoked (it has already been used). */
  async revoke(businessId: string, invitationId: string, ctx: IssueContext) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(customerInvitations).where(and(eq(customerInvitations.id, invitationId), eq(customerInvitations.businessId, businessId))).for('update').limit(1);
      if (!row) throw new AppError('Invitation not found.', 404, 'INVITATION_NOT_FOUND');
      if (row.revokedAt) return { invitation: row, created: false };
      const used = await tx.select({ id: customerOnboardingEvents.id }).from(customerOnboardingEvents).where(and(
        eq(customerOnboardingEvents.businessId, businessId), eq(customerOnboardingEvents.source, 'remote_invitation'), eq(customerOnboardingEvents.reference, invitationId))).limit(1);
      if (used.length > 0) throw new AppError('This invitation has already been used.', 409, 'INVITATION_ALREADY_USED');
      const [updated] = await tx.update(customerInvitations).set({ revokedAt: new Date(), revokedByUserId: ctx.actorUserId }).where(eq(customerInvitations.id, invitationId)).returning();
      await tx.insert(auditLog).values({
        businessId, actorUserId: ctx.actorUserId, action: 'customer_invitation.revoked', entityType: 'customer_invitation', entityId: invitationId,
        metadata: { outcome: 'success' }, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null,
      });
      return { invitation: updated!, created: true };
    });
  }

  /** For the issuer's token re-signing on an idempotent repeat. */
  async get(businessId: string, invitationId: string) {
    const [row] = await this.db.select().from(customerInvitations).where(and(eq(customerInvitations.id, invitationId), eq(customerInvitations.businessId, businessId))).limit(1);
    return row ?? null;
  }
}

/**
 * Inside the customer's join transaction: the invitation must STILL be usable. The row is taken FOR SHARE first, so a concurrent revocation
 * (which updates it) either committed before and is refused here, or waits for this join to finish. Every failure is the same generic
 * customer-facing error: the customer learns nothing about why, or about the issuer.
 */
export async function assertOwnerInvitationUsable(tx: Db, claims: { invitationId: string; businessId: string; branchId: string }): Promise<void> {
  const refuse = () => new AppError('This invitation is no longer valid. Ask the business for a new one.', 409, 'ONBOARDING_INVITE_INVALID');
  const rows = await tx.execute(sql`
    SELECT 1 AS ok
    FROM customer_invitations ci
    JOIN businesses b ON b.id = ci.business_id AND b.status = 'active'
    JOIN branches br ON br.id = ci.branch_id AND br.business_id = ci.business_id AND br.is_deleted = false AND br.status = 'active'
    JOIN users u ON u.id = ci.issued_by_user_id AND u.is_deleted = false AND u.status = 'active'
    WHERE ci.id = ${claims.invitationId} AND ci.business_id = ${claims.businessId} AND ci.branch_id = ${claims.branchId}
      AND ci.revoked_at IS NULL AND ci.expires_at > now()
      -- the issuer must STILL hold the permission that lets them invite, in this business
      AND EXISTS (
        SELECT 1 FROM user_business_roles ubr
        JOIN role_permissions rp ON rp.role_id = ubr.role_id
        JOIN permissions p ON p.id = rp.permission_id
        WHERE ubr.user_id = u.id AND ubr.business_id = ci.business_id AND ubr.deleted_at IS NULL AND ubr.branch_id IS NULL AND p.key = 'cashier:manage'
      )
    FOR SHARE OF ci
    LIMIT 1`);
  if (rows.rows.length === 0) throw refuse();
}
