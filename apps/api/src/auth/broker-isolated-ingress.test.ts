import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  BROKER_AUDIENCE, BROKER_ISSUER, BROKER_WORKLOAD, brokerAssertionMessage,
  type BrokerAssertionClaims, type BrokerVerificationKey,
} from './broker-assertion.contract';
import { b409AssertionDigest, b409WorkloadMessage, type B409WorkloadEvidence } from './broker-workload-attestation';
import { inspectB410Ingress } from './broker-isolated-ingress';

const now = 1000;
const subject = '10000000-0000-4000-8000-000000000001';
const issuer = generateKeyPairSync('ed25519');
const workload = generateKeyPairSync('ed25519');
const publicKey=(pair:typeof issuer,id:string):BrokerVerificationKey=>({
  keyId:id,version:1,state:'ACTIVE',notBefore:900,notAfter:1100,
  publicKeyHex:(pair.publicKey.export({format:'der',type:'spki'}) as Buffer).subarray(-32).toString('hex'),
});
const signed=(bytes:Uint8Array,pair:typeof issuer)=>sign(null,Buffer.from(bytes),pair.privateKey).toString('hex');
async function invocation(){
  const claims:BrokerAssertionClaims={
    version:'B4-03/1',algorithm:'Ed25519',environment:'development',
    issuer:BROKER_ISSUER,audience:BROKER_AUDIENCE,workloadId:BROKER_WORKLOAD,
    keyId:'issuer-1',keyVersion:1,actorType:'staff',actorId:subject,sessionId:subject,
    businessId:subject,branchId:subject,operation:'branches:read',permission:'branches:view',
    requestId:subject,nonce:subject,issuedAt:985,expiresAt:1030,authorizationVersion:null,
  };
  const assertion={claims,signature:signed(brokerAssertionMessage(claims),issuer)};
  const evidence:B409WorkloadEvidence={
    version:'B4-09/1',environment:'development',workload:'echogrid:development:api-worker',
    audience:'echogrid:development:isolated-broker',keyId:'workload-1',keyVersion:1,
    assertionDigest:await b409AssertionDigest(assertion),issuedAt:995,expiresAt:1020,signature:'',
  };
  return {assertion,workloadEvidence:{...evidence,signature:signed(b409WorkloadMessage(evidence),workload)}};
}
const path='https://broker.invalid/internal/broker/v1/branch-read';
const request=(body:string,method='POST',url=path,headers:Record<string,string>={'content-type':'application/json'})=>
  new Request(url,method==='GET'?{method,headers}:{method,headers,body});
const inspect=(req:Request)=>inspectB410Ingress(req,
  async()=>publicKey(issuer,'issuer-1'),async()=>publicKey(workload,'workload-1'),()=>now);

