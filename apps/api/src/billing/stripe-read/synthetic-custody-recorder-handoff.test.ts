import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyntheticCustodyRecorderHandoff, type IndependentSettlementRecorder } from './synthetic-custody-recorder-handoff';
import type { VerifiedCustodyReader } from './custody-settlement-classification';
import { SignedEvidenceCustodyService, isIssuedCustodyReader } from './index';

const BIZ = 'c33112d3-7bb4-4b35-ab92-03246d05bb43';
const EVIDENCE_ID = 'a9d3a73b-d8f9-4de5-b44f-7a7e4fa2db94';
const AUTH_ID = 'bb29c6b8-82d0-4995-bca0-44b9f6c0befc';
const request = { evidenceId: EVIDENCE_ID, businessId: BIZ, reservationId: 'res-1' };
const signed = {
  ok: true as const,
  authenticity: 'AUTHENTIC' as const,
  financialAuthorization: 'NOT_GRANTED' as const,
  claims: {
    schema: 'S08-SIGNED-EVIDENCE' as const, schemaVersion: 1 as const,
    evidenceType: 'SYNTHETIC_TEST_EVIDENCE' as const, purpose: 'SYNTHETIC_TEST_EVIDENCE' as const,
    environment: 'development' as const, businessId: BIZ, workloadId: 'signer:synthetic',
    keyId: 'test', keyVersion: 1, algorithm: 'Ed25519' as const, signedAtMs: 500_000,
    payloadSha256: '0'.repeat(64),
  },
  payload: {
    settlementEvidence: {
      provenance: { evidenceKind: 'MOCK_SYNTHETIC', snapshotRef: 'snapshot-1' },
      binding: { businessId: BIZ, reservationId: 'res-1', intentRef: 'intent-1' },
    },
  },
};
type CustodyResponse = Awaited<ReturnType<VerifiedCustodyReader['retrieve']>>;
afterEach(() => vi.restoreAllMocks());
function issuedReader(retrieve: VerifiedCustodyReader['retrieve']): VerifiedCustodyReader {
  // A real DEV-15 custody instance issues the capability; the test substitutes
  // its retrieval implementation only, without a database or signing credential.
  const service = new SignedEvidenceCustodyService({
    db: {} as ConstructorParameters<typeof SignedEvidenceCustodyService>[0]['db'],
    keys: { load: async () => null }, environment: 'development',
    clock: () => 500_000,
    authority: {} as ConstructorParameters<typeof SignedEvidenceCustodyService>[0]['authority'],
  });
  vi.spyOn(SignedEvidenceCustodyService.prototype, 'retrieve').mockImplementation(retrieve as SignedEvidenceCustodyService['retrieve']);
  return service.issueTrustedReader();
}
function rig(stored: CustodyResponse = signed, recordResult: unknown = { id: AUTH_ID, verdict: 'UNRESOLVED', reasonCodes: ['INPUT_INVALID'], replay: false }) {
  const retrieve = vi.fn(async () => stored);
  const record = vi.fn(async () => recordResult) as unknown as IndependentSettlementRecorder['record'];
  const stage = createSyntheticCustodyRecorderHandoff({
    custody: issuedReader(retrieve),
    recorder: { record },
  });
  return { stage, retrieve, record };
}

