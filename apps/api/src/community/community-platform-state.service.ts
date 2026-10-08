import { sql } from 'drizzle-orm';
import type {
  CommunityPointPlatformStateChangeInput,
} from '@echo-grid-feedback/shared-types';
import type { Database, Db } from '../db/client';
import { customers } from '../db/schema';
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
  constructor(private readonly db: Database) {}

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
        state.membership.status !== 'active' ||
        state.account.status !== 'active'
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
          membershipFrom: 'active',
          membershipTo: 'suspended',
          accountFrom: 'active',
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
    return this.db.transaction(async (tx) => {
      const state = await this.lockAndLoad(tx, customerId);

      if (
        state.membership.status === 'active' &&
        state.account.status === 'active'
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
      const membership = await repos.communityMemberships.updateStatus(customerId, {
        status: 'active',
        suspendedAt: null,
      });
      const account = await repos.communityPointAccounts.updateStatus(
        state.account.id,
        'active',
      );

      if (!membership || !account) {
        throw new AppError(
          'Community restoration could not be completed atomically.',
          409,
          'COMMUNITY_STATE_CONFLICT',
        );
      }

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
          membershipTo: 'active',
          accountFrom: 'suspended',
          accountTo: 'active',
          pointsBalance: account.pointsBalance,
        },
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent,
      });

      return { membership, account, changed: true };
    });
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
