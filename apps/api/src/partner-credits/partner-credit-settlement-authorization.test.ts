import { describe, it, expect } from 'vitest';
import {
  createSettlementEvidenceSigner, DEVELOPMENT_ALLOWED_INTERVALS, SETTLEMENT_PROVENANCE_LABEL, settlementProvenanceMessage, validSettlementGateConfig, verifySettlementProvenance,
  SettlementAuthorizationError, SettlementAuthorizationRecorder, type SettlementGateConfig,
} from './partner-credit-settlement-authorization';
import type { Database } from '../db/client';

async function key(keyId: string) {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return {
    signer: await createSettlementEvidenceSigner(keyId, Buffer.from((await crypto.subtle.exportKey('pkcs8', kp.privateKey)) as ArrayBuffer).toString('base64')),
    publicHex: Buffer.from((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer).toString('hex'),
  };
}
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const digest = 'ab'.repeat(32);

describe('D1/D3-DEV-04 settlement provenance (pure)', () => {
  it('signs a deterministic, versioned, key-bound message and verifies it only with the matching public key', async () => {
    const a = await key('rec-a'); const b = await key('rec-b');
    const msg = settlementProvenanceMessage('rec-a', digest);
    expect(new TextDecoder().decode(msg)).toBe(`${SETTLEMENT_PROVENANCE_LABEL.length}:${SETTLEMENT_PROVENANCE_LABEL};5:rec-a;64:${digest};`);
    const sig = hex(await a.signer.sign(msg));
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(hex(await a.signer.sign(msg))).toBe(sig); // Ed25519 is deterministic
    expect(await verifySettlementProvenance('rec-a', digest, sig, { 'rec-a': a.publicHex })).toBe(true);
    expect(await verifySettlementProvenance('rec-a', digest, sig, { 'rec-a': b.publicHex })).toBe(false); // substituted key
    expect(await verifySettlementProvenance('rec-a', 'cd'.repeat(32), sig, { 'rec-a': a.publicHex })).toBe(false); // another digest
    expect(await verifySettlementProvenance('rec-b', digest, sig, { 'rec-a': a.publicHex, 'rec-b': b.publicHex })).toBe(false); // key id is bound into the message
    expect(await verifySettlementProvenance('rec-a', digest, sig, {})).toBe(false); // untrusted / revoked
    expect(await verifySettlementProvenance('rec-a', digest, sig.slice(2), { 'rec-a': a.publicHex })).toBe(false); // malformed
    expect(await verifySettlementProvenance('rec-a', digest, sig.toUpperCase(), { 'rec-a': a.publicHex })).toBe(false);
    expect(await verifySettlementProvenance('rec-a', digest, sig, { 'rec-a': 'zz' })).toBe(false);
    for (const evil of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) expect(await verifySettlementProvenance(evil, digest, sig, {})).toBe(false);
  });

  it('refuses a corrupt or malformed signing credential, and the signer exposes no key material', async () => {
    await expect(createSettlementEvidenceSigner('rec-a', 'bm90LWEta2V5')).rejects.toThrow(/RECORDER_UNCONFIGURED/);
    await expect(createSettlementEvidenceSigner('bad id', '')).rejects.toThrow(/RECORDER_UNCONFIGURED/);
    const a = await key('rec-a');
    expect(Object.keys(a.signer).sort()).toEqual(['keyId', 'sign']);
    expect(Object.isFrozen(a.signer)).toBe(true);
  });

  it('the gate configuration fails closed without a valid trusted-key registry', async () => {
    const a = await key('rec-a');
    const ok: SettlementGateConfig = { providerAccountId: 'acct_x', providerMode: 'test', freshnessWindowMs: 1000, policyEffectiveFromMs: null, allowedIntervals: DEVELOPMENT_ALLOWED_INTERVALS,
      acceptedEvidenceKinds: ['MOCK_SYNTHETIC'], trustedSigningKeys: { 'rec-a': a.publicHex } };
    expect(validSettlementGateConfig(ok)).toBe(true);
    for (const bad of [{ trustedSigningKeys: {} }, { trustedSigningKeys: undefined }, { trustedSigningKeys: null }, { trustedSigningKeys: { 'rec-a': 'short' } }, { trustedSigningKeys: { 'bad id': a.publicHex } },
      { trustedSigningKeys: { 'rec-a': a.publicHex.toUpperCase() } }]) expect(validSettlementGateConfig({ ...ok, ...bad } as unknown as SettlementGateConfig), JSON.stringify(bad)).toBe(false);
  });

  it('a recorder without a signer, or with an unsafe role name, refuses before touching the database', async () => {
    const a = await key('rec-a');
    const cfg: SettlementGateConfig = { providerAccountId: 'acct_x', providerMode: 'test', freshnessWindowMs: 1000, policyEffectiveFromMs: null, allowedIntervals: DEVELOPMENT_ALLOWED_INTERVALS,
      acceptedEvidenceKinds: ['MOCK_SYNTHETIC'], trustedSigningKeys: { 'rec-a': a.publicHex } };
    const neverCalled = new Proxy({}, { get() { throw new Error('the database must not be touched'); } }) as unknown as Database;
    const input = { reservationId: '00000000-0000-0000-0000-000000000001', businessId: '00000000-0000-0000-0000-000000000002', evidence: {} as never };
    await expect(new SettlementAuthorizationRecorder(neverCalled, cfg).record(input)).rejects.toThrow(/RECORDER_UNCONFIGURED/);
    await expect(new SettlementAuthorizationRecorder(neverCalled, cfg, a.signer, 'x; drop table businesses').record(input)).rejects.toThrow(/RECORDER_UNCONFIGURED/);
    await expect(new SettlementAuthorizationRecorder(neverCalled, { ...cfg, trustedSigningKeys: {} }, a.signer).record(input)).rejects.toThrow(/CONFIG_INVALID/);
    expect(new SettlementAuthorizationError('RECORDER_UNCONFIGURED').message).toBe('SETTLEMENT_AUTH_RECORDER_UNCONFIGURED');
  });
});
