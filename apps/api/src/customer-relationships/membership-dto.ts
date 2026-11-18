import type { CustomerMembershipDto } from '@echo-grid-feedback/shared-types';
import type { BusinessCustomerMembership } from '../repositories';

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
