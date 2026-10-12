import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { IntegratedProviderTierAuthorityGate } from '../src/partner-credits/integrated-provider-tier-authority.gate';

const seconds = 1791712800;
const subscription = {
  id:'sub_one',customer:'cus_one',metadata:{businessId:'business-one'},
  status:'active',items:{data:[{price:{id:'price_starter',recurring:{interval:'month'}},
    current_period_start:1790812800,current_period_end:1793491200}]},
};
const event = {
  id:'evt_one',created:seconds,type:'customer.subscription.updated',data:{object:subscription},
};
const observation = {
  stripeEventId:'evt_one',stripeEventCreatedAt:new Date(seconds*1000),
  stripeEventType:event.type,businessId:'business-one',
  stripeCustomerId:'cus_one',stripeSubscriptionId:'sub_one',
  stripePriceId:'price_starter',billingInterval:'month',status:'active',
  itemPeriodStart:new Date(1790812800*1000),itemPeriodEnd:new Date(1793491200*1000),
};
const input = {
  businessId:'business-one',customerId:'cus_one',subscriptionId:'sub_one',
  fulfilledAt:new Date((seconds+100)*1000),localObservations:[observation],
};
function gate(events: typeof event[] = [event]) {
  const list=vi.fn().mockResolvedValue({data:events,has_more:false});
  const retrieve=vi.fn().mockImplementation(async (id: string)=>events.find(e=>e.id===id));
  return {service:new IntegratedProviderTierAuthorityGate({events:{list,retrieve}} as unknown as Pick<Stripe,'events'>),list,retrieve};
}
describe('Integrated provider-tier gate remains fail-closed',()=>{
  it('corroborates provider event with immutable local evidence but denies authority',async()=>{
    const {service,retrieve}=gate();
    expect(await service.inspect(input)).toEqual({
      historicalTierVerified:false,issuanceAuthorized:false,
      reason:'HISTORICAL_COVERAGE_AND_EFFECTIVE_TIME_UNPROVEN',
      matchedEventIds:['evt_one'],
    });
    expect(retrieve).toHaveBeenCalledWith('evt_one');
  });
  it('rejects provider events not present locally',async()=>{
    expect((await gate([event,{...event,id:'evt_two'}]).service.inspect(input)).reason)
      .toBe('PROVIDER_EVENT_MISSING_LOCALLY');
  });
  it('rejects local events not retained at provider',async()=>{
    expect((await gate([]).service.inspect(input)).reason).toBe('PROVIDER_HISTORY_ABSENT');
    expect((await gate().service.inspect({...input,localObservations:[observation,{...observation,stripeEventId:'evt_unretained'}]})).reason)
      .toBe('LOCAL_EVENT_NOT_RETAINED_BY_PROVIDER');
  });
  it('rejects tenant mismatch before fetching provider data',async()=>{
    const {service,list}=gate();
    expect((await service.inspect({...input,businessId:'other'})).reason)
      .toBe('LOCAL_IDENTITY_OR_EVENT_INVALID');
    expect(list).not.toHaveBeenCalled();
  });
  it('does not promote incomplete pagination to historical authority',async()=>{
    const {service}=gate();
    expect((await service.inspect({...input,maxPages:0})).reason)
      .toBe('PROVIDER_HISTORY_INVALID_INPUT');
  });
});
