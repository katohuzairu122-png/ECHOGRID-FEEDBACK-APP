import { describe, it, expect } from 'vitest';
import { BROKER_ISSUER, BROKER_AUDIENCE, BROKER_WORKLOAD, brokerAssertionMessage, brokerHex, verifyBrokerAssertionSignature, type BrokerAssertionClaims } from './broker-assertion.contract';
const uuid = '10000000-0000-4000-8000-000000000001';
const claims: BrokerAssertionClaims = { version: 'B4-03/1', algorithm: 'Ed25519', environment: 'development', issuer: BROKER_ISSUER,
  audience: BROKER_AUDIENCE, workloadId: BROKER_WORKLOAD, keyId: 'fixture', keyVersion: 1, actorType: 'staff', actorId: uuid, sessionId: uuid,
  businessId: uuid, branchId: uuid, operation: 'branches:read', permission: 'branches:view', requestId: uuid, nonce: uuid,
  issuedAt: 1000, expiresAt: 1060, authorizationVersion: null };
async function fixture() {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  const key = { keyId: 'fixture', version: 1, publicKeyHex: brokerHex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))), state: 'ACTIVE' as const, notBefore: 900, notAfter: 2000 };
  const assertion = { claims, signature: brokerHex(new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, brokerAssertionMessage(claims)))) };
  return { assertion, key };
}
describe('B4-03 development assertion signature boundary (not broker authorization)', () => {
  it('accepts a valid signature using public verification material only', async () => { const f = await fixture(); expect(await verifyBrokerAssertionSignature(f.assertion, async () => f.key, 1001)).toBe(true); });
  it.each(['issuer','audience','workloadId','actorId','sessionId','businessId','branchId','nonce','requestId','operation','permission','environment','algorithm','keyId','keyVersion','authorizationVersion'])('rejects modified %s', async field => {
    const f = await fixture(); expect(await verifyBrokerAssertionSignature({ ...f.assertion, claims: { ...claims, [field]: 'changed' } }, async () => f.key, 1001)).toBe(false);
  });
  it.each([999,1060,2000,NaN])('rejects invalid verification time %s', async now => { const f = await fixture(); expect(await verifyBrokerAssertionSignature(f.assertion, async () => f.key, now)).toBe(false); });
  it('rejects revoked, unknown and unavailable keys', async () => {
    const f = await fixture();
    expect(await verifyBrokerAssertionSignature(f.assertion, async () => ({ ...f.key, state: 'REVOKED' }), 1001)).toBe(false);
    expect(await verifyBrokerAssertionSignature(f.assertion, async () => null, 1001)).toBe(false);
    expect(await verifyBrokerAssertionSignature(f.assertion, async () => { throw Error('secret'); }, 1001)).toBe(false);
  });
  it('rejects extra authority fields and malformed envelopes', async () => {
    const f = await fixture();
    for (const raw of [null, {}, { ...f.assertion, approved: true }, { ...f.assertion, claims: { ...claims, approved: true } }, { ...f.assertion, signature: '0'.repeat(128) }])
      expect(await verifyBrokerAssertionSignature(raw, async () => f.key, 1001)).toBe(false);
  });
  it('uses a fixed-order canonical vector independent of object ordering', () => {
    const values = ['ECHO-GRID:BROKER-ASSERTION:B4-03/1','B4-03/1','Ed25519','development','echogrid:development:b4-03','echogrid:development:branch-broker','echogrid:development:staff-issuer','fixture','1','staff',uuid,uuid,uuid,uuid,'branches:read','branches:view',uuid,uuid,'1000','1060','null'];
    const vector = values.map(x => `${x.length}:${x};`).join('');
    expect(new TextDecoder().decode(brokerAssertionMessage(claims))).toBe(vector);
    expect(new TextDecoder().decode(brokerAssertionMessage(Object.fromEntries(Object.entries(claims).reverse()) as unknown as BrokerAssertionClaims))).toBe(vector);
  });
  it('matches RFC 8032 section 7.1 Ed25519 test vector 1 (public test material)', async () => {
    const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!, x => parseInt(x,16));
    const privateKey = await crypto.subtle.importKey('pkcs8', fromHex('302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'), 'Ed25519', false, ['sign']);
    const expected = 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';
    expect(brokerHex(new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, new Uint8Array())))).toBe(expected);
    const publicKey = await crypto.subtle.importKey('raw', fromHex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'), 'Ed25519', false, ['verify']);
    expect(await crypto.subtle.verify('Ed25519', publicKey, fromHex(expected), new Uint8Array())).toBe(true);
  });
});
