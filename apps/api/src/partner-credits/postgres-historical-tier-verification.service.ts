import type Stripe from 'stripe';
import type { Db } from '../db/client';
import { IntegratedProviderTierAuthorityGate } from './integrated-provider-tier-authority.gate';
import { PostgresSubscriptionEvidenceRepository } from './postgres-subscription-evidence.repository';

/**
 * Server-only contract: the trusted calling Split 06 fulfillment path must
 * supply business/customer/subscription and authoritative fulfillment instant.
 * Postgres, not client arguments, supplies historical subscription evidence.
 * Still fail closed: provider event history is not price-effective-time proof.
 */
export class PostgresHistoricalTierVerificationService {
  constructor(
    private readonly repo: PostgresSubscriptionEvidenceRepository,
    private readonly gate: IntegratedProviderTierAuthorityGate,
  ) {}

  static fromTrustedDependencies(db: Db, stripe: Pick<Stripe, 'events'>) {
    return new PostgresHistoricalTierVerificationService(
      new PostgresSubscriptionEvidenceRepository(db),
      new IntegratedProviderTierAuthorityGate(stripe),
    );
  }

  async inspect(input: {
    businessId: string;
    customerId: string;
    subscriptionId: string;
    fulfilledAt: Date;
  }): Promise<{
    historicalTierVerified: false;
    issuanceAuthorized: false;
    reason: string;
    matchedEventIds: string[];
  }> {
    const denied = (reason: string) => ({
      historicalTierVerified: false as const,
      issuanceAuthorized: false as const,
      reason,
      matchedEventIds: [] as string[],
    });
    if (!input.businessId || !input.customerId.startsWith('cus_') ||
        !input.subscriptionId.startsWith('sub_') ||
        !(input.fulfilledAt instanceof Date) ||
        !Number.isFinite(input.fulfilledAt.getTime())) return denied('INVALID_INPUT');

    // One tenant-bound database statement obtains all candidate observations.
    // No mutable business-subscriptions mirror or user-supplied evidence accepted.
    let localObservations;
    try {
      localObservations = await this.repo.findForSubscription(input);
    } catch {
      return denied('POSTGRES_EVIDENCE_UNAVAILABLE');
    }
    if (!localObservations.length) return denied('LOCAL_HISTORY_ABSENT');
    return this.gate.inspect({
      businessId: input.businessId,
      customerId: input.customerId,
      subscriptionId: input.subscriptionId,
      fulfilledAt: input.fulfilledAt,
      localObservations,
    });
  }
}
