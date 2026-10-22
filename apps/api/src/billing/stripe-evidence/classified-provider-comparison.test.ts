import { describe, expect, it } from 'vitest';
import { compareClassifiedProvenance } from './classified-provider-comparison';

const envelope = (changes: Record<string, unknown> = {}) => JSON.stringify({
  id: 'evt_123', type: 'customer.subscription.updated',
  created: 1790000000, livemode: false, account: 'acct_123',
  data: { object: { object: 'subscription', id: 'sub_123' } },
  ...changes,
});

describe('HETA G2 classified provenance boundary (diagnostic only)', () => {
  it('matches valid envelopes after independent shape classification', () => {
    expect(compareClassifiedProvenance(envelope(), envelope())).toEqual({
      status: 'matched', mismatches: [],
    });
  });

  it('prioritizes malformed webhook over a malformed retrieval', () => {
    expect(compareClassifiedProvenance('{', '[]')).toEqual({
      status: 'unusable_envelope', source: 'webhook', parseStatus: 'not_json',
      defects: ['missing_id', 'missing_created', 'missing_livemode', 'missing_type', 'missing_data_object'],
    });
  });

  it('rejects an invalid retrieved envelope without comparing its fields', () => {
    expect(compareClassifiedProvenance(envelope(), envelope({ livemode: 'false' }))).toEqual({
      status: 'unusable_envelope', source: 'retrieved',
      parseStatus: 'json_object_invalid_envelope', defects: ['bad_livemode'],
    });
  });

  it('reports stable mismatches separately from shape errors', () => {
    const actual = compareClassifiedProvenance(envelope(), envelope({ account: 'acct_456' }));
    expect(actual.status).toBe('mismatched');
    if (actual.status === 'mismatched') {
      expect(actual.mismatches.map(x => x.field)).toEqual(['event_account']);
    }
  });

  it('never upgrades missing object identity to a match', () => {
    expect(compareClassifiedProvenance(envelope(), envelope({
      data: { object: { object: 'subscription' } },
    }))).toEqual({ status: 'insufficient_evidence', reasons: ['missing_object_id'] });
  });

  it('rejects invalid JSON primitive as an unusable retrieved event', () => {
    const actual = compareClassifiedProvenance(envelope(), 'null');
    expect(actual.status).toBe('unusable_envelope');
    if (actual.status === 'unusable_envelope') {
      expect(actual.source).toBe('retrieved');
      expect(actual.parseStatus).toBe('json_non_object');
    }
  });
});
