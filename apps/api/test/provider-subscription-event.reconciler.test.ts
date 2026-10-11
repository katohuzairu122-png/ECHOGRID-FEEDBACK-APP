import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { ProviderSubscriptionEventReconciler } from '../src/partner-credits/provider-subscription-event.reconciler';

const observation = {
  stripeEventId:'evt_valid',
  stripeEventCreatedAt:new Date('2026-10-11T10:00:00Z'),
  stripeEventType:'customer.subscription.updated',
  businessId:'business-1',
  stripeCustomerId:'cus_1',
  stripeSubscriptionId:'sub_1',
  stripePriceId:'price_starter',
  billingInterval:'month',
  status:'active',
  itemPeriodStart:new Date('2026-10-01T00:00:00Z'),
  itemPeriodEnd:new Date('2026-11-01T00:00:00Z'),
};
const event = {
 id:'evt_valid', created:1791712800, type:'customer.subscription.updated',
 data:{object:{
  id:'sub_1', customer:'cus_1', metadata:{businessId:'business-1'},
  status:'active',
  items:{data:[{price:{id:'price_starter',recurring:{interval:'month'}},current_period_start:1790812800,current_period_end:1793491200}]},
 }},
};
const input = {
  observation,
  expectedBusinessId:'business-1',
  expectedCustomerId:'cus_1',
  expectedSubscriptionId:'sub_1',
  fulfillmentAt:new Date('2026-10-11T12:00:00Z'),
};
function fixture(value: unknown = event, error = false) {
 const retrieve = error ? vi.fn().mockRejectedValue(new Error('provider outage')) : vi.fn().mockResolvedValue(value);
 const api = {events:{retrieve}} as unknown as Pick<Stripe,'events'>;
 return {reader:new ProviderSubscriptionEventReconciler(api),retrieve};
}
describe('Split 07 provider event reconciliation does not infer tier-effective windows',()=>{
 it('fails closed on provider unavailability',async()=>{
  const {reader}=fixture(event,true);
  expect((await reader.reconcile(input)).reason).toBe('PROVIDER_RETRIEVAL_FAILED');
 });
 it('denies cross-business identity before a provider request',async()=>{
  const {reader,retrieve}=fixture();
  expect((await reader.reconcile({...input,expectedBusinessId:'other'})).reason).toBe('LOCAL_IDENTITY_MISMATCH');
  expect(retrieve).not.toHaveBeenCalled();
 });
 it('rejects provider price mismatch',async()=>{
  const bad={...event,data:{object:{...event.data.object,items:{data:[{...event.data.object.items.data[0],price:{id:'price_other',recurring:{interval:'month'}}}]}}}};
  expect((await fixture(bad).reader.reconcile(input)).reason).toBe('PROVIDER_OBSERVATION_MISMATCH');
 });
 it('cannot authorize historical tier from event corroboration',async()=>{
  const r=await fixture().reader.reconcile(input);
  expect(r).toMatchObject({historicalTierVerified:false,issuanceAuthorized:false});
 });
});
