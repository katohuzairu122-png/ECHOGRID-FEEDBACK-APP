import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client';
import { auditLog, businesses, partnerCreditPolicies, partnerProgramEnrollments, rolePermissions, permissions, roles, userBusinessRoles, users } from '../db/schema';

/** Admin-recorded enrollment with distinct business-wide acceptance.
 * No award/credit/ledger operations are exposed.
 */
export class PartnerEnrollmentService {
  constructor(private readonly db: Database) {}

  /**
   * Only an authenticated business user's trusted server session may call
   * this function. There is deliberately no HTTP endpoint in Block 2.
   * Write acceptance and audit evidence atomically, distinct from platform
   * admin's subsequent enrollment approval.
   */
  async recordAcceptance(input: { businessId: string; authenticatedUserId: string; policyVersion: string; termsDigest: string }) {
    if (!/^[a-f0-9]{64}$/.test(input.termsDigest)) throw new Error('PARTNER_TERMS_DIGEST_REQUIRED');
    return this.db.transaction(async tx => {
      const actor = await tx.query.users.findFirst({ where: eq(users.id, input.authenticatedUserId) });
      if (!actor || actor.status !== 'active') throw new Error('PARTNER_CONSENT_ACTIVE_USER_REQUIRED');
      const business = await tx.query.businesses.findFirst({ where: eq(businesses.id, input.businessId) });
      if (!business || business.status !== 'active' || business.deletedAt) throw new Error('PARTNER_CONSENT_ACTIVE_BUSINESS_REQUIRED');
      const authority = await tx.select({ id: userBusinessRoles.id }).from(userBusinessRoles)
        .innerJoin(roles, eq(roles.id, userBusinessRoles.roleId))
        .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(and(eq(userBusinessRoles.userId, input.authenticatedUserId),
          eq(userBusinessRoles.businessId, input.businessId), isNull(userBusinessRoles.branchId),
          isNull(userBusinessRoles.deletedAt), eq(roles.businessId, input.businessId),
          isNull(roles.deletedAt), eq(permissions.key, 'billing:manage'))).limit(1);
      if (!authority.length) throw new Error('PARTNER_CONSENT_BUSINESS_WIDE_AUTHORITY_REQUIRED');
      const policy = await tx.query.partnerCreditPolicies.findFirst({
        where: and(eq(partnerCreditPolicies.version, input.policyVersion), eq(partnerCreditPolicies.state, 'active')),
      });
      if (!policy || !policy.effectiveAt || policy.effectiveAt > new Date() ||
          policy.awardUnits !== 1 || policy.monthlyCap !== 10 ||
          policy.vestDays !== 14 || policy.expiresAfterMonths !== 12)
        throw new Error('PARTNER_CONSENT_FROZEN_POLICY_REQUIRED');
      const [row] = await tx.insert(auditLog).values({
        businessId: input.businessId, actorUserId: input.authenticatedUserId,
        action: 'partner_credit_program.terms_accepted', entityType: 'partner_program_enrollment',
        metadata: { policyVersion: input.policyVersion, termsDigest: input.termsDigest },
      }).returning({ id: auditLog.id });
      if (!row) throw new Error('PARTNER_CONSENT_AUDIT_FAILED');
      return { acceptanceRef: row.id };
    });
  }

  async enroll(input: { businessId: string; consentingUserId: string; platformAdminId: string; policyVersion: string; acceptanceRef: string }) {
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
      const acceptance = await tx.query.auditLog.findFirst({
        where: and(eq(auditLog.id, input.acceptanceRef), eq(auditLog.businessId, input.businessId),
          eq(auditLog.actorUserId, input.consentingUserId),
          eq(auditLog.action, 'partner_credit_program.terms_accepted')),
      });
      const acceptanceMetadata = acceptance?.metadata as Record<string, unknown> | null | undefined;
      if (!acceptance || !acceptance.createdAt ||
          Date.now() - acceptance.createdAt.getTime() > 24 * 60 * 60 * 1000 ||
          acceptance.createdAt.getTime() > Date.now() ||
          acceptanceMetadata?.policyVersion !== input.policyVersion ||
          typeof acceptanceMetadata.termsDigest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(acceptanceMetadata.termsDigest))
        throw new Error('PARTNER_ENROLLMENT_VALID_CONSENT_RECEIPT_REQUIRED');
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
      await tx.insert(auditLog).values({ businessId: input.businessId, actorUserId: input.platformAdminId,
        action: 'partner_credit_program.enrollment_approved', entityType: 'partner_program_enrollment',
        entityId: row.id, metadata: { acceptanceRef: input.acceptanceRef, consentingUserId: input.consentingUserId, policyVersion: policy.version },
      });
      return row;
    });
  }

  async findForBusiness(businessId: string) {
    return this.db.query.partnerProgramEnrollments.findFirst({
      where: eq(partnerProgramEnrollments.businessId, businessId),
    });
  }
}
