import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from './bundle-builder';
import { checkProposedCustodyAuthorizationLink, type ProposedCustodyAuthorizationLink } from './custody-authorization-provenance';
import type { RetrieveResult } from './signed-evidence-custody';
import {
  createSettlementEvidenceSigner, settlementAuthorizationDigest, settlementProvenanceMessage,
  type StoredAuthorization,
} from '../../partner-credits/partner-credit-settlement-authorization';

const B = '8d14e8a4-d195-4ddf-b18a-2b6b382d20c8';
const R = 'adf3a6da-4c4e-422b-b423-a5365af05f68';
const A = '8b1e8165-c1e6-4be7-9a6b-41f4036d64e6';
const E = 'b10b642e-8a99-4b9c-8b26-87d4dd536db4';
const D = '37aabf64-7a48-4dc2-9291-6ef1b02dfe4e';
const H = 'a'.repeat(64);
const S = 'b'.repeat(64);

async function fixture() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const signer = await createSettlementEvidenceSigner('rec-dev20', Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64'));
  const publicHex = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('hex');
  const auth: StoredAuthorization = {
    id: A, businessId: B, reservationId: R, decisionId: D,
    invoiceRef: 'in_dev20', providerAccountId: 'acct_dev20', providerMode: 'test',
    allocationDigest: H, policyVersion: 'PC-BENEFIT/1', verdict: 'UNRESOLVED',
    reasonCodes: ['INPUT_INVALID'], classifierVersion: 'D1/1', evidenceKind: 'MOCK_SYNTHETIC',
    billingInterval: 'month', snapshotRef: 'snap_dev20', snapshotDigest: S,
    observedAtMs: 500000, evidenceDigest: '', provenanceVersion: 1,
    signingKeyId: 'rec-dev20', signature: '',
  };
  auth.evidenceDigest = await settlementAuthorizationDigest(auth);
  auth.signature = Buffer.from(await signer.sign(settlementProvenanceMessage(signer.keyId, auth.evidenceDigest))).toString('hex');
  const payload = {
    settlementEvidence: {
      binding: { businessId: B, reservationId: R },
      provider: { accountId: 'acct_dev20', mode: 'test' },
      invoice: { id: 'in_dev20' },
      provenance: { snapshotRef: 'snap_dev20', snapshotDigest: S, observedAtMs: 500000 },
    },
  };
  const hash = await sha256Hex(canonicalJson(payload));
  const custody: RetrieveResult = {
    ok: true, evidenceId: E, authenticity: 'AUTHENTIC', financialAuthorization: 'NOT_GRANTED',
    keyState: 'ACTIVE', custody: { status: 'STORED', recordVersion: 1, persistedAtMs: 500000, custodianWorkloadId: 'custodian:dev20' },
    claims: {
      schema: 'S08-SIGNED-EVIDENCE', schemaVersion: 1, evidenceType: 'SYNTHETIC_TEST_EVIDENCE',
      purpose: 'SYNTHETIC_TEST_EVIDENCE', environment: 'development', businessId: B,
      workloadId: 'signer:dev20', keyId: 'custody-dev20', keyVersion: 1,
      algorithm: 'Ed25519', signedAtMs: 500000, payloadSha256: hash,
    },
    payload,
  };
  const link: ProposedCustodyAuthorizationLink = {
    evidenceId: E, authorizationId: A, businessId: B, reservationId: R,
    payloadSha256: hash, custodyKeyId: 'custody-dev20',
    custodyKeyVersion: 1, authorizationEvidenceDigest: auth.evidenceDigest,
  };
  return { link, custody, auth, keys: { 'rec-dev20': publicHex } };
}

describe('DEV-20 provenance binding contract — no durable authority', () => {
  it('checks both content digest and independently signed recorder authorization without granting authority', async () => {
    const f = await fixture();
    expect(await checkProposedCustodyAuthorizationLink(f.link, f.custody, f.auth, f.keys)).toEqual({
      ok: true, link: f.link, financialAuthorization: 'NOT_GRANTED', durable: false,
    });
  });

  it('rejects identity substitution and untrusted custody states', async () => {
    const f = await fixture();
    for (const link of [
      { ...f.link, evidenceId: R }, { ...f.link, authorizationId: R },
      { ...f.link, businessId: R }, { ...f.link, reservationId: B },
      { ...f.link, custodyKeyVersion: 0 }, { ...f.link, payloadSha256: 'x' },
      { ...f.link, authorizationEvidenceDigest: 'x' },
    ]) expect((await checkProposedCustodyAuthorizationLink(link, f.custody, f.auth, f.keys)).ok).toBe(false);
    if (!f.custody.ok) throw Error('fixture');
    expect((await checkProposedCustodyAuthorizationLink(f.link, { ...f.custody, keyState: 'RETIRED' }, f.auth, f.keys)).ok).toBe(false);
    expect((await checkProposedCustodyAuthorizationLink(f.link, { ok: false, reason: 'KEY_REVOKED' }, f.auth, f.keys)).ok).toBe(false);
    expect((await checkProposedCustodyAuthorizationLink(f.link, { ...f.custody, claims: { ...f.custody.claims, businessId: R } }, f.auth, f.keys)).ok).toBe(false);
  });

  it('refuses payload, binding, provider, invoice and snapshot substitution', async () => {
    const f = await fixture();
    if (!f.custody.ok) throw Error('fixture');
    const originals = f.custody.payload.settlementEvidence as Record<string, unknown>;
    for (const changed of [
      { ...originals, binding: { businessId: R, reservationId: R } },
      { ...originals, binding: { businessId: B, reservationId: B } },
      { ...originals, provider: { accountId: 'other', mode: 'test' } },
      { ...originals, invoice: { id: 'other' } },
      { ...originals, provenance: { snapshotRef: 'other', snapshotDigest: S, observedAtMs: 500000 } },
    ]) {
      const custody = { ...f.custody, payload: { settlementEvidence: changed } };
      expect((await checkProposedCustodyAuthorizationLink(f.link, custody, f.auth, f.keys)).ok).toBe(false);
    }
  });

  it('rejects tampered recorder fields, forged signatures and revoked recorder public keys', async () => {
    const f = await fixture();
    expect((await checkProposedCustodyAuthorizationLink(f.link, f.custody, { ...f.auth, policyVersion: 'altered' }, f.keys)).ok).toBe(false);
    expect((await checkProposedCustodyAuthorizationLink(f.link, f.custody, { ...f.auth, signature: 'f'.repeat(128) }, f.keys)).ok).toBe(false);
    expect((await checkProposedCustodyAuthorizationLink(f.link, f.custody, f.auth, {})).ok).toBe(false);
    expect((await checkProposedCustodyAuthorizationLink(f.link, f.custody, { ...f.auth, id: R }, f.keys)).ok).toBe(false);
  });
});
