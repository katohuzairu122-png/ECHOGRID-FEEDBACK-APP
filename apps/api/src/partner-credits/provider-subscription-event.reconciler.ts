import type Stripe from 'stripe';

/**
 * Split 07/08 — provider reconciliation of an immutable webhook observation.
 * Stripe's retrieval of a past event can confirm its recorded object and
 * identity, but does NOT prove the exact effective instant of a mid-cycle
 * subscription price change. This probe never authorizes an earning decision.
 */
export type ProviderSubscriptionObservation = {
  stripeEventId: string;
  stripeEventCreatedAt: Date;
  stripeEventType: string;
  businessId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  billingInterval: string;
  status: string;
  itemPeriodStart: Date | null;
  itemPeriodEnd: Date | null;
};
export type ProviderWindowReconciliation =
  | { kind: 'rejected'; reason: string; historicalTierVerified: false; issuanceAuthorized: false }
  | { kind: 'provider_observation_corroborated'; reason: 'EFFECTIVE_WINDOW_UNPROVEN'; eventRef: string; historicalTierVerified: false; issuanceAuthorized: false };

export class ProviderSubscriptionEventReconciler {
  constructor(private readonly stripe: Pick<Stripe, 'events'>) {}

  async reconcile(input: {
    observation: ProviderSubscriptionObservation;
    expectedBusinessId: string;
    expectedCustomerId: string;
    expectedSubscriptionId: string;
    fulfillmentAt: Date;
  }): Promise<ProviderWindowReconciliation> {
    const fail = (reason: string): ProviderWindowReconciliation => ({
      kind: 'rejected', reason, historicalTierVerified: false, issuanceAuthorized: false,
    });
    const { observation: o } = input;
    if (!o.stripeEventId.startsWith('evt_') ||
        !input.expectedBusinessId || !input.expectedCustomerId.startsWith('cus_') ||
        !input.expectedSubscriptionId.startsWith('sub_') ||
        !Number.isFinite(input.fulfillmentAt.getTime())) return fail('INVALID_INPUT');
    if (o.businessId !== input.expectedBusinessId ||
        o.stripeCustomerId !== input.expectedCustomerId ||
        o.stripeSubscriptionId !== input.expectedSubscriptionId) return fail('LOCAL_IDENTITY_MISMATCH');

    // Explicit provider API retrieval — do not elevate stored webhook rows
    // or business-controlled metadata into historical entitlement authority.
    let event: Stripe.Event;
    try {
      event = await this.stripe.events.retrieve(o.stripeEventId);
    } catch {
      return fail('PROVIDER_RETRIEVAL_FAILED');
    }
    if (event.id !== o.stripeEventId || event.created * 1000 !== o.stripeEventCreatedAt.getTime() ||
        event.type !== o.stripeEventType ||
        !['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) {
      return fail('EVENT_MISMATCH');
    }
    const subscription = event.data.object as Stripe.Subscription;
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    const items = subscription.items?.data;
    if (!items || items.length !== 1) return fail('UNSUPPORTED_SUBSCRIPTION_ITEMS');
    const item = items[0];
    const interval = item.price.recurring?.interval;
    const periodStart = item.current_period_start;
    const periodEnd = item.current_period_end;
    if (subscription.id !== o.stripeSubscriptionId || customerId !== o.stripeCustomerId ||
        subscription.metadata?.businessId !== o.businessId || item.price.id !== o.stripePriceId ||
        subscription.status !== o.status || (interval ?? 'unknown') !== o.billingInterval ||
        periodStart * 1000 !== o.itemPeriodStart?.getTime() ||
        periodEnd * 1000 !== o.itemPeriodEnd?.getTime()) {
      return fail('PROVIDER_OBSERVATION_MISMATCH');
    }

    // A single event cannot establish a subscription item's price-change
    // effective window. Even two ordered events can miss an intervening
    // update, and current_period_start is a billing boundary, not an upgrade
    // timestamp. A later, separately audited effective-window proof is needed.
    return {
      kind: 'provider_observation_corroborated',
      eventRef: event.id,
      reason: 'EFFECTIVE_WINDOW_UNPROVEN',
      historicalTierVerified: false,
      issuanceAuthorized: false,
    };
  }
}
