import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/client';
import type { VerifiedCustodyReader } from './custody-settlement-classification';
import {
  createObservedPrivateProvenanceAuditStage,
  createUnprovisionedProvenanceObservationSink,
  type PrivateProvenanceObservation,
} from './private-provenance-observation';

const request = {
  businessId: '11111111-1111-4111-8111-111111111111',
  reservationId: '22222222-2222-4222-8222-222222222222',
  authorizationId: '33333333-3333-4333-8333-333333333333',
};

describe('DEV-23 bounded private provenance observation', () => {
  const setup = (record?: (event: PrivateProvenanceObservation) => Promise<void>) => {
    const transaction = vi.fn();
    const custodyRetrieve = vi.fn();
    const sourceLoad = vi.fn(async () => null);
    const stage = createObservedPrivateProvenanceAuditStage({
      db: { transaction } as unknown as Database,
      custodyReader: { retrieve: custodyRetrieve } as unknown as VerifiedCustodyReader,
      source: { load: sourceLoad },
      environment: 'development',
      clock: () => 500000,
      recorderPublicKeys: {},
      sink: record ? { record } : null,
    });
    return { stage, transaction, custodyRetrieve, sourceLoad };
  };

  it('refuses success when an observation sink is missing', async () => {
    const { stage, transaction, custodyRetrieve } = setup();
    expect(await stage.verify(request)).toEqual({
      status: 'UNAVAILABLE', durable: false, financialAuthorization: 'NOT_GRANTED',
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(custodyRetrieve).not.toHaveBeenCalled();
  });

  it('refuses success when the observer throws', async () => {
    const record = vi.fn(async () => { throw new Error('observer unavailable'); });
    const { stage, transaction } = setup(record);
    expect(await stage.verify(request)).toEqual({
      status: 'UNAVAILABLE', durable: false, financialAuthorization: 'NOT_GRANTED',
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('emits only a frozen, bounded, nonfinancial denial event', async () => {
    const record = vi.fn(async (_event: PrivateProvenanceObservation) => {});
    const { stage, transaction, custodyRetrieve, sourceLoad } = setup(record);
    const result = await stage.verify(request);
    expect(result).toEqual({
      status: 'UNAVAILABLE', durable: false, financialAuthorization: 'NOT_GRANTED',
    });
    expect(record).toHaveBeenCalledTimes(1);
    const observed = record.mock.calls[0]![0];
    expect(observed).toEqual({
      event: 'PRIVATE_PROVENANCE_VERIFICATION',
      status: 'UNAVAILABLE',
      financialAuthorization: 'NOT_GRANTED',
    });
    expect(Object.isFrozen(observed)).toBe(true);
    const serialized = JSON.stringify(observed);
    for (const sensitive of Object.values(request)) expect(serialized).not.toContain(sensitive);
    expect(transaction).not.toHaveBeenCalled();
    expect(custodyRetrieve).not.toHaveBeenCalled();
    expect(sourceLoad).not.toHaveBeenCalled();
  });

  it('refuses an unprovisioned sink explicitly', async () => {
    const sink = createUnprovisionedProvenanceObservationSink();
    await expect(sink.record({
      event: 'PRIVATE_PROVENANCE_VERIFICATION',
      status: 'UNAVAILABLE',
      financialAuthorization: 'NOT_GRANTED',
    })).rejects.toThrow('PROVENANCE_OBSERVATION_SINK_UNPROVISIONED');
  });

  it('remains unavailable for malformed input without invoking the database', async () => {
    const record = vi.fn(async (_event: PrivateProvenanceObservation) => {});
    const { stage, transaction } = setup(record);
    expect(await stage.verify({ ...request, authorizationId: 'not-a-uuid' })).toMatchObject({
      status: 'UNAVAILABLE', financialAuthorization: 'NOT_GRANTED',
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
  });
});
