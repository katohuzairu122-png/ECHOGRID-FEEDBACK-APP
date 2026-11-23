import { CommunityMembershipControls, recordCommunityMembershipControl, type CommunityMembershipControlConfig } from './community-membership-controls';
import { sql } from 'drizzle-orm';
import type {
  CommunityPointPlatformStateChangeInput,
} from '@echo-grid-feedback/shared-types';
import type { Database, Db } from '../db/client';
import { customers, consentGrants } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { assertVerifiedPhoneFor } from '../lib/customer-verification';
import { COMMUNITY_CONSENT_ACTION, latestCommunityTransition, lockCommunityTerms } from './community-consent.persistence';
import {
  createRepositories,
  type CommunityMembership,
  type CommunityPointAccount,
} from '../repositories';
import { AppError } from '../lib/errors';

export interface PlatformCommunityStateAuditContext {
  actorUserId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface CommunityPlatformStateResult {
  membership: CommunityMembership;
  account: CommunityPointAccount;
  changed: boolean;
}

export class CommunityPlatformStateService {
  private readonly controls: CommunityMembershipControls;
  constructor(private readonly db: Database, config: CommunityMembershipControlConfig = {}) {
    this.controls = new CommunityMembershipControls(config);
  }

  async suspend(
    customerId: string,
    input: CommunityPointPlatformStateChangeInput,
    audit: PlatformCommunityStateAuditContext,
  ): Promise<CommunityPlatformStateResult> {
    return this.db.transaction(async (tx) => {
      const state = await this.lockAndLoad(tx, customerId);

      if (
        state.membership.status === 'suspended' &&
        state.account.status === 'suspended'
      ) {
        return { ...state, changed: false };
      }

      if (
        !((state.membership.status === 'active' && state.account.status === 'active') ||
          (state.membership.status === 'inactive' && state.account.status === 'closed'))
      ) {
        throw this.stateConflict(state.membership, state.account);
      }

      const repos = createRepositories(tx);
      const membership = await repos.communityMemberships.updateStatus(customerId, {
        status: 'suspended',
        suspendedAt: new Date(),
      });
      const account = await repos.communityPointAccounts.updateStatus(
        state.account.id,
        'suspended',
      );

      if (!membership || !account) {
        throw new AppError(
          'Community suspension could not be completed atomically.',
          409,
          'COMMUNITY_STATE_CONFLICT',
        );
      }

      await repos.auditLog.record({
        businessId: null,
        actorUserId: audit.actorUserId,
        action: 'community_membership.suspended_by_platform',
        entityType: 'community_membership',
        entityId: membership.id,
        metadata: {
          customerId,
          accountId: account.id,
          reason: input.reason,
          membershipFrom: state.membership.status,
          membershipTo: 'suspended',
          accountFrom: state.account.status,
          accountTo: 'suspended',
          pointsBalance: account.pointsBalance,
        },
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent,
      });

      return { membership, account, changed: true };
    });
  }

