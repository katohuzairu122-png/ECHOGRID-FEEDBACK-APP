import { describe, expect, it } from 'vitest';
import { classifyDevelopmentObservationRetry as classify } from './development-observation-retry-classification';

describe('DEV-26 disposable observation retry classification', () => {
  it('does not invent a record after pre-append rejection', () => {
    expect(classify([{ outcome: 'REJECTED_BEFORE_RECORD', visibleRecords: 0 }]).status).toBe('NOT_RECORDED');
  });
  it('reports an acknowledged visible record without durability claims', () => {
    expect(classify([{ outcome: 'ACKNOWLEDGED', visibleRecords: 1 }])).toEqual({
      status: 'OBSERVED', financialAuthorization: 'NOT_GRANTED',
      durableProof: false, exactlyOnce: false,
    });
  });
  it('preserves uncertainty when acknowledgement is lost even if sink is visible', () => {
    expect(classify([{ outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: 1 }]).status).toBe('UNCERTAIN');
  });
  it('recognizes duplicate visible records after an ambiguous retry', () => {
    expect(classify([
      { outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: 1 },
      { outcome: 'ACKNOWLEDGED', visibleRecords: 2 },
    ])).toEqual({
      status: 'DUPLICATE_OBSERVED', financialAuthorization: 'NOT_GRANTED',
      durableProof: false, exactlyOnce: false,
    });
  });
  it('rejects impossible transitions and extra metadata', () => {
    expect(() => classify([{ outcome: 'REJECTED_BEFORE_RECORD', visibleRecords: 1 }])).toThrow();
    expect(() => classify([{ outcome: 'ACKNOWLEDGED', visibleRecords: 0 }])).toThrow();
    expect(() => classify([{ outcome: 'ACKNOWLEDGED', visibleRecords: 1, businessId: 'private' } as never])).toThrow();
    expect(() => classify([])).toThrow();
  });
  it('never changes financial authorization across retry sequences', () => {
    for (const sequence of [
      [{ outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: 0 }],
      [{ outcome: 'ACKNOWLEDGED', visibleRecords: 1 }],
      [{ outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: 1 }, { outcome: 'ACKNOWLEDGED', visibleRecords: 2 }],
    ] as const) {
      const result = classify(sequence);
      expect(result.financialAuthorization).toBe('NOT_GRANTED');
      expect(result.durableProof).toBe(false);
      expect(result.exactlyOnce).toBe(false);
    }
  });
});
