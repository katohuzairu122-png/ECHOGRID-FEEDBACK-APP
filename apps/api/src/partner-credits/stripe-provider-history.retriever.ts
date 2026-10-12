import type Stripe from 'stripe';

/**
 * Read-only, bounded retrieval of Stripe's retained subscription event pages.
 * Event listing cannot certify retention coverage or actual price-effective times.
 * No result produced here authorizes Partner Credit issuance.
 */
export type ProviderEventCoverage = {
  historicalTierVerified: false;
  issuanceAuthorized: false;
  retentionComplete: false;
  effectiveTimeProven: false;
  status: 'INVALID_INPUT' | 'PROVIDER_UNAVAILABLE' | 'PAGINATION_INCOMPLETE' |
    'PROVIDER_PAGE_INVALID' | 'RETAINED_EVENTS_FETCHED';
  events: Stripe.Event[];
  pagesFetched: number;
};

export class StripeProviderHistoryRetriever {
  constructor(private readonly stripe: Pick<Stripe, 'events'>) {}

  async retrieve(input: {
    stripeSubscriptionId: string;
    stripeCustomerId: string;
    maxPages?: number;
  }): Promise<ProviderEventCoverage> {
    const response = (
      status: ProviderEventCoverage['status'], events: Stripe.Event[] = [], pagesFetched = 0,
    ): ProviderEventCoverage => ({
      status, events, pagesFetched, historicalTierVerified: false,
      issuanceAuthorized: false, retentionComplete: false, effectiveTimeProven: false,
    });
    const maxPages = input.maxPages ?? 10;
    if (!input.stripeSubscriptionId.startsWith('sub_') ||
        !input.stripeCustomerId.startsWith('cus_') ||
        !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100)
      return response('INVALID_INPUT');
    const events: Stripe.Event[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      let result: Stripe.ApiList<Stripe.Event>;
      try {
        result = await this.stripe.events.list({
          limit: 100,
          ...(cursor ? { starting_after: cursor } : {}),
          types: [
            'customer.subscription.created',
            'customer.subscription.updated',
            'customer.subscription.deleted',
          ],
        });
      } catch {
        return response('PROVIDER_UNAVAILABLE', [], page);
      }
      if (!Array.isArray(result.data) || typeof result.has_more !== 'boolean')
        return response('PROVIDER_PAGE_INVALID', [], page + 1);
      for (const e of result.data) {
        if (!e.id?.startsWith('evt_') || !Number.isSafeInteger(e.created) ||
            seen.has(e.id)) return response('PROVIDER_PAGE_INVALID', [], page + 1);
        seen.add(e.id);
        const sub = e.data?.object as Stripe.Subscription | undefined;
        const customer = typeof sub?.customer === 'string' ? sub.customer : sub?.customer?.id;
        // Do not treat unrelated Stripe events as evidence for this subscription.
        if (sub?.id === input.stripeSubscriptionId && customer === input.stripeCustomerId)
          events.push(e);
      }
      if (!result.has_more) return response('RETAINED_EVENTS_FETCHED', events, page + 1);
      const last = result.data[result.data.length - 1];
      if (!last?.id || last.id === cursor)
        return response('PROVIDER_PAGE_INVALID', [], page + 1);
      cursor = last.id;
    }
    return response('PAGINATION_INCOMPLETE', [], maxPages);
  }
}
