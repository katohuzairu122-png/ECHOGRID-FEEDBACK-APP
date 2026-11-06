import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/client';
import { readRestrictedDurableProvenance } from './restricted-durable-provenance-read';

const businessId = '11111111-1111-4111-8111-111111111111';
const reservationId = '22222222-2222-4222-8222-222222222222';
const authorizationId = '33333333-3333-4333-8333-333333333333';
const request = { businessId, reservationId, authorizationId };

describe('DEV-21 restricted provenance read — fail closed', () => {
  it('rejects malformed UUIDs before database access', async () => {
    const transaction = vi.fn();
    const db = { transaction } as unknown as Database;
    expect(await readRestrictedDurableProvenance(db, { ...request, businessId: 'invalid' }))
      .toEqual({ ok: false, reason: 'INVALID_REQUEST' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('reports unavailable when restricted database role cannot be assumed', async () => {
    const db = {
      transaction: async (fn: (tx: object) => Promise<unknown>) =>
        fn({ execute: async () => { throw new Error('permission denied'); } }),
    } as unknown as Database;
    expect(await readRestrictedDurableProvenance(db, request))
      .toEqual({ ok: false, reason: 'UNAVAILABLE' });
  });
});
