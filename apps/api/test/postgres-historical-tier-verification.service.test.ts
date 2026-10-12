import { describe, expect, it, vi } from 'vitest';
import { PostgresHistoricalTierVerificationService } from '../src/partner-credits/postgres-historical-tier-verification.service';
import type { PostgresSubscriptionEvidenceRepository } from '../src/partner-credits/postgres-subscription-evidence.repository';
import type { IntegratedProviderTierAuthorityGate } from '../src/partner-credits/integrated-provider-tier-authority.gate';

const input = {
  businessId:'business-one',customerId:'cus_one',subscriptionId:'sub_one',
  fulfilledAt:new Date('2026-10-12T01:00:00Z'),
};
const row = {
  stripeEventId:'evt_one',stripeEventCreatedAt:new Date('2026-10-11T10:00:00Z'),
  stripeEventType:'customer.subscription.updated',businessId:'business-one',
  stripeCustomerId:'cus_one',stripeSubscriptionId:'sub_one',stripePriceId:'price_one',
  billingInterval:'month',status:'active',itemPeriodStart:null,itemPeriodEnd:null,
};
function setup(rows: unknown[] = [row], fail = false) {
  const findForSubscription = fail ? vi.fn().mockRejectedValue(new Error('db down')) : vi.fn().mockResolvedValue(rows);
  const inspect = vi.fn().mockResolvedValue({
    historicalTierVerified:false,issuanceAuthorized:false,
    reason:'HISTORICAL_COVERAGE_AND_EFFECTIVE_TIME_UNPROVEN',matchedEventIds:['evt_one'],
  });
  const service = new PostgresHistoricalTierVerificationService(
    {findForSubscription} as unknown as PostgresSubscriptionEvidenceRepository,
    {inspect} as unknown as IntegratedProviderTierAuthorityGate,
  );
  return {service,findForSubscription,inspect};
}
describe('Split 07 PostgreSQL historical-tier authority contract',()=>{
  it('loads evidence from the trusted repository, never caller-supplied rows',async()=>{
    const {service,findForSubscription,inspect}=setup();
    const outcome=await service.inspect(input);
    expect(findForSubscription).toHaveBeenCalledWith(input);
    expect(inspect).toHaveBeenCalledWith({...input,localObservations:[row]});
    expect(outcome).toMatchObject({historicalTierVerified:false,issuanceAuthorized:false});
  });
  it('fails closed before reads for invalid tenant identity',async()=>{
    const {service,findForSubscription}=setup();
    expect((await service.inspect({...input,customerId:'wrong'})).reason).toBe('INVALID_INPUT');
    expect(findForSubscription).not.toHaveBeenCalled();
  });
  it('fails closed on empty or unavailable database evidence',async()=>{
    expect((await setup([]).service.inspect(input)).reason).toBe('LOCAL_HISTORY_ABSENT');
    expect((await setup([],true).service.inspect(input)).reason).toBe('POSTGRES_EVIDENCE_UNAVAILABLE');
  });
});
