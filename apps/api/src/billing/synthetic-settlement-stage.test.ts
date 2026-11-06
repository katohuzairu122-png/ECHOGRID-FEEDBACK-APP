import { describe, expect, it, vi } from 'vitest';
import { createSyntheticSettlementStage } from './synthetic-settlement-stage';
import type { EvidenceVerifier, ExpectedEvidence, VerifiedEvidence } from './stripe-read/evidence-signing';
import type { SettlementClassifierContext } from './settlement-eligibility.classifier';

const businessId = 'd562ad93-d929-481f-a39b-dbc510b70d42';
const expected: ExpectedEvidence = {
  businessId, purpose: 'SYNTHETIC_TEST_EVIDENCE',
  evidenceType: 'SYNTHETIC_TEST_EVIDENCE', environment: 'development',
};
const context = { expected: { businessId } } as SettlementClassifierContext;
const authentic = {
  ok: true, authenticity: 'AUTHENTIC', financialAuthorization: 'NOT_GRANTED',
  claims: { businessId }, payload: { settlementEvidence: {} }, keyState: 'ACTIVE',
} as VerifiedEvidence;

function fixture(options: { stored?: unknown; verification?: VerifiedEvidence; expected?: ExpectedEvidence } = {}) {
  const load = vi.fn(async () => options.stored === undefined ? { synthetic: true } : options.stored);
  const verify = vi.fn(async () => options.verification ?? authentic);
  const getContext = vi.fn(async () => context);
  const stage = createSyntheticSettlementStage({
    lookup: { load }, verifier: { verify } as EvidenceVerifier,
    expected: options.expected ?? expected, context: getContext,
  });
  return { stage, load, verify, getContext };
}

describe('DEV-16 synthetic signed settlement staging — no financial authority', () => {
  it('refuses malformed evidence ids without reading custody or verifying', async () => {
    const { stage, load, verify } = fixture();
    expect(await stage.evaluate('../ invalid')).toEqual({
      ok: false, reason: 'INVALID_REQUEST', financialAuthorization: 'NOT_GRANTED',
    });
    expect(load).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('refuses production, staging and observation-purpose identities before custody reads', async () => {
    for (const value of [
      { ...expected, environment: 'production' as const },
      { ...expected, environment: 'staging' as const },
      { ...expected, purpose: 'STRIPE_OBSERVATION_ATTESTATION' as const },
    ]) {
      const { stage, load } = fixture({ expected: value });
      expect(await stage.evaluate('synthetic-1')).toMatchObject({ ok: false, reason: 'BINDING_MISMATCH' });
      expect(load).not.toHaveBeenCalled();
    }
  });

  it('fails closed when custody is missing or unavailable', async () => {
    const missing = fixture({ stored: null });
    expect(await missing.stage.evaluate('synthetic-1')).toMatchObject({ ok: false, reason: 'EVIDENCE_UNAVAILABLE' });
    expect(missing.verify).not.toHaveBeenCalled();
    const unavailable = createSyntheticSettlementStage({
      lookup: { load: async () => { throw new Error('private provider error'); } },
      verifier: { verify: async () => authentic }, expected, context: async () => context,
    });
    expect(await unavailable.evaluate('synthetic-1')).toEqual({
      ok: false, reason: 'EVIDENCE_UNAVAILABLE', financialAuthorization: 'NOT_GRANTED',
    });
  });

  it('rejects invalid cryptographic verification before reading policy', async () => {
    const { stage, getContext } = fixture({ verification: { ok: false, reason: 'SIGNATURE_INVALID' } });
    expect(await stage.evaluate('synthetic-1')).toMatchObject({ ok: false, reason: 'SIGNATURE_UNVERIFIED' });
    expect(getContext).not.toHaveBeenCalled();
  });

  it('rejects a purported signed payload with a different tenant', async () => {
    const { stage } = fixture({ verification: {
      ...authentic, claims: { ...authentic.claims, businessId: 'another-tenant' },
    } as VerifiedEvidence });
    expect(await stage.evaluate('synthetic-1')).toMatchObject({ ok: false, reason: 'BINDING_MISMATCH' });
  });

  it('does not accept a naked verdict, a missing payload, or an unresolved classifier result', async () => {
    for (const payload of [{ verdict: 'ELIGIBLE' }, {}, { settlementEvidence: {} }]) {
      const { stage } = fixture({ verification: { ...authentic, payload } as VerifiedEvidence });
      const result = await stage.evaluate('synthetic-1');
      expect(result.ok).toBe(false);
      expect(result.financialAuthorization).toBe('NOT_GRANTED');
    }
  });
});
