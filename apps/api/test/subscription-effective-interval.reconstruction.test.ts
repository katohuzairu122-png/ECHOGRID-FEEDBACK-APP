import { describe, expect, it } from 'vitest';
import {
  reconstructSchedulePriceIntervals,
  type ProviderSchedulePhaseEvidence,
} from '../src/partner-credits/subscription-effective-interval.reconstruction';

const base: ProviderSchedulePhaseEvidence = {
  scheduleId: 'sub_sched_123',
  subscriptionId: 'sub_123',
  customerId: 'cus_123',
  businessId: 'tenant_123',
  phaseStartSeconds: Date.parse('2026-10-01T00:00:00Z') / 1000,
  phaseEndSeconds: Date.parse('2026-11-01T00:00:00Z') / 1000,
  priceId: 'price_starter',
  interval: 'month',
  currency: 'usd',
  itemCount: 1,
  capturedProviderEventId: 'evt_start',
};
const args = {
  businessId: base.businessId,
  customerId: base.customerId,
  subscriptionId: base.subscriptionId,
  fulfillmentAt: new Date('2026-10-15T12:00:00Z'),
};
const inspect = (phases: ProviderSchedulePhaseEvidence[]) =>
  reconstructSchedulePriceIntervals({ ...args, phases });
describe('Stripe schedule phase effective interval candidates', () => {
  it('reconstructs half-open phase boundaries but never authorizes issuance', () => {
    expect(inspect([base])).toMatchObject({
      historicalTierVerified: false,
      issuanceAuthorized: false,
      reason: 'UNPROVEN_HISTORICAL_COMPLETENESS',
      candidateAtFulfillment: { priceId: 'price_starter' },
    });
  });
  it('rejects missing phase history and cross-business evidence', () => {
    expect(inspect([]).reason).toBe('ABSENT_PHASE_HISTORY');
    expect(inspect([{ ...base, businessId: 'tenant_other' }]).reason).toBe('IDENTITY_MISMATCH');
  });
  it('rejects overlap, gap, and malformed time boundaries', () => {
    const next = { ...base, capturedProviderEventId: 'evt_growth',
      priceId: 'price_growth', phaseStartSeconds: base.phaseEndSeconds,
      phaseEndSeconds: base.phaseEndSeconds + 86400 };
    expect(inspect([next, base]).candidates).toHaveLength(2);
    expect(inspect([base, { ...next, phaseStartSeconds: base.phaseEndSeconds - 1 }]).reason)
      .toBe('INCONSISTENT_PHASES');
    expect(inspect([base, { ...next, phaseStartSeconds: base.phaseEndSeconds + 1 }]).reason)
      .toBe('INCONSISTENT_PHASES');
    expect(inspect([{ ...base, phaseEndSeconds: base.phaseStartSeconds }]).reason)
      .toBe('INCONSISTENT_PHASES');
  });
  it('rejects annual and multi-item schedules', () => {
    expect(inspect([{ ...base, interval: 'year' }]).reason).toBe('UNSUPPORTED_PHASE');
    expect(inspect([{ ...base, itemCount: 2 }]).reason).toBe('UNSUPPORTED_PHASE');
  });
  it('does not treat an uncovered fulfillment instant as verified', () => {
    const result = reconstructSchedulePriceIntervals({
      ...args,
      fulfillmentAt: new Date('2026-12-01T00:00:00Z'),
      phases: [base],
    });
    expect(result).toMatchObject({
      reason: 'UNPROVEN_HISTORICAL_COMPLETENESS',
      candidateAtFulfillment: null,
      historicalTierVerified: false,
    });
  });
});
