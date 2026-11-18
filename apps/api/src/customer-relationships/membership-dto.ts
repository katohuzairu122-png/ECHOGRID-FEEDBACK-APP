import type {
  CustomerMembershipDto,
  JoinCustomerMembershipResultDto,
  LoyaltyAccountDto,
} from '@echo-grid-feedback/shared-types';
import type { BusinessCustomerMembership, LoyaltyAccount } from '../repositories';

/**
 * The membership as a customer-facing endpoint returns it: only the fields
 * `CustomerMembershipDto` declares, dates as ISO strings. Audit columns,
 * soft-delete flags and the suspension/exit timestamps are internal and stay
 * out of customer responses.
 */
export function toCustomerMembershipDto(row: BusinessCustomerMembership): CustomerMembershipDto {
  return {
    id: row.id,
    customerId: row.customerId,
    businessId: row.businessId,
    status: row.status,
    joinedAt: row.joinedAt.toISOString(),
    leftAt: row.leftAt ? row.leftAt.toISOString() : null,
    onboardingSource: row.onboardingSource,
    onboardingReference: row.onboardingReference,
  };
}

/**
 * The customer's own loyalty account as `LoyaltyAccountDto` declares it. The
 * row also carries the membership link, the referrer and audit/soft-delete
 * columns, none of which a customer response needs.
 */
export function toCustomerLoyaltyAccountDto(row: LoyaltyAccount): LoyaltyAccountDto {
  return {
    id: row.id,
    customerId: row.customerId,
    businessId: row.businessId,
    points: row.points,
    tierId: row.tierId,
    visitCount: row.visitCount,
    lastVisitAt: row.lastVisitAt ? row.lastVisitAt.toISOString() : null,
    // The column is constrained to 'active' | 'suspended'. Reading anything
    // else as suspended keeps an unexpected value from looking usable.
    status: row.status === 'active' ? 'active' : 'suspended',
  };
}

/** The result of a successful join, as `POST /customer-memberships/join` returns it. */
export function toJoinMembershipResultDto(result: {
  membership: BusinessCustomerMembership;
  loyaltyAccount: LoyaltyAccount;
}): JoinCustomerMembershipResultDto {
  return {
    membership: toCustomerMembershipDto(result.membership),
    loyaltyAccount: toCustomerLoyaltyAccountDto(result.loyaltyAccount),
  };
}