  async restore(
    customerId: string,
    input: CommunityPointPlatformStateChangeInput,
    audit: PlatformCommunityStateAuditContext,
  ): Promise<CommunityPlatformStateResult> {
    try {
    const result = await this.db.transaction(async (tx) => {
      await lockCommunityTerms(tx);
      const schema = await tx.execute<{ available: boolean }>(sql`select to_regclass('public.community_terms_current') is not null as available`);
      if (!schema.rows[0]?.available) throw new AppError('Community membership terms are unavailable.', 503, 'COMMUNITY_TERMS_UNAVAILABLE');
      const state = await this.lockAndLoad(tx, customerId);
      const customer = await createRepositories(tx).customers.findById(customerId);
      if (!customer || customer.status !== 'active') throw new AppError('Customer account is not available.', 409, 'CUSTOMER_NOT_AVAILABLE');
      assertVerifiedPhoneFor(customer, 'community');
      const permit = this.controls.authorize(tx, customerId, 'clearance');

      if (
        (state.membership.status === 'active' && state.account.status === 'active') ||
        (state.membership.status === 'inactive' && state.account.status === 'closed')
      ) {
        return { ...state, changed: false };
      }

      if (
        state.membership.status !== 'suspended' ||
        state.account.status !== 'suspended'
      ) {
        throw this.stateConflict(state.membership, state.account);
      }

      const repos = createRepositories(tx);
      // D1: moderation clearance never reuses an earlier acceptance. Only the
      // customer's explicit restore operation may activate this paired state.
      const targetMembership = 'inactive' as const;
      const targetAccount = 'closed' as const;
      const membership = await repos.communityMemberships.updateStatus(customerId, {
        status: targetMembership,
        suspendedAt: null,
      }, permit);
      const account = await repos.communityPointAccounts.updateStatus(
        state.account.id,
        targetAccount,
      );

      if (!membership || !account) {
        throw new AppError(
          'Community restoration could not be completed atomically.',
          409,
          'COMMUNITY_STATE_CONFLICT',
        );
      }

      const previous = await latestCommunityTransition(tx, state.membership.id);
      const transitionId = crypto.randomUUID();
      const clock = await tx.execute<{ revoked_at: string }>(sql`select clock_timestamp()::text as revoked_at`);
      await tx.update(consentGrants).set({ status: 'revoked', revokedAt: new Date(clock.rows[0]!.revoked_at) })
        .where(and(eq(consentGrants.customerId, customerId), eq(consentGrants.purpose, 'community_membership'), eq(consentGrants.status, 'active')));
      // An immutable lifecycle barrier invalidates every pre-clearance form,
      // including an earlier restore offer after a second suspension/clearance.
      await repos.auditLog.recordReturningId({ id: transitionId, businessId: null, actorUserId: audit.actorUserId,
        action: COMMUNITY_CONSENT_ACTION, entityType: 'community_membership', entityId: membership.id,
        metadata: { customerId, operation: 'moderation_clearance', consentAccepted: false,
          sequence: Number(previous?.metadata?.sequence ?? 0) + 1, previousTransitionId: previous?.id ?? null,
          auditCorrelationId: transitionId, membershipFrom: 'suspended', membershipTo: 'inactive' },
        ipAddress: null, userAgent: null });
      await repos.auditLog.record({
        businessId: null,
        actorUserId: audit.actorUserId,
        action: 'community_membership.restored_by_platform',
        entityType: 'community_membership',
        entityId: membership.id,
        metadata: {
          customerId,
          accountId: account.id,
          reason: input.reason,
          membershipFrom: 'suspended',
          membershipTo: targetMembership,
          accountFrom: 'suspended',
          accountTo: targetAccount,
          pointsBalance: account.pointsBalance,
        },
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent,
      });

      return { membership, account, changed: true };
    });
    recordCommunityMembershipControl('clearance', 'permitted');
    return result;
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'COMMUNITY_MEMBERSHIP_OPERATION_DISABLED')) recordCommunityMembershipControl('clearance', 'transition_failed');
      throw error;
    }
  }

  private async lockAndLoad(
    db: Db,
    customerId: string,
  ): Promise<{ membership: CommunityMembership; account: CommunityPointAccount }> {
    await db.execute(
      sql`select id from ${customers} where ${customers.id} = ${customerId} for update`,
    );

    const repos = createRepositories(db);
    const customer = await repos.customers.findById(customerId);
    if (!customer) {
      throw new AppError(
        'Customer not found.',
        404,
        'CUSTOMER_NOT_FOUND',
      );
    }

    const [membership, account] = await Promise.all([
      repos.communityMemberships.findByCustomerId(customerId),
      repos.communityPointAccounts.findByCustomerId(customerId),
    ]);

    if (!membership || !account) {
      throw new AppError(
        'Community membership and point account must both exist before platform lifecycle control.',
        409,
        'COMMUNITY_STATE_CONFLICT',
      );
    }

    return { membership, account };
  }

  private stateConflict(
    membership: CommunityMembership,
    account: CommunityPointAccount,
  ): AppError {
    return new AppError(
      'Community membership/account states are not a valid paired lifecycle state.',
      409,
      'COMMUNITY_STATE_CONFLICT',
      {
        membershipStatus: membership.status,
        accountStatus: account.status,
      },
    );
  }
}
