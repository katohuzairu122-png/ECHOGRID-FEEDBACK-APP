import { describe, expect, it } from 'vitest';
import { assessPriceTimeline, type PriceTimelineObservation } from '../src/partner-credits/subscription-price-timeline.evidence';

const base: PriceTimelineObservation = {
  eventId: 'evt_a', eventCreatedAt: new Date('2026-10-10T09:00:00Z'),
  businessId: 'business-one', customerId: 'cus_one',
  subscriptionId: 'sub_one', priceId: 'price_starter', interval: 'month',
  status: 'active', periodStart: new Date('2026-10-01T00:00:00Z'),
  periodEnd: new Date('2026-11-01T00:00:00Z'), providerCorroborated: true,
};
const input = {
  businessId: base.businessId, customerId: base.customerId,
  subscriptionId: base.subscriptionId,
  fulfilledAt: new Date('2026-10-11T10:00:00Z'),
};
const inspect = (observations: PriceTimelineObservation[]) =>
  assessPriceTimeline({ ...input, observations });
describe('Subscription price timeline evidence gate', () => {
  it('never infers a verified tier from even corroborated singleton history', () => {
    expect(inspect([base])).toMatchObject({
      reason: 'EFFECTIVE_WINDOW_UNPROVEN', historicalTierVerified: false,
      issuanceAuthorized: false, candidatePriceIds: ['price_starter'],
    });
  });
  it('rejects an empty history', () => {
    expect(inspect([]).reason).toBe('HISTORY_ABSENT');
  });
  it('rejects uncorroborated observations', () => {
    expect(inspect([{ ...base, providerCorroborated: false }]).reason).toBe('PROVIDER_NOT_CORROBORATED');
  });
  it('rejects cross-business evidence', () => {
    expect(inspect([{ ...base, businessId: 'business-other' }]).reason).toBe('IDENTITY_CONFLICT');
  });
  it('detects conflicting duplicate provider event references', () => {
    expect(inspect([base, { ...base, priceId: 'price_growth' }]).reason).toBe('DUPLICATE_EVENT_CONFLICT');
  });
  it('treats price changes and out-of-order event arrival as ambiguous', () => {
    const next = { ...base, eventId: 'evt_b', priceId: 'price_growth', eventCreatedAt: new Date('2026-10-11T09:00:00Z') };
    const a = inspect([next, base]);
    const b = inspect([base, next]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ reason: 'TIMELINE_AMBIGUOUS', issuanceAuthorized: false });
  });
  it('rejects annual plans and trialing state', () => {
    expect(inspect([{ ...base, interval: 'year' }]).reason).toBe('UNSUPPORTED_BILLING_STATE');
    expect(inspect([{ ...base, status: 'trialing' }]).reason).toBe('UNSUPPORTED_BILLING_STATE');
  });
  it('does not infer price from future events', () => {
    expect(inspect([{ ...base, eventCreatedAt: new Date('2026-10-12T00:00:00Z') }]).reason)
      .toBe('EFFECTIVE_WINDOW_UNPROVEN');
  });
});
