import { AppError } from '../lib/errors';
import type { ConsentPurpose } from '../db/schema';
import type { Repositories } from '../repositories';

/**
 * Thin pass-through to the consent repository. Nothing in the API uses it: the
 * join consent is recorded by `CustomerMembershipService.join`, withdrawal goes
 * through `ConsentWithdrawalService`, and the settlement flows use the
 * repository directly.
 */
export class ConsentService {
  constructor(private readonly repos: Pick<Repositories, 'consentGrants'>) {}

  grant(input: {
    customerId: string;
    businessId?: string;
    purpose: ConsentPurpose;
    consentVersion: string;
    scope?: string;
    resourceType?: string;
    resourceId?: string;
    idempotencyKey?: string;
    metadata?: Record<string, unknown>;
  }) {
    if (input.purpose === 'community_membership') throw new AppError('Use explicit Community acceptance.', 400, 'COMMUNITY_CONSENT_FLOW_REQUIRED');
    return this.repos.consentGrants.create({
      customerId: input.customerId,
      purpose: input.purpose,
      consentVersion: input.consentVersion,
      ...(input.businessId !== undefined ? { businessId: input.businessId } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.resourceType !== undefined ? { resourceType: input.resourceType } : {}),
      ...(input.resourceId !== undefined ? { resourceId: input.resourceId } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
  }

  hasActive(customerId: string, businessId: string, purpose: ConsentPurpose) {
    return this.repos.consentGrants.findActive(customerId, businessId, purpose);
  }

  /**
   * @deprecated Revokes the grant only. For a `join_loyalty` consent that leaves
   * the customer's membership active and earning, which withdrawing that
   * consent must not do. Use `ConsentWithdrawalService.revoke`.
   */
  revoke(id: string, customerId: string) {
    return this.repos.consentGrants.revoke(id, customerId);
  }
}
