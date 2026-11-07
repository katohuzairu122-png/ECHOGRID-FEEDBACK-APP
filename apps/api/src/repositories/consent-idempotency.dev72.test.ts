import { describe, expect, it } from 'vitest';
import type { NewConsentGrant, ConsentGrant } from './consent-grant.repository';
import { assertConsentIdempotencyMatch } from './consent-grant.repository';

const existing: Pick<ConsentGrant,
  'customerId' | 'businessId' | 'purpose' | 'scope' | 'resourceType' |
  'resourceId' | 'consentVersion'> = {
  customerId: 'customer-a',
  businessId: 'business-a',
  purpose: 'survey_participation',
  scope: 'participate',
  resourceType: 'survey_campaign',
  resourceId: 'campaign-a',
  consentVersion: 'v1',
};

const input: NewConsentGrant = {
  customerId: 'customer-a',
  businessId: 'business-a',
  purpose: 'survey_participation',
  scope: 'participate',
  resourceType: 'survey_campaign',
  resourceId: 'campaign-a',
  consentVersion: 'v1',
};

describe('DEV-72 consent idempotency replay authority', () => {
  it('accepts a replay with the identical customer, business and consent authority', () => {
    expect(() => assertConsentIdempotencyMatch(existing, input)).not.toThrow();
  });

  it.each([
    { field: 'customer', change: { customerId: 'customer-b' } },
    { field: 'business', change: { businessId: 'business-b' } },
    { field: 'purpose', change: { purpose: 'marketing' as const } },
    { field: 'scope', change: { scope: 'marketing' } },
    { field: 'resource type', change: { resourceType: 'another_resource' } },
    { field: 'resource id', change: { resourceId: 'campaign-b' } },
    { field: 'consent version', change: { consentVersion: 'v2' } },
  ])('rejects a matching key claimed for a different $field', ({ change }) => {
    expect(() => assertConsentIdempotencyMatch(existing, { ...input, ...change }))
      .toThrowError(expect.objectContaining({
        status: 409, code: 'CONSENT_IDEMPOTENCY_CONFLICT',
      }));
  });

  it('normalizes absent optional identity fields to database null without granting a different scope', () => {
    const nullScope: typeof existing = {
      ...existing, businessId: null, resourceType: null, resourceId: null, scope: null,
    };
    const omitted: NewConsentGrant = {
      customerId: 'customer-a', purpose: 'survey_participation', consentVersion: 'v1',
    };
    expect(() => assertConsentIdempotencyMatch(nullScope, omitted)).not.toThrow();
    expect(() => assertConsentIdempotencyMatch(existing, omitted))
      .toThrowError(expect.objectContaining({ code: 'CONSENT_IDEMPOTENCY_CONFLICT' }));
  });

  it('does not leak either input scope or customer identifiers through its error message', () => {
    const secret = 'sensitive-customer-identifier';
    try {
      assertConsentIdempotencyMatch(existing, { ...input, customerId: secret });
      throw new Error('EXPECTED_CONSENT_REPLAY_DENIAL');
    } catch (error) {
      expect(error).toMatchObject({ status: 409, code: 'CONSENT_IDEMPOTENCY_CONFLICT' });
      expect(String(error)).not.toContain(secret);
    }
  });
});
