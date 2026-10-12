import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { StripeProviderHistoryRetriever } from '../src/partner-credits/stripe-provider-history.retriever';

const event = (id: string, sub = 'sub_one') => ({
  id, created: 1000, type: 'customer.subscription.updated',
  data: { object: { id: sub, customer: 'cus_one' } },
});
const input = { stripeSubscriptionId: 'sub_one', stripeCustomerId: 'cus_one' };
function setup(pages: unknown[]) {
  const list = vi.fn();
  for (const page of pages) list.mockResolvedValueOnce(page);
  return { reader: new StripeProviderHistoryRetriever({ events: {list} } as unknown as Pick<Stripe,'events'>), list };
}
describe('Stripe retained provider-history retrieval never proves effective time', () => {
  it('retrieves all available pages with cursors, filters unrelated events and denies authority', async () => {
    const {reader,list} = setup([
      {data:[event('evt_a'),event('evt_other','sub_other')],has_more:true},
      {data:[event('evt_b')],has_more:false},
    ]);
    const r = await reader.retrieve(input);
    expect(r).toMatchObject({
      status:'RETAINED_EVENTS_FETCHED',pagesFetched:2,
      historicalTierVerified:false,issuanceAuthorized:false,
      retentionComplete:false,effectiveTimeProven:false,
    });
    expect(r.events.map(x=>x.id)).toEqual(['evt_a','evt_b']);
    expect(list.mock.calls[1]?.[0]).toMatchObject({starting_after:'evt_other'});
  });
  it('rejects unbounded pagination without returning partial events as complete', async () => {
    const {reader} = setup([{data:[event('evt_a')],has_more:true}]);
    expect(await reader.retrieve({...input,maxPages:1})).toMatchObject({
      status:'PAGINATION_INCOMPLETE',events:[],issuanceAuthorized:false,
    });
  });
  it('rejects duplicate provider events and an empty continuation page', async () => {
    expect((await setup([{data:[event('evt_a'),event('evt_a')],has_more:false}]).reader.retrieve(input)).status)
      .toBe('PROVIDER_PAGE_INVALID');
    expect((await setup([{data:[],has_more:true}]).reader.retrieve(input)).status)
      .toBe('PROVIDER_PAGE_INVALID');
  });
  it('fails closed on provider outage or invalid identifiers', async () => {
    const unavailable = new StripeProviderHistoryRetriever({
      events:{list:vi.fn().mockRejectedValue(new Error('offline'))},
    } as unknown as Pick<Stripe,'events'>);
    expect((await unavailable.retrieve(input)).status).toBe('PROVIDER_UNAVAILABLE');
    expect((await unavailable.retrieve({...input,stripeSubscriptionId:'bad'})).status).toBe('INVALID_INPUT');
  });
});
