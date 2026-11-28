import { and, eq, isNull, or } from 'drizzle-orm';
import type { Database } from '../db/client';
import { AppError } from '../lib/errors';
import {
  auditLog,
  b2bModerationActions,
  b2bNotifications,
  b2bParticipationEvents,
  b2bParticipations,
  b2bTermsVersions,
  businesses,
  permissions,
  rolePermissions,
  roles,
  userBusinessRoles,
  users,
} from '../db/schema';

/**
 * SPLIT 09 block S9-A1 (owner ruling S9-D1): B2B participation = platform enrollment + the business's acceptance of
 * owner-approved B2B terms. Enrollment remains fail-closed without approved terms.
 *
 * Fail-closed: with no active terms version (none is owner-approved yet) nothing can be accepted or enrolled.
 * INTERIM AUTHORITY (owner to ratify, spec section 7 keys are proposals): accepting B2B terms is a binding commitment, so
 * it requires the same business-wide `billing:manage` authority Split 07 uses for its program terms. No B2B permission
 * key is invented here. Participation never touches loyalty, points, credits, billing or customer data.
 */
export const B2B_ACCEPTANCE_ACTION = 'b2b.terms_accepted';
const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REASON_MAX = 500;
export const B2B_ACCEPTANCE_AUTHORITY_KEY = 'billing:manage';

const deny = (status: 403 | 404 | 409 | 422, code: string, message: string) =>
  new AppError(message, status, code);

export class B2bParticipationService {
  constructor(private readonly db: Database) {}

  private async requireActivePlatformAdmin(tx: Pick<Database, 'query'>, userId: string) {
    const admin = await tx.query.users.findFirst({ where: eq(users.id, userId) });
    if (!admin || admin.status !== 'active' || admin.platformRole !== 'admin') {
      throw deny(
        403,
        'B2B_PLATFORM_ADMIN_REQUIRED',
        'Only an active platform admin may perform this action.',
      );
    }
  }

  private async activeTerms(tx: Pick<Database, 'query'>, version: string) {
    const terms = await tx.query.b2bTermsVersions.findFirst({
      where: and(eq(b2bTermsVersions.version, version), eq(b2bTermsVersions.state, 'active')),
    });
    if (!terms || !terms.effectiveAt || terms.effectiveAt > new Date()) {
      throw deny(409, 'B2B_TERMS_NOT_ACTIVE', 'No owner-approved B2B terms version is active.');
    }
    return terms;
  }

  /** Business-side acceptance. Writes an audit receipt bound to the terms version and digest. */
  async recordAcceptance(input: {
    businessId: string;
    authenticatedUserId: string;
    termsVersion: string;
  }) {
    return this.db.transaction(async (tx) => {
      const actor = await tx.query.users.findFirst({
        where: eq(users.id, input.authenticatedUserId),
      });
      if (!actor || actor.status !== 'active')
        throw deny(403, 'B2B_ACCEPTANCE_ACTIVE_USER_REQUIRED', 'An active user is required.');
      const business = await tx.query.businesses.findFirst({
        where: eq(businesses.id, input.businessId),
      });
      if (!business || business.status !== 'active' || business.deletedAt) {
        throw deny(
          403,
          'B2B_ACCEPTANCE_ACTIVE_BUSINESS_REQUIRED',
          'An active business is required.',
        );
      }
      const authority = await tx
        .select({ id: userBusinessRoles.id })
        .from(userBusinessRoles)
        .innerJoin(roles, eq(roles.id, userBusinessRoles.roleId))
        .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(
          and(
            eq(userBusinessRoles.userId, input.authenticatedUserId),
            eq(userBusinessRoles.businessId, input.businessId),
            isNull(userBusinessRoles.branchId),
            isNull(userBusinessRoles.deletedAt),
            eq(roles.businessId, input.businessId),
            isNull(roles.deletedAt),
            eq(permissions.key, B2B_ACCEPTANCE_AUTHORITY_KEY),
          ),
        )
        .limit(1);
      if (!authority.length)
        throw deny(
          403,
          'B2B_ACCEPTANCE_BUSINESS_WIDE_AUTHORITY_REQUIRED',
          'Business-wide authority is required to accept B2B terms.',
        );
      const terms = await this.activeTerms(tx, input.termsVersion);
      const [row] = await tx
        .insert(auditLog)
        .values({
          businessId: input.businessId,
          actorUserId: input.authenticatedUserId,
          action: B2B_ACCEPTANCE_ACTION,
          entityType: 'b2b_participation',
          metadata: { termsVersion: terms.version, termsDigest: terms.termsDigest },
        })
        .returning({ id: auditLog.id });
      if (!row) throw deny(409, 'B2B_ACCEPTANCE_AUDIT_FAILED', 'Acceptance could not be recorded.');
      return { acceptanceRef: row.id };
    });
  }

