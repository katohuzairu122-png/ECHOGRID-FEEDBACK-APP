import type { ConsentGrant } from '../repositories/consent-grant.repository';

/** Closed customer review contract: never expose authority keys, metadata or audit columns. */
export function toCustomerConsentDto(row: ConsentGrant) {
  return {
    id: row.id,
    businessId: row.businessId,
    purpose: row.purpose,
    scope: row.scope,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    consentVersion: row.consentVersion,
    status: row.status,
    grantedAt: row.grantedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    consumedAt: row.consumedAt?.toISOString() ?? null,
  };
}
