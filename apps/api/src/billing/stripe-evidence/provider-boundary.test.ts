import { describe, expect, it } from 'vitest';
import { classifyEnvelope } from './shape';
import { compareProviderEventFields } from './provider-fields';

/**
 * G2 boundary integration: exercise real webhook/provider JSON shape parsing,
 * then compare typed stable fields. This is a diagnostic consistency signal,
 * NOT provider attestation, tenant authority or financial authorization.
 */
const payload = (override: Record<string, unknown> = {}) => ({
  id: 'evt_boundary_123',
  type: 'customer.subscription.updated',
  created: 1790000000,
  livemode: false,
  account: 'acct_123',
  api_version: '2026-05-27.dahlia',
  data: { object: { object: 'subscription', id: 'sub_123', customer: 'cus_123' } },
  ...override,
});

function parsed(document: unknown) {
  const result = classifyEnvelope(JSON.stringify(document));
  if (result.kind !== 'ok') throw new Error('Fixture is not a well-formed envelope');
  return result.envelope;
}

describe('HETA G2 cross-provenance shape-to-comparison boundary', () => {
  it('compares the same event despite JSON field ordering and unrelated provider metadata', () => {
    const webhook = parsed(payload());
    const retrieved = parsed({
      data: { object: { metadata: { foo: 'bar' }, id: 'sub_123', object: 'subscription' } },
      created: 1790000000, account: 'acct_123', livemode: false,
      type: 'customer.subscription.updated', id: 'evt_boundary_123',
    });
    expect(compareProviderEventFields(webhook, retrieved)).toEqual({
      status: 'matched', mismatches: [],
    });
  });

  it('detects a replay from a different Connect account or mode', () => {
    const webhook = parsed(payload());
    const retrieved = parsed(payload({ account: 'acct_456', livemode: true }));
    const comparison = compareProviderEventFields(webhook, retrieved);
    expect(comparison.status).toBe('mismatched');
    if (comparison.status === 'mismatched') {
      expect(comparison.mismatches.map(m => m.field)).toEqual(['livemode', 'event_account']);
    }
  });

  it('detects an event identity substitution despite identical object identity', () => {
    const comparison = compareProviderEventFields(
      parsed(payload()), parsed(payload({ id: 'evt_boundary_456' })),
    );
    expect(comparison.status).toBe('mismatched');
    if (comparison.status === 'mismatched') {
      expect(comparison.mismatches.map(m => m.field)).toEqual(['event_id']);
    }
  });

  it('rejects provider object identity gaps rather than asserting a match', () => {
    const comparison = compareProviderEventFields(
      parsed(payload()),
      parsed(payload({ data: { object: { object: 'subscription' } } })),
    );
    expect(comparison).toEqual({
      status: 'insufficient_evidence', reasons: ['missing_object_id'],
    });
  });

  it('does not call malformed authenticated envelopes equivalent to valid ones', () => {
    const malformed = classifyEnvelope(JSON.stringify(payload({ livemode: 'false' })));
    expect(malformed.kind).toBe('malformed');
    if (malformed.kind === 'malformed') expect(malformed.defects).toContain('bad_livemode');
  });

  it('does not mutate source envelope objects when comparing', () => {
    const a = parsed(payload());
    const b = parsed(payload());
    const beforeA = JSON.stringify(a);
    const beforeB = JSON.stringify(b);
    expect(compareProviderEventFields(a, b).status).toBe('matched');
    expect(JSON.stringify(a)).toBe(beforeA);
    expect(JSON.stringify(b)).toBe(beforeB);
  });
});
