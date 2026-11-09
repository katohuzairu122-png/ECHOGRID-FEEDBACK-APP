/**
 * Gate 2 R14: offline trusted issuer invocation boundary (no deployable signer).
 * All identities are synthetic; all credentials and authority are in memory.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const TENANT_A='a8000000-0000-4000-8000-000000000001';
const TENANT_B='a8000000-0000-4000-8000-000000000002';
const ACTOR_A='b8000000-0000-4000-8000-000000000001';
const ACTOR_B='b8000000-0000-4000-8000-000000000002';
const OPS=new Set(['branches:list']);
const MAX_TTL=120;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// This private WeakMap models the result of independent workload authentication.
// An ordinary object (including one with matching properties) is never a principal.
function createHarness(){
  const attested=new WeakMap();
  const activeServices=new Map([['api-staging',{environment:'staging',permitted:new Set(['branches:list'])}]]);
  const members=new Map([
    [ACTOR_A,new Map([[TENANT_A,new Set(['branches:list'])]])],
    [ACTOR_B,new Map([[TENANT_B,new Set(['branches:list'])]])],
  ]);
  const actors=new Set([ACTOR_A,ACTOR_B]);
  const tenants=new Set([TENANT_A,TENANT_B]);
  const audit=[];
  function authenticateWorkload(serviceId,environment){
    const service=activeServices.get(serviceId);
    if(!service||service.environment!==environment)throw Error('WORKLOAD_UNTRUSTED');
    const session=Object.freeze(Object.create(null));
    attested.set(session,{serviceId,environment});
    return session;
  }
  function revokeService(serviceId){activeServices.delete(serviceId);}
  function revokeActor(actor){actors.delete(actor);}
  function suspendTenant(tenant){tenants.delete(tenant);}
  function revokeMembership(actor,tenant){members.get(actor)?.delete(tenant);}
  function issue(session,request){
    // Only a genuinely attested workload may reach the modeled issuer.
    const caller=session && typeof session==='object' ? attested.get(session) : undefined;
    if(!caller)throw Error('ISSUER_CALLER_UNTRUSTED');
    const service=activeServices.get(caller.serviceId);
    if(!service||caller.environment!==service.environment)throw Error('ISSUER_CALLER_REVOKED');
    if(!request||Object.getPrototypeOf(request)!==Object.prototype ||
       Object.keys(request).sort().join(',')!=='actor,environment,operation,tenant,ttl')
      throw Error('ASSERTION_REQUEST_INVALID');
    const {actor,tenant,operation,environment,ttl}=request;
    if(environment!==caller.environment)throw Error('ISSUER_ENVIRONMENT_DENIED');
    if(!UUID.test(actor)||!UUID.test(tenant)||!Number.isSafeInteger(ttl)||ttl<=0||ttl>MAX_TTL)
      throw Error('ASSERTION_REQUEST_INVALID');
    if(!OPS.has(operation)||!service.permitted.has(operation))
      throw Error('ISSUER_OPERATION_DENIED');
    if(!actors.has(actor)||!tenants.has(tenant))
      throw Error('ISSUER_PRINCIPAL_DISABLED');
    // Trusted authorization data, never a caller's membership declaration.
    if(!members.get(actor)?.get(tenant)?.has(operation))
      throw Error('ISSUER_AUTHORIZATION_DENIED');
    const assertion=Object.freeze({
      version:'eg-broker-v1', issuer:'echogrid:trusted-issuer', audience:'echogrid:db-broker:v1',
      actor,tenant,operation,environment,nonce:randomUUID(),ttl,
    });
    audit.push(Object.freeze({event:'ISSUED',serviceId:caller.serviceId,actor,tenant,operation,environment,nonce:assertion.nonce}));
    return assertion; // UNSIGNED intent only; no credential, signature or DB verifier.
  }
  return {authenticateWorkload,revokeService,revokeActor,suspendTenant,revokeMembership,issue,audit};
}
const request=(actor=ACTOR_A,tenant=TENANT_A,operation='branches:list',environment='staging',ttl=60)=>
  ({actor,tenant,operation,environment,ttl});

describe('Gate 2 R14 offline issuer invocation boundary',()=>{
  it('01 trusted workload with current membership can request one allowlisted operation',()=>{
    const h=createHarness();const service=h.authenticateWorkload('api-staging','staging');
    const result=h.issue(service,request());
    assert.equal(result.tenant,TENANT_A);
    assert.equal(result.operation,'branches:list');
    assert.equal(h.audit.length,1);
    assert.equal(Object.hasOwn(result,'signature'),false);
  });
  it('02 plain object or claimed workload identity cannot impersonate attested session',()=>{
    const h=createHarness();
    assert.throws(()=>h.issue({serviceId:'api-staging',environment:'staging'},request()),/CALLER_UNTRUSTED/);
    assert.throws(()=>h.issue(null,request()),/CALLER_UNTRUSTED/);
  });
  it('03 unknown service and environment mismatch denied before issuing a session',()=>{
    const h=createHarness();
    assert.throws(()=>h.authenticateWorkload('browser','staging'),/WORKLOAD_UNTRUSTED/);
    assert.throws(()=>h.authenticateWorkload('api-staging','production'),/WORKLOAD_UNTRUSTED/);
  });
  it('04 session cannot be used after service revocation',()=>{
    const h=createHarness();const service=h.authenticateWorkload('api-staging','staging');
    h.revokeService('api-staging');
    assert.throws(()=>h.issue(service,request()),/CALLER_REVOKED/);
  });
  it('05 cross-environment invocation fails closed',()=>{
    const h=createHarness();const service=h.authenticateWorkload('api-staging','staging');
    assert.throws(()=>h.issue(service,request(ACTOR_A,TENANT_A,'branches:list','production')),/ENVIRONMENT_DENIED/);
  });
  it('06 actor cannot choose another business despite knowing its ID',()=>{
    const h=createHarness();const service=h.authenticateWorkload('api-staging','staging');
    assert.throws(()=>h.issue(service,request(ACTOR_A,TENANT_B)),/AUTHORIZATION_DENIED/);
  });
  it('07 unauthorized operation or client-provided role escalation fails closed',()=>{
    const h=createHarness();const service=h.authenticateWorkload('api-staging','staging');
    assert.throws(()=>h.issue(service,request(ACTOR_A,TENANT_A,'settlement:write')),/OPERATION_DENIED/);
    assert.throws(()=>h.issue(service,{...request(),role:'owner'}),/REQUEST_INVALID/);
  });
  it('08 revoked actor and suspended business cannot obtain new assertion intents',()=>{
    const a=createHarness();const sa=a.authenticateWorkload('api-staging','staging');
    a.revokeActor(ACTOR_A);assert.throws(()=>a.issue(sa,request()),/PRINCIPAL_DISABLED/);
    const b=createHarness();const sb=b.authenticateWorkload('api-staging','staging');
    b.suspendTenant(TENANT_A);assert.throws(()=>b.issue(sb,request()),/PRINCIPAL_DISABLED/);
  });
  it('09 membership revocation takes effect immediately in the model',()=>{
    const h=createHarness();const service=h.authenticateWorkload('api-staging','staging');
    h.revokeMembership(ACTOR_A,TENANT_A);
    assert.throws(()=>h.issue(service,request()),/AUTHORIZATION_DENIED/);
  });
  it('10 invalid shape, excessive TTL and missing tenant fail closed',()=>{
    const h=createHarness();const service=h.authenticateWorkload('api-staging','staging');
    for(const bad of [request(ACTOR_A,TENANT_A,'branches:list','staging',121),
      request(ACTOR_A,TENANT_A,'branches:list','staging',0),
      {...request(),tenant:''},{...request(),tenant:undefined},Object.create(null)]){
      assert.throws(()=>h.issue(service,bad),/REQUEST_INVALID/);
    }
  });
  it('11 invalid requests never generate an issuance audit event',()=>{
    const h=createHarness();const service=h.authenticateWorkload('api-staging','staging');
    assert.throws(()=>h.issue(service,request(ACTOR_B,TENANT_A)),/AUTHORIZATION_DENIED/);
    assert.equal(h.audit.length,0);
  });
});
