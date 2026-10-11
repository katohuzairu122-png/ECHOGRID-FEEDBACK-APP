import { describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { extractSubscriptionChangeEvidence } from '../src/partner-credits/stripe-subscription-change.evidence';

const raw = {
  id:'evt_upgrade',
  type:'customer.subscription.updated',
  created:1791712800,
  data:{
    object:{
      id:'sub_one',
      customer:'cus_one',
      metadata:{businessId:'business-one'},
      items:{data:[{price:{id:'price_growth'}}]},
    },
    previous_attributes:{items:{data:[{price:{id:'price_starter'}}]}},
  },
} as unknown as Stripe.Event;
const input = {
  event:raw, businessId:'business-one', customerId:'cus_one',
  subscriptionId:'sub_one', expectedPriceId:'price_growth',
  observationCorroborated:true,
};
describe('Immutable Stripe subscription change evidence',()=>{
  it('records observed price changes without claiming effective timestamp or issuance',()=>{
    const result=extractSubscriptionChangeEvidence(input);
    expect(result).toMatchObject({kind:'observation',evidence:{
      previousPriceId:'price_starter', observedPriceId:'price_growth',
      changeDirection:'price_changed_unknown_direction',
      effectiveAt:null,effectiveAtVerified:false,
      historicalTierVerified:false,issuanceAuthorized:false,
    }});
  });
  it('rejects uncorroborated event',()=>{
    expect(extractSubscriptionChangeEvidence({...input,observationCorroborated:false}))
      .toMatchObject({kind:'rejected',reason:'SOURCE_NOT_CORROBORATED'});
  });
  it('rejects cross-business and mismatched price evidence',()=>{
    expect(extractSubscriptionChangeEvidence({...input,businessId:'business-two'}))
      .toMatchObject({kind:'rejected',reason:'IDENTITY_MISMATCH'});
    expect(extractSubscriptionChangeEvidence({...input,expectedPriceId:'price_other'}))
      .toMatchObject({kind:'rejected',reason:'PRICE_MISMATCH_OR_UNSUPPORTED_ITEMS'});
  });
  it('does not invent previous price when absent',()=>{
    const event={...raw,data:{object:raw.data.object}} as Stripe.Event;
    expect(extractSubscriptionChangeEvidence({...input,event}))
      .toMatchObject({kind:'observation',evidence:{
        previousPriceId:null,changeDirection:'no_price_change_proven',effectiveAtVerified:false,
      }});
  });
  it('rejects non-update provider events',()=>{
    const event={...raw,type:'customer.subscription.created'} as Stripe.Event;
    expect(extractSubscriptionChangeEvidence({...input,event}))
      .toMatchObject({kind:'rejected',reason:'EVENT_NOT_ELIGIBLE'});
  });
});