describe('DEV-18 synthetic custody-to-recorder handoff (inert)', () => {
  it('passes evidence facts to the existing recorder without supplying any verdict', async () => {
    const { stage, retrieve, record } = rig();
    const result = await stage.record(request);
    expect(retrieve).toHaveBeenCalledWith({
      evidenceId: EVIDENCE_ID, businessId: BIZ,
      purpose: 'SYNTHETIC_TEST_EVIDENCE', evidenceType: 'SYNTHETIC_TEST_EVIDENCE',
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      businessId: BIZ, reservationId: 'res-1', evidence: signed.payload.settlementEvidence,
    });
    expect(result).toEqual({
      ok: true, evidenceId: EVIDENCE_ID, authorizationId: AUTH_ID,
      verdict: 'UNRESOLVED', replay: false, financialAuthorization: 'NOT_GRANTED',
    });
  });

  it('refuses malformed input before custody and recorder', async () => {
    const { stage, retrieve, record } = rig();
    for (const req of [null, {}, { ...request, evidenceId: 'wrong' },
      { ...request, businessId: 'not-a-uuid' }, { ...request, reservationId: '' },
      { ...request, verdict: 'ELIGIBLE' }]) {
      expect(await stage.record(req as typeof request)).toMatchObject({ ok: false, reason: 'INVALID_REQUEST' });
    }
    expect(retrieve).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses unavailable custody without invoking the recorder', async () => {
    const { stage, record } = rig({ ok: false, reason: 'NOT_FOUND' });
    expect(await stage.record(request)).toEqual({ ok: false, reason: 'CUSTODY_UNAVAILABLE', financialAuthorization: 'NOT_GRANTED' });
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses an unverified or wrongly bound custody result', async () => {
    for (const item of [
      { ...signed, claims: { ...signed.claims, businessId: 'foreign' } },
      { ...signed, claims: { ...signed.claims, environment: 'production' } },
      { ...signed, authenticity: 'ASSERTED' },
      { ...signed, financialAuthorization: 'GRANTED' },
    ]) {
      const { stage, record } = rig(item as CustodyResponse);
      expect(await stage.record(request)).toMatchObject({ ok: false, reason: 'CUSTODY_UNVERIFIED' });
      expect(record).not.toHaveBeenCalled();
    }
  });

  it('rejects embedded caller verdict and cross-reservation, cross-business or wrong-kind evidence', async () => {
    for (const payload of [
      { verdict: 'ELIGIBLE' },
      { settlementEvidence: { ...signed.payload.settlementEvidence, binding: { ...signed.payload.settlementEvidence.binding, businessId: 'foreign' } } },
      { settlementEvidence: { ...signed.payload.settlementEvidence, binding: { ...signed.payload.settlementEvidence.binding, reservationId: 'foreign' } } },
      { settlementEvidence: { ...signed.payload.settlementEvidence, provenance: { evidenceKind: 'STRIPE_LIVE' } } },
    ]) {
      const { stage, record } = rig({ ...signed, payload } as CustodyResponse);
      expect(await stage.record(request)).toMatchObject({ ok: false, reason: 'BINDING_MISMATCH' });
      expect(record).not.toHaveBeenCalled();
    }
  });

  it('does not allow recorder errors, malformed responses or concurrency to grant financial authority', async () => {
    const bad = rig(signed, { id: 'not-uuid', verdict: 'ELIGIBLE', replay: false });
    expect(await bad.stage.record(request)).toEqual({ ok: false, reason: 'RECORDER_UNAVAILABLE', financialAuthorization: 'NOT_GRANTED' });
    const errorRecorder = createSyntheticCustodyRecorderHandoff({
      custody: issuedReader(async () => signed),
      recorder: { record: async () => { throw new Error('secret signer'); } },
    });
    expect(await errorRecorder.record(request)).toEqual({ ok: false, reason: 'RECORDER_UNAVAILABLE', financialAuthorization: 'NOT_GRANTED' });
    const replay = rig(signed, { id: AUTH_ID, verdict: 'ELIGIBLE', reasonCodes: [], replay: true });
    const results = await Promise.all(Array.from({ length: 8 }, () => replay.stage.record(request)));
    expect(results).toHaveLength(8);
    expect(results.every(r => r.financialAuthorization === 'NOT_GRANTED')).toBe(true);
    expect(results.every(r => r.ok && r.authorizationId === AUTH_ID && r.replay)).toBe(true);
  });

  it('rejects a forged structurally compatible reader before custody or recorder executes', async () => {
    const retrieve = vi.fn(async () => signed);
    const record = vi.fn(async () => ({ id: AUTH_ID, verdict: 'ELIGIBLE' as const, reasonCodes: [], replay: false }));
    const fake: VerifiedCustodyReader = { retrieve };
    expect(isIssuedCustodyReader(fake)).toBe(false);
    const stage = createSyntheticCustodyRecorderHandoff({ custody: fake, recorder: { record } });
    expect(await stage.record(request)).toEqual({ ok: false, reason: 'CUSTODY_NOT_TRUSTED', financialAuthorization: 'NOT_GRANTED' });
    expect(retrieve).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    const genuine = issuedReader(async () => signed);
    expect(isIssuedCustodyReader(genuine)).toBe(true);
    expect(isIssuedCustodyReader({ ...genuine })).toBe(false);
    expect(isIssuedCustodyReader(new Proxy(genuine, {}))).toBe(false);
    // Replacing the instance method after issuance must never replace the captured verifier.
    const compromised = issuedReader(async () => ({ ok: false, reason: 'SIGNER_CONFIG_MISSING' }));
    const fakeService = {} as SignedEvidenceCustodyService;
    expect(isIssuedCustodyReader(fakeService)).toBe(false);
    // The capability retains the underlying implementation selected at issuance.
    expect(await compromised.retrieve({ evidenceId: EVIDENCE_ID, businessId: BIZ, purpose: 'SYNTHETIC_TEST_EVIDENCE', evidenceType: 'SYNTHETIC_TEST_EVIDENCE' })).toMatchObject({ ok: false });
  });
});
