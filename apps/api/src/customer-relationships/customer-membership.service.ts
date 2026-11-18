import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { assertCustomerNotLimited } from '../lib/customer-limits';
import { createRepositories, type BusinessCustomerMembership, type LoyaltyAccount } from '../repositories';
import { AppError } from '../lib/errors';
import { isUniqueViolation } from '../lib/pg-errors';
import { assertVerifiedPhone } from '../lib/customer-verification';

export interface JoinCustomerMembershipInput {
  customerId: string;
  businessId: string;
  onboardingSource: string;
  onboardingReference: string;
  consentVersion?: string;
  idempotencyKey?: string;
}

export interface JoinCustomerMembershipResult {
  membership: BusinessCustomerMembership;
  loyaltyAccount: LoyaltyAccount;
}

/** Unique indexes a join can still collide on once concurrent joins are serialised. */
const JOIN_RACE_CONSTRAINTS = [
  'business_customer_memberships_customer_business_key',
  'loyalty_accounts_membership_id_key',
] as const;
/** Covers soft-deleted rows too, so it fires when a closed account blocks a new one. */
const LOYALTY_ACCOUNT_PAIR_CONSTRAINT = 'loyalty_accounts_customer_business_key';

/** Turns the two unique-violation shapes a join can still hit into deliberate 409s
 * instead of a generic 500; every other failure is returned untouched. */
function translateJoinError(error: unknown): unknown {
  if (isUniqueViolation(error, [LOYALTY_ACCOUNT_PAIR_CONSTRAINT])) {
    return new AppError(
      'This loyalty account is closed. Please contact the business.',
      409,
      'LOYALTY_ACCOUNT_UNAVAILABLE',
    );
  }
  if (isUniqueViolation(error, JOIN_RACE_CONSTRAINTS)) {
    return new AppError(
      'Your enrollment is already being processed. Please try again.',
      409,
      'MEMBERSHIP_JOIN_CONFLICT',
    );
  }
  return error;
}

export class CustomerMembershipService {
  constructor(private readonly db: Database) {}

  /** Idempotent: joining a business you already belong to returns the existing membership and account. */
  async join(input: JoinCustomerMembershipInput): Promise<JoinCustomerMembershipResult> {
    try {
      return await this.joinSerialized(input);
    } catch (error) {
      throw translateJoinError(error);
    }
  }

  private async joinSerialized(input: JoinCustomerMembershipInput): Promise<JoinCustomerMembershipResult> {
    return this.db.transaction(async (tx) => {
      // Serialise concurrent joins of the same customer to the same business (a double-tap, a retry racing
      // the original request). Without this, both calls read "no membership", both insert, and the loser
      // fails on the unique index with a 500 -- or, when a membership already exists, both create a consent
      // grant. The lock is released when this transaction ends, so the second call then sees the first
      // call's committed rows and returns them. Same pattern as business/branch name serialisation.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`customer_membership_join:${input.customerId}:${input.businessId}`}, 0))`,
      );
      const repos = createRepositories(tx);
      const business = await repos.businesses.findById(input.businessId);
      if (!business || business.status !== 'active') {
        throw new AppError('This business is not available for loyalty enrollment.', 409, 'BUSINESS_NOT_AVAILABLE');
      }

      let membership = await repos.customerMemberships.findByCustomerAndBusiness(input.customerId, input.businessId);
      // Limited customers keep what they already belong to but cannot join anything new.
      if (!membership || membership.status !== 'active') {
        await assertCustomerNotLimited(repos, input.customerId, 'join_business');
        // The first business is open to everyone. Joining an ADDITIONAL business needs a verified phone; the check
        // is against any other membership row (left ones included) so leaving and re-joining cannot bypass it.
        const existing = await repos.customerMemberships.listForCustomer(input.customerId);
        if (existing.some((m) => m.businessId !== input.businessId)) {
          await assertVerifiedPhone(repos, input.customerId, 'join_additional_business');
        }
      }
      if (!membership) {
        membership = await repos.customerMemberships.create({
          customerId: input.customerId,
          businessId: input.businessId,
          status: 'active',
          onboardingSource: input.onboardingSource,
          onboardingReference: input.onboardingReference,
        });
      } else if (membership.status !== 'active') {
        if (membership.status !== 'left') {
          throw new AppError('This membership cannot be reactivated by the customer.', 409, 'MEMBERSHIP_NOT_REACTIVATABLE');
        }
        membership = await repos.customerMemberships.reactivate(
          membership.id,
          input.onboardingSource,
          input.onboardingReference,
        );
      }

      const existingJoinConsent = await repos.consentGrants.findActive(
        input.customerId,
        input.businessId,
        'join_loyalty',
      );
      if (!existingJoinConsent) {
        await repos.consentGrants.create({
          customerId: input.customerId,
          businessId: input.businessId,
          purpose: 'join_loyalty',
          consentVersion: input.consentVersion ?? 'v1',
          status: 'active',
          ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          metadata: {
            onboardingSource: input.onboardingSource,
            onboardingReference: input.onboardingReference,
            membershipId: membership.id,
          },
        });
      }

      let loyaltyAccount = await repos.loyaltyAccounts.findByCustomerAndBusiness(input.customerId, input.businessId);
      if (!loyaltyAccount) {
        loyaltyAccount = await repos.loyaltyAccounts.create({
          customerId: input.customerId,
          businessId: input.businessId,
          membershipId: membership.id,
        });
      } else if (!loyaltyAccount.membershipId) {
        loyaltyAccount = await repos.loyaltyAccounts.attachMembership(loyaltyAccount.id, membership.id);
      } else if (loyaltyAccount.membershipId !== membership.id) {
        throw new AppError('Loyalty membership mapping is inconsistent.', 409, 'MEMBERSHIP_MAPPING_CONFLICT');
      }

      return { membership, loyaltyAccount };
    });
  }
}
