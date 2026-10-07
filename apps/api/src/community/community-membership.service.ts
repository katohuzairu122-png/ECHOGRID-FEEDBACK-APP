import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { customers } from '../db/schema';
import {
  createRepositories,
  type CommunityMembership,
  type CommunityPointAccount,
} from '../repositories';
import { AppError } from '../lib/errors';

export interface CommunityStatus {
  membership: CommunityMembership | null;
  account: CommunityPointAccount | null;
}

export interface JoinCommunityResult extends CommunityStatus {
  membership: CommunityMembership;
  account: CommunityPointAccount;
  created: boolean;
  reactivated: boolean;
}

export class CommunityMembershipService {
  constructor(private readonly db: Database) {}

  async getStatus(customerId: string): Promise<CommunityStatus> {
    const repos = createRepositories(this.db);
    const [membership, account] = await Promise.all([
      repos.communityMemberships.findByCustomerId(customerId),
      repos.communityPointAccounts.findByCustomerId(customerId),
    ]);
    return {
      membership: membership ?? null,
      account: account ?? null,
    };
  }

  async join(customerId: string, policyVersion: string): Promise<JoinCommunityResult> {
    return this.db.transaction(async (tx) => {
      // Serialize membership/account creation per global customer so two
      // concurrent explicit join requests cannot race the unique keys.
      await tx.execute(
        sql`select id from ${customers} where ${customers.id} = ${customerId} for update`,
      );

      const repos = createRepositories(tx);
      const customer = await repos.customers.findById(customerId);
      if (!customer || customer.status !== 'active') {
        throw new AppError('Customer account is not available.', 409, 'CUSTOMER_NOT_AVAILABLE');
      }

      let membership = await repos.communityMemberships.findByCustomerId(customerId);
      let created = false;
      let reactivated = false;

      if (!membership) {
        membership = await repos.communityMemberships.create({
          customerId,
          status: 'active',
          policyVersion,
          joinedAt: new Date(),
          leftAt: null,
          suspendedAt: null,
        });
        created = true;
      } else if (membership.status === 'left') {
        membership = await repos.communityMemberships.updateStatus(customerId, {
          status: 'active',
          policyVersion,
          joinedAt: new Date(),
          leftAt: null,
          suspendedAt: null,
        });
        if (!membership) {
          throw new AppError(
            'Community membership could not be reactivated.',
            409,
            'COMMUNITY_MEMBERSHIP_CONFLICT',
          );
        }
        reactivated = true;
      } else if (membership.status === 'suspended') {
        throw new AppError(
          'This Community membership cannot be reactivated by the customer.',
          409,
          'COMMUNITY_MEMBERSHIP_SUSPENDED',
        );
      }

      let account = await repos.communityPointAccounts.findByCustomerId(customerId);
      if (!account) {
        // Account creation is reachable only through this explicit join flow.
        account = await repos.communityPointAccounts.create({
          customerId,
          status: 'active',
          pointsBalance: 0,
        });
      } else if (account.status !== 'active') {
        account = await repos.communityPointAccounts.updateStatus(account.id, 'active');
        if (!account) {
          throw new AppError(
            'Community Point account could not be activated.',
            409,
            'COMMUNITY_ACCOUNT_CONFLICT',
          );
        }
      }

      return { membership, account, created, reactivated };
    });
  }

  async leave(customerId: string): Promise<CommunityStatus> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from ${customers} where ${customers.id} = ${customerId} for update`,
      );

      const repos = createRepositories(tx);
      const membership = await repos.communityMemberships.findByCustomerId(customerId);
      if (!membership) {
        throw new AppError(
          'Community membership not found.',
          404,
          'COMMUNITY_MEMBERSHIP_NOT_FOUND',
        );
      }
      if (membership.status === 'suspended') {
        throw new AppError(
          'A suspended Community membership cannot be changed by the customer.',
          409,
          'COMMUNITY_MEMBERSHIP_SUSPENDED',
        );
      }

      let updatedMembership = membership;
      if (membership.status !== 'left') {
        const row = await repos.communityMemberships.updateStatus(customerId, {
          status: 'left',
          leftAt: new Date(),
        });
        if (!row) {
          throw new AppError(
            'Community membership could not be updated.',
            409,
            'COMMUNITY_MEMBERSHIP_CONFLICT',
          );
        }
        updatedMembership = row;
      }

      let account = await repos.communityPointAccounts.findByCustomerId(customerId);
      if (account && account.status !== 'closed') {
        account = await repos.communityPointAccounts.updateStatus(account.id, 'closed');
      }

      return {
        membership: updatedMembership,
        account: account ?? null,
      };
    });
  }
}
