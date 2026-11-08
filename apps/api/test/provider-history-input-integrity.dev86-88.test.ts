import { describe, expect, it } from 'vitest';
import {
  auditSubscriptionHistory,
  type CorroboratedChange,
} from '../src/partner-credits/provider-history-completeness.audit';

const change: CorroboratedChange = {
  eventId: 'evt_valid',
  createdSeconds: 100,
  businessId: 'business-a',
  customerId: 'cus_valid',
  subscriptionId: 'sub_valid',
  observedPriceId: 'price_valid',
  previousPriceId: null,
  providerCorroborated: true,
};

const baseline = {
  businessId: 'business-a',
  customerId: 'cus_valid',
  subscriptionId: 'sub_valid',
  fulfillmentSeconds: 101,
  providerPaginationExhausted: true,
  providerRetentionCoversFulfillment: true,
  changes: [change],
};

const audit = (input: unknown) => auditSubscriptionHistory(input as Parameters<typeof auditSubscriptionHistory>[0]);

function expectNegativeInvalid(input: unknown) {
  expect(audit(input)).toEqual({
    complete: false,
    historicalTierVerified: false,
    issuanceAuthorized: false,
    reason: 'INVALID_INPUT',
    orderedEventIds: [],
  });
}

describe('Group 14 negative-only provider history input integrity', () => {
  it('DEV-86 preserves the consistent-history negative-only verdict', () => {
    expect(audit(baseline)).toMatchObject({
      complete: false,
      historicalTierVerified: false,
      issuanceAuthorized: false,
      reason: 'EFFECTIVE_TIME_UNPROVEN',
    });
  });

  it.each([
    null, undefined, [], {}, 'invalid',
  ])('DEV-86 rejects malformed envelope %j', (input) => {
    expectNegativeInvalid(input);
  });

  it.each([
    { businessId: ' ' }, { businessId: 'tenant/other' },
    { customerId: 'cus_' }, { customerId: 'cus_bad/other' },
    { subscriptionId: 'sub_' }, { subscriptionId: null },
    { fulfillmentSeconds: Number.NaN }, { fulfillmentSeconds: -1 },
    { providerPaginationExhausted: 'true' }, { providerRetentionCoversFulfillment: 1 },
    { changes: null }, { changes: {} },
  ])('DEV-86 rejects malformed outer scope %j', (overrides) => {
    expectNegativeInvalid({ ...baseline, ...overrides });
  });

  it.each([
    null, undefined, {}, [], 'invalid',
    { ...change, eventId: 'evt_' },
    { ...change, eventId: 'evt_x/other' },
    { ...change, createdSeconds: Number.NaN },
    { ...change, createdSeconds: -1 },
    { ...change, businessId: 'x/y' },
    { ...change, customerId: null },
    { ...change, subscriptionId: 'sub_' },
    { ...change, observedPriceId: null },
    { ...change, observedPriceId: 'price_' },
    { ...change, previousPriceId: 'price_' },
    { ...change, providerCorroborated: 'true' },
  ])('DEV-87 fail-closes malformed provider change before sorting %j', (entry) => {
    expectNegativeInvalid({ ...baseline, changes: [entry] });
  });

  it('DEV-88 refuses one invalid change even when valid evidence is present', () => {
    expectNegativeInvalid({ ...baseline, changes: [change, { ...change, eventId: '' }] });
  });

  it('DEV-88 preserves the existing negative-only scope mismatch verdict', () => {
    expect(audit({ ...baseline, changes: [{ ...change, businessId: 'business-b' }] }))
      .toMatchObject({ reason: 'IDENTITY_MISMATCH', historicalTierVerified: false, issuanceAuthorized: false });
  });

  it('DEV-88 preserves explicit missing corroboration as a separate reason', () => {
    expect(audit({ ...baseline, changes: [{ ...change, providerCorroborated: false }] }))
      .toMatchObject({ reason: 'NOT_CORROBORATED', historicalTierVerified: false, issuanceAuthorized: false });
  });
});
