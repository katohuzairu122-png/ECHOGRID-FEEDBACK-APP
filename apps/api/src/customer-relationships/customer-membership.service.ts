import type { Database } from '../db/client';
import { createRepositories, type BusinessCustomerMembership, type LoyaltyAccount } from '../repositories';
import { AppError } from '../lib/errors';

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

export class CustomerMembershipService {
  constructor(private readonly db: Database) {}

  async join(input: JoinCustomerMembershipInput): Promise<JoinCustomerMembershipResult> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const business = await repos.businesses.findById(input.businessId);
      if (!business || business.status !== 'active') {
        throw new AppError('This business is not available for loyalty enrollment.', 409, 'BUSINESS_NOT_AVAILABLE');
      }

      let membership = await repos.customerMemberships.findByCustomerAndBusiness(input.customerId, input.businessId);
      if (!membership) {
        membership = await repos.customerMemberships.create({
          customerId: input.customerId,
          businessId: input.businessId,
          status: 'active',
          onboardingSource: input.onboardingSource,
          onboardingReference: input.onboardingReference,
        });
      } else if (membership.status !== 'active') {
        if (!['left', 'suspended'].includes(membership.status)) {
          throw new AppError('This membership cannot be reactivated.', 409, 'MEMBERSHIP_NOT_REACTIVATABLE');
        }
        membership = await repos.customerMemberships.reactivate(
          membership.id,
          input.onboardingSource,
          input.onboardingReference,
        );
      }

      await repos.consentGrants.create({
        customerId: input.customerId,
        businessId: input.businessId,
        purpose: 'join_loyalty',
        consentVersion: input.consentVersion ?? 'v1',
        status: 'active',
        idempotencyKey: input.idempotencyKey,
        metadata: {
          onboardingSource: input.onboardingSource,
          onboardingReference: input.onboardingReference,
          membershipId: membership.id,
        },
      });

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
