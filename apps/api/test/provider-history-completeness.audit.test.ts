import { describe, expect, it } from 'vitest';
import { auditSubscriptionHistory, type CorroboratedChange } from '../src/partner-credits/provider-history-completeness.audit';

const first: CorroboratedChange = {
  eventId:'evt_start',createdSeconds:100,businessId:'business-a',
  customerId:'cus_a',subscriptionId:'sub_a',observedPriceId:'price_starter',
  previousPriceId:null,providerCorroborated:true,
};
const second: CorroboratedChange = {
  ...first,eventId:'evt_next',createdSeconds:200,
  previousPriceId:'price_starter',observedPriceId:'price_growth',
};
const input = {
  businessId:'business-a',customerId:'cus_a',subscriptionId:'sub_a',
  fulfillmentSeconds:250,providerPaginationExhausted:true,
  providerRetentionCoversFulfillment:true,
};
const check = (changes: CorroboratedChange[]) => auditSubscriptionHistory({...input,changes});

describe('Split 07 negative-only provider history completeness',()=>{
  it('never authorizes issuance with a consistent price chain',()=>{
    const r=check([second,first]);
    expect(r).toMatchObject({
      reason:'EFFECTIVE_TIME_UNPROVEN',complete:false,
      historicalTierVerified:false,issuanceAuthorized:false,
      orderedEventIds:['evt_start','evt_next'],
    });
  });
  it('rejects incomplete provider pages or retention coverage',()=>{
    expect(auditSubscriptionHistory({...input,changes:[first],providerPaginationExhausted:false}).reason)
      .toBe('HISTORY_BOUNDS_UNKNOWN');
    expect(auditSubscriptionHistory({...input,changes:[first],providerRetentionCoversFulfillment:false}).reason)
      .toBe('HISTORY_BOUNDS_UNKNOWN');
  });
  it('rejects a missing price predecessor',()=>{
    expect(check([first,{...second,previousPriceId:null}]).reason).toBe('PRICE_CHAIN_GAP');
  });
  it('rejects contradictory provider prices',()=>{
    expect(check([first,{...second,previousPriceId:'price_other'}]).reason)
      .toBe('PRICE_CHAIN_CONFLICT');
  });
  it('detects conflicting replay of one event id',()=>{
    expect(check([first,{...first,observedPriceId:'price_other'}]).reason)
      .toBe('EVENT_CONFLICT');
  });
  it('rejects missing independent provider corroboration and wrong tenant',()=>{
    expect(check([{...first,providerCorroborated:false}]).reason).toBe('NOT_CORROBORATED');
    expect(check([{...first,businessId:'business-other'}]).reason).toBe('IDENTITY_MISMATCH');
  });
  it('does not infer order for conflicting prices at the same timestamp',()=>{
    expect(check([first,{...second,createdSeconds:100}]).reason)
      .toBe('PRICE_CHAIN_CONFLICT');
  });
});