  /** Platform enrollment. Requires a fresh acceptance receipt from a business-wide authority of THIS business. */
  async enroll(input: {
    businessId: string;
    consentingUserId: string;
    platformAdminId: string;
    termsVersion: string;
    acceptanceRef: string;
  }) {
    return this.db.transaction(async (tx) => {
      await this.requireActivePlatformAdmin(tx, input.platformAdminId);
      const business = await tx.query.businesses.findFirst({
        where: eq(businesses.id, input.businessId),
      });
      if (!business || business.status !== 'active' || business.deletedAt) {
        throw deny(409, 'B2B_ENROLLMENT_BUSINESS_INACTIVE', 'The business is not active.');
      }
      const terms = await this.activeTerms(tx, input.termsVersion);
      const receipt = await tx.query.auditLog.findFirst({
        where: and(
          eq(auditLog.id, input.acceptanceRef),
          eq(auditLog.businessId, input.businessId),
          eq(auditLog.actorUserId, input.consentingUserId),
          eq(auditLog.action, B2B_ACCEPTANCE_ACTION),
        ),
      });
      const meta = receipt?.metadata as Record<string, unknown> | null | undefined;
      const age = receipt?.createdAt
        ? Date.now() - receipt.createdAt.getTime()
        : Number.POSITIVE_INFINITY;
      if (
        !receipt ||
        age < 0 ||
        age > RECEIPT_MAX_AGE_MS ||
        meta?.termsVersion !== terms.version ||
        meta?.termsDigest !== terms.termsDigest
      ) {
        throw deny(
          409,
          'B2B_ENROLLMENT_VALID_ACCEPTANCE_REQUIRED',
          'A valid, current acceptance receipt is required.',
        );
      }
      const existing = await tx.query.b2bParticipations.findFirst({
        where: eq(b2bParticipations.businessId, input.businessId),
      });
      if (existing)
        throw deny(
          409,
          'B2B_PARTICIPATION_ALREADY_EXISTS',
          'The business already has a participation record.',
        );
      const [row] = await tx
        .insert(b2bParticipations)
        .values({
          businessId: input.businessId,
          status: 'active',
          termsVersionId: terms.id,
          termsDigest: terms.termsDigest,
          acceptedByUserId: input.consentingUserId,
          acceptedAt: receipt.createdAt!,
          enrolledByUserId: input.platformAdminId,
        })
        .returning();
      if (!row) throw deny(409, 'B2B_ENROLLMENT_INSERT_FAILED', 'Enrollment failed.');
      await tx.insert(auditLog).values({
        businessId: input.businessId,
        actorUserId: input.platformAdminId,
        action: 'b2b.participation_enrolled',
        entityType: 'b2b_participation',
        entityId: row.id,
        metadata: {
          acceptanceRef: input.acceptanceRef,
          consentingUserId: input.consentingUserId,
          termsVersion: terms.version,
        },
      });
      await tx.insert(b2bParticipationEvents).values({
        participationId: row.id,
        businessId: input.businessId,
        eventType: 'enrolled',
        actorUserId: input.platformAdminId,
        metadata: { termsVersion: terms.version, acceptanceRef: input.acceptanceRef },
      });
      return row;
    });
  }

