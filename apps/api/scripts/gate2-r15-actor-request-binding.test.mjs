/**
 * Gate 2 R15 - OFFLINE actor-to-request binding security contract.
 * No real credentials, signer, database, network, Worker or Cloudflare bindings.
 * WeakMap identity anchors simulate separate authenticated authorities only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const A='a8000000-0000-4000-8000-000000000001';
const B='a8000000-0000-4000-8000-000000000002';
const ACTOR_A='b8000000-0000-4000-8000-000000000001';
const ACTOR_B='b8000000-0000-4000-8000-000000000002';
const ALLOWED='branches:list';
const MAX_SECONDS=60;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function model() {
  const serviceSessions=new WeakMap();
  const actorSessions=new WeakMap();
  const grants=new WeakMap();
  const usedGrants=new WeakSet();
  const serviceState=new Map([['worker-staging',{environment:'staging',enabled:true,actions:new Set([ALLOWED])}]]);
  const identities=new Map([[ACTOR_A,{active:true}],[ACTOR_B,{active:true}]]);
  const businesses=new Map([[A,{active:true}],[B,{active:true}]]);
  const memberships=new Map([[ACTOR_A,new Map([[A,new Set([ALLOWED])]])],[ACTOR_B,new Map([[B,new Set([ALLOWED])]])]]);
  const audit=[];
  // These opaque authenticated handles model independently verified workload and
  // user sessions; the caller may NOT pass its preferred actor to bind an identity.
  function attestService(name,environment) {
    const s=serviceState.get(name);
    if (!s?.enabled || s.environment!==environment) throw Error('SERVICE_DENIED');
    const handle=Object.freeze(Object.create(null));
    serviceSessions.set(handle,{name,environment});
    return handle;
  }
  function authenticateActor(actor,now) {
    // Test fixture equivalent of IdP verification; NOT a public issuer API.
    if (!identities.get(actor)?.active || !Number.isSafeInteger(now)) throw Error('ACTOR_UNAUTHENTICATED');
    const handle=Object.freeze(Object.create(null));
    actorSessions.set(handle,{actor,authenticatedAt:now});
    return handle;
  }
  function proofForRequest(actorHandle,serviceHandle,input,now) {
    const actor=actorHandle && typeof actorHandle==='object' ? actorSessions.get(actorHandle) : undefined;
    const caller=serviceHandle && typeof serviceHandle==='object' ? serviceSessions.get(serviceHandle) : undefined;
    if (!actor || !caller) throw Error('AUTHENTICATED_BOUNDARY_REQUIRED');
    if (!Number.isSafeInteger(now) || now<actor.authenticatedAt || now-actor.authenticatedAt>MAX_SECONDS)
      throw Error('ACTOR_SESSION_EXPIRED');
    if (!input || Object.getPrototypeOf(input)!==Object.prototype ||
        Object.keys(input).sort().join(',')!=='environment,operation,requestId,tenant')
      throw Error('INVALID_REQUEST');
    const {tenant,operation,requestId,environment}=input;
    if (!UUID.test(tenant) || !UUID.test(requestId) || operation!==ALLOWED ||
        environment!==caller.environment) throw Error('INVALID_SCOPE');
    if (!identities.get(actor.actor)?.active || !businesses.get(tenant)?.active ||
        !memberships.get(actor.actor)?.get(tenant)?.has(operation))
      throw Error('AUTHORIZATION_DENIED');
    const capability=Object.freeze(Object.create(null));
    grants.set(capability,{actor:actor.actor,serviceName:caller.name,environment,tenant,operation,requestId,
      expiresAt:now+MAX_SECONDS});
    return capability;
  }
  function issue(serviceHandle,capability,input,now) {
    const caller=serviceHandle && typeof serviceHandle==='object' ? serviceSessions.get(serviceHandle) : undefined;
    const grant=capability && typeof capability==='object' ? grants.get(capability) : undefined;
    if (!caller || !grant) throw Error('BOUND_PROOF_REQUIRED');
    const s=serviceState.get(caller.name);
    if (!s?.enabled || s.environment!==caller.environment || caller.name!==grant.serviceName)
      throw Error('SERVICE_DENIED');
    if (!input || Object.getPrototypeOf(input)!==Object.prototype ||
        Object.keys(input).sort().join(',')!=='environment,operation,requestId,tenant')
      throw Error('INVALID_REQUEST');
    if (grant.environment!==input.environment || grant.tenant!==input.tenant ||
        grant.operation!==input.operation || grant.requestId!==input.requestId)
      throw Error('BOUND_SCOPE_MISMATCH');
    if (!Number.isSafeInteger(now) || now>grant.expiresAt || usedGrants.has(capability))
      throw Error('BOUND_PROOF_EXPIRED_OR_REPLAYED');
    if (!s.actions.has(grant.operation) ||
        !identities.get(grant.actor)?.active || !businesses.get(grant.tenant)?.active ||
        !memberships.get(grant.actor)?.get(grant.tenant)?.has(grant.operation))
      throw Error('AUTHORIZATION_REVOKED');
    usedGrants.add(capability);
    const intent=Object.freeze({
      version:'eg-broker-v1', actor:grant.actor, tenant:grant.tenant, operation:grant.operation,
      environment:grant.environment, requestId:grant.requestId, nonce:randomUUID(),
    });
    audit.push(Object.freeze({event:'INTENT_GRANTED',actor:grant.actor,tenant:grant.tenant,
      operation:grant.operation,requestId:grant.requestId}));
    return intent; // UNSIGNED, OFFLINE. Not an assertion consumable by PostgreSQL.
  }
  function disableActor(actor){ const x=identities.get(actor);if(x)x.active=false; }
  function disableBusiness(tenant){ const x=businesses.get(tenant);if(x)x.active=false; }
  function removeMembership(actor,tenant){ memberships.get(actor)?.delete(tenant); }
  function revokeService(name){ const x=serviceState.get(name);if(x)x.enabled=false; }
  return {attestService,authenticateActor,proofForRequest,issue,disableActor,disableBusiness,
    removeMembership,revokeService,audit};
}
const req=(tenant=A,operation=ALLOWED,environment='staging',requestId=randomUUID())=>
  ({tenant,operation,environment,requestId});
function setup(){
  const h=model(),service=h.attestService('worker-staging','staging');
  const actor=h.authenticateActor(ACTOR_A,1000);
  return {h,service,actor};
}

describe('Gate 2 R15 — offline independently authenticated actor to request binding',()=>{
  it('01 successful intent derives actor solely from authenticated handle, not caller claim',()=>{
    const {h,service,actor}=setup();const r=req();
    const p=h.proofForRequest(actor,service,r,1001);
    const result=h.issue(service,p,r,1002);
    assert.equal(result.actor,ACTOR_A);assert.equal(result.tenant,A);
    assert.equal(h.audit.length,1);assert.equal(Object.hasOwn(result,'signature'),false);
  });
  it('02 service credential alone cannot choose an actor',()=>{
    const {h,service}=setup();const r=req();
    assert.throws(()=>h.proofForRequest({actor:ACTOR_A},service,r,1001),/AUTHENTICATED_BOUNDARY_REQUIRED/);
    assert.throws(()=>h.issue(service,{actor:ACTOR_A,tenant:A},r,1002),/BOUND_PROOF_REQUIRED/);
  });
  it('03 injected actor or delegated admin claim rejected',()=>{
    const {h,service,actor}=setup();
    assert.throws(()=>h.proofForRequest(actor,service,{...req(),actor:ACTOR_B},1001),/INVALID_REQUEST/);
    assert.throws(()=>h.proofForRequest(actor,service,{...req(),role:'platform-admin'},1001),/INVALID_REQUEST/);
  });
  it('04 capability cannot be applied to another tenant',()=>{
    const {h,service,actor}=setup();const r=req(),p=h.proofForRequest(actor,service,r,1001);
    assert.throws(()=>h.issue(service,p,{...r,tenant:B},1002),/BOUND_SCOPE_MISMATCH/);
  });
  it('05 capability cannot be applied to another operation',()=>{
    const {h,service,actor}=setup();const r=req(),p=h.proofForRequest(actor,service,r,1001);
    assert.throws(()=>h.issue(service,p,{...r,operation:'settlement:write'},1002),/BOUND_SCOPE_MISMATCH/);
  });
  it('06 capability cannot be applied to another request ID',()=>{
    const {h,service,actor}=setup();const r=req(),p=h.proofForRequest(actor,service,r,1001);
    assert.throws(()=>h.issue(service,p,{...r,requestId:randomUUID()},1002),/BOUND_SCOPE_MISMATCH/);
  });
  it('07 capability rejects cross environment reuse',()=>{
    const {h,service,actor}=setup();const r=req(),p=h.proofForRequest(actor,service,r,1001);
    assert.throws(()=>h.issue(service,p,{...r,environment:'production'},1002),/BOUND_SCOPE_MISMATCH/);
  });
  it('08 capability is one-time and replay denied',()=>{
    const {h,service,actor}=setup();const r=req(),p=h.proofForRequest(actor,service,r,1001);
    h.issue(service,p,r,1002);
    assert.throws(()=>h.issue(service,p,r,1003),/BOUND_PROOF_EXPIRED_OR_REPLAYED/);
  });
  it('09 expired actor session and proof denied',()=>{
    const {h,service,actor}=setup();const r=req(),p=h.proofForRequest(actor,service,r,1001);
    assert.throws(()=>h.issue(service,p,r,1062),/BOUND_PROOF_EXPIRED_OR_REPLAYED/);
    assert.throws(()=>h.proofForRequest(actor,service,req(),1061),/ACTOR_SESSION_EXPIRED/);
  });
  it('10 membership change between authorization and issuance is enforced',()=>{
    const {h,service,actor}=setup();const r=req(),p=h.proofForRequest(actor,service,r,1001);
    h.removeMembership(ACTOR_A,A);
    assert.throws(()=>h.issue(service,p,r,1002),/AUTHORIZATION_REVOKED/);
  });
  it('11 disabled actor or business between authorization and issuance denies',()=>{
    for(const change of ['actor','business']){
      const {h,service,actor}=setup();const r=req(),p=h.proofForRequest(actor,service,r,1001);
      if(change==='actor')h.disableActor(ACTOR_A);else h.disableBusiness(A);
      assert.throws(()=>h.issue(service,p,r,1002),/AUTHORIZATION_REVOKED/);
    }
  });
  it('12 revoked workload cannot use a previously valid bound proof',()=>{
    const {h,service,actor}=setup();const r=req(),p=h.proofForRequest(actor,service,r,1001);
    h.revokeService('worker-staging');
    assert.throws(()=>h.issue(service,p,r,1002),/SERVICE_DENIED/);
  });
  it('13 a second actor lacks delegated authority for tenant A',()=>{
    const {h,service}=setup();const actorB=h.authenticateActor(ACTOR_B,1000);
    assert.throws(()=>h.proofForRequest(actorB,service,req(A),1001),/AUTHORIZATION_DENIED/);
  });
  it('14 unapproved operation, forged actor handle and malformed scope fail closed',()=>{
    const {h,service,actor}=setup();
    assert.throws(()=>h.proofForRequest(actor,service,req(A,'loyalty:grant'),1001),/INVALID_SCOPE/);
    assert.throws(()=>h.proofForRequest(Object.freeze({}),service,req(),1001),/AUTHENTICATED_BOUNDARY_REQUIRED/);
    assert.throws(()=>h.proofForRequest(actor,service,{...req(),tenant:'x'},1001),/INVALID_SCOPE/);
    assert.equal(h.audit.length,0);
  });
});
