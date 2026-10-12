import type Stripe from 'stripe';
import { StripeProviderHistoryRetriever } from './stripe-provider-history.retriever';
import { ProviderSubscriptionEventReconciler, type ProviderSubscriptionObservation } from './provider-subscription-event.reconciler';
import { assessPriceTimeline, type PriceTimelineObservation } from './subscription-price-timeline.evidence';

/**
 * Read-only Split 07/08 integration. Caller supplies persisted immutable local
 * observations from a trusted repository, NEVER user-provided evidence.
 * No retained event listing establishes historical completeness or exact
 * effective-time authority; therefore no positive award outcome exists.
 */
export class IntegratedProviderTierAuthorityGate {
  private readonly retriever: StripeProviderHistoryRetriever;
  private readonly reconciler: ProviderSubscriptionEventReconciler;
  constructor(stripe: Pick<Stripe, 'events'>) {
    this.retriever = new StripeProviderHistoryRetriever(stripe);
    this.reconciler = new ProviderSubscriptionEventReconciler(stripe);
  }

  async inspect(input: {
    businessId: string;
    customerId: string;
    subscriptionId: string;
    fulfilledAt: Date;
    localObservations: readonly ProviderSubscriptionObservation[];
    maxPages?: number;
  }): Promise<{
    historicalTierVerified: false;
    issuanceAuthorized: false;
    reason: string;
    matchedEventIds: string[];
  }> {
    const deny = (reason: string, matchedEventIds: string[] = []) => ({
      historicalTierVerified: false as const,
      issuanceAuthorized: false as const,
      reason,
      matchedEventIds,
    });
    if (!input.businessId || !input.customerId.startsWith('cus_') ||
        !input.subscriptionId.startsWith('sub_') ||
        !(input.fulfilledAt instanceof Date) || !Number.isFinite(input.fulfilledAt.getTime()))
      return deny('INVALID_INPUT');
    if (!input.localObservations.length) return deny('LOCAL_HISTORY_ABSENT');
    const byId = new Map<string, ProviderSubscriptionObservation>();
    for (const o of input.localObservations) {
      if (!o.stripeEventId.startsWith('evt_') ||
          o.businessId !== input.businessId || o.stripeCustomerId !== input.customerId ||
          o.stripeSubscriptionId !== input.subscriptionId ||
          !Number.isFinite(o.stripeEventCreatedAt.getTime())) return deny('LOCAL_IDENTITY_OR_EVENT_INVALID');
      if (byId.has(o.stripeEventId)) return deny('LOCAL_DUPLICATE_EVENT');
      byId.set(o.stripeEventId, o);
    }
    const history = await this.retriever.retrieve({
      stripeSubscriptionId: input.subscriptionId,
      stripeCustomerId: input.customerId,
      maxPages: input.maxPages,
    });
    if (history.status !== 'RETAINED_EVENTS_FETCHED')
      return deny('PROVIDER_HISTORY_' + history.status);
    if (!history.events.length) return deny('PROVIDER_HISTORY_ABSENT');
    const providerIds = new Set(history.events.map(e => e.id));
    // Missing either direction is a conflict, not permission to silently use
    // the subset. Retention may naturally drop older events, so fail closed.
    for (const o of input.localObservations)
      if (!providerIds.has(o.stripeEventId)) return deny('LOCAL_EVENT_NOT_RETAINED_BY_PROVIDER');
    for (const e of history.events)
      if (!byId.has(e.id)) return deny('PROVIDER_EVENT_MISSING_LOCALLY');
    const timeline: PriceTimelineObservation[] = [];
    const matched: string[] = [];
    for (const e of history.events) {
      const observation = byId.get(e.id);
      if (!observation) return deny('PROVIDER_EVENT_MISSING_LOCALLY');
      const probe = await this.reconciler.reconcile({
        observation,
        expectedBusinessId: input.businessId,
        expectedCustomerId: input.customerId,
        expectedSubscriptionId: input.subscriptionId,
        fulfillmentAt: input.fulfilledAt,
      });
      if (probe.kind !== 'provider_observation_corroborated')
        return deny('PROVIDER_CORROBORATION_' + probe.reason);
      matched.push(e.id);
      timeline.push({
        eventId: e.id,
        eventCreatedAt: observation.stripeEventCreatedAt,
        businessId: input.businessId,
        customerId: input.customerId,
        subscriptionId: input.subscriptionId,
        priceId: observation.stripePriceId,
        interval: observation.billingInterval === 'month' ? 'month'
          : observation.billingInterval === 'year' ? 'year' : 'unknown',
        status: observation.status,
        periodStart: observation.itemPeriodStart,
        periodEnd: observation.itemPeriodEnd,
        providerCorroborated: true,
      });
    }
    const assessment = assessPriceTimeline({
      businessId: input.businessId, customerId: input.customerId,
      subscriptionId: input.subscriptionId, fulfilledAt: input.fulfilledAt,
      observations: timeline,
    });
    if (assessment.reason !== 'EFFECTIVE_WINDOW_UNPROVEN')
      return deny('TIMELINE_' + assessment.reason, matched);
    // Matching all currently retained events cannot prove earlier events did
    // not expire, or that event.created was a price-effective timestamp.
    return deny('HISTORICAL_COVERAGE_AND_EFFECTIVE_TIME_UNPROVEN', matched);
  }
}
