import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  BROKER_AUDIENCE, BROKER_ISSUER, BROKER_WORKLOAD,
  brokerAssertionMessage, type BrokerAssertion, type BrokerAssertionClaims, type BrokerVerificationKey,
} from './broker-assertion.contract';
import { b409AssertionDigest, b409WorkloadMessage, verifyB409Invocation, type B409Invocation, type B409WorkloadEvidence } from './broker-workload-attestation';

const validUuid = '10000000-0000-4000-8000-000000000001';
const now = 1000;
const issuer = generateKeyPairSync('ed25519');
const workload = generateKeyPairSync('ed25519');
function key(pair: typeof issuer, keyId: string): BrokerVerificationKey {
  const der = pair.publicKey.export({ format:'der', type:'spki' });
  return { keyId, version:1, publicKeyHex:der.subarray(-32).toString('hex'),
    state:'ACTIVE',notBefore:900,notAfter:1100 };
}
const signer=(bytes: Uint8Array, pair: typeof issuer): string =>
  sign(null, Buffer.from(bytes), pair.privateKey).toString('hex');

async function fixture(): Promise<B409Invocation> {
  const claims: BrokerAssertionClaims = {
    version:'B4-03/1', algorithm:'Ed25519', environment:'development',
    issuer:BROKER_ISSUER, audience:BROKER_AUDIENCE, workloadId:BROKER_WORKLOAD,
    keyId:'issuer-1', keyVersion:1, actorType:'staff', actorId:validUuid,
    sessionId:validUuid, businessId:validUuid, branchId:validUuid,
    operation:'branches:read',permission:'branches:view',
    requestId:validUuid,nonce:validUuid,issuedAt:985,expiresAt:1030,authorizationVersion:null,
  };
  const assertion: BrokerAssertion={claims,signature:signer(brokerAssertionMessage(claims),issuer)};
  const evidence: B409WorkloadEvidence = {
    version:'B4-09/1',environment:'development',workload:'echogrid:development:api-worker',
    audience:'echogrid:development:isolated-broker',
    keyId:'workload-1', keyVersion:1,assertionDigest:await b409AssertionDigest(assertion),
    issuedAt:995, expiresAt:1020,signature:'',
  };
  return { assertion,workloadEvidence:{...evidence,signature:signer(b409WorkloadMessage(evidence),workload)} };
}
const verify=(input:unknown, time=now) =>
  verifyB409Invocation(input,async()=>key(issuer,'issuer-1'),async()=>key(workload,'workload-1'),time);

describe('B4-09 offline two-key broker invocation provenance',()=>{
  it('verifies two separate Ed25519 keys but never grants runtime execution',async()=>{
    const v=await verify(await fixture());
    expect(v).toEqual({provenanceVerified:true,brokerAuthorization:'NOT_GRANTED',
      deploymentAuthorized:false,reason:'VERIFIED_PROVENANCE_ONLY'});
  });
  it('rejects tampered assertion and cryptographic evidence',async()=>{
    const original=await fixture();
    for(const changed of [
      {...original,assertion:{...original.assertion,signature:'a'.repeat(128)}},
      {...original,assertion:{...original.assertion,claims:{...original.assertion.claims,businessId:'20000000-0000-4000-8000-000000000002'}}},
      {...original,workloadEvidence:{...original.workloadEvidence,assertionDigest:'0'.repeat(64)}},
      {...original,workloadEvidence:{...original.workloadEvidence,signature:'1'.repeat(128)}},
      {...original,workloadEvidence:{...original.workloadEvidence,audience:'wrong'}},
    ]) expect((await verify(changed)).provenanceVerified).toBe(false);
  });
  it('refuses expired, future and excessive time windows',async()=>{
    const good=await fixture();
    expect((await verify(good,1021)).provenanceVerified).toBe(false);
    expect((await verify(good,994)).provenanceVerified).toBe(false);
    const tooLong={...good,workloadEvidence:{...good.workloadEvidence,expiresAt:1060}};
    expect((await verify(tooLong)).provenanceVerified).toBe(false);
  });
  it('refuses caller-injected proof and key substitutions',async()=>{
    const good=await fixture();
    expect((await verify({...good,verified:true})).provenanceVerified).toBe(false);
    expect((await verifyB409Invocation(good,async()=>key(workload,'issuer-1'),async()=>key(workload,'workload-1'),now)).provenanceVerified).toBe(false);
    expect((await verifyB409Invocation(good,async()=>key(issuer,'issuer-1'),async()=>key(issuer,'workload-1'),now)).provenanceVerified).toBe(false);
  });
  it('fails closed if independent key sources are unavailable',async()=>{
    const good=await fixture();
    expect((await verifyB409Invocation(good,async()=>null,async()=>key(workload,'workload-1'),now)).provenanceVerified).toBe(false);
    expect((await verifyB409Invocation(good,async()=>key(issuer,'issuer-1'),async()=>null,now)).provenanceVerified).toBe(false);
  });
  it('rejects the same public key under different trust-role identifiers',async()=>{
    const good=await fixture();
    const shared={...good,workloadEvidence:{...good.workloadEvidence,
      signature:signer(b409WorkloadMessage(good.workloadEvidence),issuer)}};
    expect((await verifyB409Invocation(shared,async()=>key(issuer,'issuer-1'),
      async()=>key(issuer,'workload-1'),now)).provenanceVerified).toBe(false);
  });
  it('cannot replace validated workload fields while awaiting assertion key lookup',async()=>{
    const good=await fixture();
    const wrong={...good.workloadEvidence,audience:'wrong'} as unknown as B409WorkloadEvidence;
    const replacement={...wrong,signature:signer(b409WorkloadMessage(wrong),workload)};
    const mutable={...good,workloadEvidence:{...good.workloadEvidence,signature:'0'.repeat(128)}};
    expect((await verifyB409Invocation(mutable,async()=>{
      Object.assign(mutable.workloadEvidence,replacement);
      return key(issuer,'issuer-1');
    },async()=>key(workload,'workload-1'),now)).provenanceVerified).toBe(false);
  });
  it.each([null,{},[],false,{verified:true},'trusted'])('rejects malformed envelope',async raw=>{
    expect((await verify(raw)).provenanceVerified).toBe(false);
  });
});
