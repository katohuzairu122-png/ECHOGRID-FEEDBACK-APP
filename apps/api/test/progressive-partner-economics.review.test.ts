import { describe, expect, it } from 'vitest';
import {
  inspectProgressiveAwardCandidate, quoteProgressiveRedemption,
  type FulfillmentTierSnapshotCandidate,
} from '../src/partner-credits/progressive-partner-economics.review';

const snapshot: FulfillmentTierSnapshotCandidate = {
  subscriptionId:'db-sub',planId:'db-plan',planKey:'starter',
  stripePriceId:'price_test',stripeSubscriptionId:'sub_test',
  stripeCustomerId:'cus_test',businessId:'db-business',
  billingInterval:'month',activeAtFulfillment:true,
  fulfillmentAt:new Date('2026-10-11T12:00:00Z'),
};
describe('PC-ECON/2 proposed progressive tier economics: never authorizing', () => {
  it('proposes 3/2/1 units for the actual catalog plan keys', () => {
    for (const [planKey,units] of [['starter',3],['growth',2],['business',1]] as const) {
      const result=inspectProgressiveAwardCandidate({...snapshot,planKey},0);
      expect(result).toMatchObject({
        candidateUnits:units,awardableUnits:units,state:'candidate',
        historicalTierVerified:false,issuanceAuthorized:false,
      });
    }
  });
  it('excludes Free, Enterprise, yearly and inactive subscriptions', () => {
    for (const test of [
      {...snapshot,planKey:'free'}, {...snapshot,planKey:'enterprise'},
      {...snapshot,billingInterval:'year' as const},
      {...snapshot,activeAtFulfillment:false},
    ]) {
      expect(inspectProgressiveAwardCandidate(test,0)).toMatchObject({
        awardableUnits:0,state:'not_eligible',issuanceAuthorized:false,
      });
    }
  });
  it('never partially awards units over the 10-unit monthly cap', () => {
    expect(inspectProgressiveAwardCandidate(snapshot,7).awardableUnits).toBe(3);
    expect(inspectProgressiveAwardCandidate(snapshot,8)).toMatchObject({
      candidateUnits:3,awardableUnits:0,state:'cap_exceeded',
    });
    expect(inspectProgressiveAwardCandidate({...snapshot,planKey:'business'},9)
      .awardableUnits).toBe(1);
    expect(()=>inspectProgressiveAwardCandidate(snapshot,-1)).toThrow();
  });
  it('calculates a full threshold based on 30% of eligible cents, rounded down to whole $1 units', () => {
    for (const [cents,units] of [[900,2],[2900,8],[5900,17],[1000,3],[3000,9],[5000,15]]) {
      const quote=quoteProgressiveRedemption({
        eligibleInvoiceCents:cents,vestedUnexpiredAvailableUnits:units,currency:'usd',
      });
      expect(quote).toMatchObject({
        requiredUnits:units,discountCents:units*100,eligibleToRequest:true,
        providerAmountVerified:false,redemptionAuthorized:false,
      });
      expect(quote.discountCents*10).toBeLessThanOrEqual(cents*3);
    }
  });
  it('rejects below-threshold partial discounts, unsupported currency and free invoices', () => {
    expect(quoteProgressiveRedemption({
      eligibleInvoiceCents:2900,vestedUnexpiredAvailableUnits:7,currency:'usd',
    })).toMatchObject({requiredUnits:8,discountCents:0,eligibleToRequest:false});
    expect(quoteProgressiveRedemption({
      eligibleInvoiceCents:0,vestedUnexpiredAvailableUnits:40,currency:'usd',
    })).toMatchObject({requiredUnits:0,discountCents:0,eligibleToRequest:false});
    expect(()=>quoteProgressiveRedemption({
      eligibleInvoiceCents:2900,vestedUnexpiredAvailableUnits:10,currency:'eur',
    })).toThrow('PC_ECON2_REDEMPTION_QUOTE_INVALID');
  });
});
