import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { stripeSubscriptionTierObservations as evidence } from '../db/schema';
import type { ProviderSubscriptionObservation } from './provider-subscription-event.reconciler';

/**
 * Tenant-scoped read-only access to the append-only provider observations
 * created by the signature-checked Stripe webhook path (migration 0043).
 * This repository does not establish historical effective-time authority.
 */
export class PostgresSubscriptionEvidenceRepository {
  constructor(private readonly db: Db) {}

  async findForSubscription(input: {
    businessId: string;
    customerId: string;
    subscriptionId: string;
  }): Promise<readonly ProviderSubscriptionObservation[]> {
    if (!input.businessId || !input.customerId.startsWith('cus_') ||
        !input.subscriptionId.startsWith('sub_'))
      throw new Error('HISTORICAL_EVIDENCE_IDENTITY_INVALID');

    const rows = await this.db.select({
      eventId: evidence.stripeEventId,
      eventCreatedAt: evidence.stripeEventCreatedAt,
      eventType: evidence.stripeEventType,
      businessId: evidence.businessId,
      customerId: evidence.stripeCustomerId,
      subscriptionId: evidence.stripeSubscriptionId,
      priceId: evidence.stripePriceId,
      interval: evidence.billingInterval,
      status: evidence.status,
      periodStart: evidence.itemPeriodStart,
      periodEnd: evidence.itemPeriodEnd,
    }).from(evidence).where(and(
      eq(evidence.businessId,input.businessId),
      eq(evidence.stripeCustomerId,input.customerId),
      eq(evidence.stripeSubscriptionId,input.subscriptionId),
    )).orderBy(asc(evidence.stripeEventCreatedAt),asc(evidence.stripeEventId));

    return rows.map(row => ({
      stripeEventId: row.eventId,
      stripeEventCreatedAt: row.eventCreatedAt,
      stripeEventType: row.eventType,
      businessId: row.businessId,
      stripeCustomerId: row.customerId,
      stripeSubscriptionId: row.subscriptionId,
      stripePriceId: row.priceId,
      billingInterval: row.interval,
      status: row.status,
      itemPeriodStart: row.periodStart,
      itemPeriodEnd: row.periodEnd,
    }));
  }
}