  async suspend(input: { businessId: string; platformAdminId: string; reason: string }) {
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 1 || reason.length > REASON_MAX)
      throw deny(
        422,
        'B2B_REASON_INVALID',
        `A reason of 1 to ${REASON_MAX} characters is required.`,
      );
    return this.transition(
      input.businessId,
      input.platformAdminId,
      'active',
      'suspended',
      'b2b.participation_suspended',
      { reason },
    );
  }

  async reinstate(input: { businessId: string; platformAdminId: string; reason: string }) {
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 1 || reason.length > REASON_MAX)
      throw deny(
        422,
        'B2B_REASON_INVALID',
        `A reason of 1 to ${REASON_MAX} characters is required.`,
      );
    return this.transition(
      input.businessId,
      input.platformAdminId,
      'suspended',
      'active',
      'b2b.participation_reinstated',
      { reason },
    );
  }

  private async transition(
    businessId: string,
    adminId: string,
    from: 'active' | 'suspended',
    to: 'active' | 'suspended',
    action: string,
    metadata: Record<string, unknown>,
  ) {
    return this.db.transaction(async (tx) => {
      await this.requireActivePlatformAdmin(tx, adminId);
      const now = new Date();
      // Conditional update = optimistic state check: a concurrent or repeated call matches no row and is a clean conflict.
      const [row] = await tx
        .update(b2bParticipations)
        .set({
          status: to,
          updatedAt: now,
          suspendedAt: to === 'suspended' ? now : null,
          suspendedByUserId: to === 'suspended' ? adminId : null,
        })
        .where(
          and(eq(b2bParticipations.businessId, businessId), eq(b2bParticipations.status, from)),
        )
        .returning();
      if (!row) {
        const current = await tx.query.b2bParticipations.findFirst({
          where: eq(b2bParticipations.businessId, businessId),
        });
        if (!current)
          throw deny(404, 'B2B_PARTICIPATION_NOT_FOUND', 'No participation record exists.');
        throw deny(
          409,
          'B2B_PARTICIPATION_STATE_CONFLICT',
          `Participation is ${current.status}, expected ${from}.`,
        );
      }
      await tx.insert(auditLog).values({
        businessId,
        actorUserId: adminId,
        action,
        entityType: 'b2b_participation',
        entityId: row.id,
        metadata,
      });
      await tx.insert(b2bParticipationEvents).values({
        participationId: row.id,
        businessId,
        eventType: to === 'suspended' ? 'suspended' : 'reinstated',
        actorUserId: adminId,
        metadata,
      });
      await tx.insert(b2bModerationActions).values({
        targetBusinessId: businessId,
        actorUserId: adminId,
        actionType: to === 'suspended' ? 'restrict_participation' : 'restore_participation',
        reasonCode: to === 'suspended' ? 'ADMIN_RESTRICTION' : 'ADMIN_REINSTATEMENT',
        reason: String(
          metadata.reason ??
            (to === 'active' ? 'Participation reinstated after platform review.' : ''),
        ),
      });
      await tx.insert(b2bNotifications).values({
        recipientBusinessId: businessId,
        eventKey: `participation:${row.id}:${action}:${now.toISOString()}`,
        eventType: 'moderation_action',
        subject:
          to === 'suspended'
            ? 'Business Network participation restricted'
            : 'Business Network participation restored',
        body:
          to === 'suspended'
            ? 'A platform administrator restricted participation. Contact support for details.'
            : 'A platform administrator restored participation.',
        resourceType: 'moderation',
        resourceId: row.id,
      });
      return row;
    });
  }

  async withdraw(input: { businessId: string; actorUserId: string }) {
    return this.db.transaction(async (tx) => {
      const actor = await tx.query.users.findFirst({ where: eq(users.id, input.actorUserId) });
      if (!actor || actor.status !== 'active')
        throw deny(403, 'B2B_WITHDRAWAL_ACTIVE_USER_REQUIRED', 'An active user is required.');
      const authority = await tx
        .select({ id: userBusinessRoles.id })
        .from(userBusinessRoles)
        .innerJoin(roles, eq(roles.id, userBusinessRoles.roleId))
        .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(
          and(
            eq(userBusinessRoles.userId, input.actorUserId),
            eq(userBusinessRoles.businessId, input.businessId),
            isNull(userBusinessRoles.branchId),
            isNull(userBusinessRoles.deletedAt),
            eq(roles.businessId, input.businessId),
            isNull(roles.deletedAt),
            eq(permissions.key, 'b2b:manage'),
          ),
        )
        .limit(1);
      if (!authority.length)
        throw deny(
          403,
          'B2B_WITHDRAWAL_BUSINESS_AUTHORITY_REQUIRED',
          'Business-wide B2B management authority is required.',
        );
      const now = new Date();
      const [row] = await tx
        .update(b2bParticipations)
        .set({
          status: 'withdrawn',
          withdrawnAt: now,
          withdrawnByUserId: input.actorUserId,
          suspendedAt: null,
          suspendedByUserId: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(b2bParticipations.businessId, input.businessId),
            or(eq(b2bParticipations.status, 'active'), eq(b2bParticipations.status, 'suspended')),
          ),
        )
        .returning();
      if (!row)
        throw deny(
          409,
          'B2B_PARTICIPATION_WITHDRAWAL_CONFLICT',
          'There is no current participation to withdraw.',
        );
      await tx.insert(auditLog).values({
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        action: 'b2b.participation_withdrawn',
        entityType: 'b2b_participation',
        entityId: row.id,
        metadata: {},
      });
      await tx.insert(b2bParticipationEvents).values({
        participationId: row.id,
        businessId: input.businessId,
        eventType: 'withdrawn',
        actorUserId: input.actorUserId,
        metadata: {},
      });
      return row;
    });
  }

  async findForBusiness(businessId: string) {
    return this.db.query.b2bParticipations.findFirst({
      where: eq(b2bParticipations.businessId, businessId),
    });
  }

  /** Fail-closed eligibility term for later blocks: only an `active` record on an active business counts. */
  async isParticipating(businessId: string): Promise<boolean> {
    const row = await this.findForBusiness(businessId);
    if (!row || row.status !== 'active') return false;
    const business = await this.db.query.businesses.findFirst({
      where: eq(businesses.id, businessId),
    });
    return !!business && business.status === 'active' && !business.deletedAt;
  }
}
