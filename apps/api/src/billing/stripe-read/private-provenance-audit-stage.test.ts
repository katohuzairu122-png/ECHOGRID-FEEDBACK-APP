import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/client';
import type { VerifiedCustodyReader } from './custody-settlement-classification';
import {
  createPrivateProvenanceAuditStage,
  createUnprovisionedProvenanceAuditSource,
} from './private-provenance-audit-stage';

const businessId = '11111111-1111-4111-8111-111111111111';
const reservationId = '22222222-2222-4222-8222-222222222222';
const authorizationId = '33333333-3333-4333-8333-333333333333';
const request = { businessId, reservationId, authorizationId };

describe('DEV-22 private audit stage (inert/fail-closed)', () => {
  const make = (source: { load(): Promise<unknown> } | null) => {
    const transaction = vi.fn();
    const db = { transaction } as unknown as Database;
    // Intentionally forged reader: none of these tests may reach DB.
    const custodyReader = { retrieve: vi.fn() } as unknown as VerifiedCustodyReader;
    return {
      stage: createPrivateProvenanceAuditStage({
        db, custodyReader, source, environment: 'development',
        clock: () => 500000, recorderPublicKeys: {},
      }),
      transaction, custodyReader,
    };
  };

  it('disabled-by-default audit source contains no authority', async () => {
    const source = createUnprovisionedProvenanceAuditSource();
    expect(await source.load()).toBe(null);
    const { stage, transaction } = make(source);
    expect(await stage.verify(request)).toEqual({
      status: 'UNAVAILABLE', durable: false, financialAuthorization: 'NOT_GRANTED',
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses caller-created reader and never consults DB or user data', async () => {
    const load = vi.fn(async () => ({
      workloadId: 'auditor', role: 'PROVENANCE_AUDITOR', environment: 'development',
      businessIds: [businessId], validFromMs: 1, expiresAtMs: 900000, revokedAtMs: null,
    }));
    const { stage, transaction, custodyReader } = make({ load });
    expect(await stage.verify(request)).toMatchObject({
      status: 'UNAVAILABLE', financialAuthorization: 'NOT_GRANTED',
    });
    expect(load).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(custodyReader.retrieve).not.toHaveBeenCalled();
  });

  it('rejects malformed requests before any trust or database read', async () => {
    const source = { load: vi.fn(async () => null) };
    const { stage, transaction } = make(source);
    expect(await stage.verify({ ...request, reservationId: 'bad' })).toMatchObject({
      status: 'UNAVAILABLE', durable: false,
    });
    expect(source.load).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
