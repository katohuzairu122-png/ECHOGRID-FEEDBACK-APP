import { describe, expect, it } from 'vitest';
import { reviewHistoricalEffectiveTimeAuthority } from '../src/partner-credits/historical-effective-time-authority.review';
const base = {
  businessId:'business-one',customerId:'cus_one',subscriptionId:'sub_one',
  fulfillmentAt:new Date('2026-10-01T12:00:00Z'),
};
describe('Split 07 historical effective-time review refuses unsupported authority',()=>{
  it('rejects bare event timestamps and billing boundaries',()=>{
    for(const kind of ['stripe_event_created','stripe_item_period_start','current_schedule_phase','retained_event_history'] as const) {
      const r=reviewHistoricalEffectiveTimeAuthority({...base,sources:[{
        kind,providerRef:'evt_one',effectiveAt:new Date('2026-10-01T10:00:00Z'),
        immutableCapture:true,completeFromSubscriptionInception:true,
      }]});
      expect(r).toMatchObject({historicalTierVerified:false,issuanceAuthorized:false,
        reason:'UNPROVEN_TRANSITION_AUTHORITY'});
    }
  });
  it('does not trust a self-asserted complete historical receipt',()=>{
    const result=reviewHistoricalEffectiveTimeAuthority({...base,sources:[{
      kind:'immutable_provider_transition_receipt' as const,
      providerRef:'provider-receipt-one',effectiveAt:new Date('2026-10-01T10:00:00Z'),
      immutableCapture:true,completeFromSubscriptionInception:true,
    }]});
    expect(result).toMatchObject({issuanceAuthorized:false,historicalTierVerified:false,
      reason:'HISTORICAL_COMPLETENESS_UNPROVEN',
      candidateTransitionRefs:['provider-receipt-one']});
  });
  it('fails closed for empty evidence or invalid identities',()=>{
    expect(reviewHistoricalEffectiveTimeAuthority({...base,sources:[]}).reason).toBe('NO_EVIDENCE');
    expect(reviewHistoricalEffectiveTimeAuthority({...base,customerId:'bad',sources:[]}).reason)
      .toBe('INVALID_INPUT');
  });
});
