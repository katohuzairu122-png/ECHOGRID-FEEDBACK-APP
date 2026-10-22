import { describe, expect, it } from 'vitest';
import { compareProviderEventFields } from './provider-fields';
import type { WellFormedEnvelope } from './shape';

const event = (change: Partial<WellFormedEnvelope> = {}): WellFormedEnvelope => ({
  id: 'evt_123', type: 'customer.subscription.updated', created: 1790000000,
  livemode: false, account: null, apiVersion: '2026-05-27.dahlia',
  requestId: null, idempotencyKey: null,
  dataObject: { object: 'subscription', id: 'sub_123', customer: 'cus_1' },
  ...change,
});

describe('HETA G2 typed stable-field comparison (non-authoritative)', () => {
  it('matches typed stable fields despite irrelevant object details', () => {
    expect(compareProviderEventFields(event(), event({
      dataObject: { object: 'subscription', id: 'sub_123', customer: 'cus_2', metadata: { arbitrary: true } },
      apiVersion: '2024-01-01', requestId: 'req_2',
    }))).toEqual({ status: 'matched', mismatches: [] });
  });

  it('reports changed subscription identity without assigning tenant authority', () => {
    const result = compareProviderEventFields(event(), event({
      dataObject: { object: 'subscription', id: 'sub_swapped' },
    }));
    expect(result.status).toBe('mismatched');
    if (result.status === 'mismatched') expect(result.mismatches.map(m => m.field)).toEqual(['object_id']);
  });

  it('compares event id, type, timestamp, mode, and Connect account separately', () => {
    const result = compareProviderEventFields(event(), event({
      id: 'evt_other', type: 'customer.subscription.deleted', created: 1790000001,
      livemode: true, account: 'acct_123',
    }));
    expect(result.status).toBe('mismatched');
    if (result.status === 'mismatched') expect(result.mismatches.map(m => m.field)).toEqual([
      'event_id', 'event_type', 'event_created', 'livemode', 'event_account',
    ]);
  });

  it('fails closed for missing object type or identifier', () => {
    expect(compareProviderEventFields(event(), event({ dataObject: {} }))).toEqual({
      status: 'insufficient_evidence', reasons: ['missing_object_type', 'missing_object_id'],
    });
    expect(compareProviderEventFields(event({ dataObject: { object: 'subscription' } }), event()).status)
      .toBe('insufficient_evidence');
  });

  it('does not confuse webhook serialization with provider-field mismatch', () => {
    const sameEvent = event({ dataObject: { id: 'sub_123', object: 'subscription' } });
    expect(compareProviderEventFields(event(), sameEvent).status).toBe('matched');
  });
});
