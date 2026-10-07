import type { ConsentPurpose } from '../db/schema';
import type { Repositories } from '../repositories';

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

  revoke(id: string, customerId: string) {
    return this.repos.consentGrants.revoke(id, customerId);
  }
}