describe('B4-10 unmounted, bounded broker ingress',()=>{
  const streamed = (body: ReadableStream<Uint8Array>) => new Request(path, {
    method:'POST',headers:{'content-type':'application/json'},body,duplex:'half',
  } as RequestInit);
  it('bounds a body stream that never produces data',async()=>{
    vi.useFakeTimers();
    try {
      const result=inspect(streamed(new ReadableStream<Uint8Array>()));
      const observed=Promise.race([result, new Promise(resolve=>setTimeout(()=>resolve('STILL_PENDING'),6000))]);
      await vi.advanceTimersByTimeAsync(6000);
      expect(await observed).toMatchObject({acceptedForEvaluation:false,reason:'INGRESS_TIMEOUT'});
    } finally {vi.useRealTimers();}
  });
  it('does not await attacker-controlled cancellation after an oversized body',async()=>{
    vi.useFakeTimers();
    try {
      const result=inspect(streamed(new ReadableStream<Uint8Array>({
        start(controller){controller.enqueue(new Uint8Array(8193));},cancel(){return new Promise(()=>{});},
      })));
      const observed=Promise.race([result,new Promise(resolve=>setTimeout(()=>resolve('STILL_PENDING'),6000))]);
      await vi.advanceTimersByTimeAsync(6000);
      expect(await observed).toMatchObject({acceptedForEvaluation:false,reason:'BODY_LIMIT_EXCEEDED'});
    } finally {vi.useRealTimers();}
  });
  it('bounds streams of empty chunks without relying on timer scheduling',async()=>{
    const body=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array());}});
    expect(await inspect(streamed(body))).toMatchObject({acceptedForEvaluation:false,reason:'BODY_LIMIT_EXCEEDED'});
  });
  it('observes cancellation rejection without replacing the size denial',async()=>{
    const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(8193));},
      cancel(){return Promise.reject(new Error('synthetic cancellation failure'));}});
    expect(await inspect(streamed(body))).toMatchObject({reason:'BODY_LIMIT_EXCEEDED'});
  });
  it('bounds an unavailable trusted key provider',async()=>{
    const body=JSON.stringify(await invocation());
    vi.useFakeTimers();
    try {
      const result=inspectB410Ingress(request(body),()=>new Promise(()=>{}),
        async()=>publicKey(workload,'workload-1'),()=>now);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await result).toMatchObject({acceptedForEvaluation:false,reason:'INGRESS_TIMEOUT'});
    } finally {vi.useRealTimers();}
  });
  it('rejects evidence that expires during asynchronous verification',async()=>{
    let time=now;
    const result=await inspectB410Ingress(request(JSON.stringify(await invocation())),
      async()=>publicKey(issuer,'issuer-1'),async()=>{time=1021;return publicKey(workload,'workload-1');},()=>time);
    expect(result).toMatchObject({acceptedForEvaluation:false,reason:'UNTRUSTED_PROVENANCE'});
  });
  it('rejects a trusted clock that moves backwards during verification',async()=>{
    let time=now;
    const result=await inspectB410Ingress(request(JSON.stringify(await invocation())),
      async()=>publicKey(issuer,'issuer-1'),async()=>{time=999;return publicKey(workload,'workload-1');},()=>time);
    expect(result).toMatchObject({acceptedForEvaluation:false,reason:'UNTRUSTED_PROVENANCE'});
  });
  it('rejects malformed UTF-8 before key lookup',async()=>{
    let calls=0;
    const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array([0xc3,0x28]));controller.close();}});
    const source=async()=>{calls++;return null;};
    expect(await inspectB410Ingress(streamed(body),source,source,()=>now)).toMatchObject({reason:'MALFORMED_INVOCATION'});
    expect(calls).toBe(0);
  });
  it('valid dual-signature invocation remains non-authorizing',async()=>{
    expect(await inspect(request(JSON.stringify(await invocation())))).toEqual({
      acceptedForEvaluation:true,brokerAuthorization:'NOT_GRANTED',
      deploymentAuthorized:false,reason:'PROVENANCE_ONLY',
    });
  });
  it('rejects wrong methods, paths and query strings',async()=>{
    const valid=JSON.stringify(await invocation());
    expect((await inspect(request(valid,'GET'))).reason).toBe('METHOD_OR_PATH_DENIED');
    expect((await inspect(request(valid,'POST',path+'?debug=1'))).reason).toBe('METHOD_OR_PATH_DENIED');
    expect((await inspect(request(valid,'POST','https://broker.invalid/internal/broker/v1/settlement'))).reason).toBe('METHOD_OR_PATH_DENIED');
  });
  it('rejects missing and wrong content-type',async()=>{
    expect((await inspect(request('{}','POST',path,{'content-type':'text/plain'}))).reason).toBe('UNSUPPORTED_MEDIA');
    expect((await inspect(request('{}','POST',path,{}))).reason).toBe('UNSUPPORTED_MEDIA');
  });
  it('rejects oversized bodies, including missing content-length',async()=>{
    expect((await inspect(request('x'.repeat(8193)))).reason).toBe('BODY_LIMIT_EXCEEDED');
    expect((await inspect(request('{}','POST',path,{'content-type':'application/json','content-length':'999999'}))).reason)
      .toBe('BODY_LIMIT_EXCEEDED');
  });
  it('rejects malformed, forged and extra-field invocations',async()=>{
    expect((await inspect(request('{bad'))).reason).toBe('MALFORMED_INVOCATION');
    expect((await inspect(request('{}'))).reason).toBe('UNTRUSTED_PROVENANCE');
    expect((await inspect(request(JSON.stringify({...await invocation(),trusted:true})))).reason).toBe('UNTRUSTED_PROVENANCE');
  });
  it('rejects altered signed bytes',async()=>{
    const good=await invocation();
    expect((await inspect(request(JSON.stringify({...good,
      assertion:{...good.assertion,claims:{...good.assertion.claims,branchId:'20000000-0000-4000-8000-000000000002'}}})))).reason)
      .toBe('UNTRUSTED_PROVENANCE');
  });
});
