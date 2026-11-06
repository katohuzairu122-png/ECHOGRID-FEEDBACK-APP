import { describe, expect, it, vi } from 'vitest';
import { createCustodySettlementClassificationStage, type VerifiedCustodyReader } from './custody-settlement-classification';
import type { SettlementClassifierContext } from '../settlement-eligibility.classifier';

const BIZ = 'c33112d3-7bb4-4b35-ab92-03246d05bb43';
const EVIDENCE = 'a9d3a73b-d8f9-4de5-b44f-7a7e4fa2db94';
const ctx = {
  nowMs: 500_000,
  policy: { version: null, effectiveFromMs: null, freshnessWindowMs: null },
  expected: {
    businessId: BIZ, reservationId: 'r1', intentRef: 'i1', invoiceRef: 'inv1',
    providerAccountId: 'acct1', providerMode: 'test',
    frozenAllocation: { allocationDigest: '0'.repeat(64) },
  },
} as unknown as SettlementClassifierContext;
const evidence = {
  provenance: { evidenceKind: 'MOCK_SYNTHETIC' },
  binding: { businessId: BIZ, reservationId: 'r1', intentRef: 'i1' },
  invoice: { id: 'inv1' },
  provider: { accountId: 'acct1', mode: 'test' },
};
const success = {
  ok: true, evidenceId: EVIDENCE, authenticity: 'AUTHENTIC',
  financialAuthorization: 'NOT_GRANTED',
  claims: {
    businessId: BIZ, environment: 'development', purpose: 'SYNTHETIC_TEST_EVIDENCE',
    evidenceType: 'SYNTHETIC_TEST_EVIDENCE',
  },
  payload: { settlementEvidence: evidence },
} as unknown as Extract<Awaited<ReturnType<VerifiedCustodyReader['retrieve']>>, {ok: true}>;

type CustodyResponse = Awaited<ReturnType<VerifiedCustodyReader['retrieve']>>;
function rig(stored: CustodyResponse = success, context: SettlementClassifierContext = ctx) {
  const retrieve = vi.fn(async () => stored);
  // Test double is confined to this file. Production requires the concrete DEV-15 service.
  const custody = { retrieve } satisfies VerifiedCustodyReader;
  const stage = createCustodySettlementClassificationStage({ custody, context: async () => context });
  return { retrieve, stage };
}

describe('DEV-17: merged custody-to-classifier integration remains inert', () => {
  it('rejects malformed evidence identifiers before custody reads', async () => {
    const { stage, retrieve } = rig();
    expect(await stage.evaluate('invalid')).toEqual({ ok: false, reason: 'INVALID_REQUEST', financialAuthorization: 'NOT_GRANTED' });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('always requests actual custody retrieval with the scoped synthetic binding', async () => {
    const { stage, retrieve } = rig();
    const result = await stage.evaluate(EVIDENCE);
    expect(retrieve).toHaveBeenCalledWith({
      evidenceId: EVIDENCE, businessId: BIZ,
      purpose: 'SYNTHETIC_TEST_EVIDENCE', evidenceType: 'SYNTHETIC_TEST_EVIDENCE',
    });
    expect(result.financialAuthorization).toBe('NOT_GRANTED');
    expect(result).toMatchObject({ ok: false, reason: 'CLASSIFICATION_UNRESOLVED' });
  });

  it('fails closed when custody denies access or is unavailable', async () => {
    const { stage } = rig({ ok: false, reason: 'NOT_FOUND' });
    expect(await stage.evaluate(EVIDENCE)).toMatchObject({ ok: false, reason: 'CUSTODY_UNAVAILABLE' });
    const custody: VerifiedCustodyReader = { retrieve: async () => { throw new Error('secret'); } };
    const broken = createCustodySettlementClassificationStage({ custody, context: async () => ctx });
    expect(await broken.evaluate(EVIDENCE)).toEqual({ ok: false, reason: 'CUSTODY_UNAVAILABLE', financialAuthorization: 'NOT_GRANTED' });
  });

  it('rejects forged success flags, wrong environments and wrong business bindings', async () => {
    const cases = [
      { ...success, financialAuthorization: 'GRANTED' },
      { ...success, authenticity: 'UNVERIFIED' },
      { ...success, claims: { ...((success as Extract<CustodyResponse, { ok: true }>).claims), environment: 'production' } },
      { ...success, claims: { ...((success as Extract<CustodyResponse, { ok: true }>).claims), businessId: 'another' } },
    ];
    for (const wrong of cases) {
      const { stage } = rig(wrong as CustodyResponse);
      expect(await stage.evaluate(EVIDENCE)).toMatchObject({ ok: false, reason: 'CUSTODY_UNVERIFIED' });
    }
  });

  it('rejects payload mismatches before classification and never grants authority', async () => {
    for (const payload of [
      { verdict: 'ELIGIBLE' },
      { settlementEvidence: { ...evidence, binding: { ...evidence.binding, businessId: 'foreign' } } },
      { settlementEvidence: { ...evidence, provider: { ...evidence.provider, accountId: 'foreign' } } },
      { settlementEvidence: { ...evidence, invoice: { id: 'foreign' } } },
    ]) {
      const { stage } = rig({ ...success, payload } as CustodyResponse);
      expect(await stage.evaluate(EVIDENCE)).toMatchObject({ ok: false, reason: 'BINDING_MISMATCH', financialAuthorization: 'NOT_GRANTED' });
    }
  });

  it('fails closed on missing, undecidable or incompatible expected context', async () => {
    const bad = { ...ctx, expected: { ...ctx.expected, businessId: 'foreign' } } as SettlementClassifierContext;
    const { stage } = rig(success, bad);
    expect(await stage.evaluate(EVIDENCE)).toMatchObject({ ok: false });
  });
});
