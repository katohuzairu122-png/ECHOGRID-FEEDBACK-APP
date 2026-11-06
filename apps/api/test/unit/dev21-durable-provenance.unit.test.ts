import { describe, expect, it } from 'vitest';
import { durableProvenanceResult } from '../../src/billing/stripe-read/durable-provenance-result';
import { verifyDurableSettlementProvenance } from '../../src/billing/stripe-read/durable-provenance-verifier';
import type { Database } from '../../src/db/client';
import type { VerifiedCustodyReader } from '../../src/billing/stripe-read/custody-settlement-classification';

describe('DEV-21 durable provenance foundation', () => {
  it.each(['VERIFIED', 'UNLINKED', 'INVALID', 'UNAVAILABLE'] as const)(
    'keeps %s explicitly nonfinancial', status => {
      const result = durableProvenanceResult(status);
      expect(result.status).toBe(status);
      expect(result.financialAuthorization).toBe('NOT_GRANTED');
      expect(result.durable).toBe(status === 'VERIFIED');
      expect(Object.isFrozen(result)).toBe(true);
    },
  );

  it('refuses caller-created custody readers before any database access', async () => {
    const fakeReader = {
      retrieve: async () => { throw new Error('caller reader must never execute'); },
    } as unknown as VerifiedCustodyReader;
    const fakeDb = {
      transaction: async () => { throw new Error('database must never execute'); },
    } as unknown as Database;
    const result = await verifyDurableSettlementProvenance(fakeDb, fakeReader, {
      businessId: '11111111-1111-4111-8111-111111111111',
      reservationId: '22222222-2222-4222-8222-222222222222',
      authorizationId: '33333333-3333-4333-8333-333333333333',
    }, {});
    expect(result).toEqual({
      status: 'UNAVAILABLE',
      durable: false,
      financialAuthorization: 'NOT_GRANTED',
    });
  });
});
