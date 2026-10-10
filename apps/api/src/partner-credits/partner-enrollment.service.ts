import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client';
import { businesses, partnerCreditPolicies, partnerProgramEnrollments, rolePermissions, permissions, roles, userBusinessRoles, users } from '../db/schema';

/** Admin-recorded enrollment with distinct business-wide acceptance.
 * No award/credit/ledger operations are exposed.
 */
export class PartnerEnrollmentService {
  constructor(private readonly db: Database) {}

  async enroll(input: { businessId: string; consentingUserId: string; platformAdminId: string; policyVersion: string }) {
    return this.db.transaction(async tx => {
      const admin = await tx.query.users.findFirst({ where: eq(users.id, input.platformAdminId) });
      if (!admin || admin.status !== 'active' || admin.platformRole !== 'admin') throw new Error('PARTNER_ENROLLMENT_ADMIN_REQUIRED');
      const business = await tx.query.businesses.findFirst({ where: eq(businesses.id, input.businessId) });
      if (!business || business.status !== 'active' || business.deletedAt) throw new Error('PARTNER_ENROLLMENT_BUSINESS_INACTIVE');
      const consentingUser = await tx.query.users.findFirst({ where: eq(users.id, input.consentingUserId) });
      if (!consentingUser || consentingUser.status !== 'active') throw new Error('PARTNER_ENROLLMENT_CONSENT_REQUIRED');
      // Business-wide billing:manage permission is the established financial authority.
      // Branch-scoped grants are expressly excluded.
      const authority = await tx.select({ id: userBusinessRoles.id }).from(userBusinessRoles)
        .innerJoin(roles, eq(roles.id, userBusinessRoles.roleId))
        .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(and(eq(userBusinessRoles.userId, input.consentingUserId),
          eq(userBusinessRoles.businessId, input.businessId),
          isNull(userBusinessRoles.branchId),
          isNull(userBusinessRoles.deletedAt),
          eq(roles.businessId, input.businessId),
          isNull(roles.deletedAt),
          eq(permissions.key, 'billing:manage')))
        .limit(1);
      if (!authority.length) throw new Error('PARTNER_ENROLLMENT_BUSINESS_WIDE_CONSENT_REQUIRED');
      const policy = await tx.query.partnerCreditPolicies.findFirst({
        where: and(eq(partnerCreditPolicies.version, input.policyVersion), eq(partnerCreditPolicies.state, 'active')),
      });
      if (!policy || !policy.effectiveAt || policy.effectiveAt > new Date() ||
          policy.awardUnits !== 1 || policy.monthlyCap !== 10 ||
          policy.vestDays !== 14 || policy.expiresAfterMonths !== 12)
        throw new Error('PARTNER_ENROLLMENT_FROZEN_POLICY_REQUIRED');
      const existing = await tx.query.partnerProgramEnrollments.findFirst({
        where: eq(partnerProgramEnrollments.businessId, input.businessId),
      });
      if (existing) throw new Error('PARTNER_ENROLLMENT_ALREADY_EXISTS');
      const now = new Date();
      const [row] = await tx.insert(partnerProgramEnrollments).values({
        businessId: input.businessId, status: 'active',
        policyVersion: policy.version, acceptedByUserId: input.consentingUserId,
        acceptedAt: now, effectiveAt: now,
      }).returning();
      if (!row) throw new Error('PARTNER_ENROLLMENT_INSERT_FAILED');
      return row;
    });
  }

  async findForBusiness(businessId: string) {
    return this.db.query.partnerProgramEnrollments.findFirst({
      where: eq(partnerProgramEnrollments.businessId, businessId),
    });
  }
}
