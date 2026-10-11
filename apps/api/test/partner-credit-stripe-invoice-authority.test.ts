import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { PartnerCreditStripeInvoiceAuthorityAdapter } from '../src/billing/partner-credit-stripe-invoice-authority.adapter';

const expected = {
  invoiceRef:'in_valid',stripeCustomerId:'cus_owning_business',
  stripeSubscriptionId:'sub_owning_business',
};
const valid = {
  id:'in_valid',status:'paid',amount_remaining:0,livemode:true,
  customer:'cus_owning_business',
  parent:{type:'subscription_details',
    subscription_details:{subscription:'sub_owning_business'}},
};

function adapter(invoice: Record<string,unknown>) {
  const retrieve=vi.fn().mockResolvedValue(invoice);
  const stripe={invoices:{retrieve}} as unknown as Pick<Stripe,'invoices'>;
  return {service:new PartnerCreditStripeInvoiceAuthorityAdapter(stripe),retrieve};
}

describe('Split 08 provider invoice authority is not credit application authority',()=>{
  it('retrieves the live invoice from Stripe rather than trusting a webhook payload',async()=>{
    const {service,retrieve}=adapter(valid);
    expect(await service.inspect(expected)).toEqual({
      kind:'invoice_verified_credit_unproven',invoiceRef:'in_valid',
    });
    expect(retrieve).toHaveBeenCalledWith('in_valid');
  });
  it('rejects untrusted or malformed identifiers without a Stripe call',async()=>{
    const {service,retrieve}=adapter(valid);
    expect(await service.inspect({...expected,invoiceRef:'invalid'})).toEqual({
      kind:'invoice_mismatch',reason:'IDENTITY_INVALID',
    });
    expect(retrieve).not.toHaveBeenCalled();
  });
  it('rejects unpaid, draft, void, outstanding, test-mode or incorrect invoices',async()=>{
    const cases=[
      {status:'draft'},{status:'void'},{status:'open'},{amount_remaining:1},
      {livemode:false},{id:'in_another'},
    ];
    for(const changes of cases){
      const {service}=adapter({...valid,...changes});
      expect((await service.inspect(expected)).kind).toBe('invoice_mismatch');
    }
  });
  it('rejects other business customer and subscription and absent subscription',async()=>{
    for(const changes of [
      {customer:'cus_other'},
      {parent:{type:'subscription_details',subscription_details:{subscription:'sub_other'}}},
      {parent:null},
    ]){
      const {service}=adapter({...valid,...changes});
      expect(await service.inspect(expected)).toEqual({
        kind:'invoice_mismatch',reason:'INVOICE_CUSTOMER_SUBSCRIPTION_MISMATCH',
      });
    }
  });
});
